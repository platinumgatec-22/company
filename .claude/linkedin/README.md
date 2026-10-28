# LinkedIn skills data (li-*)

The `li-*` skills read and write `~/.claude/linkedin/`. In cloud sessions the setup hook
(`.claude/hooks/setup-skills.sh`) links that folder here, so these files are kept in the repo:

- `voice.md` - the voice profile every li-* skill reads. Started from `voice.template.md` and the
  material Platinum Gate has published; lines marked [confirm] still need an answer.
- `log.md` - posts approved with `/li-post` (date, hook formula, first line), used by `/li-audit`.
- `plan.md` - the week from `/li-plan`.

Skills: github.com/Jakeschincariol/linkedin-agent-skill (MIT, see `LICENSE-linkedin-agent-skill`).
Local changes in this repo: `li-human/detect.py` and `li-human/humanize.py` are the Arabic-aware
versions from `ig-human` (Arabic words, dialect contractions, «،» and «؟», Arabic-Indic numbers),
and `li-human/slop.json` carries the Arabic phrase block from `ig-human/slop.json`.
