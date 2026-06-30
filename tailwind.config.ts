import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        // Iron Device brand palette
        brand: {
          blue: "#0057B8",
          "blue-light": "#1A73E8",
          "blue-dark": "#003F8A",
        },
        surface: {
          DEFAULT: "#FFFFFF",
          secondary: "#F5F6F8",
          tertiary: "#ECEEF1",
        },
        iron: {
          900: "#1A1D23",
          800: "#232830",
          700: "#2E3440",
          600: "#3D4455",
          500: "#5A6278",
          400: "#7D8699",
          300: "#A4AABA",
          200: "#CDD1DA",
          100: "#E8EAF0",
          50:  "#F5F6F8",
        },
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
