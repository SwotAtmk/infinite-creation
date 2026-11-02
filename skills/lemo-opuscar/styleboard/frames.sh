#!/bin/sh
# Collect each style demo's style frame into the gallery: styles/<slug>/demo/stills/styleframe.jpg → img/<slug>_0.jpg
# sh styleboard/frames.sh [slug]: with a slug, only that one style is done (use this for a new style, so every card isn't re-encoded)
cd "$(dirname "$0")"
ONLY="${1:-*}"
[ "$ONLY" = "*" ] || [ -f "../styles/$ONLY/demo/stills/styleframe.jpg" ] || { echo "frames.sh: no styles/$ONLY/demo/stills/styleframe.jpg" >&2; exit 1; }
for f in ../styles/$ONLY/demo/stills/styleframe.jpg; do
  s=$(basename "$(dirname "$(dirname "$(dirname "$f")")")")
  ffmpeg -v error -y -i "$f" -vf scale=1280:-1 -q:v 3 "img/${s}_0.jpg" && echo "$s"
done
python3 build.py
