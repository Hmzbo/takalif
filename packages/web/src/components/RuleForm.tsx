import { useEffect, useMemo, useState } from 'react';
import type { CalendarKind, Rule } from '@takalif/core';
import { api, ApiError, type EditPreview } from '../api';
import { CALENDAR_OPTIONS } from '../format';
import {
  buildRRule,
  describeRRule,
  parseMonthDays,
  PRESETS,
  WEEKDAYS,
  type PresetKind,
  type WeekdayKey,
} from '../rrulePresets';
import { Banner, Field } from '../ui';

export interface RuleFormValue {
  title: string;
  description: string;
  rrule: string;
  calendar: CalendarKind;
  dtstartDate: string;
  dueTime: string;
  reminderTime: string;
  trackStreak: boolean;
  category: string;
  effectiveFrom: string;
}

function initialValue(rule: Rule | null, today: string): RuleFormValue {
  return {
    title: rule?.title ?? '',
    description: rule?.description ?? '',
    rrule: rule?.rrule ?? 'FREQ=DAILY',
    calendar: rule?.calendar ?? 'gregorian',
    dtstartDate: rule?.dtstartDate ?? today,
    dueTime: rule?.dueTime ?? '',
    reminderTime: rule?.reminderTime ?? '',
    trackStreak: rule?.trackStreak ?? false,
    category: rule?.category ?? '',
    effectiveFrom: today,
  };
}

