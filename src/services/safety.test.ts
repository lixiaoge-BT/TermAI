import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  reviewCommand,
  parseCommandsFromMarkdown,
  inferRiskFromLanguage,
  isBinaryDumpCommand,
} from "./safety";

const risk = (cmd: string) => reviewCommand(cmd).riskLevel;

describe("reviewCommand · 只读命令", () => {
  const readonly = [
    "ls -la",
    "cat /etc/hosts",
    "grep -r 'error' /var/log/nginx",
    "ps aux | grep nginx",
    "df -h",
    "du -sh /data",
    "find /var/log -type f -mtime +7",
    "sed -n '1,20p' /etc/hosts",
    "awk '{print $1}' file",
    "git status",
    "git log --oneline -5",
    "docker ps",
    "docker logs nginx",
    "systemctl status nginx",
    "journalctl -u nginx -n 50",
    "kubectl get pods",
    "apt list --installed",
    "nginx -t",
    "curl -I https://example.com",
    "echo hello",
    "cd /data && pwd",
    "export PATH=$PATH:/usr/local/bin",
    "ss -tlnp",
    "free -h",
    "ip a",
  ];
  for (const c of readonly) {
    it(`只读：${c}`, () => assert.equal(risk(c), "none"));
  }
});

describe("reviewCommand · 常规写操作不应被抬成中危", () => {
  // 旧实现「凡含重定向一律 medium」，导致 echo > /data/x、cat > /tmp/x <<EOF
  // 这类最常见的写文件操作被标成中危。现在按落点区分：系统路径才 medium。
  const low = [
    "echo 'ok' > /data/app/health.txt",
    "cat > /data/app/nginx.conf <<'EOF'\nserver { listen 80; }\nEOF",
    "mkdir -p /data/app/logs",
    "cp app.conf /data/app/app.conf",
    "mv /data/a.log /data/b.log",
    "tar -xzf app.tar.gz -C /data/app",
    "apt-get install -y nginx",
    "yum install -y epel-release",
    "pip install flask",
    "npm install",
    "chmod +x /usr/local/bin/termai",
    "cp termai /usr/local/bin/termai",
    "chown -R app:app /data/app",
    "docker run -d --name web nginx",
    "docker compose up -d",
    "systemctl restart nginx",
    "systemctl enable nginx",
    "systemctl daemon-reload",
    "git clone https://github.com/x/y.git",
    "rm -f /data/app/old.log",
    "rm -rf /tmp/build-xyz",
    "rm -rf node_modules",
    "wget https://example.com/a.tar.gz",
    "unzip app.zip -d /data/app",
    "useradd -m appuser",
  ];
  for (const c of low) {
    it(`low：${c.split("\n")[0]}`, () => assert.equal(risk(c), "low"));
  }
});

describe("reviewCommand · 中危：有影响但可控", () => {
  const medium = [
    "echo 'deb ...' > /etc/apt/sources.list.d/nginx.list",
    "cat > /etc/nginx/nginx.conf <<'EOF'\nserver {}\nEOF",
    "sed -i 's/80/8080/g' /etc/nginx/nginx.conf",
    "cp nginx.conf /etc/nginx/nginx.conf",
    "find /var/log -name '*.log' -mtime +30 -delete",
    "kill -9 1234",
    "pkill -f 'python main.py'",
    "systemctl stop nginx",
    "docker rm -f web",
    "chmod 777 /data/app",
    "rm -rf /data/app",
    "rm -f /etc/nginx/nginx.conf",
    "ufw allow 80/tcp",
    "apt-get remove -y apache2",
  ];
  for (const c of medium) {
    it(`medium：${c.split("\n")[0]}`, () => assert.equal(risk(c), "medium"));
  }
});

