// Bundles the server into a single runnable artifact.
//
// Kept as a script rather than a CLI one-liner for two reasons: the banner needs
// quoting that npm scripts handle badly on Windows, and `better-sqlite3` is a
// native module that must stay external.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'dist');

mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(outDir, 'index.js'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Native addon: must be required at runtime, not bundled.
  external: ['better-sqlite3'],
  sourcemap: true,
  // Fastify and its dependencies are CommonJS and call `require('node:events')`.
  // esbuild generates a `__require` shim that throws in ESM output; defining a
  // real `require` via `createRequire` makes it resolve instead. esbuild prefers
  // an ambient `require` when one exists.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// The schema is read from disk at boot, so it has to sit next to the bundle.
copyFileSync(join(root, 'src', 'schema.sql'), join(outDir, 'schema.sql'));

console.log('built dist/index.js + dist/schema.sql');