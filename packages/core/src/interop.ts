import { isKnownCalendar, type CalendarKind } from './calendars.js';
import { isValidDate, isValidTime, type LocalDate } from './dates.js';
import { parseCalendarQualifier, splitExDates, validateRRule } from './rrule.js';
import type { Exception, Occurrence, OccurrenceStatus, Rule, RuleVersion, Settings, SkipPeriod } from './types.js';

// ---------------------------------------------------------------------------
// JSON backup
// ---------------------------------------------------------------------------

/** Version of the backup envelope. Bump when the shape changes. */
export const BACKUP_VERSION = 1 as const;

/**
 * Complete, portable snapshot of everything the user owns.
 *
 * `push_subscriptions` are deliberately excluded: they are per-device
 * endpoints that cannot be restored anywhere else.
 */
export interface BackupDocument {
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  settings: Settings;
  rules: Rule[];
  ruleVersions: RuleVersion[];
  occurrences: Occurrence[];
  skipPeriods: SkipPeriod[];
  exceptions: Exception[];
}

export interface BackupInput {
  settings: Settings;
  rules: Rule[];
  ruleVersions: RuleVersion[];
  occurrences: Occurrence[];
  skipPeriods: SkipPeriod[];
  exceptions: Exception[];
}

/** Assemble a versioned envelope. Pure; the caller decides where it goes. */
export function buildBackup(input: BackupInput, now: Date = new Date()): BackupDocument {
  return {
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    settings: input.settings,
    rules: input.rules,
    ruleVersions: input.ruleVersions,
    occurrences: input.occurrences,
    skipPeriods: input.skipPeriods,
    exceptions: input.exceptions,
  };
}

const STATUSES: readonly string[] = ['pending', 'done', 'missed', 'skipped'];

