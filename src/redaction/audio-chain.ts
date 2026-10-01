/**
 * Audio redaction chain, built on Web Audio and Editframe's own PCM access (`getAudioBuffer`).
 *
 * Editframe's export mixes a composition by asking every `<Video>` / `<Audio>` leaf for the PCM of a
 * short time window (`leaf.getAudioBuffer(from, to)` -> `AudioBuffer`). `attachAudioRedaction()` wraps that
 * one method on a leaf so every window passes through this chain before it reaches the mixer:
 *
 *     decoded PCM window  ->  [ treat ranges ]  ->  mixer  ->  encoder
 *
 * Treatments *replace* the samples inside a range; the original is never mixed back in underneath:
 *
 *   silence   zeros
 *   hush      soft pink noise (a gentle "something was removed" cue; far less jarring than a tone)
 *   bleep     a synthetic tone, eased in and out
 *   disguise  a channel-vocoder re-synthesis (see audio/vocoder.ts). Only the coarse spectral envelope (what
 *             is being said) is kept; the speaker's pitch, harmonics and fine structure are discarded and
 *             replaced by a synthetic carrier at a different pitch with warped formants. Unlike a plain
 *             pitch shift, this cannot be undone by shifting back.
 *
 * Everything is a pure function of absolute time on the element's timeline (carrier phase and noise are
 * derived from the sample's time, filters get a lead-in), so the 0.5 s windows the exporter asks for join
 * seamlessly and a re-render is bit-for-bit repeatable.
 */

import { pinkAt, smoothstep } from "./audio/signals";
import { vocode } from "./audio/vocoder";
import { AUDIO_DEFAULTS, type AudioRedaction, type AudioTreatment, PLAN_DEFAULTS } from "./types";

/** Length of the PCM windows Editframe's exporter asks for, seconds. */
export const WINDOW_SEC = 0.5;
/** Seconds of extra audio fetched before each window so IIR filters have settled. */
export const LEAD_IN_SEC = 0.5;
/** Ramp that takes the original out (and the replacement in) at the edges of a range. */
const FADE_SEC = 0.012;
/** Peak level of the bleep tone (linear, full scale = 1). */
const BLEEP_PEAK = 0.08;

export interface ResolvedRange extends AudioRedaction {
  /** start/end including margin, seconds */
  a: number;
  b: number;
}

export function resolveRanges(redactions: AudioRedaction[], defaultMargin: number = PLAN_DEFAULTS.audioMargin): ResolvedRange[] {
  return redactions
    .map((r) => {
      const m = r.margin ?? defaultMargin;
      return { ...r, a: Math.max(0, r.start - m), b: r.end + m };
    })
    .sort((p, q) => p.a - q.a);
}

// ---------------------------------------------------------------------------------------------
// window processing
// ---------------------------------------------------------------------------------------------

/** 0 at `a`, 1 after `fade` seconds, back to 0 at `b` (linear). */
const edgeRamp = (t: number, a: number, b: number, fade: number) => Math.min(1, (t - a) / fade, (b - t) / fade);

/** 0 outside the range, 1 inside, 12 ms linear ramps across the (margin) edges. */
function rangeWeight(t: number, r: ResolvedRange): number {
  if (t < r.a || t > r.b) return 0;
  return edgeRamp(t, r.a, r.b, FADE_SEC);
}

/** The window being redacted: `raw` holds PCM from timeline second `rawStart`; `offset`/`length` locate the output in it. */
interface AudioWindow {
  raw: AudioBuffer;
  rawStart: number;
  offset: number;
  length: number;
  sampleRate: number;
}

/** The replacement signal for one range: (sample index in the window, absolute time) -> sample. */
type Sampler = (i: number, t: number) => number;

