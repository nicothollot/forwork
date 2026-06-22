import { cp, mkdir } from "node:fs/promises";

await mkdir("dist/schemas", { recursive: true });
await cp("src/schemas", "dist/schemas", { recursive: true });
await mkdir("dist/resources", { recursive: true });
await cp("resources/office", "dist/resources/office", { recursive: true });
