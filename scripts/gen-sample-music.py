#!/usr/bin/env python3
"""
Generate small sample music files (WAV) for the built-in virtual disk.

Usage:
    python scripts/gen-sample-music.py [outdir]

Default outdir: apps/web/public/media/music

Why this exists:
  The virtual disk is provisioned at startup from files under
  apps/web/public (see BUILTIN_MUSIC_FILES in packages/ui/src/builtin-win.ts).
  This script synthesizes royalty-free placeholder melodies so the disk has
  real playable audio without shipping any copyrighted content. Replace the
  generated files (or add new ones) with your own music — same directory,
  same format, then add one line to BUILTIN_MUSIC_FILES.

Output: 16-bit PCM mono WAV, 44.1 kHz, a few seconds each (~200-350 KB).
"""

import math
import struct
import sys
import wave
from pathlib import Path

SAMPLE_RATE = 44100
AMPLITUDE = 0.35
NOTE_MS = 380  # per-note duration
FADE_SAMPLES = 250  # envelope ramp to avoid clicks


def synth(frequencies: list[float], out: Path) -> None:
    """Write a short melody as a WAV file."""
    frames: list[float] = []
    for freq in frequencies:
        n = int(SAMPLE_RATE * NOTE_MS / 1000)
        for i in range(n):
            attack = min(1.0, i / FADE_SAMPLES)
            release = min(1.0, (n - i) / FADE_SAMPLES)
            env = attack * release
            frames.append(AMPLITUDE * env * math.sin(2 * math.pi * freq * i / SAMPLE_RATE))
    pcm = b"".join(struct.pack("<h", int(max(-1.0, min(1.0, s)) * 32767)) for s in frames)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)


def main() -> int:
    outdir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("apps/web/public/media/music")
    outdir.mkdir(parents=True, exist_ok=True)

    # A-minor pentatonic lullaby-ish melody (middle octave + high octave).
    melody = [
        440.0, 523.25, 659.25, 783.99, 659.25, 523.25,
        440.0, 523.25, 587.33, 659.25, 587.33, 523.25,
        349.23, 440.0, 523.25, 659.25, 523.25, 440.0,
        392.0, 440.0, 523.25, 587.33, 523.25, 392.0,
    ]
    synth(melody, outdir / "sample-melody.wav")

    # C-major arpeggio loop (bright, rhythmic).
    arpeggio = [
        261.63, 329.63, 392.0, 523.25, 392.0, 329.63,
        293.66, 369.99, 440.0, 587.33, 440.0, 369.99,
        329.63, 415.30, 493.88, 659.25, 493.88, 415.30,
        349.23, 440.0, 523.25, 698.46, 523.25, 440.0,
    ]
    synth(arpeggio, outdir / "sample-arpeggio.wav")

    print(f"wrote sample music to {outdir.resolve()}")
    for f in sorted(outdir.glob("*.wav")):
        print(f"  {f.name}  {f.stat().st_size} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
