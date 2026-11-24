import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractHostFacts,
  mergeHostFacts,
  renderHostFacts,
  parseOsRelease,
  parseUname,
  parsePkgManager,
  envProbeKind,
  envProbeCoveredBy,
} from "./hostFacts";

// 真实样本取自 CentOS 7.9（root@192.168.188.128）
const OS_RELEASE = `NAME="CentOS Linux"
VERSION="7 (Core)"
ID="centos"
ID_LIKE="rhel fedora"
VERSION_ID="7"
PRETTY_NAME="CentOS Linux 7 (Core)"
ANSI_COLOR="0;31"
CPE_NAME="cpe:/o:centos:centos:7"`;

const UNAME_A =
  "Linux mgt 3.10.0-1160.119.1.el7.x86_64 #1 SMP Tue Jun 4 15:57:24 UTC 2024 x86_64 x86_64 x86_64 GNU/Linux";

describe("hostFacts · 解析", () => {
  it("os-release 取 PRETTY_NAME，缺失时用 NAME + VERSION_ID", () => {
    assert.equal(parseOsRelease(OS_RELEASE), "CentOS Linux 7 (Core)");
    assert.equal(parseOsRelease('NAME="Alpine Linux"\nVERSION_ID="3.19.1"'), "Alpine Linux 3.19.1");
    // 老发行版只有 /etc/redhat-release
    assert.equal(parseOsRelease("CentOS Linux release 7.9.2009 (Core)"), "CentOS Linux release 7.9.2009 (Core)");
    assert.equal(parseOsRelease("hello"), "");
  });

  it("uname -a 同时取内核与架构；uname -m 只取架构", () => {
    assert.deepEqual(parseUname("uname -a", UNAME_A), {
      kernel: "3.10.0-1160.119.1.el7.x86_64",
      arch: "x86_64",
    });
    assert.deepEqual(parseUname("uname -m", "aarch64"), { arch: "aarch64" });
    // 不认识的输出不能瞎猜
    assert.deepEqual(parseUname("uname -m", "oops"), {});
  });

  it("复合探测命令（cat os-release; uname -r; uname -m; command -v）也要抽到内核与架构", () => {
    // 真实主机 192.168.188.128 实测：四段输出拼在一起，首行是 os-release 的 NAME=…，
    // 旧实现按「第一行」取，内核与架构**整天抽不到**，模型于是每轮自己再 uname 一遍。
    const command = "cat /etc/os-release; uname -r; uname -m; command -v apt-get yum dnf apk";
    const output = [OS_RELEASE, "3.10.0-1160.119.1.el7.x86_64", "x86_64", "/usr/bin/yum"].join("\n");
    const facts = extractHostFacts([{ command, output, exitCode: 0 }]);
    assert.equal(facts.kernel, "3.10.0-1160.119.1.el7.x86_64", "内核必须抽到");
    assert.equal(facts.arch, "x86_64", "架构必须抽到");
    assert.equal(facts.pkgManager, "yum", "包管理器必须抽到");
    assert.ok(facts.os?.includes("CentOS"), "发行版必须抽到");
  });

  it("command -v 输出里挑包管理器，dnf 优先于 yum", () => {
    assert.equal(parsePkgManager("/usr/bin/yum"), "yum");
    assert.equal(parsePkgManager("/usr/bin/yum\n/usr/bin/dnf"), "dnf");
    assert.equal(parsePkgManager("/usr/bin/apt-get"), "apt-get");
    assert.equal(parsePkgManager(""), "");
  });

  it("整轮命令里抽取事实（含复合探测）", () => {
    const facts = extractHostFacts([
      { command: "cat /etc/os-release", output: OS_RELEASE, exitCode: 0 },
      { command: "uname -a", output: UNAME_A, exitCode: 0 },
      { command: "command -v apt-get yum dnf apk", output: "/usr/bin/yum", exitCode: 0 },
      { command: "docker --version", output: "Docker version 20.10.17, build 100c701", exitCode: 0 },
    ]);
    assert.equal(facts.os, "CentOS Linux 7 (Core)");
    assert.equal(facts.kernel, "3.10.0-1160.119.1.el7.x86_64");
    assert.equal(facts.arch, "x86_64");
    assert.equal(facts.pkgManager, "yum");
    assert.equal(facts.container, "docker");
  });

  it("失败的命令不采信（避免把报错文本当成事实）", () => {
    const facts = extractHostFacts([
      { command: "cat /etc/os-release", output: "cat: /etc/os-release: No such file", exitCode: 1 },
      { command: "uname -m", output: "", exitCode: 1 },
    ]);
    assert.deepEqual(facts, {});
  });

  it("合并只覆盖有值的键，渲染成一行", () => {
    const merged = mergeHostFacts(
      { os: "CentOS Linux 7 (Core)", pkgManager: "yum" },
      { arch: "x86_64", os: undefined }
    );
    assert.deepEqual(merged, { os: "CentOS Linux 7 (Core)", pkgManager: "yum", arch: "x86_64" });
    const line = renderHostFacts(merged);
    assert.ok(line.includes("CentOS"));
    assert.ok(line.includes("包管理器 yum"));
    assert.ok(line.includes("x86_64"));
    assert.equal(renderHostFacts(undefined), "");
  });
});

