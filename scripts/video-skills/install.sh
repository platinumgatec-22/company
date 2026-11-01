#!/usr/bin/env bash
# Installs the five video-editing skill sets for Claude Code by copying their
# skill folders (no third-party code is executed by this script).
#
#   1+2. HyperFrames (embedded-captions and talking-head-recut were retired
#        upstream on 2026-10-21 and folded into the `hyperframes` skill)
#   3.   Herk Edit Kit  -> cloned as its own workspace (open Claude inside it)
#   4.   FFmpeg Skill   -> ~/.claude/skills/ffmpeg-skill
#   5.   Video Toolkit  -> cloned workspace + ~/.claude/skills/video-toolkit
#
# Usage: bash scripts/video-skills/install.sh [workspace_dir]
set -euo pipefail

WORK="${1:-$HOME/video-kits}"
SKILLS="$HOME/.claude/skills"
mkdir -p "$WORK" "$SKILLS"

clone() { # repo dir
  if [ -d "$WORK/$2/.git" ]; then git -C "$WORK/$2" pull -q --ff-only
  else git clone -q --depth 1 "https://github.com/$1.git" "$WORK/$2"; fi
}

clone heygen-com/hyperframes hyperframes
clone nateherkai/herk-edit-kit herk-edit-kit
clone kajisho5/ffmpeg-skill ffmpeg-skill
clone digitalsamba/claude-code-video-toolkit claude-code-video-toolkit

# 1+2. HyperFrames skills
for s in hyperframes hyperframes-cli hyperframes-registry media-use; do
  rm -rf "${SKILLS:?}/$s"
  cp -r "$WORK/hyperframes/skills/$s" "$SKILLS/"
done

# 4. FFmpeg skill: the file set its README lists for a manual install
rm -rf "$SKILLS/ffmpeg-skill"; mkdir -p "$SKILLS/ffmpeg-skill"
( cd "$WORK/ffmpeg-skill" && cp -r SKILL.md package.json scripts templates references docs mcp "$SKILLS/ffmpeg-skill/" )

# 5. Video toolkit skill (it locates the toolkit clone at run time)
mkdir -p "$SKILLS/video-toolkit"
cp "$WORK/claude-code-video-toolkit/skills/video-toolkit/SKILL.md" "$SKILLS/video-toolkit/"

echo "Installed skills in $SKILLS:"; ls "$SKILLS"
echo "Workspaces in $WORK:"; ls "$WORK"
cat <<EOF

Next steps (these run third-party code; review first):
  ffmpeg-skill : python3 $SKILLS/ffmpeg-skill/scripts/doctor.py
  hyperframes  : npx hyperframes doctor
  herk kit     : cd $WORK/herk-edit-kit && npm ci && npm run setup && npm test
  toolkit      : cd $WORK/claude-code-video-toolkit/examples/hello-world && npm install && npm run render
EOF
