import os, re, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_DIRS = ["src", "electron"]
EXT_EXT = (".ts", ".tsx")
ALIASES = {"@": "src"}

# 入口点：不被任何模块 import，但被外部配置/构建脚本引用
ENTRY_POINTS = {
    os.path.join("src", "main.tsx"),      # index.html 的 <script type="module" src="/src/main.tsx">
    os.path.join("electron", "main", "index.ts"),   # package.json main
    os.path.join("electron", "preload", "index.ts"),
}

# 测试文件由 scripts/run-tests.mjs 按 glob 收集，不算「未使用」
def is_test(rel):
    return ".test." in rel or ".spec." in rel


def collect_source():
    files = []
    for d in SRC_DIRS:
        base = os.path.join(ROOT, d)
        for dp, dns, fns in os.walk(base):
            for fn in fns:
                if fn.endswith(EXT_EXT):
                    full = os.path.join(dp, fn)
                    # Windows 下 relpath 用反斜杠，统一成正斜杠便于比对
                    files.append(os.path.relpath(full, ROOT).replace("\\", "/"))
    return files


IMPORT_RE = re.compile(
    r"""(?:from|import|require|export\s+\*\s+from)\s*\(?\s*["']([^"']+)["']""",
    re.MULTILINE,
)


def resolve(spec, importer_rel):
    """把 import 说明符解析成相对仓库根的路径（可能带/不带扩展名）"""
    out = []
    if spec.startswith("."):
        base = os.path.normpath(os.path.join(os.path.dirname(importer_rel), spec))
        out.append(base)
    else:
        for alias, target in ALIASES.items():
            if spec == alias:
                out.append(target)
                break
            if spec.startswith(alias + "/"):
                out.append(os.path.join(target, spec[len(alias) + 1:]))
                break
        else:
            return []  # node_modules 裸包名，跳过
    return out


def candidate_paths(p):
    """一个说明符可能对应的实际文件"""
    cands = [p]
    for ext in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css", ".svg", ".png"):
        cands.append(p + ext)
    for ext in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"):
        cands.append(os.path.join(p, "index" + ext))
    return cands


def main():
    all_files = set(collect_source())
    referenced = set()

    for rel in sorted(all_files):
        full = os.path.join(ROOT, rel)
        try:
            text = open(full, encoding="utf-8", errors="ignore").read()
        except Exception:
            continue
        for spec in IMPORT_RE.findall(text):
            for base in resolve(spec, rel):
                for cand in candidate_paths(base):
                    cand_norm = cand.replace("\\", "/")
                    if cand_norm in all_files:
                        referenced.add(cand_norm)
                        break

    entries = {e.replace("\\", "/") for e in ENTRY_POINTS if os.path.exists(os.path.join(ROOT, e))}
    unused = sorted(f for f in all_files
                    if f not in referenced and f not in entries and not is_test(f))

    print("=== 源码文件总数: %d ===" % len(all_files))
    print("=== 被 import 的: %d | 入口: %d | 测试: %d ===" % (
        len(referenced), len(entries), sum(1 for f in all_files if is_test(f))))
    print("")
    print("=== 可能未被使用（%d 个）===" % len(unused))
    for f in unused:
        print("  " + f.replace("\\", "/"))


if __name__ == "__main__":
    main()
