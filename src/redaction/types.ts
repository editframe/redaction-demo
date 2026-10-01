/**
 * The redaction plan: plain JSON a customer can generate from any tool. All times are in seconds on the
 * *source video's own timeline*; all coordinates are in source-video pixels.
 */

export interface BoxKey {
  /** seconds */
  t: number;
  /** top-left corner, px */
  x: number;
  y: number;
  w: number;
  h: number;
  /** rotation about the box centre, degrees (optional) */
  r?: number;
}

/** A box at one instant: a BoxKey without the time, rotation resolved to a number. */
export interface BoxState {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

export const VIDEO_TREATMENTS = ["solid", "scramble"] as const;
export type VideoTreatment = (typeof VIDEO_TREATMENTS)[number];

export const SHAPES = ["rect", "round", "ellipse"] as const;
export type Shape = (typeof SHAPES)[number];

/** Corner radius of the "round" shape, px. */
export const ROUND_RADIUS = 14;

/**
 * "scramble": the pixels under the box are averaged into coarse cells, the cells are randomly shuffled
 * (within tiles), and the result is blurred. It looks like a soft blur, but because the shuffle uses fresh
 * secure randomness that is never stored, there is no inverse: deconvolution can at best recover the
 * shuffled cells. `tile` sets how much coarse layout survives: a small tile keeps a rough "blob" of the
 * original, `"region"` shuffles across the whole box and keeps only its colour distribution.
 */
export interface ScrambleOptions {
  /** source px averaged into one cell before shuffling (default 6) */
  cell?: number;
  /** shuffle within tiles of this many source px, or "region" for the whole box (default "region") */
  tile?: number | "region";
  /** blur radius in px applied after the shuffle (default 1.6 x cell) */
  blur?: number;
  /**
   * Soft edge, px. The redaction box itself stays fully opaque; the feather is an extra ring *outside* it
   * that fades the scrambled blur into the picture, so the edge looks like a natural blur. The box (the
   * private region) must therefore never rely on the feather for coverage.
   */
  feather?: number;
}

export interface VideoTrack {
  id: string;
  /** "solid" = flat opaque fill (default). "scramble" = shuffle-then-blur, see ScrambleOptions. */
  treatment?: VideoTreatment;
  scramble?: ScrambleOptions;
  /** Text printed inside the box (omit for a plain block). Never derived from what is underneath. */
  label?: string;
  shape?: Shape;
  /** Opaque fill colour. Default: plan.defaults.fill */
  fill?: string;
  /** Extra px added on every side of the interpolated box. */
  padding?: number;
  /** Seconds the box appears early / lingers late. */
  timeMargin?: number;
  /** Linear interpolation between keys; the box exists from the first key to the last. */
  keys: BoxKey[];
}

export const AUDIO_TREATMENTS = ["silence", "hush", "bleep", "disguise"] as const;
export type AudioTreatment = (typeof AUDIO_TREATMENTS)[number];

export interface AudioRedaction {
  id: string;
  start: number;
  end: number;
  treatment: AudioTreatment;
  /** Free-form tag for tools (the workbench finds "beep" and "voice" redactions by it). The renderer ignores it. */
  role?: string;
  /** seconds of extra coverage either side (default plan.defaults.audioMargin) */
  margin?: number;
  /** hush: level of the pink noise in dBFS (default -30; speech here sits around -26) */
  level?: number;
  /** bleep: tone frequency (default 440) */
  hz?: number;
  /** bleep: seconds of smooth fade-in and fade-out of the tone inside the range (default 0.08) */
  fade?: number;
  /** disguise: carrier pitch in Hz (default 105) */
  carrierHz?: number;
  /** disguise: >1 raises apparent formants, <1 lowers them (default 0.84) */
  formantWarp?: number;
}

export interface PlanDefaults {
  treatment?: VideoTreatment;
  scramble?: ScrambleOptions;
  fill?: string;
  labelColor?: string;
  padding?: number;
  timeMargin?: number;
  audioMargin?: number;
}

export interface RedactionPlan {
  version: 1;
  source: { src: string; width: number; height: number };
  defaults?: PlanDefaults;
  video: VideoTrack[];
  audio?: { redactions: AudioRedaction[] };
}

// ---------------------------------------------------------------------------------------------
// defaults: every fallback value lives here, so the renderer, the workbench and the docs agree
// ---------------------------------------------------------------------------------------------

export const PLAN_DEFAULTS = {
  fill: "#0a0a0f",
  labelColor: "#8b93a7",
  padding: 10,
  timeMargin: 0.1,
  audioMargin: 0.06,
} as const;

/** Fallbacks for the per-treatment audio fields (each field is documented on AudioRedaction). */
export const AUDIO_DEFAULTS = { level: -30, hz: 440, fade: 0.08, carrierHz: 105, formantWarp: 0.84 } as const;

export interface ResolvedScramble {
  cell: number;
  tile: number | "region";
  blur: number;
  feather: number;
}

/** Merges scramble option layers (later wins, e.g. plan defaults then the track's own) and applies the fallbacks. */
export function resolveScramble(...layers: (ScrambleOptions | undefined)[]): ResolvedScramble {
  const o: ScrambleOptions = Object.assign({}, ...layers);
  const cell = Math.max(2, o.cell ?? 6);
  return {
    cell,
    tile: o.tile ?? "region",
    blur: o.blur && o.blur > 0 ? o.blur : cell * 1.6,
    feather: Math.max(0, o.feather ?? 0),
  };
}

export interface ResolvedTrack {
  id: string;
  treatment: VideoTreatment;
  shape: Shape;
  fill: string;
  label?: string;
  padding: number;
  timeMargin: number;
  scramble: ResolvedScramble;
  keys: BoxKey[];
}

/** A track with every plan-level default applied, so nothing downstream repeats the `a ?? b ?? c` chain. */
export function resolveTrack(track: VideoTrack, defaults: PlanDefaults = {}): ResolvedTrack {
  return {
    id: track.id,
    treatment: track.treatment ?? defaults.treatment ?? "solid",
    shape: track.shape ?? "rect",
    fill: track.fill ?? defaults.fill ?? PLAN_DEFAULTS.fill,
    label: track.label,
    padding: track.padding ?? defaults.padding ?? PLAN_DEFAULTS.padding,
    timeMargin: track.timeMargin ?? defaults.timeMargin ?? PLAN_DEFAULTS.timeMargin,
    scramble: resolveScramble(defaults.scramble, track.scramble),
    keys: track.keys,
  };
}

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);

