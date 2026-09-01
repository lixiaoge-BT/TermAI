// 直接测试 ssh2 连接，定位失败原因
import { Client } from "ssh2";

const client = new Client();

console.log("[test] 正在连接 192.168.188.128:22 root/****** ...");

client
  .on("ready", () => {
    console.log("[test] ✅ 连接成功！ready 事件触发");
    client.shell({ term: "xterm-256color", cols: 80, rows: 24 }, (err, stream) => {
      if (err) {
        console.error("[test] ❌ shell 创建失败:", err.message);
        client.end();
        process.exit(1);
      }
      console.log("[test] ✅ shell 创建成功");
      stream.on("data", (data) => {
        process.stdout.write(data.toString("utf-8"));
      });
      stream.on("close", () => {
        console.log("\n[test] stream 已关闭");
        client.end();
        process.exit(0);
      });
      // 发送一个测试命令
      setTimeout(() => {
        stream.write("echo HELLO_FROM_SSH && whoami && exit\n");
      }, 500);
    });
  })
  .on("error", (err) => {
    console.error("[test] ❌ 连接失败:", err.message);
    console.error("[test] 错误详情:", err);
    process.exit(1);
  })
  .on("keyboard-interactive", (_name, _instructions, _lang, prompts, finish) => {
    console.log("[test] ℹ️ 服务器要求 keyboard-interactive 认证");
    console.log("[test] prompts:", JSON.stringify(prompts));
    // 回答密码
    finish(["111111"]);
  })
  .connect({
    host: "192.168.188.128",
    port: 22,
    username: "root",
    password: "111111",
    readyTimeout: 15000,
    tryKeyboard: true, // 尝试 keyboard-interactive 回退
    algorithms: {
      kex: [
        "ecdh-sha2-nistp256",
        "ecdh-sha2-nistp384",
        "ecdh-sha2-nistp521",
        "diffie-hellman-group-exchange-sha256",
        "diffie-hellman-group14-sha256",
        "diffie-hellman-group14-sha1",
        "diffie-hellman-group1-sha1",
      ],
      serverHostKey: [
        "ssh-ed25519",
        "ecdsa-sha2-nistp256",
        "ecdsa-sha2-nistp384",
        "ecdsa-sha2-nistp521",
        "ssh-rsa",
        "ssh-dss",
        "rsa-sha2-256",
        "rsa-sha2-512",
      ],
      cipher: [
        "aes128-ctr",
        "aes192-ctr",
        "aes256-ctr",
        "aes128-gcm",
        "aes128-gcm@openssh.com",
        "aes256-gcm",
        "aes256-gcm@openssh.com",
        "aes256-cbc",
        "aes192-cbc",
        "aes128-cbc",
        "3des-cbc",
      ],
      hmac: [
        "hmac-sha2-256",
        "hmac-sha2-512",
        "hmac-sha1",
        "hmac-md5",
        "hmac-sha2-256-etm@openssh.com",
        "hmac-sha2-512-etm@openssh.com",
      ],
    },
  });