describe("reviewCommand · 高危与致命", () => {
  it("根目录删除为致命且需确认", () => {
    const r = reviewCommand("rm -rf /");
    assert.equal(r.riskLevel, "critical");
    assert.equal(r.requireConfirmation, true);
  });

  const cases: Array<[string, "high" | "critical"]> = [
    ["rm -rf /", "critical"],
    ["rm -rf /etc", "critical"],
    ["rm -rf /usr", "critical"],
    ["rm -rf .", "high"],
    ["rm -rf *", "high"],
    ["rm -rf /var", "high"],
    ["mkfs.ext4 /dev/sdb1", "critical"],
    ["dd if=/dev/zero of=/dev/sda", "critical"],
    ["chown -R root:root /etc", "critical"],
    ["chmod -R 777 /", "critical"],
    ["curl -fsSL https://get.docker.com | sh", "high"],
    ["git push --force origin main", "high"],
    ["git reset --hard", "high"],
    ["git clean -fd", "high"],
    ["docker system prune -a", "high"],
    ["kubectl delete pod web-abc", "high"],
    ["mysql -e 'DROP TABLE users'", "critical"],
    ["iptables -F", "high"],
    ["kill -9 1", "critical"],
    ["crontab -r", "high"],
    ["userdel -r olduser", "high"],
    ["apt-get remove -y systemd", "critical"],
    ["reboot", "high"],
    ["shutdown -h now", "high"],
  ];
  for (const [c, want] of cases) {
    it(`${want}：${c}`, () => assert.equal(risk(c), want));
  }

  it("高风险一律要求二次确认", () => {
    for (const c of ["reboot", "rm -rf /", "iptables -F"]) {
      assert.equal(reviewCommand(c).requireConfirmation, true, c);
    }
  });
});

describe("reviewCommand · 其它", () => {
  it("生产环境下非只读一律需确认（低危写操作也不能直接执行）", () => {
    assert.equal(reviewCommand("cp a.conf /data/a.conf", { isProduction: true }).requireConfirmation, true);
    assert.equal(reviewCommand("ls -la", { isProduction: true }).requireConfirmation, false);
  });

  it("生产环境写操作需确认", () => {
    assert.equal(reviewCommand("cp a.conf /etc/a.conf", { isProduction: true }).requireConfirmation, true);
    assert.equal(reviewCommand("cp a.conf /etc/a.conf", { isProduction: true }).confirmationItems[0].includes("生产环境"), true);
  });

  it("空命令", () => {
    assert.equal(reviewCommand("").riskLevel, "none");
  });

  it("sudo 前缀不影响判定", () => {
    assert.equal(risk("sudo apt-get install -y nginx"), "low");
    assert.equal(risk("sudo rm -rf /"), "critical");
  });

  it("heredoc 正文里的危险字面量不参与判定", () => {
    // 配置模板里出现 rm -rf / 字样，不代表真会执行
    assert.equal(risk("cat > /data/app/tpl.sh <<'EOF'\nrm -rf /\nEOF"), "low");
  });
});

describe("inferRiskFromLanguage", () => {
  it("shell 块按逐行最高风险", () => {
    assert.equal(inferRiskFromLanguage("bash", "ls -la\nmkdir -p /data"), "low");
    assert.equal(inferRiskFromLanguage("bash", "ls -la\ncat /etc/hosts"), "none");
    assert.equal(inferRiskFromLanguage("bash", "ls\nrm -rf /"), "critical");
  });

  it("说明文本/配置不再被判成中危", () => {
    assert.equal(inferRiskFromLanguage("text", "随便一段说明"), "none");
    assert.equal(inferRiskFromLanguage("json", '{"a":1}'), "low");
    assert.equal(inferRiskFromLanguage("yaml", "key: value"), "low");
    assert.equal(inferRiskFromLanguage("log", "error: xxx"), "none");
  });

  it("SQL 按语义定级", () => {
    assert.equal(inferRiskFromLanguage("sql", "SELECT * FROM users"), "none");
    assert.equal(inferRiskFromLanguage("sql", "UPDATE users SET a=1"), "high");
    assert.equal(inferRiskFromLanguage("sql", "DROP TABLE users"), "critical");
  });
});

