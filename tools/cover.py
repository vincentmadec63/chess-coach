#!/usr/bin/env python3
"""Ajoute une image de couverture en toute première image d'un Short (pour que TikTok et YouTube la prennent
comme vignette par défaut).

La couverture : un plan officiel Rockstar du catalogue (vidéo à l'instant t, ou capture), recadré en 9:16,
assombri, avec un sur-titre et 2 ou 3 lignes de titre en gros, plus « Footage: Rockstar Games ».

Usage :
  python3 cover.py --video in.mp4 --out out.mp4 --shot '<entrée JSON du catalogue>' \
      --kicker "GTA 6" --line "THE PS5 PRO" --line "YOU CAN'T BUY:sun" [--hold 0.1] [--png cover.png]
  Couleur d'une ligne : suffixe :sun / :coral / :cyan / :pink (défaut : blanc).
"""
import argparse, json, os, subprocess, sys, tempfile
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import shortgen3 as sg

W, H = 1080, 1920


def font(weight, size):
    names = {"black": ["InterDisplay-Black.otf", "DejaVuSans-Bold.ttf"],
             "bold": ["InterDisplay-Bold.otf", "DejaVuSans-Bold.ttf"]}[weight]
    for n in names:
        for d in sg.FONT_DIRS:
            if os.path.exists(d + n):
                return ImageFont.truetype(d + n, size)
    return ImageFont.load_default()


def grab_background(shot, tmp):
    src = sg.expand_src(shot["src"])
    png = os.path.join(tmp, "bg.png")
    if shot.get("kind") == "video" or not sg.is_image(src):
        t = float(shot.get("t", 0)) + min(1.0, float(shot.get("d", 2)) / 2)
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-ss", str(t), "-i", src, "-frames:v", "1", png],
                       check=True, timeout=300)
        img = Image.open(png).convert("RGB")
        x = float(shot.get("x", 0.5))
    else:
        img = Image.open(sg.local_media(src) if hasattr(sg, "local_media") else src).convert("RGB")
        x = (float(shot.get("x0", 0.5)) + float(shot.get("x1", 0.5))) / 2
    w, h = img.size
    cw = int(h * 9 / 16)
    if cw <= w:
        left = int(max(0, min(w - cw, x * w - cw / 2)))
        img = img.crop((left, 0, left + cw, h))
    return img.resize((W, H), Image.LANCZOS)


def build_cover(shot, kicker, lines, tmp):
    bg = grab_background(shot, tmp)
    # assombrissement progressif vers le bas pour la lisibilité
    shade = Image.new("L", (W, H))
    sd = ImageDraw.Draw(shade)
    for y in range(H):
        a = 45 if y < 700 else int(45 + (y - 700) / (H - 700) * 160)
        sd.line([(0, y), (W, y)], fill=a)
    img = Image.composite(Image.new("RGB", (W, H), (12, 6, 24)), bg, shade)
    d = ImageDraw.Draw(img)
    # titre : taille adaptée à la ligne la plus longue
    parsed = []
    for ln in lines:
        t, c = ln, "text"
        if ":" in ln and ln.rsplit(":", 1)[-1] in sg.COL:
            t, c = ln.rsplit(":", 1)
        parsed.append((t, sg.COL.get(c, sg.COL["text"])))
    size = 190
    while size > 80:
        f = font("black", size)
        if all(d.textbbox((0, 0), t, font=f, stroke_width=10)[2] <= 980 for t, _ in parsed):
            break
        size -= 6
    f = font("black", size)
    lh = int(size * 1.08)
    y0 = 1020 - (len(parsed) * lh) // 2
    if kicker:
        fk = font("bold", 64)
        b = d.textbbox((0, 0), kicker.upper(), font=fk)
        d.text(((W - b[2]) // 2, y0 - 100), kicker.upper(), font=fk, fill=sg.COL["cyan"],
               stroke_width=6, stroke_fill=(12, 6, 24))
    for i, (t, col) in enumerate(parsed):
        b = d.textbbox((0, 0), t, font=f, stroke_width=10)
        d.text(((W - b[2]) // 2, y0 + i * lh), t, font=f, fill=col, stroke_width=10, stroke_fill=(12, 6, 24))
    fc = font("bold", 34)
    cred = "Footage: Rockstar Games"
    b = d.textbbox((0, 0), cred, font=fc)
    d.text(((W - b[2]) // 2, 1560), cred, font=fc, fill=(220, 214, 235))
    return img


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--shot", required=True, help="entrée JSON du catalogue broll_index.json")
    ap.add_argument("--kicker", default="GTA 6")
    ap.add_argument("--line", action="append", required=True)
    ap.add_argument("--hold", type=float, default=0.1, help="durée de la couverture en secondes")
    ap.add_argument("--png", help="enregistre aussi la couverture en PNG")
    a = ap.parse_args()
    shot = json.loads(a.shot)
    if set(shot.get("tags", [])) & {"violent", "text"}:
        sys.exit("ERREUR : plan violent ou avec texte refusé pour la couverture")
    with tempfile.TemporaryDirectory() as tmp:
        cov = build_cover(shot, a.kicker, a.line, tmp)
        cp = os.path.join(tmp, "cover.png")
        cov.save(cp)
        if a.png:
            cov.save(a.png)
        fps = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
                              "stream=r_frame_rate", "-of", "csv=p=0", a.video],
                             capture_output=True, text=True).stdout.strip() or "30"
        sr = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
                             "stream=sample_rate", "-of", "csv=p=0", a.video],
                            capture_output=True, text=True).stdout.strip() or "48000"
        fc = (f"[0:v]scale={W}:{H},fps={fps},format=yuv420p,setsar=1[cv];"
              f"[1:v]fps={fps},format=yuv420p,setsar=1[mv];"
              f"[2:a]aformat=sample_rates={sr}:channel_layouts=stereo[ca];"
              f"[1:a]aformat=sample_rates={sr}:channel_layouts=stereo[ma];"
              "[cv][ca][mv][ma]concat=n=2:v=1:a=1[v][a]")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y",
                        "-loop", "1", "-t", str(a.hold), "-i", cp,
                        "-i", a.video,
                        "-f", "lavfi", "-t", str(a.hold), "-i", f"anullsrc=r={sr}:cl=stereo",
                        "-filter_complex", fc, "-map", "[v]", "-map", "[a]",
                        "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
                        "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", a.out], check=True)
    print("couverture ajoutée :", a.out)


if __name__ == "__main__":
    main()
