from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
items = [
    ("Exact-width one-shot baseline: 14/27", ROOT / "results/nodiff/baseline/routing.png"),
    ("Block local-first: 9/27", ROOT / "results/nodiff/block-local-first/routing.png"),
    ("Skeleton-first before timed-out repair: 12/27", ROOT / "results/nodiff/skeleton-first-repair/routing.png"),
]

images = [(label, Image.open(path).convert("RGB")) for label, path in items]
width = max(image.width for _, image in images)
label_height = 34
height = sum(image.height + label_height for _, image in images)
canvas = Image.new("RGB", (width, height), "#0b0e13")
draw = ImageDraw.Draw(canvas)
font = ImageFont.load_default(size=18)

y = 0
for label, image in images:
    draw.rectangle((0, y, width, y + label_height), fill="#0b0e13")
    draw.text((12, y + label_height / 2), label, fill="#f0f3f8", font=font, anchor="lm")
    y += label_height
    canvas.paste(image, (0, y))
    y += image.height

output = ROOT / "results/nodiff-comparison.png"
canvas.save(output)
print(output)
