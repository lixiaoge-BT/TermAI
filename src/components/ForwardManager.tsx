import { useEffect, useState } from "react";
import { Network, Plus, Trash2, Play, Square, X } from "lucide-react";
import { useAppConfig } from "@/store/config";
import { useForwardStore } from "@/store/forward";
import { useTerminalStore } from "@/store/terminal";
import type { HostConfig, SshForwardConfig, SshForwardType, SshForwardStatus } from "@/types";

export function ForwardManager() {
  const forwardHostId = useAppConfig((s) => s.forwardHostId);
  const getHost = useAppConfig((s) => s.getHost);
  const closeForward = useAppConfig((s) => s.closeForward);
  const host = forwardHostId ? getHost(forwardHostId) : undefined;
  if (!forwardHostId || !host) return null;
  return <ForwardManagerInner host={host} onClose={closeForward} />;
}

const TYPE_LABEL: Record<SshForwardType, string> = {
  local: "本地转发",
  remote: "远程转发",
  dynamic: "动态(SOCKS5)",
};

function mappingText(cfg: SshForwardConfig, live?: SshForwardStatus): string {
  const local = `${cfg.localAddress || "127.0.0.1"}:${(live?.localPort ?? cfg.localPort) || "?"}`;
  if (cfg.type === "dynamic") return `SOCKS5 代理监听于 ${local}`;
  if (cfg.type === "local")
    return `${local} → ${cfg.remoteAddress}:${cfg.remotePort}`;
  // remote：远端绑定端口转发到本地目标
  const bind = (live?.bindPort ?? cfg.localPort) || "?";
  return `远端 :${bind} → 本地 ${cfg.remoteAddress}:${cfg.remotePort}`;
}

