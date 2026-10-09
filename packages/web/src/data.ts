import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';

/**
 * Minimal async-resource hook: load on mount and on demand.
 *
 * Deliberately not TanStack Query. The slice has three screens and one
 * refresh pattern (reload after a mutation); a cache with invalidation rules
 * would be machinery without a problem. If Phase 4 range views need it, adopt
 * it then.
 */
export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  refresh: () => void;
}

export function useResource<T>(key: string, load: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    // Transient startup failures (sidecar still booting, container
    // restarting) resolve on their own; absorb them before surfacing.
    fetchWithRetry(load).then(
      (value) => {
        if (live) setData(value);
      },
      (e: unknown) => {
        if (live) setError(e instanceof ApiError ? e : new ApiError(0, String(e)));
      },
    );
    return () => {
      live = false;
    };
    // `load` is recreated per render by callers; `key` + `nonce` drive reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce]);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading: data === null && error === null, refresh };
}

/**
 * Run a loader through transient failures: connection refused while the
 * server boots, brief network loss, 5xx blips. Retries with backoff and
 * gives up after ~7s; client errors (4xx) surface immediately since retrying
 * them can never help. Unmounting abandons the result but cannot cancel the
 * in-flight request — same as the plain call it replaces.
 */
export async function fetchWithRetry<T>(
  load: () => Promise<T>,
  delays: readonly number[] = [400, 800, 1600, 3200],
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await load();
    } catch (e) {
      const retryable = e instanceof ApiError ? e.status === 0 || e.status >= 500 : true;
      const wait = delays[attempt];
      if (!retryable || wait === undefined) throw e;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

/** Runs `fn`, returning its `ApiError` (if any) so callers can display it. */
export async function runMutation(fn: () => Promise<unknown>): Promise<ApiError | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    return e instanceof ApiError ? e : new ApiError(0, String(e));
  }
}

type Theme = 'light' | 'dark' | 'system';

const THEME_KEY = 'takalif-theme';

function storedTheme(): Theme {
  const raw = localStorage.getItem(THEME_KEY);
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** Manual theme override. `system` (the default) follows the OS. */
export function useTheme(): { theme: Theme; setTheme: (t: Theme) => void } {
  const [theme, setThemeState] = useState<Theme>(storedTheme);

  useEffect(() => {
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  return { theme, setTheme: setThemeState };
}

/** Tracks `navigator.onLine`. The ledger lives on the server, so offline the
 *  app can only show what it already fetched — say so honestly. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  return online;
}
