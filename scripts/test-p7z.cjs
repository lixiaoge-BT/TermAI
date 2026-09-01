const p7z = require("7zip-bin").path7za;
console.log("path7za:", p7z);
console.log("exists:", require("fs").existsSync(p7z));
console.log("");
const { spawnSync } = require("child_process");
const r = spawnSync(p7z, [], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
console.log("exit:", r.status);
console.log("stdout head 300:", String(r.stdout || "").slice(0, 300));
if (r.stderr && r.stderr.length) console.log("stderr:", String(r.stderr).slice(0, 300));
