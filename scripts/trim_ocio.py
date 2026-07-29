"""Staging-time OCIO diet (see link_blender_web.sh).

A browser canvas is an sRGB display: drop the Display P3 / Rec.1886 /
Rec.2020 / Rec.2100 display definitions and the multi-MB AgX display cubes
they reference, plus the niche Khronos PBR Neutral view (5.3MB cube).
AgX_Base_Rec2020.cube STAYS: the kept False Color view transform samples it.
Only the STAGED copy is patched; the source tree is untouched.
"""
import os
import re
import sys

d = sys.argv[1]
cfg = d + "/config.ocio"
lines = open(cfg).read().splitlines(True)
out = []
i = 0
while i < len(lines):
    l = lines[i]
    if l.startswith("displays:"):
        out.append(l)
        i += 1
        keep = False
        while i < len(lines) and (lines[i].startswith("  ") or lines[i].strip() == ""):
            if re.match(r"^  \S", lines[i]):
                keep = lines[i].startswith("  sRGB:")
            if keep and "Khronos PBR Neutral" not in lines[i]:
                out.append(lines[i])
            i += 1
        continue
    if l.startswith("active_displays:"):
        out.append("active_displays: [sRGB]\n")
        i += 1
        continue
    if l.startswith("active_views:"):
        out.append("active_views: [Standard, ACES 1.3, ACES 2.0, AgX, Filmic, "
                   "Filmic Log, False Color, Raw]\n")
        i += 1
        continue
    out.append(l)
    i += 1
open(cfg, "w").write("".join(out))
for f in ("pbrNeutral.cube", "AgX_Base_P3.cube", "AgX_Rec2100-HLG_p3_lim.cube"):
    os.remove(d + "/luts/" + f)
print("OCIO trimmed")
