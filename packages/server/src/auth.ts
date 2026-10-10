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

const generateToken = (): string => randomBytes(32).toString('hex');

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
  const token = generateToken();
  try {
    mkdirSync(dbDir, { recursive: true });
    writeFileSync(path, `${token}\n`, { mode: 0o600 });
  } catch (error) {
    // Same reasoning: keep serving loopback, just without persistence.
    console.warn(`Could not persist token file ${path}:`, error);
  }
  return token;
}

/**
 * Replace the persisted token with a fresh one. Explicit user action only
 * (the rotate route); unlike loading, failure here is loud — the caller
 * asked for a new code and must know it did not happen.
 */
export function rotateToken(dbDir: string): string {
  const token = generateToken();
  mkdirSync(dbDir, { recursive: true });
  writeFileSync(join(dbDir, TOKEN_FILE), `${token}\n`, { mode: 0o600 });
  return token;
}

/** First non-internal IPv4, for the pairing screen's LAN URL. Null if none. */
export function lanIPv4(): string | null {
  return pickPairingInterfaces(networkInterfaces())[0]?.address ?? null;
}

/** Every usable IPv4 with its interface name, RFC 1918 (likely the phone's
 *  WiFi) first. Multi-homed machines — Tailscale beside Ethernet, as here —
 *  otherwise hand the companion whichever address enumeration hits first. */
export interface LanInterface {
  name: string;
  address: string;
}

/** Minimal shape pickPairingInterfaces reads; real NIC records satisfy it. */
export interface NicInfo {
  family: string;
  internal: boolean;
  address: string;
}

export function pickPairingInterfaces(all: NodeJS.Dict<NicInfo[]>): LanInterface[] {
  const found: LanInterface[] = [];
  for (const [name, addrs] of Object.entries(all)) {
    for (const a of addrs ?? []) {
      // '4' is the pre-18 numeric family; engines here are 22+, kept for safety.
      if (a.family !== 'IPv4' && a.family !== '4') continue;
      if (a.internal) continue;
      found.push({ name, address: a.address });
    }
  }
  const rfc1918 = (ip: string) =>
    ip.startsWith('192.168.') ||
    ip.startsWith('10.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
  // Virtual switches (Hyper-V, Docker, Tailscale tunnels) hand out perfectly
  // valid RFC 1918 addresses a phone can never reach. They stay selectable —
  // the tailnet path is real when the phone is on it — but rank below a NIC
  // that looks like actual hardware.
  const virtualNic = (name: string) =>
    /virtual|vethernet|\bwsl\b|hyper-?v|docker|vbox|virtualbox|vmware|vmnet|tailscale|\btun\b|\btap\b/i.test(
      name,
    );
  const physicalNic = (name: string) =>
    /ethernet|eth\d|\bwi-?fi\b|wlan|^en\d|^eno|^ens|^enp|^wlp/i.test(name) &&
    !virtualNic(name);
  const score = (nic: LanInterface) =>
    (rfc1918(nic.address) ? 2 : 0) + (physicalNic(nic.name) ? 1 : 0) - (virtualNic(nic.name) ? 2 : 0);
  return found.sort((a, b) => score(b) - score(a));
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
