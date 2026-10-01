import { useSyncExternalStore } from "react";
import { jobs } from "../jobs";
import { AUDIO_DEFAULTS, type RedactionPlan, resolveTrack, type VideoTrack, validatePlan } from "../redaction/types";

/**
 * The workbench exposes a handful of choices, not the whole plan. The plan that is previewed (and exported)
 * is always derived: shipped plan  +  these controls  ->  effective plan.
 */
export interface Controls {
  /** multiplier on every blur radius and edge softness (1 = as shipped) */
  blur: number;
  /** how rectangular text boxes (lower-third, screen text) are obscured */
  textBoxes: "solid" | "blur";
  /** sound that replaces the spoken name */
  beep: "beep" | "hush" | "silence";
  beepHz: number;
  /** pitch of the disguised voice */
  voiceHz: number;
  /** <1 deeper/darker, >1 brighter */
  voiceCharacter: number;
}

/** Scramble settings used when a text box is switched from a solid fill to a blur. */
export const TEXT_BLUR = { cell: 4, tile: 12, blur: 7, feather: 4 };
export const isText = (t: VideoTrack) => (t.shape ?? "rect") === "rect";
const role = (plan: RedactionPlan, r: string) => plan.audio?.redactions.find((x) => x.role === r);

export function defaultsFor(plan: RedactionPlan): Controls {
  const beep = role(plan, "beep");
  const voice = role(plan, "voice");
  return {
    blur: 1,
    textBoxes: "solid",
    beep: beep?.treatment === "hush" ? "hush" : beep?.treatment === "silence" ? "silence" : "beep",
    beepHz: beep?.hz ?? AUDIO_DEFAULTS.hz,
    voiceHz: voice?.carrierHz ?? AUDIO_DEFAULTS.carrierHz,
    voiceCharacter: voice?.formantWarp ?? AUDIO_DEFAULTS.formantWarp,
  };
}

export function applyControls(base: RedactionPlan, c: Controls): RedactionPlan {
  const plan: RedactionPlan = JSON.parse(JSON.stringify(base));
  for (const t of plan.video) {
    const r = resolveTrack(t, plan.defaults);
    if (r.treatment === "solid" && isText(t)) {
      if (c.textBoxes !== "blur") continue;
      t.treatment = "scramble";
      t.scramble = { ...TEXT_BLUR, blur: TEXT_BLUR.blur * c.blur, feather: TEXT_BLUR.feather * c.blur };
    } else if (r.treatment === "scramble") {
      t.scramble = { ...r.scramble, blur: r.scramble.blur * c.blur, feather: r.scramble.feather * c.blur };
    }
  }
  const beep = role(plan, "beep");
  if (beep) {
    beep.treatment = c.beep === "beep" ? "bleep" : c.beep;
    beep.hz = c.beepHz;
  }
  const voice = role(plan, "voice");
  if (voice) {
    voice.carrierHz = c.voiceHz;
    voice.formantWarp = c.voiceCharacter;
  }
  return validatePlan(plan);
}

interface State {
  job: string;
  base: RedactionPlan;
  controls: Controls;
  plan: RedactionPlan;
  debug: boolean;
}

const key = (job: string) => `redaction-workbench-controls:${job}`;

function init(job: string): State {
  const base = jobs[job];
  let controls = defaultsFor(base);
  try {
    const saved = localStorage.getItem(key(job));
    if (saved) controls = { ...controls, ...JSON.parse(saved) };
  } catch {
    /* defaults */
  }
  return { job, base, controls, plan: applyControls(base, controls), debug: false };
}

const first = new URLSearchParams(location.search).get("job");
let state = init(first && first in jobs ? first : Object.keys(jobs)[0]);
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const store = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  set(patch: Partial<Controls>) {
    const controls = { ...state.controls, ...patch };
    localStorage.setItem(key(state.job), JSON.stringify(controls));
    state = { ...state, controls, plan: applyControls(state.base, controls) };
    emit();
  },
  setJob(job: string) {
    state = { ...init(job), debug: state.debug };
    emit();
  },
  reset() {
    localStorage.removeItem(key(state.job));
    state = { ...init(state.job), debug: state.debug };
    emit();
  },
  setDebug(debug: boolean) {
    state = { ...state, debug };
    emit();
  },
};

export const useStore = () => useSyncExternalStore(store.subscribe, store.get);
