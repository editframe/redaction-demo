/**
 * Channel vocoder (Web Audio graph) behind the "disguise" treatment.
 *
 * The input is split into BANDS bands; the loudness of each band (its envelope) drives the gain of the
 * same band of a synthetic carrier (a buzzing sawtooth blended with noise) at a different pitch, with the
 * band centres warped. Only the coarse spectral envelope of the speech survives.
 */

import { AUDIO_DEFAULTS } from "../types";
import { noiseCarrier, sawCarrier } from "./signals";

const BANDS = 26;
const F_LO = 110;
const F_HI = 7600;
const Q = 6;
/** Cutoff of the envelope followers, Hz: fast enough to follow syllables, too slow to follow pitch. */
const ENVELOPE_HZ = 45;

const bandCenters = Array.from({ length: BANDS }, (_, k) => F_LO * Math.pow(F_HI / F_LO, (k + 0.5) / BANDS));
/** Fraction of each band's carrier that is noise rather than a pitched buzz (fricatives live up high). */
const noiseMix = bandCenters.map((c) => Math.min(0.9, Math.max(0.08, (c - 2200) / 3500 + 0.08)));

function toMono(buf: AudioBuffer): Float32Array {
  const n = buf.length;
  const out = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}

function bufferFrom(ctx: BaseAudioContext, data: Float32Array, sr: number): AudioBuffer {
  const b = ctx.createBuffer(1, data.length, sr);
  b.copyToChannel(data as Float32Array<ArrayBuffer>, 0);
  return b;
}

/** `stages` identical biquads in series: a steeper filter than one. Returns the last node. */
function cascade(ctx: BaseAudioContext, from: AudioNode, type: BiquadFilterType, frequency: number, q: number, stages = 2): AudioNode {
  let node = from;
  for (let s = 0; s < stages; s++) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    node.connect(f);
    node = f;
  }
  return node;
}

const bandpass = (ctx: BaseAudioContext, from: AudioNode, freq: number) => cascade(ctx, from, "bandpass", Math.min(freq, ctx.sampleRate * 0.45), Q);

/**
 * Adds `nodes` together through a balanced tree of two-input gains and returns the node with the total.
 *
 * Not one node with many inputs: Chrome adds a node's inputs in an order that changes from render to render,
 * and float addition is order-dependent, so the result would differ in the last bits every time. Adding exactly
 * two signals at a time cannot depend on order (a + b === b + a), which keeps re-renders bit-identical.
 */
function sumTree(ctx: BaseAudioContext, nodes: AudioNode[]): AudioNode {
  let level = nodes;
  while (level.length > 1) {
    const next: AudioNode[] = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 === level.length) {
        next.push(level[i]);
        continue;
      }
      const pair = ctx.createGain();
      level[i].connect(pair);
      level[i + 1].connect(pair);
      next.push(pair);
    }
    level = next;
  }
  return level[0];
}

/** Builds the carrier side: per-band, level-normalised outputs. `into` receives (band index, node). */
function buildCarrierBank(
  ctx: BaseAudioContext,
  saw: AudioBuffer,
  noise: AudioBuffer,
  warp: number,
  gains: Float32Array | null,
  into: (k: number, node: AudioNode) => void,
) {
  const sawSrc = ctx.createBufferSource();
  sawSrc.buffer = saw;
  const noiseSrc = ctx.createBufferSource();
  noiseSrc.buffer = noise;
  for (let k = 0; k < BANDS; k++) {
    const mix = ctx.createGain();
    const sawG = ctx.createGain();
    sawG.gain.value = 1 - noiseMix[k];
    const noiseG = ctx.createGain();
    noiseG.gain.value = noiseMix[k];
    sawSrc.connect(sawG).connect(mix);
    noiseSrc.connect(noiseG).connect(mix);
    const out = bandpass(ctx, mix, bandCenters[k] * warp);
    if (gains) {
      const norm = ctx.createGain();
      norm.gain.value = gains[k];
      out.connect(norm);
      into(k, norm);
    } else into(k, out);
  }
  sawSrc.start(0);
  noiseSrc.start(0);
}

const calibrationCache = new Map<string, Float32Array>();

/** One-off render: measures the RMS of every carrier band so each can be normalised to unity. */
async function carrierGains(sr: number, carrierHz: number, warp: number): Promise<Float32Array> {
  const key = `${sr}:${carrierHz}:${warp}`;
  const hit = calibrationCache.get(key);
  if (hit) return hit;
  const n = Math.round(sr * 1.2);
  const ctx = new OfflineAudioContext(BANDS, n, sr);
  const merger = ctx.createChannelMerger(BANDS);
  buildCarrierBank(ctx, bufferFrom(ctx, sawCarrier(n, sr, 0, carrierHz), sr), bufferFrom(ctx, noiseCarrier(n, sr, 0), sr), warp, null, (k, node) =>
    node.connect(merger, 0, k),
  );
  merger.connect(ctx.destination);
  const rendered = await ctx.startRendering();
  const skip = Math.round(sr * 0.3); // ignore filter warm-up
  const gains = new Float32Array(BANDS);
  for (let k = 0; k < BANDS; k++) {
    const ch = rendered.getChannelData(k);
    let acc = 0;
    for (let i = skip; i < n; i++) acc += ch[i] * ch[i];
    gains[k] = 1 / Math.sqrt(acc / (n - skip) + 1e-12);
  }
  calibrationCache.set(key, gains);
  return gains;
}

/** Vocodes `input` (which starts at absolute time `t0`). Returns mono samples, same length. */
export async function vocode(input: AudioBuffer, t0: number, opts: { carrierHz?: number; formantWarp?: number } = {}): Promise<Float32Array> {
  const sr = input.sampleRate;
  const n = input.length;
  const carrierHz = opts.carrierHz ?? AUDIO_DEFAULTS.carrierHz;
  const warp = opts.formantWarp ?? AUDIO_DEFAULTS.formantWarp;
  const gains = await carrierGains(sr, carrierHz, warp);

  const ctx = new OfflineAudioContext(1, n, sr);
  const mod = ctx.createBufferSource();
  mod.buffer = bufferFrom(ctx, toMono(input), sr);

  // analysis side: band-pass, rectify, smooth -> one envelope per band
  const rectCurve = new Float32Array([1, 0, 1]); // |x|
  const envs: AudioNode[] = [];
  for (let k = 0; k < BANDS; k++) {
    const band = bandpass(ctx, mod, bandCenters[k]);
    const rect = ctx.createWaveShaper();
    rect.curve = rectCurve;
    band.connect(rect);
    const smooth = cascade(ctx, rect, "lowpass", ENVELOPE_HZ, 0.707);
    const scale = ctx.createGain();
    scale.gain.value = 1.5; // mean(|x|) -> RMS
    smooth.connect(scale);
    envs.push(scale);
  }

  // synthesis side: each carrier band's gain is driven by the matching envelope
  const voices: AudioNode[] = [];
  buildCarrierBank(
    ctx,
    bufferFrom(ctx, sawCarrier(n, sr, t0, carrierHz), sr),
    bufferFrom(ctx, noiseCarrier(n, sr, t0), sr),
    warp,
    gains,
    (k, carrier) => {
      const vca = ctx.createGain();
      vca.gain.value = 0; // envelope drives the gain
      envs[k].connect(vca.gain);
      carrier.connect(vca);
      voices.push(vca);
    },
  );
  sumTree(ctx, voices).connect(ctx.destination);
  mod.start(0);
  const rendered = await ctx.startRendering();
  return rendered.getChannelData(0).slice();
}
