#!/usr/bin/env bash
# Prepares this repo's skills in Claude Code cloud sessions:
#  - reel-editor: Python packages and an Arabic font with Latin glyphs (Cairo).
#  - ffmpeg-skill: Noto Arabic fonts (installed in the background).
#  - ig-* / li-*: ~/.claude/instagram and ~/.claude/linkedin (voice.md, log.md, plan.md...) point at
#    .claude/instagram and .claude/linkedin in the repo, so voice profiles and post history survive a reset.
# Local machines: reel-editor's setup_check.py covers its needs, so the hook only runs in remote sessions.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

for d in instagram linkedin; do
  mkdir -p "$CLAUDE_PROJECT_DIR/.claude/$d" "$HOME/.claude"
  [ -e "$HOME/.claude/$d" ] || ln -s "$CLAUDE_PROJECT_DIR/.claude/$d" "$HOME/.claude/$d"
done

python3 - <<'PY' 2>/dev/null || python3 -m pip install -q --break-system-packages \
  pillow numpy arabic-reshaper python-bidi faster-whisper onnxruntime fonttools >/dev/null 2>&1
import PIL, numpy, arabic_reshaper, bidi, faster_whisper, onnxruntime, fontTools
PY

# Arabic system fonts for ffmpeg-skill captions (Noto Naskh Arabic renders the lam-alef ligature correctly).
if [ ! -f /usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf ] && command -v apt-get >/dev/null; then
  (apt-get install -y -q fonts-noto-core >/dev/null 2>&1 || (apt-get update -qq && apt-get install -y -q fonts-noto-core)) >/dev/null 2>&1 &
fi

FONT="$HOME/.local/share/fonts/Cairo-Bold.ttf"
if [ ! -f "$FONT" ]; then
  mkdir -p "$(dirname "$FONT")"
  TMP=$(mktemp -d)
  (cd "$TMP" && npm pack -s @fontsource/cairo@5 >/dev/null 2>&1 && tar xzf fontsource-cairo-*.tgz) &&
    python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/build_cairo_font.py" "$TMP/package/files" "$FONT" >/dev/null 2>&1
  rm -rf "$TMP"
fi
exit 0
