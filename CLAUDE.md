# Notes for Claude

## Video skills in `.claude/skills/`

- `reel-editor` (montage → MP4 / CapCut / Premiere), `ig-*` (Instagram writing), and HeyGen's
  `hyperframes`, `hyperframes-cli`, `hyperframes-registry`, `media-use` (HTML → video, captions).
- HeyGen retired its workflow skills on 2026-10-21 and folded them into `hyperframes`:
  `embedded-captions` → `hyperframes/references/captions.md`, `talking-head-recut` (cards, lower
  thirds, PiP over a talking head) → `hyperframes/references/overlays.md`. Don't run
  `npx skills add ... --skill <retired name>`; it finds nothing.
- Cloud sessions: the renderer's Chrome can't reach CDNs (cdn.jsdelivr.net etc.). In HyperFrames
  projects, vendor scripts from npm into `assets/vendor/` (e.g. `npm pack gsap@3.14.2`, copy
  `package/dist/gsap.min.js`) and reference them root-relative. Run `npx hyperframes browser ensure`
  once per container before the first render.
- Arabic text: use the Cairo font from `~/.local/share/fonts/Cairo-Bold.ttf` (built by
  `.claude/hooks/setup-skills.sh`) via `@font-face` from `assets/fonts/`.

## ffmpeg-skill (`.claude/skills/ffmpeg-skill`, from npm `ffmpeg-skill`)

- Arabic captions: pass `--font "Noto Naskh Arabic"`. The auto-picked Noto Sans Arabic drops the
  لا (lam-alef) ligature to a missing-glyph box in libass; Noto Kufi Arabic renders nothing.
- Refresh with `npx ffmpeg-skill --project` (copies are not updated automatically).
