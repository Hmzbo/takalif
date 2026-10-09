import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { openDatabase } from './db.js';
import { pushConfigured, runReminderTick } from './reminders.js';
import { restoreBackup } from './repo.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const DB_FILE = process.env.DB_FILE ?? join(root, 'data', 'takalif.sqlite');
const WEB_DIST = process.env.WEB_DIST ?? join(root, 'packages', 'web', 'dist');

mkdirSync(dirname(DB_FILE), { recursive: true });

const db = openDatabase(DB_FILE);

/**
 * Optional one-time seed (demo mode). Opt-in via SEED_FILE; strictly guarded:
 * it only ever touches an empty database (no rules and no occurrences), so it
 * cannot overwrite real data no matter how it is misconfigured. A bad file
 * fails the boot loudly rather than starting an empty-looking app.
 */
const SEED_FILE = process.env.SEED_FILE;
if (SEED_FILE) {
  if (!existsSync(SEED_FILE)) {
    console.error(`SEED_FILE points at a missing file: ${SEED_FILE}`);
    process.exit(1);
  }
  const isEmpty =
    (db.prepare('SELECT COUNT(*) AS n FROM rules').get() as { n: number }).n === 0 &&
    (db.prepare('SELECT COUNT(*) AS n FROM occurrences').get() as { n: number }).n === 0;
  if (isEmpty) {
    try {
      const counts = restoreBackup(db, JSON.parse(readFileSync(SEED_FILE, 'utf8')));
      console.log(
        `seeded database from ${SEED_FILE} (${counts.rules} rules, ${counts.occurrences} occurrences)`,
      );
    } catch (error) {
      console.error(`SEED_FILE ${SEED_FILE} is not a valid backup document:`, error);
      process.exit(1);
    }
  } else {
    console.log('SEED_FILE set but the database already has data — leaving it alone');
  }
}

const pushConfig = {
  publicKey: process.env.VAPID_PUBLIC_KEY || undefined,
  privateKey: process.env.VAPID_PRIVATE_KEY || undefined,
  subject: process.env.VAPID_SUBJECT || undefined,
};

const app = buildApp(db, {
  // Same-origin only unless explicitly opened up. Reflecting any origin would
  // let any site the owner visits read and rewrite their ledger.
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean),
  logger: process.env.LOG !== 'off',
  push: pushConfig,
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
if (pushConfigured(pushConfig)) {
  console.log('  reminders: web push enabled');
} else {
  console.log('  reminders: web push disabled (set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)');
}

// Reminders must be server-side: the client is not reliably open, and the
// ledger is the source of truth. One pass a minute is plenty — reminder times
// have minute resolution, and each pass marks what it sent.
const REMINDER_INTERVAL_MS = 60_000;
async function reminderTick(): Promise<void> {
  try {
    const result = await runReminderTick(db, pushConfig, new Date());
    if (result.checked > 0) {
      console.log(
        `reminders: checked ${result.checked}, sent ${result.sent}, failed ${result.failed}, pruned ${result.pruned}`,
      );
    }
  } catch (error) {
    // A failed tick must never take the server down with it.
    console.error('reminders: tick failed', error);
  }
}
await reminderTick();
const reminderTimer = setInterval(() => {
  void reminderTick();
}, REMINDER_INTERVAL_MS);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(reminderTimer);
    void app.close().then(() => {
      db.close();
      process.exit(0);
    });
  });
}
