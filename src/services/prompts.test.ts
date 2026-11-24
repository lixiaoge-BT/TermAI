import test from "node:test";
import assert from "node:assert/strict";
import { AGENT_SYSTEM_PROMPT, AGENT_MAX_BATCH_COMMANDS } from "./prompts";

/**
 * 这里只锁「会直接导致执行跑偏/白烧轮次」的硬规则。
 * 措辞可以改，判据不能悄悄消失 —— 改坏了没人会发现，只有真机上跑几个小时装不完。
 */
test("Agent 系统提示：批量上限与关键硬规则都在", () => {
  assert.equal(AGENT_MAX_BATCH_COMMANDS, 6, "一轮最多 6 条，改这个数会直接影响步数预算");

  // 装包前先确认「包名 + 来源仓库」：CentOS 7 上 docker-ce 必失败、extras 里的包名是 docker
  assert.match(AGENT_SYSTEM_PROMPT, /list available/, "必须要求先查可用包清单再装");
  assert.match(AGENT_SYSTEM_PROMPT, /来源仓库/, "必须点明同名不同源这个坑");

  // 半成品残留：装了 containerd.io 但没有 docker 时，直接重装主包就可能通
  assert.match(AGENT_SYSTEM_PROMPT, /装了一半|残留/, "必须先查残留再决定是否从头来");

  // 长流程一轮干一段：&& 串起来，逐段退出码
  assert.match(AGENT_SYSTEM_PROMPT, /&&/, "必须引导用 && 串依赖步骤");
  assert.match(AGENT_SYSTEM_PROMPT, /非交互参数/, "必须要求带 -y 等非交互参数");

  // 输出被省略 ≠ 失败，不许因此重跑安装
  assert.match(AGENT_SYSTEM_PROMPT, /不要因为「日志被截断」就重跑安装|不要因为.*截断.*重跑/);
});
