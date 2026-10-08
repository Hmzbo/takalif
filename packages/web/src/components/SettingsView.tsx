import { useEffect, useState } from 'react';
import type { Settings, SkipPeriod } from '@takalif/core';
import { api, ApiError } from '../api';
import { runMutation } from '../data';
import { CALENDAR_OPTIONS } from '../format';
import {
  pushState,
  pushSupported,
  subscribeBrowser,
  unsubscribeBrowser,
  type PushState,
} from '../push';
import { Banner, Field } from '../ui';

/** Common IANA zones for the datalist. Anything valid also works typed by hand. */
const COMMON_ZONES = [
  'UTC',
  'Europe/London',
  'Europe/Warsaw',
  'Europe/Berlin',
  'Europe/Paris',
  'Africa/Cairo',
  'Asia/Dubai',
  'Asia/Riyadh',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Jakarta',
  'Asia/Singapore',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Sao_Paulo',
];

function allZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    if (typeof supported === 'function') return supported('timeZone');
  } catch {
    // Fall through to the curated list.
  }
  return COMMON_ZONES;
}

/**
 * Shows how this device reaches the server, and — when opened via loopback —
 * what a phone on the same network needs instead. The client cannot discover
 * the PC's LAN address, so it says how to find it rather than guessing.
 */
function ConnectionHint() {
  let origin: string | null = null;
  let loopback = false;
  try {
    origin = window.location.origin;
    const host = window.location.hostname;
    loopback = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    origin = null;
  }
  if (!origin) return null;
  return (
    <div>
      <p className="muted" style={{ marginBlock: '0 0.4rem' }}>
        This device reaches the server at <span className="mono">{origin}</span>.
      </p>
      {loopback && (
        <Banner kind="info">
          A phone cannot use that address — on the phone, <em>localhost</em> means the
          phone itself. On the same WiFi, open{' '}
          <span className="mono">http://&lt;PC-LAN-IP&gt;:8787</span> instead (Windows:{' '}
          <span className="mono">ipconfig</span> → IPv4), with Windows firewall open on
          8787.
        </Banner>
      )}
    </div>
  );
}