const SAMPLERS: Record<AudioTreatment, (r: ResolvedRange, w: AudioWindow) => Sampler | Promise<Sampler>> = {
  silence: () => () => 0,

  hush: (r, w) => {
    const gain = 10 ** ((r.level ?? AUDIO_DEFAULTS.level) / 20);
    return (_, t) => gain * pinkAt(Math.round(t * w.sampleRate));
  },

  bleep: (r) => {
    // the original is removed with a short ramp (rangeWeight); the tone itself eases in and out over
    // `fade`, so it never starts or stops abruptly
    const fade = Math.max(FADE_SEC, r.fade ?? AUDIO_DEFAULTS.fade);
    const hz = r.hz ?? AUDIO_DEFAULTS.hz;
    return (_, t) => BLEEP_PEAK * smoothstep(edgeRamp(t, r.a, r.b, fade)) * Math.sin(2 * Math.PI * hz * t);
  },

  disguise: async (r, w) => {
    const voiced = (await vocode(w.raw, w.rawStart, r)).subarray(w.offset, w.offset + w.length);
    return (i) => voiced[i] ?? 0;
  },
};

/**
 * Redacts the part of `raw` (PCM that starts at timeline second `rawStart`) that lies in [from, to).
 * Returns a new AudioBuffer of exactly that window, same channel count and sample rate as `raw`.
 */
export async function redactWindow(raw: AudioBuffer, rawStart: number, from: number, to: number, ranges: ResolvedRange[]): Promise<AudioBuffer> {
  const sr = raw.sampleRate;
  const offset = Math.max(0, Math.round((from - rawStart) * sr));
  const length = Math.max(1, Math.round((to - from) * sr));
  const out = new AudioBuffer({ numberOfChannels: raw.numberOfChannels, length, sampleRate: sr });

  const win: AudioWindow = { raw, rawStart, offset, length, sampleRate: sr };
  const active: { range: ResolvedRange; sample: Sampler }[] = [];
  for (const range of ranges) {
    if (range.b > from && range.a < to) active.push({ range, sample: await SAMPLERS[range.treatment](range, win) });
  }

  // How much of the original survives (keep) and what replaces the rest (wet) is the same for every
  // channel, so work it out once per sample. Float64: it is multiplied into the audio below.
  const keep = new Float64Array(length).fill(1);
  const wet = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const t = from + i / sr;
    for (const { range, sample } of active) {
      const w = rangeWeight(t, range);
      if (w === 0) continue;
      keep[i] *= 1 - w;
      wet[i] += w * sample(i, t);
    }
  }

  for (let c = 0; c < raw.numberOfChannels; c++) {
    const src = raw.getChannelData(c);
    const dst = out.getChannelData(c);
    for (let i = 0; i < length; i++) dst[i] = keep[i] * (src[offset + i] ?? 0) + wet[i];
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// attach to an Editframe media element
// ---------------------------------------------------------------------------------------------

/** The slice of EFVideoElement / EFAudioElement the chain relies on (both are public API). */
export interface PcmSourceElement extends HTMLElement {
  muted: boolean;
  getAudioBuffer(fromLocalSec: number, toLocalSec: number): Promise<AudioBuffer | null>;
}

export const ATTACHED_FLAG = "data-audio-redaction";

/**
 * Routes all export audio for `el` through the chain. Returns a function that detaches it.
 *
 * Fail-closed: the element is kept `muted`, so live playback is silent and — if this function is never
 * called — Editframe's own `getAudioBuffer` returns null (no audio at all). Only this wrapper unmutes the
 * element, and only for the instant it takes to fetch PCM that it then redacts.
 */
export function attachAudioRedaction(el: PcmSourceElement, redactions: AudioRedaction[], defaultMargin?: number): () => void {
  const ranges = resolveRanges(redactions, defaultMargin);
  const original = el.getAudioBuffer.bind(el);
  let pending = 0;

  el.muted = true;
  el.setAttribute(ATTACHED_FLAG, String(ranges.length));

  el.getAudioBuffer = async (from: number, to: number) => {
    const rawStart = Math.max(0, from - LEAD_IN_SEC);
    pending++;
    el.muted = false;
    let raw: AudioBuffer | null;
    try {
      raw = await original(rawStart, to);
    } finally {
      if (--pending === 0) el.muted = true;
    }
    if (!raw) return null;
    return redactWindow(raw, rawStart, from, to, ranges);
  };

  return () => {
    // Restore the prototype method, but stay muted: a detached element must never leak audio.
    delete (el as Partial<PcmSourceElement>).getAudioBuffer;
    el.removeAttribute(ATTACHED_FLAG);
    el.muted = true;
  };
}
