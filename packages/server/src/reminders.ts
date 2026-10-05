import webpush from 'web-push';
import {
  deleteSubscription,
  findDueReminders,
  listSubscriptions,
  markReminded,
  materialize,
  readSettings,
  type DueReminder,
} from './repo.js';
import type { DB } from './db.js';

export interface PushConfig {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
}

/** A single push delivery. Injected in tests; web-push in production. */
export interface PushSender {
  send(
    subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
    payload: string,
  ): Promise<void>;
}

export type FetchImpl = typeof fetch;

export interface TickResult {
  /** Occurrences examined. */
  checked: number;
  /** Individual deliveries that succeeded (push sends + ntfy posts). */
  sent: number;
  /** Deliveries that threw. */
  failed: number;
  /** Dead subscriptions pruned (410/404 from the push service). */
  pruned: number;
}

export interface ReminderDeps {
  push?: PushSender;
  fetchImpl?: FetchImpl;
}

const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

function defaultPushSender(config: Required<Pick<PushConfig, 'publicKey' | 'privateKey'>> & Pick<PushConfig, 'subject'>): PushSender {
  webpush.setVapidDetails(
    config.subject ?? 'mailto:takalif@localhost',
    config.publicKey,
    config.privateKey,
  );
  return {
    send: async (subscription, payload) => {
      await webpush.sendNotification(subscription, payload);
    },
  };
}

export function pushConfigured(config: PushConfig): boolean {
  return Boolean(config.publicKey && config.privateKey);
}

function reminderPayload(reminder: DueReminder): string {
  return JSON.stringify({
    title: reminder.ruleTitle,
    body: reminder.dueTime ? `Due today at ${reminder.dueTime}` : 'Due today',
    occurrenceId: reminder.occurrenceId,
    date: reminder.scheduledDate,
  });
}

function ntfyServer(settings: { ntfyServer?: string | null }): string {
  const raw = (settings.ntfyServer ?? '').trim() || DEFAULT_NTFY_SERVER;
  return raw.replace(/\/+$/, '');
}

export async function sendNtfy(
  server: string,
  topic: string,
  title: string,
  body: string,
  fetchImpl: FetchImpl = fetch,
): Promise<void> {
  if (!/^https?:\/\//i.test(server)) throw new Error(`Refusing to post to non-HTTP(S) ntfy server`);
  const res = await fetchImpl(`${server}/${topic}`, {
    method: 'POST',
    headers: { Title: title },
    body,
  });
  if (!res.ok) throw new Error(`ntfy post failed (${res.status})`);
}

/**
 * One scheduler pass: find what's due, deliver it, record it.
 *
 * Materialises first so today's rows are guaranteed to exist. Marks rows
 * reminded only when at least one delivery was attempted — with no channel
 * configured at all, rows stay unmarked so a later-configured channel still
 * fires for them.
 */
export async function runReminderTick(
  db: DB,
  config: PushConfig,
  now: Date = new Date(),
  deps: ReminderDeps = {},
): Promise<TickResult> {
  const result: TickResult = { checked: 0, sent: 0, failed: 0, pruned: 0 };

  materialize(db, now);
  const due = findDueReminders(db, now);
  result.checked = due.length;
  if (due.length === 0) return result;

  const settings = readSettings(db);
  const ntfyTopic = (settings.ntfyTopic ?? '').trim();

  const pushSender =
    deps.push ??
    (pushConfigured(config)
      ? defaultPushSender({
          publicKey: config.publicKey!,
          privateKey: config.privateKey!,
          subject: config.subject,
        })
      : null);
  const subscriptions = pushSender ? listSubscriptions(db) : [];
  const ntfyOn = ntfyTopic.length > 0;
  if (subscriptions.length === 0 && !ntfyOn) return result;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const server = ntfyServer(settings);
  const dead: string[] = [];

  for (const reminder of due) {
    const payload = reminderPayload(reminder);
    for (const sub of subscriptions) {
      try {
        await pushSender!.send(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        result.sent++;
      } catch (error) {
        const status = (error as { statusCode?: number })?.statusCode;
        if (status === 404 || status === 410) {
          dead.push(sub.endpoint);
        }
        result.failed++;
      }
    }
    if (ntfyOn) {
      try {
        await sendNtfy(
          server,
          ntfyTopic,
          `Takalif: ${reminder.ruleTitle}`,
          reminder.dueTime ? `Due today at ${reminder.dueTime}` : 'Due today',
          fetchImpl,
        );
        result.sent++;
      } catch {
        result.failed++;
      }
    }
  }

  for (const endpoint of [...new Set(dead)]) {
    if (deleteSubscription(db, endpoint)) result.pruned++;
  }
  markReminded(
    db,
    due.map((d) => d.occurrenceId),
  );
  return result;
}

export interface TestNotificationResult extends TickResult {
  channels: { push: boolean; ntfy: boolean };
}

/** Fire a test notification through every configured channel. */
export async function sendTestNotification(
  db: DB,
  config: PushConfig,
  deps: ReminderDeps = {},
): Promise<TestNotificationResult> {
  const settings = readSettings(db);
  const ntfyTopic = (settings.ntfyTopic ?? '').trim();
  const pushSender =
    deps.push ??
    (pushConfigured(config)
      ? defaultPushSender({
          publicKey: config.publicKey!,
          privateKey: config.privateKey!,
          subject: config.subject,
        })
      : null);
  const subscriptions = pushSender ? listSubscriptions(db) : [];
  const result: TestNotificationResult = {
    checked: 1,
    sent: 0,
    failed: 0,
    pruned: 0,
    channels: { push: subscriptions.length > 0, ntfy: ntfyTopic.length > 0 },
  };
  if (subscriptions.length === 0 && ntfyTopic.length === 0) return result;

  const fetchImpl = deps.fetchImpl ?? fetch;
  const dead: string[] = [];
  for (const sub of subscriptions) {
    try {
      await pushSender!.send(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify({ title: 'Takalif', body: 'Test notification — reminders are working.' }),
      );
      result.sent++;
    } catch (error) {
      const status = (error as { statusCode?: number })?.statusCode;
      if (status === 404 || status === 410) dead.push(sub.endpoint);
      result.failed++;
    }
  }
  if (ntfyTopic.length > 0) {
    try {
      await sendNtfy(
        ntfyServer(settings),
        ntfyTopic,
        'Takalif',
        'Test notification — reminders are working.',
        fetchImpl,
      );
      result.sent++;
    } catch {
      result.failed++;
    }
  }
  for (const endpoint of [...new Set(dead)]) {
    if (deleteSubscription(db, endpoint)) result.pruned++;
  }
  return result;
}
