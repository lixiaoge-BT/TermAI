import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  parseAgentReply,
  splitCommandBlock,
  flattenCommand,
  needsScriptFile,
  buildObservation,
  makeSentinelMatcher,
  sanitizeOutput,
  probeTargetOf,
  isNoInfoProbeOutput,
  splitSubCommands,
  digestFailure,
  digestOutput,
  createDupTracker,
  errorShapeOf,
  createFailTreadmill,
  splitCommandParts,
  sanitizeCommandLine,
  shellIncomplete,
  cmdFamily,
  isStateChanging,
  buildExecScript,
  balancedBraces,
  allocateObservationBudget,
  renderSegmentStatus,
  isExecOk,
  extractResult,
  extractFencedCommands,
  shouldAbortWait,
  pickLedgerLines,
  busyMountHint,
  serviceDiagHint,
  OBS_MIN_PER_COMMAND,
  stepBudgetFor,
  isPackageManagerCommand,
  stripInstallNoise,
  detectInteractivePrompt,
} from "./agent";
import { pickUsage } from "./ai";

describe("splitCommandBlock", () => {
  it("去掉注释与空行", () => {
    assert.deepEqual(splitCommandBlock("# 注释\nls -la\n\n  "), ["ls -la"]);
  });

  it("容忍模型自作主张加的序号/列表符号", () => {
    assert.deepEqual(splitCommandBlock("1) df -h\n2. free -m\n- uptime"), [
      "df -h",
      "free -m",
      "uptime",
    ]);
  });

  it("多行循环保成一整条命令（旧实现按行拆 → 半截 for 卡死终端）", () => {
    const block = ["for dir in */; do", '  [ "$dir" = "today/" ] || rm -rf "$dir"', "done"].join(
      "\n"
    );
    assert.deepEqual(splitCommandBlock(block), [block]);
  });

  it("多行 if / 管道续行同样保成一整条", () => {
    const ifBlock = ["if [ -d today ]; then", "  echo yes", "else", "  echo no", "fi"].join("\n");
    assert.deepEqual(splitCommandBlock(ifBlock), [ifBlock]);
    const pipeBlock = ["cat /etc/os-release |", "  head -5"].join("\n");
    assert.deepEqual(splitCommandBlock(pipeBlock), [pipeBlock]);
  });

  it("循环前后的普通命令仍各自成条", () => {
    const block = ["ls -la", "for d in x; do", "  echo $d", "done"].join("\n");
    const out = splitCommandBlock(block);
    assert.equal(out.length, 2);
    assert.equal(out[0], "ls -la");
    // 续行保留原始缩进（heredoc 正文的缩进/前缀是内容的一部分）
    assert.equal(out[1], ["for d in x; do", "  echo $d", "done"].join("\n"));
  });

  it("多条只读探测不会被误并成一条", () => {
    assert.deepEqual(splitCommandBlock("df -h\nfree -m\nuptime"), ["df -h", "free -m", "uptime"]);
  });
});

describe("shellIncomplete（结构残缺识别）", () => {
  it("完整结构判定为完整", () => {
    assert.equal(shellIncomplete("for d in */; do rm -rf \"$d\"; done"), false);
    assert.equal(shellIncomplete("if [ -d x ]; then echo y; fi"), false);
    assert.equal(shellIncomplete("echo done"), false);
    assert.equal(shellIncomplete("ls -la"), false);
  });

  it("半截结构判定为残缺（下发会让 shell 停在续行提示符）", () => {
    assert.equal(shellIncomplete("for dir in */; do"), true);
    assert.equal(shellIncomplete("while read l; do"), true);
    assert.equal(shellIncomplete("if [ -d x ]; then"), true);
    assert.equal(shellIncomplete(["for d in x; do", "echo $d"].join("\n")), true);
  });

  it("引号不闭合 / 括号不闭合 / heredoc 未收尾都算残缺", () => {
    assert.equal(shellIncomplete(`grep "abc f.txt`), true);
    assert.equal(shellIncomplete("echo $(date"), true);
    assert.equal(shellIncomplete("cat <<EOF\nhi"), true);
    assert.equal(shellIncomplete("cat <<EOF\nhi\nEOF"), false);
  });
});

describe("parseAgentReply", () => {
  it("解析 <<<RUN>>> 块为命令列表", () => {
    const r = parseAgentReply("<<<RUN>>>\nls -la\n<<<END>>>");
    assert.equal(r.done, false);
    assert.deepEqual(r.commands, ["ls -la"]);
  });

  it("批量 RUN：多行命令拆成多条", () => {
    const r = parseAgentReply("<<<RUN>>>\n1. df -h\n2. free -h\n<<<END>>>");
    assert.deepEqual(r.commands, ["df -h", "free -h"]);
  });

  it("<<<DONE>>> 视为结束并提取结论", () => {
    const r = parseAgentReply("<<<DONE>>>\n系统健康");
    assert.equal(r.done, true);
    assert.deepEqual(r.commands, []);
    assert.equal(r.finalAnswer, "系统健康");
    // 真·结束不带兜底标记，run() 会据此立即收尾而非要求继续
    assert.equal(r.noMarkerFallback, undefined);
  });

  it("未遵循协议时退化为最终结论（标记 noMarkerFallback）", () => {
    const r = parseAgentReply("这里没有协议标记，当作总结");
    assert.equal(r.done, true);
    assert.ok(r.finalAnswer?.includes("总结"));
    // 无标记兜底：run() 应区分「过渡/解释」与「真完成」，避免没做完就停
    assert.equal(r.noMarkerFallback, true);
  });

  it("无协议标记但给了 ```bash 围栏 → 兜底执行命令（固定 IP 任务的真实死因）", () => {
    // 用户实测：Agent 只在围栏里给了改 IP 的命令，引擎当成结论，一条都没下发。
    const r = parseAgentReply(
      "这是修改固定 IP 的命令：\n```bash\nnmcli con mod eth0 ipv4.addresses 192.168.1.9/24\n```"
    );
    assert.equal(r.done, false);
    assert.equal(r.commands.length, 1);
    assert.ok(r.commands[0].includes("nmcli con mod"));
    assert.equal(r.normalizedFrom, "fence");
    // 归一化后仍不是「已完成」，不能顺手把原文当结论
    assert.equal(r.finalAnswer, null);
  });

  it("```bash:risk=low 这种带风险标注的围栏同样识别", () => {
    const r = parseAgentReply("```bash:risk=medium\necho hi\n```");
    assert.equal(r.commands.length, 1);
    assert.equal(r.normalizedFrom, "fence");
  });

  it("`RUN:` 单行前缀也兜底执行", () => {
    const r = parseAgentReply("RUN: systemctl restart network\n");
    assert.equal(r.commands.length, 1);
    assert.ok(r.commands[0].includes("systemctl restart network"));
    assert.equal(r.normalizedFrom, "prefix");
  });

  it("已经用了 <<<DONE>>> 时的围栏**绝不**自动执行（那是「需手动执行的操作」）", () => {
    // 安全边界：结论里贴命令给人看是合法用法，自动跑就等于越权。
    const r = parseAgentReply(
      "<<<DONE>>>\n## 需要手动执行的操作\n```bash\nrm -rf /var/lib/old\n```\n"
    );
    assert.equal(r.done, true);
    assert.deepEqual(r.commands, []);
    assert.equal(r.normalizedFrom, undefined);
  });

  it("非 shell 围栏 / 混中文的无标注围栏不当命令执行", () => {
    assert.deepEqual(parseAgentReply("```yaml\nip: 192.168.1.9\n```").commands, []);
    // 无语言标注且含中文说明 → 是给人看的示例，不是命令
    const chinese = parseAgentReply("```\n下面是配置示例，请按需修改\nIPADDR=1.2.3.4\n```");
    assert.deepEqual(chinese.commands, []);
    assert.equal(chinese.noMarkerFallback, true);
  });

  it("extractFencedCommands 剥掉终端提示符前缀", () => {
    const cmds = extractFencedCommands("```shell\n$ ip -4 addr show\n# systemctl restart network\n```");
    assert.deepEqual(cmds, ["ip -4 addr show", "systemctl restart network"]);
  });

  it("<<<PLAN>>> 计划声明：剥掉尾部重复的闭合标记", () => {
    const r = parseAgentReply("先出计划\n<<<PLAN>>>\n1. 探测环境\n2. 安装 nginx\n<<<PLAN>>>");
    assert.equal(r.done, false);
    assert.equal(r.commands.length, 0);
    assert.ok(r.plan);
    // 蓝图文本不应混入协议串（会进 UI 计划卡片与 pinned 注入消息）
    assert.ok(!r.plan!.includes("<<<PLAN>>>"));
    assert.ok(r.plan!.includes("安装 nginx"));
  });

  it("计划与首条命令写在同一回复：命令不能丢", () => {
    // 实测形态（小模型的常见输出）：先给 PLAN，紧接着同一回复里给 RUN。
    // 旧实现 PLAN 分支直接 returns commands: []，整轮白跑（探针复现过）。
    const r = parseAgentReply(
      "<<<PLAN>>>\n1. 看环境\n2. 装 nginx\n<<<PLAN>>>\n<<<RUN>>>\ncat /etc/os-release\nuname -m\n<<<END>>>"
    );
    assert.equal(r.done, false);
    assert.ok(r.plan?.includes("装 nginx"));
    assert.deepEqual(r.commands, ["cat /etc/os-release", "uname -m"]);
    // 同时断言宽松判据：纯 PLAN（无 RUN）仍然不产生命令，避免「一律放行」式的假修复
    const planOnly = parseAgentReply("<<<PLAN>>>\n1. a\n2. b\n<<<PLAN>>>");
    assert.equal(planOnly.commands.length, 0);
    assert.ok(planOnly.plan);
  });

  it("只有 <<<DONE>>> 而无正文：finalAnswer 为空，不能把协议串当总结", () => {
    // 实测故障：界面上「任务总结」里只剩一行 `<<<DONE>>>`。
    // 旧实现 finalAnswer: after || before || raw 会把标记本身兜底成结论。
    const r = parseAgentReply("<<<DONE>>>");
    assert.equal(r.done, true);
    assert.equal(r.finalAnswer, "");
    // 同时断言宽松判据：真有正文时必须原样提取，不能被这条守卫误伤
    const withBody = parseAgentReply("<<<DONE>>>\n## 结论摘要\n本机 IP 是 10.0.0.5。");
    assert.equal(withBody.finalAnswer, "## 结论摘要\n本机 IP 是 10.0.0.5。");
  });

  it("孤立的 <<<PLAN>>> 空块：既不是命令也不是结束，不能被当成结论", () => {
    // 实测故障：模型只吐一个 `<<<PLAN>>>`（计划块为空）时，旧实现让 run() 走到
    // 「commands 为空就直接收尾、summary 取 replyText」的分支，
    // 于是「任务总结」里只剩协议串。这里锁定解析结果：done=false 且 finalAnswer 为空，
    // run() 才会走「畸形回复打回重写」而不是拿它当结论。
    const r = parseAgentReply("<<<PLAN>>>");
    assert.equal(r.done, false);
    assert.equal(r.commands.length, 0);
    assert.equal(r.finalAnswer, null);
    assert.equal(r.plan, "");
    // 同时断言宽松判据：有计划正文时必须仍被识别为计划，不能被这条守卫误伤
    const real = parseAgentReply("<<<PLAN>>>\n1. 探测\n<<<PLAN>>>");
    assert.equal(real.plan, "1. 探测");
  });

  it("RUN 与 DONE 写在同一轮：命令优先执行，结论降级为草稿", () => {
    // 实测故障：模型一边发最后一条命令、一边把结论写好了。旧实现整段丢弃命令、
    // 照收结论 → 模型说「已清理完成」而实际一条没跑，用户拿到的结论是编的。
    const r = parseAgentReply(
      "<<<RUN>>>\nrm -rf /tmp/termai_old\n<<<END>>>\n<<<DONE>>>\n## 结论摘要\n已清理完成。"
    );
    assert.equal(r.done, false, "有命令时必须先执行，不能直接结束");
    assert.deepEqual(r.commands, ["rm -rf /tmp/termai_old"]);
    assert.equal(r.finalAnswer, null);
    assert.ok(r.deferredAnswer?.includes("已清理完成"), "结论正文要留下，用于核对提示");

    // 同时断言宽松判据：没有命令的 DONE 必须还是正常收尾，不能被这条改动拖慢一轮
    const pure = parseAgentReply("<<<DONE>>>\n## 结论摘要\n已清理完成。");
    assert.equal(pure.done, true);
    assert.equal(pure.commands.length, 0);
    assert.equal(pure.deferredAnswer, undefined);
  });
});

