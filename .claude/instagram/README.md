# Instagram skills data (ig-*)

The `ig-*` skills read and write `~/.claude/instagram/`. In cloud sessions the setup hook
(`.claude/hooks/setup-skills.sh`) links that folder here, so these files are kept in the repo:

- `voice.md` - your voice profile. Start from `voice.template.md`, or send Claude three of your own
  reels and say "write my voice.md from these". Every ig-* skill reads it.
- `log.md` - reels you approved with `/ig-reel` (date, hook formula, first line), used by `/ig-audit`.
- `swipe.md` - what `/ig-viral` found working in your niche.
- `plan.md` - the week from `/ig-plan`.

Skills: github.com/Jakeschincariol/instagram-agent-skill (MIT, see `LICENSE-instagram-agent-skill`).
Local changes in this repo: Arabic/Gulf-dialect support in `ig-reel/hookscore.py`, `ig-reel/beats.py`,
`ig-caption/caption.py`, `ig-human/humanize.py`, `ig-human/detect.py` and an Arabic block in
`ig-human/slop.json`.
