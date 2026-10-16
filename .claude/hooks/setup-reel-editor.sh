#!/usr/bin/env bash
# Prepares the reel-editor skill (.claude/skills/reel-editor) in Claude Code cloud sessions:
# Python packages and an Arabic font with Latin glyphs (Cairo). Local machines: the skill's own
# setup_check.py covers this, so the hook only runs in remote sessions.
set -uo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

python3 - <<'PY' 2>/dev/null || python3 -m pip install -q --break-system-packages \
  pillow numpy arabic-reshaper python-bidi faster-whisper onnxruntime fonttools >/dev/null 2>&1
import PIL, numpy, arabic_reshaper, bidi, faster_whisper, onnxruntime, fontTools
PY

FONT="$HOME/.local/share/fonts/Cairo-Bold.ttf"
if [ ! -f "$FONT" ]; then
  mkdir -p "$(dirname "$FONT")"
  TMP=$(mktemp -d)
  (cd "$TMP" && npm pack -s @fontsource/cairo@5 >/dev/null 2>&1 && tar xzf fontsource-cairo-*.tgz) &&
    python3 "$CLAUDE_PROJECT_DIR/.claude/hooks/build_cairo_font.py" "$TMP/package/files" "$FONT" >/dev/null 2>&1
  rm -rf "$TMP"
fi
exit 0