export function RuleForm({
  rule,
  today = '',
  onSaved,
  onCancel,
}: {
  /** Null for create, a rule for edit. */
  rule: Rule | null;
  /**
   * Civil date used to prefill "starts on" and "effective from". Empty means
   * "leave blank and let the server default to its own today".
   */
  today?: string;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState<RuleFormValue>(() => initialValue(rule, today));
  const [preset, setPreset] = useState<PresetKind>('daily');
  const [days, setDays] = useState<WeekdayKey[]>(['MO']);
  const [monthDays, setMonthDays] = useState('1');
  const [interval, setInterval] = useState('1');
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<EditPreview | null>(null);

  const set = <K extends keyof RuleFormValue>(key: K, v: RuleFormValue[K]) =>
    setValue((prev) => ({ ...prev, [key]: v }));

  // In create mode the RRULE follows the preset; in edit mode the stored
  // value is authoritative and the user edits it as raw text.
  const building = rule === null && preset !== 'custom';
  useEffect(() => {
    if (!building) return;
    set(
      'rrule',
      buildRRule({
        kind: preset,
        days,
        monthDays: parseMonthDays(monthDays),
        interval: Number(interval) || 1,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [building, preset, days, monthDays, interval]);

  useEffect(() => {
    if (rule !== null || preset !== 'custom') return;
    set('rrule', custom.trim());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [custom, preset]);

  // Edit preview, debounced. Read-only by design: it never writes.
  useEffect(() => {
    if (!rule) {
      setPreview(null);
      return;
    }
    const timer = setTimeout(() => {
      api
        .editPreview(rule.id, {
          rrule: value.rrule,
          dtstartDate: value.dtstartDate,
          effectiveFrom: value.effectiveFrom,
        })
        .then(setPreview, () => setPreview(null));
    }, 400);
    return () => clearTimeout(timer);
  }, [rule, value.rrule, value.dtstartDate, value.effectiveFrom]);

  const previewText = useMemo(() => {
    try {
      return describeRRule(value.rrule);
    } catch {
      return value.rrule;
    }
  }, [value.rrule]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!value.title.trim()) {
      setError('A title is required.');
      return;
    }
    if (!value.rrule.trim()) {
      setError('A schedule is required.');
      return;
    }
    setSaving(true);
    try {
      if (rule) {
        await api.updateRule(rule.id, {
          title: value.title.trim(),
          description: value.description.trim() || null,
          rrule: value.rrule.trim(),
          dtstartDate: value.dtstartDate || undefined,
          dueTime: value.dueTime || null,
          reminderTime: value.reminderTime || null,
          calendar: value.calendar,
          trackStreak: value.trackStreak,
          category: value.category.trim() || null,
          effectiveFrom: value.effectiveFrom || undefined,
        });
      } else {
        await api.createRule({
          title: value.title.trim(),
          description: value.description.trim() || null,
          rrule: value.rrule.trim(),
          dtstartDate: value.dtstartDate || undefined,
          dueTime: value.dueTime || null,
          reminderTime: value.reminderTime || null,
          calendar: value.calendar,
          trackStreak: value.trackStreak,
          category: value.category.trim() || null,
        });
      }
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function toggleDay(d: WeekdayKey) {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]));
  }

  // Edit mode starts with the stored schedule shown read-only; the user opts
  // into raw RRULE editing explicitly. Presets are a creation-time convenience,
  // not something that should ever silently rewrite an existing schedule.
  const [editingSchedule, setEditingSchedule] = useState(false);

  return (
    <form onSubmit={submit} aria-label={rule ? 'Edit rule' : 'New rule'}>
      <Field label="Title">
        <input
          type="text"
          value={value.title}
          maxLength={500}
          onChange={(e) => set('title', e.target.value)}
          placeholder="e.g. Workout"
          autoFocus
        />
      </Field>

      <Field label="Description (optional)">
        <textarea
          value={value.description}
          maxLength={500}
          onChange={(e) => set('description', e.target.value)}
          placeholder="Anything you want to remember about this commitment."
        />
      </Field>

      {rule === null && (
        <Field label="Schedule">
          <select value={preset} onChange={(e) => setPreset(e.target.value as PresetKind)}>
            {PRESETS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.label} — {p.hint}
              </option>
            ))}
          </select>
        </Field>
      )}

      {rule === null && preset === 'weekly' && (
        <div className="field">
          <label>Days of the week</label>
          <div className="day-picker" role="group" aria-label="Days of the week">
            {WEEKDAYS.map((w) => (
              <button
                key={w.key}
                type="button"
                className="day-chip"
                aria-pressed={days.includes(w.key)}
                onClick={() => toggleDay(w.key)}
              >
                {w.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {rule === null && preset === 'monthly' && (
        <Field label="Days of the month" hint='Comma-separated, e.g. "1, 15". A day that does not exist in a month is skipped, never moved.'>
          <input
            type="text"
            value={monthDays}
            inputMode="numeric"
            onChange={(e) => setMonthDays(e.target.value)}
            placeholder="1, 15"
          />
        </Field>
      )}

      {rule === null && preset !== 'custom' && preset !== 'weekdays' && (
        <Field label="Every N (1 = every time)" hint="2 means every second day, week or month.">
          <input
            type="number"
            min={1}
            max={365}
            value={interval}
            onChange={(e) => setInterval(e.target.value)}
          />
        </Field>
      )}

      {((rule === null && preset === 'custom') || (rule !== null && editingSchedule)) && (
        <Field label="RRULE" hint="A bare RFC 5545 value, e.g. FREQ=WEEKLY;BYDAY=TU;INTERVAL=2.">
          <input
            type="text"
            className="mono"
            value={rule === null ? custom : value.rrule}
            onChange={(e) => {
              if (rule === null) setCustom(e.target.value);
              else set('rrule', e.target.value);
            }}
            placeholder="FREQ=WEEKLY;BYDAY=TU;INTERVAL=2"
          />
        </Field>
      )}

      {rule === null && preset !== 'custom' && (
        <Banner kind="info">
          Will create: <span className="mono">{value.rrule || '…'}</span>
          {value.rrule ? ` · ${previewText}` : ''}
        </Banner>
      )}

      {rule !== null && !editingSchedule && (
        <div className="field">
          <label>Schedule</label>
          <div className="muted">
            <span className="mono">{value.rrule}</span> · {previewText}
          </div>
          <button
            type="button"
            className="btn small ghost"
            onClick={() => setEditingSchedule(true)}
          >
            Change schedule…
          </button>
        </div>
      )}

      <Field label="Calendar" hint="Month and day anchors are interpreted in this calendar.">
        <select
          value={value.calendar}
          onChange={(e) => set('calendar', e.target.value as CalendarKind)}
        >
          {CALENDAR_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Starts on" hint="Nothing is ever materialised before the rule was created; backdate deliberately by moving this.">
        <input type="date" value={value.dtstartDate} onChange={(e) => set('dtstartDate', e.target.value)} />
      </Field>

      <Field label="Due time (optional)" hint="When set, lateness becomes measurable.">
        <input type="time" value={value.dueTime} onChange={(e) => set('dueTime', e.target.value)} />
      </Field>

      <Field
        label="Remind me at (optional)"
        hint="The server sends a push notification at this time on days this rule is due. Leave empty for no reminder."
      >
        <input
          type="time"
          value={value.reminderTime}
          onChange={(e) => set('reminderTime', e.target.value)}
        />
      </Field>

      <Field label="Category (optional)">
        <input
          type="text"
          value={value.category}
          maxLength={500}
          onChange={(e) => set('category', e.target.value)}
          placeholder="e.g. health"
        />
      </Field>

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={value.trackStreak}
          onChange={(e) => set('trackStreak', e.target.checked)}
        />
        Track a streak for this rule
      </label>

      {rule && (
        <Field
          label="Effective from"
          hint="Schedule edits open a new version from this date. Settled history is never rewritten."
        >
          <input
            type="date"
            value={value.effectiveFrom}
            onChange={(e) => set('effectiveFrom', e.target.value)}
          />
        </Field>
      )}

      {rule && preview?.changed && (
        <Banner kind="info">
          This change would add {preview.added.length} occurrence
          {preview.added.length === 1 ? '' : 's'}
          {preview.added.length > 0 && (
            <>
              {' '}({preview.added.slice(0, 5).join(', ')}
              {preview.added.length > 5 ? `, +${preview.added.length - 5} more` : ''})
            </>
          )}
          {preview.withdrawn.length > 0 &&
            `, withdraw ${preview.withdrawn.length} unlogged occurrence${preview.withdrawn.length === 1 ? '' : 's'}`}
          {preview.neutralised.length > 0 &&
            `, and mark ${preview.neutralised.length} as skipped`}
          .
        </Banner>
      )}

      {error && <Banner kind="error">{error}</Banner>}

      <div className="form-actions">
        <button type="button" className="btn" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" className="btn primary" disabled={saving}>
          {saving ? 'Saving…' : rule ? 'Save changes' : 'Create rule'}
        </button>
      </div>
    </form>
  );
}
