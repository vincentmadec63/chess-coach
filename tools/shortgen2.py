#!/usr/bin/env python3
"""Shorts 1080x1920, version 2 : voix off anglaise, sous-titres mot à mot, fond synthwave animé original,
musique originale et effets sonores générés par code. Aucune image de jeu.

Usage : python3 shortgen2.py spec.json [--frames 0.0,4.2]   (--frames : PNG de contrôle seulement)

Spec :
{
  "out": "fichier.mp4",
  "source": "Source: ...",                      (bas de l'écran, 70 caractères max)
  "seed": 12,                                   (optionnel : musique)
  "segments": [
    {"say": "Texte lu par la voix. {18 hours|eighteen hours} = affiché|prononcé.",
     "card": {"type": "title", "kicker": "GTA 6 launch", "lines": [{"t": "NEW ZEALAND"}, {"t": "FIRST", "c": "sun"}]}},
    {"say": "...", "card": {"type": "stat", "kicker": "...", "value": "18H", "label": "head start"}},
    {"say": "...", "card": {"type": "list", "title": "Unlock times", "sub": "New York time", "rows": [{"l": "...", "r": "...", "hl": true}]}},
    {"say": "...", "card": null}
  ]
}
Couleurs "c" : text, sun, coral, pink, cyan.
Voix : Piper TTS + voix LibriTTS (CC BY 4.0), dossier $GTA6_VOICE_DIR (défaut ~/voices).
Sans voix disponible, la vidéo est rendue avec sous-titres seuls (rythme de lecture).
"""
import json, os, re, subprocess, sys, wave, zlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

W, H, FPS = 1080, 1920, 30
ASR = 44100
COL = {"text": (248, 244, 255), "sun": (255, 204, 92), "coral": (255, 128, 96),
       "pink": (240, 80, 140), "cyan": (70, 215, 230), "muted": (190, 178, 214), "ink": (14, 6, 30)}
X0, X1 = 90, 950
CX = (X0 + X1) // 2
HORIZON = 1390
CAP_Y = 1040
CARD_TOP, CARD_BOTTOM = 330, 930
VOICE_DIR = os.environ.get("GTA6_VOICE_DIR", os.path.expanduser("~/voices"))
VOICE_NAME = "en-us-libritts-high"
SPEAKER, LENGTH = 888, 0.9

FONT_DIRS = ["/usr/share/fonts/opentype/inter/", "/usr/share/fonts/truetype/dejavu/"]
_fc = {}
def font(weight, size):
    key = (weight, size)
    if key in _fc:
        return _fc[key]
    names = {"black": ["InterDisplay-Black.otf", "DejaVuSans-Bold.ttf"],
             "bold": ["InterDisplay-Bold.otf", "DejaVuSans-Bold.ttf"],
             "semi": ["Inter-SemiBold.otf", "DejaVuSans.ttf"],
             "reg": ["Inter-Medium.otf", "DejaVuSans.ttf"]}[weight]
    for n in names:
        for d in FONT_DIRS:
            if os.path.exists(d + n):
                _fc[key] = ImageFont.truetype(d + n, size)
                return _fc[key]
    _fc[key] = ImageFont.load_default()
    return _fc[key]

def ease(p):
    p = max(0.0, min(1.0, p))
    return 1 - (1 - p) ** 3

# ---------------------------------------------------------------- texte
def fit_font(t, weight, size, maxw, minsize=30):
    while size > minsize:
        f = font(weight, size)
        b = f.getbbox(t)
        if b[2] - b[0] <= maxw:
            return f
        size -= 4
    return font(weight, minsize)

def text_img(t, weight, size, color, maxw=X1 - X0, stroke=0):
    f = fit_font(t, weight, size, maxw - 2 * stroke)
    b = f.getbbox(t, stroke_width=stroke)
    asc, desc = f.getmetrics()
    im = Image.new("RGBA", (b[2] - b[0] + 4, asc + desc + 2 * stroke), (0, 0, 0, 0))
    ImageDraw.Draw(im).text((2 - b[0], stroke), t, font=f, fill=color,
                            stroke_width=stroke, stroke_fill=COL["ink"])
    return im

