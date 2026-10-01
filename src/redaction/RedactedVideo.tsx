import type { EFTimegroupElement, EFVideoElement } from "@editframe/elements";
import { Timegroup, Video } from "@editframe/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { attachAudioRedaction, type PcmSourceElement } from "./audio-chain";
import { sampleKeys } from "./interpolate";
import { Scrambler } from "./scramble";
import { type BoxState, PLAN_DEFAULTS, ROUND_RADIUS, type RedactionPlan, type ResolvedTrack, resolveTrack, type Shape, validatePlan } from "./types";

export interface RedactedVideoProps {
  /** Passed through by <TimelineRoot>; becomes the root timegroup's id. */
  id?: string;
  plan: RedactionPlan;
  className?: string;
  /** Wrap in Editframe's workbench (player UI). Only for a top-level composition. */
  workbench?: boolean;
  /** Re-draw the current frame whenever the plan changes (interactive tools only; never during a render). */
  refreshOnChange?: boolean;
  /** Print each track's label inside its box (default true). Off = plain blocks, used by the leak test. */
  labels?: boolean;
  /** Show the tracks as translucent red outlines instead of redacting. For authoring only. */
  debug?: boolean;
}

type Part = "box" | "label";
type Registry = Map<string, Partial<Record<Part, HTMLDivElement>>>;

const radiusFor = (shape: Shape) => (shape === "ellipse" ? "50%" : shape === "round" ? `${ROUND_RADIUS}px` : "2px");

/** `box` is the interpolated box grown by the track's padding. */
const padded = (s: BoxState, pad: number): BoxState => ({ x: s.x - pad, y: s.y - pad, w: s.w + pad * 2, h: s.h + pad * 2, r: s.r });

/** Positions a track's element (and shrinks or hides its label) for the current frame. */
function placeBox({ box: el, label }: Partial<Record<Part, HTMLDivElement>>, box: BoxState) {
  if (!el) return;
  el.style.display = "block";
  el.style.width = `${box.w.toFixed(2)}px`;
  el.style.height = `${box.h.toFixed(2)}px`;
  el.style.transform = `translate(${box.x.toFixed(2)}px, ${box.y.toFixed(2)}px) rotate(${box.r.toFixed(3)}deg)`;
  if (label) {
    label.style.fontSize = `${Math.max(11, Math.min(24, box.h * 0.28)).toFixed(1)}px`;
    label.style.display = box.h < 30 || box.w < 60 ? "none" : "flex";
  }
}

let scrambleWarned = false;

/**
 * Draws the scramble for `track` and returns the colour the element should show underneath it. If anything
 * goes wrong that is the track's opaque fill, never the raw pixels.
 */
function drawScramble(scrambler: Scrambler | null, videoCanvas: HTMLCanvasElement | null, track: ResolvedTrack, box: BoxState): string {
  if (!scrambler || !videoCanvas) return track.fill;
  try {
    return scrambler.draw(videoCanvas, box, track.shape, track.scramble);
  } catch (error) {
    if (!scrambleWarned) {
      scrambleWarned = true;
      console.warn("redaction: scramble failed, covering with the opaque fill instead", error);
    }
    return track.fill;
  }
}

/**
 * Renders `plan.source` with its video tracks and audio ranges redacted.
 *
 * Video  — each track is an opaque shape that follows its keyframes on the composition clock. A track is
 *          either a flat fill ("solid") or scramble+blur ("scramble"); both sit on an opaque base, and a
 *          full-frame black cover stays up until the first frame has been processed (fail closed).
 * Audio  — the source <Video> is permanently muted and its PCM is only reachable through
 *          attachAudioRedaction(), which replaces the ranges in the plan (see audio-chain.ts).
 */