function fail(path: string, message: string): never {
  throw new Error(`Invalid backup at ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(obj: Record<string, unknown>, field: string, path: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) fail(`${path}.${field}`, 'must be a non-empty string');
  return value as string;
}

/** Ids travel into UIDs, filenames and SQL keys: no line breaks, ever. */
function requireId(obj: Record<string, unknown>, field: string, path: string): string {
  const value = requireString(obj, field, path);
  if (/[\r\n]/.test(value)) fail(`${path}.${field}`, 'must not contain line breaks');
  return value;
}

function optionalString(obj: Record<string, unknown>, field: string, path: string): string | null {
  const value = obj[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(`${path}.${field}`, 'must be a string or null');
  return value;
}

function requireIso(value: unknown, path: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    fail(path, 'must be an ISO-8601 timestamp');
  }
  return value as string;
}

/**
 * Validate an unknown value as a backup document.
 *
 * Throws a descriptive `Error` on the first problem. The server maps this to
 * 400 and writes nothing: validation always runs before any row is touched,
 * so a corrupt file can never leave a half-restored database.
 */
export function parseBackupDocument(input: unknown): BackupDocument {
  if (!isRecord(input)) fail('$', 'must be an object');
  const doc = input as Record<string, unknown>;
  if (doc.version !== BACKUP_VERSION) fail('version', `must be ${BACKUP_VERSION}`);
  requireIso(doc.exportedAt, 'exportedAt');

  const settings = parseSettings(doc.settings);
  const rules = parseRules(doc.rules);
  const ruleIds = new Set(rules.map((r) => r.id));
  const createdDates = new Map(rules.map((r) => [r.id, r.createdDate]));
  const ruleVersions = parseRuleVersions(doc.ruleVersions, ruleIds);
  const versionKeys = new Set(ruleVersions.map((v) => `${v.ruleId}\u0000${v.version}`));
  const occurrences = parseOccurrences(doc.occurrences, ruleIds, createdDates, versionKeys);
  const skipPeriods = parseSkipPeriods(doc.skipPeriods);
  const exceptions = parseExceptions(doc.exceptions, ruleIds);

  return {
    version: BACKUP_VERSION,
    exportedAt: doc.exportedAt as string,
    settings,
    rules,
    ruleVersions,
    occurrences,
    skipPeriods,
    exceptions,
  };
}

function parseSettings(value: unknown): Settings {
  if (!isRecord(value)) fail('settings', 'must be an object');
  try {
    new Intl.DateTimeFormat('en', { timeZone: String(value.timezone) });
  } catch {
    fail('settings.timezone', 'must be a known IANA timezone');
  }
  if (!isValidTime(String(value.dayRollover))) fail('settings.dayRollover', 'must be HH:MM');
  for (const field of ['lookbackDays', 'lookaheadDays'] as const) {
    const n = value[field];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 3660) {
      fail(`settings.${field}`, 'must be an integer between 0 and 3660');
    }
  }
  if (!isKnownCalendar(value.defaultCalendar)) fail('settings.defaultCalendar', 'must be a known calendar');
  const email = value.email ?? null;
  if (email !== null && (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    fail('settings.email', 'must be a valid address or null');
  }
  // Same bounds as PATCH /api/settings: a crafted backup must not store what
  // the interactive route would reject.
  const ntfyTopic = value.ntfyTopic ?? null;
  if (ntfyTopic !== null && (typeof ntfyTopic !== 'string' || !/^[A-Za-z0-9_\-/]{1,64}$/.test(ntfyTopic))) {
    fail('settings.ntfyTopic', 'must be 1-64 characters of letters, numbers, -, _ or /');
  }
  const ntfyServer = value.ntfyServer ?? null;
  if (ntfyServer !== null && (typeof ntfyServer !== 'string' || !/^https?:\/\/.{1,200}$/i.test(ntfyServer))) {
    fail('settings.ntfyServer', 'must be an http(s) URL');
  }
  return value as unknown as Settings;
}

function parseRules(value: unknown): Rule[] {
  if (!Array.isArray(value)) fail('rules', 'must be an array');
  const seen = new Set<string>();
  return (value as unknown[]).map((item, i) => {
    const path = `rules[${i}]`;
    if (!isRecord(item)) fail(path, 'must be an object');
    const id = requireId(item, 'id', path);
    if (seen.has(id)) fail(path, `duplicate rule id ${JSON.stringify(id)}`);
    seen.add(id);
    const title = requireString(item, 'title', path);
    if (title.length > 500) fail(`${path}.title`, 'must be at most 500 characters');
    const rrule = requireString(item, 'rrule', path);
    const dtstartDate = requireString(item, 'dtstartDate', path);
    if (!isValidDate(dtstartDate)) fail(`${path}.dtstartDate`, 'must be YYYY-MM-DD');
    if (!validateRRule(rrule, dtstartDate as LocalDate)) fail(`${path}.rrule`, 'is not a supported RRULE');
    const createdDate = requireString(item, 'createdDate', path);
    if (!isValidDate(createdDate)) fail(`${path}.createdDate`, 'must be YYYY-MM-DD');
    if (item.calendar !== undefined && !isKnownCalendar(item.calendar)) {
      fail(`${path}.calendar`, 'must be a known calendar');
    }
    if (item.dueTime !== undefined && item.dueTime !== null && !isValidTime(String(item.dueTime))) {
      fail(`${path}.dueTime`, 'must be HH:MM or null');
    }
    if (
      item.reminderTime !== undefined &&
      item.reminderTime !== null &&
      !isValidTime(String(item.reminderTime))
    ) {
      fail(`${path}.reminderTime`, 'must be HH:MM or null');
    }
    if (item.trackStreak !== undefined && typeof item.trackStreak !== 'boolean') {
      fail(`${path}.trackStreak`, 'must be a boolean');
    }
    if (item.active !== undefined && typeof item.active !== 'boolean') {
      fail(`${path}.active`, 'must be a boolean');
    }
    return item as unknown as Rule;
  });
}

function parseRuleVersions(value: unknown, ruleIds: Set<string>): RuleVersion[] {
  if (!Array.isArray(value)) fail('ruleVersions', 'must be an array');
  const seen = new Set<string>();
  const seenPair = new Set<string>();
  return (value as unknown[]).map((item, i) => {
    const path = `ruleVersions[${i}]`;
    if (!isRecord(item)) fail(path, 'must be an object');
    const id = requireId(item, 'id', path);
    if (seen.has(id)) fail(path, `duplicate version id ${JSON.stringify(id)}`);
    seen.add(id);
    const ruleId = requireString(item, 'ruleId', path);
    if (!ruleIds.has(ruleId)) fail(`${path}.ruleId`, 'references an unknown rule');
    if (typeof item.version !== 'number' || !Number.isInteger(item.version) || item.version < 1) {
      fail(`${path}.version`, 'must be a positive integer');
    }
    const pair = `${ruleId}\u0000${item.version}`;
    if (seenPair.has(pair)) fail(path, 'duplicate (ruleId, version)');
    seenPair.add(pair);
    const rrule = requireString(item, 'rrule', path);
    const dtstartDate = requireString(item, 'dtstartDate', path);
    if (!isValidDate(dtstartDate)) fail(`${path}.dtstartDate`, 'must be YYYY-MM-DD');
    if (!validateRRule(rrule, dtstartDate as LocalDate)) fail(`${path}.rrule`, 'is not a supported RRULE');
    const effectiveFrom = requireString(item, 'effectiveFrom', path);
    if (!isValidDate(effectiveFrom)) fail(`${path}.effectiveFrom`, 'must be YYYY-MM-DD');
    return item as unknown as RuleVersion;
  });
}

function parseOccurrences(
  value: unknown,
  ruleIds: Set<string>,
  createdDates: Map<string, string>,
  versionKeys: Set<string>,
): Occurrence[] {
  if (!Array.isArray(value)) fail('occurrences', 'must be an array');
  const seen = new Set<string>();
  const seenPair = new Set<string>();
  return (value as unknown[]).map((item, i) => {
    const path = `occurrences[${i}]`;
    if (!isRecord(item)) fail(path, 'must be an object');
    const id = requireId(item, 'id', path);
    if (seen.has(id)) fail(path, `duplicate occurrence id ${JSON.stringify(id)}`);
    seen.add(id);
    const ruleId = requireString(item, 'ruleId', path);
    if (!ruleIds.has(ruleId)) fail(`${path}.ruleId`, 'references an unknown rule');
    const scheduledDate = requireString(item, 'scheduledDate', path);
    if (!isValidDate(scheduledDate)) fail(`${path}.scheduledDate`, 'must be YYYY-MM-DD');
    // Nothing exists before the rule was created: a crafted file must not
    // invent failures from before tracking began.
    const created = createdDates.get(ruleId);
    if (created !== undefined && scheduledDate < created) {
      fail(`${path}.scheduledDate`, 'precedes the rule\u2019s createdDate');
    }
    const pair = `${ruleId}\u0000${scheduledDate}`;
    if (seenPair.has(pair)) fail(path, 'duplicate (ruleId, scheduledDate)');
    seenPair.add(pair);
    if (typeof item.ruleVersion !== 'number' || !Number.isInteger(item.ruleVersion) || item.ruleVersion < 1) {
      fail(`${path}.ruleVersion`, 'must be a positive integer');
    }
    if (!versionKeys.has(`${ruleId}\u0000${item.ruleVersion}`)) {
      fail(`${path}.ruleVersion`, 'references an unknown rule version');
    }
    if (!STATUSES.includes(String(item.status))) fail(`${path}.status`, 'must be a known status');
    if (item.dueTime !== undefined && item.dueTime !== null && !isValidTime(String(item.dueTime))) {
      fail(`${path}.dueTime`, 'must be HH:MM or null');
    }
    if (item.completedAt !== undefined && item.completedAt !== null) {
      requireIso(item.completedAt, `${path}.completedAt`);
    }
    return item as unknown as Occurrence;
  });
}

function parseSkipPeriods(value: unknown): SkipPeriod[] {
  if (!Array.isArray(value)) fail('skipPeriods', 'must be an array');
  const seen = new Set<string>();
  return (value as unknown[]).map((item, i) => {
    const path = `skipPeriods[${i}]`;
    if (!isRecord(item)) fail(path, 'must be an object');
    const id = requireId(item, 'id', path);
    if (seen.has(id)) fail(path, `duplicate skip period id ${JSON.stringify(id)}`);
    seen.add(id);
    const startDate = requireString(item, 'startDate', path);
    const endDate = requireString(item, 'endDate', path);
    if (!isValidDate(startDate) || !isValidDate(endDate)) fail(path, 'dates must be YYYY-MM-DD');
    if (endDate < startDate) fail(path, 'endDate must not precede startDate');
    return item as unknown as SkipPeriod;
  });
}

function parseExceptions(value: unknown, ruleIds: Set<string>): Exception[] {
  if (!Array.isArray(value)) fail('exceptions', 'must be an array');
  const seen = new Set<string>();
  const seenId = new Set<string>();
  return (value as unknown[]).map((item, i) => {
    const path = `exceptions[${i}]`;
    if (!isRecord(item)) fail(path, 'must be an object');
    if (item.id !== undefined && item.id !== null) {
      const id = requireId(item, 'id', path);
      if (seenId.has(id)) fail(path, `duplicate exception id ${JSON.stringify(id)}`);
      seenId.add(id);
    }
    const ruleId = requireString(item, 'ruleId', path);
    if (!ruleIds.has(ruleId)) fail(`${path}.ruleId`, 'references an unknown rule');
    const date = requireString(item, 'date', path);
    if (!isValidDate(date)) fail(`${path}.date`, 'must be YYYY-MM-DD');
    const pair = `${ruleId}\u0000${date}`;
    if (seen.has(pair)) fail(path, 'duplicate (ruleId, date)');
    seen.add(pair);
    return item as unknown as Exception;
  });
}

// ---------------------------------------------------------------------------
// CSV export (ledger)
// ---------------------------------------------------------------------------

/** One ledger row joined with its rule, ready for spreadsheet use. */
export interface LedgerCsvRow {
  ruleId: string;
  ruleTitle: string;
  scheduledDate: LocalDate;
  status: OccurrenceStatus;
  dueTime: string | null;
  completedAt: string | null;
  ruleVersion: number;
  calendar: CalendarKind;
  category: string | null;
}

export const LEDGER_CSV_HEADER =
  'rule_id,rule_title,scheduled_date,status,due_time,completed_at,rule_version,calendar,category';

function csvField(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? '' : String(value);
  // Spreadsheet formula injection: titles and categories are user-controlled,
  // and Excel/Sheets evaluate a leading = + - @ as a formula on open. Prefix
  // with a single quote, per OWASP CSV guidance.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** RFC 4180 quoting. Newline is `\n`; a trailing newline terminates the file. */
export function ledgerToCsv(rows: LedgerCsvRow[]): string {
  const lines = [LEDGER_CSV_HEADER];
  for (const r of rows) {
    lines.push(
      [
        csvField(r.ruleId),
        csvField(r.ruleTitle),
        csvField(r.scheduledDate),
        csvField(r.status),
        csvField(r.dueTime),
        csvField(r.completedAt),
        csvField(r.ruleVersion),
        csvField(r.calendar),
        csvField(r.category),
      ].join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** Join occurrences with their rules for CSV export. Unknown rules read as archived. */
export function toLedgerCsvRows(
  occurrences: Occurrence[],
  rules: Pick<Rule, 'id' | 'title' | 'calendar' | 'category'>[],
): LedgerCsvRow[] {
  const byId = new Map(rules.map((r) => [r.id, r]));
  return occurrences.map((o) => {
    const rule = byId.get(o.ruleId);
    return {
      ruleId: o.ruleId,
      ruleTitle: rule?.title ?? '(archived)',
      scheduledDate: o.scheduledDate,
      status: o.status,
      dueTime: o.dueTime ?? null,
      completedAt: o.completedAt ?? null,
      ruleVersion: o.ruleVersion,
      calendar: rule?.calendar ?? 'gregorian',
      category: rule?.category ?? null,
    };
  });
}

// ---------------------------------------------------------------------------
// CalDAV VTODO export (schedules)
// ---------------------------------------------------------------------------

/**
 * Escape RFC 5545 TEXT: backslash, newline, comma, semicolon.
 * See RFC 5545 §3.3.11.
 */
export function escapeVText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
}

/** Fold a content line at 75 octets with a space continuation (RFC 5545 §3.1). */
export function foldVLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  const limit = () => (parts.length === 0 ? 75 : 74);
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (currentBytes + size > limit()) {
      parts.push(parts.length === 0 ? current : ` ${current}`);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  parts.push(parts.length === 0 ? current : ` ${current}`);
  return parts.join('\r\n');
}

const toBasicDate = (iso: string): string | null => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
};

const toBasicDay = (date: LocalDate): string => date.replace(/-/g, '');

/**
 * Serialise rules as a VCALENDAR of VTODOs.
 *
 * The RRULE is exported without our `CALENDAR=` extension (stripped to a
 * plain RFC 5545 value) and the rule's calendar travels in
 * `X-TAKALIF-CALENDAR`, so foreign parsers still read the schedule while a
 * re-import restores the exact calendar. `EXDATE` parts embedded in the stored
 * RRULE are lifted into real `EXDATE` properties. Archived rules export as
 * `STATUS:CANCELLED`.
 */
export function rulesToVCalendar(rules: Rule[], now: Date = new Date()): string {
  const dtstamp = toBasicDate(now.toISOString()) ?? '20260101T000000Z';
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Takalif//Rules//EN'];
  for (const rule of [...rules].sort((a, b) => a.id.localeCompare(b.id))) {
    lines.push(...ruleToVTodo(rule, dtstamp));
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldVLine).join('\r\n') + '\r\n';
}

function ruleToVTodo(rule: Rule, dtstamp: string): string[] {
  const { rule: withoutExdates, exdates } = splitExDates(rule.rrule);
  let rrule = withoutExdates;
  try {
    rrule = parseCalendarQualifier(withoutExdates).rule;
  } catch {
    // A stored rule that no longer parses is still exported verbatim: losing
    // a schedule silently would be worse than an imperfect import elsewhere.
  }
  const out = [
    'BEGIN:VTODO',
    `UID:${rule.id}@takalif`,
    `DTSTAMP:${dtstamp}`,
    `SUMMARY:${escapeVText(rule.title)}`,
    `DTSTART;VALUE=DATE:${toBasicDay(rule.dtstartDate)}`,
    `RRULE:${rrule}`,
    `X-TAKALIF-CALENDAR:${rule.calendar}`,
    `X-TAKALIF-CREATED-DATE:${toBasicDay(rule.createdDate)}`,
  ];
  if (rule.description) out.push(`DESCRIPTION:${escapeVText(rule.description)}`);
  if (rule.dueTime) out.push(`X-TAKALIF-DUE-TIME:${rule.dueTime}`);
  if (rule.reminderTime) out.push(`X-TAKALIF-REMINDER-TIME:${rule.reminderTime}`);
  if (rule.category) out.push(`CATEGORIES:${escapeVText(rule.category)}`);
  if (rule.trackStreak) out.push('X-TAKALIF-TRACK-STREAK:TRUE');
  if (!rule.active) out.push('STATUS:CANCELLED');
  const created = rule.createdAt ? toBasicDate(rule.createdAt) : null;
  if (created) out.push(`CREATED:${created}`);
  const updated = rule.updatedAt ? toBasicDate(rule.updatedAt) : null;
  if (updated) out.push(`LAST-MODIFIED:${updated}`);
  for (const ex of exdates) out.push(`EXDATE;VALUE=DATE:${toBasicDay(ex as LocalDate)}`);
  out.push('END:VTODO');
  return out;
}
