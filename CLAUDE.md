# Notes for Claude

## Video skills in `.claude/skills/`

- `reel-editor` (montage → MP4 / CapCut / Premiere), `ig-*` (Instagram writing), and HeyGen's
  `hyperframes`, `hyperframes-cli`, `hyperframes-registry`, `media-use` (HTML → video, captions).
- HeyGen retired the `embedded-captions` skill on 2026-10-21; captions now live in
  `hyperframes/references/captions.md`. Don't try `npx skills add ... --skill embedded-captions`.
- Cloud sessions: the renderer's Chrome can't reach CDNs (cdn.jsdelivr.net etc.). In HyperFrames
  projects, vendor scripts from npm into `assets/vendor/` (e.g. `npm pack gsap@3.14.2`, copy
  `package/dist/gsap.min.js`) and reference them root-relative. Run `npx hyperframes browser ensure`
  once per container before the first render.
- Arabic text: use the Cairo font from `~/.local/share/fonts/Cairo-Bold.ttf` (built by
  `.claude/hooks/setup-skills.sh`) via `@font-face` from `assets/fonts/`.
