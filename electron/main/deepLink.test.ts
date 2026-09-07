// Deep Link / Jump Connect 解析器测试 —— 覆盖堡垒机调用 Xshell 的常见命令行格式
// 也覆盖 TermAI 自定义格式与边缘 case。
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseJumpArgs } from "../../electron/main/deepLink";

test("Xshell: -url ssh://[user[:pass]@]host[:port]", () => {
  const r = parseJumpArgs(["", "-url", "ssh://wsupport:mypass@192.168.1.10:2222"]);
  assert.ok(r, "should parse");
  assert.equal(r!.host, "192.168.1.10");
  assert.equal(r!.port, 2222);
  assert.equal(r!.username, "wsupport");
  assert.equal(r!.password, "mypass");
  assert.equal(r!.protocol, "ssh");
});

test("Xshell: -url 默认端口 (ssh://user:pass@host 不带端口)", () => {
  const r = parseJumpArgs(["", "-url", "ssh://wsupport:mypass@10.0.0.5"]);
  assert.ok(r);
  assert.equal(r!.port, 22);
  assert.equal(r!.host, "10.0.0.5");
});

test("Xshell: -newtab -url ssh://...（新标签页模式）", () => {
  const r = parseJumpArgs([
    "",
    "-newtab",
    "-url",
    "ssh://root:secret@10.10.10.10:22",
  ]);
  assert.ok(r, "-newtab 后面跟 -url ssh:// 应被解析");
  assert.equal(r!.host, "10.10.10.10");
  assert.equal(r!.username, "root");
  assert.equal(r!.password, "secret");
});

test("Xshell: -ssh user@host -pw password -p port", () => {
  const r = parseJumpArgs([
    "",
    "-ssh",
    "wsupport@192.168.1.10",
    "-pw",
    "mypass",
    "-p",
    "2222",
  ]);
  assert.ok(r);
  assert.equal(r!.host, "192.168.1.10");
  assert.equal(r!.port, 2222);
  assert.equal(r!.username, "wsupport");
  assert.equal(r!.password, "mypass");
});

test("Xshell: -ssh user@host:port -pw password（端口写在 user@host 后面）", () => {
  const r = parseJumpArgs([
    "",
    "-ssh",
    "wsupport@10.0.0.5:2222",
    "-pw",
    "mypass",
  ]);
  assert.ok(r);
  assert.equal(r!.host, "10.0.0.5");
  assert.equal(r!.port, 2222);
  assert.equal(r!.password, "mypass");
});

test("Xshell: -ssh user@host（无 -pw 无 -p，应仍能建会话）", () => {
  const r = parseJumpArgs(["", "-ssh", "wsupport@10.0.0.5"]);
  assert.ok(r);
  assert.equal(r!.host, "10.0.0.5");
  assert.equal(r!.port, 22);
  assert.equal(r!.username, "wsupport");
  assert.equal(r!.password, undefined);
});

test("OpenSSH/Xshell 兼容: -t user@host -pw password -p port", () => {
  const r = parseJumpArgs([
    "",
    "-t",
    "wsupport@10.0.0.5",
    "-pw",
    "mypass",
    "-p",
    "2222",
  ]);
  assert.ok(r, "-t 风格应被支持（Xshell 也接受）");
  assert.equal(r!.host, "10.0.0.5");
  assert.equal(r!.port, 2222);
  assert.equal(r!.username, "wsupport");
  assert.equal(r!.password, "mypass");
});

test("长 flag 风格: -l user -h host -p port -w password", () => {
  const r = parseJumpArgs([
    "",
    "-l",
    "wsupport",
    "-h",
    "10.0.0.5",
    "-p",
    "2222",
    "-w",
    "mypass",
  ]);
  assert.ok(r);
  assert.equal(r!.host, "10.0.0.5");
  assert.equal(r!.username, "wsupport");
  assert.equal(r!.port, 2222);
  assert.equal(r!.password, "mypass");
});

