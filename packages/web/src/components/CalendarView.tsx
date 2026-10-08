import { useMemo, useState } from 'react';
import { toHijri, type Settings } from '@takalif/core';
import { api, type DayItem } from '../api';
import { monthFirst, monthGrid, shiftMonth, weekDays, weekStart } from '../calendar';
import { useResource } from '../data';
import { formatCalendarDate, formatDayLabel, shiftDate, todayUTC } from '../format';
import { Banner, ErrorBanner, Skeleton } from '../ui';

type Mode = 'week' | 'month';

const MODE_KEY = 'takalif-calendar-mode';
const MAX_SHOWN = 4; // week list rows before "+n more"
const MAX_DOTS = 5; // month-cell dots; the title/aria-label always carries full counts
// Any known Monday: weekday header labels must start Monday to match the grid.
const KNOWN_MONDAY = '2026-10-05';
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function storedMode(): Mode {
  try {
    return localStorage.getItem(MODE_KEY) === 'month' ? 'month' : 'week';
  } catch {
    return 'week';
  }
}

function groupByDate(items: DayItem[]): Map<string, DayItem[]> {
  const map = new Map<string, DayItem[]>();
  for (const item of items) {
    const list = map.get(item.scheduledDate) ?? [];
    list.push(item);
    map.set(item.scheduledDate, list);
  }
  return map;
}

function hijriSub(date: string, settings: Settings | null): string | null {
  const calendar = settings?.defaultCalendar ?? 'gregorian';
  if (calendar === 'gregorian') return null;
  try {
    return formatCalendarDate(date, toHijri(date, calendar), calendar);
  } catch {
    return null;
  }
}

function Dots({ items }: { items: DayItem[] }) {
  const shown = items.slice(0, MAX_DOTS);
  const counts = items.reduce<Record<string, number>>((acc, i) => {
    acc[i.status] = (acc[i.status] ?? 0) + 1;
    return acc;
  }, {});
  const label = Object.entries(counts)
    .map(([status, n]) => `${n} ${status}`)
    .join(', ');
  return (
    <span className="cal-dots" role="img" aria-label={label}>
      {shown.map((i) => (
        <span key={i.id} className={`cal-dot ${i.status}`} />
      ))}
    </span>
  );
}

