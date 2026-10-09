import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.js';
import { fetchWithRetry } from '../src/data.js';

const FAST = [1, 2, 4];

describe('fetchWithRetry', () => {
  it('returns the first success without waiting', async () => {
    let calls = 0;
    const value = await fetchWithRetry(async () => {
      calls++;
      return 'ok';
    }, FAST);
    expect(value).toBe('ok');
    expect(calls).toBe(1);
  });

  it('rides out transient network failures, then succeeds', async () => {
    let calls = 0;
    const value = await fetchWithRetry(async () => {
      calls++;
      if (calls < 3) throw new ApiError(0, 'Cannot reach the server');
      return 'recovered';
    }, FAST);
    expect(value).toBe('recovered');
    expect(calls).toBe(3);
  });

  it('gives up after the delays run out', async () => {
    let calls = 0;
    await expect(
      fetchWithRetry(async () => {
        calls++;
        throw new ApiError(0, 'down');
      }, FAST),
    ).rejects.toMatchObject({ status: 0 });
    expect(calls).toBe(1 + FAST.length);
  });

  it('surfaces client errors immediately without retrying', async () => {
    let calls = 0;
    await expect(
      fetchWithRetry(async () => {
        calls++;
        throw new ApiError(404, 'Not found');
      }, FAST),
    ).rejects.toMatchObject({ status: 404 });
    expect(calls).toBe(1);
  });

  it('retries server errors but not client errors', async () => {
    let calls = 0;
    await expect(
      fetchWithRetry(async () => {
        calls++;
        throw new ApiError(503, 'Unavailable');
      }, [1]),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(2);
  });
});