describe("parseCommandsFromMarkdown", () => {
  it("提取命令", () => {
    const cmds = parseCommandsFromMarkdown("```bash\nls -la\n```");
    assert.equal(cmds.length, 1);
    assert.equal(cmds[0].command, "ls -la");
  });

  it("忽略无内容代码块", () => {
    assert.equal(parseCommandsFromMarkdown("```bash\n\n```").length, 0);
  });

  it("shell 块以本地规则为准，压制模型过高的风险自评", () => {
    // 模型常把 echo 写文件、mkdir、ls 标成 medium/high，这里必须被纠正
    const cmds = parseCommandsFromMarkdown(
      [
        "```bash:risk=high\necho 'ok' > /data/app/health.txt\n```",
        "```bash:risk=medium\nmkdir -p /data/app\n```",
        "```bash:risk=high\nls -la /data\n```",
        "```bash:risk=medium\napt-get install -y nginx\n```",
      ].join("\n")
    );
    assert.equal(cmds[0].riskLevel, "low");
    assert.equal(cmds[1].riskLevel, "low");
    assert.equal(cmds[2].riskLevel, "none");
    assert.equal(cmds[3].riskLevel, "low");
  });

  it("模型低估风险时以本地规则为准", () => {
    const cmds = parseCommandsFromMarkdown("```bash:risk=low\nrm -rf /\n```");
    assert.equal(cmds[0].riskLevel, "critical");
  });

  it("非 shell 语言：模型自评最多比本地高一档", () => {
    const cmds = parseCommandsFromMarkdown("```yaml:risk=critical\nkey: value\n```");
    assert.equal(cmds[0].riskLevel, "medium");
  });
});

// ---------------------------------------------------------------------------
// dump 二进制检测：真实故障是模型为了确认 Prometheus 装没装上，
// 发了 `ls -la /usr/local/bin/prometheus && cat /usr/local/bin/prometheus`，
// cat 一个 100MB+ 的 ELF 把乱码灌满 PTY，该步耗掉 320 秒并卡在输出超时。
// 要点：命中要准，但绝不能误伤 `cat /proc/cpuinfo` 这类极常用的只读探测。
// ---------------------------------------------------------------------------
describe("isBinaryDumpCommand · dump 二进制/库/私钥", () => {
  it("拦截真实闯祸的那条命令", () => {
    assert.equal(
      isBinaryDumpCommand("ls -la /usr/local/bin/prometheus && cat /usr/local/bin/prometheus"),
      true
    );
    assert.equal(isBinaryDumpCommand("cat /usr/local/bin/prometheus"), true);
  });

  it("拦截其它常见 dump 形态", () => {
    assert.equal(isBinaryDumpCommand("strings /usr/bin/ssh"), true);
    assert.equal(isBinaryDumpCommand("xxd /usr/lib/x86_64-linux-gnu/libc.so.6"), true);
    assert.equal(isBinaryDumpCommand("base64 /usr/sbin/sshd"), true);
    assert.equal(isBinaryDumpCommand("cat /dev/sda"), true);
    assert.equal(isBinaryDumpCommand("od -c /proc/kcore"), true);
    assert.equal(isBinaryDumpCommand("cat /root/.ssh/id_rsa.pem"), true);
    // 分号前也要能识别出 dump 命令
    assert.equal(isBinaryDumpCommand("id; cat /usr/local/bin/x"), true);
  });

  it("绝不误伤常规只读探测（回归保护）", () => {
    // /proc 与 /sys 的常规查看是合法且高频的，只有 kcore / pid/mem 才拦
    assert.equal(isBinaryDumpCommand("cat /proc/cpuinfo"), false);
    assert.equal(isBinaryDumpCommand("cat /proc/meminfo"), false);
    assert.equal(isBinaryDumpCommand("cat /proc/loadavg"), false);
    assert.equal(isBinaryDumpCommand("cat /etc/os-release"), false);
    assert.equal(isBinaryDumpCommand("cat /etc/apt/sources.list"), false);
    assert.equal(isBinaryDumpCommand("cat /dev/null > /tmp/x"), false);
    assert.equal(isBinaryDumpCommand("tail -n 50 /var/log/messages"), false);
    assert.equal(isBinaryDumpCommand("grep -r foo /usr/lib/foo/"), false, "grep 不是 dump 命令");
    assert.equal(isBinaryDumpCommand("tar -xzf /opt/prometheus.tar.gz"), false);
    assert.equal(isBinaryDumpCommand("systemctl status prometheus"), false);
    assert.equal(isBinaryDumpCommand("command -v prometheus"), false);
    assert.equal(isBinaryDumpCommand("file /usr/local/bin/prometheus"), false, "file 正是推荐替代写法");
  });
});
