"""Builds every vector file of the repath identity from one drawing and one recipe.

The mark is a lowercase r whose arm is a step response: it rises, overshoots, rings and settles.
It is one stroke on a 128 grid. The wordmark is "repath" in Geist, weight 600, tracking -35
units (-0.035 em), turned into outlines so no file needs the font.

Outputs, in the folder above this one:
  mark/      the r alone: colour for dark grounds, colour for light grounds, ink, paper, currentColor
  icon/      the r on its tile: dark (the main one), light, and the small cut for 32 px and under
  logo/      the r and the name on one line, in the same five colourings
  wordmark/  the name alone
  favicon/   favicon.svg (the small cut) and the full-bleed squares the PNG files are made from
  tools/assets.json   paths and sizes, for the page of the guidelines

Run from anywhere:  python -I tools/build.py   then   node tools/make.cjs
"""
import json
import sys
from pathlib import Path

import uharfbuzz as hb
from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.recordingPen import DecomposingRecordingPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = Path(__file__).resolve().parent.parent
# The same Geist the app self-hosts, from its @fontsource-variable/geist dependency.
GEIST = ROOT.parent / "web/node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2"
INSTANCE = ROOT / "tools" / "geist-600.ttf"

# The drawing. One stroke, round caps and joins, 7 units wide on the 128 grid.
MARK = "M36 102V66c0-26 6-40 14-40s9 30 17 30 8-18 15-18 7 9 14 9 5-4 12-4"
STROKE = 7
SMALL_STROKE = 10.5  # the small cut, for 32 px and under
# Ink bounds of the stroke: x 32.5..111.5, y 22.5..105.5. The square below is centred on it.
MARK_BOX = (24, 16, 96, 96)

BLUE, GREEN = "#4ea8ff", "#7fe3a0"  # on dark grounds
BLUE_DAY, GREEN_DAY = "#1f7fe0", "#17a35a"  # on light grounds
INK, PAPER, SNOW, NIGHT = "#12151c", "#f6f7f9", "#e8edf5", "#0e1116"

WEIGHT = 600
TRACKING = -35
EM = 64  # px per em of the name in the logo files


def number(value):
    return ("%.3f" % value).rstrip("0").rstrip(".")


def gradient(a, b, name="signal"):
    return (
        f'<linearGradient id="{name}" x1="40" x2="104" gradientUnits="userSpaceOnUse">'
        f'<stop offset=".25" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>'
    )


def stroke(paint, width=STROKE, more=""):
    return f'<path d="{MARK}" fill="none" stroke="{paint}" stroke-width="{number(width)}" stroke-linecap="round" stroke-linejoin="round"{more}/>'


# name -> (defs, paint of the mark, fill of the name)
COLOURINGS = {
    "": (gradient(BLUE, GREEN), "url(#signal)", SNOW),
    "-day": (gradient(BLUE_DAY, GREEN_DAY), "url(#signal)", INK),
    "-ink": ("", INK, INK),
    "-paper": ("", "#ffffff", "#ffffff"),
    "-current": ("", "currentColor", "currentColor"),
}


def svg(view, body, title, defs=""):
    box = " ".join(number(v) for v in view)
    head = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{box}" role="img" aria-label="{title}">\n\t<title>{title}</title>\n'
    if defs:
        head += f"\t<defs>{defs}</defs>\n"
    return head + f"\t{body}\n</svg>\n"


def write(folder, name, content):
    target = ROOT / folder
    target.mkdir(parents=True, exist_ok=True)
    (target / name).write_text(content, encoding="utf-8", newline="\n")


def name_outline():
    """The name as one path at EM px per em, its left ink edge at x = 0 and its baseline at y = 0."""
    if not INSTANCE.exists():
        font = instantiateVariableFont(TTFont(GEIST), {"wght": WEIGHT})
        font.flavor = None
        font.save(INSTANCE)
    font = TTFont(INSTANCE)
    scale = EM / font["head"].unitsPerEm
    shaper = hb.Font(hb.Face(INSTANCE.read_bytes()))
    buf = hb.Buffer()
    buf.add_str("repath")
    buf.guess_segment_properties()
    hb.shape(shaper, buf, {"kern": True, "liga": False})
    order, glyph_set = font.getGlyphOrder(), font.getGlyphSet()
    glyphs, x = [], 0.0
    for info, pos in zip(buf.glyph_infos, buf.glyph_positions):
        glyphs.append((order[info.codepoint], x + pos.x_offset))
        x += pos.x_advance + TRACKING * font["head"].unitsPerEm / 1000

    def draw(pen, dx=0.0, k=1.0, flip=1.0):
        for glyph, at in glyphs:
            recording = DecomposingRecordingPen(glyph_set)
            glyph_set[glyph].draw(recording)
            recording.replay(TransformPen(pen, (k, 0, 0, flip * k, (at + dx) * k, 0)))

    bounds = BoundsPen(glyph_set)
    draw(bounds)
    left, bottom, right, top = bounds.bounds
    pen = SVGPathPen(glyph_set, ntos=number)
    draw(pen, -left, scale, -1.0)
    return pen.getCommands(), (right - left) * scale, top * scale, -bottom * scale


