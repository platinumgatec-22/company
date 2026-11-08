# Installed skills — sources

Installed 2026-11-08. Each upstream folder was copied unchanged.

| Skill | Source | Role |
|---|---|---|
| chief-of-staff (experimental) | mattpocock/skills@4ae2317 skills/in-progress | requested |
| teach | mattpocock/skills@4ae2317 skills/productivity | requested |
| grill-me | mattpocock/skills@4ae2317 skills/productivity | requested |
| grilling | mattpocock/skills@4ae2317 skills/productivity | needed by grill-me |
| retro, to-spec, to-tickets, implement-spec | mattpocock/skills@4ae2317 skills/engineering | needed by chief-of-staff |
| writing-for-agents | mattpocock/skills@4ae2317 skills/productivity | needed by retro |
| setup-matt-pocock-skills | mattpocock/skills@4ae2317 skills/engineering | needed by to-spec / to-tickets / implement-spec |
| tdd, codebase-design | mattpocock/skills@4ae2317 skills/engineering | needed by implement-spec |
| marketing-psychology | coreyhaines31/marketingskills@96798cf skills | requested |
| anatomy | wheresryan22/anatomy@1482e84 (repo root) | requested |

Notes:
- mattpocock's `code-review` was not copied, so it doesn't shadow the built-in /code-review that implement-spec calls.
- In anatomy, the .git and .github folders and the built example outputs (examples/*/*.html and *.pdf) were left out. Run `node examples/<name>/build.mjs` to rebuild them.
