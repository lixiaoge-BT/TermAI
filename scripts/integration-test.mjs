// 集成测试：模拟应用层 createSshManager 的完整生命周期
// 复制 ssh.ts 的核心逻辑运行在 Node 中，与应用中完全一致
import { Client } from "ssh2";
import { EventEmitter } from "node:events";

let nextId = 0;
function genId() {
  nextId++;
  return `sess_test_${Date.now()}_${nextId}`;
}

// 模拟 BrowserWindow 的 webContents.send（换成 console 记录）
const receivedEvents = [];
const mockWin = {
  isDestroyed: () => false,
  webContents: {
    send: (channel, ...args) => {
      receivedEvents.push({ channel, args, ts: Date.now() });
      const ts = new Date().toLocaleTimeString();
      const pretty = args.map((a) => {
        try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); }
      }).join(", ");
      console.log(`  [ipc] ${ts} ${channel} → ${pretty}`);
    },
  },
};

// 复制 createSshManager（来自 electron/main/ssh.ts）
function createSshManager(win) {
  const sessions = new Map();

  const emit = (channel, ...args) => {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args);
    }
  };

  const connect = async (sessionId, params) => {
    return new Promise((resolve, reject) => {
      const client = new Client();
      const emitter = new EventEmitter();

      const session = {
        id: sessionId,
        client,
        emitter,
        info: {
          id: sessionId,
          host: params.host,
          username: params.username,
          connected: false,
          startTime: Date.now(),
        },
      };
      sessions.set(sessionId, session);

      const config = {
        host: params.host,
        port: params.port,
        username: params.username,
        readyTimeout: 15000,
        keepaliveInterval: 30000,
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
            "aes128-ctr", "aes192-ctr", "aes256-ctr",
            "aes128-gcm", "aes128-gcm@openssh.com",
            "aes256-gcm", "aes256-gcm@openssh.com",
            "aes256-cbc", "aes192-cbc", "aes128-cbc", "3des-cbc",
          ],
          hmac: [
            "hmac-sha2-256", "hmac-sha2-512", "hmac-sha1", "hmac-md5",
            "hmac-sha2-256-etm@openssh.com", "hmac-sha2-512-etm@openssh.com",
          ],
        },
      };

      if (params.privateKey) {
        config.privateKey = params.privateKey;
        if (params.passphrase) config.passphrase = params.passphrase;
      } else if (params.password) {
        config.password = params.password;
        config.tryKeyboard = true;
      }

      client
        .on("ready", () => {
          console.log(`  [ssh ${sessionId}] ready → 创建 shell`);
          session.info.connected = true;
          emit("ssh:status", sessionId, "connected");

          client.shell(
            { term: "xterm-256color", cols: 80, rows: 24 },
            (err, stream) => {
              if (err) { reject(err); return; }
              session.stream = stream;

              stream
                .on("data", (data) => {
                  emit("ssh:data", sessionId, data.toString("utf-8"));
                })
                .on("close", () => {
                  emit("ssh:status", sessionId, "closed");
                  session.info.connected = false;
                })
                .on("exit", (code) => {
                  emit("ssh:status", sessionId, "exit", code);
                })
                .stderr.on("data", (data) => {
                  emit("ssh:data", sessionId, data.toString("utf-8"));
                });

              resolve(true);
            }
          );
        })
        .on("keyboard-interactive", (_n, _i, _l, prompts, finish) => {
          console.log(`  [ssh ${sessionId}] keyboard-interactive: prompts=${JSON.stringify(prompts)}`);
          finish([params.password || ""]);
        })
        .on("error", (err) => {
          emit("ssh:status", sessionId, "error", err.message);
          sessions.delete(sessionId);
          reject(err);
        })
        .on("end", () => {
          session.info.connected = false;
          emit("ssh:status", sessionId, "end");
        })
        .on("close", () => {
          session.info.connected = false;
          emit("ssh:status", sessionId, "close");
          sessions.delete(sessionId);
        })
        .connect(config);
    });
  };

  const write = (sessionId, data) => {
    const session = sessions.get(sessionId);
    if (!session || !session.stream) return false;
    session.stream.write(data);
    return true;
  };

  const resize = (sessionId, cols, rows) => {
    const session = sessions.get(sessionId);
    if (!session || !session.stream) return false;
    try { session.stream.setWindow(rows, cols, 800, 600); return true; }
    catch { return false; }
  };

  const disconnect = (sessionId) => {
    const session = sessions.get(sessionId);
    if (!session) return false;
    try { if (session.stream) session.stream.end(); session.client.end(); } catch {}
    sessions.delete(sessionId);
    return true;
  };

  const listSessions = () => Array.from(sessions.values()).map((s) => ({ ...s.info }));
  const disposeAll = () => {
    for (const [id, session] of sessions) {
      try { if (session.stream) session.stream.end(); session.client.end(); } catch {}
    }
    sessions.clear();
  };

  return { connect, disconnect, write, resize, listSessions, disposeAll };
}

