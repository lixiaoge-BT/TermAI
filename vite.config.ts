import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";
import { resolve } from "node:path";
// 暂时移除 vite-plugin-electron-renderer 以排除打包后黑屏嫌疑
// import renderer from "vite-plugin-electron-renderer";

// https://vite.dev/config/
export default defineConfig(() => {
  return {
    base: "./",
    build: {
      sourcemap: "hidden",
      // 构建时清理 dist，避免上一版遗留的旧 hash 资源（chunk/preload）被加载
      emptyOutDir: true,
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "./src"),
      },
    },
    plugins: [
      react({
        babel: {
          plugins: [
            'react-dev-locator',
          ],
        },
      }),
      tsconfigPaths(),
      // renderer({ nodeIntegration: false }),
    ],
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      watch: {
        ignored: [
          "**/.electron-userdata/**",
          "**/.cache/**",
          "**/dist/**",
          "**/dist-electron/**",
          "**/release/**",
          "**/node_modules/**",
        ],
      },
    },
  };
});
