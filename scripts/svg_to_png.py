from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageColor, ImageDraw, ImageFont


def number(value: str | None, fallback: float = 0.0) -> float:
    if not value:
        return fallback
    match = re.match(r"[-+0-9.eE]+", value)
    return float(match.group(0)) if match else fallback


def color(value: str | None, opacity: float = 1.0):
    if not value or value == "none":
        return None
    rgb = ImageColor.getrgb(value)
    return (*rgb[:3], round(255 * opacity))


def render(svg_path: Path, png_path: Path) -> None:
    root = ET.parse(svg_path).getroot()
    width = max(1, round(number(root.attrib.get("width"), 1200)))
    height = max(1, round(number(root.attrib.get("height"), 700)))
    image = Image.new("RGBA", (width, height), (17, 21, 28, 255))
    draw = ImageDraw.Draw(image, "RGBA")
    font = ImageFont.load_default()

    def walk(node: ET.Element, tx: float = 0.0, ty: float = 0.0) -> None:
        transform = node.attrib.get("transform", "")
        translated = re.search(r"translate\(([-+0-9.eE]+)[ ,]+([-+0-9.eE]+)\)", transform)
        if translated:
            tx += float(translated.group(1))
            ty += float(translated.group(2))

        tag = node.tag.rsplit("}", 1)[-1]
        opacity = number(node.attrib.get("opacity"), 1.0)
        fill = color(node.attrib.get("fill"), opacity)
        stroke = color(node.attrib.get("stroke"), opacity)
        stroke_width = max(1, round(number(node.attrib.get("stroke-width"), 1)))

        if tag == "rect":
            x = number(node.attrib.get("x")) + tx
            y = number(node.attrib.get("y")) + ty
            w = number(node.attrib.get("width"))
            h = number(node.attrib.get("height"))
            draw.rounded_rectangle(
                (x, y, x + w, y + h),
                radius=number(node.attrib.get("rx")),
                fill=fill,
                outline=stroke,
                width=stroke_width,
            )
        elif tag == "line":
            draw.line(
                (
                    number(node.attrib.get("x1")) + tx,
                    number(node.attrib.get("y1")) + ty,
                    number(node.attrib.get("x2")) + tx,
                    number(node.attrib.get("y2")) + ty,
                ),
                fill=stroke,
                width=stroke_width,
            )
        elif tag == "circle":
            cx = number(node.attrib.get("cx")) + tx
            cy = number(node.attrib.get("cy")) + ty
            radius = number(node.attrib.get("r"))
            draw.ellipse(
                (cx - radius, cy - radius, cx + radius, cy + radius),
                fill=fill,
                outline=stroke,
                width=stroke_width,
            )
        elif tag == "text" and node.text:
            draw.text(
                (number(node.attrib.get("x")) + tx, number(node.attrib.get("y")) + ty),
                node.text,
                fill=fill or (238, 242, 248, 255),
                font=font,
                anchor="ls",
            )

        for child in node:
            walk(child, tx, ty)

    walk(root)
    image.convert("RGB").save(png_path)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: svg_to_png.py input.svg [output.png]")
    source = Path(sys.argv[1]).resolve()
    target = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else source.with_suffix(".png")
    render(source, target)
    print(f"{source} -> {target}")
