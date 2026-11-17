// Launch Curve Forecaster v2 — make.fun gta6-twitch-ccu-forecast-01 entry (Node 22, stdlib only).
//
// Shape-based forecaster anchored on the case's hour-1 print p1. GTA VI launches
// console-only (PS5 / Xbox Series) with a rolling local-midnight unlock, so the
// shape is taken from the console-only comparables — past launches with no PC
// release, whose rolling-unlock curves rise through the day alike — rather than
// from every launch, whose PC simultaneous global unlocks flatten their curves:
//
//   1. For each console-only comparable, the log-ratios ln(viewers_h / viewers_1)
//      on its UTC release day, h = 2..24.
//   2. Per hour, the 60TH PERCENTILE log-ratio across those launches (v2: the
//      median under-shoots — the practice launches' curves run above the
//      comparable median, and the one case that dominates the mean, Wolverine,
//      surged 9x its hour-1 print), smoothed with a 3-hour moving average in
//      log space, shrunk slightly toward persistence (ratio 1) where that hour
//      has few comparables, and scaled by 1.35.
//   3. q50(h) = p1 * exp(that log-ratio).
//   4. Spread s_h from the interquartile range of log-ratios that hour:
//      the console-only IQR / 1.349, but never less than half the all-launch
//      IQR / 1.349 — console launches agree tightly, yet a Wolverine-style
//      outlier surge (9x the hour-1 print) must stay inside the band, so the
//      wider population still sets a floor. s_h is floored at 0.25.
//      q_tau(h) = q50(h) * exp(z_tau * s_h).
//
// Launch-day curves rise hard after hour 1 (US unlocks land at hours 6 and 9, the
// evening peak near hour 19-20 at a median ~2.4x the hour-1 print), so the
// comparables' shape captures what a flat persistence forecast misses. No
// peak hour is hard-coded; the data says it.
//
// Practice (local scoring against SullyGnome's published hourly averages, the
// same pinball loss the contest uses): mean loss 0.244 across p00..p03
// (p00 Wolverine 0.390, p01 RDR2 0.154, p02 GoW Ragnarok 0.203,
// p03 Spider-Man 2 0.227), against 0.258 for v1 and 0.387 for the house
// persistence baseline. The v2 tilt trades small losses on the flat launches
// (GoW +0.03, Spider-Man 2 +0.01) for a large gain on the surge case
// (Wolverine -0.08). Honest caveat: re-tuning the knobs on 3 of the 4 practice
// cases and testing on the held-out 4th gives a mean of 0.276, so the 0.244 is
// optimistic — the tilt is a bet that GTA VI surges like Wolverine rather than
// staying flat like GoW. No network, no randomness, no clock:
// the same input always writes the same bytes. Runs in milliseconds per case.
//
// Output: {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]}, exactly 23 rows,
// hours 2..24, each q finite, > 0, at most 1e9, non-decreasing, rounded to 2 dp.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
/** First and last forecast hour. */
const FIRST_HOUR = 2;
const LAST_HOUR = 24;
/** Floor for the per-hour log-spread; the band never claims more certainty than this. */
const MIN_SPREAD = 0.25;
/** 1.349 IQRs span one standard deviation of a normal, so IQR / 1.349 is its sigma. */
const IQR_TO_SIGMA = 1 / 1.349;
/** Shrink strength: a median from n comparables is pulled toward persistence by n / (n + K). */
const SHRINK_K = 3;
/** Tilt on the centre log-ratio: practice launches run above the comparable median. */
const AMP = 1.35;
/** Centre percentile of the console-only log-ratios each hour (60th, not the median). */
const CENTRE_PCT = 0.6;
/** The all-launch spread never lets the console-only spread fall below half its size. */
const ALL_SPREAD_SHARE = 0.5;

interface Comparable {
  day_start: string;
  platforms?: string;
  hourly: Array<{ from: string; viewers: number }>;
}