function fail(message: string): never {
  throw new Error(`redaction plan: ${message}`);
}

/** Throws on anything malformed. A plan that does not validate must never render. */
export function validatePlan(plan: RedactionPlan): RedactionPlan {
  if (plan?.version !== 1) fail(`unsupported version ${plan?.version}`);
  if (!plan.source?.src || !plan.source.width || !plan.source.height) fail("source.src/width/height required");
  if (plan.defaults?.treatment !== undefined && !oneOf(VIDEO_TREATMENTS, plan.defaults.treatment)) fail(`unknown default treatment "${plan.defaults.treatment}"`);
  if (!Array.isArray(plan.video)) fail("video must be an array of tracks");

  const ids = new Set<string>();
  for (const track of plan.video) {
    const id = track?.id;
    if (!id || ids.has(id)) fail(`bad or duplicate track id "${id}"`);
    ids.add(id);
    if (track.treatment !== undefined && !oneOf(VIDEO_TREATMENTS, track.treatment)) fail(`track "${id}" has unknown treatment "${track.treatment}"`);
    if (track.shape !== undefined && !oneOf(SHAPES, track.shape)) fail(`track "${id}" has unknown shape "${track.shape}"`);
    if (!Array.isArray(track.keys) || track.keys.length < 2) fail(`track "${id}" needs >= 2 keys`);
    track.keys.forEach((k, i) => {
      if (![k.t, k.x, k.y, k.w, k.h].every(finite) || (k.r !== undefined && !finite(k.r))) fail(`track "${id}" key ${i} is malformed`);
      if (k.w <= 0 || k.h <= 0) fail(`track "${id}" key ${i} has an empty box`);
      if (i > 0 && k.t < track.keys[i - 1].t) fail(`track "${id}" keys are not time-sorted`);
    });
  }

  const ranges = [...(plan.audio?.redactions ?? [])].sort((a, b) => a.start - b.start);
  ranges.forEach((r, i) => {
    if (!finite(r.start) || !finite(r.end) || r.end <= r.start) fail(`audio "${r.id}" has an invalid range`);
    if (!oneOf(AUDIO_TREATMENTS, r.treatment)) fail(`audio "${r.id}" has unknown treatment`);
    if (i > 0 && r.start < ranges[i - 1].end) fail(`audio "${ranges[i - 1].id}" and "${r.id}" overlap`);
  });
  return plan;
}