describe("flattenCommand", () => {
  it("单行原样返回", () => {
    assert.equal(flattenCommand("ls -la"), "ls -la");
  });

  it("多行用分号连接", () => {
    assert.equal(flattenCommand("ls\ncd /tmp"), "ls ; cd /tmp");
  });

  it("上一行以连接符结尾时直接拼接", () => {
    assert.equal(flattenCommand("echo a &&\\\n  echo b"), "echo a && echo b");
  });

  it("do / then 之后只空格拼接 —— 不能插分号（`do ;` 是非法 bash）", () => {
    const out = flattenCommand(`for d in */; do
  rm -rf "$d"
done`);
    assert.ok(!/;\s*do\s*;/.test(out), `不该出现 do ; ：${out}`);
    assert.ok(/do rm -rf/.test(out), `do 后应直接跟命令：${out}`);
  });

  it("注释行被丢弃，不能吞掉后面的命令（旧实现在此挂死在续行提示符）", () => {
    const out = flattenCommand(`for d in */; do
  # 跳过 today
  [ "$d" = "today/" ] || rm -rf "$d"
done`);
    assert.ok(!out.includes("#"), `压平结果不该含注释符：${out}`);
    assert.ok(out.includes("rm -rf"), "注释后面的真实命令必须保留");
    assert.ok(out.trimEnd().endsWith("done"), `必须以 done 收尾：${out}`);
  });

  it("压平产物必须是合法 bash（交给 bash -n 校验，含注释/循环/if-else）", () => {
    if (spawnSync("bash", ["-c", "true"]).status !== 0) return; // 环境无 bash 时跳过
    const samples = [
      `for d in */; do
  # 跳过 today
  [ "$d" = "today/" ] || rm -rf "$d"
done`,
      `ls -d */ | while read dir; do
  if [ "$dir" != "today/" ]; then
    rm -rf "$dir"
  fi
done`,
      `if [ -d today ]; then
  echo yes
else
  echo no
fi`,
    ];
    for (const src of samples) {
      const flat = flattenCommand(src);
      const r = spawnSync("bash", ["-n", "-c", flat]);
      assert.equal(
        r.status,
        0,
        `压平后不是合法 bash（stderr=${r.stderr}）：${flat}`
      );
    }
  });
});

describe("needsScriptFile（多行脚本落盘判定）", () => {
  it("单行命令不落盘", () => {
    assert.equal(needsScriptFile("ls -la"), false);
    assert.equal(needsScriptFile(`ls -l | grep -v today | xargs -r rm -rf`), false);
  });

  it("简单多行命令序列仍走压平", () => {
    assert.equal(needsScriptFile("ls\ncd /tmp"), false);
  });

  it("含循环 / 条件 / 注释 / heredoc 的多行脚本一律落盘", () => {
    assert.equal(needsScriptFile("for d in */; do\n  echo $d\ndone"), true);
    assert.equal(needsScriptFile("while read l; do\n  echo $l\ndone"), true);
    assert.equal(needsScriptFile("if [ -d x ]; then\n  echo y\nfi"), true);
    assert.equal(needsScriptFile("ls\n# 注释\ncd /tmp"), true);
    assert.equal(needsScriptFile("cat <<EOF\nhi\nEOF"), true);
  });
});

describe("sanitizeOutput", () => {
  it("剥离 ANSI 控制符与 \\r，压缩连续空行", () => {
    const raw = "line1\r\n\x1B[31mRED\x1B[0m\n\n\n\nline2";
    const out = sanitizeOutput(raw);
    assert.ok(!out.includes("\x1B"), "不该残留 ANSI 序列");
    assert.ok(!out.includes("\r"));
    assert.ok(out.includes("RED"), "行内真实内容必须保留");
    assert.ok(!/\n\n\n/.test(out), "连续空行应被压缩");
  });

  it("超长输出保留头尾并标注省略行数", () => {
    const lines = Array.from({ length: 300 }, (_, i) => `L${i}`);
    const out = sanitizeOutput(lines.join("\n"), 20);
    assert.ok(out.includes("已省略"), "应标注省略");
    assert.ok(out.includes("L0"), "应保留头部");
    assert.ok(out.includes("L299"), "应保留尾部");
    assert.ok(out.length < lines.join("\n").length);
  });

  it("短输出原样保留", () => {
    const raw = "a\nb\nc";
    assert.equal(sanitizeOutput(raw), raw);
  });

  it("ESC(B 整段剥除 —— 否则 yum 高亮的包名会被污染成 docker-ce(B", () => {
    // 真机原始字节（CentOS 7）：yum 用 ESC(B 包住包名，ESC[m 收尾
    const ESC = String.fromCharCode(27);
    const raw = `No package docker-ce${ESC}(B${ESC}[m available.`;
    const out = sanitizeOutput(raw);
    assert.equal(out, "No package docker-ce available.");
    assert.ok(!out.includes("(B"), "字符集切换的残片不能留在观察里");
  });

  it("OSC / DCS 也整段剥除，不留 ]0; 这类残渣", () => {
    const ESC = String.fromCharCode(27);
    const raw = `${ESC}]0;root@host: ~${String.fromCharCode(7)}ok\n${ESC}P1$r${ESC}\\tail`;
    const out = sanitizeOutput(raw);
    assert.ok(out.includes("ok"));
    assert.ok(out.includes("tail"));
    assert.ok(!out.includes("]0;"), "OSC 标题残渣必须清掉");
    assert.ok(!out.includes("1$r"), "DCS 残渣必须清掉");
  });
});

describe("buildObservation", () => {
  it("超长输出按预算截断", () => {
    const longOut = "A".repeat(7000);
    const obs = buildObservation([
      { command: "cat big", result: { output: longOut, exitCode: 0, timedOut: false, script: "" } },
    ]);
    assert.ok(obs.includes("输出过长已截断"));
    // 原始 7000 字符不应完整保留（单条预算 6000）
    assert.ok(!obs.includes(longOut));
    // 但前 6000 个字符应当出现
    assert.ok(obs.includes("A".repeat(6000)));
  });

  it("正常输出完整保留", () => {
    const obs = buildObservation([
      { command: "ls", result: { output: "a\nb", exitCode: 0, timedOut: false, script: "" } },
    ]);
    assert.ok(obs.includes("a\nb"));
    assert.ok(obs.includes("退出码：0"));
  });
});

describe("probeTargetOf（同源探测识别）", () => {
  it("取出 host:port 并小写化", () => {
    assert.equal(probeTargetOf("curl -s http://LOCALHOST:9090/-/health | head -50"), "localhost:9090");
    assert.equal(probeTargetOf("curl -sS https://example.com/api/v1/status"), "example.com");
  });

  it("带额外参数/引号的写法也能提取", () => {
    assert.equal(
      probeTargetOf("curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/x"),
      "127.0.0.1:8080"
    );
    assert.equal(probeTargetOf("wget -q -O - http://a.b:80/"), "a.b:80");
  });

  it("非 HTTP 探测或解析不出时返回 null（不做猜测）", () => {
    assert.equal(probeTargetOf("ls -la /etc"), null);
    assert.equal(probeTargetOf("systemctl status nginx --no-pager"), null);
    assert.equal(probeTargetOf("curl -s localhost:9090/metrics"), null);
  });
});

describe("isNoInfoProbeOutput（探测是否拿到有效信息）", () => {
  it("空输出 / 404 / 连接失败都算「没有有效信息」", () => {
    assert.equal(isNoInfoProbeOutput(""), true);
    assert.equal(isNoInfoProbeOutput("   \n  "), true);
    assert.equal(isNoInfoProbeOutput("404 page not found"), true);
    assert.equal(
      isNoInfoProbeOutput("curl: (7) Failed to connect to localhost port 9090: Connection refused"),
      true
    );
  });

  it("拿到真实内容就不算 —— 绝不能把正常 200 响应误判成空转", () => {
    assert.equal(isNoInfoProbeOutput("Prometheus Server is Healthy."), false);
    assert.equal(isNoInfoProbeOutput("HTTP/1.1 200 OK\nsome metrics payload"), false);
  });
});

describe("buildObservation 超长输出的聚焦", () => {
  it("带错误关键词时头部正常信息同样保留，而不是只留错误行", () => {
    // 60 行、行很长：行数不超过 sanitizeOutput 的 80 行上限，
    // 保证中间那行错误能活到聚焦阶段（否则会先被 sanitizeOutput 的行数收敛去掉）。
    const line = (s: string) => `${s} ${"x".repeat(180)}`;
    const lines = Array.from({ length: 60 }, (_, i) => line(`L${i}`));
    lines[0] = line("HEADMARK-version-1.2.3");
    lines[30] = line("ERROR: upstream connect failed");
    const obs = buildObservation(
      [
        {
          command: "app --check",
          result: { output: lines.join("\n"), exitCode: 1, timedOut: false, script: "" },
        },
      ],
      2000
    );
    assert.ok(obs.includes("HEADMARK-version-1.2.3"), "头部正常信息必须保留（模型据它判断下一步策略）");
    assert.ok(obs.includes("ERROR: upstream connect failed"), "错误行必须保留");
    assert.ok(obs.includes("已聚焦错误/异常行"));
  });
});

describe("长输出阅读：头 / 错误行 / 尾都必须读到", () => {
  const run = (output: string, exitCode = 0, budget = 2000) =>
    buildObservation(
      [{ command: "some --cmd", result: { output, exitCode, timedOut: false, script: "" } }],
      budget
    );

  it("没有错误关键词时也保留尾部（旧实现直接丢尾，模型看不到最终状态）", () => {
    const lines = Array.from({ length: 400 }, (_, i) => `normal line payload ${i}`);
    lines[399] = "TAILMARK-final-status-ok";
    const obs = run(lines.join("\n"));
    assert.ok(obs.includes("normal line payload 0"), "首行必须保留（版本/路径/表头）");
    assert.ok(obs.includes("TAILMARK-final-status-ok"), "尾部最终状态必须保留");
    assert.ok(obs.includes("已聚焦头部与结尾"));
  });

  it("中段错误行不被省略区吞掉，并给出错误行号", () => {
    const lines = Array.from({ length: 600 }, (_, i) => `${i} ${"x".repeat(120)}`);
    lines[300] = "ERROR: disk quota exceeded";
    const obs = run(lines.join("\n"), 1);
    assert.ok(obs.includes("ERROR: disk quota exceeded"), "错误行必须出现在观察里");
    assert.ok(/错误\/异常行在第 \d+/.test(obs), "必须告诉模型错误在第几行");
  });

  it("省略标注带行号区间，并提示用 sed 精确取回而不是重跑整条命令", () => {
    const lines = Array.from({ length: 600 }, (_, i) => `${i} ${"y".repeat(120)}`);
    const obs = run(lines.join("\n"));
    assert.ok(/（省略第 \d+~\d+ 行，共 \d+ 行）/.test(obs), "省略区间必须可定位");
    assert.ok(obs.includes("sed -n"), "必须给出精确取回被省略行的方法");
    assert.ok(obs.includes("不要原样重跑整条命令"));
  });

  it("单行超长（无行结构）仍按字符截断，不凭空造省略标注", () => {
    const obs = run("A".repeat(7000), 0, 6000);
    assert.ok(!obs.includes("（省略第"));
  });

  it("只去掉了颜色码/空行时不得标记「已截断」——否则模型以为自己缺信息", () => {
    const colored = `\x1b[32m绿色正常输出\x1b[0m\n\n\n\n第二段内容\n\n`;
    const obs = run(colored);
    assert.ok(obs.includes("绿色正常输出"));
    assert.ok(obs.includes("第二段内容"));
    assert.ok(
      !obs.includes("输出过长已截断"),
      "ANSI/空行不是信息，去掉它们不等于截断"
    );
  });

  it("同类错误刷屏时说明「重复了多少行」，别让模型读成「只错了一次」", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    for (let i = 100; i < 140; i++) lines[i] = "ERROR: same failure";
    const obs = run(lines.join("\n"), 1);
    assert.ok(
      /另有 39 行同类错误内容重复/.test(obs),
      `去重必须说明重复数量，实际：${obs.slice(-260)}`
    );
  });
});

