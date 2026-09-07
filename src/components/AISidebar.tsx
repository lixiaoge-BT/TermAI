import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  User,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  PanelRightOpen,
  PanelRightClose,
  Key,
  Wand2,
  AlertCircle,
  Loader2,
  ChevronDown,
  Info,
  SearchCode,
  FileCode2,
  Wrench,
  Stethoscope,
  Activity,
  History,
  MessageSquare,
  SquareTerminal,
} from "lucide-react";
import { useSessionChat } from "@/store/chat";
import { useAppConfig } from "@/store/config";
import { useTerminalStore } from "@/store/terminal";
import { chatCompletion } from "@/services/ai";
import { CommandCard } from "./CommandCard";
import { AgentPanel } from "./AgentPanel";
import type { ParsedCommand } from "@/types";
import { parseCommandsFromMarkdown } from "@/services/safety";

type AIMode = "chat" | "agent";

const accentGradient = {
  background: "linear-gradient(135deg, var(--accent), var(--accent-hover))",
};

export function AISidebar({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  // 两种模式：AI 问答（对话给建议） / Agent 接管（AI 自己在终端里执行）
  const [mode, setMode] = useState<AIMode>("chat");

  // 允许外部（如在终端里输入 `?问题`）把侧边栏切到问答模式，确保用户看得到回答
  useEffect(() => {
    const handler = (e: Event) => {
      const m = (e as CustomEvent).detail as AIMode | undefined;
      if (m === "chat" || m === "agent") setMode(m);
    };
    window.addEventListener("termai:ai-mode", handler);
    return () => window.removeEventListener("termai:ai-mode", handler);
  }, []);

  const activeSession = useTerminalStore((s) => s.getActiveSession());
  const hostConfig = useAppConfig((c) =>
    activeSession?.hostId ? c.getHost(activeSession.hostId) : null
  );
  const aiConfig = useAppConfig((c) => c.aiConfig);

  if (!open) {
    return (
      <button
        onClick={onToggle}
        className="h-full border-l border-border-primary bg-bg-secondary hover:bg-bg-tertiary px-1.5 flex flex-col items-center pt-4 gap-3 text-text-secondary hover:text-text-primary w-14 min-w-14 transition-colors"
        title="打开 AI 助手"
      >
        <Sparkles size={20} />
        <span
          className="text-[11px] tracking-[0.22em] leading-relaxed"
          style={{ writingMode: "vertical-rl" }}
        >
          AI 助手
        </span>
        <PanelRightClose size={14} className="mt-auto mb-3" />
      </button>
    );
  }

  return (
    <div className="flex flex-col h-full w-[420px] min-w-[360px] max-w-[40%] bg-bg-secondary border-l border-border-primary">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border-primary flex-shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded flex items-center justify-center" style={accentGradient}>
            <Sparkles size={14} className="text-white" />
          </div>
          <div>
            <div className="text-sm font-semibold text-text-primary flex items-center gap-1.5">
              TermAI 助手
              {activeSession?.connected && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-success/30 text-success-text">
                  上下文已接入
                </span>
              )}
            </div>
            <div className="text-[11px] text-text-secondary">
              {aiConfig.model} · {aiConfig.provider}
              {!aiConfig.apiKey && <span className="text-warning-text ml-1">（未配置 Key）</span>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <SettingsButton />
          <button
            onClick={onToggle}
            className="p-1.5 rounded hover:bg-bg-hover text-text-secondary"
            title="收起侧边栏"
          >
            <PanelRightOpen size={16} />
          </button>
        </div>
      </div>

      {/* 模式切换：问答 / Agent 接管 */}
      <div className="px-3 py-2 border-b border-border-primary flex items-center gap-1.5 flex-shrink-0">
        <ModeTab
          active={mode === "chat"}
          icon={MessageSquare}
          label="AI 问答"
          hint="对话式给建议"
          onClick={() => setMode("chat")}
        />
        <ModeTab
          active={mode === "agent"}
          icon={SquareTerminal}
          label="Agent 接管"
          hint="自动执行命令"
          onClick={() => setMode("agent")}
        />
      </div>

      {/* 两个模式都保持挂载，只切换显示：避免切换时丢失对话/任务上下文 */}
      <div
        className="flex-1 flex flex-col min-h-0"
        style={{ display: mode === "chat" ? "flex" : "none" }}
      >
        <ChatArea
          session={activeSession}
          hostConfig={hostConfig}
          isProduction={hostConfig?.tags?.some((t) => /生产|prod|线上|live/i.test(t))}
        />
      </div>
      <div
        className="flex-1 flex flex-col min-h-0"
        style={{ display: mode === "agent" ? "flex" : "none" }}
      >
        <AgentPanel
          session={activeSession}
          hostConfig={hostConfig}
          isProduction={hostConfig?.tags?.some((t) => /生产|prod|线上|live/i.test(t))}
        />
      </div>
    </div>
  );
}

function ModeTab({
  active,
  icon: Icon,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-left transition-colors ${
        active
          ? "border-accent bg-accent-20 text-text-primary"
          : "border-border-primary bg-bg-tertiary text-text-secondary hover:bg-bg-hover"
      }`}
      title={hint}
    >
      <Icon size={13} className={active ? "text-text-link" : ""} />
      <span className="text-[11px] font-medium">{label}</span>
      <span className="text-[10px] text-text-tertiary ml-auto truncate">{hint}</span>
    </button>
  );
}

function SettingsButton() {
  const [open, setOpen] = useState(false);
  const aiConfig = useAppConfig((c) => c.aiConfig);
  const updateAI = useAppConfig((c) => c.updateAIConfig);
  const [form, setForm] = useState(aiConfig);

  useEffect(() => {
    setForm(aiConfig);
  }, [aiConfig, open]);

  const save = () => {
    updateAI(form);
    setOpen(false);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="p-1.5 rounded hover:bg-bg-hover text-text-secondary"
        title="AI 设置"
      >
        <Settings2 size={16} />
      </button>
      {open && (
        <div className="fixed inset-0 z-[999] bg-overlay backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn" onClick={() => setOpen(false)}>
          <div
            className="w-[460px] max-w-full bg-modal-bg border border-border-primary rounded-lg shadow-2xl flex flex-col max-h-[86vh] overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary flex-shrink-0">
              <h3 className="text-sm font-semibold flex items-center gap-2">
                <Key size={16} className="text-text-link" />
                AI 服务配置
              </h3>
              <button onClick={() => setOpen(false)} className="text-text-secondary hover:text-text-primary text-xl leading-none">×</button>
            </div>
            <div className="p-4 space-y-3 overflow-y-auto flex-1 min-h-0">
              <Field label="API 供应商">
                <div className="flex gap-2">
                  {(["openai", "custom"] as const).map((p) => (
                    <button
                      key={p}
                      type="button"
                      onClick={() => setForm({ ...form, provider: p })}
                      className={`flex-1 text-xs py-2 rounded border ${
                        form.provider === p
                          ? "bg-accent-20 border-accent text-accent-text"
                          : "bg-bg-secondary border-border-primary text-text-secondary"
                      }`}
                    >
                      {p === "openai" ? "OpenAI 兼容" : "自定义"}
                    </button>
                  ))}
                </div>
              </Field>
              <Field label="API Base URL">
                <input
                  className={inputCls}
                  placeholder="https://api.openai.com/v1"
                  value={form.baseUrl}
                  onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
                />
                <div className="text-[11px] text-text-secondary mt-1">
                  兼容 OpenAI / v1/chat/completions 格式的 API（如 deepseek、moonshot、qwen、local-ai 等）
                </div>
              </Field>
              <Field label="API Key">
                <input
                  type="password"
                  className={inputCls}
                  placeholder="sk-xxxx 或你的 API 密钥"
                  value={form.apiKey}
                  onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                />
              </Field>
              <Field label="模型名称（Model）">
                <input
                  className={inputCls}
                  placeholder="gpt-4o-mini / deepseek-chat / qwen-plus 等"
                  value={form.model}
                  onChange={(e) => setForm({ ...form, model: e.target.value })}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Temperature (0-2)">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    className={inputCls}
                    value={form.temperature}
                    onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })}
                  />
                </Field>
                <Field label="Max Tokens">
                  <input
                    type="number"
                    className={inputCls}
                    value={form.maxTokens}
                    onChange={(e) => setForm({ ...form, maxTokens: Number(e.target.value) })}
                  />
                </Field>
              </div>
              <Field label="自动分析终端报错">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setForm({ ...form, autoAnalyze: !form.autoAnalyze })}
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded text-xs border transition-colors ${
                      form.autoAnalyze
                        ? "bg-accent-20 border-accent text-accent-text"
                        : "bg-bg-secondary border-border-primary text-text-secondary"
                    }`}
                  >
                    <Activity size={13} />
                    {form.autoAnalyze ? "已开启：终端报错自动分析" : "已关闭"}
                  </button>
                </div>
                <div className="text-[11px] text-text-secondary mt-1">
                  开启后，终端出现错误/异常时，AI 会自动介入分析并给出修复命令（带 20 秒防抖，避免刷屏）
                </div>
              </Field>
            </div>
            <div className="flex justify-end gap-2 px-4 py-3 border-t border-border-primary flex-shrink-0 bg-bg-tertiary">
              <button
                onClick={() => setOpen(false)}
                className="px-3 py-1.5 text-xs rounded border border-border-primary hover:bg-bg-hover"
              >
                取消
              </button>
              <button
                onClick={save}
                className="px-3 py-1.5 text-xs rounded bg-success hover:bg-success-hover text-white"
              >
                保存配置
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const inputCls =
  "w-full bg-bg-secondary border border-border-primary rounded px-2.5 py-1.5 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent/50 placeholder:text-text-tertiary";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-xs text-text-secondary mb-1">{label}</div>
      {children}
    </label>
  );
}

