/** Build do painel: painel/app.ts -> painel/app.js (transpile, sem bundle). */
const esbuild = require("esbuild");
const path = require("node:path");

const raiz = path.resolve(__dirname, "..");
esbuild
  .build({
    entryPoints: [path.join(raiz, "painel", "app.ts")],
    outfile: path.join(raiz, "painel", "app.js"),
    bundle: false,
    target: ["es2020"],
    format: "iife",
    logLevel: "info",
  })
  .then(() => console.log("painel/app.js gerado"))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });