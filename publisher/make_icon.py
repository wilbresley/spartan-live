"""Recorta o emblema e gera um ícone quadrado em bitmap, que a barra do Windows lê nítido."""

import struct
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "Spartan Live.png"
ICO = ROOT / "assets" / "Spartan-Live.ico"
PNG = ROOT / "assets" / "spartan-taskbar.png"
SIZES = (16, 20, 24, 32, 40, 48, 64, 96, 128, 256)


def badge_square(source=SOURCE):
    image = Image.open(source).convert("RGBA")
    mask = image.getchannel("A").point(lambda pixel: 255 if pixel > 12 else 0)
    box = mask.getbbox() or (0, 0, image.width, image.height)
    crop = image.crop(box)
    side = min(crop.size)
    left = (crop.width - side) // 2
    top = (crop.height - side) // 2
    return crop.crop((left, top, left + side, top + side))


def downscale(image, size):
    current = image
    while current.width > size * 2:
        nxt = max(size, current.width // 2)
        current = current.resize((nxt, nxt), Image.Resampling.BOX)
    if current.size != (size, size):
        current = current.resize((size, size), Image.Resampling.LANCZOS)
    return current


def dib_bytes(image):
    image = image.convert("RGBA")
    width, height = image.size
    bgra = image.tobytes("raw", "BGRA")
    row = width * 4
    xor = b"".join(bgra[y * row:(y + 1) * row] for y in range(height - 1, -1, -1))
    mask_row = ((width + 31) // 32) * 4
    mask = bytearray(mask_row * height)
    rgba = image.tobytes("raw", "RGBA")
    for y in range(height):
        source_y = height - 1 - y
        for x in range(width):
            if rgba[(source_y * width + x) * 4 + 3] < 16:
                mask[y * mask_row + (x // 8)] |= 0x80 >> (x % 8)
    header = struct.pack(
        "<IiiHHIIiiII",
        40, width, height * 2, 1, 32, 0, len(xor) + len(mask), 0, 0, 0, 0,
    )
    return header + xor + bytes(mask)


def write_icons(source=SOURCE, ico=ICO, png=PNG):
    square = badge_square(source)
    frames = [(size, dib_bytes(downscale(square, size))) for size in SIZES]
    blob = struct.pack("<HHH", 0, 1, len(frames))
    offset = 6 + 16 * len(frames)
    entries = b""
    images = b""
    for size, dib in frames:
        byte = 0 if size >= 256 else size
        entries += struct.pack("<BBBBHHII", byte, byte, 0, 0, 1, 32, len(dib), offset)
        images += dib
        offset += len(dib)
    ico.write_bytes(blob + entries + images)
    downscale(square, 512).save(png)


def read_frame(path, size):
    data = Path(path).read_bytes()
    count = struct.unpack_from("<H", data, 4)[0]
    offset = 6
    for _index in range(count):
        width, _height, _colors, _reserved, _planes, _bits, nbytes, image_offset = struct.unpack_from("<BBBBHHII", data, offset)
        offset += 16
        if (width or 256) != size:
            continue
        dib = data[image_offset:image_offset + nbytes]
        header = struct.unpack_from("<IiiHHIIiiII", dib, 0)
        pixel_w, stored_h = header[1], header[2] // 2
        xor = dib[40:40 + pixel_w * stored_h * 4]
        row = pixel_w * 4
        raw = b"".join(xor[y * row:(y + 1) * row] for y in range(stored_h - 1, -1, -1))
        image = Image.frombytes("RGBA", (pixel_w, stored_h), raw, "raw", "BGRA")
        return image
    raise KeyError(size)


if __name__ == "__main__":
    raise SystemExit("assets/Spartan-Live.ico é o arquivo pronto. Este script não substitui ele.")