// =============================================
// 聊天区
// =============================================
/**
 * loading 卡死守卫时长。
 *
 * 只要 isLoading 为 true，发送按钮就是 disabled 的（disabled={isLoading || ...}）。
 * 一旦 loading 因任何原因没能复位，用户就会遇到「问题输入了、点发送却毫无反应」——
 * 且没有任何自救入口。这里给一个比 AI 请求总超时（120s）多 30s 余量的守卫兜底。
 */
const LOADING_STUCK_GUARD_MS = 150_000;

function ChatArea({
  session,
  hostConfig,
  isProduction,
}: {
  session: ReturnType<typeof useTerminalStore.getState>["sessions"][number] | null;
  hostConfig: ReturnType<typeof useAppConfig.getState>["hosts"][number] | null;
  isProduction?: boolean;
}) {
  // 对话按终端会话隔离：切换标签页时这里读到的就是该会话自己的记录
  const {
    key: chatKey,
    messages,
    isLoading,
    error,
    addMessage,
    updateMessage,
    clearMessages,
    setLoading,
    setError,
  } = useSessionChat(session?.id ?? null);
  const aiConfig = useAppConfig((c) => c.aiConfig);
  const [input, setInput] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, isLoading]);

  // 切换终端会话时清空草稿输入框，避免把 A 会话里没发出去的内容误发到 B 会话
  useEffect(() => {
    setInput("");
  }, [chatKey]);

  // 切换会话 / 组件卸载时，中止上一个会话仍在进行的请求。
  // ChatArea 没有 key，切换会话时组件不重建，abortRef 会一直指向旧 controller：
  // 在新会话点「停止」会停错会话，旧会话的 loading 也可能残留成永久 disabled。
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [chatKey]);

  // 兜底：loading 若卡死（请求既没成功也没抛错），强制复位并给出提示，
  // 否则发送按钮会永久 disabled，用户只能重启应用。
  useEffect(() => {
    if (!isLoading) return;
    const guard = setTimeout(() => {
      setLoading(false);
      setError("请求长时间未响应，已自动恢复，请重试。");
    }, LOADING_STUCK_GUARD_MS);
    return () => clearTimeout(guard);
  }, [isLoading, setLoading, setError]);

  // 每个会话首次打开时各生成一次欢迎语（用 Set 记录，切换会话不会互相影响）
  const welcomedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!chatKey) return;
    if (welcomedRef.current.has(chatKey)) return;
    if (messages.length > 0) {
      welcomedRef.current.add(chatKey);
      return;
    }
    welcomedRef.current.add(chatKey);
    addMessage({
      role: "assistant",
      content: WELCOME_TEMPLATE({
        hostname: session?.hostName,
        host: session?.host,
        hasKey: !!aiConfig.apiKey,
      }),
      commands: [],
    });
  }, [chatKey, messages, addMessage, session, aiConfig.apiKey]);

  const send = async (text?: string) => {
    const content = (text ?? input).trim();
    if (!content) return;
    if (!aiConfig.apiKey) {
      setError("请先点击右上角 ⚙️ 设置 API Key");
      return;
    }
    setError(null);

    addMessage({ role: "user", content });
    setInput("");

    // 若上一个请求仍在进行（例如通过快捷提示绕过 disabled 的发送按钮触发），
    // 先中止它，避免两个请求并发写同一会话的消息、并互相覆盖 loading 状态。
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    // 先放一个空占位消息，流式输出时实时填充，避免「等半天没反应」
    const placeholder = addMessage({ role: "assistant", content: "", commands: [] });
    let acc = "";
    let lastFlush = 0;
    try {
      const { commands } = await chatCompletion({
        config: aiConfig,
        userMessage: content,
        chatHistory: messages,
        terminalCtx: session,
        hostConfig,
        signal: controller.signal,
        onToken: (delta) => {
          acc += delta;
          const now = Date.now();
          if (now - lastFlush >= 60) {
            lastFlush = now;
            updateMessage(placeholder.id, { content: acc });
          }
        },
      });
      // 收尾确保完整文本落盘（节流可能漏掉末尾几字）
      updateMessage(placeholder.id, { content: acc, commands });
    } catch (e: unknown) {
      if ((e as { name?: string })?.name === "AbortError") {
        updateMessage(placeholder.id, { content: "_请求已取消_" });
      } else {
        const msg = (e as Error).message;
        setError(msg);
        updateMessage(
          placeholder.id,
          { content: `❌ 请求失败：\`${msg}\`\n\n请检查 API Key、Base URL 和网络是否正确。` }
        );
      }
    } finally {
      // 只有自己仍是「当前请求」时才复位 loading 与 abortRef。
      // 无条件复位的话，先发起的请求结束后会把后发起的请求错误地标记为已完成
      // （loading 被提前清掉 → 按钮提前可用 → 更容易并发）。
      if (abortRef.current === controller) {
        setLoading(false);
        abortRef.current = null;
      }
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  // 注：终端里输入 `?问题` 触发的 termai:quick-ask 事件统一由 Home 的
  // QuickAskBridge 处理（全局唯一监听），此处不再重复监听，否则同一次提问
  // 会被两个监听器各发一次，导致对话里出现重复的用户/助手消息。

  const privilege = useMemo<"root" | "sudoer" | "user">(() => {
    if (!session) return "user";
    if (session.username === "root") return "root";
    return "user";
  }, [session]);

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* 快捷提示 */}
      <div className="px-3 py-2 border-b border-border-primary flex items-center gap-2 overflow-x-auto flex-shrink-0">
        <QuickPill icon={AlertCircle} text="分析终端错误" onClick={() => send("请分析我终端最近的输出，找出是否有错误或问题，并给出修复方案")} />
        <QuickPill icon={History} text="分析我的操作" onClick={() => send("请分析我最近在终端中的操作序列（命令历史与对应输出），总结我做了什么，指出可能的错误/风险，并给出下一步建议。")} />
        <QuickPill icon={Stethoscope} text="诊断系统资源" onClick={() => send("帮我看看这台服务器的 CPU、内存、磁盘占用情况，给出诊断建议")} />
        <QuickPill icon={SearchCode} text="查看端口占用" onClick={() => send("帮我查看占用端口的进程，列出正在监听的端口和对应服务")} />
        <QuickPill icon={Wrench} text="安装 Nginx" onClick={() => send("帮我安装和配置 Nginx")} />
        <QuickPill icon={FileCode2} text="备份脚本" onClick={() => send("帮我写个自动备份的 shell 脚本")} />
      </div>

      {/* 消息区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="text-center text-xs text-text-secondary py-8">
            <Wand2 size={32} className="mx-auto mb-2 opacity-50" />
            正在加载...
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            role={m.role}
            content={m.content}
            commands={m.commands && m.commands.length > 0 ? m.commands : parseCommandsFromMarkdown(m.content)}
            session={session}
            isProduction={isProduction}
            privilege={privilege}
            onRenderCommandsDone={(cmds) => {
              if (!m.commands || m.commands.length === 0) {
                updateMessage(m.id, { commands: cmds });
              }
            }}
          />
        ))}
        {isLoading && (
          <div className="flex items-start gap-2">
            <Avatar role="assistant" />
            <div className="flex-1 bg-bg-tertiary border border-border-primary rounded-lg px-3 py-2 text-xs text-text-secondary">
              <span className="inline-flex items-center gap-1.5">
                <Loader2 size={13} className="animate-spin text-text-link" />
                AI 正在思考...
                <button onClick={stop} className="ml-3 text-[11px] px-2 py-0.5 rounded border border-border-primary hover:bg-bg-hover">
                  停止生成
                </button>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="px-3 py-2 mx-3 mb-2 text-xs rounded bg-danger/10 border border-danger/30 text-danger-text flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
          <div className="flex-1 whitespace-pre-wrap">{error}</div>
          <button onClick={() => setError(null)} className="text-danger-text/70 hover:text-danger">×</button>
        </div>
      )}

      {/* 输入区 */}
      <div className="border-t border-border-primary p-2 flex-shrink-0">
        <div className="bg-bg-tertiary border border-border-primary focus-within:border-accent rounded-lg overflow-hidden">
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              aiConfig.apiKey
                ? "输入你的问题...（Enter 发送，Shift+Enter 换行）"
                : "请先点击上方 ⚙️ 按钮配置 API Key..."
            }
            className="w-full bg-transparent p-2.5 text-sm outline-none resize-none placeholder:text-text-tertiary text-text-primary"
          />
          <div className="flex items-center justify-between px-2 py-1.5 border-t border-border-primary/50">
            <div className="flex items-center gap-2">
              <button
                onClick={clearMessages}
                className="p-1 text-text-secondary hover:text-danger-text rounded hover:bg-bg-hover"
                title="清空对话"
              >
                <Trash2 size={14} />
              </button>
              <ContextInfo session={session} host={hostConfig} />
            </div>
            <button
              onClick={() => send()}
              disabled={isLoading || !input.trim()}
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded bg-accent hover:bg-accent-hover disabled:bg-bg-hover disabled:text-text-tertiary disabled:cursor-not-allowed text-white"
            >
              <Send size={13} />
              {isLoading ? "生成中..." : "发送"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function QuickPill({
  icon: Icon,
  text,
  onClick,
}: {
  icon: React.ComponentType<{ size?: number | string; className?: string }>;
  text: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] rounded-full bg-bg-tertiary border border-border-primary hover:border-accent hover:text-accent-text text-text-secondary flex-shrink-0 whitespace-nowrap"
    >
      <Icon size={12} />
      {text}
    </button>
  );
}