describe("hostFacts · 探测识别与覆盖判定", () => {
  it("单一维度探测归类正确", () => {
    assert.equal(envProbeKind("cat /etc/os-release"), "os");
    assert.equal(envProbeKind("sudo cat /etc/redhat-release"), "os");
    assert.equal(envProbeKind("uname -m"), "arch");
    assert.equal(envProbeKind("uname -r"), "kernel");
    assert.equal(envProbeKind("uname -a"), "env");
    assert.equal(envProbeKind("command -v apt-get yum dnf apk"), "pkg");
  });

  it("混了真实操作的复合命令不算纯探测", () => {
    // 这条必须放行，否则 `cat /etc/os-release; systemctl restart nginx` 会被整条拦掉
    assert.equal(envProbeKind("cat /etc/os-release; systemctl restart nginx"), null);
    assert.equal(envProbeKind("cat /etc/os-release; uname -m; command -v yum"), "env");
    assert.equal(envProbeKind("df -h"), null);
    assert.equal(envProbeKind(""), null);
  });

  it("只有事实确实覆盖时才判「已确认」", () => {
    assert.equal(envProbeCoveredBy({ os: "CentOS" }, "cat /etc/os-release"), true);
    assert.equal(envProbeCoveredBy({ os: "CentOS" }, "command -v yum"), false);
    assert.equal(envProbeCoveredBy({ pkgManager: "yum" }, "uname -a"), false);
    // 复合探测要求「发行版 + 包管理器」都在，缺一个就放行让它真去探
    assert.equal(envProbeCoveredBy({ os: "CentOS" }, "cat /etc/os-release; uname -m; command -v yum"), false);
    assert.equal(
      envProbeCoveredBy(
        { os: "CentOS", pkgManager: "yum" },
        "cat /etc/os-release; uname -m; command -v yum"
      ),
      true
    );
    assert.equal(envProbeCoveredBy(undefined, "cat /etc/os-release"), false);
  });
});

describe("hostFacts · 发行版兜底推断包管理器", () => {
  it("只探到发行版时给出默认包管理器（避免凭印象用错）", () => {
    const centos = extractHostFacts([
      { command: "cat /etc/os-release", output: OS_RELEASE, exitCode: 0 },
    ]);
    assert.equal(centos.pkgManager, "yum");
    const ubuntu = extractHostFacts([
      {
        command: "cat /etc/os-release",
        output: 'NAME="Ubuntu"\nVERSION_ID="22.04"\nPRETTY_NAME="Ubuntu 22.04.4 LTS"',
        exitCode: 0,
      },
    ]);
    assert.equal(ubuntu.pkgManager, "apt");
  });

  it("真实探测结果优先于推断", () => {
    const facts = extractHostFacts([
      { command: "cat /etc/os-release", output: OS_RELEASE, exitCode: 0 },
      { command: "command -v apt-get yum dnf apk", output: "/usr/bin/dnf", exitCode: 0 },
    ]);
    assert.equal(facts.pkgManager, "dnf");
  });
});
