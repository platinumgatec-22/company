# Builds one Cairo Bold TTF (Arabic + Latin) from the @fontsource/cairo web subsets, and maps the Arabic
# presentation-form code points to the font's own init/medi/fina/isol glyphs — the reel-editor skill draws
# text pre-shaped (arabic-reshaper), so it needs those code points.
# usage: python3 build_cairo_font.py <fontsource files dir> <out.ttf>
import sys, os, tempfile
from fontTools.ttLib import TTFont
from fontTools.merge import Merger
from arabic_reshaper.letters import LETTERS_ARABIC

src, out = sys.argv[1], sys.argv[2]
tmp = tempfile.mkdtemp()
parts = []
for sub in ("arabic", "latin"):
    f = TTFont(os.path.join(src, f"cairo-{sub}-700-normal.woff"))
    f.flavor = None
    p = os.path.join(tmp, f"{sub}.ttf")
    f.save(p)
    parts.append(p)
font = Merger().merge(parts)

cmap = font.getBestCmap()
forms = {}
gsub = font["GSUB"].table
for rec in gsub.FeatureList.FeatureRecord:
    if rec.FeatureTag not in ("isol", "init", "medi", "fina"):
        continue
    for i in rec.Feature.LookupListIndex:
        lookup = gsub.LookupList.Lookup[i]
        for st in lookup.SubTable:
            st = st.ExtSubTable if lookup.LookupType == 7 else st
            if hasattr(st, "mapping"):
                forms.setdefault(rec.FeatureTag, {}).update(st.mapping)
for ch, pres in LETTERS_ARABIC.items():
    base = cmap.get(ord(ch))
    if not base:
        continue
    for tag, p in zip(("isol", "init", "medi", "fina"), pres):
        glyph = forms.get(tag, {}).get(base, base if tag == "isol" else None)
        if p and glyph:
            for t in font["cmap"].tables:
                if t.isUnicode():
                    t.cmap.setdefault(ord(p), glyph)
font.save(out)
print("saved", out)