def stack(images, gap, align="center", width=X1 - X0):
    h = sum(i.height for i in images) + gap * (len(images) - 1)
    out = Image.new("RGBA", (width, max(h, 1)), (0, 0, 0, 0))
    y = 0
    for im in images:
        x = (width - im.width) // 2 if align == "center" else 0
        out.paste(im, (x, y), im)
        y += im.height + gap
    return out

# ---------------------------------------------------------------- cartes
def card_title(c):
    parts = []
    if c.get("kicker"):
        parts.append(text_img(c["kicker"].upper(), "bold", 44, COL["cyan"]))
    for ln in c.get("lines", []):
        parts.append(text_img(ln["t"], "black", ln.get("s", 124), COL[ln.get("c", "text")], stroke=6))
    return [(stack(parts, 6), 0.0)]

def card_stat(c):
    parts = []
    if c.get("kicker"):
        parts.append(text_img(c["kicker"].upper(), "bold", 44, COL["cyan"]))
    parts.append(text_img(c["value"], "black", c.get("s", 250), COL[c.get("c", "sun")], stroke=8))
    for ln in str(c.get("label", "")).split("\n"):
        if ln:
            parts.append(text_img(ln, "bold", 60, COL["text"], stroke=4))
    return [(stack(parts, 10), 0.0)]

