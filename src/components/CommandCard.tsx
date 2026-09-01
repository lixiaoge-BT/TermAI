import { useState } from "react";
import { Copy, Play, Pencil, CheckCircle2, AlertTriangle, AlertOctagon, ShieldAlert, Shield } from "lucide-react";
import type { ParsedCommand } from "@/types";
import { reviewCommand, type RiskLevel } from "@/services/safety";

interface Props {
  command: ParsedCommand;
  sessionId: string | null;
  sessionConnected: boolean;
  isProduction?: boolean;
  privilege?: "root" | "sudoer" | "user";
  onRun?: (command: string) => void;
}

const RISK_META: Record<
  RiskLevel,
  { label: string; color: string; bg: string; icon: React.ComponentType<{ size?: number | string; className?: string }> }
> = {
  none: { label: "安全", color: "text-green-400", bg: "bg-green-900/30 border-green-700/50", icon: Shield },
  low: { label: "低风险", color: "text-blue-400", bg: "bg-blue-900/30 border-blue-700/50", icon: CheckCircle2 },
  medium: { label: "中风险", color: "text-yellow-400", bg: "bg-yellow-900/30 border-yellow-700/50", icon: AlertTriangle },
  high: { label: "高风险", color: "text-orange-400", bg: "bg-orange-900/30 border-orange-700/50", icon: ShieldAlert },
  critical: { label: "⚠️ 致命风险", color: "text-red-400", bg: "bg-red-900/30 border-red-700/50", icon: AlertOctagon },
};

export function CommandCard({ command, sessionId, sessionConnected, isProduction, privilege, onRun }: Props) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(command.command);
  const [showConfirm, setShowConfirm] = useState(false);

  const review = reviewCommand(command.command, { isProduction,  privilege });

  // 优先展示 AI 在代码块里标注的风险级别（命令级），本地规则结果作为兜底
  const effectiveRisk: RiskLevel = command.riskLevel || review.riskLevel;
  const effectiveMeta = RISK_META[effectiveRisk];

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      alert("复制失败：" + (e as Error).message);
    }
  };

  const handleRun = () => {
    if (review.requireConfirmation) {
      setShowConfirm(true);
      return;
    }
    doRun();
  };

  const doRun = () => {
    setShowConfirm(false);
    if (!sessionId || !sessionConnected) {
      alert("请先连接一台 SSH 主机");
      return;
    }
    const toSend = value.endsWith("\n") ? value : value + "\n";
    const w = window as unknown as {
      __termai_writeTerminal?: (sid: string, data: string) => void;
    };
    w.__termai_writeTerminal?.(sessionId, toSend);
    onRun?.(value);
  };

  return (
    <div className={`my-2 rounded-lg border overflow-hidden ${effectiveMeta.bg}`}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/10">
        <div className="flex items-center gap-2 text-xs">
          <effectiveMeta.icon size={13} className={effectiveMeta.color} />
          <span className={`font-medium ${effectiveMeta.color}`}>{effectiveMeta.label}</span>
          <span className="text-white/40">·</span>
          <span className="text-white/60 font-mono">{command.language}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setEditing((v) => !v)}
            title="编辑命令"
            className="px-2 py-1 text-[11px] rounded hover:bg-white/10 text-white/70 hover:text-white flex items-center gap-1"
          >
            <Pencil size={12} />
            {editing ? "完成" : "编辑"}
          </button>
          <button
            onClick={copy}
            title="复制到剪贴板"
            className="px-2 py-1 text-[11px] rounded hover:bg-white/10 text-white/70 hover:text-white flex items-center gap-1"
          >
            {copied ? <CheckCircle2 size={12} className="text-green-400" /> : <Copy size={12} />}
            {copied ? "已复制" : "复制"}
          </button>
          <button
            onClick={handleRun}
            disabled={!sessionConnected}
            title={sessionConnected ? "在终端执行此命令" : "请先连接主机"}
            className="px-2 py-1 text-[11px] rounded bg-success hover:bg-success-hover disabled:bg-bg-hover disabled:text-text-tertiary disabled:cursor-not-allowed text-white flex items-center gap-1"
          >
            <Play size={12} />
            执行
          </button>
        </div>
      </div>

      {editing ? (
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={Math.min(12, Math.max(2, value.split("\n").length + 1))}
          className="w-full bg-bg-tertiary p-3 font-mono text-xs text-text-primary outline-none border-0 resize-none"
        />
      ) : (
        <pre className="bg-bg-tertiary p-3 overflow-x-auto font-mono text-xs text-text-primary whitespace-pre-wrap break-words">
{value}
        </pre>
      )}

      {review.riskDescription && (
        <div className="px-3 py-2 text-xs text-white/80 border-t border-white/10 bg-black/20 flex items-start gap-2">
          <AlertTriangle size={14} className="text-yellow-400 mt-0.5 flex-shrink-0" />
          <div>
            <div className="font-medium">{review.riskDescription}</div>
            {review.backupSuggestion && <div className="mt-0.5 text-white/60">💡 {review.backupSuggestion}</div>}
            {review.suggestedAlternative && <div className="mt-0.5 text-white/60">更安全的替代：{review.suggestedAlternative}</div>}
          </div>
        </div>
      )}

      {/* 二次确认弹窗 */}
      {showConfirm && (
        <div className="px-3 py-3 border-t border-white/10 bg-red-950/40">
          <div className="flex items-start gap-2 mb-2">
            <AlertOctagon size={18} className="text-red-400 flex-shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-semibold text-red-300">高风险操作，请确认以下事项</div>
              <div className="text-xs text-white/70 mt-0.5">{review.riskDescription}</div>
            </div>
          </div>
          <ul className="space-y-1 text-xs pl-6 mb-3">
            {review.confirmationItems.map((item, i) => (
              <li key={i} className="flex items-start gap-1.5 text-white/80">
                <span className="text-red-400">▪</span>
                {item}
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setShowConfirm(false)}
              className="px-3 py-1.5 text-xs rounded border border-white/20 hover:bg-white/10"
            >
              取消
            </button>
            <button
              onClick={doRun}
              className="px-3 py-1.5 text-xs rounded bg-red-600 hover:bg-red-500 text-white font-medium"
            >
              ⚠️ 我已知风险，确认执行
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
