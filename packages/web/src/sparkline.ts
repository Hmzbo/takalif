/**
 * Monthly-adherence sparkline geometry.
 *
 * Pure: values in, SVG path data out. A `null` adherence (nothing elapsed that
 * month) is a gap, not a zero — rendering it as zero would draw a disaster
 * where there is only an absence of data.
 */

export interface SparkDot {
  x: number;
  y: number;
  /** Null dots are never emitted; kept for clarity at call sites. */
  value: number;
}

export interface Sparkline {
  /** One `d` per contiguous run of non-null values. */
  segments: string[];
  dots: SparkDot[];
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function buildSparkline(
  values: (number | null)[],
  width: number,
  height: number,
  pad = 6,
): Sparkline {
  const segments: string[] = [];
  const dots: SparkDot[] = [];
  if (values.length === 0 || width <= 0 || height <= 0) return { segments, dots };

  const innerH = Math.max(0, height - pad * 2);
  const x = (i: number): number =>
    values.length === 1 ? width / 2 : pad + (i * (width - pad * 2)) / (values.length - 1);
  const y = (v: number): number => pad + (1 - Math.min(1, Math.max(0, v))) * innerH;

  let current: string[] = [];
  // A lone point draws nothing as a path; dots are rendered as circles, so
  // only runs of two or more become segments.
  const flush = (): void => {
    if (current.length >= 2) segments.push(current.join(' '));
    current = [];
  };

  values.forEach((v, i) => {
    if (v === null) {
      flush();
      return;
    }
    const px = round2(x(i));
    const py = round2(y(v));
    current.push(`${current.length === 0 ? 'M' : 'L'}${px},${py}`);
    dots.push({ x: px, y: py, value: v });
  });
  flush();

  return { segments, dots };
}
