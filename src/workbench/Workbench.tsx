import { TimelineRoot } from "@editframe/react";
import { jobs } from "../jobs";
import { RedactedVideo } from "../redaction/RedactedVideo";
import { resolveTrack } from "../redaction/types";
import { isText, store, useStore } from "./store";
import { usePlayback } from "./usePlayback";

// live preview: reads the plan from the store, so changing a control never remounts the player
const Preview = ({ id }: { id: string }) => {
  const { plan, debug } = useStore();
  return <RedactedVideo id={id} plan={plan} workbench refreshOnChange debug={debug} />;
};

function Slider(p: { label: string; value: number; min: number; max: number; step: number; show: (v: number) => string; onChange: (v: number) => void }) {
  return (
    <label className="block text-xs text-slate-300">
      <span className="flex justify-between">
        <span>{p.label}</span>
        <span className="tabular-nums text-slate-100">{p.show(p.value)}</span>
      </span>
      <input type="range" className="w-full accent-sky-400" min={p.min} max={p.max} step={p.step} value={p.value} onChange={(e) => p.onChange(Number(e.target.value))} />
    </label>
  );
}

function Seg<T extends string>(p: { label: string; value: T; options: T[]; onChange: (v: T) => void }) {
  return (
    <div className="text-xs text-slate-300">
      <div className="mb-1">{p.label}</div>
      <div className="flex overflow-hidden rounded border border-slate-600">
        {p.options.map((o) => (
          <button key={o} type="button" onClick={() => p.onChange(o)} className={`flex-1 px-2 py-1.5 ${o === p.value ? "bg-sky-500 font-semibold text-slate-950" : "bg-slate-800 text-slate-300 hover:bg-slate-700"}`}>
            {o}
          </button>
        ))}
      </div>
    </div>
  );
}

const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-3 rounded-lg border border-slate-700 bg-slate-900 p-3">
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">{title}</h3>
    <div className="space-y-3">{children}</div>
  </section>
);

function Hear({ status, onRedacted, onOriginal }: { status: string; onRedacted: () => void; onOriginal: () => void }) {
  return (
    <div className="flex items-center gap-2">
      <button type="button" className="rounded bg-sky-500 px-3 py-1 text-xs font-semibold text-slate-950 hover:bg-sky-400" onClick={onRedacted}>
        ▶ hear it
      </button>
      <button type="button" className="rounded bg-slate-700 px-3 py-1 text-xs text-slate-100 hover:bg-slate-600" onClick={onOriginal}>
        ▶ original
      </button>
      <span className="text-[11px] text-slate-400">{status}</span>
    </div>
  );
}

export function Workbench() {
  const { job, plan, controls: c, debug } = useStore();
  const { status, busy, hear, playAll, pause } = usePlayback(plan);

  const reds = plan.audio?.redactions ?? [];
  const beepRed = reds.find((r) => r.role === "beep");
  const voiceRed = reds.find((r) => r.role === "voice");
  const hasBlurred = plan.video.some((t) => resolveTrack(t, plan.defaults).treatment === "scramble");
  const hasTextBoxes = plan.video.some(isText);

  return (
    <div className="grid h-screen grid-cols-[minmax(0,1fr)_340px] bg-slate-950 text-slate-100">
      <main className="min-w-0 p-3">
        <div className="h-[calc(100vh-1.5rem)] overflow-hidden rounded-lg border border-slate-800">
          <TimelineRoot key={job} id={`wb-${job}`} component={Preview} />
        </div>
      </main>

      <aside className="overflow-y-auto border-l border-slate-800 p-3">
        <div className="mb-3 flex items-center gap-2">
          <select className="flex-1 rounded border border-slate-600 bg-slate-800 px-2 py-1 text-sm" value={job} onChange={(e) => store.setJob(e.target.value)}>
            {Object.keys(jobs).map((j) => (
              <option key={j}>{j}</option>
            ))}
          </select>
          <label className="flex items-center gap-1 text-xs text-slate-300">
            <input type="checkbox" checked={debug} onChange={(e) => store.setDebug(e.target.checked)} />
            show boxes
          </label>
        </div>

        {reds.length > 0 && (
          <div className="mb-3 flex gap-2">
            <button type="button" disabled={!!busy && !busy.startsWith("live")} className="flex-1 rounded bg-emerald-500 px-2 py-1.5 text-xs font-semibold text-slate-950 disabled:opacity-50" onClick={playAll}>
              {busy || "▶ play with redacted audio"}
            </button>
            <button type="button" className="rounded bg-slate-700 px-3 py-1.5 text-xs" onClick={pause}>
              ■
            </button>
          </div>
        )}

        {(hasBlurred || hasTextBoxes) && (
          <Card title="Video">
            {hasBlurred && <Slider label="Blur strength" value={c.blur} min={0.5} max={2} step={0.05} show={(v) => `${Math.round(v * 100)}%`} onChange={(v) => store.set({ blur: v })} />}
            {hasTextBoxes && <Seg label="Text boxes" value={c.textBoxes} options={["solid", "blur"]} onChange={(v) => store.set({ textBoxes: v })} />}
          </Card>
        )}

        {beepRed && (
          <Card title="Spoken name">
            <Seg label="Replace with" value={c.beep} options={["beep", "hush", "silence"]} onChange={(v) => store.set({ beep: v })} />
            {c.beep === "beep" && <Slider label="Beep pitch" value={c.beepHz} min={200} max={1000} step={10} show={(v) => `${v} Hz`} onChange={(v) => store.set({ beepHz: v })} />}
            <Hear status={status[beepRed.id] ?? ""} onRedacted={() => hear(beepRed, true)} onOriginal={() => hear(beepRed, false)} />
          </Card>
        )}

        {voiceRed && (
          <Card title="Disguised voice">
            <Slider label="Voice pitch" value={c.voiceHz} min={70} max={220} step={1} show={(v) => `${v} Hz`} onChange={(v) => store.set({ voiceHz: v })} />
            <Slider label="Voice character" value={c.voiceCharacter} min={0.7} max={1.3} step={0.01} show={(v) => (v < 0.9 ? "darker" : v > 1.1 ? "brighter" : "neutral")} onChange={(v) => store.set({ voiceCharacter: v })} />
            <Hear status={status[voiceRed.id] ?? ""} onRedacted={() => hear(voiceRed, true)} onOriginal={() => hear(voiceRed, false)} />
          </Card>
        )}

        <div className="mt-4 flex gap-2">
          <button type="button" className="flex-1 rounded bg-slate-700 px-2 py-1.5 text-xs" onClick={() => navigator.clipboard.writeText(JSON.stringify(plan, null, 2))}>
            copy plan JSON
          </button>
          <button type="button" className="rounded bg-rose-900 px-3 py-1.5 text-xs" onClick={() => store.reset()}>
            reset
          </button>
        </div>
        <p className="mt-3 text-[11px] leading-snug text-slate-500">Choices are remembered in this browser. "copy plan JSON" gives the effective plan for the current choices.</p>
      </aside>
    </div>
  );
}
