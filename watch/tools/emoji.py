"""Erzeugt die Emoji-Bilder der Uhr aus Noto Color Emoji (SIL OFL 1.1).
Aufruf: uv run --with pillow python tools/emoji.py [Pfad/zu/NotoColorEmoji.ttf]
Ausgabe: resources/emoji/{c28,c36,bw28}/NN.png – Reihenfolge = EMOJI[] in src/c/main.c."""
import os, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

EMOJI = ["\U0001F44D", "\U0001F60A", "\U0001F602", "❤️", "\U0001F609", "\U0001F600", "\U0001F618", "\U0001F62E",
         "\U0001F622", "\U0001F61E", "\U0001F621", "\U0001F914", "\U0001F44B", "\U0001F389", "\U0001F64F", "\U0001F44C", "\U0001F44E"]
font = ImageFont.truetype(sys.argv[1] if len(sys.argv) > 1 else "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf", 109)
out = os.path.join(os.path.dirname(__file__), "..", "resources", "emoji")

def glyph(e):
    im = Image.new("RGBA", (160, 160), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((80, 80), e, font=font, embedded_color=True, anchor="mm")
    return im.crop(im.getbbox())

def square(im, n):
    im.thumbnail((n, n), Image.LANCZOS)
    s = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    s.paste(im, ((n - im.width) // 2, (n - im.height) // 2))
    return s

def color(im, n):
    s = square(im.copy(), n)
    a = s.getchannel("A").point(lambda v: 255 if v > 110 else 0)   # Pebble kennt nur wenige Alpha-Stufen
    s.putalpha(a)
    return s

def bw(im, n):
    """S/W: weiße Fläche mit schwarzer Kontur und dunklen Details (Augen, Mund) – Hintergrund weiß."""
    big = square(im.copy(), n * 4)
    a = big.getchannel("A").point(lambda v: 255 if v > 128 else 0)
    lum = Image.new("RGB", big.size, "white"); lum.paste(big, mask=big)
    dark = lum.convert("L").point(lambda v: 255 if v < 90 else 0)
    inner = a.filter(ImageFilter.MinFilter(9))                     # Kontur = Maske minus erodierte Maske
    ed = Image.new("L", big.size, 0); ed.paste(255, mask=a); ed.paste(0, mask=inner)
    ink = Image.new("L", big.size, 0); ink.paste(255, mask=ed); ink.paste(255, mask=dark)
    small = ink.resize((n, n), Image.BOX).point(lambda v: 0 if v > 80 else 255)
    return small.convert("1")

for i, e in enumerate(EMOJI):
    g = glyph(e)
    for d, f in (("c28", lambda: color(g, 28)), ("c36", lambda: color(g, 36)), ("bw28", lambda: bw(g, 28))):
        os.makedirs(os.path.join(out, d), exist_ok=True)
        f().save(os.path.join(out, d, "%02d.png" % i))
print("ok", len(EMOJI))
