#!/usr/bin/env python3
"""Generate an original, royalty-free background score with numpy.

This is a small procedural composer, not a sampled track: every sound is
synthesised from oscillators and noise, so there is no third-party licence to
clear. Moods: uplifting, cinematic, energetic, calm.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import wave
from pathlib import Path

import numpy as np

SR = 44_100

# Root + triad frequencies (A4 = 440 Hz).
CHORDS: dict[str, tuple[float, list[float]]] = {
    "Am": (110.00, [220.00, 261.63, 329.63]),
    "F": (87.31, [174.61, 220.00, 261.63]),
    "C": (130.81, [261.63, 329.63, 392.00]),
    "G": (98.00, [196.00, 246.94, 293.66]),
    "Dm": (73.42, [146.83, 220.00, 293.66]),
    "Em": (82.41, [164.81, 246.94, 329.63]),
}

MOODS: dict[str, dict] = {
    "cinematic": {
        "bpm": 72,
        "beats_per_chord": 4,
        "progression": ["Am", "F", "C", "G"],
        "pad": 0.34,
        "bass": 0.28,
        "drums": "none",
        "arp": False,
        "bells": True,
        "riser": False,
    },
    "energetic": {
        "bpm": 124,
        "beats_per_chord": 2,
        "progression": ["Am", "F", "C", "G"],
        "pad": 0.16,
        "bass": 0.34,
        "drums": "full",
        "arp": True,
        "bells": False,
        "riser": True,
    },
    "uplifting": {
        "bpm": 104,
        "beats_per_chord": 4,
        "progression": ["C", "G", "Am", "F"],
        "pad": 0.24,
        "bass": 0.26,
        "drums": "light",
        "arp": True,
        "bells": True,
        "riser": False,
    },
    "calm": {
        "bpm": 60,
        "beats_per_chord": 4,
        "progression": ["C", "Am", "F", "G"],
        "pad": 0.30,
        "bass": 0.16,
        "drums": "none",
        "arp": True,
        "bells": True,
        "riser": False,
    },
}


def pad(freqs: list[float], duration: float, amp: float, attack: float = 0.8, release: float = 1.2) -> np.ndarray:
    n = max(1, int(duration * SR))
    t = np.arange(n) / SR
    signal = np.zeros(n)
    for freq in freqs:
        signal += np.sin(2 * math.pi * freq * 0.9985 * t)
        signal += np.sin(2 * math.pi * freq * 1.0015 * t + 0.7)
        signal += 0.24 * np.sin(2 * math.pi * freq * 2.0 * t + 1.1)
    signal /= len(freqs) * 2.2
    env = np.ones(n)
    a = min(n, int(attack * SR))
    if a > 0:
        env[:a] = np.linspace(0.0, 1.0, a) ** 1.4
    r = min(n, int(release * SR))
    if r > 0:
        env[-r:] *= np.linspace(1.0, 0.0, r) ** 1.2
    signal *= 0.95 + 0.05 * np.sin(2 * math.pi * 0.13 * t)
    return (amp * signal * env).astype(np.float64)


def pluck(freq: float, duration: float, amp: float, decay: float = 0.45) -> np.ndarray:
    n = max(1, int(duration * SR))
    t = np.arange(n) / SR
    signal = (
        np.sin(2 * math.pi * freq * t)
        + 0.42 * np.sin(2 * math.pi * freq * 2 * t + 0.3)
        + 0.18 * np.sin(2 * math.pi * freq * 3 * t + 0.7)
        + 0.07 * np.sin(2 * math.pi * freq * 4 * t + 1.2)
    )
    env = np.exp(-t / max(0.05, decay))
    a = min(n, int(0.006 * SR))
    if a > 0:
        env[:a] *= np.linspace(0.0, 1.0, a)
    r = min(n, int(0.04 * SR))
    if r > 0:
        env[-r:] *= np.linspace(1.0, 0.0, r)
    return (amp * signal * env).astype(np.float64)


def bass(freq: float, duration: float, amp: float) -> np.ndarray:
    n = max(1, int(duration * SR))
    t = np.arange(n) / SR
    signal = np.sin(2 * math.pi * freq * t) + 0.32 * np.sin(2 * math.pi * freq * 2 * t)
    env = np.exp(-t / max(0.08, duration * 0.85))
    a = min(n, int(0.008 * SR))
    if a > 0:
        env[:a] *= np.linspace(0.0, 1.0, a)
    return (amp * signal * env).astype(np.float64)


def kick(rng: np.random.Generator, amp: float = 0.9) -> np.ndarray:
    duration = 0.30
    n = int(duration * SR)
    t = np.arange(n) / SR
    freq = 44 + 118 * np.exp(-t * 17)
    phase = 2 * math.pi * np.cumsum(freq) / SR
    body = np.sin(phase) * np.exp(-t * 8.5)
    click = rng.standard_normal(n) * np.exp(-t * 240) * 0.12
    return (amp * (body + click)).astype(np.float64)


def hat(rng: np.random.Generator, amp: float = 0.16) -> np.ndarray:
    duration = 0.08
    n = int(duration * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    hp = np.diff(noise, prepend=0.0)
    return (amp * hp * np.exp(-t * 55)).astype(np.float64)


def snare(rng: np.random.Generator, amp: float = 0.28) -> np.ndarray:
    duration = 0.22
    n = int(duration * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n) * np.exp(-t * 24)
    tone = 0.35 * np.sin(2 * math.pi * 185 * t) * np.exp(-t * 32)
    return (amp * (noise + tone)).astype(np.float64)


def riser(rng: np.random.Generator, duration: float, amp: float = 0.16) -> np.ndarray:
    n = max(1, int(duration * SR))
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    hp = np.diff(noise, prepend=0.0)
    env = (t / max(0.001, duration)) ** 2.2
    return (amp * hp * env).astype(np.float64)


class Mixer:
    def __init__(self, duration: float) -> None:
        self.samples = int((duration + 0.25) * SR)
        self.buffer = np.zeros((self.samples, 2), dtype=np.float64)

    def add(self, signal: np.ndarray, start: float, gain: float = 1.0, pan: float = 0.0) -> None:
        start_index = int(max(0.0, start) * SR)
        if start_index >= self.samples or signal.size == 0:
            return
        count = min(signal.size, self.samples - start_index)
        pan = max(-1.0, min(1.0, pan))
        left = gain * math.sqrt(0.5 * (1.0 - pan))
        right = gain * math.sqrt(0.5 * (1.0 + pan))
        self.buffer[start_index : start_index + count, 0] += signal[:count] * left
        self.buffer[start_index : start_index + count, 1] += signal[:count] * right

    def finish(self, duration: float, fade_in: float = 0.35, fade_out: float = 1.1) -> np.ndarray:
        self.buffer = self.buffer[: int(duration * SR)]
        peak = float(np.max(np.abs(self.buffer))) if self.buffer.size else 0.0
        if peak > 0:
            self.buffer *= 0.89 / peak
        n = self.buffer.shape[0]
        fi = min(n, int(fade_in * SR))
        if fi > 0:
            self.buffer[:fi] *= np.linspace(0.0, 1.0, fi)[:, None]
        fo = min(n, int(fade_out * SR))
        if fo > 0:
            self.buffer[-fo:] *= np.linspace(1.0, 0.0, fo)[:, None]
        return self.buffer


def compose(duration: float, mood: str, seed: int) -> np.ndarray:
    config = MOODS[mood]
    rng = np.random.default_rng(seed)
    mixer = Mixer(duration)
    beat = 60.0 / config["bpm"]
    chord_length = beat * config["beats_per_chord"]
    progression = config["progression"]
    total_chords = int(math.ceil((duration + 0.5) / chord_length)) + 1

    for chord_index in range(total_chords):
        start = chord_index * chord_length
        if start > duration:
            break
        name = progression[chord_index % len(progression)]
        root, notes = CHORDS[name]

        mixer.add(pad(notes, chord_length * 1.08, config["pad"]), start, pan=-0.08)

        if config["drums"] == "none":
            mixer.add(bass(root / 2, chord_length * 0.95, config["bass"]), start, pan=-0.05)
        else:
            step = beat if config["drums"] == "light" else beat / 2
            step_index = 0
            while step_index * step < chord_length:
                note_freq = root / 2 * (2.0 if step_index % 4 == 3 else 1.0)
                mixer.add(bass(note_freq, step * 0.9, config["bass"]), start + step_index * step, pan=-0.05)
                step_index += 1

        if config["arp"]:
            pattern = [0, 1, 2, 1, 0, 2, 1, 2]
            step = beat / 2
            for step_index, note_index in enumerate(pattern):
                position = start + step_index * step
                if position >= duration:
                    break
                freq = notes[note_index] * (2.0 if step_index % 6 == 4 else 1.0)
                mixer.add(pluck(freq, step * 1.4, 0.16, decay=0.35), position, pan=0.22 if step_index % 2 else -0.2)

        if config["bells"]:
            bell_times = [beat * 1.5, beat * 3.0] if config["beats_per_chord"] >= 4 else [beat * 0.5]
            for bell_index, offset in enumerate(bell_times):
                position = start + offset
                if position >= duration:
                    continue
                freq = notes[(chord_index + bell_index) % len(notes)] * 2
                mixer.add(pluck(freq, min(2.2, duration - position), 0.13, decay=1.0), position, pan=0.3 if bell_index else -0.3)

        if config["drums"] in {"full", "light"}:
            for beat_index in range(config["beats_per_chord"]):
                position = start + beat_index * beat
                if config["drums"] == "full":
                    mixer.add(kick(rng), position, gain=0.25)
                    mixer.add(hat(rng), position + beat / 2, gain=0.55)
                    if beat_index % 2 == 1:
                        mixer.add(snare(rng), position, gain=0.5)
                else:
                    if beat_index in {0, 2}:
                        mixer.add(kick(rng), position, gain=0.16)
                    if beat_index in {1, 3}:
                        mixer.add(snare(rng), position, gain=0.3)
                    mixer.add(hat(rng), position + beat / 2, gain=0.32)

        if config["riser"] and chord_index % 4 == 3:
            mixer.add(riser(rng, min(chord_length, duration - start)), start, gain=0.5, pan=0.25)

    return mixer.finish(duration)


def write_wav(path: Path, samples: np.ndarray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(samples, -1.0, 1.0)
    pcm = (pcm * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as handle:
        handle.setnchannels(2)
        handle.setsampwidth(2)
        handle.setframerate(SR)
        handle.writeframes(pcm.tobytes())


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mood", default="uplifting", choices=sorted(MOODS.keys()))
    parser.add_argument("--duration", type=float, required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()

    if args.duration <= 0 or args.duration > 900:
        print("MUSIC_ERROR: duration must be between 0 and 900 seconds.", file=sys.stderr)
        return 2

    try:
        samples = compose(args.duration, args.mood, args.seed)
        out = Path(args.out)
        write_wav(out, samples)
    except Exception as error:  # noqa: BLE001
        print(f"MUSIC_ERROR: {type(error).__name__}: {error}", file=sys.stderr)
        return 2

    print(
        json.dumps(
            {
                "ok": True,
                "mood": args.mood,
                "duration": args.duration,
                "path": str(out),
                "license": "algorithmically generated original score (no third-party samples)",
            }
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
