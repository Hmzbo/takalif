import type { ReactNode } from 'react';
import type { ApiError } from './api';

export function Banner({ kind, children }: { kind: 'error' | 'warn' | 'info'; children: ReactNode }) {
  return (
    <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function ErrorBanner({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  return (
    <Banner kind="error">
      <div className="row-between">
        <span>
          {error.status === 0 ? 'Offline. ' : ''}
          {error.message}
        </span>
        {onRetry && (
          <button type="button" className="btn small" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    </Banner>
  );
}

export function Skeleton() {
  return (
    <div aria-hidden="true">
      <div className="skeleton" />
      <div className="skeleton" />
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>
        {label}
        <span style={{ display: 'block', marginBlockStart: '0.25rem', fontWeight: 400 }}>
          {children}
        </span>
      </label>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}
