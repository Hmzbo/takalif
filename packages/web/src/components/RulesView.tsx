import { useEffect, useRef, useState } from 'react';
import type { Rule } from '@takalif/core';
import { api } from '../api';
import { runMutation, useResource, type Resource } from '../data';
import { calendarLabel } from '../format';
import { describeRRule } from '../rrulePresets';
import { IconArchive, IconCalendar, IconDots, IconPencil, IconPlus } from '../icons';
import { Banner, ErrorBanner, Skeleton } from '../ui';
import { RuleForm } from './RuleForm';

export function RulesView({
  onChanged,
  createRequest = 0,
}: {
  onChanged: () => void;
  /** Bumped to open the create form from another tab. */
  createRequest?: number;
}) {
  const rules: Resource<Awaited<ReturnType<typeof api.rules>>> = useResource('rules', () =>
    api.rules(),
  );
  const [editing, setEditing] = useState<Rule | null>(null);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmArchive, setConfirmArchive] = useState<string | null>(null);
  // Only reacts to increases: the nonce survives every later mount of this
  // view, so "greater than last handled" is what actually means "new request".
  const lastHandled = useRef(0);

  useEffect(() => {
    if (createRequest > lastHandled.current) {
      lastHandled.current = createRequest;
      setCreating(true);
    }
  }, [createRequest]);

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
      <div className="page-head">
        <div>
          <h2 className="page-title">
            Recurring <span className="accent-text">tasks</span>
          </h2>
          <p className="page-sub">
            Repeating commitments. Time away lives under Settings, never as a task.
          </p>
        </div>
        <button type="button" className="btn primary new-pill" onClick={() => setCreating(true)}>
          <IconPlus /> New task
        </button>
      </div>

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
          <p className="muted">Tap New task to create your first commitment.</p>
        </div>
      )}

      <div className="task-list">
        {active.map((rule) => (
          <TaskCard
            key={rule.id}
            rule={rule}
            onEdit={() => setEditing(rule)}
            onArchive={() => archive(rule.id)}
            confirming={confirmArchive === rule.id}
            onConfirm={() => setConfirmArchive(rule.id)}
            onCancelConfirm={() => setConfirmArchive(null)}
          />
        ))}
      </div>

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

/** One commitment card: ring, title, schedule, actions, kebab menu. */
function TaskCard({
  rule,
  onEdit,
  onArchive,
  confirming,
  onConfirm,
  onCancelConfirm,
}: {
  rule: Rule;
  onEdit: () => void;
  onArchive: () => void;
  confirming: boolean;
  onConfirm: () => void;
  onCancelConfirm: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const kebabRef = useRef<HTMLDetailsElement>(null);

  // Native <details> stays open when clicking elsewhere; close on outside
  // click and Escape so the menu behaves like every other popover.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (e: MouseEvent) => {
      if (kebabRef.current && !kebabRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('click', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('click', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const closeMenu = () => setMenuOpen(false);
  const editFromMenu = () => {
    closeMenu();
    onEdit();
  };
  const archiveFromMenu = () => {
    closeMenu();
    onConfirm();
  };

  return (
    <article className="card task-card">
      <span className="task-ring" aria-hidden="true" />
      <div className="task-main">
        <div className="task-title">{rule.title}</div>
        <div className="task-sched">
          <IconCalendar />
          <span>{describeRRule(rule.rrule)}</span>
          {rule.calendar !== 'gregorian' && (
            <span className="pill hijri">{calendarLabel(rule.calendar)}</span>
          )}
        </div>
        {(rule.category || rule.trackStreak || rule.dueTime || rule.reminderTime) && (
          <div className="item-meta">
            {rule.category && <span>{rule.category}</span>}
            {rule.trackStreak && <span>streak on</span>}
            {rule.dueTime && <span>due {rule.dueTime}</span>}
            {rule.reminderTime && <span>reminds {rule.reminderTime}</span>}
          </div>
        )}
        {rule.description && <div className="task-desc">{rule.description}</div>}
        <div className="task-actions">
          {confirming ? (
            <>
              <button type="button" className="btn-pill danger" onClick={onArchive}>
                <IconArchive /> Confirm archive
              </button>
              <button type="button" className="btn-pill" onClick={onCancelConfirm}>
                Keep
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn-pill" onClick={onEdit}>
                <IconPencil /> Edit
              </button>
              <button type="button" className="btn-pill danger" onClick={onConfirm}>
                <IconArchive /> Archive
              </button>
            </>
          )}
        </div>
      </div>
      <details
        ref={kebabRef}
        className="kebab"
        open={menuOpen}
        onToggle={(e) => setMenuOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary aria-label="More actions">
          <IconDots />
        </summary>
        <div className="kebab-menu" role="menu">
          <button type="button" role="menuitem" onClick={editFromMenu}>
            <IconPencil /> Edit
          </button>
          <button type="button" role="menuitem" className="danger" onClick={archiveFromMenu}>
            <IconArchive /> Archive
          </button>
        </div>
      </details>
    </article>
  );
}
