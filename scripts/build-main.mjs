import { rm } from "node:fs/promises";
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
  input: { preload: path.join(root, "src", "preload", "preload.ts") },
  outDir: path.join(root, "dist", "preload"),
  chunkFileNames: "chunks/[name]-[hash].js"
});

async function bundle({ input, outDir, chunkFileNames }) {
  const build = await rolldown({
    input,
    platform: "node",
    external,
    treeshake: true,
    logLevel: "warn"
  });

  await build.write({
    dir: outDir,
    format: "esm",
    entryFileNames: "[name].js",
    chunkFileNames,
    sourcemap: false
  });

  await build.close();
}
