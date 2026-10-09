import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

/**
 * LAN pairing auth.
 *
 * The server is single-user with no accounts (D10). On loopback everything
 * stays as it was — open, because only this machine can reach it. The moment
 * the bind opens to the LAN (desktop app + Android companion), the whole
 * Wi-Fi could read and rewrite the ledger — so non-loopback API traffic must
 * carry a bearer token the user pairs once via QR.
 */

/** True for 127.0.0.0/8, ::1, and IPv6-mapped 127.x. Strict decimal octets
 *  only — `Number()` would accept hex (`0x7f`), whitespace, and empty
 *  segments, which is the wrong shape for a security boundary, even though
 *  `request.ip` is OS-normalized and never produces those forms. */
export function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === '::1') return true;
  const v4 = ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip;
  const parts = v4.split('.');
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p))) {
    return false;
  }
  const nums = parts.map(Number);
  return nums[0] === 127 && nums.slice(1).every((n) => n <= 255);
}

const TOKEN_FILE = 'takalif.token';

/**
 * Resolve the LAN token: explicit env wins, else a persisted file next to the
 * database, else generate-and-store. The file carries 0600 intent (best effort
 * on Windows, where modes are ignored).
 */
export function loadOrCreateToken(dbDir: string, envToken?: string): string {
  const fromEnv = (envToken ?? '').trim();
  if (fromEnv) return fromEnv;
  const path = join(dbDir, TOKEN_FILE);
  try {
    if (existsSync(path)) {
      const stored = readFileSync(path, 'utf8').trim();
      // Implausibly short content is corruption, not a token: regenerate
      // rather than guarding the ledger with a 1-character bearer.
      if (stored.length >= 16) return stored;
      console.warn(`Ignoring implausible token in ${path}; generating a fresh one`);
    }
  } catch (error) {
    // Fall through to generation: a missing/unreadable sidecar must not
    // prevent boot. Worst case the token rotates, which only unpairs clients.
    console.warn(`Could not read token file ${path}:`, error);
  }
  const token = randomBytes(32).toString('hex');
  try {
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
  } catch (error) {
    // Same reasoning: keep serving loopback, just without persistence.
    console.warn(`Could not persist token file ${path}:`, error);
  }
  return token;
}

/** First non-internal IPv4, for the pairing screen's LAN URL. Null if none. */
export function lanIPv4(): string | null {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/** `Authorization: Bearer <token>`, or null when absent/malformed. */
export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return null;
  const m = /^Bearer (.+)$/.exec(value.trim());
  return m?.[1] ? m[1].trim() : null;
}

export function tokenFilePath(dbDir: string): string {
  return join(dbDir, TOKEN_FILE);
}
