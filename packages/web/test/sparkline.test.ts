import { describe, expect, it } from 'vitest';
import { buildSparkline } from '../src/sparkline';

describe('buildSparkline', () => {
  it('maps values to a single path', () => {
    const { segments, dots } = buildSparkline([0, 0.5, 1], 100, 40);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatch(/^M[\d.]+,[\d.]+ L[\d.]+,[\d.]+ L[\d.]+,[\d.]+$/);
    expect(dots).toHaveLength(3);
  });

  it('puts full adherence at the top and zero at the bottom', () => {
    const { dots } = buildSparkline([1, 0], 100, 40, 0);
    expect(dots[0]!.y).toBe(0);
    expect(dots[1]!.y).toBe(40);
  });

  it('splits nulls into gaps rather than drawing through them', () => {
    const { segments, dots } = buildSparkline([1, null, 0.5, 0.75], 200, 40);
    expect(segments).toHaveLength(1);
    expect(dots).toHaveLength(3);
  });

  it('produces one segment per contiguous run', () => {
    const { segments } = buildSparkline([0.2, 0.4, null, 0.6, 0.8], 200, 40);
    expect(segments).toHaveLength(2);
  });

  it('renders a lone point as a dot with no path', () => {
    const { segments, dots } = buildSparkline([null, 0.5, null], 200, 40);
    expect(segments).toHaveLength(0);
    expect(dots).toHaveLength(1);
    expect(dots[0]!.x).toBe(100);
  });

  it('returns nothing for empty or degenerate input', () => {
    expect(buildSparkline([], 200, 40)).toEqual({ segments: [], dots: [] });
    expect(buildSparkline([null, null], 200, 40)).toEqual({ segments: [], dots: [] });
    expect(buildSparkline([0.5], 0, 40).segments).toEqual([]);
  });

  it('clamps out-of-range values instead of drawing outside the box', () => {
    const { dots } = buildSparkline([1.5, -0.5], 100, 40, 0);
    expect(dots[0]!.y).toBe(0);
    expect(dots[1]!.y).toBe(40);
  });
});
