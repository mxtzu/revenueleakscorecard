import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0A0A0B",
          900: "#0d1016",
          800: "#12161f"
        },
        line: {
          DEFAULT: "#1c2030",
          soft: "rgba(255, 255, 255, 0.06)"
        },
        electric: {
          300: "#8fb0ff",
          400: "#5d89ff",
          500: "#2F6BFF",
          600: "#2456d6"
        }
      },
      fontFamily: {
        display: ["var(--font-display)"],
        mono: ["var(--font-mono)"],
        sans: ["var(--font-sans)"]
      },
      boxShadow: {
        card: "0 1px 0 rgba(255, 255, 255, 0.03) inset, 0 16px 40px rgba(0, 0, 0, 0.45)",
        lift: "0 24px 64px rgba(0, 0, 0, 0.55)",
        glow: "0 0 0 1px rgba(47, 107, 255, 0.35), 0 8px 40px rgba(47, 107, 255, 0.18)"
      },
      letterSpacing: {
        label: "0.18em"
      }
    }
  },
  plugins: []
};

export default config;