interface Case {
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables?: Comparable[];
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Median of a non-empty array; undefined when empty. */
const medianOf = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 === 1 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/** p-th quantile (nearest-rank) of a non-empty array; undefined when empty. */
const quantileOf = (values: number[], p: number): number | undefined => {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};

/** A launch counts as console-only when its platforms string names no PC release. */
const isConsoleOnly = (comp: Comparable): boolean =>
  typeof comp.platforms === 'string' && !/PC/i.test(comp.platforms);

/**
 * For one comparable launch, its release-day hourly viewers keyed by hour 1..24.
 * `from` is the hour's start in UTC; day_start is the release day's 00:00 UTC.
 */
const releaseDayHours = (comp: Comparable): Map<number, number> => {
  const dayStart = Date.parse(comp.day_start);
  const byHour = new Map<number, number>();
  if (Number.isNaN(dayStart) || !Array.isArray(comp.hourly)) return byHour;
  for (const pt of comp.hourly) {
    if (typeof pt.viewers !== 'number' || !(pt.viewers > 0)) continue;
    const t = Date.parse(pt.from);
    if (Number.isNaN(t)) continue;
    const h = Math.round((t - dayStart) / 3600000) + 1;
    if (h >= 1 && h <= LAST_HOUR && !byHour.has(h)) byHour.set(h, pt.viewers);
  }
  return byHour;
};

/** The persistence forecast of one hour: the house baseline's shape, used as fallback. */
const persistenceRow = (p1: number, h: number): number[] => {
  const s = MIN_SPREAD * Math.sqrt(h - 1);
  return Z.map((z) => clampRow(p1 * Math.exp(z * s)));
};

/** Clamp one quantile to (0, 1e9] and round to 2 decimals. */
function clampRow(x: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0.01;
  return Math.max(0.01, round2(Math.min(x, 1e9)));
}

/** Enforce non-decreasing order within a row (cumulative max), left to right. */
const monotoneRow = (q: number[]): number[] => {
  const out: number[] = [];
  let top = 0;
  for (const v of q) {
    top = Math.max(top, v);
    out.push(top);
  }
  return out;
};

/** Forecast one case: 23 rows, hours 2..24. Never throws; falls back to persistence. */
const forecastCase = (c: Case): Array<{ hour: number; q: number[] }> => {
  const first = c.known.find((k) => k.hour === 1);
  const p1 = Math.max(1, first !== undefined && Number.isFinite(first.viewers) ? first.viewers : 1);
  const hours = c.forecast.map((f) => f.hour).filter((h) => h >= FIRST_HOUR && h <= LAST_HOUR);

  // Per-hour log-ratios ln(viewers_h / viewers_1): the console-only set drives the
  // centre, the full set only floors the spread (see below).
  const consoleRatios = new Map<number, number[]>();
  const allRatios = new Map<number, number[]>();
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
    consoleRatios.set(h, []);
    allRatios.set(h, []);
  }
  const comps = Array.isArray(c.comparables) ? c.comparables : [];
  for (const comp of comps) {
    const byHour = releaseDayHours(comp);
    const v1 = byHour.get(1);
    if (v1 === undefined || !(v1 > 0)) continue;
    for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
      const vh = byHour.get(h);
      if (vh === undefined || !(vh > 0)) continue;
      const lr = Math.log(vh / v1);
      allRatios.get(h)!.push(lr);
      if (isConsoleOnly(comp)) consoleRatios.get(h)!.push(lr);
    }
  }

  // 60th-percentile log-ratio and IQR per hour, from the console-only set; an hour with
  // no console data falls back to the full set for that hour.
  const med = new Map<number, number>();
  const spread = new Map<number, number>();
  const count = new Map<number, number>();
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
    const crs = consoleRatios.get(h)!;
    const ars = allRatios.get(h)!;
    const centre = crs.length > 0 ? crs : ars;
    count.set(h, centre.length);
    const m = quantileOf(centre, CENTRE_PCT);
    if (m === undefined) continue;
    med.set(h, m);
    const iqrOf = (a: number[]): number => {
      if (a.length === 0) return 0;
      return Math.max(0, quantileOf(a, 0.75)! - quantileOf(a, 0.25)!);
    };
    const sConsole = iqrOf(crs) * IQR_TO_SIGMA;
    const sAll = iqrOf(ars) * IQR_TO_SIGMA;
    spread.set(h, Math.max(MIN_SPREAD, sConsole, ALL_SPREAD_SHARE * sAll));
  }

  // Fill any hour missing a median by linear interpolation in log space across
  // its neighbours (flat persistence, log-ratio 0, when nothing is known at all).
  const filled = new Map<number, number>();
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
    if (med.has(h)) {
      filled.set(h, med.get(h)!);
      continue;
    }
    let lo = h - 1;
    while (lo >= FIRST_HOUR && !med.has(lo)) lo--;
    let hi = h + 1;
    while (hi <= LAST_HOUR && !med.has(hi)) hi++;
    if (lo >= FIRST_HOUR && hi <= LAST_HOUR) {
      const a = med.get(lo)!;
      const b = med.get(hi)!;
      filled.set(h, a + ((b - a) * (h - lo)) / (hi - lo));
    } else if (lo >= FIRST_HOUR) {
      filled.set(h, med.get(lo)!);
    } else if (hi <= LAST_HOUR) {
      filled.set(h, med.get(hi)!);
    } else {
      filled.set(h, 0);
    }
  }

  // Smooth the 23 centre values with a 3-hour moving average in log space.
  const smooth = new Map<number, number>();
  for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) {
    const window: number[] = [];
    for (let k = h - 1; k <= h + 1; k++) {
      if (k >= FIRST_HOUR && k <= LAST_HOUR) window.push(filled.get(k)!);
    }
    smooth.set(h, window.reduce((a, b) => a + b, 0) / window.length);
  }

  return hours.map((h) => {
    const n = count.get(h) ?? 0;
    // Shrink toward persistence (log-ratio 0) where that hour has few comparables.
    const shrink = n / (n + SHRINK_K);
    const logMed = smooth.get(h)! * shrink * AMP;
    const q50 = p1 * Math.exp(logMed);
    // Spread from that hour's IQR (console set, floored by half the all-launch
    // spread); where no IQR exists, widen like a random walk, as the baseline does.
    const s = spread.has(h) ? spread.get(h)! : MIN_SPREAD * Math.sqrt(h - 1);
    const q = monotoneRow(Z.map((z) => clampRow(q50 * Math.exp(z * s))));
    return { hour: h, q };
  });
};

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  let hours: Array<{ hour: number; q: number[] }>;
  try {
    const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as Case;
    if (!Array.isArray(c.forecast) || c.forecast.length === 0) throw new Error(`${file} has no forecast hours`);
    hours = forecastCase(c);
  } catch {
    // A case we cannot read still gets a valid persistence forecast, never a crash.
    const fallback: Array<{ hour: number; q: number[] }> = [];
    for (let h = FIRST_HOUR; h <= LAST_HOUR; h++) fallback.push({ hour: h, q: persistenceRow(1, h) });
    hours = fallback;
  }
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
