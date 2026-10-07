# llm-council (vendored skill)

Vendored from https://github.com/tenfoldmarc/llm-council-skill at commit
`0dc03275b0ddf542545da3a9684510fff31df353` (MIT, per upstream README).

Claude Code loads this automatically as a project skill when working in this repo.
Trigger it with phrases like "council this", "pressure-test this", or "debate this",
followed by a decision you want stress-tested by five advisor sub-agents.

Each run writes `council-report-*.html` and `council-transcript-*.md`; these are
git-ignored at the repo root.

To update: re-copy `SKILL.md` from upstream and bump the commit hash above.
