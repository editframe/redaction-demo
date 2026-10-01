/**
 * Real-time redacted audio for interactive tools.
 *
 * Editframe's live player schedules decoded samples straight to the speakers (a private path we can't
 * route through our chain), and our source <Video> is muted precisely so that nothing unredacted can
 * ever play. So for a live preview we do what the exporter does, just paced by the clock instead of as
 * fast as possible:
 *
 *     tap.getAudioBuffer(t, t + 0.5)      <- the attachAudioRedaction() wrapper: PCM -> treat ranges
 *          -> AudioBufferSourceNode scheduled on the AudioContext timeline, ~1-2 s ahead of the playhead
 *
 * Nothing is rendered up front: the first audio starts after ~1 s of lookahead and the rest is produced
 * while it plays. The "tap" is a second, never-played <ef-video> on the same file, used only as a PCM
 * source, so the real (muted) video element is never unmuted and cannot leak in the player.
 */

import { attachAudioRedaction, type PcmSourceElement, WINDOW_SEC } from "./audio-chain";
import type { AudioRedaction } from "./types";

/** Seconds of audio produced before playback starts, so the first windows are not late. */
const PREROLL = 1.0;
/** How far ahead of the playhead audio is produced; beyond this the loop waits. */
const AHEAD = 2.0;

let ctx: AudioContext | null = null;
export const audioContext = () => (ctx ??= new AudioContext());

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A hidden, never-played media element carrying the redaction chain; dispose() removes it. */
export function createRedactedTap(src: string, redactions: AudioRedaction[], margin?: number) {
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:-9999px;top:0;width:8px;height:8px;overflow:hidden;pointer-events:none";
  const el = document.createElement("ef-video") as unknown as PcmSourceElement;
  el.setAttribute("src", src);
  host.appendChild(el);
  document.body.appendChild(host);
  const detach = attachAudioRedaction(el, redactions, margin);
  return {
    el,
    dispose() {
      detach();
      host.remove();
    },
  };
}

export interface LiveStats {
  /** processing time / audio time, so 0.2 means the chain runs 5x faster than real time */
  realtimeFactor: number;
  underruns: number;
}

export interface LiveOptions {
  from: number;
  to: number;
  signal: AbortSignal;
  /** Called at the instant the first audio is scheduled to start (start the video here). */
  onStart?: () => void;
  onStats?: (s: LiveStats) => void;
}

/** Plays `tap`'s redacted audio for [from, to) as it is produced. Resolves when finished or aborted. */
export async function playRedactedLive(tap: PcmSourceElement, { from, to, signal, onStart, onStats }: LiveOptions): Promise<void> {
  const c = audioContext();
  await c.resume();
  const sources = new Set<AudioBufferSourceNode>();
  let anchor: number | null = null; // AudioContext time at which media time `from` is heard
  const preroll: { t: number; buf: AudioBuffer }[] = [];
  let procMs = 0;
  let audioSec = 0;
  let underruns = 0;

  /** Schedules the window that starts at media time `t`, given the AudioContext time at which `from` is heard. */
  const start = (anchorAt: number, t: number, buf: AudioBuffer) => {
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.onended = () => sources.delete(src);
    sources.add(src);
    const when = anchorAt + (t - from);
    const now = c.currentTime;
    if (when >= now) src.start(when);
    else if (now - when < buf.duration) {
      underruns++; // the chain fell behind: play what is left of this window
      src.start(now, now - when);
    } else underruns++;
  };
  const stopAll = () => {
    for (const s of sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    sources.clear();
  };
  signal.addEventListener("abort", stopAll);

  try {
    let t = from;
    while (t < to && !signal.aborted) {
      if (anchor !== null && t - (from + (c.currentTime - anchor)) > AHEAD) {
        await sleep(40); // far enough ahead; don't run the chain faster than needed
        continue;
      }
      const end = Math.min(t + WINDOW_SEC, to);
      const t0 = performance.now();
      const buf = await tap.getAudioBuffer(t, end);
      if (!buf) throw new Error("no audio from the redaction tap");
      procMs += performance.now() - t0;
      audioSec += end - t;
      onStats?.({ realtimeFactor: procMs / 1000 / audioSec, underruns });
      if (anchor === null) {
        preroll.push({ t, buf });
        if (end - from >= PREROLL || end >= to) {
          anchor = c.currentTime + 0.08;
          onStart?.();
          for (const p of preroll) start(anchor, p.t, p.buf);
          preroll.length = 0;
        }
      } else start(anchor, t, buf);
      t = end;
    }
    while (!signal.aborted && anchor !== null && c.currentTime < anchor + (to - from)) await sleep(50);
  } finally {
    signal.removeEventListener("abort", stopAll);
    stopAll();
  }
}
