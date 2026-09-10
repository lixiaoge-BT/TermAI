import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { secureStorage, __resetReadableKeysForTest } from "./secureStorage";

/**
 * 用可控的假实现替换 localStorage / window.secureStorage。
 * throwOnGet 模拟「localStorage 被策略禁用」，throwOnSet 模拟「配额满」。
 */
function installStorage(opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {}) {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem(k: string) {
      if (opts.throwOnGet) throw new Error("localStorage is disabled");
      return store.has(k) ? (store.get(k) as string) : null;
    },
    setItem(k: string, v: string) {
      if (opts.throwOnSet) throw new Error("QuotaExceededError");
      store.set(k, v);
    },
    removeItem(k: string) {
      store.delete(k);
    },
  };
  (globalThis as unknown as { window: unknown }).window = {
    secureStorage: {
      encrypt: async (v: string) => `enc:${v}`,
      decrypt: async (v: string) => (v.startsWith("enc:") ? v.slice(4) : v),
    },
  };
  return store;
}

describe("secureStorage", () => {
  beforeEach(() => {
    __resetReadableKeysForTest();
  });

  it("存储可用时正常读写（加密后落盘）", async () => {
    const store = installStorage();
    assert.equal(await secureStorage.getItem("cfg"), null);
    await secureStorage.setItem("cfg", '{"hosts":[1]}');
    assert.equal(store.get("cfg"), 'enc:{"hosts":[1]}');
    assert.equal(await secureStorage.getItem("cfg"), '{"hosts":[1]}');
  });

  it("localStorage 不可用时：读为 null，且绝不写盘（守住磁盘上的旧配置）", async () => {
    const store = installStorage({ throwOnGet: true });
    assert.equal(await secureStorage.getItem("cfg"), null);
    // 此时 store 若仍被写入，水合失败的空状态就会把主机清单 / API Key 冲掉
    await secureStorage.setItem("cfg", '{"hosts":[]}');
    assert.equal(store.size, 0, "存储不可用时不应写入任何内容");
  });

  it("没读过的 key 不写入（避免其他 store 的水合放行误伤）", async () => {
    const store = installStorage();
    await secureStorage.getItem("storeA");
    await secureStorage.setItem("storeB", "x");
    assert.equal(store.has("storeB"), false);
    // 读过的 key 仍然照常写入
    await secureStorage.setItem("storeA", "y");
    assert.equal(store.get("storeA"), "enc:y");
  });

  it("写入抛异常（配额满）时不冒泡，避免 setState 连带炸掉 UI", async () => {
    const store = installStorage({ throwOnSet: true });
    await secureStorage.getItem("cfg");
    // setItem 的签名是 `void | Promise<void>`，这里显式包成 Promise 再交给断言
    await assert.doesNotReject(() => Promise.resolve(secureStorage.setItem("cfg", "v")));
    assert.equal(store.size, 0);
  });

  it("解密失败时退回明文内容", async () => {
    const store = installStorage();
    store.set("cfg", "plain-text");
    (globalThis as unknown as { window: { secureStorage: { decrypt: () => Promise<never> } } }).window.secureStorage.decrypt =
      () => Promise.reject(new Error("decrypt failed"));
    assert.equal(await secureStorage.getItem("cfg"), "plain-text");
  });
});