describe("createDupTracker：lastFull 回填", () => {
  it("保存较完整的聚焦输出，供模型「再看一眼」时回填", () => {
    const t = createDupTracker();
    const lines = Array.from({ length: 300 }, (_, i) => `row-${i} ${"y".repeat(80)}`);
    const out = lines.join("\n");
    t.record("ps aux", true, out);
    t.record("ps aux", true, out);
    const full = t.lastFull("ps aux");
    assert.ok(full.includes("row-0"), "头部必须保留");
    assert.ok(full.includes("row-299"), "尾部必须保留");
    assert.ok(
      full.length > t.lastDigest("ps aux").length * 5,
      "回填内容必须明显比 240 字符摘要更完整"
    );
  });

  it("失败那次的输出不覆盖此前成功的完整输出", () => {
    const t = createDupTracker();
    t.record("df -h", true, "Filesystem Size Used Avail\n/dev/sda1 40G 30G 10G");
    const okFull = t.lastFull("df -h");
    t.record("df -h", false, "df: no such file or directory");
    assert.equal(t.lastFull("df -h"), okFull);
  });
});

describe("pickUsage", () => {
  it("解析 OpenAI 风格的 usage", () => {
    assert.deepEqual(pickUsage({ prompt_tokens: 1200, completion_tokens: 34 }), {
      promptTokens: 1200,
      completionTokens: 34,
    });
  });

  it("缺失或非法时返回 undefined / 归零，不抛异常", () => {
    assert.equal(pickUsage(undefined), undefined);
    assert.equal(pickUsage(null), undefined);
    assert.equal(pickUsage({}), undefined);
    assert.deepEqual(pickUsage({ prompt_tokens: "abc", completion_tokens: -5 }), {
      promptTokens: 0,
      completionTokens: 0,
    });
  });
});

describe("makeSentinelMatcher（结束哨兵判定）", () => {
  const token = "a1b2c3";
  const begin = `TERMAI_BEGIN_${token}`;
  const end = `TERMAI_END_${token}`;
  const exitTag = `TERMAI_EXIT_${token}`;

  // execCommand 下发的脚本（换行在发送时统一转成 \r），PTY 会把它整段回显回来
  const script = `echo "${begin}"; uptime 2>&1; echo "${exitTag}:$?"; echo "${end}"`;
  const echoBack = (script.replace(/\r?\n/g, "\r") + "\r").replace(/\r/g, "\r\n");

  it("回显里的哨兵不算数（否则命令还没跑就被判为已结束）", () => {
    const matchEnd = makeSentinelMatcher(end);
    // 回显确实含有哨兵子串，说明这条用例真的覆盖到了 PTY 回显场景
    assert.ok(echoBack.includes(end), "前置条件：回显应包含哨兵子串");
    assert.equal(matchEnd(echoBack), false);
  });

  it("命令真正跑完、哨兵独占一行时才算出现", () => {
    const matchEnd = makeSentinelMatcher(end);
    const realOut = echoBack + `${begin}\r\n 09:00:01 up 3 days\r\n${exitTag}:0\r\n${end}\r\n`;
    assert.equal(matchEnd(realOut), true);
  });

  it("哨兵出现在行尾（后面还有提示符）也算出现", () => {
    const matchEnd = makeSentinelMatcher(end);
    assert.equal(matchEnd(`output\r\n${end}$ `), true);
  });
});

describe("splitSubCommands（复合命令拆分，去重台账用）", () => {
  it("按 && 拆分", () => {
    assert.deepEqual(splitSubCommands("systemctl restart nfs && systemctl status nfs"), [
      "systemctl restart nfs",
      "systemctl status nfs",
    ]);
  });

  it("按 ; 拆分", () => {
    assert.deepEqual(splitSubCommands("sleep 5; tail -n 50 /tmp/x.log"), [
      "sleep 5",
      "tail -n 50 /tmp/x.log",
    ]);
  });

  it("引号内的分隔符不拆（引号内分号不是命令分隔符）", () => {
    assert.deepEqual(splitSubCommands('grep "a;b" /etc/fstab'), ['grep "a;b" /etc/fstab']);
    assert.deepEqual(splitSubCommands(`awk '{print $1 && $2}' f`), [`awk '{print $1 && $2}' f`]);
  });

  it("转义的分号不拆", () => {
    assert.deepEqual(splitSubCommands("echo a\\;b"), ["echo a\\;b"]);
  });

  it("不拆管道（grep 单独拿出来不是一条命令）", () => {
    assert.deepEqual(splitSubCommands("ps aux | grep nginx | head -5"), [
      "ps aux | grep nginx | head -5",
    ]);
  });

  it("不拆单个 &（2>&1 里含 &，拆了会把重定向拆散）", () => {
    assert.deepEqual(splitSubCommands("nohup app > /tmp/a.log 2>&1 &"), [
      "nohup app > /tmp/a.log 2>&1 &",
    ]);
  });

  it("单条命令返回自身（调用方据此避免重复计数）", () => {
    assert.deepEqual(splitSubCommands("  df -h  "), ["df -h"]);
  });

  it("三段链与空段都被处理", () => {
    assert.deepEqual(splitSubCommands("a && b; c"), ["a", "b", "c"]);
    assert.deepEqual(splitSubCommands("a && && b"), ["a", "b"]);
  });
});

describe("digestOutput（台账输出片段）", () => {
  it("跳过 ls 的 total 表头，取真正的内容行（前 3 条内全部给出）", () => {
    const out = "total 12\ndrwxr-xr-x 2 root root 4096 prometheus\ndrwx------ 2 root root 16384 lost+found";
    assert.equal(
      digestOutput(out),
      "drwxr-xr-x 2 root root 4096 prometheus | drwx------ 2 root root 16384 lost+found"
    );
  });

  it("跳过 df -h 的表头，取第一条数据行", () => {
    const out = "Filesystem      Size  Used Avail Use% Mounted on\n/dev/vda1        40G   30G  8.0G  79% /";
    assert.equal(digestOutput(out), "/dev/vda1        40G   30G  8.0G  79% /".slice(0, 60));
  });

  it("systemctl status 跳过 ● / Loaded:，取 Active: 行", () => {
    const out = [
      "● nfs-server.service - NFS server and services",
      "     Loaded: loaded (/usr/lib/systemd/system/nfs-server.service; enabled)",
      "     Active: active (running) since Thu 2026-09-10 14:00:00 CST",
      "   Main PID: 1234 (rpc.nfsd)",
    ].join("\n");
    assert.equal(digestOutput(out), "Active: active (running) since Thu 2026-09-10 14:00:00 CST");
  });

  it("全是结构性行时回退首行，绝不返回空", () => {
    assert.equal(digestOutput("total 0\nFilesystem  Size"), "total 0");
  });

  it("空输出给出明确占位", () => {
    assert.equal(digestOutput(""), "（无输出）");
    assert.equal(digestOutput("   \n  \n"), "（无输出）");
  });

  it("超长内容按预算截断并加省略号（默认预算 240）", () => {
    const long = "x".repeat(500);
    const got = digestOutput(long);
    assert.equal(got.length, 241);
    assert.ok(got.endsWith("…"));
  });

  it("输出行数多于展示行数时标注总行数（模型据此判断够不够用）", () => {
    const out = Array.from({ length: 10 }, (_, i) => `line-${i}`).join("\n");
    const got = digestOutput(out);
    assert.ok(got.startsWith("line-0 | line-1 | line-2"), "按原顺序取前 3 条");
    assert.ok(got.endsWith("（共 10 行）"), "必须告诉模型片段之外还有多少行");
  });

  it("条数不超上限时不加总行数后缀（避免噪音）", () => {
    assert.equal(digestOutput("a\nb"), "a | b");
  });

  it("显式传小预算时仍按老行为截断（参数未被写死）", () => {
    const got = digestOutput("x".repeat(200), 60, 1);
    assert.equal(got.length, 61);
    assert.ok(got.endsWith("…"));
  });

  it("首行本身有信息量时不被跳过（普通命令保持原行为）", () => {
    assert.equal(digestOutput("nginx version: nginx/1.24.0"), "nginx version: nginx/1.24.0");
  });
});

describe("allocateObservationBudget（观察预算按需分配）", () => {
  it("总预算够时每条拿到全额，短输出不会白占预算", () => {
    // 长度 [100, 9000, 200]，总预算 12000：都够，直接按长度给满
    assert.deepEqual(allocateObservationBudget([100, 9000, 200], 12000, 800), [100, 9000, 200]);
  });

  it("预算不足时每条先拿保底，剩余全部补给缺口最大的那条", () => {
    // 保底 800×3 = 2400，剩余 600 全给缺口最大的 idx1（9000-800=8200）
    assert.deepEqual(allocateObservationBudget([5000, 9000, 5000], 3000, 800), [800, 1400, 800]);
  });

  it("预算连保底都不够时仍给满保底（保底优先于总额，短输出按自身长度）", () => {
    assert.deepEqual(allocateObservationBudget([5000, 5000, 5000], 1000, 800), [800, 800, 800]);
    assert.deepEqual(allocateObservationBudget([100, 5000, 200], 1000, 800), [100, 800, 200]);
  });

  it("批量均摊的旧问题：4 条大输出不会再被压成 750 字符", () => {
    const lengths = [5000, 5000, 5000, 5000];
    const budgets = allocateObservationBudget(lengths, 8000, OBS_MIN_PER_COMMAND);
    // 旧实现 max(800, 8000/4) = 2000（其实是 2000，不是 750）；关键是新实现
    // 保证「每条先 800，剩余 4800 按需补给单条」→ 至少有一条显著变大
    assert.ok(budgets.every((b) => b >= 800), "每条都不低于保底");
    assert.ok(Math.max(...budgets) > 2000, "按需分配必须让某些条目拿到比均摊更多的预算");
  });
});

describe("renderSegmentStatus（分段退出码渲染）", () => {
  it("只有一条或没有分段时不出声（向后兼容）", () => {
    assert.equal(renderSegmentStatus(undefined), "");
    assert.equal(renderSegmentStatus([]), "");
    assert.equal(renderSegmentStatus([{ index: 1, code: 0 }]), "");
  });

  it("全部成功时只报数值，不制造警告", () => {
    const s = renderSegmentStatus([
      { index: 1, code: 0 },
      { index: 2, code: 0 },
    ]);
    assert.equal(s, "分段退出码：第 1 段 → 0，第 2 段 → 0");
  });

  it("中间段失败必须显式警告 —— 整体退出码只反映最后一段", () => {
    const s = renderSegmentStatus([
      { index: 1, code: 1 },
      { index: 2, code: 0 },
    ]);
    assert.ok(s.includes("第 1 段 → 1"));
    assert.ok(s.includes("第 2 段 → 0"));
    assert.ok(s.includes("1 段执行失败"));
    assert.ok(s.includes("只反映最后一段"), "必须点明整体退出码不可作为成功依据");
  });
});

describe("isExecOk（任一分段失败即整体失败）", () => {
  it("末条成功但中间段失败 → 不算成功（终结假成功反馈）", () => {
    assert.equal(
      isExecOk({
        output: "",
        exitCode: 0,
        timedOut: false,
        script: "",
        segmentStatus: [
          { index: 1, code: 1 },
          { index: 2, code: 0 },
        ],
      }),
      false
    );
  });

  it("全部分段成功才算成功", () => {
    assert.equal(
      isExecOk({
        output: "",
        exitCode: 0,
        timedOut: false,
        script: "",
        segmentStatus: [
          { index: 1, code: 0 },
          { index: 2, code: 0 },
        ],
      }),
      true
    );
  });

  it("没有分段信息时退回原判据（exitCode 0 / null 都算成功）", () => {
    assert.equal(isExecOk({ output: "", exitCode: 0, timedOut: false, script: "" }), true);
    assert.equal(isExecOk({ output: "", exitCode: null, timedOut: false, script: "" }), true);
    assert.equal(isExecOk({ output: "", exitCode: 2, timedOut: false, script: "" }), false);
    assert.equal(
      isExecOk({ output: "", exitCode: 0, timedOut: false, script: "", error: "下发失败" }),
      false
    );
  });
});

describe("buildExecScript（下发给 shell 的包装脚本）", () => {
  const tags = {
    begin: "TERMAI_BEGIN_t1",
    exitTag: "TERMAI_EXIT_t1",
    end: "TERMAI_END_t1",
  };

  it("单条命令：不加分段打点，且不外包 2>&1（否则会抵消命令自己的重定向）", () => {
    const s = buildExecScript("ls -la /etc", tags, "/tmp/x.sh");
    assert.equal(s, 'echo "TERMAI_BEGIN_t1"; ls -la /etc; echo "TERMAI_EXIT_t1:$?"; echo "TERMAI_END_t1"');
    assert.ok(!s.includes("2>&1"), "外包 2>&1 会把末条自己的 2>/dev/null 抵消掉");
    assert.ok(!s.includes(":seg:"), "单条命令没有分段");
  });

  it("顶层 `;` 串联：逐段打点，每段后紧跟分段退出码", () => {
    const s = buildExecScript("rm -f /nope; du -sh /tmp", tags, "/tmp/x.sh");
    assert.ok(s.includes('{ rm -f /nope; echo "TERMAI_EXIT_t1:seg:1:$?"; }'));
    assert.ok(s.includes('{ du -sh /tmp; echo "TERMAI_EXIT_t1:seg:2:$?"; }'));
    assert.ok(s.endsWith('echo "TERMAI_EXIT_t1:$?"; echo "TERMAI_END_t1"'), "整体退出码仍要保留");
  });

  it("分段打点仍能被压平成合法 bash（spawnSync bash -n 校验）", () => {
    const written: string[] = [];
    for (const cmd of [
      "rm -f /nope; du -sh /tmp",
      "a=1; echo $a; ls | head -1",
      'echo "a;b"; ls',
    ]) {
      const s = buildExecScript(cmd, tags, "/tmp/x.sh");
      const r = spawnSync("bash", ["-n", "-c", s], { encoding: "utf8" });
      assert.equal(r.status, 0, `压平产物必须是合法 bash：${cmd}\n${r.stderr}`);
      written.push(s);
    }
    assert.ok(written.length === 3, "前置条件：三条都真的被校验过");
  });

  it("`&&` / `||` 串联逐段打点，且不破坏短路语义", () => {
    const s = buildExecScript("cd /tmp && rm -f a", tags, "/tmp/x.sh");
    assert.ok(s.includes(":seg:1:") && s.includes(":seg:2:"), "两段都要打点");
    assert.ok(s.includes(":seg:2:skip"), "短路跳过必须可识别（不能当成成功）");
    // 不能写成 `{ cmd; echo $?; } && next`：花括号组的退出码是组内最后一条（echo）的，
    // 恒为 0 —— 那样插打点等于把短路改成了「永远继续」。必须先把状态存进变量。
    assert.ok(s.includes("__termai_rc=$?"), "逐段状态必须显式保存");
    assert.ok(!/}\s*&&/.test(s), "不能把花括号组直接接 &&");
    const chk = spawnSync("bash", ["-n", "-c", s], { encoding: "utf8" });
    assert.equal(chk.status, 0, `生成的脚本必须是合法 bash：${chk.stderr}`);
  });

  it("`&&` 链的短路跳过可被解析成 skipped，且不会被算成失败", () => {
    const buf = [
      "TERMAI_BEGIN_t1",
      "TERMAI_EXIT_t1:seg:1:1",
      "TERMAI_EXIT_t1:seg:2:skip",
      "TERMAI_EXIT_t1:1",
      "TERMAI_END_t1",
    ].join("\n");
    const r = extractResult(buf, tags.begin, tags.end, tags.exitTag)!;
    assert.equal(r.segmentStatus![1].skipped, true);
    assert.equal(r.exitCode, 1);
    assert.equal(isExecOk({ output: "", exitCode: 1, timedOut: false, script: "", segmentStatus: r.segmentStatus }), false);
    // 只有「跳过」没有真失败时，整条应当算成功
    assert.equal(
      isExecOk({ output: "", exitCode: 0, timedOut: false, script: "", segmentStatus: [{ index: 1, code: 0 }, { index: 2, code: 0, skipped: true }] }),
      true
    );
  });

  it("引号里的 `&&` 不拆（`echo 'a && b'` 是一条命令）", () => {
    const s = buildExecScript("echo 'a && b' && echo ok", tags, "/tmp/x.sh");
    assert.ok(s.includes("a && b"), "引号内容必须原样保留");
    assert.ok(s.includes(":seg:2:"), "外层 && 仍然要逐段打点");
  });

  it("后台任务（行尾 &）不插打点（{ cmd &; ... } 是非法 bash）", () => {
    // 这是提示词明确推荐的写法（nohup 后台启动 + 轮询），必须是整体放行
    const s = buildExecScript("nohup sleep 1 > /tmp/a.log 2>&1 &\nuptime", tags, "/tmp/x.sh");
    assert.ok(!s.includes(":seg:"), "行尾 & 的场景必须整体放行");
    assert.ok(!s.includes("{ "), "不能生成花括号分组");
  });

  it("多行脚本走 heredoc 落盘 + bash file，且同样不外包 2>&1", () => {
    const s = buildExecScript("for f in *; do\n  echo $f\ndone", tags, "/tmp/termai_agent_t1.sh");
    assert.ok(s.startsWith("cat > /tmp/termai_agent_t1.sh <<'TERMAI_AGENT_EOF'"));
    assert.ok(s.includes("\nbash /tmp/termai_agent_t1.sh\n"), "落盘执行，保留原始换行");
    assert.ok(!s.includes("bash /tmp/termai_agent_t1.sh 2>&1"), "不能外包 2>&1");
    assert.ok(s.endsWith("rm -f /tmp/termai_agent_t1.sh"));
  });

  it("命令含未配平花括号时不分段（会提前闭合 { ...; } 分组 → 整条语法错误）", () => {
    const s = buildExecScript("echo }; ls", tags, "/tmp/x.sh");
    assert.ok(!s.includes(":seg:"), "未配平花括号必须整体放行");
    const r = spawnSync("bash", ["-n", "-c", s], { encoding: "utf8" });
    assert.equal(r.status, 0, `仍必须是合法 bash：${r.stderr}`);
  });

  it("`${x}` 参数展开自平衡，不误伤分段", () => {
    const s = buildExecScript("echo ${x}; ls", tags, "/tmp/x.sh");
    assert.ok(s.includes(":seg:1:"), "参数展开配平，可以分段");
    const r = spawnSync("bash", ["-n", "-c", s], { encoding: "utf8" });
    assert.equal(r.status, 0, `必须是合法 bash：${r.stderr}`);
  });

  it("引号内的花括号不算（awk '{print $1}' 正常分段且语法合法）", () => {
    const s = buildExecScript("awk '{print $1}' /etc/hosts; ls", tags, "/tmp/x.sh");
    assert.ok(s.includes(":seg:1:"));
    const r = spawnSync("bash", ["-n", "-c", s], { encoding: "utf8" });
    assert.equal(r.status, 0, `必须是合法 bash：${r.stderr}`);
  });
});

describe("balancedBraces（花括号配平检查）", () => {
  it("配平 / 未配平 / 引号内 / 转义", () => {
    assert.equal(balancedBraces("echo ${x}"), true);
    assert.equal(balancedBraces("echo {a,b}"), true);
    assert.equal(balancedBraces("echo }"), false, "多出的 } 会提前闭合分组");
    assert.equal(balancedBraces("echo {"), false, "未闭合的 { 会吞掉后续内容");
    assert.equal(balancedBraces("awk '{print $1}' f"), true, "引号内的不算");
    assert.equal(balancedBraces("echo \\}; ls"), true, "转义的花括号不算");
  });
});