// ========== 测试流程 ==========
const manager = createSshManager(mockWin);
const sessionId = genId();
const params = {
  host: "192.168.188.128",
  port: 22,
  username: "root",
  password: "111111",
};

console.log("=" + "=".repeat(60));
console.log("  TermAI SSH 集成测试");
console.log("=" + "=".repeat(60));
console.log(`\n[1/5] 创建会话 ${sessionId} 并连接到 ${params.username}@${params.host}:${params.port}`);

let collectedOutput = "";

// 监听 IPC 事件收集输出
const startTs = Date.now();
const origSend = mockWin.webContents.send.bind(mockWin.webContents);
mockWin.webContents.send = (channel, ...args) => {
  origSend(channel, ...args);
  if (channel === "ssh:data") {
    collectedOutput += args[1];
  }
};

try {
  const ok = await manager.connect(sessionId, params);
  console.log(`\n[2/5] connect 返回: ${ok}`);

  if (!ok) {
    console.error("  ❌ 连接失败（resolve false）");
    process.exit(1);
  }

  // 等待 banner 和 prompt
  console.log("\n[3/5] 等待 shell 提示符...");
  await new Promise((r) => setTimeout(r, 800));

  const testCmd = "echo '=== TERMAI_TEST_123 ===' && whoami && hostname && pwd && echo DONE\n";
  console.log(`\n[4/5] 发送测试命令: echo HELLO + whoami + hostname + pwd`);
  const wrote = manager.write(sessionId, testCmd);
  console.log(`  write 返回: ${wrote}`);

  // 等待命令执行完成
  await new Promise((r) => setTimeout(r, 1500));

  console.log("\n[5/5] 断言结果 & 断开连接");

  const checks = [
    ["TERMAI_TEST_123 标记", collectedOutput.includes("TERMAI_TEST_123")],
    ["whoami = root",       /root\s*$/m.test(collectedOutput) || /\nroot\n/.test(collectedOutput) || collectedOutput.includes("\nroot")],
    ["hostname 存在",       collectedOutput.match(/\r?\n\w+\r?\n/) !== null],
    ["pwd 存在",            collectedOutput.includes("/") && collectedOutput.includes("\n/")],
    ["DONE 标记",           collectedOutput.includes("DONE")],
    ["connected 事件触发",  receivedEvents.some(e => e.channel === "ssh:status" && e.args[1] === "connected")],
    ["ssh:data 事件触发",   receivedEvents.some(e => e.channel === "ssh:data")],
  ];

  console.log("");
  let allPassed = true;
  for (const [name, passed] of checks) {
    const mark = passed ? "✅" : "❌";
    console.log(`  ${mark} ${name}`);
    if (!passed) allPassed = false;
  }

  console.log("");
  console.log(`  耗时: ${Date.now() - startTs}ms`);
  console.log(`  接收 IPC 事件总数: ${receivedEvents.length}`);
  console.log(`  收集终端输出 (${collectedOutput.length} bytes):`);
  console.log("  " + "-".repeat(60));
  for (const line of collectedOutput.slice(-2000).split("\n")) {
    console.log("  | " + line.replace(/\s+$/,""));
  }
  console.log("  " + "-".repeat(60));

  manager.disconnect(sessionId);
  console.log("\n已断开连接。");

  console.log("");
  if (allPassed) {
    console.log("🎉 所有断言通过！SSH Manager 集成测试成功 ✅");
    process.exit(0);
  } else {
    console.error("💥 部分断言失败，请检查上方输出 ❌");
    process.exit(1);
  }
} catch (e) {
  console.error("\n💥 测试异常:", e.message);
  console.error(e.stack);
  manager.disposeAll();
  process.exit(1);
}