function ContextInfo({
  session,
  host,
}: {
  session: ReturnType<typeof useTerminalStore.getState>["sessions"][number] | null;
  host: ReturnType<typeof useAppConfig.getState>["hosts"][number] | null;
}) {
  const [open, setOpen] = useState(false);
  if (!session) {
    return (
      <span className="text-[10px] text-text-secondary inline-flex items-center gap-1">
        <Info size={11} />
        未连接终端
      </span>
    );
  }
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-bg-secondary border border-border-primary text-text-secondary hover:text-text-primary"
      >
        {session.status === "connected" ? (
          <span className="w-1.5 h-1.5 rounded-full bg-success-text" />
        ) : (
          <span className="w-1.5 h-1.5 rounded-full bg-warning-text" />
        )}
        {session.username}@{session.hostName || session.host}
        <ChevronDown size={11} />
      </button>
      {open && (
        <div className="absolute bottom-full left-0 mb-2 w-72 p-3 rounded-lg bg-bg-tertiary border border-border-primary shadow-xl text-[11px] space-y-2 z-10">
          <div>
            <div className="text-text-secondary mb-1">主机</div>
            <div>{session.host}（{session.hostName}）</div>
          </div>
          <div>
            <div className="text-text-secondary mb-1">标签</div>
            <div className="flex flex-wrap gap-1">
              {(host?.tags?.length ?? 0) > 0
                ? host!.tags.map((t) => (
                    <span key={t} className="px-1.5 py-0.5 rounded bg-accent-20 text-accent-text">
                      {t}
                    </span>
                  ))
                : <span className="text-text-tertiary">无</span>}
            </div>
          </div>
          <div>
            <div className="text-text-secondary mb-1">最近输出（{session.recentOutput.length} 行）</div>
            <div className="max-h-20 overflow-y-auto bg-bg-secondary rounded p-1.5 font-mono text-[10px] text-text-secondary whitespace-pre-wrap">
              {session.recentOutput.slice(-10).join("\n") || "（暂无）"}
            </div>
          </div>
          <div>
            <div className="text-text-secondary mb-1">命令历史（{session.history.length} 条）</div>
            <div className="max-h-20 overflow-y-auto bg-bg-secondary rounded p-1.5 font-mono text-[10px] text-text-secondary space-y-0.5">
              {session.history.length
                ? session.history.map((h, i) => <div key={i}>$ {h}</div>)
                : "（暂无）"}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Avatar({ role }: { role: "user" | "assistant" }) {
  if (role === "user") {
    return (
      <div className="w-7 h-7 flex-shrink-0 rounded-full bg-accent-20 border border-accent/40 flex items-center justify-center">
        <User size={14} className="text-accent-text" />
      </div>
    );
  }
  return (
    <div
      className="w-7 h-7 flex-shrink-0 rounded-full border border-accent/30 flex items-center justify-center"
      style={accentGradient}
    >
      <Bot size={14} className="text-white" />
    </div>
  );
}

function MessageBubble({
  role,
  content,
  commands,
  session,
  isProduction,
  privilege,
  onRenderCommandsDone,
}: {
  role: "user" | "assistant" | "system";
  content: string;
  commands?: ParsedCommand[];
  session: ReturnType<typeof useTerminalStore.getState>["sessions"][number] | null;
  isProduction?: boolean;
  privilege?: "root" | "sudoer" | "user";
  onRenderCommandsDone?: (cmds: ParsedCommand[]) => void;
}) {
  useEffect(() => {
    if (commands && commands.length > 0) onRenderCommandsDone?.(commands);
  }, [commands, onRenderCommandsDone]);

  const parts = useMemo(() => splitTextAndCode(content, commands ?? []), [content, commands]);

  if (role === "system") return null;

  return (
    <div className={`flex items-start gap-2 ${role === "user" ? "flex-row-reverse" : ""}`}>
      <Avatar role={role} />
      <div className={`max-w-[92%] flex-1 ${role === "user" ? "items-end" : "items-start"}`}>
        <div
          className={`px-3 py-2 rounded-lg text-sm whitespace-pre-wrap break-words leading-relaxed ${
            role === "user"
              ? "bg-accent-20 border border-accent/40 text-text-primary"
              : "bg-bg-tertiary border border-border-primary text-text-primary"
          }`}
        >
          {parts.map((part, i) =>
            part.type === "text" ? (
              <div key={i} dangerouslySetInnerHTML={{ __html: linkify(escapeHtml(part.text)) }} />
            ) : (
              <CommandCard
                key={part.cmd.id + i}
                command={part.cmd}
                sessionId={session?.id ?? null}
                sessionConnected={session?.connected ?? false}
                isProduction={isProduction}
                privilege={privilege}
              />
            )
          )}
        </div>
      </div>
    </div>
  );
}

function splitTextAndCode(
  md: string,
  commands: ParsedCommand[]
): Array<{ type: "text"; text: string } | { type: "code"; cmd: ParsedCommand }> {
  const result: Array<{ type: "text"; text: string } | { type: "code"; cmd: ParsedCommand }> = [];
  let cmdIdx = 0;

  const regex = /```[A-Za-z0-9_+-]*(?::risk=[a-z]+)?\s*\n[\s\S]*?```/g;
  let lastLastIndex = 0;
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(md)) !== null) {
    if (match.index > lastLastIndex) {
      result.push({ type: "text", text: md.slice(lastLastIndex, match.index) });
    }
    const cmd = commands[cmdIdx++] ?? {
      id: `fallback_${cmdIdx}`,
      command: match[0].replace(/```[^\n]*\n/, "").replace(/```$/, "").trim(),
      language: "bash",
      riskLevel: "low",
    };
    result.push({ type: "code", cmd });
    lastLastIndex = match.index + match[0].length;
  }
  if (lastLastIndex < md.length) {
    result.push({ type: "text", text: md.slice(lastLastIndex) });
  }
  if (result.length === 0) {
    result.push({ type: "text", text: md });
  }
  return result;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, '<code class="px-1 py-0.5 mx-0.5 rounded bg-overlay border border-border-primary font-mono text-[0.9em]">$1</code>')
    .replace(/(^|\n) - /g, "$1• ");
}

