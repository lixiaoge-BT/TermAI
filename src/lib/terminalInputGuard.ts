// =====================================================
// 终端键盘输入加固（修复「偶发打不进字 / 空格无效 / 退格改不掉」）
// -----------------------------------------------------
// 症状：在终端里敲命令时，偶发性地整个键盘失效 —— 空格打不出、字母进不去、
// 已经敲下的文字退格也改不掉，看上去像终端「死」了。这不是终端渲染问题，
// 而是输入链路上的三个已知缺陷叠加（xterm 5.3 + React 18 + 中文输入法）：
//
// ① 输入法组合态卡死（xterm 5.3 CompositionHelper）
//    Chromium 在「输入法正在处理」期间，给每个 keydown 的 keyCode 都填 229。
//    xterm 的 CompositionHelper.keydown() 一旦认为自己还在组合中（_isComposing），
//    就对 229 直接 return false —— _keyDown 提前返回，不产生 onData，
//    字节永远到不了 PTY。而 _isComposing 只有 compositionend 能清。
//    中文输入法被 Ctrl+Space 切走、组合途中窗口失焦（_handleTextAreaBlur 会清空
//    textarea.value 却不复位 _isComposing）、侧栏/弹窗抢焦点、ResizeObserver 里
//    fit() 触发重排，都可能让 compositionend 丢失。一旦丢失，之后每个按键
//    （含空格、退格）都会被吞，且无法自愈 —— 必须重启窗口才恢复。
//    → 对策：检测「229 还在来，但很久没有 compositionupdate」，向 textarea 补发
//      一次 compositionend，把 xterm 的组合态强行收尾。
//
// ② React 18 根级事件委托干扰组合输入
//    keydown(229) 冒泡到 React 根后会被当作组合事件再合成一遍，和 xterm 自己
//    挂在 textarea 上的原生组合处理互相踩（典型表现：每个组合块的第一个字丢失）。
//    → 对策：在 textarea 上捕获相拦截 229 / key=Process 的 keydown，不再向上冒泡。
//      xterm 自己的监听就注册在这个节点上，且先于本模块注册，行为不受影响。
//
// ③ 输入被静默丢弃却毫无痕迹
//    ssh:write / local-terminal:write 走 ipcRenderer.invoke，返回的 Promise 没人
//    await；主进程窗口未就绪时它直接 reject —— 键按下去、画面没反应、控制台也没
//    提示，排查时完全看不出是「没收下」还是「发不出去」。
//    → 对策：本模块统计 imeKeydowns / dataEvents / stuckReleases，并挂到
//      window.__termaiInputDiag()，一眼分清卡在哪一段。
//
// 只做「补一笔」和「数一数」，不改变 xterm 的正常输入路径；任何一步失败都静默降级。
// =====================================================

import type { Terminal } from "xterm";

/** Chromium 在「输入法正在处理」阶段给所有 keydown 填的 keyCode */
export const IME_KEY_CODE = 229;
/**
 * 组合态被判定为「卡死」的静默阈值。
 * 正常组合里 keydown(229) 与 compositionupdate 是成对出现的（输入法每次更新
 * 候选都会发）；只收到 229 却长时间没有 compositionupdate，说明组合已经名存实亡。
 */
export const STUCK_COMPOSITION_MS = 800;

export interface ImeKeyLike {
  keyCode?: number;
  key?: string;
}

/** 是否为「输入法接管了这次按键」的 keydown（Chromium: keyCode 229 / key=Process） */
export function isImeProcessKey(e: ImeKeyLike): boolean {
  return e.keyCode === IME_KEY_CODE || e.key === "Process";
}

/**
 * 组合态是否已经卡死（纯函数，便于单测）。
 * - 不在组合中 → 不可能卡死
 * - 从没收到过 compositionstart（lastCompositionAt <= 0）→ 算不上卡死
 * - 距上次组合活动超过阈值，却仍有 229 keydown → 判定卡死
 */
export function isStuckComposition(input: {
  now: number;
  composing: boolean;
  lastCompositionAt: number;
  thresholdMs?: number;
}): boolean {
  const { now, composing, lastCompositionAt } = input;
  if (!composing) return false;
  if (lastCompositionAt <= 0) return false;
  const threshold = input.thresholdMs ?? STUCK_COMPOSITION_MS;
  return now - lastCompositionAt > threshold;
}

