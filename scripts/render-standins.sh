#!/usr/bin/env bash
# Renders the two stand-in source videos with Editframe, then normalises them the way a real upload
# would be prepared (h264 + aac 48k, short GOP, faststart). Needs the dev server (npm run dev).
# The talking-head stand-in also needs src/assets/public/nasa-solar-orbiter-interview.mp4 (see README).
set -euo pipefail
cd "$(dirname "$0")/.."
export EF_NO_TELEMETRY=1
base=${EF_BASE:-http://127.0.0.1:5173}
mkdir -p work src/assets/source

for name in talking-head screen-recording; do
  raw="work/$name.raw.mp4"
  npx editframe render --url "$base/standins/$name.html" -o "$raw"

  if ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$raw" | grep -q .; then
    audio=(-c:a aac -ar 48000 -b:a 192k)
  else
    audio=(-an)
  fi
  ffmpeg -y -v error -i "$raw" -c:v libx264 -crf 14 -preset slow -g 30 -pix_fmt yuv420p "${audio[@]}" \
    -movflags +faststart "src/assets/source/$name.mp4"
  echo "-> src/assets/source/$name.mp4"
done
