/**
 * 「需要手动执行的操作」里到底该不该出现命令？
 *
 * 背景（实测事故）：用户让 Agent 装 zabbix，因文件冲突失败 → 想卸载冲突包被用户跳过 →
 * 模型原样重跑同一条 install 又失败 → 直接 DONE，把 `yum remove` / `yum install`
 * 抄进「需要手动执行的操作」丢回给用户。用户看到的就是「它为什么还是让我手动执行」。
 *
 * 这里只做一件事：**从总结的该段落里挑出「本来可以由引擎自己下发」的变更命令**。
 * 判断留给调用方（要结合本轮是否真有 blocked / 被跳过的命令）。
 */

/** 变更类命令的形态：包管理安装/卸载、服务启停、文件增删改 */
const CHANGE_CMD_RE = new RegExp(
  [
    // 包管理：install / remove / update 等
    String.raw`\b(?:yum|dnf|apt-get|apt|rpm|dpkg|zypper|pacman|apk)\s+(?:-\S+\s+)*(?:install|remove|erase|purge|update|upgrade|reinstall|localinstall)\b`,
    // 服务管理：启停/开机自启/重载
    String.raw`\b(?:systemctl|service)\s+(?:-\S+\s+)*(?:start|stop|restart|reload|enable|disable|daemon-reload|mask)\b`,
    // 文件/权限变更
    String.raw`\b(?:rm|mv|cp|chmod|chown|ln|mkdir|touch)\s+-`,
    // 配置落盘（非受保护路径的常见形态）
    String.raw`\bsed\s+-i\b`,
  ].join("|")
);

/** 取「需要手动执行的操作」段落正文；没有该段落返回 null */
export function extractManualSection(markdown: string): string | null {
  if (!markdown) return null;
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) =>
    // 兼容 `## 需要手动执行的操作` / `**需要手动执行的操作**` / `### 需要手动执行的操作：`
    /^\s*(?:#{1,6}\s*)?\*{0,2}\s*需要手动执行的操作\s*[:：]?\s*\*{0,2}\s*$/.test(l)
  );
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    // 下一个同级或更高级标题即段落结束
    if (/^\s*#{1,6}\s+\S/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join("\n").trim();
}

/**
 * 段落里「可以由引擎自己执行」的变更命令。
 *
 * 只认**变更类**：`ls -l /etc/ssh/sshd_config` 这种只读确认留在手动清单里是合理的，
 * 不该被误判成推卸。
 */
export function findDeferrableCommands(markdown: string): string[] {
  const section = extractManualSection(markdown);
  if (!section) return [];
  const out: string[] = [];
  for (const raw of section.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (!CHANGE_CMD_RE.test(line)) continue;
    if (out.includes(line)) continue;
    out.push(line);
  }
  return out;
}
