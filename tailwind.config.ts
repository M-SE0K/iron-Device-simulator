import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          blue: "#0B4171",
          "blue-light": "#6B9BD1",
          "blue-dark": "#08314F",
        },
        surface: {
          DEFAULT: "#FFFFFF",
          secondary: "#F1F5F9",
          tertiary: "#EEF2F7",
        },
        iron: {
          900: "#0F172A",
          800: "#1E293B",
          700: "#334155",
          600: "#475569",
          500: "#64748B",
          400: "#94A3B8",
          300: "#CBD5E1",
          200: "#E2E8F0",
          100: "#F1F5F9",
          50:  "#F8FAFC",
        },
      },
      fontFamily: {
        sans: ["Pretendard Variable", "Pretendard", "Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
