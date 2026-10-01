# Privacy rendering

Render a video with private regions and audio ranges obscured. A **redaction plan** (plain JSON) goes into
`<RedactedVideo>`, and Editframe renders the composition to an mp4. No detection here: you supply the
coordinates and time ranges.

- video: `solid` fill, or `scramble` (cells averaged, shuffled with secure randomness, blurred; not invertible)
- audio: `silence`, `hush` (pink noise), `bleep`, `disguise` (vocoder re-synthesis; cannot be pitch-shifted back)

## Run it

```sh
npm i
npm run dev                          # http://127.0.0.1:5173
#   /jobs/<name>.html                the composition that gets rendered (?debug = outlines, ?nolabels = plain blocks)
#   /workbench.html                  preview + a few controls + live redacted audio
npm run render -- talking-head       # -> output/talking-head.redacted.mp4   (needs `npm run dev` running)
npm run verify -- talking-head output/talking-head.redacted.mp4    # independent leak test (python, see below)
npm run typecheck
```

## Port it into your system

1. Copy `src/redaction/` (`types`, `RedactedVideo`, `interpolate`, `scramble`, `audio-chain`, `audio/`). It needs
   React 18, `@editframe/react` and `@editframe/elements`. `live-audio.ts` is for interactive previews only.
2. Produce a plan (`types.ts` is the schema, and `validatePlan` throws on anything malformed). Times are seconds on the
   source video's timeline, coordinates are source pixels, boxes are linearly interpolated between keys:

   ```json
   {
     "version": 1,
     "source": { "src": "/clip.mp4", "width": 1920, "height": 1080 },
     "video": [{ "id": "face", "treatment": "scramble", "shape": "ellipse",
                 "keys": [{ "t": 0, "x": 800, "y": 200, "w": 300, "h": 380 }, { "t": 4, "x": 900, "y": 210, "w": 300, "h": 380 }] }],
     "audio": { "redactions": [{ "id": "name", "start": 0.4, "end": 1.28, "treatment": "bleep" }] }
   }
   ```
3. Mount `<RedactedVideo plan={plan} workbench />` inside Editframe's `TimelineRoot` on a page, then
   `editframe render --url <page> -o out.mp4` (see `src/main.tsx` and `scripts/render.sh`).
4. Chromium only: it uses canvas `filter` and `OfflineAudioContext`.

Fail-closed by design: an invalid plan throws, a black cover stays up until the first frame is processed, a failed
scramble falls back to the opaque fill, and the source `<Video>` is permanently muted: its audio is only reachable
through `attachAudioRedaction()`, which replaces the planned ranges. (The workbench's "original" button plays the
unredacted audio on purpose; it is an authoring aid and is never part of a render.)

## Layout

```
src/redaction/   the portable core (above)
src/jobs/        <job>.plan.json + index.ts registry
src/workbench/   authoring UI (workbench.html)
jobs/            one html page per job (the CLI appends its own query string, so the job is chosen by path)
standins/        synthetic source footage + per-job configs (demo only)
scripts/         render, extract-tracks, verify, trackers
```

Add a job: `src/jobs/<name>.plan.json`, register it in `src/jobs/index.ts`, copy `jobs/talking-head.html` to `jobs/<name>.html`.

## Demo footage and regenerating the plans

The two source videos in `src/assets/source/` are synthetic stand-ins, rendered from `standins/*.html`. Every
private element there is tagged `data-pii`, and `scripts/extract-tracks.mjs` measures it frame by frame to produce
the plan and a per-frame ground truth (`work/<job>.truth.json`) that `scripts/verify.py` uses as an independent check.

The plans are **generated**: edit `standins/<job>.job.json` (styling, windows, audio ranges), not the plan.

```sh
npm run extract                  # dev server running + Google Chrome: rewrites src/jobs/*.plan.json
npm run check:plans              # fails if a plan on disk differs from what its job file generates
npm run render -- <job> --nolabels && npm run verify -- <job> work/<job>.nolabels.mp4 --nolabels   # strict leak test
npm run standins                 # re-render the stand-in sources (needs ffmpeg)
```

Python deps for `verify.py` and the trackers: `pip install -r scripts/requirements.txt`.

The talking-head stand-in uses a NASA interview clip that is not committed. Download it from
[NASA SVS 13534](https://svs.gsfc.nasa.gov/13534/) (credits: Michelle Handleman, Courtney A. Lee) and save it as
`src/assets/public/nasa-solar-orbiter-interview.mp4`. It is only needed to re-render the stand-in. Check NASA's media
usage guidelines before reusing it.
