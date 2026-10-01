import type { EFTimegroupElement } from "@editframe/elements";
import { useRef, useState } from "react";
import { createRedactedTap, type LiveStats, playRedactedLive } from "../redaction/live-audio";
import type { AudioRedaction, RedactionPlan } from "../redaction/types";
import { clipOriginal, decodeSource, playOriginal, stopOriginal } from "./audition";

const statsText = (st: LiveStats) => `live · ${st.realtimeFactor.toFixed(2)}× real time${st.underruns ? ` · ${st.underruns} late` : ""}`;
const timegroup = () => document.querySelector<EFTimegroupElement>("ef-timegroup");

/**
 * Audio playback for the workbench. One session at a time: starting a new one, or calling `pause`, aborts
 * the current one (which stops the audio, and the video too for "play all").
 */
export function usePlayback(plan: RedactionPlan) {
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const session = useRef<AbortController | null>(null);
  const setS = (id: string, v: string) => setStatus((s) => ({ ...s, [id]: v }));

  const reds = plan.audio?.redactions ?? [];
  const margin = plan.defaults?.audioMargin;

  const stopAll = () => {
    session.current?.abort();
    session.current = null;
    stopOriginal();
  };

  /** Plays a redaction and a second either side. The audio is redacted window by window, just ahead of the playhead. */
  const hear = async (r: AudioRedaction, redacted: boolean) => {
    stopAll();
    const ac = new AbortController();
    session.current = ac;
    const from = Math.max(0, r.start - 1);
    const to = r.end + 1;
    try {
      if (!redacted) {
        setS(r.id, "playing original");
        const decoded = await decodeSource(plan.source.src);
        await playOriginal(clipOriginal(decoded, from, Math.min(to, decoded.duration)));
      } else {
        setS(r.id, "buffering…");
        const tap = createRedactedTap(plan.source.src, reds, margin);
        try {
          await playRedactedLive(tap.el, { from, to, signal: ac.signal, onStats: (st) => setS(r.id, statsText(st)) });
        } finally {
          tap.dispose();
        }
      }
    } catch (e) {
      setS(r.id, `error: ${(e as Error).message}`);
      return;
    }
    setS(r.id, "");
  };

  /** Plays the preview from the playhead with redacted audio produced live, in step with the video. */
  const playAll = async () => {
    const tg = timegroup();
    if (!tg) return;
    stopAll();
    const ac = new AbortController();
    session.current = ac;
    setBusy("buffering…");
    const tap = createRedactedTap(plan.source.src, reds, margin);
    let started = false;
    const watch = setInterval(() => {
      if (started && tg.paused) ac.abort(); // user paused the player: stop the audio too
    }, 200);
    try {
      await playRedactedLive(tap.el, {
        from: Math.min(tg.currentTime, tg.duration - 0.5),
        to: tg.duration,
        signal: ac.signal,
        onStart: () => {
          void tg.play();
          setTimeout(() => (started = true), 400); // give the player a moment to leave its paused state
        },
        onStats: (st) => setBusy(statsText(st)),
      });
    } catch (e) {
      setBusy(`error: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 2500));
    } finally {
      clearInterval(watch);
      tap.dispose();
      if (!tg.paused) tg.pause();
      setBusy("");
    }
  };

  const pause = () => {
    stopAll();
    timegroup()?.pause();
  };

  return { status, busy, hear, playAll, pause };
}
