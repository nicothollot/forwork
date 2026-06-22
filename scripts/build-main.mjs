import { cp, mkdir, rm } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import { rolldown } from "rolldown";

const root = process.cwd();
const external = [
  "electron",
  ...builtinModules,
  ...builtinModules.map((moduleName) => `node:${moduleName}`)
];

await Promise.all([
  rm(path.join(root, "dist", "main"), { recursive: true, force: true }),
  rm(path.join(root, "dist", "preload"), { recursive: true, force: true })
]);

await bundle({
  input: { main: path.join(root, "src", "main", "main.ts") },
  outDir: path.join(root, "dist", "main"),
  chunkFileNames: "chunks/[name]-[hash].js"
});

await bundle({
  input: { pdfWorkerHost: path.join(root, "src", "engine", "pdfWorkerHost.ts") },
  outDir: path.join(root, "dist", "main"),
  chunkFileNames: "chunks/[name]-[hash].js"
});

await bundle({
  input: {
    preload: path.join(root, "src", "preload", "preload.ts"),
    visualQaPreload: path.join(root, "src", "preload", "visualQaPreload.ts")
  },
  outDir: path.join(root, "dist", "preload"),
  chunkFileNames: "chunks/[name]-[hash].cjs",
  format: "cjs",
  entryFileNames: "[name].cjs"
});

await mkdir(path.join(root, "dist", "main", "chunks"), { recursive: true });
await cp(
  path.join(root, "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
  path.join(root, "dist", "main", "chunks", "pdf.worker.mjs")
);

async function bundle({ input, outDir, chunkFileNames, format = "esm", entryFileNames = "[name].js" }) {
  const build = await rolldown({
    input,
    platform: "node",
    external,
    treeshake: true,
    logLevel: "warn"
  });

  await build.write({
    dir: outDir,
    format,
    entryFileNames,
    chunkFileNames,
    sourcemap: false
  });

  await build.close();
}
