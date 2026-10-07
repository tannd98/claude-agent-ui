import { defineConfig } from "tsup";

/**
 * Bundles the server into `dist/`, which is the only thing `files` ships.
 *
 * Two entries because package.json names two: `bin` is dist/cli.js and `main` is dist/server.js.
 * Everything they share lands in one chunk rather than being emitted twice — and because every
 * emitted file sits directly in dist/, `import.meta.url` still resolves dist/web the same way
 * from a chunk as from the entry (see AppOptions.webRoot in src/server.ts).
 */
export default defineConfig({
  entry: ["src/cli.ts", "src/server.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist",
  splitting: true,
  // Safe only because the web build runs after this one; reversing the two deletes dist/web.
  clean: true,
  // The tarball ships built output and nothing else, so no sourcemap carries the TypeScript back
  // into it. A stack trace from the bundle still names the right function and file.
  sourcemap: false,
  // Left readable on purpose: a local tool nobody downloads over a network gains nothing from
  // minification, and an unminified bundle is one a user can actually read when it misbehaves.
  minify: false,
  // The four runtime dependencies resolve from node_modules at run time; only our own code is
  // bundled. Anything else pulled in would be a dependency we failed to declare.
  external: ["express", "yaml", "croner", "open"],
});
