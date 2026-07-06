#!/usr/bin/env python3

from pathlib import Path
import argparse
from PIL import Image

# Размеры создаваемых PNG
PNG_ICONS = {
    "apple-touch-icon.png": 180,
    "favicon-16.png": 16,
    "favicon-32.png": 32,
    "favicon-48.png": 48,
    "favicon-64.png": 64,
    "master-1024.png": 1024,
}


def make_square(img: Image.Image) -> Image.Image:
    """Делает изображение квадратным, добавляя прозрачные поля."""
    w, h = img.size

    if w == h:
        return img

    size = max(w, h)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(img, ((size - w) // 2, (size - h) // 2))
    return canvas


def resize(img: Image.Image, size: int) -> Image.Image:
    return img.resize((size, size), Image.Resampling.LANCZOS)


def generate_icons(input_png: Path, output_dir: Path):
    output_dir.mkdir(parents=True, exist_ok=True)

    img = Image.open(input_png).convert("RGBA")
    img = make_square(img)

    # PNG
    for filename, size in PNG_ICONS.items():
        icon = resize(img, size)
        icon.save(output_dir / filename)

    # ICO (несколько размеров внутри)
    ico_sizes = [(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]

    img.save(
        output_dir / "favicon.ico",
        format="ICO",
        sizes=ico_sizes,
    )

    print(f"Icons saved to {output_dir.resolve()}")


def main():
    parser = argparse.ArgumentParser(
        description="Generate favicon set from PNG."
    )

    parser.add_argument("input", help="Input PNG")
    parser.add_argument(
        "-o",
        "--output",
        default="icons",
        help="Output directory (default: icons)",
    )

    args = parser.parse_args()

    generate_icons(Path(args.input), Path(args.output))


if __name__ == "__main__":
    main()