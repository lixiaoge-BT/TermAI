import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSocks5ConnectRequest, buildSocks5SuccessReply } from "./socks5.js";

test("解析 IPv4 CONNECT 请求", () => {
  // VER CMD RSV ATYP | 192 168 1 10 | 端口 8080(0x1F90)
  const buf = Buffer.from([0x05, 0x01, 0x00, 0x01, 192, 168, 1, 10, 0x1f, 0x90]);
  const r = parseSocks5ConnectRequest(buf);
  assert.deepEqual(r, { host: "192.168.1.10", port: 8080 });
});

test("解析域名 CONNECT 请求", () => {
  // example.com = 11 字节，端口 443(0x01BB)
  const buf = Buffer.from([
    0x05, 0x01, 0x00, 0x03,
    0x0b, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x63, 0x6f, 0x6d,
    0x01, 0xbb,
  ]);
  const r = parseSocks5ConnectRequest(buf);
  assert.deepEqual(r, { host: "example.com", port: 443 });
});

test("解析 IPv6 CONNECT 请求", () => {
  // ::1
  const addr = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
  const buf = Buffer.from([0x05, 0x01, 0x00, 0x04, ...addr, 0x00, 0x50]);
  const r = parseSocks5ConnectRequest(buf);
  assert.deepEqual(r, { host: "::1", port: 80 });
});

test("数据不完整时返回 null（继续等待）", () => {
  const buf = Buffer.from([0x05, 0x01, 0x00, 0x01, 192, 168, 1]);
  assert.equal(parseSocks5ConnectRequest(buf), null);
});

test("非 SOCKS5 版本返回 null", () => {
  const buf = Buffer.from([0x04, 0x01, 0x00, 0x01, 1, 2, 3, 4, 0, 80]);
  assert.equal(parseSocks5ConnectRequest(buf), null);
});

test("非 CONNECT 命令返回 null", () => {
  const buf = Buffer.from([0x05, 0x02, 0x00, 0x01, 1, 2, 3, 4, 0, 80]);
  assert.equal(parseSocks5ConnectRequest(buf), null);
});

test("成功应答为标准 10 字节", () => {
  const reply = buildSocks5SuccessReply();
  assert.equal(reply.length, 10);
  assert.equal(reply[0], 0x05);
  assert.equal(reply[1], 0x00);
});
