import { build } from "esbuild";
await build({ entryPoints: { main: "electron/main.ts", preload: "electron/preload.ts" }, outdir: "dist-electron", bundle: true, platform: "node", format: "cjs", outExtension: { ".js": ".cjs" }, external: ["electron"], target: "node22", sourcemap: true });