describe("extractResult（哨兵 → 输出/退出码 的真实链路）", () => {
  const T = { begin: "TERMAI_BEGIN_pt", exitTag: "TERMAI_EXIT_pt", end: "TERMAI_END_pt" };

  /** 实跑生成的脚本（bash 真实执行），返回 PTY 会看到的原文（含脚本回显行） */
  const runScript = (command: string): string => {
    const script = buildExecScript(command, T, "/tmp/termai_probe.sh");
    const echoBack = `${script.replace(/\r?\n/g, "\r")}\r`.replace(/\r/g, "\r\n");
    const r = spawnSync("bash", ["-c", script.replace(/\r?\n/g, "; ")], { encoding: "utf8" });
    return echoBack + (r.stdout ?? "");
  };

  it("`rm 对不存在路径 返回 0` —— 两段都成功，链路本身要能跑通（不是空断言）", () => {
    const buf = runScript("rm -f /definitely/not/here 2>/dev/null; echo real-output");
    const parsed = extractResult(buf, T.begin, T.end, T.exitTag);
    assert.ok(parsed, "前置条件：必须能切出哨兵区间");
    assert.equal(parsed!.exitCode, 0, "整体退出码反映末条 echo");
    assert.deepEqual(parsed!.segmentStatus, [
      { index: 1, code: 0 },
      { index: 2, code: 0 },
    ]);
    assert.ok(parsed!.output.includes("real-output"), "真实输出必须被正确切出");
    assert.equal(
      isExecOk({
        output: parsed!.output,
        exitCode: parsed!.exitCode,
        timedOut: false,
        script: "",
        segmentStatus: parsed!.segmentStatus,
      }),
      true
    );
  });

  it("中间段真的失败：整体退出码仍是 0，但分段退出码抓到非 0（终结假成功）", () => {
    // cat 不存在的文件 → 退出码 1；末条 echo 成功 → 整体退出码 0。
    // 旧实现只看到 0，会把「明明失败」的命令标成成功喂给模型。
    const buf = runScript("cat /nonexistent-termai-probe-file; echo done");
    const parsed = extractResult(buf, T.begin, T.end, T.exitTag);
    assert.ok(parsed);
    assert.equal(parsed!.exitCode, 0, "末条 echo 成功 → 整体退出码 0（这正是旧实现被骗的地方）");
    assert.deepEqual(parsed!.segmentStatus, [
      { index: 1, code: 1 },
      { index: 2, code: 0 },
    ]);
    const res = {
      output: parsed!.output,
      exitCode: parsed!.exitCode,
      timedOut: false,
      script: "",
      segmentStatus: parsed!.segmentStatus,
    };
    assert.equal(isExecOk(res), false, "整体 0 不能再骗过判据");
    const obs = buildObservation([{ command: "cat /nonexistent-termai-probe-file; echo done", result: res }]);
    assert.ok(obs.includes("第 1 段 → 1"), "分段结果必须进观察");
    assert.ok(obs.includes("只反映最后一段"), "必须点明整体退出码不可作成功依据");
  });

  it("分段标记不会混进模型看到的输出正文（否则等于给模型看哨兵）", () => {
    const parsed = extractResult(runScript("echo AAA; echo BBB"), T.begin, T.end, T.exitTag);
    assert.ok(parsed);
    assert.ok(parsed!.output.includes("AAA") && parsed!.output.includes("BBB"));
    assert.ok(!parsed!.output.includes(":seg:"), "打点行必须被剔除");
    assert.ok(!parsed!.output.includes(T.exitTag), "哨兵串不能出现在输出里");
    assert.equal(parsed!.exitCode, 0);
  });

  it("单条命令（无分段）时 segmentStatus 为空，整体退出码照常工作", () => {
    const parsed = extractResult(runScript("grep -q termai-no-such-token /dev/null"), T.begin, T.end, T.exitTag);
    assert.ok(parsed);
    assert.equal(parsed!.exitCode, 1, "单条命令的退出码必须原样拿到");
    assert.deepEqual(parsed!.segmentStatus, []);
  });

  it("逐段输出切分：每段拿到自己独立的 stdout，空输出段也保留（模型据此归因）", () => {
    // 模拟 PTY 真实原文：首行是脚本回显（含所有哨兵 token），其后才是输出行。
    const buffer = [
      `echo "${T.begin}"; { ls /etc; echo "${T.exitTag}:seg:1:0"; }; { grep ssl /etc/nginx.conf; echo "${T.exitTag}:seg:2:1"; }; echo "${T.exitTag}:0"; echo "${T.end}"`,
      T.begin,
      "hosts",
      "passwd",
      `${T.exitTag}:seg:1:0`,
      "", // 第 2 段 grep 无匹配 → 空输出
      `${T.exitTag}:seg:2:1`,
      `${T.exitTag}:0`,
      T.end,
    ].join("\n");
    const parsed = extractResult(buffer, T.begin, T.end, T.exitTag);
    assert.ok(parsed, "前置条件：必须切出哨兵区间");
    assert.equal(parsed!.segments.length, 2, "两段都要切出来");
    assert.deepEqual(parsed!.segmentStatus, [
      { index: 1, code: 0 },
      { index: 2, code: 1 },
    ]);
    assert.ok(parsed!.segments[0].output.includes("hosts") && parsed!.segments[0].output.includes("passwd"), "第 1 段输出是 ls 的结果");
    assert.equal(parsed!.segments[1].output.trim(), "", "第 2 段无匹配 → 空输出，必须保留以便模型知道「这段啥也没匹配到」");
    assert.ok(!parsed!.output.includes(":seg:"), "分段标记不能漏进整段输出");
  });

  it("逻辑链多行下发：脚本回显不能漏进分段输出（真实主机 192.168.188.128 实测泄漏）", () => {
    // 逻辑链包装是**多行下发**的（`&&` / `||` 要逐段打点，不能拍平成一行），
    // PTY 会把每一行带提示符回显出来，于是
    // `[root@mgt ~]# { false; __termai_rc=$?; }; echo "TERMAI_EXIT_pt:seg:1:$__termai_rc"`
    // 这类行会落在**各段自己的输出区间**里。整体 output 走了 isWrapperEchoLine 是干净的，
    // 分段输出若不过滤，模型就在观察里看到哨兵 token，可能照抄这个模式自己拼哨兵，
    // 下一轮嵌套哨兵、切分全乱（heredoc 形态踩过同一个坑，链式包装是新增形态）。
    const command = "false && echo NEVER-SHOULD-RUN || echo fallback-ran";
    const script = buildExecScript(command, T, "/tmp/termai_probe.sh");
    const r = spawnSync("bash", ["-c", script], { encoding: "utf8" });
    const echoBack = script
      .split(/\r?\n/)
      .map((l) => `[root@mgt ~]# ${l}\r\n`)
      .join("");
    const parsed = extractResult(echoBack + (r.stdout ?? ""), T.begin, T.end, T.exitTag)!;
    assert.ok(parsed, "前置条件：必须切出哨兵区间");
    assert.deepEqual(parsed.segmentStatus, [
      { index: 1, code: 1 },
      { index: 2, code: 0, skipped: true },
      { index: 3, code: 0 },
    ]);
    const segText = parsed.segments.map((s) => s.output).join("\n");
    assert.ok(!segText.includes("TERMAI_"), `分段输出漏了哨兵 token：\n${segText}`);
    assert.ok(!segText.includes("__termai_rc"), `分段输出漏了链式状态行：\n${segText}`);
    assert.ok(segText.includes("fallback-ran"), "第 3 段的真实输出必须留着");
    assert.ok(!segText.includes("NEVER-SHOULD-RUN"), "被短路的段不该有输出");
    const obs = buildObservation(
      [
        {
          command,
          result: {
            output: parsed.output,
            exitCode: parsed.exitCode,
            timedOut: false,
            script,
            segmentStatus: parsed.segmentStatus,
            segments: parsed.segments,
          },
        },
      ],
      8000
    );
    assert.ok(!/TERMAI_(BEGIN|EXIT|END)_/.test(obs), "观察里出现哨兵 token → 模型可能照抄包装模式");
  });

  it("多行脚本：BEGIN 之后回显的 bash/echo 包装行必须剔除（真实主机实测泄漏）", () => {
    // 真实链路（CentOS 7 实测）：多行脚本先 heredoc 落盘，BEGIN 打印之后才执行
    // `bash /tmp/termai_agent_<token>.sh` 与 `echo "TERMAI_EXIT_…"`，这些回显行
    // 落在切片区间内。旧实现把它们当命令输出交给模型 → 模型以为协议长这样，
    // 下一轮照抄 `echo "TERMAI_EXIT_..."`，导致嵌套哨兵、切分错乱。
    const scriptPath = "/tmp/termai_agent_pt.sh";
    const command = 'for i in 1 2 3; do\n  echo "n=$i"\ndone';
    const script = buildExecScript(command, T, scriptPath);
    const buffer = [
      script.replace(/\r?\n/g, "\r\n"),
      T.begin,
      `[root@mgt ~]# bash ${scriptPath}`,
      "n=1",
      "n=2",
      "n=3",
      "echo hi", // 真实输出里出现 echo 字样不能被误伤
      `[root@mgt ~]# echo "${T.exitTag}:$?"`,
      `${T.exitTag}:0`,
      `[root@mgt ~]# echo "${T.end}"`,
      T.end,
    ].join("\r\n");

    const parsed = extractResult(buffer, T.begin, T.end, T.exitTag);
    assert.ok(parsed, "前置条件：必须切出哨兵区间");
    assert.equal(parsed!.output, "n=1\nn=2\nn=3\necho hi", "只留真实输出");
    assert.ok(!parsed!.output.includes("termai_agent_pt.sh"), "脚本路径回显不能进输出");
    assert.equal(parsed!.exitCode, 0, "退出码仍要能拿到");
  });
});

describe("buildObservation（多段命令按段归因）", () => {
  it("多段命令拆成每段独立块，空输出段也可见，而非混成一坨", () => {
    const result = {
      output: "hosts\npasswd",
      exitCode: 0,
      timedOut: false,
      script: "",
      segmentStatus: [
        { index: 1, code: 0 },
        { index: 2, code: 1 },
      ],
      segments: [
        { index: 1, code: 0, output: "hosts\npasswd" },
        { index: 2, code: 1, output: "" },
      ],
    };
    const obs = buildObservation([{ command: "ls /etc; grep ssl /etc/nginx.conf", result }]);
    assert.ok(obs.includes("· 第 1 段 退出码：0"), "第 1 段独立块");
    assert.ok(obs.includes("· 第 2 段 退出码：1"), "第 2 段独立块（失败段也明确标出）");
    assert.ok(obs.includes("(无输出)"), "空输出段显示占位，模型才知道这段没匹配到");
    assert.ok(obs.includes("hosts"), "第 1 段真实输出进观察");
    assert.ok(obs.includes("只反映最后一段"), "分段退出码总览仍要带出来");
  });
});

describe("createDupTracker（重复命令硬闸门）", () => {
  const STATUS_OUT = [
    "● nfs-server.service - NFS server and services",
    "     Loaded: loaded (/usr/lib/systemd/system/nfs-server.service; enabled)",
    "     Active: active (running) since Thu 2026-09-10 14:00:00 CST",
  ].join("\n");

  it("允许执行 2 次（给「装完 / 启动后复查状态」留余量），第 3 次才拦", () => {
    const t = createDupTracker();
    t.record("df -h", true, "Filesystem Size\n/dev/vda1 40G 30G 79% /");
    assert.equal(t.isDuplicate("df -h"), false, "已成功 1 次 → 第 2 次仍放行（复查余量）");
    t.record("df -h", true, "Filesystem Size\n/dev/vda1 40G 30G 79% /");
    assert.equal(t.isDuplicate("df -h"), true, "已成功 2 次 → 第 3 次起拦住");
  });

  it("复现截图：查询被包进 `restart && status` 里也要计数，第 10 步必须被拦", () => {
    const t = createDupTracker();
    // 第 7 步：起服务
    t.record("systemctl start nfs-server && systemctl enable nfs-server", true, "");
    // 第 8 步：查状态（第 1 次）
    t.record("systemctl status nfs-server --no-pager", true, STATUS_OUT);
    assert.equal(t.isDuplicate("systemctl status nfs-server --no-pager"), false);
    // 第 9 步：重启 + 再查（status 第 2 次，此前被旧实现漏记）
    t.record(
      "systemctl restart nfs-server && systemctl status nfs-server --no-pager",
      true,
      STATUS_OUT
    );
    // 第 10 步：与第 8 步逐字相同 —— 旧实现只数到 1 次所以放行，现在必须拦
    assert.equal(t.isDuplicate("systemctl status nfs-server --no-pager"), true);
  });

  it("复合命令里只要有一条子命令是新的，整条照常执行", () => {
    const t = createDupTracker();
    t.record("systemctl status nfs --no-pager", true, "running");
    t.record("systemctl status nfs --no-pager", true, "running");
    // 前一半是新命令（没跑过）→ 不该因后一半重复而整条被拦
    assert.equal(t.isDuplicate("systemctl is-enabled nfs && systemctl status nfs --no-pager"), false);
  });

  it("失败的命令原样重跑会进闸门，但先修好前提就放行", () => {
    const t = createDupTracker();
    t.record("nginx -t", false, "syntax error");
    // 前提没变 → 同样的输入必然得到同一份报错，重发只是白烧一轮
    assert.equal(t.isDuplicate("nginx -t"), true, "失败后原样重跑必须拦");
    assert.equal(t.dupReason("nginx -t")?.kind, "failed");
    // 中间成功改过配置（状态变更）→ 前提变了，允许复测
    t.record("sed -i 's/a/b/' /etc/nginx/nginx.conf", true, "");
    assert.equal(t.isDuplicate("nginx -t"), false, "改过配置后允许复测");
  });

  it("失败重跑被拦时能回填上次的报错（模型据此知道为什么不能重跑）", () => {
    const t = createDupTracker();
    t.record("yum install -y zabbix-get", false, "Transaction check error: file /usr/bin/zabbix_get conflicts");
    const r = t.dupReason("yum install -y zabbix-get");
    assert.equal(r?.kind, "failed");
    assert.match(r?.failDigest ?? "", /Transaction check error/);
  });

  it("装包失败 → 卸掉冲突包 → 再装：这是正确路径，必须放行", () => {
    const t = createDupTracker();
    const install = "yum install -y zabbix-server zabbix-agent zabbix-get";
    t.record(install, false, "Transaction check error");
    assert.equal(t.isDuplicate(install), true, "原样重跑不该放行");
    t.record("yum remove -y zabbix-get", true, "Complete!");
    assert.equal(t.isDuplicate(install), false, "卸掉冲突包后重装是正确路径");
  });

  it("成功过一次后即视为已有答案（与失败重跑无关）", () => {
    const t = createDupTracker();
    t.record("nginx -t", false, "syntax error");
    t.record("nginx -t", true, "");
    assert.equal(t.isDuplicate("nginx -t"), true, "拿到过成功结果后，再跑就是冗余");
  });

  it("lastDigest 回填成功那次的输出片段（失败那次的片段不被采用）", () => {
    const t = createDupTracker();
    t.record("systemctl status nfs-server --no-pager", false, "Unit not found");
    assert.equal(t.lastDigest("systemctl status nfs-server --no-pager"), "Unit not found");
    t.record("systemctl status nfs-server --no-pager", true, STATUS_OUT);
    // 片段取「有信息量」的那一行，而不是 ● 开头的单元描述
    assert.equal(
      t.lastDigest("systemctl status nfs-server --no-pager"),
      "Active: active (running) since Thu 2026-09-10 14:00:00 CST"
    );
    t.record("systemctl status nfs-server --no-pager", false, "connection refused");
    assert.equal(
      t.lastDigest("systemctl status nfs-server --no-pager"),
      "Active: active (running) since Thu 2026-09-10 14:00:00 CST",
      "失败那次的片段没有参考价值，应保留上次成功拿到的"
    );
  });

  it("空白/空命令不会污染台账", () => {
    const t = createDupTracker();
    t.record("   ", true, "");
    t.record("", true, "");
    assert.equal(t.isDuplicate("   "), false);
  });

  it("多余空白不影响判定（normalize 后是同一个键）", () => {
    const t = createDupTracker();
    t.record("df   -h", true, "");
    t.record("df -h", true, "");
    assert.equal(t.isDuplicate("  df  -h  "), true);
  });
});

