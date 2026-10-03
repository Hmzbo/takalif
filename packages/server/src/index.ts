import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { openDatabase } from './db.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_FILE = process.env.DB_FILE ?? join(root, 'data', 'takalif.sqlite');
const WEB_DIST = process.env.WEB_DIST ?? join(root, 'packages', 'web', 'dist');

mkdirSync(dirname(DB_FILE), { recursive: true });

const db = openDatabase(DB_FILE);
const app = buildApp(db, {
  // Same-origin only unless explicitly opened up. Reflecting any origin would
  // let any site the owner visits read and rewrite their ledger.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  logger: process.env.LOG !== 'off',
});

if (existsSync(join(WEB_DIST, 'index.html'))) {
  // Serve the built PWA when it is available, so one process is the whole app.
  // Gated on index.html rather than the directory: without it, `sendFile`
  // re-enters the not-found handler and turns every request into a 500.
  const fastifyStatic = (await import('@fastify/static')).default;
  await app.register(fastifyStatic, { root: WEB_DIST });
}
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) {
    reply.code(404).send({ error: 'Not found' });
    return;
  }
  // Client-side routing: hand back the SPA shell, but only to requests that
  // actually want a document.
  if (!req.headers.accept?.includes('text/html')) {
    reply.code(404).send({ error: 'Not found' });
    return;
  }
  if (reply.sent) return;
  reply.sendFile('index.html');
});

await app.listen({ port: PORT, host: HOST });

console.log(`Takalif server listening on http://${HOST}:${PORT}`);
console.log(`  database: ${DB_FILE}`);
if (existsSync(WEB_DIST)) console.log(`  web:      ${WEB_DIST}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