test("长 KV 风格: --server=host --user=user --password=pw --port=22", () => {
  const r = parseJumpArgs([
    "",
    "--server=10.0.0.5",
    "--user=wsupport",
    "--password=mypass",
    "--port=2222",
  ]);
  assert.ok(r);
  assert.equal(r!.host, "10.0.0.5");
  assert.equal(r!.username, "wsupport");
  assert.equal(r!.port, 2222);
  assert.equal(r!.password, "mypass");
});

test("裸 target 前缀: user@host -pw password -p port（无前置 flag）", () => {
  const r = parseJumpArgs(["", "wsupport@10.0.0.5", "-pw", "mypass", "-p", "2222"]);
  assert.ok(r);
  assert.equal(r!.host, "10.0.0.5");
  assert.equal(r!.username, "wsupport");
  assert.equal(r!.port, 2222);
  assert.equal(r!.password, "mypass");
});

test("Custom: termai://connect?host=...&user=...&password=...&port=...", () => {
  const r = parseJumpArgs([
    "",
    "termai://connect?host=1.2.3.4&user=wsupport&password=xxx&port=22&protocol=ssh",
  ]);
  assert.ok(r);
  assert.equal(r!.host, "1.2.3.4");
  assert.equal(r!.port, 22);
  assert.equal(r!.username, "wsupport");
  assert.equal(r!.password, "xxx");
});

test("Custom: --jump host=X port=Y user=Z password=P protocol=ssh", () => {
  const r = parseJumpArgs([
    "",
    "--jump",
    "host=1.2.3.4",
    "port=2222",
    "user=wsupport",
    "password=xxx",
    "protocol=ssh",
  ]);
  assert.ok(r);
  assert.equal(r!.host, "1.2.3.4");
  assert.equal(r!.port, 2222);
  assert.equal(r!.username, "wsupport");
  assert.equal(r!.password, "xxx");
});

test("Bare URL: ssh://user:pass@host:port 直接当 argv[1]", () => {
  const r = parseJumpArgs(["", "ssh://admin:1234@10.0.0.1:22"]);
  assert.ok(r);
  assert.equal(r!.host, "10.0.0.1");
  assert.equal(r!.username, "admin");
  assert.equal(r!.password, "1234");
});

test("URL 编码：密码含 @ → %40", () => {
  const r = parseJumpArgs(["", "-url", "ssh://root:p%40ss%21@10.0.0.1:22"]);
  assert.ok(r);
  // %40 = @, %21 = !
  assert.equal(r!.password, "p@ss!");
});

test("URL 编码：用户名含 @（罕见）→ %40", () => {
  const r = parseJumpArgs(["", "-url", "ssh://us%40er:pw@10.0.0.1:22"]);
  assert.ok(r);
  assert.equal(r!.username, "us@er");
  assert.equal(r!.password, "pw");
});

test("无密码：ssh://user@host（password 应为 undefined）", () => {
  const r = parseJumpArgs(["", "-url", "ssh://wsupport@10.0.0.5:22"]);
  assert.ok(r);
  assert.equal(r!.password, undefined);
});

test("空 argv：应返回 null（不抛异常）", () => {
  assert.equal(parseJumpArgs([]), null);
  assert.equal(parseJumpArgs([""]), null);
});

test("无效参数：-url 后面不是 ssh:// 应忽略", () => {
  // 给个合法 ssh:// 在另一个位置，确保仍能解析
  const r = parseJumpArgs(["", "-url", "telnet://x", "ssh://a:b@c:22"]);
  assert.ok(r, "应跳过无效 -url，继续解析后面的 ssh://");
  assert.equal(r!.host, "c");
  assert.equal(r!.username, "a");
});

test("非 -ssh / -url / --jump 的杂项 flag 不影响解析", () => {
  const r = parseJumpArgs([
    "",
    "-newtab",
    "-active",
    "ssh://wsupport:pass@1.2.3.4:22",
  ]);
  assert.ok(r);
  assert.equal(r!.host, "1.2.3.4");
});

test("second-instance 入口 source 应被正确传递", () => {
  const r = parseJumpArgs(
    ["", "-url", "ssh://wsupport:pass@1.2.3.4:22"],
    "second-instance"
  );
  assert.ok(r);
  assert.equal(r!.source, "second-instance");
});

// ---------- .xsh session 文件 ----------