describe("cmdFamily（同族变体识别）", () => {
  it("同一目标的不同写法归成一族（忽略 flag 差异）", () => {
    const fam = cmdFamily("ls -1");
    assert.equal(fam, "ls|.");
    assert.equal(cmdFamily("ls -1t | head -1"), fam, "套了管道还是看同一个目录");
    assert.equal(cmdFamily("ls -la"), fam, "换 flag 不改变「在看哪个目标」");
    assert.equal(cmdFamily("ls -la ."), fam, "显式 . 与省略等价");
  });

  it("不同目标不算同族（各查各的）", () => {
    assert.notEqual(cmdFamily("ls /var/log"), cmdFamily("ls /etc"));
    assert.notEqual(cmdFamily("ls /var/log"), cmdFamily("ls /opt"));
    assert.notEqual(cmdFamily("cat /etc/passwd"), cmdFamily("cat /etc/group"));
  });

  it("末尾斜杠只是写法差异，归一到同一目标", () => {
    assert.equal(cmdFamily("ls /var/log"), cmdFamily("ls -la /var/log/"));
  });

  it("重定向 token 不混进族键（2>/dev/null 极常见）", () => {
    assert.equal(
      cmdFamily("grep -n err /var/log/a.log 2>/dev/null"),
      cmdFamily("grep -n err /var/log/a.log 2>&1"),
      "重定向不是被观察的目标，写法不同也应同族"
    );
  });

  it("写操作 segment 不参与族计数（必须能重复执行）", () => {
    assert.equal(cmdFamily("rm -rf /tmp/x"), null);
    assert.equal(cmdFamily("systemctl restart nginx"), null);
    assert.equal(cmdFamily("find / -name x -exec rm -f {} +"), null);
    assert.equal(cmdFamily("sed -i s/a/b/ f.conf"), null);
    assert.equal(cmdFamily("docker rm -f c1"), null);
    assert.equal(cmdFamily("crontab /tmp/x"), null);
  });

  it("复合命令跳过写 segment，取第一个只读 segment 归族", () => {
    assert.equal(
      cmdFamily("rm -rf /tmp/old; du -sh /var/log/* /var/cache/yum/*"),
      "du|/var/cache/yum/* /var/log/*"
    );
  });

  it("同一基础命令的只读子命令才算只读（rpm -qa 是查询、rpm -ivh 是安装）", () => {
    assert.equal(cmdFamily("rpm -qa | grep -i nsf"), "rpm|.");
    assert.equal(cmdFamily("rpm -ivh /tmp/x.rpm"), null, "安装不能进族计数");
    assert.equal(cmdFamily("systemctl status nginx"), "systemctl|nginx status");
    assert.equal(cmdFamily("systemctl restart nginx"), null);
    assert.equal(cmdFamily("crontab -l"), "crontab|.");
  });

  it("含 $(...) / 反引号时目标无法静态确定 → 不参与族计数", () => {
    assert.equal(cmdFamily("ls $(pwd)"), null);
    assert.equal(cmdFamily("cat `ls /tmp`"), null);
  });

  it("不在只读白名单里的命令安全退化为 null", () => {
    assert.equal(cmdFamily("smartctl -a /dev/sda"), null);
    assert.equal(cmdFamily("my_custom_tool"), null);
  });

  it("isStateChanging 认得出伪装成只读的写操作", () => {
    assert.equal(isStateChanging("find / -name '*.log' -exec rm -f {} +"), true);
    assert.equal(isStateChanging("crontab /tmp/x"), true);
    assert.equal(isStateChanging("echo hi > /tmp/f"), true);
    assert.equal(isStateChanging("yum install -y httpd"), true);
    assert.equal(isStateChanging("ls -la"), false);
    assert.equal(isStateChanging("rpm -qa 2>/dev/null"), false);
    assert.equal(isStateChanging("systemctl status nginx"), false);
  });
});

describe("同族变体硬闸门（复现截图：5 条变体全部放行）", () => {
  /** 截图序列：模型在同一个目录上连换 5 种写法「再看一眼」 */
  const SHOT = ["ls -1", "ls -1t | head -1", "ls -1", "pwd", "ls -1t"];

  it("旧实现：5 条全部放行，第 6 条逐字重复才拦 —— 这是截图故障的根因", () => {
    const t = createDupTracker();
    const allowed: string[] = [];
    for (const c of SHOT) {
      if (!t.isDuplicate(c)) {
        allowed.push(c);
        t.record(c, true, "a.txt\nb.txt");
      }
    }
    assert.deepEqual(allowed, SHOT, "五条变体全部逃过旧闸门");
  });

  it("新实现：同一族第 3 次变体起拒绝，且说清「和哪些写法是同族」", () => {
    const t = createDupTracker();
    const allowed: string[] = [];
    const blocked: string[] = [];
    for (const c of SHOT) {
      const r = t.dupReason(c);
      if (r) {
        blocked.push(c);
        if (c === "ls -1" && blocked.length === 1) {
          assert.equal(r.kind, "family");
          assert.deepEqual(r.siblings, ["ls -1", "ls -1t | head -1"], "要能告诉模型它换过哪些写法");
        }
      } else {
        allowed.push(c);
        t.record(c, true, "a.txt\nb.txt");
      }
    }
    assert.deepEqual(allowed, ["ls -1", "ls -1t | head -1", "pwd"], "前两种写法给足余量");
    assert.deepEqual(blocked, ["ls -1", "ls -1t"], "第 3 次同族变体起拦下");
  });

  it("写操作子命令第 2 次起拒绝，避免反复删/装", () => {
    const t = createDupTracker();
    assert.equal(t.dupReason("rm -rf /tmp/old"), null, "执行前第 1 次放行");
    t.record("rm -rf /tmp/old", true, "");
    assert.equal(t.dupReason("rm -rf /tmp/old")?.kind, "exact", "第 2 次即拒绝");
  });

  it("写命令执行后不再清空只读族计数：删完再看一眼仍受族阈值约束", () => {
    const t = createDupTracker();
    t.record("ls -1", true, "a");
    t.record("ls -1t", true, "b");
    assert.equal(t.dupReason("ls -la")?.kind, "family", "没写操作时第 3 次变体该拦");
    t.record("rm -rf /tmp/old", true, "");
    // 写操作不清空族计数，所以 ls -la 仍是第 3 次同族变体
    assert.equal(t.dupReason("ls -la")?.kind, "family", "删完再看一眼的机会已在前面用掉");
  });

  it("复现截图：rm; du 复合命令第二次因 rm 重复而被拒绝", () => {
    const t = createDupTracker();
    const cmd1 =
      "rm -rf /var/log/boot.log-* /var/log/dmesg.old; du -sh /var/log/* /var/cache/yum/* /var/lib/yum* /var/lib/docker/* 2>/dev/null | head -20";
    const cmd2 =
      "rm -rf /var/log/boot.log-* /var/log/dmesg.old; du -sh /var/log/* /var/cache/yum/* /var/lib/yum* /var/lib/docker/* /var/lib/audit* 2>/dev/null | head -20";
    assert.equal(t.dupReason(cmd1), null, "cmd1 第 1 次放行");
    t.record(cmd1, true, "4.0K /var/log/audit\n8.0K /var/log/messages");
    assert.equal(t.dupReason(cmd2)?.kind, "exact", "cmd2 第 2 次：rm 子命令已重复，拒绝");
  });

  it("失败不会进族闸门（同族换写法重试也放行）", () => {
    const t = createDupTracker();
    t.record("systemctl status nginx", false, "inactive");
    t.record("systemctl status nginx", false, "inactive");
    assert.equal(t.dupReason("systemctl is-active nginx"), null);
  });

  it("逐字重复优先报 exact，带不回 siblings（文案不同）", () => {
    const t = createDupTracker();
    t.record("df -h", true, "");
    t.record("df -h", true, "");
    const r = t.dupReason("df -h");
    assert.equal(r?.kind, "exact");
  });
});

describe("errorShapeOf（同类错误签名）", () => {
  it("真实故障：删不同路径，落到同一个签名（文本去重抓不到、签名能抓到）", () => {
    const a = errorShapeOf(
      "rm: cannot remove '/var/lib/nfs/rpc_pipefs/gssd/clntXX/gssd': Operation not permitted"
    );
    const b = errorShapeOf(
      "rm: cannot remove '/var/lib/nfs/rpc_pipefs/nfsd4_cb': Operation not permitted"
    );
    assert.equal(a, "rm: cannot remove <>: operation not permitted");
    assert.equal(a, b);
  });

  it("同一输出里多种错误时，取出现最多的那种形态", () => {
    const out = [
      "rm: cannot remove '/a/b': Operation not permitted",
      "rm: cannot remove '/c/d': Operation not permitted",
      "ls: cannot access '/x': No such file or directory",
    ].join("\n");
    assert.equal(errorShapeOf(out), "rm: cannot remove <>: operation not permitted");
  });

  it("不同性质的错误不会混成一个签名", () => {
    const perm = errorShapeOf("rm: cannot remove '/a': Operation not permitted");
    const conn = errorShapeOf("curl: (7) Failed to connect to localhost port 9090");
    assert.ok(perm);
    assert.ok(conn);
    assert.notEqual(perm, conn);
  });

  it("没被引号包裹的裸路径也归一", () => {
    assert.equal(
      errorShapeOf("cp: cannot stat /etc/nginx/nginx.conf: Permission denied"),
      "cp: cannot stat <>: permission denied"
    );
  });

  it("端口号 / errno 归一，同一种错误不会被数字拆成多个签名", () => {
    const a = errorShapeOf("nginx: bind() to 0.0.0.0:80 failed (98: Address already in use)");
    const b = errorShapeOf("nginx: bind() to 0.0.0.0:8080 failed (98: Address already in use)");
    assert.ok(a);
    assert.equal(a, b);
  });

  it("正常输出行不会被算进签名", () => {
    const out = [
      "drwxrwxrwx 2 root root 0 Sep 10 09:25 clntXX",
      "total 0",
      "rm: cannot remove '/x': Operation not permitted",
    ].join("\n");
    assert.equal(errorShapeOf(out), "rm: cannot remove <>: operation not permitted");
  });

  it("没有任何错误关键词时返回 null（不猜测）", () => {
    assert.equal(errorShapeOf("total 0\ndrwxr-xr-x 3 root root 4096 Sep 10 09:25 nfs"), null);
    assert.equal(errorShapeOf(""), null);
    assert.equal(errorShapeOf("nfs-server.service is active (running)"), null);
  });
});

