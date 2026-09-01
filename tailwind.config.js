/** @type {import('tailwindcss').Config} */

export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    container: {
      center: true,
    },
    extend: {
      borderRadius: {
        DEFAULT: "0.5rem",
        sm: "0.375rem",
        md: "0.5rem",
        lg: "0.75rem",
        xl: "1rem",
        "2xl": "1.25rem",
        "3xl": "1.5rem",
      },
      boxShadow: {
        soft: "0 8px 24px -10px rgba(0, 0, 0, 0.28)",
        xl: "0 14px 34px -14px rgba(0, 0, 0, 0.34)",
        "2xl": "0 28px 64px -18px rgba(0, 0, 0, 0.45)",
      },
      colors: {
        // 背景色
        "bg-primary": "var(--bg-primary)",
        "bg-secondary": "var(--bg-secondary)",
        "bg-tertiary": "var(--bg-tertiary)",
        "bg-hover": "var(--bg-hover)",
        "bg-active": "var(--bg-active)",
        "bg-selected": "var(--bg-selected)",
        // 文字色
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-tertiary": "var(--text-tertiary)",
        "text-link": "var(--text-link)",
        // 边框色
        "border-primary": "var(--border-primary)",
        "border-secondary": "var(--border-secondary)",
        // 强调色
        "accent": "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "accent-text": "var(--accent-text)",
        // 功能色
        "success": "var(--success)",
        "success-hover": "var(--success-hover)",
        "success-text": "var(--success-text)",
        "danger": "var(--danger)",
        "danger-text": "var(--danger-text)",
        "warning": "var(--warning)",
        "warning-text": "var(--warning-text)",
        // 终端色
        "terminal-bg": "var(--terminal-bg)",
        "terminal-text": "var(--terminal-text)",
        // 特殊用途（带透明度变体）
        "accent-20": "var(--accent-20)",
        "danger-10": "var(--danger-10)",
        "success-10": "var(--success-10)",
        "warning-10": "var(--warning-10)",
        "hover-bg": "var(--hover-bg)",
        "overlay": "var(--overlay)",
        "code-bg": "var(--code-bg)",
        "modal-bg": "var(--modal-bg)",
        "dropdown-bg": "var(--dropdown-bg)",
      },
    },
  },
  plugins: [],
};