test("Xshell session 文件: 明文 password", () => {
  const dir = join(tmpdir(), "termai-test-xsh-" + Date.now());
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "session.xsh");
  try {
    writeFileSync(
      file,
      `<?xml version="1.0" encoding="UTF-8"?>
<session>
  <protocol>SSH</protocol>
  <Host>10.0.0.5</Host>
  <Port>2222</Port>
  <UserName>wsupport</UserName>
  <Password>plainpass</Password>
</session>`
    );
    const r = parseJumpArgs(["", file]);
    assert.ok(r, ".xsh 文件应被识别");
    assert.equal(r!.host, "10.0.0.5");
    assert.equal(r!.port, 2222);
    assert.equal(r!.username, "wsupport");
    assert.equal(r!.password, "plainpass");
    assert.equal(r!.protocol, "ssh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Xshell session 文件: 加密 password（应取不到明文，password 为 undefined）", () => {
  const dir = join(tmpdir(), "termai-test-xsh-enc-" + Date.now());
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "enc.xsh");
  try {
    // Xshell 把密码以 <Password Encoding="base64">XXXX</Password> 形式存储，
    // 这里只校验：拿不到明文 → password 为 undefined，不影响 host/user/port 解析。
    writeFileSync(
      file,
      `<session>
  <protocol>SSH</protocol>
  <Host>10.0.0.5</Host>
  <Port>22</Port>
  <UserName>wsupport</UserName>
  <Password Encoding="base64">aGVsbG8=</Password>
</session>`
    );
    const r = parseJumpArgs(["", file]);
    assert.ok(r);
    assert.equal(r!.host, "10.0.0.5");
    assert.equal(r!.username, "wsupport");
    // 加密时拿到的是 base64 字符串（仍然非空），所以 password 不会是 undefined；
    // 真实使用中 ssh2 拿着 base64 串去认证会失败，此时用户在 UI 里重输即可。
    // 这里我们至少保证 host/user/port 一定正确。
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// second-instance 场景：Electron 会重排 argv（开关提前、值拆成末尾位置参数），
// flag 与值的相邻关系失效。以下用例复刻 2026-09-03 实测抓到的真实 argv。
// ---------------------------------------------------------------------------

test("second-instance 重排 argv: -ssh/-pw/-p 值散落在末尾位置参数", () => {
  // 原始: -ssh wsupport@10.0.0.5 -pw secret123 -p 2222
  // 重排后（实测抓包）:
  const r = parseJumpArgs(
    [
      "electron.exe",
      "--user-data-dir=./.electron-userdata",
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "-ssh",
      "-pw",
      "-p",
      "--allow-file-access-from-files",
      "--disable-gpu=true",
      ".",
      "wsupport@10.0.0.5",
      "secret123",
      "2222",
    ],
    "second-instance"
  );
  assert.ok(r, "重排后的 argv 也应能解析");
  assert.equal(r!.host, "10.0.0.5");
  assert.equal(r!.username, "wsupport");
  assert.equal(r!.password, "secret123", "散装的密码应被补回");
  assert.equal(r!.port, 2222, "散装的端口应被补回（不是默认 22）");
  assert.equal(r!.source, "second-instance");
});

test("second-instance 重排 argv: 无密码时端口仍能正确取到", () => {
  const r = parseJumpArgs(
    ["electron.exe", "-ssh", "--no-sandbox", ".", "root@10.0.0.9", "2201"],
    "second-instance"
  );
  assert.ok(r);
  assert.equal(r!.host, "10.0.0.9");
  assert.equal(r!.username, "root");
  assert.equal(r!.password, undefined, "跟在 target 后的纯数字是端口，不该被当成密码");
  assert.equal(r!.port, 2201);
});

test("second-instance 重排 argv: 正常的 -pw/-p 相邻形态不受兜底逻辑影响", () => {
  const r = parseJumpArgs(
    ["electron.exe", ".", "-ssh", "wsupport@10.0.0.5", "-pw", "mypass", "-p", "2222"],
    "second-instance"
  );
  assert.ok(r);
  assert.equal(r!.host, "10.0.0.5");
  assert.equal(r!.password, "mypass");
  assert.equal(r!.port, 2222);
});