export function RedactedVideo({ id, plan: rawPlan, className, workbench = false, refreshOnChange = false, labels: showLabels = true, debug = false }: RedactedVideoProps) {
  const plan = useMemo(() => validatePlan(rawPlan), [rawPlan]);
  const tracks = useMemo(() => plan.video.map((t) => resolveTrack(t, plan.defaults)), [plan]);
  const labelColor = plan.defaults?.labelColor ?? PLAN_DEFAULTS.labelColor;
  const { width, height } = plan.source;

  const videoRef = useRef<EFVideoElement>(null);
  const rootRef = useRef<EFTimegroupElement>(null);
  const coverRef = useRef<HTMLDivElement>(null);
  const overlayHost = useRef<HTMLDivElement>(null);
  const scramblerRef = useRef<Scrambler | null>(null);
  const els = useRef<Registry>(new Map());

  const register = useCallback((trackId: string, part: Part, el: HTMLDivElement | null) => {
    const entry = els.current.get(trackId) ?? {};
    if (el) entry[part] = el;
    else delete entry[part];
    els.current.set(trackId, entry);
  }, []);

  // --- audio chain: attach before anything can be exported -------------------------------------
  useLayoutEffect(() => {
    const el = videoRef.current as unknown as PcmSourceElement | null;
    if (!el) return;
    return attachAudioRedaction(el, plan.audio?.redactions ?? [], plan.defaults?.audioMargin);
  }, [plan]);

  // --- scramble overlay canvas ------------------------------------------------------------------
  useLayoutEffect(() => {
    const host = overlayHost.current;
    if (!host || !tracks.some((t) => t.treatment === "scramble")) return;
    const scrambler = new Scrambler(width, height);
    scrambler.overlay.style.cssText = "position:absolute;left:0;top:0;width:100%;height:100%;";
    host.replaceChildren(scrambler.overlay);
    scramblerRef.current = scrambler;
    return () => {
      host.replaceChildren();
      scramblerRef.current = null;
    };
  }, [tracks, width, height]);

  // --- per-frame driver --------------------------------------------------------------------------
  const onFrame = useCallback(
    ({ ownCurrentTime: t }: { ownCurrentTime: number }) => {
      const scrambler = scramblerRef.current;
      scrambler?.clear();
      const videoCanvas = videoRef.current?.querySelector<HTMLCanvasElement>('canvas[part="canvas"]') ?? null;

      for (const track of tracks) {
        const entry = els.current.get(track.id);
        if (!entry?.box) continue;
        const first = track.keys[0].t;
        const last = track.keys[track.keys.length - 1].t;
        if (t < first - track.timeMargin || t > last + track.timeMargin) {
          entry.box.style.display = "none";
          continue;
        }
        const box = padded(sampleKeys(track.keys, t), track.padding);
        placeBox(entry, box);
        if (track.treatment === "scramble" && !debug) entry.box.style.background = drawScramble(scrambler, videoCanvas, track, box);
      }
      // first frame processed: lift the cover
      if (coverRef.current) coverRef.current.style.display = "none";
    },
    [tracks, debug],
  );

  useEffect(() => {
    const tg = rootRef.current;
    if (!refreshOnChange || !tg || !tg.paused) return;
    void tg.seekForRender(tg.currentTime).catch(() => {});
  }, [plan, debug, refreshOnChange]);

  const renderBox = (track: ResolvedTrack) => <Box key={track.id} track={track} labelColor={labelColor} showLabels={showLabels} debug={debug} register={register} />;

  return (
    <Timegroup id={id} ref={rootRef} workbench={workbench} className={className ?? "relative overflow-hidden bg-black"} style={{ width, height }} onFrame={onFrame}>
      {/* muted on purpose; the audio chain unmutes it only to fetch PCM it then redacts */}
      <Video ref={videoRef} src={plan.source.src} muted className="absolute inset-0 size-full" />

      {/* opaque bases under the scramble canvas, then the canvas, then the solid fills on top */}
      <div data-redaction-layer style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}>
        {tracks.filter((t) => t.treatment === "scramble").map(renderBox)}
        <div ref={overlayHost} style={{ position: "absolute", inset: 0 }} />
        {tracks.filter((t) => t.treatment !== "scramble").map(renderBox)}
      </div>

      {/* fail-closed cover: black until the first frame has been processed */}
      <div ref={coverRef} data-redaction-cover style={{ position: "absolute", inset: 0, background: "#000" }} />
    </Timegroup>
  );
}

function Box(props: {
  track: ResolvedTrack;
  labelColor: string;
  showLabels: boolean;
  debug: boolean;
  register: (trackId: string, part: Part, el: HTMLDivElement | null) => void;
}) {
  const { track, labelColor, showLabels, debug, register } = props;
  // a scramble track never prints its label (the text would sit on top of the blur)
  const text = debug ? track.id : showLabels && track.treatment !== "scramble" ? track.label : undefined;
  return (
    <div
      ref={(el) => register(track.id, "box", el)}
      data-redact-id={track.id}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        display: "none",
        overflow: "hidden",
        transformOrigin: "50% 50%",
        borderRadius: radiusFor(track.shape),
        background: debug ? "rgba(239,68,68,.35)" : track.fill,
        outline: debug ? "3px solid #ef4444" : undefined,
      }}
    >
      {text && (
        <div
          ref={(el) => register(track.id, "label", el)}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            font: "600 20px/1 'SF Mono', Menlo, Consolas, monospace",
            letterSpacing: ".14em",
            textTransform: "uppercase",
            whiteSpace: "nowrap",
            color: debug ? "#fff" : labelColor,
          }}
        >
          {text}
        </div>
      )}
    </div>
  );
}
