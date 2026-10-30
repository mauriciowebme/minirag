/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // mesmos tokens da v1.11 — a paleta não muda, só a forma de escrever
        bg: "#0b0e13",
        sup: "#11151c",
        sup2: "#161c25",
        sup3: "#1c2330",
        borda: "#232b38",
        bordaforte: "#313b4b",
        txt: "#e7edf6",
        txt2: "#bfc9d6",
        txt3: "#9aa7b7",
        verde: { DEFAULT: "#3fb950", claro: "#4ccd60" },
        azul: "#6cb6ff",
        roxo: "#a371f7", // v3.15: o pensamento do rastro (mesma cor do IA_GO)
        amarelo: "#d29922",
        vermelho: { DEFAULT: "#f85149", escuro: "#06210c" },
      },
      borderRadius: { campo: "10px", cartao: "14px" },
      fontFamily: {
        sans: ["Inter", "system-ui", "Segoe UI", "Roboto", "-apple-system", "sans-serif"],
        mono: ["ui-monospace", "Cascadia Code", "Consolas", "monospace"],
      },
      boxShadow: { painel: "0 10px 30px rgba(0,0,0,.35)" },
    },
  },
  plugins: [],
};