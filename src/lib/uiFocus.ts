// =====================================================
// 「别抢终端焦点」的临时抑制窗
// -----------------------------------------------------
// AI 侧栏在收到 termai:quick-ask 时会把焦点交给自己的输入框 —— 这对用户主动
// 敲 `?问题` 是想要的行为，但对「后台自动分析」是灾难：
//   终端输出命中报错关键词（error / cannot / invalid / not found / denied …）
//   → tryAutoAnalyze 自动派发 quick-ask
//   → AI 侧栏把焦点从终端抢走
//   → 用户正在敲的下一条命令全部进了 AI 输入框：
//     字母进不去终端、空格打进 AI 框、退格改的是 AI 框里的文字。
// 表现就是「偶发打不进字」，且越是在敲命令（打错一条命令 = 出现报错）越容易触发。
//
// 这里用一个极小的可变窗口表达「接下来这段时间的自动唤起不要抢焦点」，
// 由发起方显式声明意图，避免侧栏去猜用户到底想在哪打字。
// =====================================================

let suppressedUntil = 0;

/** 声明「未来 ms 毫秒内自动唤起 AI 不要抢焦点」 */
export function suppressAutoFocus(ms = 2500): void {
  suppressedUntil = Date.now() + Math.max(0, ms);
}

/** 当前是否处于「不抢焦点」窗口内（now 可注入，便于单测） */
export function isAutoFocusSuppressed(now: number = Date.now()): boolean {
  return now < suppressedUntil;
}

/** 仅供测试复位 */
export function resetAutoFocusSuppression(): void {
  suppressedUntil = 0;
}
