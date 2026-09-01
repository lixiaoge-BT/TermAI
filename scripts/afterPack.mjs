import { rcedit } from "rcedit";
import path from "node:path";

/**
 * electron-builder 在 Windows 下有时不会把 icon 正确写入 win-unpacked/TermAI.exe
 * （setup / portable 的图标正常，但 app exe 仍保留 Electron 默认图标）。
 * 此 hook 在打包完成后显式用 rcedit 把应用图标写入 exe，确保任务栏/桌面图标也正确。
 */
export default async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const productName = context.packager.appInfo.productName;
  const exePath = path.join(context.appOutDir, `${productName}.exe`);
  const iconPath = path.join(context.packager.projectDir, "assets", "icons", "icon.ico");

  try {
    await rcedit(exePath, { icon: iconPath });
    console.log(`[afterPack] icon patched: ${exePath}`);
  } catch (err) {
    console.error(`[afterPack] failed to patch icon for ${exePath}:`, err);
    // 不要阻塞打包流程；setup/portable 图标已经正确
  }
}
