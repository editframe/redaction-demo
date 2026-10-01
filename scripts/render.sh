#!/usr/bin/env bash
# Renders a redaction job with Editframe. Needs the dev server (npm run dev).
#
#   scripts/render.sh <job>              -> output/<job>.redacted.mp4
#   scripts/render.sh <job> --nolabels   -> work/<job>.nolabels.mp4  (plain blocks, for `verify.py --nolabels`)
set -euo pipefail
cd "$(dirname "$0")/.."

job=${1:?usage: scripts/render.sh <job> [--nolabels]}
base=${EF_BASE:-http://127.0.0.1:5173}

if [[ ${2:-} == "--nolabels" ]]; then
  url="$base/jobs/$job.html?nolabels"
  out="work/$job.nolabels.mp4"
else
  url="$base/jobs/$job.html"
  out="output/$job.redacted.mp4"
fi

mkdir -p "$(dirname "$out")"
EF_NO_TELEMETRY=1 npx editframe render --url "$url" -o "$out"
echo "-> $out"
