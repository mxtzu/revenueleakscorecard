import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#05070a",
          900: "#090d12",
          850: "#0c1118",
          800: "#101721",
          700: "#182131"
        },
        electric: {
          400: "#20c8ff",
          500: "#00a3ff",
          600: "#0874ff"
        }
      },
      boxShadow: {
        "blue-glow": "0 0 0 1px rgba(32, 200, 255, 0.28), 0 24px 80px rgba(0, 120, 255, 0.12)"
      }
    }
  },
  plugins: []
};

export default config;
