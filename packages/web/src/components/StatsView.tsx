import { useEffect, useState } from 'react';
import type { PeriodReport } from '@takalif/core';
import { api } from '../api';
import { useResource, type Resource } from '../data';
import { formatAdherence, formatCounts } from '../format';
import { buildSparkline } from '../sparkline';
import { ErrorBanner, Skeleton } from '../ui';

type RangeSelection =
  | { mode: 'preset'; preset: 'week' | 'month' | 'quarter' | 'year' }
  | { mode: 'custom'; from: string; to: string };

const PRESET_LABELS: { preset: 'week' | 'month' | 'quarter' | 'year'; label: string }[] = [
  { preset: 'week', label: 'Week' },
  { preset: 'month', label: 'Month' },
  { preset: 'quarter', label: 'Quarter' },
  { preset: 'year', label: 'Year' },
];

export interface ReviewRange {
  from: string;
  to: string;
}

function rangeKey(range: RangeSelection): string {
  return range.mode === 'preset' ? `preset:${range.preset}` : `custom:${range.from}:${range.to}`;
}

/** Short month label for a trend bucket, e.g. `2026-09-01` → `Sep`. */
function bucketLabel(bucket: string): string {
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return months[Number(bucket.slice(5, 7)) - 1] ?? bucket.slice(0, 7);
}

export function StatsView({
  reviewRange,
  reviewNonce,
}: {
  /** Set by the recovery prompt's "Review" action; applied when `reviewNonce` changes. */
  reviewRange: ReviewRange | null;
  reviewNonce: number;
}) {
  const [range, setRange] = useState<RangeSelection>({ mode: 'preset', preset: 'month' });
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  useEffect(() => {
    if (reviewRange) {
      setRange({ mode: 'custom', from: reviewRange.from, to: reviewRange.to });
      setCustomFrom(reviewRange.from);
      setCustomTo(reviewRange.to);
    }
    // Only the nonce drives this; the range object identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewNonce]);

  const report: Resource<PeriodReport> = useResource(rangeKey(range), () =>
    range.mode === 'preset'
      ? api.stats(range.preset)
      : api.stats(undefined, range.from, range.to),
  );

  async function applyCustom(e: React.FormEvent) {
    e.preventDefault();
    if (!customFrom || !customTo) return;
    setRange({ mode: 'custom', from: customFrom, to: customTo });
  }

  const overall = report.data?.overall;

  return (
    <section aria-label="Statistics">
      <h2 style={{ marginBlock: '0.5rem 0' }}>Adherence</h2>

      <div className="day-picker" role="group" aria-label="Range" style={{ marginBlock: '0.75rem' }}>
        {PRESET_LABELS.map((p) => (
          <button
            key={p.preset}
            type="button"
            className="day-chip"
            aria-pressed={range.mode === 'preset' && range.preset === p.preset}
            onClick={() => setRange({ mode: 'preset', preset: p.preset })}
          >
            {p.label}
          </button>
        ))}
      </div>

      <form onSubmit={applyCustom} aria-label="Custom range">
        <div className="row-between">
          <input
            type="date"
            aria-label="From"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            style={{ inlineSize: 'auto' }}
          />
          <span className="muted" aria-hidden="true">
            →
          </span>
          <input
            type="date"
            aria-label="To"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            style={{ inlineSize: 'auto' }}
          />
          <button type="submit" className="btn small">
            Apply
          </button>
        </div>
      </form>

      {report.error && <ErrorBanner error={report.error} onRetry={report.refresh} />}
      {report.loading && <Skeleton />}

      {report.data && (
        <>
          <article className="card" aria-label="Overall adherence">
            <div
              style={{
                fontSize: '2.4rem',
                fontWeight: 800,
                letterSpacing: '-0.02em',
                lineHeight: 1.1,
              }}
            >
              {formatAdherence(overall?.adherence ?? null)}
            </div>
            <div className="muted">
              {overall &&
                `${formatCounts(overall.counts.done, overall.counts.missed, overall.counts.skipped)} · ${overall.counts.missed} missed`}
            </div>
            {overall && overall.behind.last7 + overall.behind.last30 > 0 && (
              <div className="muted">
                {overall.behind.last7 > 0 && `${overall.behind.last7} missed in the last 7 days`}
                {overall.behind.last7 > 0 && overall.behind.last30 > 0 && ' · '}
                {overall.behind.last30 > 0 && `${overall.behind.last30} missed in the last 30 days`}
              </div>
            )}
            {overall && overall.late > 0 && overall.lateRate !== null && (
              <div className="muted">
                {overall.late} completed after the due time ({Math.round(overall.lateRate * 100)}%
                of completions)
              </div>
            )}
          </article>

          <h3 className="section-title">Trend</h3>
          <TrendChart report={report.data} />

          <h3 className="section-title">Tasks</h3>
          {report.data.perRule.length === 0 && (
            <div className="empty">
              <p>Nothing elapsed in this range yet.</p>
            </div>
          )}
          {report.data.perRule.map((rule) => (
            <article className="card" key={rule.ruleId} style={{ marginBlock: '0.5rem' }}>
              <div className="row-between">
                <div className="item-title">{rule.title}</div>
                <strong>{formatAdherence(rule.summary.adherence)}</strong>
              </div>
              <div className="item-meta">
                <span>
                  {formatCounts(
                    rule.summary.counts.done,
                    rule.summary.counts.missed,
                    rule.summary.counts.skipped,
                  )}
                </span>
                {rule.streak && (
                  <span>
                    {rule.streak.current}-day streak · best {rule.streak.best}
                  </span>
                )}
              </div>
            </article>
          ))}
        </>
      )}
    </section>
  );
}

function TrendChart({ report }: { report: PeriodReport }) {
  const width = 300;
  const height = 84;
  const values = report.trend.map((t) => t.adherence);
  const { segments, dots } = buildSparkline(values, width, height);

  if (dots.length === 0) {
    return (
      <div className="card">
        <div className="muted">No elapsed months in this range.</div>
      </div>
    );
  }

  const labels = report.trend.map((t) => bucketLabel(t.bucket));
  const first = labels[0] ?? '';
  const last = labels.length > 1 ? (labels[labels.length - 1] ?? '') : '';

  return (
    <div className="card" role="img" aria-label={`Monthly adherence trend: ${values.map((v) => (v === null ? 'no data' : `${Math.round(v * 100)}%`)).join(', ')}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ inlineSize: '100%', blockSize: 'auto', display: 'block' }}
        aria-hidden="true"
      >
        {segments.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {dots.map((dot, i) => (
          <circle key={i} cx={dot.x} cy={dot.y} r={3.5} fill="var(--accent)" />
        ))}
      </svg>
      <div className="row-between muted">
        <span>{first}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}
