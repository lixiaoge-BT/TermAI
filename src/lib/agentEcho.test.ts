import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  beginAgentEchoFilter,
  endAgentEchoFilter,
  filterAgentEchoForDisplay,
  type AgentEchoTags,
} from "./agentEcho";

const SID = "s1";
const T: AgentEchoTags = {
  begin: "TERMAI_BEGIN_t1a2b3",
  exitTag: "TERMAI_EXIT_t1a2b3",
  end: "TERMAI_END_t1a2b3",
};
const PROMPT = "[root@node1 ~]# ";
const ECHO_LINE = `echo "${T.begin}"; ls -la /usr/local/prometheus-2.47.0/ 2>&1; echo "${T.exitTag}:$?"; echo "${T.end}"`;
const REAL = "total 8\r\ndrwxr-xr-x 2 root root 4096 prometheus.yml\r\n";
const FULL_STREAM = `${PROMPT}${ECHO_LINE}\r\n${T.begin}\r\n${REAL}${T.exitTag}:0\r\n${T.end}\r\n`;

describe("filterAgentEchoForDisplay（Agent 哨兵回显过滤）", () => {
  it("未开启窗口时一字不动 —— 用户手敲同名字符串也不受影响", () => {
    const s = `${PROMPT}echo "${T.begin}"\r\n${T.begin}\r\n`;
    assert.equal(filterAgentEchoForDisplay(SID, s), s);
  });

  it("回显行与三条哨兵输出行全部剔除，真实输出前补回换行", () => {
    beginAgentEchoFilter(SID, T);
    assert.equal(filterAgentEchoForDisplay(SID, FULL_STREAM), "\r\n" + REAL);
    endAgentEchoFilter(SID);
  });

  it("回显行被数据包切两段，也整段剔除（区间抑制，不需要尾行暂存）", () => {
    beginAgentEchoFilter(SID, T);
    // 第一包正好切在 token 中间：不能把这段残缺的回显漏到终端上
    assert.equal(filterAgentEchoForDisplay(SID, `[root@node1 ~]# echo "TERMAI_BE`), "");
    const rest =
      `GIN_t1a2b3"; ls -la 2>&1; echo "${T.exitTag}:$?"; echo "${T.end}"\r\n` +
      `${T.begin}\r\n${REAL}${T.exitTag}:0\r\n${T.end}\r\n`;
    assert.equal(filterAgentEchoForDisplay(SID, rest), "\r\n" + REAL);
    endAgentEchoFilter(SID);
  });

  it("回显行被 readline 按终端宽度插入换行，也能整段剔除", () => {
    beginAgentEchoFilter(SID, T);
    const wrapped =
      `${PROMPT}echo "${T.begin}"; ls -la\r\n` +
      `/usr/local/prometheus-2.47.0/ 2>&1; echo "${T.exitTag}:$?"\r\n` +
      `; echo "${T.end}"\r\n${T.begin}\r\nreal\r\n`;
    assert.equal(filterAgentEchoForDisplay(SID, wrapped), "\r\nreal\r\n");
    endAgentEchoFilter(SID);
  });

  it("BEGIN 行的换行被包边界切走时，不产生多余空行", () => {
    beginAgentEchoFilter(SID, T);
    assert.equal(filterAgentEchoForDisplay(SID, `junk\r\n${T.begin}`), "\r\n");
    assert.equal(filterAgentEchoForDisplay(SID, `\r\nreal\r\n`), "real\r\n");
    endAgentEchoFilter(SID);
  });

  it("窗口生效时真实输出的末尾残行照常透出，不被扣留", () => {
    beginAgentEchoFilter(SID, T);
    filterAgentEchoForDisplay(SID, `${T.begin}\r\ntotal 8\r\n`);
    assert.equal(
      filterAgentEchoForDisplay(SID, "drwxr-xr-x 2 root root"),
      "drwxr-xr-x 2 root root"
    );
    endAgentEchoFilter(SID);
  });

  it("回归：命令无输出时下一条提示符不贴在旧提示符同一行（成对提示符）", () => {
    // 第一条命令：有输出，结束后 shell 打印提示符（此时上一窗口已关，提示符原样透出）
    beginAgentEchoFilter(SID, T);
    assert.equal(
      filterAgentEchoForDisplay(
        SID,
        `${T.begin}\r\nlisting\r\n${T.exitTag}:0\r\n${T.end}\r\n`
      ),
      "\r\nlisting\r\n"
    );
    endAgentEchoFilter(SID);
    const visible1 = PROMPT; // 提示符透传，光标停在提示符后
    // 第二条命令：回显被整段抑制，且命令本身零输出（如 ls | grep -v x | xargs rm -rf）
    beginAgentEchoFilter(SID, T);
    const silent =
      `echo "${T.begin}"; ls -l | grep -v today | xargs -r rm -rf 2>&1; ` +
      `echo "${T.exitTag}:$?"; echo "${T.end}"\r\n` +
      `${T.begin}\r\n${T.exitTag}:0\r\n${T.end}\r\n`;
    const visible2 = filterAgentEchoForDisplay(SID, silent);
    endAgentEchoFilter(SID);
    // 关键断言：补回的 \r\n 让下一条提示符从行首开始，而不是紧跟在旧提示符后面
    assert.equal(visible2, "\r\n");
    const screen = visible1 + visible2 + PROMPT;
    assert.ok(screen.includes(PROMPT + "\r\n" + PROMPT));
    assert.ok(!screen.includes(PROMPT + PROMPT));
  });

  it("窗口关闭后立即恢复原样透传", () => {
    beginAgentEchoFilter(SID, T);
    filterAgentEchoForDisplay(SID, FULL_STREAM);
    endAgentEchoFilter(SID);
    const again = `${T.begin}\r\nx\r\n`;
    assert.equal(filterAgentEchoForDisplay(SID, again), again);
  });

  it("区间结束后，别的哨兵字符串不受影响", () => {
    beginAgentEchoFilter(SID, T);
    assert.equal(filterAgentEchoForDisplay(SID, `${T.begin}\r\nok\r\n`), "\r\nok\r\n");
    const other = "TERMAI_BEGIN_z9y8x7\r\nTERMAI_END_z9y8x7\r\nplain\r\n";
    assert.equal(filterAgentEchoForDisplay(SID, other), other);
    endAgentEchoFilter(SID);
  });

  it("保留原始 \\r\\n，不做换行归一（否则终端光标不换行、排版错乱）", () => {
    beginAgentEchoFilter(SID, T);
    const out = filterAgentEchoForDisplay(SID, `${T.begin}\r\na\r\nb\r\n${T.end}\r\n`);
    assert.equal(out, "\r\na\r\nb\r\n");
    endAgentEchoFilter(SID);
  });

  it("heredoc 临时脚本模式：脚本落盘那一段随回显区间一起剔除", () => {
    beginAgentEchoFilter(SID, T);
    const s =
      `cat > /tmp/x.sh <<'TERMAI_AGENT_EOF'\r\nfoo\r\nTERMAI_AGENT_EOF\r\n` +
      `echo "${T.begin}"\r\n${T.begin}\r\nbar\r\n${T.exitTag}:0\r\n${T.end}\r\n`;
    assert.equal(filterAgentEchoForDisplay(SID, s), "\r\nbar\r\n");
    endAgentEchoFilter(SID);
  });

  it("开启窗口时传入展示命令：直接把命令补在提示符后面，像手动输入一样", () => {
    const cmd = "docker run -d --name grafana grafana/grafana:12.4.0";
    // 提示符在窗口开启前就已经到达并显示
    assert.equal(filterAgentEchoForDisplay(SID, PROMPT), PROMPT);
    beginAgentEchoFilter(SID, T, cmd);
    // 随后是命令回显 + 哨兵 + 真实输出；命令直接补在已有的提示符后面
    assert.equal(
      filterAgentEchoForDisplay(SID, `${ECHO_LINE}\r\n${T.begin}\r\n${REAL}${T.exitTag}:0\r\n${T.end}\r\n`),
      `${cmd}\r\n${REAL}`
    );
    endAgentEchoFilter(SID);
  });

  it("展示命令多行时会被折叠成单行", () => {
    assert.equal(filterAgentEchoForDisplay(SID, PROMPT), PROMPT);
    beginAgentEchoFilter(SID, T, "echo a\necho b\n");
    assert.equal(
      filterAgentEchoForDisplay(SID, `${ECHO_LINE}\r\n${T.begin}\r\n${REAL}${T.exitTag}:0\r\n${T.end}\r\n`),
      "echo a echo b\r\n" + REAL
    );
    endAgentEchoFilter(SID);
  });
});
