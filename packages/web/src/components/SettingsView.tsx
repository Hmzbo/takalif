import { useEffect, useState } from 'react';
import type { Settings } from '@takalif/core';
import { api, ApiError } from '../api';
import { runMutation } from '../data';
import { CALENDAR_OPTIONS } from '../format';
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
      },
      (e: unknown) => {
        if (live) setLoadError(e instanceof ApiError ? e : new ApiError(0, String(e)));
      },
    );
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
          {failedRules === 1 ? 'A rule' : `${failedRules} rules`} could not be expanded after
          this change. A rule that generates nothing also shrinks its adherence denominator.
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
          hint="Display preference and the default for new rules. Rules may each use any calendar."
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