describe("createFailTreadmill（同类错误连击）", () => {
  const EPERM = (p: string) => `rm: cannot remove '${p}': Operation not permitted`;

  it("第 1 次失败不提醒（给一次换方法的机会）", () => {
    const t = createFailTreadmill();
    t.observe(EPERM("/a"), false);
    assert.equal(t.note(), "");
  });

  it("连续 2 次同一签名后提醒，且文案里带出锁定的签名", () => {
    const t = createFailTreadmill();
    t.observe(EPERM("/a"), false);
    t.observe(EPERM("/b/c/d"), false);
    const n = t.note();
    assert.ok(n.includes("连续 2 次"), "应说明连击次数");
    assert.ok(n.includes("rm: cannot remove <>: operation not permitted"), "应回显签名");
    assert.ok(n.includes("mount | grep"), "应给出挂载点确认方法");
    assert.ok(n.includes("umount"), "应指出正确做法是卸载");
  });

  it("提醒过之后不每轮刷屏，连击到 4 次才再提醒一次", () => {
    const t = createFailTreadmill();
    t.observe(EPERM("/a"), false);
    t.observe(EPERM("/b"), false);
    assert.notEqual(t.note(), "", "第 2 次应提醒");
    assert.equal(t.note(), "", "同一连击不应重复提醒");
    t.observe(EPERM("/c"), false);
    assert.equal(t.note(), "", "第 3 次仍不提醒");
    t.observe(EPERM("/d"), false);
    assert.notEqual(t.note(), "", "第 4 次应再次提醒");
  });

  it("只有成功时不触发", () => {
    const t = createFailTreadmill();
    t.observe("total 0", true);
    t.observe("drwxr-xr-x 3 root root 4096 nfs", true);
    assert.equal(t.note(), "");
  });

  it("中间夹着成功命令不打断连击（真实场景：第 7 步 rm 失败 → 第 8 步成功 → 第 9 步 rm 又失败）", () => {
    const t = createFailTreadmill();
    t.observe(EPERM("/a"), false);
    t.observe("total 0", true);
    t.observe(EPERM("/b/c"), false);
    assert.notEqual(t.note(), "", "成功命令不算失败，不该把两次同因失败拆开");
  });

  it("错误性质换了就重新计数（不是「一直在失败」而是「一直在同一个错误上」）", () => {
    const t = createFailTreadmill();
    t.observe(EPERM("/a"), false);
    t.observe("curl: (7) Failed to connect to localhost port 9090", false);
    assert.equal(t.note(), "", "换了错误签名应重新计数");
    t.observe("curl: (7) Failed to connect to localhost port 9090", false);
    assert.notEqual(t.note(), "");
  });

  it("输出里没有可识别的错误行时不计数", () => {
    const t = createFailTreadmill();
    t.observe("total 0", false);
    t.observe("drwxr-xr-x 3 root root 4096 nfs", false);
    assert.equal(t.note(), "");
  });
});

describe("splitCommandParts（带分隔符的分词）", () => {
  it("保留每条子命令前面的分隔符，且与 splitSubCommands 结果一致", () => {
    const parts = splitCommandParts("a; b && c");
    assert.deepEqual(
      parts.map((p) => [p.sep, p.text]),
      [
        ["", "a"],
        [";", "b"],
        ["&&", "c"],
      ]
    );
    assert.deepEqual(splitSubCommands("a; b && c"), ["a", "b", "c"]);
  });

  it("引号内的分号不拆，2>&1 里的单 & 不拆", () => {
    assert.equal(splitCommandParts('grep "a;b" f').length, 1);
    assert.equal(splitCommandParts("nginx -t 2>&1").length, 1);
    assert.equal(splitCommandParts("nginx -t 2>&1; echo ok").length, 2);
  });
});

describe("sanitizeCommandLine（单行命令净化）", () => {
  const REPEATED = "rpm -qf /etc/cron.d/nsf 2>/dev/null";
  const many = (n: number) => Array.from({ length: n }, (_, i) => "ls /data" + i);

  it("真实截图：同一子命令逐字重复 46 次 → 折叠成 1 条", () => {
    const wall = Array.from({ length: 46 }, () => REPEATED).join("; ");
    const r = sanitizeCommandLine(wall);
    assert.equal(r.command, REPEATED, "折叠后应只剩一条");
    assert.equal(r.dedupedCount, 45);
    assert.equal(r.subCommandCount, 1);
    assert.deepEqual(r.overflow, []);
  });

  it("折叠重复时不破坏 && 的 fail-fast 语义", () => {
    const cmd =
      "systemctl restart nfs-server && systemctl status nfs-server --no-pager && systemctl status nfs-server --no-pager";
    const r = sanitizeCommandLine(cmd);
    assert.equal(r.command, "systemctl restart nfs-server && systemctl status nfs-server --no-pager");
    assert.equal(r.dedupedCount, 1);
    assert.ok(!r.command.includes(" ; "), "不能把 && 重拼成分号");
  });

  it("合法的复合命令原样通过（5 条 && 链，不误伤）", () => {
    const cmd =
      "apt-get update && apt-get install -y nginx && systemctl enable nginx && systemctl start nginx && systemctl status nginx --no-pager";
    const r = sanitizeCommandLine(cmd);
    assert.equal(r.command, cmd);
    assert.equal(r.dedupedCount, 0);
    assert.equal(r.subCommandCount, 5);
    assert.deepEqual(r.overflow, []);
  });

  it("参数不同的同名命令不合并（rm -rf /a 与 rm -rf /b 是两件事）", () => {
    const r = sanitizeCommandLine("rm -rf /var/lib/nfs; rm -rf /var/lib/nfs/rpc_pipefs");
    assert.equal(r.subCommandCount, 2);
    assert.equal(r.dedupedCount, 0);
    assert.equal(r.command, "rm -rf /var/lib/nfs; rm -rf /var/lib/nfs/rpc_pipefs");
  });

  it("只有空白差异的重复也算重复", () => {
    const r = sanitizeCommandLine("ls -la  /tmp; ls -la /tmp");
    assert.equal(r.dedupedCount, 1);
    assert.equal(r.command, "ls -la  /tmp");
  });

  it("净化后的子命令超过 8 条 → 整条拒绝（overflow 非空），不做静默截断", () => {
    const r = sanitizeCommandLine(many(9).join("; "));
    assert.equal(r.command, "");
    assert.equal(r.subCommandCount, 9);
    assert.equal(r.overflow.length, 1);
    assert.equal(r.overflow[0], "ls /data8");
  });

  it("恰好 8 条不同子命令放行（上限是闭区间）", () => {
    const cmd = many(8).join("; ");
    const r = sanitizeCommandLine(cmd);
    assert.equal(r.overflow.length, 0);
    assert.equal(r.subCommandCount, 8);
    assert.equal(r.command, cmd);
  });

  it("单行超过 2000 字符（无分隔符）→ 拒绝，避免 PTY 行缓冲截断丢掉尾部哨兵", () => {
    const huge = "echo " + "a".repeat(2100);
    const r = sanitizeCommandLine(huge);
    assert.equal(r.command, "");
    assert.equal(r.overflow.length, 1);
  });

  it("无顶层分隔符的普通命令原样返回", () => {
    const r = sanitizeCommandLine("df -h");
    assert.equal(r.command, "df -h");
    assert.equal(r.subCommandCount, 1);
    assert.equal(r.dedupedCount, 0);
    assert.deepEqual(r.overflow, []);
  });

  it("空输入不抛异常", () => {
    const r = sanitizeCommandLine("");
    assert.equal(r.command, "");
    assert.deepEqual(r.overflow, []);
  });
});

describe("shouldAbortWait（命令等待的熔断判据）", () => {
  const IDLE = 120_000;
  const HARD = 15 * 60_000;
  const base = { idleTimeoutMs: IDLE, hardTimeoutMs: HARD };

  it("静默超时后仍在持续输出：不能切断", () => {
    // 旧实现基础超时与硬上限同为 5 分钟，且硬上限判断无条件命中 ——
    // 还在爬进度条的 yum install / docker pull 会在第 5 分钟被切成半截，
    // 模型拿着半截输出下结论。这条锁住「只要还在吐字就续命」。
    const aborted = shouldAbortWait({
      ...base,
      now: 300_000,
      startedAt: 0,
      lastDataAt: 299_500, // 0.5 秒前刚有输出
    });
    assert.equal(aborted, false);
  });

  it("静默超过阈值且 3 秒无输出：判定卡死", () => {
    const aborted = shouldAbortWait({
      ...base,
      now: 125_000,
      startedAt: 0,
      lastDataAt: 120_000, // 已静默 5 秒
    });
    assert.equal(aborted, true);
  });

  it("静默未到阈值时，即使一直没输出也不切", () => {
    // 命令刚发出去还在建连/解析依赖，前 120 秒本来就可能没有输出。
    assert.equal(
      shouldAbortWait({ ...base, now: 60_000, startedAt: 0, lastDataAt: 0 }),
      false
    );
  });

  it("到达硬上限：即使刚有输出也切", () => {
    assert.equal(
      shouldAbortWait({ ...base, now: HARD, startedAt: 0, lastDataAt: HARD - 100 }),
      true
    );
  });

  it("洪水 / 中断 / 已结束：立即跳出", () => {
    const at = { ...base, now: 1000, startedAt: 0, lastDataAt: 900 };
    assert.equal(shouldAbortWait({ ...at, flooded: true }), true);
    assert.equal(shouldAbortWait({ ...at, aborted: true }), true);
    assert.equal(shouldAbortWait({ ...at, sawEnd: true }), true);
    // 宽松判据：以上都不成立时不能误判
    assert.equal(shouldAbortWait(at), false);
  });
});

describe("pickLedgerLines（已执行台账的展示窗口）", () => {
  const line = (i: number, pad = 80) => `✓ cmd_${i} → ${"x".repeat(pad)}`;

  it("超过条数上限时只取最近若干条", () => {
    const lines = Array.from({ length: 30 }, (_, i) => line(i));
    const out = pickLedgerLines(lines, 5, 100000);
    assert.equal(out.length, 5);
    assert.ok(out[4].includes("cmd_29"));
    assert.ok(!out.some((l) => l.includes("cmd_0 ")));
  });

  it("字符预算会先于条数触发", () => {
    // 条目自带输出片段，一条 100~300 字符很常见 —— 只按条数会在长行上撑爆上下文。
    const lines = Array.from({ length: 30 }, (_, i) => line(i, 500));
    const out = pickLedgerLines(lines, 24, 4000);
    const used = out.reduce((s, l) => s + l.length + 1, 0);
    assert.ok(used <= 4000, `总长必须收在预算内，实际 ${used}`);
    assert.ok(out.length < 24, "字符预算应比条数更早生效");
    // 同时断言宽松判据：预算很宽时不该凭空少给
    assert.equal(pickLedgerLines(lines, 24, 1e9).length, 24);
  });

  it("单行就超预算时仍保留这一条", () => {
    // 全砍光会让模型看不到「刚刚执行了什么」，于是重发同一条命令。
    const out = pickLedgerLines([line(0, 9000)], 24, 100);
    assert.equal(out.length, 1);
  });

  it("空台账返回空数组", () => {
    assert.deepEqual(pickLedgerLines([], 24, 4000), []);
  });
});

