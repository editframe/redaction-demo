import type { BoxKey, BoxState } from "./types";

const toState = (k: BoxKey): BoxState => ({ x: k.x, y: k.y, w: k.w, h: k.h, r: k.r ?? 0 });

/** Linear interpolation between the two keys that bracket `t`; holds the first/last key outside the range. */
export function sampleKeys(keys: BoxKey[], t: number): BoxState {
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (t <= first.t) return toState(first);
  if (t >= last.t) return toState(last);

  // binary search for the bracketing pair
  let lo = 0;
  let hi = keys.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = toState(keys[lo]);
  const b = toState(keys[hi]);
  const k = keys[hi].t === keys[lo].t ? 0 : (t - keys[lo].t) / (keys[hi].t - keys[lo].t);
  const mix = (p: number, q: number) => p + (q - p) * k;
  return { x: mix(a.x, b.x), y: mix(a.y, b.y), w: mix(a.w, b.w), h: mix(a.h, b.h), r: mix(a.r, b.r) };
}
