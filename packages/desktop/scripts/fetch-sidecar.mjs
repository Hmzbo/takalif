#!/usr/bin/env node
/**
 * Assemble the Tauri sidecar payload: a stock Node.js runtime plus our
 * already-built bundles. Deliberately no pkg/SEA single-file step — native
 * modules need a real file for dlopen, and stock runtimes dodge that trap.
 *
 * Layout produced (binaries live where Tauri resolves sidecars from):
 *   src-tauri/binaries/node-<triple>[.exe]    the runtime (the sidecar binary)
 *   sidecar-build/resources/server/           index.js, schema.sql, node_modules
 *   sidecar-build/resources/web/              built PWA
 *   sidecar-build/manifest.json               triple/node/build traceability
 *
 * Usage: node scripts/fetch-sidecar.mjs [--triple <t>] [--node 22.17.0]
 * Triple defaults to this machine. Native code cannot cross-compile, so other
 * triples are assembled on their own runners (CI).
 */
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, '..');
const root = resolve(desktop, '..', '..');
const out = join(desktop, 'sidecar-build');

const rawArgs = process.argv.slice(2);
const args = {};
for (let i = 0; i < rawArgs.length; i++) {
  const token = rawArgs[i];
  if (token === undefined) break;
  if (!token.startsWith('--')) {
    throw new Error(`unexpected argument: ${token} (use --key=value or --key value)`);
  }
  const eq = token.indexOf('=');
  if (eq === -1) {
    const value = rawArgs[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${token}`);
    args[token.slice(2)] = value;
    i++;
  } else {
    args[token.slice(2, eq)] = token.slice(eq + 1);
  }
}

function hostTriple() {
  if (process.platform === 'win32' && process.arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'aarch64-apple-darwin';
  if (process.platform === 'darwin' && process.arch === 'x64') return 'x86_64-apple-darwin';
  if (process.platform === 'linux' && process.arch === 'x64') return 'x86_64-unknown-linux-gnu';
  throw new Error(`unsupported host ${process.platform}-${process.arch}; pass --triple explicitly`);
}

const triple = args.triple || hostTriple();
// Pinned to the major our lockfile's better-sqlite3 prebuilds cover; bump
// together with engines. Patch version is free to move.
const nodeVersion = args.node || '22.17.0';
const isWindows = triple.includes('windows');

const distName =
  triple === 'x86_64-pc-windows-msvc'
    ? `node-v${nodeVersion}-win-x64`
    : triple === 'aarch64-apple-darwin'
      ? `node-v${nodeVersion}-darwin-arm64`
      : triple === 'x86_64-apple-darwin'
        ? `node-v${nodeVersion}-darwin-x64`
        : `node-v${nodeVersion}-linux-x64`;
const archiveExt = isWindows ? 'zip' : 'tar.xz';
const binaryName = `node-${triple}${isWindows ? '.exe' : ''}`;

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}): ${url}`);
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
}

async function main() {
  // 1. Our bundles must exist first — the script asserts rather than builds.
  const serverBundle = join(root, 'packages', 'server', 'dist', 'index.js');
  const schema = join(root, 'packages', 'server', 'dist', 'schema.sql');
  const webDist = join(root, 'packages', 'web', 'dist', 'index.html');
  for (const f of [serverBundle, schema, webDist]) {
    try {
      await stat(f);
    } catch {
      throw new Error(`missing ${f} — run pnpm build first`);
    }
  }

  // 2. better-sqlite3 must resolve for THIS triple's Node major. Its binding
  // was fetched by prebuild-install on pnpm install; verify presence before
  // shipping a broken sidecar. Resolution goes through Node itself below, so
  // pnpm's store layout is never guessed.
  const serverPkg = join(root, 'packages', 'server', 'package.json');
  try {
    await stat(serverPkg);
  } catch {
    throw new Error('server package not found — wrong checkout?');
  }

  await rm(out, { recursive: true, force: true });
  const binaries = join(desktop, 'src-tauri', 'binaries');
  const resServer = join(out, 'resources', 'server');
  const resWeb = join(out, 'resources', 'web');
  await mkdir(binaries, { recursive: true });
  await mkdir(resServer, { recursive: true });

  // 3. Stock Node runtime.
  console.log(`fetching node v${nodeVersion} for ${triple}…`);
  const tmp = await mkdtemp(join(tmpdir(), 'takalif-node-'));
  const archive = join(tmp, `${distName}.${archiveExt}`);
  await download(`https://nodejs.org/dist/v${nodeVersion}/${distName}.${archiveExt}`, archive);
  if (isWindows) {
    await execFileAsync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path '${archive}' -DestinationPath '${tmp}'`,
    ]);
    await copyFile(join(tmp, distName, 'node.exe'), join(binaries, binaryName));
  } else {
    await execFileAsync('tar', ['-xf', archive, '-C', tmp]);
    await copyFile(join(tmp, distName, 'bin', 'node'), join(binaries, binaryName));
  }
  await rm(tmp, { recursive: true, force: true });

  // 4. Bundles + the native module's whole runtime closure (whole package
  // dirs: internal require paths must survive the move). Dependencies resolve
  // through Node itself, so pnpm's store layout is never guessed. Nearest
  // wins on duplicates, matching Node's own lookup. `prebuild-install` is
  // install tooling only — if a future dep breaks at runtime, the smoke test
  // below the script's contract catches it before Tauri ever sees it.
  await copyFile(serverBundle, join(resServer, 'index.js'));
  await copyFile(schema, join(resServer, 'schema.sql'));
  const resModules = join(resServer, 'node_modules');
  const { createRequire } = await import('node:module');
  const SKIP_RUNTIME = new Set(['prebuild-install']);

  async function packageDirOf(name, fromFile) {
    const req = createRequire(fromFile);
    let dir;
    try {
      dir = dirname(req.resolve(name));
    } catch {
      throw new Error(`cannot resolve runtime dependency ${name} from ${fromFile}`);
    }
    for (let i = 0; i < 8; i++) {
      try {
        const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
        if (pkg.name === name) return dir;
      } catch {
        // Keep walking up.
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(`cannot locate package dir for ${name}`);
  }

  const copied = new Set();
  const queue = [{ name: 'better-sqlite3', from: serverPkg }];
  while (queue.length > 0) {
    const { name, from } = queue.shift();
    if (copied.has(name) || SKIP_RUNTIME.has(name)) continue;
    const dir = await packageDirOf(name, from);
    copied.add(name);
    await cp(dir, join(resModules, name), { recursive: true });
    const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      queue.push({ name: dep, from: join(dir, 'package.json') });
    }
  }
  console.log(`native closure: ${[...copied].join(', ')}`);
  await cp(join(root, 'packages', 'web', 'dist'), resWeb, { recursive: true });

  await writeFile(
    join(out, 'manifest.json'),
    JSON.stringify({ triple, nodeVersion, builtAt: new Date().toISOString() }, null, 2),
  );

  // The claim this assembly makes: the sidecar runtime can load the native
  // binding. Prove it with the sidecar's own Node, not the dev machine's —
  // an ABI mismatch fails here, loudly, instead of inside the installed app.
  const sidecarNode = join(binaries, binaryName);
  try {
    const { stdout } = await execFileAsync(sidecarNode, ['-p', 'require("better-sqlite3/package.json").version'], {
      cwd: resServer,
    });
    console.log(`binding loads under sidecar node (better-sqlite3 ${stdout.trim()})`);
  } catch (error) {
    throw new Error(
      `sidecar node cannot load better-sqlite3 (likely ABI drift — bump --node to a supported major): ${error instanceof Error ? error.message : error}`,
    );
  }

  console.log(`assembled ${out} for ${triple}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