describe("busyMountHint（挂载点占用的确定性提示）", () => {
  // 真实输出取自 CentOS 7 实测：目录里含挂载点时 rm -rf 会逐条报 busy
  const busyOut =
    "rm: cannot remove ‘/run/containerd/io.containerd.runtime.v2.task/k8s.io/abc/rootfs’: Device or resource busy\n" +
    "rm: cannot remove ‘/run/containerd/io.containerd.runtime.v2.task/k8s.io/def/rootfs’: Device or resource busy";

  it("命中 EBUSY 时给出「找挂载点 → umount → 再删」的步骤", () => {
    const hint = busyMountHint(busyOut);
    assert.ok(hint.includes("挂载点"), "必须点明是挂载点占用");
    assert.ok(hint.includes("mount | grep"), "必须给出定位挂载点的命令");
    assert.ok(hint.includes("umount"), "必须给出正确动作");
    assert.ok(hint.includes("not mounted"), "必须提醒 umount 父目录会报 not mounted");
    assert.ok(hint.includes("df -h"), "必须区分「释放磁盘」这个真实目标");
  });

  it("umount 的 target is busy / 大小写变体同样命中", () => {
    assert.ok(busyMountHint("umount: /data: target is busy.").includes("挂载点"));
    assert.ok(busyMountHint("rm: cannot remove 'x': device is busy").includes("挂载点"));
  });

  it("普通失败与其它 errno 不误报", () => {
    // 宽松判据：避免「凡失败就塞一段提示」把观察预算吃光、也避免误导。
    assert.equal(busyMountHint("ls: cannot access '/nope': No such file or directory"), "");
    assert.equal(busyMountHint("Resource temporarily unavailable"), "");
    assert.equal(busyMountHint("bash: foo: command not found"), "");
    assert.equal(busyMountHint(""), "");
  });
});

describe("serviceDiagHint（服务起不来 / 半装包 / 依赖 socket）", () => {
  // 以下原文全部取自 CentOS 7 真机（docker 26.1.4 + containerd.io 1.6.33）
  it("systemd 启动失败：给出 journalctl 取根因，并明确「不要重复 start」", () => {
    const out =
      "Job for docker.service failed because the control process exited with error code. " +
      'See "systemctl status docker.service" and "journalctl -xe" for details.';
    const hint = serviceDiagHint(out);
    assert.ok(hint.includes("没有给出根因"));
    assert.ok(hint.includes("journalctl -u docker"), "必须点名服务并给命令");
    assert.ok(hint.includes("不要重复 start"));
    assert.ok(hint.includes("60~90"), "必须说明重复 start 的时间代价");
  });

  it("executable file not found → 指向「半装」与 reinstall，而不是换包名", () => {
    const out =
      'level=warning msg="Failed to run [runc features]" ' +
      'error="exec: \\"runc\\": executable file not found in $PATH"';
    const hint = serviceDiagHint(out);
    assert.ok(hint.includes("runc"));
    assert.ok(hint.includes("yum reinstall"), "半装的正解是重装同一个包");
    assert.ok(hint.includes("command -v"), "必须给出验收方式");
    assert.ok(hint.includes("不代表它对应的包没装"), "必须打断「没装就装别的包」的直觉");
  });

  it("依赖 socket 连不上 → 先起上游服务（containerd → docker）", () => {
    const out =
      'failed to start daemon: failed to dial "/run/containerd/containerd.sock": ' +
      'failed to dial "/run/containerd/containerd.sock": context deadline exceeded';
    const hint = serviceDiagHint(out);
    assert.ok(hint.includes("/run/containerd/containerd.sock"));
    assert.ok(hint.includes("上游"));
    assert.ok(hint.includes("systemctl enable --now containerd"));
  });

  it("`systemctl is-active` 只回 failed：start 返回 0 也可能是假成功", () => {
    // 真机实测（Type=simple 的服务）：systemctl start 返回 0，服务其实已经退出，
    // 唯一线索是紧接着的 is-active 输出 failed。只看 exit code 会误判成「起来了」。
    const hint = serviceDiagHint("failed", "systemctl start foo && systemctl is-active foo");
    assert.ok(hint.includes("foo"));
    assert.ok(hint.includes("不代表起来了"), "必须点破 start 返回 0 的假成功");
    assert.ok(hint.includes("journalctl -u foo"));
  });

  it("普通失败不误报（避免把观察预算吃光）", () => {
    assert.equal(serviceDiagHint("ls: cannot access '/nope': No such file or directory"), "");
    assert.equal(serviceDiagHint("yum install -y docker  \nComplete!"), "");
    assert.equal(serviceDiagHint(""), "");
  });
});

describe("安装类任务的效率与准确性", () => {
  it("步数预算按任务类型分档：安装/部署放宽到 36，查询类仍是 20", () => {
    assert.equal(stepBudgetFor("帮我在这台机器上安装 docker"), 36);
    assert.equal(stepBudgetFor("deploy the app with systemd"), 36);
    assert.equal(stepBudgetFor("看一下内存和磁盘"), 20);
    assert.equal(stepBudgetFor(""), 20);
  });

  it("安装日志去噪：删进度/包列表，保留错误行与结果行", () => {
    const lines: string[] = [
      "Loaded plugins: fastestmirror",
      "Resolving Dependencies",
      "--> Running transaction check",
    ];
    for (let i = 0; i < 120; i++) lines.push(`---> Package libpkg${i}.x86_64 0:1.0-${i} will be installed`);
    lines.push("Downloading packages:");
    lines.push("[==========>          ]  45%");
    lines.push("Error: Package: docker-ce-24.0.7 requires containerd.io >= 1.6.24");
    lines.push("Transaction check error:");
    lines.push("Complete!");
    const { text, dropped } = stripInstallNoise(lines.join("\n"));
    assert.ok(dropped > 100, `应删掉大量噪声行，实际 ${dropped}`);
    assert.ok(text.includes("requires containerd.io"), "错误行必须保留");
    assert.ok(text.includes("Complete!"), "结果行必须保留");
    assert.ok(!text.includes("---> Package libpkg0"), "包列表应被删掉");
  });

  it("安装类输出进观察时显著变短，且错误行不丢", () => {
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) lines.push(`---> Package pkg${i}.x86_64 1.0-${i} will be installed`);
    lines.push("Error: GPG key 缺少，无法校验签名");
    lines.push("Complete!");
    const obs = buildObservation(
      [
        {
          command: "yum install -y docker-ce",
          result: { output: lines.join("\n"), exitCode: 0, timedOut: false, script: "" },
        },
      ],
      8000
    );
    assert.ok(obs.includes("GPG key"), "错误行必须保留");
    assert.ok(obs.includes("已省略") && obs.includes("安装进度"), "必须说明省了什么");
    assert.ok(obs.length < 2000, `去噪后观察应远小于原始输出，实际 ${obs.length}`);
  });

  it("非安装类命令不走去噪（避免误删正常输出）", () => {
    assert.equal(isPackageManagerCommand("ls -lh /var/log"), false);
    assert.equal(isPackageManagerCommand("sudo yum install -y httpd"), true);
    assert.equal(isPackageManagerCommand("docker pull nginx:alpine"), true);
  });
});

describe("detectInteractivePrompt（停在等输入的识别）", () => {
  it("不带换行的提问后紧跟包装哨兵，仍要识别（真实主机实测硬等 120s 的那条）", () => {
    // 真实链路：`echo -n "Password: "; read -s pw` 被 `;` 分段包装成
    // `{ echo -n "Password: "; echo "TERMAI_EXIT_x:seg:1:0"; }; { read -s pw; … }`
    // 于是提问与哨兵拼成同一行，行尾条件失效 —— 旧实现在真机上等满 120 秒。
    const tail = "Password: TERMAI_EXIT_tmw1h74g7o4mxnv:seg:1:0";
    const hit = detectInteractivePrompt(tail);
    assert.ok(hit, "带哨兵的同类行必须仍能识别为「在等密码」");
    assert.equal(hit!.what, "密码");
  });

  it("是/否确认后粘哨兵同样识别", () => {
    const hit = detectInteractivePrompt("Continue? [Y/n] TERMAI_EXIT_abc:seg:1:0");
    assert.ok(hit);
    assert.equal(hit!.what, "是/否确认");
  });

  it("sudo 密码（独占一行）照常识别", () => {
    const hit = detectInteractivePrompt("[sudo] password for root:");
    assert.ok(hit);
    assert.equal(hit!.what, "sudo 密码");
  });

  it("普通输出末尾出现 password 字样但不在行尾提问形态时，不误判", () => {
    assert.equal(detectInteractivePrompt("2026-01-01 WARN password policy loaded"), null);
    assert.equal(detectInteractivePrompt("all-done"), null);
  });

  it("剥哨兵不能把真实内容一起剥掉", () => {
    const hit = detectInteractivePrompt("see TERMAI_EXIT_x:seg:1:0 in log\nProceed? [yes/no]");
    assert.ok(hit, "前一行含哨兵不影响后一行提问的识别");
  });
});

describe("观察里的凭证脱敏（接在 sanitizeOutput 上）", () => {
  it("密码/令牌/连接串不会原样进模型上下文", () => {
    const raw = [
      "$ mysql -uroot --password=Adm1n@2024 -e 'select 1'",
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig",
      "DSN=mysql://root:Pa55w0rd@10.0.0.9:3306/app",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "b3BlbnNzaC1rZXktdjEAAAAA",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const out = sanitizeOutput(raw, 200);
    for (const secret of ["Adm1n@2024", "eyJhbGciOiJIUzI1NiJ9", "Pa55w0rd", "b3BlbnNzaC1rZXktdjEAAAAA"]) {
      assert.ok(!out.includes(secret), `明文泄露：${secret}\n${out}`);
    }
    // 结构保留，模型仍能判断「这是一条带密码的命令」
    assert.ok(out.includes("--password=***"));
    assert.ok(out.includes("mysql://root:***@10.0.0.9"));
  });

  it("正常日志不受影响（不能因为脱敏让模型读不到报错）", () => {
    const raw = "Job for docker.service failed because the control process exited with error code.";
    assert.equal(sanitizeOutput(raw, 200), raw);
  });
});

describe("digestFailure（失败输出取错误行）", () => {
  it("yum 包冲突：取到 Transaction check error 与冲突明细，而不是 Loaded plugins", () => {
    const out = [
      "Loaded plugins: fastestmirror, langpacks",
      "Loading mirror speeds from cached hostfile",
      "Running transaction check",
      "Transaction check error:",
      "  file /usr/bin/zabbix_get conflicts between attempted installs",
      "Error Summary",
    ].join("\n");
    const s = digestFailure(out);
    assert.match(s, /Transaction check error/);
    assert.match(s, /conflicts/);
    assert.ok(!s.includes("Loaded plugins"), "头部噪音不该占位");
    assert.ok(!s.includes("Running transaction check"), "「Runnging transaction check」不是错误行");
  });

  it("没有错误关键词时退回尾部两行（多数程序最后一行才是结论）", () => {
    assert.equal(digestFailure("a\nb\nc\nd"), "c | d");
  });

  it("跳过没有内容的纯标题行（Error Summary）", () => {
    const out = "boom happened\npanic: disk gone\nError Summary";
    assert.equal(digestFailure(out), "boom happened | panic: disk gone");
  });

  it("空输出给占位符", () => {
    assert.equal(digestFailure(""), "（无输出）");
  });

  it("超长错误行被截断但保留关键前缀", () => {
    const s = digestFailure(`error: ${"x".repeat(500)}`, 80);
    assert.ok(s.length <= 81);
    assert.match(s, /^error:/);
  });
});

describe("digestFailure：命中过多时取尾部（根因在最后）", () => {
  it("yum 先逐包提示 No package，再在末尾给 Transaction check error", () => {
    const out = [
      "Loaded plugins: fastestmirror",
      "No package zabbix-sqlite3 available.",
      "Resolving Dependencies",
      "Transaction check error:",
      "  file /usr/bin/zabbix_get conflicts between attempted installs",
      "Error Summary",
    ].join("\n");
    const s = digestFailure(out);
    assert.match(s, /Transaction check error/);
    assert.match(s, /conflicts/);
    assert.ok(!s.includes("No package"), "中间提示不该盖掉根因");
  });
});
