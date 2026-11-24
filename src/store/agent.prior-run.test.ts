/**
 * 「换目标后重开」的上一轮简报。
 *
 * 对应真实故障：Agent 给出「需要手动执行：创建 /etc/systemd/system/Xvnc.service」，
 * 用户接着发「你帮我建这个服务」，agent 却答非所问。根因是 `goalChanged` 会把
 * 上下文清成 system + 新目标 —— 上一轮那句结论、以及做过的命令全都不在上下文里了，
 * 模型既不知道「这个服务」指什么，也不知道自己已经干到哪一步。
 *
 * 修法不是把旧对话整段塞回来（那会导致「换目标仍接着干旧活」），而是给一份
 * 结构化简报 + 明确的「这是背景不是当前任务」限定。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildPriorRunBrief, judgeGoalRelation } from "./agent";

const step = (index: number, command: string, output = "", status: "done" | "failed" = "done") => ({
  id: `s${index}`,
  index,
  thought: "",
  items: [
    {
      command,
      risk: "low" as const,
      status,
      output,
      exitCode: status === "done" ? 0 : 1,
      timedOut: false,
    },
  ],
  risk: "low" as const,
  batched: false,
  status,
  startedAt: 0,
  finishedAt: 1,
});

describe("buildPriorRunBrief", () => {
  it("没有任何上一轮内容时返回 null（不能凭空空塞一段提示）", () => {
    assert.equal(buildPriorRunBrief({ submittedGoal: "", summary: "", steps: [] }), null);
    assert.equal(buildPriorRunBrief({ submittedGoal: "  ", summary: "\n", steps: [] }), null);
  });

  it("带上上一轮目标与结论 —— 用户说的「那个服务」才有指代对象", () => {
    const s = buildPriorRunBrief({
      submittedGoal: "帮我在这台机器上装 VNC 并设成开机自启",
      summary: "## 结论摘要\n已装好 tigervnc-server。\n## 需要手动执行的操作\n- 创建 /etc/systemd/system/Xvnc.service",
      steps: [],
    });
    assert.ok(s);
    assert.ok(s!.includes("装 VNC"), "要有上一轮目标");
    assert.ok(s!.includes("Xvnc.service"), "结论原文要带过来（关键就是这句）");
  });

  it("列出已执行命令，并标出命令与其结果", () => {
    const s = buildPriorRunBrief({
      submittedGoal: "装 VNC",
      summary: "",
      steps: [step(1, "yum install -y tigervnc-server", "Installed:\n  tigervnc-server.x86_64"), step(2, "systemctl status vncserver", "Unit vncserver.service could not be found.", "failed")],
    });
    assert.ok(s);
    assert.ok(s!.includes("yum install -y tigervnc-server"), "要列出做过的命令（避免重复劳动）");
    assert.ok(s!.includes("✓"), "成功标记");
    assert.ok(s!.includes("✗"), "失败标记");
  });

  it("明确声明这是背景资料，并给出「续做 / 换事」两种处置，避免回到「换目标仍干旧活」", () => {
    const s = buildPriorRunBrief({ submittedGoal: "装 VNC", summary: "装好了", steps: [] });
    assert.ok(s);
    assert.ok(s!.includes("背景资料"), "必须限定为背景");
    assert.ok(s!.includes("直接接着做"), "要允许「把上面那几条执行掉」这类指令");
    // 关键：判断依据必须是用户原话，而不是上一轮计划 —— 否则换目标后会接着干旧活
    assert.ok(s!.includes("用户这次的原话"), "续接与否以用户原话为准");
    assert.ok(s!.includes("确实是另一件事"), "要给出「换事就忽略旧计划」的出口");
  });

  it("体积有上限：命令只取前 24 条、结论截断到 1.6k", () => {
    const steps = Array.from({ length: 40 }, (_, i) => step(i + 1, `cmd-number-${i + 1}`));
    const s = buildPriorRunBrief({
      submittedGoal: "x".repeat(500),
      summary: "y".repeat(5000),
      steps,
    });
    assert.ok(s);
    assert.ok(s!.includes("cmd-number-24"), "第 24 条应在");
    assert.ok(!s!.includes("cmd-number-25"), "第 25 条应被截掉");
    assert.ok(s!.length < 6000, `总体积要可控，实际 ${s!.length}`);
  });

  it("命令里的换行被压平（否则台账会撑爆上下文）", () => {
    const s = buildPriorRunBrief({
      submittedGoal: "a",
      summary: "",
      steps: [step(1, "cat > /tmp/x <<'EOF'\nline1\nline2\nEOF")],
    });
    assert.ok(s);
    const rowLine = s!.split("\n").find((l) => l.includes("cat > /tmp/x"))!;
    assert.ok(rowLine, "要有一行台账");
    assert.ok(!rowLine.includes("\n"));
  });
});

describe("judgeGoalRelation（续接 vs 换事）", () => {
  it("含承接语 → 判为继续，保住完整对话历史", () => {
    const cases = [
      "你先把冲突包卸了再装",
      "继续",
      "接着弄",
      "上面那个服务帮我建一下",
      "把那个改掉",
      "它还是起不来",
      "再试一次",
    ];
    for (const g of cases) {
      const r = judgeGoalRelation({ prevGoal: "帮我安装 zabbix", newGoal: g });
      assert.equal(r.relation, "continue", `「${g}」应判为续接`);
    }
  });

  it("没有承接语 → 判为新任务（宁可多说一句，也不要答非所问）", () => {
    const cases = ["帮我安装 docker", "查一下磁盘使用率", "帮我配置 nginx 反向代理"];
    for (const g of cases) {
      const r = judgeGoalRelation({ prevGoal: "帮我安装 zabbix", newGoal: g });
      assert.equal(r.relation, "fresh", `「${g}」应判为新任务`);
    }
  });

  it("首轮无上一轮目标 → fresh", () => {
    assert.equal(judgeGoalRelation({ prevGoal: "", newGoal: "装 nginx" }).relation, "fresh");
  });

  it("目标完全没变 → continue", () => {
    assert.equal(judgeGoalRelation({ prevGoal: "装 nginx", newGoal: "装 nginx" }).relation, "continue");
  });

  it("给出可解释的原因（便于排查误判）", () => {
    assert.match(
      judgeGoalRelation({ prevGoal: "装 nginx", newGoal: "接着弄" }).reason,
      /承接语/
    );
  });
});

describe("buildPriorRunBrief 的失败摘要", () => {
  const FAIL_OUT = [
    "Loaded plugins: fastestmirror, langpacks",
    "Loading mirror speeds from cached hostfile",
    "Running transaction check",
    "Running transaction test",
    "Transaction check error:",
    "  file /usr/bin/zabbix_get conflicts between attempted installs of zabbix-get-6.0.49 and zabbix6.0-6.0.29",
    "Error Summary",
  ].join("\n");

  it("失败命令取**错误行**，而不是文件头的 Loaded plugins", () => {
    const s = buildPriorRunBrief({
      submittedGoal: "装 zabbix",
      summary: "",
      steps: [step(1, "yum install -y zabbix-get", FAIL_OUT, "failed")],
    });
    assert.ok(s);
    assert.ok(s!.includes("conflicts"), "冲突明细必须出现在台账里");
    assert.ok(!s!.includes("Loaded plugins"), "没有信息量的头部不该占据摘要");
  });

  it("被硬闸门拒绝的命令要带过去（它们不建 step，否则新任务会重撞同一堵墙）", () => {
    const s = buildPriorRunBrief({
      submittedGoal: "改 ssh 配置",
      summary: "被拦了",
      steps: [],
      blockedCommands: ["sed -i 's/PermitRootLogin/no/' /etc/ssh/sshd_config"],
    });
    assert.ok(s);
    assert.ok(s!.includes("被安全规则"), "要有明确的「被拒绝」段落");
    assert.ok(s!.includes("sshd_config"), "命令原文要在");
  });
});
