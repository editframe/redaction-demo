/**
 * Deterministic signal generators: every output sample is a pure function of its absolute index or time,
 * with no running state, so any window of a signal can be generated on its own and the pieces join exactly.
 */

/** Hermite smoothstep on [0, 1]. */
export const smoothstep = (x: number) => x * x * (3 - 2 * x);

/** Integer hash -> uniform [-1, 1). Same sample index always gives the same value. */
export function noiseAt(index: number): number {
  let x = (index | 0) ^ 0x9e3779b9;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 2147483648 - 1;
}

const lazy = <T>(make: () => T) => {
  let value: T | undefined;
  return () => (value ??= make());
};

/**
 * Pink-ish noise as a pure function of the sample index: eleven octaves of smoothly interpolated value
 * noise (period 8..8192 samples), equal power per octave. No filter state, so any window of it can be
 * generated independently and the pieces join exactly.
 */
const PINK_OCTAVES = 11;
function pinkRaw(i: number): number {
  let sum = 0;
  for (let k = 0; k < PINK_OCTAVES; k++) {
    const period = 8 << k;
    const j = Math.floor(i / period);
    const e = smoothstep((i - j * period) / period);
    const a = noiseAt(Math.imul(j, 2654435761) + k * 40503);
    const b = noiseAt(Math.imul(j + 1, 2654435761) + k * 40503);
    sum += a + (b - a) * e;
  }
  return sum;
}

/** Scale that gives pinkRaw unit RMS, measured once over 200k samples. */
const pinkNorm = lazy(() => {
  const N = 200000;
  let acc = 0;
  for (let n = 0; n < N; n++) acc += pinkRaw(n * 7) ** 2;
  return 1 / Math.sqrt(acc / N);
});

/** Pink noise with unit RMS at sample index `i`. */
export const pinkAt = (i: number) => pinkRaw(i) * pinkNorm();

/** White noise for the `n` samples starting at time `t0`. */
export function noiseCarrier(n: number, sr: number, t0: number): Float32Array {
  const out = new Float32Array(n);
  const base = Math.round(t0 * sr);
  for (let i = 0; i < n; i++) out[i] = noiseAt(base + i);
  return out;
}

/** Band-limited (PolyBLEP) sawtooth at `f0` Hz with a slow vibrato, phase derived from absolute time. */
export function sawCarrier(n: number, sr: number, t0: number, f0: number): Float32Array {
  const vibDepth = 0.014;
  const vibHz = 5.1;
  const w = 2 * Math.PI * vibHz;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = t0 + i / sr;
    const cycles = f0 * t + ((f0 * vibDepth) / w) * (1 - Math.cos(w * t));
    const p = cycles - Math.floor(cycles);
    const dt = (f0 * (1 + vibDepth * Math.sin(w * t))) / sr;
    let v = 2 * p - 1;
    if (p < dt) {
      const x = p / dt;
      v -= x + x - x * x - 1;
    } else if (p > 1 - dt) {
      const x = (p - 1) / dt;
      v -= x * x + x + x + 1;
    }
    out[i] = v;
  }
  return out;
}
