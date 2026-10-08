import { useState } from 'react';
import { api, type DayItem } from '../api';
import { runMutation, useResource, type Resource } from '../data';
import { calendarLabel, formatCalendarDate, formatDayLabel, shiftDate } from '../format';
import { Banner, ErrorBanner, Skeleton } from '../ui';
import type { Settings } from '@takalif/core';

const STATUS_LABEL: Record<DayItem['status'], string> = {
  pending: 'Due',
  done: 'Done',
  missed: 'Missed',
  skipped: 'Skipped',
};

const DISMISSED_KEY = 'takalif-recovery-dismissed';

/**
 * Offered after a long absence, when the sweep recorded a wall of failures.
 *
 * "We were away" excuses the whole range at once via the bulk endpoint;
 * without it the only path was one tap per occurrence. Dismissal is stored
 * per range so the same prompt does not nag twice.
 */
function RecoveryBanner({
  from,
  to,
  count,
  ruleIds,
  onDone,
  onReviewRange,
}: {
  from: string;
  to: string;
  count: number;
  ruleIds: string[];
  onDone: () => void;
  onReviewRange: (from: string, to: string) => void;
}) {
  const key = `${from}:${to}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === key;
    } catch {
      return false;
    }
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, key);
    } catch {
      // Private browsing: dismissal lasts the session only. Acceptable.
    }
    setDismissed(true);
  };

  async function excuseAll() {
    setBusy(true);
    setError(null);
    const err = await runMutation(() => api.bulkExcuse({ from, to, ruleIds }));
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    dismiss();
    onDone();
  }

  return (
    <Banner kind="warn">
      <div>
        <strong>
          {count} unlogged occurrence{count === 1 ? '' : 's'}
        </strong>{' '}
        from {formatDayLabel(from)} to {formatDayLabel(to)}, recorded as missed.
      </div>
      {error && <div style={{ marginBlockStart: '0.4rem' }}>{error}</div>}
      <div style={{ display: 'flex', gap: '0.4rem', marginBlockStart: '0.5rem', flexWrap: 'wrap' }}>
        <button type="button" className="btn small" disabled={busy} onClick={excuseAll}>
          {busy ? 'Excusing…' : 'We were away — excuse all'}
        </button>
        <button type="button" className="btn small ghost" onClick={() => onReviewRange(from, to)}>
          Review
        </button>
        <button type="button" className="btn small ghost" onClick={dismiss}>
          Dismiss
        </button>
      </div>
    </Banner>
  );
}

/**
 * A `?date=YYYY-MM-DD` query param deep-links to that day. Notification taps
 * use it so a reminder opens on the day it refers to; anything else is
 * ignored and the view falls back to today.
 */
function initialDateParam(): string | null {
  try {
    const date = new URLSearchParams(window.location.search).get('date');
    return date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  } catch {
    return null;
  }
}

export function TodayView({
  settings,
  onReviewRange,
}: {
  settings: Settings | null;
  onReviewRange: (from: string, to: string) => void;
}) {
  const [date, setDate] = useState<string | null>(initialDateParam);
  const day: Resource<Awaited<ReturnType<typeof api.day>>> = useResource(
    `day:${date ?? 'today'}`,
    () => api.day(date ?? undefined),
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [noteId, setNoteId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  const viewing = date ?? day.data?.today ?? '';
  const isToday = !day.data || viewing === day.data.today;

  async function act(id: string, fn: () => Promise<unknown>): Promise<boolean> {
    setBusyId(id);
    setActionError(null);
    const err = await runMutation(fn);
    setBusyId(null);
    if (err) {
      setActionError(err.message);
      return false;
    }
    day.refresh();
    return true;
  }

  async function saveNote(id: string) {
    if (await act(id, () => api.setNote(id, noteDraft))) setNoteId(null);
  }

  async function clearNote(id: string) {
    if (await act(id, () => api.setNote(id, null))) setNoteId(null);
  }

  return (
    <section aria-label="Today">
      <div className="day-nav">
        <button
          type="button"
          className="btn icon"
          aria-label="Previous day"
          onClick={() => setDate((d) => shiftDate(d ?? day.data?.today ?? '', -1))}
          disabled={!day.data}
        >
          ←
        </button>
        <div className="day-title">
          <strong>{viewing ? formatDayLabel(viewing) : '…'}</strong>
          <span>
            {day.data && settings
              ? formatCalendarDate(viewing, day.data.calendarDate, settings.defaultCalendar)
              : ''}
            {!isToday && day.data ? ` · today is ${formatDayLabel(day.data.today)}` : ''}
          </span>
        </div>
        <button
          type="button"
          className="btn icon"
          aria-label="Next day"
          onClick={() => setDate((d) => shiftDate(d ?? day.data?.today ?? '', 1))}
          disabled={!day.data}
        >
          →
        </button>
      </div>

      {!isToday && (
        <button type="button" className="btn small" onClick={() => setDate(null)}>
          Back to today
        </button>
      )}

      {day.error && <ErrorBanner error={day.error} onRetry={day.refresh} />}
      {actionError && <Banner kind="error">{actionError}</Banner>}
      {day.data?.recoveryPrompt && (
        <RecoveryBanner
          from={day.data.recoveryPrompt.from}
          to={day.data.recoveryPrompt.to}
          count={day.data.recoveryPrompt.count}
          ruleIds={day.data.recoveryPrompt.ruleIds}
          onDone={day.refresh}
          onReviewRange={onReviewRange}
        />
      )}
      {day.data?.failedRules?.length ? (
        <Banner kind="warn">
          {day.data.failedRules.length === 1 ? 'A task' : `${day.data.failedRules.length} tasks`}{' '}
          could not be expanded, so{' '}
          {day.data.failedRules.length === 1 ? 'it is' : 'they are'} generating nothing. Check the
          tasks list.
        </Banner>
      ) : null}
      {day.loading && <Skeleton />}

      {day.data && day.data.items.length === 0 && (
        <div className="empty">
          <p>Nothing due{isToday ? ' today' : ' on this day'}.</p>
          <p className="muted">Enjoy it, or add a task.</p>
        </div>
      )}

      {day.data?.items.map((item) => (
        <article className="card" key={item.id} style={{ marginBlock: '0.5rem' }}>
          <div className="item" style={{ borderBlockEnd: 0, paddingBlock: 0 }}>
            <div className="item-main">
              <div className={`item-title${item.status === 'done' ? ' done' : ''}`}>
                {item.ruleTitle}
              </div>
              <div className="item-meta">
                <span className={`pill ${item.status}`}>{STATUS_LABEL[item.status]}</span>
                {item.ruleCalendar !== 'gregorian' && (
                  <span className="pill hijri">{calendarLabel(item.ruleCalendar)}</span>
                )}
                {item.category && <span>{item.category}</span>}
                {item.dueTime && <span>due {item.dueTime}</span>}
              </div>
              {item.note && noteId !== item.id && <div className="muted">{item.note}</div>}
              {noteId === item.id ? (
                <form
                  style={{ display: 'flex', gap: '0.4rem', marginTop: '0.4rem' }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void saveNote(item.id);
                  }}
                >
                  <input
                    type="text"
                    value={noteDraft}
                    maxLength={500}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder="Add a note…"
                    aria-label="Occurrence note"
                  />
                  <button type="submit" className="btn small primary" disabled={busyId === item.id}>
                    Save
                  </button>
                  {item.note && (
                    <button
                      type="button"
                      className="btn small ghost"
                      disabled={busyId === item.id}
                      onClick={() => void clearNote(item.id)}
                    >
                      Clear
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn small"
                    disabled={busyId === item.id}
                    onClick={() => setNoteId(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <div style={{ marginTop: '0.4rem' }}>
                  <button
                    type="button"
                    className="btn small ghost"
                    disabled={busyId === item.id}
                    onClick={() => {
                      setNoteId(item.id);
                      setNoteDraft(item.note ?? '');
                    }}
                  >
                    {item.note ? 'Edit note' : 'Add note'}
                  </button>
                </div>
              )}
            </div>
            <div className="item-actions">
              {item.status === 'pending' && (
                <>
                  <button
                    type="button"
                    className="btn small primary"
                    disabled={busyId === item.id}
                    onClick={() => act(item.id, () => api.markDone(item.id))}
                  >
                    Done
                  </button>
                  <button
                    type="button"
                    className="btn small"
                    disabled={busyId === item.id}
                    onClick={() => act(item.id, () => api.markMissed(item.id))}
                  >
                    Miss
                  </button>
                </>
              )}
              {item.status === 'done' && (
                <button
                  type="button"
                  className="btn small ghost"
                  disabled={busyId === item.id}
                  onClick={() => act(item.id, () => api.reset(item.id))}
                >
                  Undo
                </button>
              )}
              {item.status === 'missed' && (
                <button
                  type="button"
                  className="btn small ghost"
                  disabled={busyId === item.id}
                  onClick={() => act(item.id, () => api.excuse(item.id))}
                >
                  Excuse
                </button>
              )}
            </div>
          </div>
        </article>
      ))}
    </section>
  );
}
