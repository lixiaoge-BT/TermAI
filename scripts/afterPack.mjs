import { rcedit } from "rcedit";
import path from "node:path";

/**
 * electron-builder 在 Windows 下有时不会把 icon 正确写入 win-unpacked/TermAI.exe
 * （setup / portable 的图标正常，但 app exe 仍保留 Electron 默认图标）。
 * 此 hook 在打包完成后显式用 rcedit 把应用图标写入 exe，确保任务栏/桌面图标也正确。
 *
 * 注意：`rcedit({ icon })` **不会**写版本信息 —— 只传 icon 时，exe 属性里
 * ProductName/FileVersion 仍是 `Electron / 31.3.1`（任务管理器、属性页、
 * 部分合规检查都会读这几个字段）。必须额外传 version-string 与 file-version。
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const productName = context.packager.appInfo.productName;
  const version = context.packager.appInfo.version;
  const exePath = path.join(context.appOutDir, `${productName}.exe`);
  const iconPath = path.join(context.packager.projectDir, "assets", "icons", "icon.ico");

  try {
    await rcedit(exePath, {
      icon: iconPath,
      "file-version": version,
      "product-version": version,
      "version-string": {
        ProductName: productName,
        FileDescription: `${productName} SSH 终端`,
        CompanyName: productName,
        OriginalFilename: `${productName}.exe`,
      },
    });
    console.log(`[afterPack] icon + version patched: ${exePath} (${version})`);
  } catch (err) {
    console.error(`[afterPack] failed to patch icon for ${exePath}:`, err);
    // 不要阻塞打包流程；setup/portable 图标已经正确
  }
}
