import { useState } from 'react';
import type { Rule } from '@takalif/core';
import { api } from '../api';
import { runMutation, useResource, type Resource } from '../data';
import { calendarLabel } from '../format';
import { describeRRule } from '../rrulePresets';
import { Banner, ErrorBanner, Skeleton } from '../ui';
import { RuleForm } from './RuleForm';

export function RulesView({ onChanged }: { onChanged: () => void }) {
  const rules: Resource<Awaited<ReturnType<typeof api.rules>>> = useResource('rules', () =>
    api.rules(),
  );
  const [editing, setEditing] = useState<Rule | null>(null);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);

  async function archive(id: string) {
    setActionError(null);
    const err = await runMutation(() => api.archiveRule(id));
    if (err) {
      setActionError(err.message);
      return;
    }
    setConfirmArchive(null);
    rules.refresh();
    onChanged();
  }

  function saved() {
    setEditing(null);
    setCreating(false);
    rules.refresh();
    onChanged();
  }

  if (editing) {
    return (
      <section aria-label="Edit task">
        <h2>Edit task</h2>
        <RuleForm
          rule={editing}
          onSaved={saved}
          onCancel={() => setEditing(null)}
        />
      </section>
    );
  }

  if (creating) {
    return (
      <section aria-label="New task">
        <h2>New task</h2>
        <RuleForm rule={null} onSaved={saved} onCancel={() => setCreating(false)} />
      </section>
    );
  }

  const active = rules.data?.rules.filter((r) => r.active) ?? [];
  const archived = rules.data?.rules.filter((r) => !r.active) ?? [];

  return (
    <section aria-label="Recurring tasks">
      <div className="row-between">
        <h2 style={{ margin: 0 }}>Recurring tasks</h2>
        <button type="button" className="btn primary" onClick={() => setCreating(true)}>
          New task
        </button>
      </div>
      <p className="muted" style={{ marginBlock: '0.4rem 0' }}>
        Repeating commitments. Time away lives under Settings, never as a task.
      </p>

      {rules.error && <ErrorBanner error={rules.error} onRetry={rules.refresh} />}
      {actionError && <Banner kind="error">{actionError}</Banner>}
      {rules.data && rules.data.failedRules.length > 0 && (
        <Banner kind="warn">
          {rules.data.failedRules.length === 1
            ? 'A task could not be expanded, so it is generating nothing.'
            : `${rules.data.failedRules.length} tasks could not be expanded, so they are generating nothing.`}{' '}
          A task that generates nothing also shrinks its adherence denominator — check the
          schedule below.
        </Banner>
      )}
      {rules.loading && <Skeleton />}

      {rules.data && active.length === 0 && (
        <div className="empty">
          <p>No recurring tasks yet.</p>
          <p className="muted">Create your first recurring commitment above.</p>
        </div>
      )}

      {active.map((rule) => (
        <article className="card" key={rule.id} style={{ marginBlock: '0.5rem' }}>
          <div className="item" style={{ borderBlockEnd: 0, paddingBlock: 0 }}>
            <div className="item-main">
              <div className="item-title">{rule.title}</div>
              <div className="item-meta">
                <span>{describeRRule(rule.rrule)}</span>
                {rule.calendar !== 'gregorian' && (
                  <span className="pill hijri">{calendarLabel(rule.calendar)}</span>
                )}
                {rule.category && <span>{rule.category}</span>}
                {rule.trackStreak && <span>streak on</span>}
                {rule.dueTime && <span>due {rule.dueTime}</span>}
    {rule.reminderTime && <span>reminds {rule.reminderTime}</span>}
              </div>
              {rule.description && <div className="muted">{rule.description}</div>}
            </div>
            <div className="item-actions">
              <button type="button" className="btn small" onClick={() => setEditing(rule)}>
                Edit
              </button>
              {confirmArchive === rule.id ? (
                <>
                  <button
                    type="button"
                    className="btn small danger"
                    onClick={() => archive(rule.id)}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="btn small ghost"
                    onClick={() => setConfirmArchive(null)}
                  >
                    Keep
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="btn small danger"
                  onClick={() => setConfirmArchive(rule.id)}
                >
                  Archive
                </button>
              )}
            </div>
          </div>
        </article>
      ))}

      {archived.length > 0 && (
        <>
          <h3 className="section-title">Archived · history preserved</h3>
          {archived.map((rule) => (
            <article className="card" key={rule.id} style={{ marginBlock: '0.5rem' }}>
              <div className="item-title" style={{ color: 'var(--text-2)' }}>
                {rule.title}
              </div>
              <div className="item-meta">
                <span>{describeRRule(rule.rrule)}</span>
              </div>
            </article>
          ))}
        </>
      )}
    </section>
  );
}
