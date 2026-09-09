import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#ecfdf5",
          100: "#d1fae5",
          500: "#10b981",
          600: "#059669",
          700: "#047857",
        },
      },
      boxShadow: {
        card: "0 1px 3px rgba(16,24,40,0.08)",
      },
    },
  },
  plugins: [],
};

export default config;