export function SettingsView({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failedRules, setFailedRules] = useState(0);

  const [timezone, setTimezone] = useState('');
  const [dayRollover, setDayRollover] = useState('04:00');
  const [lookbackDays, setLookbackDays] = useState('30');
  const [lookaheadDays, setLookaheadDays] = useState('14');
  const [defaultCalendar, setDefaultCalendar] = useState('gregorian');
  const [email, setEmail] = useState('');
  const [ntfyTopic, setNtfyTopic] = useState('');
  const [ntfyServer, setNtfyServer] = useState('');
  const [push, setPush] = useState<PushState | null>(null);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMessage, setPushMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(
    null,
  );
  const [importBusy, setImportBusy] = useState(false);
  const [importMessage, setImportMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(
    null,
  );
  const [periods, setPeriods] = useState<SkipPeriod[] | null>(null);
  const [skStart, setSkStart] = useState('');
  const [skEnd, setSkEnd] = useState('');
  const [skReason, setSkReason] = useState('');
  const [skipsBusy, setSkipsBusy] = useState(false);
  const [skipsMessage, setSkipsMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(
    null,
  );
  const [confirmDeleteSkip, setConfirmDeleteSkip] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.settings().then(
      (s) => {
        if (!live) return;
        setSettings(s);
        setTimezone(s.timezone);
        setDayRollover(s.dayRollover);
        setLookbackDays(String(s.lookbackDays));
        setLookaheadDays(String(s.lookaheadDays));
        setDefaultCalendar(s.defaultCalendar);
        setEmail(s.email ?? '');
        setNtfyTopic(s.ntfyTopic ?? '');
        setNtfyServer(s.ntfyServer ?? '');
      },
      (e: unknown) => {
        if (live) setLoadError(e instanceof ApiError ? e : new ApiError(0, String(e)));
      },
    );
    void pushState().then((state) => {
      if (live) setPush(state);
    });
    void api
      .skipPeriods()
      .then((p) => {
        if (live) setPeriods(p);
      })
      .catch(() => {
        if (live) setPeriods([]);
      });
    return () => {
      live = false;
    };
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    const err = await runMutation(async () => {
      const updated = await api.updateSettings({
        timezone: timezone.trim(),
        dayRollover: dayRollover || undefined,
        lookbackDays: lookbackDays === '' ? undefined : Number(lookbackDays),
        lookaheadDays: lookaheadDays === '' ? undefined : Number(lookaheadDays),
        defaultCalendar: defaultCalendar as Settings['defaultCalendar'],
        email: email.trim() || null,
        ntfyTopic: ntfyTopic.trim() || null,
        ntfyServer: ntfyServer.trim() || null,
      });
      setSettings(updated);
      setFailedRules(updated.failedRules.length);
    });
    setSaving(false);
    if (err) {
      setSaveError(err.message);
      return;
    }
    setSaved(true);
    onChanged();
  }

  async function enablePush() {
    setPushBusy(true);
    setPushMessage(null);
    try {
      const { publicKey } = await api.pushPublicKey();
      const sub = await subscribeBrowser(publicKey);
      await api.pushSubscribe(sub);
      setPush({ kind: 'subscribed', endpoint: sub.endpoint });
      setPushMessage({ kind: 'info', text: 'This device will now receive reminders.' });
    } catch (e) {
      setPushMessage({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) });
      setPush(await pushState());
    } finally {
      setPushBusy(false);
    }
  }

  async function disablePush() {
    setPushBusy(true);
    setPushMessage(null);
    try {
      const endpoint = await unsubscribeBrowser();
      if (endpoint) await api.pushUnsubscribe(endpoint);
      setPush(await pushState());
      setPushMessage({ kind: 'info', text: 'This device will no longer receive reminders.' });
    } catch (e) {
      setPushMessage({ kind: 'error', text: e instanceof ApiError ? e.message : String(e) });
    } finally {
      setPushBusy(false);
    }
  }

  async function testPush() {
    setPushBusy(true);
    setPushMessage(null);
    const err = await runMutation(async () => {
      const result = await api.pushTest();
      if (result.sent === 0) {
        throw new Error('Nothing was sent: no device subscribed and no ntfy topic set.');
      }
      setPushMessage({
        kind: 'info',
        text:
          `Sent ${result.sent} notification${result.sent === 1 ? '' : 's'}` +
          (result.pruned > 0 ? `, removed ${result.pruned} dead subscription(s)` : '') +
          '.',
      });
    });
    if (err) setPushMessage({ kind: 'error', text: err.message });
    setPushBusy(false);
  }

  async function importBackup(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!window.confirm(`Replace everything on this server with ${file.name}? This cannot be undone.`)) {
      return;
    }
    setImportBusy(true);
    setImportMessage(null);
    const err = await runMutation(async () => {
      const doc = JSON.parse(await file.text());
      const result = await api.importBackup(doc);
      setImportMessage({
        kind: 'info',
        text: `Restored ${result.rules} task(s) and ${result.occurrences} occurrence(s).`,
      });
      onChanged();
    });
    if (err) setImportMessage({ kind: 'error', text: err.message });
    setImportBusy(false);
  }

  async function reloadPeriods() {
    try {
      setPeriods(await api.skipPeriods());
    } catch {
      setPeriods([]);
    }
  }

  async function addSkipPeriod() {
    if (!skStart) return;
    setSkipsBusy(true);
    setSkipsMessage(null);
    const err = await runMutation(async () => {
      await api.createSkipPeriod({
        startDate: skStart,
        endDate: skEnd || skStart,
        reason: skReason.trim() || null,
      });
      setSkStart('');
      setSkEnd('');
      setSkReason('');
      setSkipsMessage({ kind: 'info', text: 'Added. Days in this range leave your adherence figures.' });
      await reloadPeriods();
      onChanged();
    });
    if (err) setSkipsMessage({ kind: 'error', text: err.message });
    setSkipsBusy(false);
  }

  async function deleteSkipPeriod(id: string) {
    setSkipsBusy(true);
    setSkipsMessage(null);
    const err = await runMutation(async () => {
      await api.deleteSkipPeriod(id);
      setConfirmDeleteSkip(null);
      await reloadPeriods();
      onChanged();
    });
    if (err) setSkipsMessage({ kind: 'error', text: err.message });
    setSkipsBusy(false);
  }

  if (loadError) {
    return (
      <section aria-label="Settings">
        <h2>Settings</h2>
        <Banner kind="error">{loadError.message}</Banner>
      </section>
    );
  }

  if (!settings) {
    return (
      <section aria-label="Settings">
        <h2>Settings</h2>
        <div className="skeleton" />
      </section>
    );
  }

  return (
    <section aria-label="Settings">
      <h2>Settings</h2>
      {failedRules > 0 && (
        <Banner kind="warn">
          {failedRules === 1 ? 'A task' : `${failedRules} tasks`} could not be expanded after
          this change. A task that generates nothing also shrinks its adherence denominator.
        </Banner>
      )}
      <form onSubmit={save}>
        <Field label="Timezone" hint="Server-side. Your phone and laptop always agree on what today is.">
          <input
            type="text"
            list="timezones"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            placeholder="Europe/Warsaw"
          />
          <datalist id="timezones">
            {allZones().map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </Field>

        <Field
          label="Day rollover"
          hint="A day labelled D stays open until this time on D+1. Without it, everything done after dinner counts as missed."
        >
          <input type="time" value={dayRollover} onChange={(e) => setDayRollover(e.target.value)} />
        </Field>

        <Field
          label="Default calendar"
          hint="Display preference and the default for new tasks. Tasks may each use any calendar."
        >
          <select value={defaultCalendar} onChange={(e) => setDefaultCalendar(e.target.value)}>
            {CALENDAR_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="History kept (days)" hint="How far back the ledger materialises.">
          <input
            type="number"
            min={0}
            max={3660}
            value={lookbackDays}
            onChange={(e) => setLookbackDays(e.target.value)}
          />
        </Field>

        <Field label="Planned ahead (days)" hint="How far forward occurrences are generated.">
          <input
            type="number"
            min={0}
            max={3660}
            value={lookaheadDays}
            onChange={(e) => setLookaheadDays(e.target.value)}
          />
        </Field>

        <Field label="Email (optional)" hint="Destination for reminder fallbacks.">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </Field>

        <Field
          label="ntfy topic (optional)"
          hint="Reminder fallback that needs no account: install ntfy on your phone, subscribe to this topic, and reminders arrive there too."
        >
          <input
            type="text"
            value={ntfyTopic}
            maxLength={64}
            onChange={(e) => setNtfyTopic(e.target.value)}
            placeholder="takalif-reminders"
          />
        </Field>

        <Field label="ntfy server (optional)" hint="Empty means the public ntfy.sh. Self-hosters can point at their own.">
          <input
            type="text"
            value={ntfyServer}
            maxLength={200}
            onChange={(e) => setNtfyServer(e.target.value)}
            placeholder="https://ntfy.sh"
          />
        </Field>

        <h3 className="section-title">Notifications</h3>
        {!pushSupported() && (
          <Banner kind="warn">
            This browser does not support push notifications. Use ntfy above as the fallback.
          </Banner>
        )}
        {push?.kind === 'denied' && (
          <Banner kind="warn">
            Notifications are blocked for this site. Allow them in the browser settings first.
          </Banner>
        )}
        {push?.kind === 'subscribed' ? (
          <div className="row-between">
            <span className="muted">This device receives reminders.</span>
            <span style={{ display: 'flex', gap: '0.4rem' }}>
              <button type="button" className="btn small" disabled={pushBusy} onClick={testPush}>
                Send test
              </button>
              <button type="button" className="btn small" disabled={pushBusy} onClick={disablePush}>
                Disable
              </button>
            </span>
          </div>
        ) : (
          pushSupported() &&
          push?.kind !== 'denied' && (
            <div className="row-between">
              <span className="muted">Reminders appear only if a channel below delivers them.</span>
              <span style={{ display: 'flex', gap: '0.4rem' }}>
                <button type="button" className="btn small" disabled={pushBusy} onClick={testPush}>
                  Send test
                </button>
                <button
                  type="button"
                  className="btn small primary"
                  disabled={pushBusy}
                  onClick={enablePush}
                >
                  Enable on this device
                </button>
              </span>
            </div>
          )
        )}
        {pushMessage && <Banner kind={pushMessage.kind}>{pushMessage.text}</Banner>}

        <h3 className="section-title">Connection</h3>
        <ConnectionHint />

        <h3 className="section-title">Data</h3>
        <p className="muted">
          The JSON backup holds everything and restores it. The CSV is the ledger for
          spreadsheets; the ICS file carries the schedules to any calendar tool.
        </p>
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
          <a className="btn small" href={api.exportUrls.backupJson} download>
            Download backup (JSON)
          </a>
          <a className="btn small" href={api.exportUrls.ledgerCsv} download>
            Download ledger (CSV)
          </a>
          <a className="btn small" href={api.exportUrls.rulesVtodo} download>
            Download schedules (ICS)
          </a>
        </div>
        <Field
          label="Restore from backup"
          hint="Replaces tasks, history and settings with the backup file. This device's push subscription stays as it is. This cannot be undone."
        >
          <input
            type="file"
            accept="application/json,.json"
            disabled={importBusy}
            onChange={importBackup}
          />
        </Field>
        {importMessage && <Banner kind={importMessage.kind}>{importMessage.text}</Banner>}

        <h3 className="section-title">Time away</h3>
        <p className="muted">
          Mark a date range as away — a holiday, illness, anything that should not count
          against adherence. Days in the range leave the denominator; completing one
          anyway still counts as a success.
        </p>
        {periods !== null && periods.length > 0 && (
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 0.6rem' }}>
            {periods.map((p) => (
              <li key={p.id} className="row-between" style={{ paddingBlock: '0.3rem' }}>
                <span>
                  {p.startDate} → {p.endDate}
                  {p.reason && <span className="muted"> · {p.reason}</span>}
                </span>
                {confirmDeleteSkip === p.id ? (
                  <span style={{ display: 'flex', gap: '0.4rem' }}>
                    <button
                      type="button"
                      className="btn small"
                      disabled={skipsBusy}
                      onClick={() => void deleteSkipPeriod(p.id)}
                    >
                      Confirm
                    </button>
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={skipsBusy}
                      onClick={() => setConfirmDeleteSkip(null)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={skipsBusy}
                    onClick={() => setConfirmDeleteSkip(p.id)}
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {/* A <div>, not a <form>: this section lives inside the settings form
            and HTML forbids nested forms — a submit button here would save
            settings instead of adding the range. */}
        <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'end' }}>
          <label className="muted">
            From
            <input type="date" value={skStart} onChange={(e) => setSkStart(e.target.value)} />
          </label>
          <label className="muted">
            To
            <input
              type="date"
              value={skEnd}
              min={skStart || undefined}
              onChange={(e) => setSkEnd(e.target.value)}
            />
          </label>
          <label className="muted" style={{ flexGrow: 1 }}>
            Reason (optional)
            <input
              type="text"
              value={skReason}
              maxLength={500}
              onChange={(e) => setSkReason(e.target.value)}
              placeholder="Summer holiday"
            />
          </label>
          <button
            type="button"
            className="btn small primary"
            disabled={skipsBusy || !skStart}
            onClick={() => void addSkipPeriod()}
          >
            {skipsBusy ? 'Adding…' : 'Add'}
          </button>
        </div>
        {skipsMessage && <Banner kind={skipsMessage.kind}>{skipsMessage.text}</Banner>}

        {saveError && <Banner kind="error">{saveError}</Banner>}
        {saved && <Banner kind="info">Saved.</Banner>}

        <div className="form-actions">
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save settings'}
          </button>
        </div>
      </form>
    </section>
  );
}