function ForwardManagerInner({ host, onClose }: { host: HostConfig; onClose: () => void }) {
  const updateHost = useAppConfig((s) => s.updateHost);
  const init = useForwardStore((s) => s.init);
  const statuses = useForwardStore((s) => s.statuses);
  const start = useForwardStore((s) => s.start);
  const stop = useForwardStore((s) => s.stop);
  const refresh = useForwardStore((s) => s.refresh);

  // 该主机当前已连接的会话（转发需依附于已建立的 SSH 连接）
  const sessionId = useTerminalStore(
    (s) => s.sessions.find((x) => x.hostId === host.id && x.connected)?.id
  );

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    type: "local" as SshForwardType,
    localAddress: "127.0.0.1",
    localPort: 0,
    remoteAddress: "127.0.0.1",
    remotePort: 3306,
    enabled: true,
  });

  useEffect(() => {
    init();
    if (sessionId) void refresh(sessionId);
  }, [init, refresh, sessionId]);

  const cfgList = host.forwards ?? [];

  const liveStatus = (id: string): SshForwardStatus | undefined =>
    sessionId ? statuses[sessionId]?.find((x) => x.id === id) : undefined;

  const saveConfig = (next: SshForwardConfig[]) => {
    updateHost(host.id, { forwards: next });
  };

  const handleAdd = () => {
    const id = `fw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const cfg: SshForwardConfig = {
      id,
      type: form.type,
      localAddress: form.localAddress || "127.0.0.1",
      localPort: Number(form.localPort) || 0,
      remoteAddress: form.remoteAddress,
      remotePort: Number(form.remotePort) || 0,
      enabled: form.enabled,
    };
    saveConfig([...cfgList, cfg]);
    setShowForm(false);
    if (sessionId && cfg.enabled) void start(sessionId, cfg);
  };

  const handleDelete = (id: string) => {
    if (sessionId) void stop(sessionId, id);
    saveConfig(cfgList.filter((c) => c.id !== id));
  };

  const toggleEnabled = (cfg: SshForwardConfig) => {
    saveConfig(cfgList.map((c) => (c.id === cfg.id ? { ...c, enabled: !c.enabled } : c)));
  };

  const live = (cfg: SshForwardConfig) => liveStatus(cfg.id);

  return (
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40">
      <div className="w-[520px] max-h-[80vh] flex flex-col bg-dropdown-bg border border-border-primary rounded-xl shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border-primary">
          <div className="flex items-center gap-2">
            <Network size={16} className="text-text-link" />
            <span className="text-sm font-semibold">端口转发</span>
            <span className="text-xs text-text-secondary">{host.name}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-bg-hover text-text-secondary"
            title="关闭"
          >
            <X size={16} />
          </button>
        </div>

        {!sessionId && (
          <div className="px-4 py-2 text-xs text-warning-text bg-warning-10 border-b border-border-primary">
            该主机当前未连接，转发需在 SSH 连接建立后才能启用。
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
          {cfgList.length === 0 && (
            <div className="text-xs text-text-secondary py-6 text-center">
              暂无转发规则，点击「新增转发」添加。
            </div>
          )}
          {cfgList.map((cfg) => {
            const st = live(cfg);
            const listening = st?.listening && !st?.error;
            return (
              <div
                key={cfg.id}
                className="border border-border-primary rounded-lg px-3 py-2 bg-bg-secondary"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] px-1.5 py-0.5 rounded bg-accent-20 text-text-link">
                        {TYPE_LABEL[cfg.type]}
                      </span>
                      {cfg.enabled && (
                        <span className="text-[10px] px-1 rounded bg-success-10 text-success-text">
                          自动恢复
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-text-primary mt-1 truncate">
                      {mappingText(cfg, st)}
                    </div>
                    <div className="text-[11px] mt-0.5">
                      {st?.error ? (
                        <span className="text-danger-text">错误：{st.error}</span>
                      ) : listening ? (
                        <span className="text-success-text">● 监听中</span>
                      ) : (
                        <span className="text-text-tertiary">○ 未启动</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      disabled={!sessionId}
                      onClick={() => (listening ? stop(sessionId!, cfg.id) : start(sessionId!, cfg))}
                      className="p-1.5 rounded hover:bg-bg-hover text-text-secondary disabled:opacity-40"
                      title={listening ? "停止" : "启动"}
                    >
                      {listening ? <Square size={13} /> : <Play size={13} />}
                    </button>
                    <button
                      onClick={() => toggleEnabled(cfg)}
                      className="p-1.5 rounded hover:bg-bg-hover text-text-secondary"
                      title={cfg.enabled ? "禁用自动恢复" : "启用自动恢复"}
                    >
                      <div
                        className={`w-7 h-4 rounded-full relative transition-colors ${
                          cfg.enabled ? "bg-success-text" : "bg-bg-hover"
                        }`}
                      >
                        <div
                          className={`absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all ${
                            cfg.enabled ? "left-3.5" : "left-0.5"
                          }`}
                        />
                      </div>
                    </button>
                    <button
                      onClick={() => handleDelete(cfg.id)}
                      className="p-1.5 rounded hover:bg-bg-hover text-text-secondary hover:text-danger-text"
                      title="删除"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="border-t border-border-primary px-4 py-3">
          {showForm ? (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <select
                  value={form.type}
                  onChange={(e) => setForm({ ...form, type: e.target.value as SshForwardType })}
                  className="bg-bg-tertiary border border-border-primary rounded px-2 py-1 text-xs"
                >
                  <option value="local">本地转发</option>
                  <option value="remote">远程转发</option>
                  <option value="dynamic">动态(SOCKS5)</option>
                </select>
                <input
                  value={form.localAddress}
                  onChange={(e) => setForm({ ...form, localAddress: e.target.value })}
                  placeholder="本地地址"
                  className="flex-1 bg-bg-tertiary border border-border-primary rounded px-2 py-1 text-xs"
                />
                <input
                  type="number"
                  value={form.localPort}
                  onChange={(e) => setForm({ ...form, localPort: Number(e.target.value) })}
                  placeholder="本地端口(0=随机)"
                  className="w-28 bg-bg-tertiary border border-border-primary rounded px-2 py-1 text-xs"
                />
              </div>
              {form.type !== "dynamic" && (
                <div className="flex items-center gap-2">
                  <input
                    value={form.remoteAddress}
                    onChange={(e) => setForm({ ...form, remoteAddress: e.target.value })}
                    placeholder={form.type === "local" ? "远端目标地址" : "本机目标地址"}
                    className="flex-1 bg-bg-tertiary border border-border-primary rounded px-2 py-1 text-xs"
                  />
                  <input
                    type="number"
                    value={form.remotePort}
                    onChange={(e) => setForm({ ...form, remotePort: Number(e.target.value) })}
                    placeholder="目标端口"
                    className="w-28 bg-bg-tertiary border border-border-primary rounded px-2 py-1 text-xs"
                  />
                </div>
              )}
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-xs text-text-secondary">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  />
                  连接后自动恢复
                </label>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowForm(false)}
                    className="px-2 py-1 rounded text-xs hover:bg-bg-hover text-text-secondary"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleAdd}
                    className="px-3 py-1 rounded text-xs bg-accent text-white"
                  >
                    添加
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowForm(true)}
              className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg border border-dashed border-border-primary text-xs text-text-secondary hover:text-text-primary hover:bg-bg-tertiary"
            >
              <Plus size={14} />
              新增转发
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
