# GTA 6 Shorts media

Video files hosted for scheduled YouTube Shorts (via Metricool), plus the rendering engine in tools/. Separate branch, unrelated to chess-coach.

- tools/shortgen3.py: current engine (voice-over, word captions, cards, original music) over official GTA VI footage.
- tools/broll_index.json: catalogue of shots from Rockstar's official GTA VI media page (https://www.rockstargames.com/VI/downloads), with timestamps and keywords. Only metadata is stored here; footage is read from Rockstar's CDN at render time, game audio muted.
- No fallback: the engine stops with an error if official footage is unavailable (no Short without game footage).

Footage: Rockstar Games (official GTA VI media). Fan channel, not affiliated with Rockstar Games.
Voice-over: Piper TTS with the LibriTTS voice (dataset CC BY 4.0, http://www.openslr.org/60/).
