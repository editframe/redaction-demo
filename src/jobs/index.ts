import type { RedactionPlan } from "../redaction/types";
import screenRecording from "./screen-recording.plan.json";
import talkingHead from "./talking-head.plan.json";

/** Every job is just data: where the source is, and what to obscure, where, and when. */
export const jobs: Record<string, RedactionPlan> = {
  "talking-head": talkingHead as RedactionPlan,
  "screen-recording": screenRecording as RedactionPlan,
};
