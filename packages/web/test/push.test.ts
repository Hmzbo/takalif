import { describe, expect, it } from 'vitest';
import { pushSupported, urlBase64ToUint8Array } from '../src/push';

describe('urlBase64ToUint8Array', () => {
  it('decodes URL-safe base64 without padding', () => {
    // 'Hello' in URL-safe base64, padding stripped, as VAPID keys arrive.
    expect(urlBase64ToUint8Array('SGVsbG8')).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
  });

  it('handles - and _ substitutions', () => {
    const bytes = urlBase64ToUint8Array('__79');
    expect(bytes).toEqual(new Uint8Array([255, 254, 253]));
  });
});

describe('pushSupported', () => {
  it('is false where there is no window at all', () => {
    // Node has no window: documents the guard every caller relies on.
    expect(pushSupported()).toBe(false);
  });
});