export function CalendarView({
  settings,
  onSelectDate,
}: {
  settings: Settings | null;
  onSelectDate: (date: string) => void;
}) {
  const [mode, setModeState] = useState<Mode>(storedMode);
  const todayRes = useResource('calendar:today', () => api.day());
  const serverToday = todayRes.data?.today ?? null;
  // Null means "follow today". Paging sets an explicit cursor. Local on
  // purpose: returning to the tab re-anchors to today, while the mode persists.
  const [anchor, setAnchor] = useState<string | null>(null);
  // Gate the range on the server's today: rendering from the UTC fallback
  // first would fetch (and flash) the wrong week near midnight.
  const base = anchor ?? serverToday ?? (todayRes.error ? todayUTC() : null);

  interface Range {
    from: string;
    to: string;
    cells: string[];
    month?: number;
    year?: number;
  }

  const range: Range | null = useMemo(() => {
    if (!base) return null;
    if (mode === 'week') {
      const from = weekStart(base);
      return { from, to: shiftDate(from, 6), cells: weekDays(from) };
    }
    const first = monthFirst(base);
    const y = Number(first.slice(0, 4));
    const m = Number(first.slice(5, 7));
    const cells = monthGrid(y, m);
    return { from: cells[0]!, to: cells[cells.length - 1]!, cells, month: m, year: y };
  }, [mode, base]);

  const occ = useResource(`calendar:${mode}:${range ? `${range.from}:${range.to}` : 'pending'}`, () =>
    range ? api.occurrences(range.from, range.to) : Promise.resolve([]),
  );
  const byDate = useMemo(() => groupByDate(occ.data ?? []), [occ.data]);
  const rangeEmpty = !occ.data || occ.data.length === 0;
  const viewedPrefix =
    range && range.month
      ? `${range.year}-${String(range.month).padStart(2, '0')}`
      : null;

  function setMode(m: Mode) {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      // Private browsing: the choice lasts the session only. Acceptable.
    }
  }

  function step(delta: -1 | 1) {
    if (!base) return;
    if (mode === 'week') setAnchor(shiftDate(weekStart(base), delta * 7));
    else setAnchor(shiftMonth(monthFirst(base), delta));
  }

  const span = mode === 'week' ? 'week' : 'month';
  const title = !range
    ? 'Calendar'
    : mode === 'week'
      ? `Week of ${formatDayLabel(range.from)}`
      : `${MONTH_NAMES[(range.month ?? 1) - 1]} ${range.year}`;
  const weekdays = weekDays(weekStart(KNOWN_MONDAY)).map((d) => formatDayLabel(d).split(' ')[0]);

  return (
    <section aria-label="Calendar">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>{title}</h2>
        <div className="day-picker" role="group" aria-label="Calendar view">
          <button
            type="button"
            className="day-chip"
            aria-pressed={mode === 'week'}
            onClick={() => setMode('week')}
          >
            Week
          </button>
          <button
            type="button"
            className="day-chip"
            aria-pressed={mode === 'month'}
            onClick={() => setMode('month')}
          >
            Month
          </button>
        </div>
      </div>

      <div className="day-nav">
        <button
          type="button"
          className="btn icon"
          aria-label={`Previous ${span}`}
          onClick={() => step(-1)}
        >
          ←
        </button>
        <button type="button" className="btn small" onClick={() => setAnchor(null)}>
          This {span}
        </button>
        <button
          type="button"
          className="btn icon"
          aria-label={`Next ${span}`}
          onClick={() => step(1)}
        >
          →
        </button>
      </div>

      {todayRes.error && <ErrorBanner error={todayRes.error} onRetry={todayRes.refresh} />}
      {occ.error && <ErrorBanner error={occ.error} onRetry={occ.refresh} />}
      {(!range || todayRes.loading || occ.loading) && <Skeleton />}

      {range && mode === 'week' && occ.data && (
        <div className="cal-week">
          {range.cells.map((d) => {
            const items = byDate.get(d) ?? [];
            const sub = hijriSub(d, settings);
            return (
              <article
                key={d}
                className={`card cal-day${d === serverToday ? ' cal-today' : ''}`}
              >
                <button
                  type="button"
                  className="cal-dayhead"
                  onClick={() => onSelectDate(d)}
                  aria-label={`${formatDayLabel(d)}, open day view`}
                >
                  <strong>{formatDayLabel(d)}</strong>
                  {sub && <span className="muted">{sub}</span>}
                </button>
                {items.length === 0 && !rangeEmpty && (
                  <div className="muted">Nothing due.</div>
                )}
                {items.slice(0, MAX_SHOWN).map((i) => (
                  <div key={i.id} className="cal-item">
                    <span className={`cal-dot ${i.status}`} aria-hidden="true" />
                    <span className={`item-title${i.status === 'done' ? ' done' : ''}`}>
                      {i.ruleTitle}
                    </span>
                    {i.dueTime && <span className="muted">{i.dueTime}</span>}
                  </div>
                ))}
                {items.length > MAX_SHOWN && (
                  <div className="muted">+{items.length - MAX_SHOWN} more</div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {range && mode === 'month' && occ.data && (
        <>
          <div className="cal-month" role="group" aria-label={title}>
            {weekdays.map((w) => (
              <div key={w} className="cal-dow" aria-hidden="true">
                {w}
              </div>
            ))}
            {range.cells.map((d) => {
              const inMonth = viewedPrefix !== null && d.slice(0, 7) === viewedPrefix;
              const items = byDate.get(d) ?? [];
              const sub = hijriSub(d, settings);
              return (
                <button
                  key={d}
                  type="button"
                  className={`cal-cell${inMonth ? '' : ' cal-outside'}${
                    d === serverToday ? ' cal-today' : ''
                  }`}
                  onClick={() => onSelectDate(d)}
                  aria-label={`${formatDayLabel(d)}: ${
                    items.length === 0
                      ? 'nothing due'
                      : items.map((i) => `${i.ruleTitle} (${i.status})`).join(', ')
                  }`}
                >
                  <span className="cal-num">{Number(d.slice(8, 10))}</span>
                  {sub && <span className="cal-sub">{sub}</span>}
                  {items.length > 0 && <Dots items={items} />}
                </button>
              );
            })}
          </div>
          <p className="muted">
            Dots follow the day status: green done, red missed, amber skipped, grey due.
            Pending never reads as failure.
          </p>
        </>
      )}

      {range && occ.data && occ.data.length === 0 && (
        <Banner kind="info">Nothing due in this {span}.</Banner>
      )}
    </section>
  );
}