def tile(dark, width=STROKE, glow=True, square=False, inset=1.0):
    """The r on its ground. `square` drops the round corners and the edge, for full-bleed files."""
    top, ground, edge = ("#1a202b", "#10141b", "#2c3442") if dark else ("#ffffff", "#f1f3f6", "#dfe3ea")
    a, b = (BLUE, GREEN) if dark else (BLUE_DAY, GREEN_DAY)
    defs = f'<linearGradient id="ground" x2="0" y2="1"><stop stop-color="{top}"/><stop offset="1" stop-color="{ground}"/></linearGradient>' + gradient(a, b)
    if square:
        body = '<rect width="128" height="128" fill="url(#ground)"/>'
    else:
        body = f'<rect x=".75" y=".75" width="126.5" height="126.5" rx="28" fill="url(#ground)" stroke="{edge}" stroke-width="1.5"/>'
    drawing = ""
    if glow and dark:
        defs += '<filter id="halo" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="6"/></filter>'
        drawing += stroke("url(#signal)", width, ' filter="url(#halo)" opacity=".6"')
    drawing += stroke("url(#signal)", width)
    if inset != 1.0:
        drawing = f'<g transform="translate(64 64) scale({number(inset)}) translate(-72 -64)">{drawing}</g>'
    else:
        drawing = f'<g transform="translate(-8 0)">{drawing}</g>'
    return defs, body + "\n\t" + drawing


def build():
    d, name_width, ascent, descent = name_outline()
    # The r stands on the baseline and is a little taller than the h, so the two read as one line.
    mark_height = ascent * 1.16
    k = mark_height / 83  # 83 is the ink height of the stroke
    mark_width = 79 * k
    gap = EM * 0.15
    height = mark_height + descent
    baseline = mark_height
    place = f"translate({number(-32.5 * k)} {number(baseline - 105.5 * k)}) scale({number(k)})"
    logo_view = (0, 0, mark_width + gap + name_width, height)
    word_view = (0, 0, name_width, ascent + descent)

    for suffix, (defs, paint, fill) in COLOURINGS.items():
        write("mark", f"repath-mark{suffix}.svg", svg(MARK_BOX, stroke(paint), "repath", defs))
        body = f'<g transform="{place}">{stroke(paint)}</g>\n\t<path d="{d}" fill="{fill}" transform="translate({number(mark_width + gap)} {number(baseline)})"/>'
        write("logo", f"repath-logo{suffix}.svg", svg(logo_view, body, "repath", defs))
        if suffix != "-day":
            name = suffix if suffix else "-snow"
            write("wordmark", f"repath-wordmark{name}.svg", svg(word_view, f'<path d="{d}" fill="{fill}" transform="translate(0 {number(ascent)})"/>', "repath"))

    square = (0, 0, 128, 128)
    for name, args in {
        "repath-icon.svg": dict(dark=True),
        "repath-icon-light.svg": dict(dark=False),
        "repath-icon-small.svg": dict(dark=True, width=SMALL_STROKE, glow=False),
    }.items():
        defs, body = tile(**args)
        write("icon", name, svg(square, body, "repath", defs))
    defs, body = tile(True, SMALL_STROKE, glow=False)
    write("favicon", "favicon.svg", svg(square, body, "repath", defs))
    # Full-bleed squares: the system that shows them cuts its own corners.
    defs, body = tile(True, square=True, inset=0.86)
    write("favicon", "square.svg", svg(square, body, "repath", defs))
    defs, body = tile(True, square=True, inset=0.66)
    write("favicon", "maskable.svg", svg(square, body, "repath", defs))

    assets = {
        "mark": {"d": MARK, "stroke": STROKE, "smallStroke": SMALL_STROKE, "box": MARK_BOX},
        "name": {"d": d, "width": name_width, "ascent": ascent, "descent": descent, "em": EM, "weight": WEIGHT, "tracking": TRACKING},
        "logo": {"width": logo_view[2], "height": height, "markScale": k, "markWidth": mark_width, "gap": gap, "baseline": baseline, "place": place},
        "colours": {"blue": BLUE, "green": GREEN, "blueDay": BLUE_DAY, "greenDay": GREEN_DAY, "ink": INK, "paper": PAPER, "snow": SNOW, "night": NIGHT},
    }
    write("tools", "assets.json", json.dumps(assets, indent="\t"))
    print("logo %.2f x %.2f, name %.2f wide, mark scale %.4f" % (logo_view[2], height, name_width, k))


if __name__ == "__main__":
    build()
