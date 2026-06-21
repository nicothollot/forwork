import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/schemas", { recursive: true });
await cp("src/schemas", "dist/schemas", { recursive: true });