def card_list(c, dur):
    head = []
    head.append(text_img(c.get("title", "").upper(), "black", 78, COL["text"], stroke=5))
    if c.get("sub"):
        head.append(text_img(c["sub"], "semi", 40, COL["cyan"]))
    layers = [(stack(head, 8), 0.0)]
    rows = c.get("rows", [])[:6]
    n = max(1, len(rows))
    step = min(0.9, max(0.35, (dur - 0.8) / n))
    for i, r in enumerate(rows):
        hl = r.get("hl")
        col = COL["sun"] if hl else COL["text"]
        lab = text_img(r["l"], "semi", 44, col, maxw=500)
        val = text_img(r["r"], "bold", 44, col, maxw=360)
        row = Image.new("RGBA", (X1 - X0, 92), (0, 0, 0, 0))
        d = ImageDraw.Draw(row)
        d.rounded_rectangle([0, 0, X1 - X0 - 1, 91], radius=18,
                            fill=(255, 204, 92, 70) if hl else (20, 8, 40, 190),
                            outline=(255, 204, 92, 200) if hl else (120, 80, 170, 120), width=2)
        row.paste(lab, (26, (92 - lab.height) // 2), lab)
        row.paste(val, (X1 - X0 - 26 - val.width, (92 - val.height) // 2), val)
        layers.append((row, 0.5 + i * step))
    return layers

def build_card(c, dur):
    """Renvoie [(image, apparition relative)] empilées verticalement dans la zone carte."""
    if not c:
        return []
    kind = c.get("type")
    if kind == "title":
        layers = card_title(c)
    elif kind == "stat":
        layers = card_stat(c)
    elif kind == "list":
        layers = card_list(c, dur)
    else:
        return []
    gap = 14
    total = sum(im.height for im, _ in layers) + gap * (len(layers) - 1)
    y = CARD_TOP + max(0, (CARD_BOTTOM - CARD_TOP - total) // 2)
    out = []
    for im, st in layers:
        out.append((im, X0 + (X1 - X0 - im.width) // 2, y, st))
        y += im.height + gap
    return out

# ---------------------------------------------------------------- voix et minutage
TOKEN = re.compile(r"\{([^|}]+)\|([^}]+)\}|(\S+)")

def tokens_of(text):
    """[(affiché, prononcé)] ; {affiché|prononcé} compte pour un seul mot à l'écran."""
    out = []
    for m in TOKEN.finditer(text):
        if m.group(3):
            out.append((m.group(3), m.group(3)))
        else:
            shown, spoken = m.group(1), m.group(2)
            # ponctuation collée juste après l'accolade
            out.append((shown, spoken))
    return out

def sentences_of(text):
    parts = re.split(r"(?<=[.!?])\s+", text.strip())
    return [p for p in parts if p]

_voice = None
def load_voice():
    global _voice
    if _voice is not None:
        return _voice or None
    try:
        from piper import PiperVoice
        m = os.path.join(VOICE_DIR, VOICE_NAME + ".onnx")
        _voice = PiperVoice.load(m, config_path=m + ".json")
    except Exception as e:
        print("voix indisponible :", e, file=sys.stderr)
        _voice = False
    return _voice or None

def speak(sentence_spoken):
    v = load_voice()
    if not v:
        return None
    from piper import SynthesisConfig
    ch = list(v.synthesize(sentence_spoken, syn_config=SynthesisConfig(
        speaker_id=SPEAKER, length_scale=LENGTH, noise_scale=0.6, noise_w_scale=0.7)))
    a = np.concatenate([c.audio_float_array for c in ch]).astype(np.float32)
    sr = ch[0].sample_rate
    from scipy.signal import resample_poly
    g = np.gcd(sr, ASR)
    return resample_poly(a, ASR // g, sr // g).astype(np.float32)

def speech_bounds(a):
    env = np.convolve(np.abs(a), np.ones(441) / 441, mode="same")
    idx = np.where(env > 0.02 * env.max())[0]
    if len(idx) == 0:
        return 0, len(a)
    return int(idx[0]), int(idx[-1])

def weight(spoken):
    core = re.sub(r"[^A-Za-z0-9]", "", spoken)
    w = sum(2.5 if ch.isdigit() else 1 for ch in core) + 1.5 * spoken.count(" ")
    if re.search(r"[,;:]$", spoken):
        w += 3
    return max(2.0, w)

def time_segments(segments):
    """Calcule voix, durées et mots minutés. Temps absolus en secondes."""
    t = 0.0
    voice_parts = []
    out = []
    for si, seg in enumerate(segments):
        start = t
        words = []
        for sent in sentences_of(seg.get("say", "")):
            toks = tokens_of(sent)
            spoken = " ".join(sp for _, sp in toks)
            audio = speak(spoken)
            if audio is None:
                dur = max(0.8, sum(weight(sp) for _, sp in toks) / 13.0)
                s0, s1 = 0.0, dur
            else:
                b0, b1 = speech_bounds(audio)
                dur = len(audio) / ASR
                s0, s1 = b0 / ASR, b1 / ASR
                voice_parts.append((t, audio))
            ws = [weight(sp) for _, sp in toks]
            tot = sum(ws)
            acc = 0.0
            for (shown, _), w in zip(toks, ws):
                a = t + s0 + (s1 - s0) * acc / tot
                acc += w
                words.append([shown, a, t + s0 + (s1 - s0) * acc / tot])
            t += dur + 0.08
        t += 0.22
        if seg.get("min"):
            t = max(t, start + float(seg["min"]))
        out.append({"start": start, "end": t, "words": words, "card": seg.get("card")})
    return out, t, voice_parts

def caption_groups(words, seg_end):
    groups, cur = [], []
    for w in words:
        cur.append(w)
        text = " ".join(x[0] for x in cur)
        if len(cur) >= 3 or len(text) >= 14 or re.search(r"[.,!?;:]$", w[0]):
            groups.append(cur); cur = []
    if cur:
        groups.append(cur)
    out = []
    for i, g in enumerate(groups):
        end = groups[i + 1][0][1] if i + 1 < len(groups) else seg_end
        out.append({"words": g, "start": g[0][1], "end": end})
    return out

def render_caption(group, active):
    f = None
    words = [re.sub(r"[.,;:]+$", "", w[0]).upper() for w in group["words"]]
    size = 96
    while True:
        f = font("black", size)
        widths = [f.getbbox(w, stroke_width=9)[2] - f.getbbox(w, stroke_width=9)[0] for w in words]
        space = f.getbbox(" ")[2] or 24
        total = sum(widths) + space * (len(words) - 1)
        if total <= X1 - X0 or size <= 54:
            break
        size -= 6
    asc, desc = f.getmetrics()
    im = Image.new("RGBA", (int(total) + 8, asc + desc + 18), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    x = 4
    for i, (w, wd) in enumerate(zip(words, widths)):
        b = f.getbbox(w, stroke_width=9)
        d.text((x - b[0], 9), w, font=f, fill=COL["sun"] if i == active else COL["text"],
               stroke_width=9, stroke_fill=COL["ink"])
        x += wd + space
    return im

# ---------------------------------------------------------------- fond animé
def make_background(seed):
    rng = np.random.default_rng(seed)
    y = np.arange(H, dtype=np.float32)[:, None]
    stops = [(0.0, (7, 3, 22)), (0.55, (30, 9, 62)), (0.86, (96, 26, 104)), (1.0, (222, 86, 122))]
    sky = np.zeros((H, W, 3), np.float32)
    ty = np.clip(y / HORIZON, 0, 1)
    for c in range(3):
        xs = [s[0] for s in stops]; vs = [s[1][c] for s in stops]
        sky[:, :, c] = np.interp(ty, xs, vs)
    g = np.clip((y - HORIZON) / (H - HORIZON), 0, 1)
    ground = np.concatenate([(16 - 10 * g), (5 - 3 * g), (34 - 22 * g)], axis=1)
    ground = np.repeat(ground[:, None, :], W, axis=1)
    img = np.where(y < HORIZON, sky.transpose(2, 0, 1), ground.transpose(2, 0, 1)).transpose(1, 2, 0)
    base = Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")
    # soleil rayé (motif de la chaîne)
    R = 250
    sun = Image.new("RGBA", (2 * R, 2 * R), (0, 0, 0, 0))
    grad = np.zeros((2 * R, 2 * R, 4), np.uint8)
    yy = np.linspace(0, 1, 2 * R)[:, None]
    grad[:, :, 0] = 255
    grad[:, :, 1] = (205 - 120 * yy).astype(np.uint8)
    grad[:, :, 2] = (90 + 30 * yy).astype(np.uint8)
    yy2, xx2 = np.mgrid[0:2 * R, 0:2 * R]
    mask = ((yy2 - R) ** 2 + (xx2 - R) ** 2) <= R * R
    for k, (y0, hgt) in enumerate([(R + 30, 10), (R + 72, 15), (R + 118, 21), (R + 170, 28)]):
        mask[y0:y0 + hgt, :] = False
    grad[:, :, 3] = mask.astype(np.uint8) * 255
    sun = Image.fromarray(grad, "RGBA")
    glow = Image.new("RGBA", (2 * R + 400, 2 * R + 400), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse([200 - 40, 200 - 40, 200 + 2 * R + 40, 200 + 2 * R + 40], fill=(255, 90, 140, 120))
    glow = glow.filter(ImageFilter.GaussianBlur(70))
    base.paste(glow, (CX - R - 200, HORIZON - R - 120 - 200), glow)
    sun_c = sun.crop((0, 0, 2 * R, R + 120))
    base.paste(sun_c, (CX - R, HORIZON - R - 120), sun_c)
    # silhouettes de palmiers (dessin original)
    pal = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pal)
    def palm(x, y, s, flip):
        sx = -1 if flip else 1
        pd.polygon([(x, y), (x + sx * 14 * s, y), (x + sx * 40 * s, y - 330 * s), (x + sx * 28 * s, y - 332 * s)], fill=(10, 4, 20, 255))
        top = (x + sx * 34 * s, y - 330 * s)
        for ang, ln in [(-160, 170), (-130, 150), (-95, 120), (-60, 150), (-25, 175), (-200, 140)]:
            a = np.radians(ang if not flip else 180 - ang)
            ex, ey = top[0] + np.cos(a) * ln * s, top[1] + np.sin(a) * ln * s * 0.6 + 40 * s
            mx, my = (top[0] + ex) / 2, (top[1] + ey) / 2 - 30 * s
            pd.polygon([top, (mx, my - 10 * s), (ex, ey), (mx, my + 14 * s)], fill=(10, 4, 20, 255))
    palm(40, HORIZON + 40, 1.25, False)
    palm(W - 30, HORIZON + 30, 1.05, True)
    stars = [(int(rng.integers(0, W)), int(rng.integers(40, HORIZON - 420)), float(rng.uniform(0, 6.28)),
              float(rng.uniform(0.5, 1.6))) for _ in range(110)]
    return base, pal, stars

def draw_dynamic(fr, t, stars):
    d = ImageDraw.Draw(fr, "RGBA")
    for x, y, ph, sp in stars:
        a = int(110 + 110 * np.sin(t * sp * 2 + ph))
        d.rectangle([x, y, x + 2, y + 2], fill=(255, 235, 255, max(0, a)))
    # grille en perspective
    depth = H - HORIZON
    phase = (t * 0.9) % 1.0
    for i in range(1, 26):
        z = i - phase
        if z <= 0.15:
            continue
        yy = HORIZON + depth / z * 0.95
        if yy > H:
            continue
        al = int(min(255, 60 + 900 / (z + 2)))
        d.line([(0, yy), (W, yy)], fill=(255, 70, 170, min(230, al)), width=3 if z < 3 else 2)
    for k in range(-14, 15):
        xb = CX + k * 160
        d.line([(CX + k * 6, HORIZON), (xb + k * 80, H)], fill=(255, 70, 170, 150), width=2)
    d.line([(0, HORIZON), (W, HORIZON)], fill=(255, 150, 200, 255), width=3)

# ---------------------------------------------------------------- audio
def make_music(seconds, seed):
    from scipy.signal import butter, lfilter
    rng = np.random.default_rng(seed)
    sr = ASR
    bpm = [100, 106, 112, 118][seed % 4]
    beat = 60.0 / bpm
    root = [57, 60, 52, 54][(seed // 4) % 4]
    prog = [[0, 8, 3, 10], [0, 5, 8, 7], [0, 10, 8, 10]][(seed // 16) % 3]
    n = int(seconds * sr) + sr
    L = np.zeros(n); R = np.zeros(n); KL = np.zeros(n)
    hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)
    def lp(x, f):
        b, a = butter(2, f / (sr / 2)); return lfilter(b, a, x)
    def hp(x, f):
        b, a = butter(2, f / (sr / 2), "high"); return lfilter(b, a, x)
    def add(buf, start, sig, gain=1.0):
        i = int(start * sr)
        if i >= n: return
        sig = sig[: n - i]; buf[i:i + len(sig)] += sig * gain
    def saw(f, d, det=0.0):
        t = np.arange(int(d * sr)) / sr
        return 2 * ((t * f * (1 + det)) % 1) - 1
    def env(d, a=0.005, r=0.1):
        m = int(d * sr); e = np.ones(m)
        ai = max(1, int(a * sr)); e[:ai] = np.linspace(0, 1, ai)
        ri = min(m, max(1, int(r * sr))); e[-ri:] *= np.linspace(1, 0, ri)
        return e
    tk = np.arange(int(0.35 * sr)) / sr
    kick = np.sin(2 * np.pi * (45 * tk + (75 / 18) * (1 - np.exp(-18 * tk)))) * np.exp(-9 * tk)
    ts = np.arange(int(0.22 * sr)) / sr
    snare = hp(rng.standard_normal(len(ts)), 1200) * np.exp(-16 * ts) * 0.5 + np.sin(2 * np.pi * 190 * ts) * np.exp(-25 * ts) * 0.4
    th = np.arange(int(0.05 * sr)) / sr
    hat = hp(rng.standard_normal(len(th)), 7000) * np.exp(-60 * th)
    duck = np.ones(n)
    for b in range(int(seconds / (4 * beat)) + 2):
        t0 = b * 4 * beat
        cr = root + prog[b % 4]
        for k in range(4):
            add(KL, t0 + k * beat, kick, 0.9)
            i = int((t0 + k * beat) * sr)
            if i < n:
                m = min(n - i, int(0.25 * sr)); duck[i:i + m] = np.minimum(duck[i:i + m], 0.35 + 0.65 * np.linspace(0, 1, m))
            if k in (1, 3):
                add(L, t0 + k * beat, snare, 0.5); add(R, t0 + k * beat, snare, 0.5)
        for e8 in range(8):
            g = 0.09 if e8 % 2 else 0.05
            add(L, t0 + e8 * beat / 2, hat, g * 0.8); add(R, t0 + e8 * beat / 2, hat, g)
            bd = beat / 2 * 0.9
            bass = lp(saw(hz(cr - 24), bd), 420) * env(bd, 0.003, 0.05)
            add(L, t0 + e8 * beat / 2, bass, 0.42); add(R, t0 + e8 * beat / 2, bass, 0.42)
        pd = 4 * beat + 0.45
        pad = sum(saw(hz(cr + iv), pd, det) for iv in (0, 3, 7) for det in (-0.004, 0.004))
        pad = lp(pad, 1500) * env(pd, 0.35, 0.4) / 6
        add(L, t0, pad, 0.28); add(R, t0, np.roll(pad, 300), 0.28)
        for s16 in range(16):
            ad = beat / 4 * 0.8
            f = hz(cr + 12 + [0, 3, 7, 12][s16 % 4])
            t = np.arange(int(ad * sr)) / sr
            note = lp(np.sign(np.sin(2 * np.pi * f * t)) * env(ad, 0.002, 0.06), 2500)
            add(L, t0 + s16 * beat / 4, note, 0.05); add(R, t0 + s16 * beat / 4 + 0.375 * beat, note, 0.03)
    mix = np.stack([KL + L * duck, KL + R * duck])[:, :int(seconds * sr)]
    mix = np.tanh(mix * 1.2)
    return mix / (np.sqrt(np.mean(mix ** 2)) + 1e-9)

def sfx_whoosh(seed):
    from scipy.signal import butter, lfilter
    rng = np.random.default_rng(seed)
    d = int(0.42 * ASR)
    noise = rng.standard_normal(d)
    t = np.linspace(0, 1, d)
    out = np.zeros(d)
    for k in range(8):
        f = 400 + 3500 * (k / 7)
        b, a = butter(2, [f * 0.8 / (ASR / 2), min(0.99, f * 1.25 / (ASR / 2))], "band")
        band = lfilter(b, a, noise)
        center = 0.15 + 0.6 * (k / 7)
        out += band * np.exp(-((t - center) ** 2) / 0.02)
    out *= np.sin(np.pi * t) ** 2
    return out / (np.abs(out).max() + 1e-9)

def sfx_pop():
    t = np.arange(int(0.12 * ASR)) / ASR
    return np.sin(2 * np.pi * (880 - 2600 * t) * t) * np.exp(-30 * t)

def build_audio(total, segs, voice_parts, seed, path):
    n = int(total * ASR)
    voice = np.zeros(n, np.float32)
    for t0, a in voice_parts:
        i = int(t0 * ASR); a = a[: n - i]; voice[i:i + len(a)] += a
    if np.abs(voice).max() > 0:
        voice = voice / np.abs(voice).max() * 0.89
    env = np.convolve(np.abs(voice), np.ones(4410) / 4410, mode="same")
    duck = 1.0 - 0.6 * np.clip(env / (env.max() + 1e-9) * 3, 0, 1)
    music = make_music(total, seed) * (0.06 if np.abs(voice).max() > 0 else 0.16)
    music = music[:, :n] * duck[None, :music.shape[1]]
    fx = np.zeros(n)
    wh = sfx_whoosh(seed)
    for k, s in enumerate(segs[1:], 1):
        i = max(0, int((s["start"] - 0.2) * ASR)); seg = wh[: n - i]; fx[i:i + len(seg)] += seg * 0.10
        c = s.get("card") or {}
        if c.get("type") == "stat":
            p = sfx_pop(); j = int((s["start"] + 0.05) * ASR); p = p[: n - j]; fx[j:j + len(p)] += p * 0.12
    mix = np.zeros((2, n))
    mix[:, :music.shape[1]] += music
    mix += voice[None, :] + fx[None, :]
    fo = int(0.4 * ASR)
    mix[:, -fo:] *= np.linspace(1, 0, fo)
    mix = np.clip(mix, -0.98, 0.98)
    with wave.open(path, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(ASR)
        w.writeframes((mix.T * 32767).astype(np.int16).tobytes())

# ---------------------------------------------------------------- rendu
def paste_alpha(fr, im, x, y, alpha=1.0, scale=1.0):
    if scale != 1.0:
        w2, h2 = max(1, int(im.width * scale)), max(1, int(im.height * scale))
        x += (im.width - w2) // 2; y += (im.height - h2) // 2
        im = im.resize((w2, h2), Image.BILINEAR)
    if alpha < 1.0:
        im = im.copy(); im.putalpha(im.getchannel("A").point(lambda v: int(v * alpha)))
    fr.paste(im, (int(x), int(y)), im)

def main():
    spec_path = sys.argv[1]
    spec = json.load(open(spec_path))
    base_dir = os.path.dirname(os.path.abspath(spec_path))
    out = os.path.join(base_dir, spec.get("out", "short.mp4"))
    seed = spec.get("seed", zlib.crc32(os.path.basename(out).encode()))
    segs, total, voice_parts = time_segments(spec["segments"])
    for s in segs:
        s["layers"] = build_card(s["card"], s["end"] - s["start"])
        s["groups"] = caption_groups(s["words"], s["end"])
        for g in s["groups"]:
            g["imgs"] = [render_caption(g, i) for i in range(len(g["words"]))]
    base, palms, stars = make_background(seed)
    src_img = text_img(spec.get("source", ""), "reg", 26, COL["muted"]) if spec.get("source") else None
    logo = Image.new("RGBA", (40, 40), (0, 0, 0, 0))
    ld = ImageDraw.Draw(logo); ld.ellipse([2, 2, 38, 38], fill=COL["sun"])
    ld.rectangle([0, 23, 40, 26], fill=(0, 0, 0, 0)); ld.rectangle([0, 30, 40, 33], fill=(0, 0, 0, 0))

    def frame_at(t):
        fr = base.copy()
        draw_dynamic(fr, t, stars)
        fr.paste(palms, (0, 0), palms)
        seg = next((s for s in segs if s["start"] <= t < s["end"]), segs[-1])
        lt = t - seg["start"]
        first = seg is segs[0]
        for im, x, y, st in seg["layers"]:
            if lt < st:
                continue
            p = 1.0 if (first and st == 0) else ease((lt - st) / 0.18)
            sc = 1.0 + 0.10 * (1 - ease((lt - st) / 0.22)) if not first else 1.0 + 0.06 * (1 - ease(lt / 0.3))
            paste_alpha(fr, im, x, y, alpha=p, scale=sc)
        for g in seg["groups"]:
            if g["start"] - 0.02 <= t < g["end"]:
                act = 0
                for i, w in enumerate(g["words"]):
                    if t >= w[1] - 0.02:
                        act = i
                im = g["imgs"][act]
                pop = 1.0 + 0.08 * (1 - ease((t - g["start"]) / 0.12))
                paste_alpha(fr, im, CX - im.width // 2, CAP_Y - im.height // 2, scale=pop)
                break
        d = ImageDraw.Draw(fr)
        fr.paste(logo, (X0, 232), logo)
        d.rectangle([X0 + 56, 250, X1, 256], fill=(60, 40, 96))
        d.rectangle([X0 + 56, 250, X0 + 56 + int((X1 - X0 - 56) * min(1, t / total)), 256], fill=COL["cyan"])
        if src_img:
            fr.paste(src_img, (X0 + 56, 272), src_img)
        return fr

    if "--frames" in sys.argv:
        for ti in [float(x) for x in sys.argv[sys.argv.index("--frames") + 1].split(",")]:
            frame_at(ti).save(os.path.join(base_dir, f"frame_{ti:05.1f}.png"))
        print(f"durée {total:.1f}s")
        return
    tmpv = out[:-4] + ".part.mp4"
    ff = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24",
                           "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-c:v", "libx264", "-preset", "veryfast",
                           "-crf", "20", "-pix_fmt", "yuv420p", tmpv], stdin=subprocess.PIPE)
    for i in range(int(round(total * FPS))):
        ff.stdin.write(frame_at(i / FPS).tobytes())
    ff.stdin.close()
    if ff.wait() != 0:
        sys.exit("ffmpeg a échoué")
    wav = out[:-4] + ".audio.wav"
    build_audio(total, segs, voice_parts, seed, wav)
    tmp = out[:-4] + ".mux.mp4"
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", tmpv, "-i", wav, "-map", "0:v", "-map", "1:a",
                    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", tmp], check=True)
    os.rename(tmp, out)
    os.remove(tmpv); os.remove(wav)
    print(out, f"{total:.1f}s", "voix" if voice_parts else "sans voix")

if __name__ == "__main__":
    main()
