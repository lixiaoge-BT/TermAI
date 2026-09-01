import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHostsBackup, validateHost } from "./configImport";

describe("configImport", () => {
  describe("validateHost", () => {
    it("接受合法主机对象并补默认值", () => {
      const h = validateHost({
        id: "h1",
        name: "web",
        host: "10.0.0.1",
        port: 22,
        username: "root",
        authMethod: "password",
        password: "secret",
      });
      assert.ok(h);
      assert.equal(h!.id, "h1");
      assert.equal(h!.port, 22);
      assert.equal(h!.authMethod, "password");
      assert.equal(h!.password, "secret");
      assert.equal(h!.tags!.length, 0);
    });

    it("缺失必填字段返回 null", () => {
      assert.equal(validateHost({ name: "x", host: "1.1.1.1" }), null);
      assert.equal(validateHost(null), null);
      assert.equal(validateHost("nope"), null);
      assert.equal(validateHost({ id: "", name: "x", host: "1.1.1.1" }), null);
    });

    it("非法 authMethod 返回 null", () => {
      assert.equal(
        validateHost({ id: "a", name: "b", host: "c", authMethod: "oauth" }),
        null
      );
    });

    it("authMethod 缺省回退为 password", () => {
      const h = validateHost({ id: "a", name: "b", host: "c" });
      assert.equal(h!.authMethod, "password");
    });
  });

  describe("parseHostsBackup", () => {
    it("解析合法备份并跳过非法主机", () => {
      const json = JSON.stringify({
        version: 1,
        exportedAt: 123,
        hosts: [
          { id: "h1", name: "a", host: "1.1.1.1" },
          { id: "bad" }, // 缺 name/host
          { name: "nohost" }, // 缺 id
        ],
        hostGroups: ["prod", "test"],
      });
      const res = parseHostsBackup(json);
      assert.equal(res.hosts.length, 1);
      assert.equal(res.hosts[0].id, "h1");
      assert.deepEqual(res.hostGroups, ["prod", "test"]);
      assert.equal(res.exportedAt, 123);
    });

    it("非 JSON 抛出错误", () => {
      assert.throws(() => parseHostsBackup("not json"), /JSON/);
    });

    it("缺少 hosts 数组抛出错误", () => {
      assert.throws(() => parseHostsBackup(JSON.stringify({ foo: 1 })), /hosts/);
    });

    it("保留 forwards 与 proxyJumpHostId", () => {
      const json = JSON.stringify({
        version: 1,
        hosts: [
          {
            id: "h1",
            name: "a",
            host: "1.1.1.1",
            forwards: [{ type: "local", localPort: 8080, remoteHost: "127.0.0.1", remotePort: 80, enabled: true }],
            proxyJumpHostId: "jump1",
          },
        ],
        hostGroups: [],
      });
      const res = parseHostsBackup(json);
      assert.equal(res.hosts[0].proxyJumpHostId, "jump1");
      assert.equal(res.hosts[0].forwards!.length, 1);
    });
  });
});