export interface InputGuardStats {
  /** 收到的 229（输入法接管）keydown 次数 */
  imeKeydowns: number;
  /** 通过 onData 送出的数据事件次数 */
  dataEvents: number;
  /** 判定组合态卡死并强制收尾的次数 */
  stuckReleases: number;
  /** 最近一次强制收尾的时间戳（0 表示没有发生过） */
  lastReleaseAt: number;
}

const zeroStats = (): InputGuardStats => ({
  imeKeydowns: 0,
  dataEvents: 0,
  stuckReleases: 0,
  lastReleaseAt: 0,
});

/** 全进程汇总（多个终端面板共用一份，便于一次性看全） */
const totalStats = zeroStats();

function publishDiag() {
  const w = window as unknown as {
    __termaiInputDiag?: () => InputGuardStats & { snapshotAt: number };
  };
  if (w.__termaiInputDiag) return;
  w.__termaiInputDiag = () => ({ ...totalStats, snapshotAt: Date.now() });
}

/**
 * 给单个终端实例装上输入加固，返回卸载函数。
 * 必须在 term.open() 之后调用（那时 term.textarea / term.element 才存在）。
 */
export function installTerminalInputGuard(term: Terminal): () => void {
  const ta = term.textarea as HTMLTextAreaElement | undefined;
  if (!ta) return () => {};
  publishDiag();

  let composing = false;
  let lastCompositionAt = 0;

  const bump = (patch: Partial<InputGuardStats>) => {
    if (patch.imeKeydowns) totalStats.imeKeydowns += patch.imeKeydowns;
    if (patch.dataEvents) totalStats.dataEvents += patch.dataEvents;
    if (patch.stuckReleases) totalStats.stuckReleases += patch.stuckReleases;
    if (patch.lastReleaseAt) totalStats.lastReleaseAt = patch.lastReleaseAt;
  };

  /**
   * 强行给组合态收尾：补发一次 compositionend，xterm 的 compositionend 监听会
   * 走 _finalizeComposition(true)，把 _isComposing 复位。
   * 不 preventDefault、不动 textarea.value —— 尽量保留输入法已经提交的文本。
   */
  const releaseStuckComposition = () => {
    try {
      const data = ta.value;
      ta.dispatchEvent(new CompositionEvent("compositionend", { data }));
      composing = false;
      lastCompositionAt = 0;
      bump({ stuckReleases: 1, lastReleaseAt: Date.now() });
      console.warn("[termai] 输入法组合态卡死，已强制收尾（下一次按键恢复正常）");
    } catch (e) {
      console.error("[termai] 强制收尾组合态失败:", e);
    }
  };

  // ② 拦截 229 / Process 的 keydown，阻止它冒泡到 React 根被二次合成；
  //    顺便在 ① 的判定成立时把卡死的组合态收尾。
  const onTextareaKeyDown = (e: KeyboardEvent) => {
    if (!isImeProcessKey(e)) return;
    bump({ imeKeydowns: 1 });
    if (isStuckComposition({ now: Date.now(), composing, lastCompositionAt })) {
      releaseStuckComposition();
    }
    // xterm 自己的 keydown 监听注册在同一个节点且更早，已经处理完了，
    // 这里断掉冒泡只会影响「React 根 / window 上的全局快捷键」，不会影响终端输入。
    e.stopPropagation();
  };

  const onCompositionStart = () => {
    composing = true;
    lastCompositionAt = Date.now();
  };
  const onCompositionActivity = () => {
    lastCompositionAt = Date.now();
  };
  const onCompositionEnd = () => {
    composing = false;
    lastCompositionAt = 0;
  };

  ta.addEventListener("keydown", onTextareaKeyDown, true);
  ta.addEventListener("compositionstart", onCompositionStart);
  // 只把 compositionupdate 当「组合还活着」的证据。
  // 不用 input 事件：卡死状态下 Chromium 仍可能零星派发 input，拿它续命会把
  // 判定条件永远喂饱，自愈就再也不会触发了。
  ta.addEventListener("compositionupdate", onCompositionActivity);
  ta.addEventListener("compositionend", onCompositionEnd);

  // 计数：onData 是否真的在产出数据。用来区分「xterm 层面就把键吞了」和
  // 「数据发了但远端/渲染没反应」—— 排查时最关键的一刀。
  const dataSub = term.onData(() => {
    bump({ dataEvents: 1 });
  });

  return () => {
    ta.removeEventListener("keydown", onTextareaKeyDown, true);
    ta.removeEventListener("compositionstart", onCompositionStart);
    ta.removeEventListener("compositionupdate", onCompositionActivity);
    ta.removeEventListener("compositionend", onCompositionEnd);
    dataSub.dispose();
  };
}
