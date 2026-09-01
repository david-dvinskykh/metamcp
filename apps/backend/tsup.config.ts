import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  splitting: false,
  bundle: true,
  keepNames: true,
  minify: false,
  external: [
    "@modelcontextprotocol/sdk",
    "@repo/trpc",
    "@repo/zod-types",
    "@trpc/server",
    "basic-auth",
    "better-auth",
    "cors",
    "dotenv",
    "drizzle-orm",
    "express",
    "helmet",
    "nanoid",
    "pg",
    "qrcode",
    "shell-quote",
    "spawn-rx",
    // GramJS ships its own CommonJS graph with dynamic requires; bundling it
    // breaks the MTProto crypto lookups, so keep it resolved at runtime.
    "telegram",
    "zod",
  ],
});
