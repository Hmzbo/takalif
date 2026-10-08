import { useState } from 'react';
import type { Settings } from '@takalif/core';
import { api } from './api';
import { useOnline, useResource, useTheme } from './data';
import { RulesView } from './components/RulesView';
import { SettingsView } from './components/SettingsView';
import { StatsView, type ReviewRange } from './components/StatsView';
import { TodayView } from './components/TodayView';

type Tab = 'today' | 'rules' | 'stats' | 'settings';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'today', label: 'Today', icon: '✓' },
  { id: 'rules', label: 'Tasks', icon: '◷' },
  { id: 'stats', label: 'Stats', icon: '▦' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

const THEMES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
] as const;

export function App() {
  const [tab, setTab] = useState<Tab>('today');
  const online = useOnline();
  const { theme, setTheme } = useTheme();
  const settings = useResource<Settings>('settings', () => api.settings());

  // Set by the recovery prompt's "Review" action: jump to Stats showing that range.
  const [reviewRange, setReviewRange] = useState<ReviewRange | null>(null);
  const [reviewNonce, setReviewNonce] = useState(0);

  function reviewRangeAction(from: string, to: string) {
    setReviewRange({ from, to });
    setReviewNonce((n) => n + 1);
    setTab('stats');
  }

  return (
    <>
      {!online && (
        <div className="offline-bar" role="status">
          You are offline. Showing what was last fetched — changes will fail until you reconnect.
        </div>
      )}
      <header className="app-header">
        <div className="app-header-inner">
          <span className="brand">
            <span className="brand-mark" aria-hidden="true">
              ✓
            </span>
            Takalif
          </span>
          <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            Theme
            <select
              aria-label="Theme"
              value={theme}
              onChange={(e) => setTheme(e.target.value as typeof theme)}
              style={{ inlineSize: 'auto' }}
            >
              {THEMES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </header>

      <main className="app">
        {tab === 'today' && (
          <TodayView settings={settings.data} onReviewRange={reviewRangeAction} />
        )}
        {tab === 'rules' && <RulesView onChanged={() => settings.refresh()} />}
        {tab === 'stats' && <StatsView reviewRange={reviewRange} reviewNonce={reviewNonce} />}
        {tab === 'settings' && <SettingsView onChanged={() => settings.refresh()} />}
      </main>

      <nav className="tabs" aria-label="Sections">
        <div className="sidebar-brand" aria-hidden="true">
          <span className="brand-mark" aria-hidden="true">
            ✓
          </span>
          Takalif
        </div>
        <div className="tabs-inner">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className="tab"
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
            >
              <span className="tab-icon" aria-hidden="true">
                {t.icon}
              </span>
              {t.label}
            </button>
          ))}
        </div>
      </nav>
    </>
  );
}