// 不变量：linkify 的输入必须是 escapeHtml 的输出。字符类显式排除引号，
// 这样即使将来有人调换调用顺序，也无法用引号闭合 href 来注入属性（如 onmouseover）。
function linkify(s: string): string {
  return s.replace(/(https?:\/\/[^\s<"']+)/g, '<a href="$1" target="_blank" rel="noreferrer" class="text-text-link underline underline-offset-2">$1</a>');
}

function WELCOME_TEMPLATE({
  hostname,
  host,
  hasKey,
}: {
  hostname?: string;
  host?: string;
  hasKey: boolean;
}): string {
  return `👋 你好！我是 **TermAI 终端助手**，已与你的终端深度整合。

我可以帮你完成：

| 能力 | 用法 |
|---|---|
| 🚀 生成命令 | "帮我查看 **8080** 端口占用" |
| 🐛 自动排查错误 | 点击上方「分析终端错误」或直接说「帮我看看什么问题」——我会自动读取终端输出 |
| 📜 写脚本 | "写个自动备份 MySQL 的脚本" |
| 🔍 诊断系统 | "这台服务器为什么卡？帮我分析" |
| 📖 解释命令 | "这条 \`grep -E '^a.*z$'\` 是什么意思？" |

💡 **核心特性**：
- ✅ **自动读取终端输出**：你不需要复制粘贴报错，我能看到最近 80 行终端内容和命令历史（含你执行的每条命令）
- ✅ 在终端中输入 \`?你的问题\` 可直接唤起我（如：\`?为什么 nginx 启动失败\`）
- ✅ 点击「分析我的操作」可让我总结你整段终端操作、指出风险与下一步建议
- ✅ 开启「自动分析终端报错」（⚙️ 设置）后，终端一旦出现报错我会**自动介入**分析
- ✅ 每条命令我都会检查**安全性**，高风险操作会强制二次确认
- ✅ 未连接主机时也可以问我纯知识性问题

${
  hostname && host
    ? `📌 **当前已连接**：${hostname}（${host}）—— 我正在实时监控终端输出，有问题直接问！`
    : `📌 请在左侧连接一台 SSH 主机后，我会自动接入终端上下文。`
}
${hasKey ? "" : `⚠️ **还未配置 API Key** —— 请点击右上角 ⚙️ 按钮填写。`}

现在你想做什么？`;
}