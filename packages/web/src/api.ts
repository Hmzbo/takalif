import type {
  CalendarKind,
  HijriDate,
  Occurrence,
  OccurrenceStatus,
  PeriodReport,
  Rule,
  Settings,
  SkipPeriod,
} from '@takalif/core';

/** An occurrence as returned by /api/day and /api/occurrences (see `decorate`). */
export interface DayItem extends Occurrence {
  ruleTitle: string;
  category: string | null;
  ruleCalendar: CalendarKind;
}

export interface DayResponse {
  date: string;
  today: string;
  timezone: string;
  calendarDate: HijriDate;
  items: DayItem[];
  recoveryPrompt: {
    from: string;
    to: string;
    count: number;
    ruleIds: string[];
  } | null;
  failedRules: { ruleId: string; rrule: string; error: string }[];
}

export interface RulesResponse {
  rules: Rule[];
  failedRules: DayResponse['failedRules'];
}

export interface EditPreview {
  added: string[];
  withdrawn: Occurrence[];
  neutralised: Occurrence[];
  changed: boolean;
}

export interface SkipPeriodCreated {
  period: SkipPeriod;
  prompt: DayResponse['recoveryPrompt'];
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  } catch {
    throw new ApiError(0, 'Cannot reach the server. Is it running?');
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error
        : `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

const withBody = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
});

export const api = {
  health: () => request<{ ok: boolean; today: string }>('/api/health'),

  settings: () => request<Settings>('/api/settings'),
  updateSettings: (patch: Partial<Settings>) =>
    request<Settings & { failedRules: DayResponse['failedRules'] }>(
      '/api/settings',
      withBody('PATCH', patch),
    ),

  rules: () => request<RulesResponse>('/api/rules'),
  createRule: (input: {
    title: string;
    description?: string | null;
    rrule: string;
    dtstartDate?: string;
    dueTime?: string | null;
    reminderTime?: string | null;
    calendar?: CalendarKind;
    createdDate?: string;
    trackStreak?: boolean;
    category?: string | null;
  }) => request<Rule>('/api/rules', withBody('POST', input)),
  updateRule: (
    id: string,
    input: {
      title?: string;
      description?: string | null;
      rrule?: string;
      dtstartDate?: string;
      dueTime?: string | null;
      reminderTime?: string | null;
      calendar?: CalendarKind;
      trackStreak?: boolean;
      category?: string | null;
      effectiveFrom?: string;
    },
  ) => request<Rule>(`/api/rules/${id}`, withBody('PATCH', input)),
  editPreview: (id: string, params: { rrule?: string; dtstartDate?: string; effectiveFrom?: string }) => {
    const q = new URLSearchParams();
    if (params.rrule) q.set('rrule', params.rrule);
    if (params.dtstartDate) q.set('dtstartDate', params.dtstartDate);
    if (params.effectiveFrom) q.set('effectiveFrom', params.effectiveFrom);
    return request<EditPreview>(`/api/rules/${id}/edit-preview?${q.toString()}`);
  },
  archiveRule: (id: string) => request<{ archived: boolean }>(`/api/rules/${id}`, { method: 'DELETE' }),

  day: (date?: string) =>
    request<DayResponse>(date ? `/api/day?date=${encodeURIComponent(date)}` : '/api/day'),
  occurrences: (from: string, to: string) =>
    request<DayItem[]>(
      `/api/occurrences?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  reset: (id: string) => request<Occurrence>(`/api/occurrences/${id}/reset`, withBody('POST', {})),  changeStatus: (id: string, status: 'done' | 'missed' | 'skipped') =>
    request<Occurrence>(`/api/occurrences/${id}/status`, withBody('POST', { status })),
  excuse: (id: string) =>
    request<Occurrence>(`/api/occurrences/${id}/excuse`, withBody('POST', {})),
  setNote: (id: string, note: string | null) =>
    request<Occurrence>(`/api/occurrences/${id}/note`, withBody('POST', { note })),
  bulkExcuse: (input: { from: string; to: string; ruleIds?: string[] }) =>
    request<{ excused: number }>('/api/occurrences/bulk-excuse', withBody('POST', input)),

  skipPeriods: () => request<SkipPeriod[]>('/api/skip-periods'),
  createSkipPeriod: (input: { startDate: string; endDate: string; reason?: string | null }) =>
    request<SkipPeriodCreated>('/api/skip-periods', withBody('POST', input)),
  deleteSkipPeriod: (id: string) =>
    request<{ removed: boolean }>(`/api/skip-periods/${id}`, { method: 'DELETE' }),

  stats: (preset?: string, from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from && to) {
      q.set('from', from);
      q.set('to', to);
    } else {
      q.set('preset', preset ?? 'month');
    }
    return request<PeriodReport>(`/api/stats?${q.toString()}`);
  },

  pushPublicKey: () => request<{ publicKey: string }>('/api/push/public-key'),
  pushSubscribe: (input: { endpoint: string; keys: { p256dh: string; auth: string } }) =>
    request<{ subscribed: boolean; endpoint: string }>(
      '/api/push/subscribe',
      withBody('POST', input),
    ),
  pushUnsubscribe: (endpoint: string) =>
    request<{ removed: boolean }>('/api/push/unsubscribe', withBody('DELETE', { endpoint })),
  pushTest: () =>
    request<{ checked: number; sent: number; failed: number; pruned: number }>(
      '/api/push/test',
      withBody('POST', {}),
    ),

  pairing: () =>
    request<{ lanIP: string | null; interfaces: { name: string; address: string }[]; token: string }>(
      '/api/pairing',
    ),

  exportUrls: {
    backupJson: '/api/export/json',
    ledgerCsv: '/api/export/csv',
    rulesVtodo: '/api/export/vtodo',
  },
  importBackup: (doc: unknown) =>
    request<{ restored: boolean; rules: number; occurrences: number }>(
      '/api/import/json',
      withBody('POST', doc),
    ),
};

export type { OccurrenceStatus };
export type { CalendarKind, HijriDate, Occurrence, PeriodReport, Rule, Settings, SkipPeriod };
