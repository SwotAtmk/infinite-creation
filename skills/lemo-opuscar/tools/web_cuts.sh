#!/bin/sh
# 720p web cuts for the gallery (served by GitHub Pages as video/mp4, which Safari needs).
# A cut is made when it doesn't exist yet or when its film is newer; a failing ffmpeg stops the run with exit 1.
cd "$(dirname "$0")/.."
mkdir -p .release/web
fail=0
webcut() {   # webcut <film> <slug>
  src=$1; out=.release/web/$2.mp4
  [ -f "$out" ] && [ ! "$src" -nt "$out" ] && return 0
  if ffmpeg -v error -y -i "$src" -vf "scale=-2:720:flags=lanczos" -c:v libx264 -preset slow -crf 24 -maxrate 2M -bufsize 4M -pix_fmt yuv420p \
    -c:a aac -b:a 128k -movflags +faststart -f mp4 "$out.part"; then mv "$out.part" "$out"; echo "$2 $(du -h "$out" | cut -f1)"
  else rm -f "$out.part"; echo "✗ $2: ffmpeg could not make the web cut of $src" >&2; fail=1; fi
}
for f in styles/*/STYLE.md; do
  s=$(basename "$(dirname "$f")")
  [ -f "styles/$s/$s.mp4" ] && webcut "styles/$s/$s.mp4" "$s"
done
for f in .release/films/*.mp4; do      # feature films (not a style), e.g. opuscar98
  [ -f "$f" ] || continue
  s=$(basename "$f" .mp4)
  [ -f "styles/$s/STYLE.md" ] || webcut "$f" "$s"
done
du -sh .release/web
[ "$fail" = 0 ] || exit 1
