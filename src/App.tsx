import { HashRouter as Router, Routes, Route } from "react-router-dom";
import { useEffect } from "react";
import Home from "@/pages/Home";
import { useAppConfig } from "@/store/config";
import { initTerminalBridge } from "@/lib/terminalBridge";

// 应用启动时注册一次全局终端桥（AI 命令下发 / 快捷连接），保证多标签命令路由正确
initTerminalBridge();

export default function App() {
  const theme = useAppConfig((s) => s.theme);

  // 主题切换逻辑
  useEffect(() => {
    const root = document.documentElement;
    const applyTheme = () => {
      let appliedTheme = theme;
      if (theme === "system") {
        const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
        appliedTheme = prefersDark ? "dark" : "light";
      }
      if (appliedTheme === "light") {
        root.classList.add("light");
        root.classList.remove("dark");
      } else {
        root.classList.add("dark");
        root.classList.remove("light");
      }
    };
    applyTheme();

    if (theme === "system") {
      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQuery.addEventListener("change", applyTheme);
      return () => mediaQuery.removeEventListener("change", applyTheme);
    }
  }, [theme]);

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/other" element={<div className="text-center text-xl">Other Page - Coming Soon</div>} />
      </Routes>
    </Router>
  );
}
