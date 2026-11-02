#!/bin/sh
# Publish local changes: refresh the gallery data, check the repo, pack and upload films and asset packs, verify the releases.
# After it passes:  git add -A && git commit -m "…" && git push     (add -A: the new files must go in too)
# Don't commit tools/assets.json from a run that failed: it may point at packs that were never uploaded.
set -e
cd "$(dirname "$0")/.."
python3 styleboard/build.py
sh tools/web_cuts.sh
python3 tools/release.py check
python3 tools/release.py pack
python3 tools/release.py upload
python3 tools/release.py verify
echo
git status --short 2>/dev/null | head -30 || true
echo "Ready. Next: git add -A && git commit -m \"…\" && git push      (-A, not -a: untracked files are part of the release)"
