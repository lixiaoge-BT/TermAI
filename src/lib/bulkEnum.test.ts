import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findEnumeration, skeletonOf, suggestLoopRewrite, ENUM_MIN_TARGETS } from "./bulkEnum";

const D = "/data/signature/signature";

describe("skeletonOf", () => {
  it("抹掉数字，保留其余", () => {
    assert.equal(skeletonOf("/data/x/20250801"), "/data/x/#");
    assert.equal(skeletonOf("app1 app2"), "app# app#");
  });
});

describe("findEnumeration · 单条命令里塞一排路径", () => {
  it("现场那 5 个目录被识别为枚举", () => {
    const cmd = `mkdir -p ${["20250801", "20250802", "20250803", "20250804", "20250805"]
      .map((d) => `${D}/${d}`)
      .join(" ")}`;
    const hit = findEnumeration([cmd]);
    assert.ok(hit, "必须命中");
    assert.equal(hit!.count, 5);
    assert.equal(hit!.skeleton, `${D}/#`);
    assert.equal(hit!.prefix, `${D}/`);
    assert.equal(hit!.samples[0], `${D}/20250801`);
  });

  it(`少于 ${ENUM_MIN_TARGETS} 个不算问题（手写 3 个不值得多一轮）`, () => {
    const cmd = `mkdir -p ${D}/a1 ${D}/a2 ${D}/a3`;
    assert.equal(findEnumeration([cmd]), null);
  });

  it("等宽花括号展开已经是循环写法，不能误判", () => {
    assert.equal(findEnumeration([`mkdir -p ${D}/{20250801..20250901}`]), null);
    assert.equal(findEnumeration([`mkdir -p ${D}/{01..31}`]), null);
  });

  it("不含路径的编号参数不误判（chmod 755 a b c）", () => {
    assert.equal(findEnumeration(["chmod 755 a b c"]), null);
  });

  it("只读探测里的普通多个路径不误判（没有数字序列）", () => {
    assert.equal(findEnumeration([`ls -l ${D}/out ${D}/in ${D}/tmp ${D}/var`]), null);
  });
});

describe("findEnumeration · 多条命令各来一个（多行块被拆开）", () => {
  it("4 行 mkdir 每个一个日期 → 命中", () => {
    const cmds = ["20250801", "20250802", "20250803", "20250804"].map(
      (d) => `mkdir -p ${D}/${d}`
    );
    const hit = findEnumeration(cmds);
    assert.ok(hit);
    assert.equal(hit!.count, 4);
  });

  it("3 行不命中", () => {
    const cmds = ["20250801", "20250802", "20250803"].map((d) => `mkdir -p ${D}/${d}`);
    assert.equal(findEnumeration(cmds), null);
  });

  it("不同骨架混在一起不累加（mkdir 与 touch 各 3 条）", () => {
    const cmds = [
      ...[1, 2, 3].map((i) => `mkdir -p ${D}/d${i}`),
      ...[1, 2, 3].map((i) => `touch ${D}/f${i}`),
    ];
    assert.equal(findEnumeration(cmds), null);
  });
});

describe("suggestLoopRewrite", () => {
  it("给出花括号与 date 循环两条路，且带上真实前缀", () => {
    const hit = findEnumeration([
      ["20250801", "20250802", "20250803", "20250804"].map((d) => `${D}/${d}`).join(" "),
    ]);
    assert.ok(hit);
    const s = suggestLoopRewrite(hit!);
    assert.match(s, /4 个同类目标/);
    assert.ok(s.includes(`${D}/`), "前缀要具体，模型才能直接抄");
    assert.ok(s.includes("{起始..结束}"), "连续编号给花括号写法");
    assert.ok(s.includes("date -d"), "跨月日期给 date 循环");
    assert.ok(s.includes("全部目标"), "要点明一条命令跑完所有目标");
  });
});
