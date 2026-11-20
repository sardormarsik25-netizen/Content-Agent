"""Prepare sound effects, a music bed and time-aligned Uzbek speech."""
import array
import math
from pathlib import Path
import subprocess
import sys
import wave

RATE = 24000
FLAGS = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def audio_command(args, timeout=90):
    return subprocess.run(args, check=True, capture_output=True, timeout=timeout, creationflags=FLAGS)


def write_wave(path, samples):
    with wave.open(str(path), "wb") as track:
        track.setparams((1, 2, RATE, 0, "NONE", "not compressed"))
        track.writeframes(samples.tobytes())


def read_pcm(ffmpeg, path, start=None, length=None, tempo=None):
    limits = [] if start is None else ["-ss", str(start), "-t", str(length)]
    filters = [] if tempo is None else ["-af", f"atempo={tempo:.4f}"]
    result = audio_command([ffmpeg, "-v", "error", "-i", str(path), *limits, *filters,
                            "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "pipe:1"])
    return array.array("h", result.stdout)


def rms(samples):
    return math.sqrt(sum(value * value for value in samples) / max(1, len(samples)))


def approved_audio(source, workspace):
    path = Path(source)
    if not path.is_absolute():
        raise ValueError("Audio assets need an absolute local file path")
    path = path.resolve()
    roots = (workspace / "assets", workspace.parent / "audio_cache")
    if (not any(path.is_relative_to(root.resolve()) for root in roots) or not path.is_file()
            or path.suffix.lower() not in (".wav", ".mp3", ".ogg", ".m4a", ".flac")
            or path.stat().st_size > 32_000_000):
        raise ValueError("Audio asset missing or invalid; attach approved audio or save it in asset_library")
    return path


class NarrationUnavailable(ValueError):
    pass


def synthesize(source, tts_script, voice, ffmpeg, providers, size):
    edge_output = source.with_suffix(".mp3")
    attempts = [("edge", [sys.executable, str(tts_script), "--text-file", str(source),
                          "--out", str(edge_output), "--voice", voice], edge_output)]
    for index, provider in enumerate(providers):
        voice_id = provider["voices"].get(voice)
        if not voice_id:
            continue
        target = source.with_suffix(f".fallback-{index}.wav")
        substitutions = {"{text_file}": str(source), "{output_file}": str(target), "{voice}": voice_id}
        args = [substitutions.get(arg, arg) for arg in provider["argv"]]
        attempts.append((f"configured-{index+1}", args, target))
    failures = []
    for provider, args, target in attempts:
        try:
            audio_command(args, timeout=30)
            pcm = read_pcm(ffmpeg, target, 0, min(60, size * 1.29 / RATE + 0.5))
            if pcm and rms(pcm) >= 160:
                return pcm, target, provider
        except (OSError, subprocess.SubprocessError):
            pass
        failures.append(provider)
    raise NarrationUnavailable("Uzbek speech unavailable or inaudible via " + ", ".join(failures))


def fallback_providers(config):
    if not isinstance(config, list) or len(config) > 2:
        raise ValueError("tts_fallbacks must contain up to two operator-configured providers")
    for provider in config:
        if not isinstance(provider, dict) or set(provider) != {"argv", "voices"}:
            raise ValueError("Each TTS fallback needs argv and voices")
        argv, voices = provider["argv"], provider["voices"]
        if (not isinstance(argv, list) or not argv or any(not isinstance(x, str) for x in argv)
                or not Path(argv[0]).is_absolute() or Path(argv[0]).suffix.lower() != ".exe"
                or not {"{text_file}", "{output_file}"}.issubset(argv)
                or not isinstance(voices, dict) or any(not isinstance(v, str) or not v for v in voices.values())):
            raise ValueError("Configure a trusted absolute executable, text/output arguments and voice mappings")
    return config


def mix(plan, frames, temp, ffmpeg, tts_script, workspace, providers=()):
    count = sum(frames) * RATE // 30
    speech = array.array("h", [0]) * count
    bed = array.array("h", [0]) * count
    windows = []
    narration_skipped = []
    start = 0
    for index, (scene, frame_count) in enumerate(zip(plan["scenes"], frames), 1):
        size = frame_count * RATE // 30
        narration = scene.get("narration", "").strip()
        recorded = scene.get("voiceover_path")
        if narration or recorded:
            source = temp / f"scene-{index}.txt"
            try:
                if recorded:
                    voice_file = approved_audio(recorded, workspace)
                    voice = read_pcm(ffmpeg, voice_file, 0, size / RATE + 0.5)
                    provider = "recorded"
                else:
                    source.write_text(narration, encoding="utf-8")
                    voice, voice_file, provider = synthesize(
                        source, tts_script, plan.get("voice", "uz-UZ-MadinaNeural"), ffmpeg, providers, size
                    )
                if not voice or rms(voice) < 160:
                    raise NarrationUnavailable("Narration is silent")
                available = size - RATE // 5
                if len(voice) > available:
                    tempo = len(voice) / available * 1.015
                    if tempo > 1.25:
                        raise NarrationUnavailable("Narration is too long; shorten the line or extend the scene")
                    voice = read_pcm(ffmpeg, voice_file, 0, available / RATE + 0.2, tempo=tempo)
                    if not voice or len(voice) > available or rms(voice) < 160:
                        raise NarrationUnavailable("Narration could not be fitted without truncation")
            except (NarrationUnavailable, OSError, subprocess.SubprocessError) as error:
                reason = str(error) if isinstance(error, NarrationUnavailable) else "Audio could not be decoded"
                if plan.get("narration_policy") != "optional":
                    raise ValueError(f"Scene {index}: {reason}") from error
                narration_skipped.append({"scene": index, "reason": reason})
            else:
                offset = RATE // 10
                peak = max(map(abs, voice))
                gain = min(8, 18000 / peak, 4200 / rms(voice))
                fade = RATE // 100
                for t, value in enumerate(voice):
                    speech[start + offset + t] = int(value * gain * min(1, t / fade, (len(voice) - t) / fade))
                windows.append({"scene": index, "start": (start + offset) / RATE,
                                "seconds": len(voice) / RATE, "provider": provider})
        effect = scene.get("sfx", "none")
        frequency = {"none": 0, "pop": 420, "whoosh": 240, "chime": 880}[effect]
        if frequency:
            for t in range(RATE // 3):
                seconds = t / RATE
                phase = math.tau * (frequency * seconds + (650 * seconds * seconds if effect == "whoosh" else 0))
                bed[start + t] = int(3600 * math.sin(phase) * min(1, seconds * 160) * math.exp(-10 * seconds))
        start += size

    mode = plan.get("music", "pulse")
    music_samples = None
    music_gain = 0
    if "music_path" in plan:
        music_samples = read_pcm(ffmpeg, approved_audio(plan["music_path"], workspace), 0, count / RATE)
        if not music_samples or rms(music_samples) < 80:
            raise ValueError("Music track is silent or unreadable")
        music_gain = min(0.28, 1000 / rms(music_samples))
    cursor = 0
    for i in range(count):
        t = i / RATE
        music = 0
        if music_samples is not None:
            music = music_samples[i % len(music_samples)] * music_gain
        elif mode != "none":
            chord = ((110, 164.81, 220), (98, 146.83, 196), (130.81, 196, 261.63), (82.41, 123.47, 164.81))[int(t / 2) % 4]
            phase = t % 2
            envelope = min(1, phase * 12, (2 - phase) * 10)
            pulse = math.exp(-9 * (t % 0.5)) if mode == "pulse" else 0.15
            music = envelope * (280 * sum(math.sin(math.tau * f * t) for f in chord)
                                + 340 * pulse * math.sin(math.tau * 55 * t))
        fade = min(1, t * 5, (count - i) / RATE * 2)
        while cursor < len(windows) and t > windows[cursor]["start"] + windows[cursor]["seconds"] + 0.24:
            cursor += 1
        duck = 1
        if cursor < len(windows):
            window = windows[cursor]
            attack = max(0, (window["start"] - t) / 0.10)
            release = max(0, (t - window["start"] - window["seconds"]) / 0.24)
            duck = 0.32 + 0.68 * min(1, max(attack, release))
        bed[i] = int((bed[i] * (0.60 if duck < 1 else 1) + music * duck) * fade)

    target = temp / "audio-mix.wav"
    combined = array.array("h", (voice + room for voice, room in zip(speech, bed)))
    write_wave(target, combined)
    return target, windows, narration_skipped


def verify_voice(ffmpeg, final, mix_path, windows):
    for window in windows:
        start, length = window["start"], window["seconds"]
        expected = read_pcm(ffmpeg, mix_path, start, length)
        actual = read_pcm(ffmpeg, final, start, length)
        pairs = list(zip(expected, actual))
        signal = sum(a * a for a, _ in pairs)
        encoded = sum(b * b for _, b in pairs)
        correlation = sum(a * b for a, b in pairs) / max(1, math.sqrt(signal * encoded))
        if rms(actual) < 250 or correlation < 0.82:
            raise ValueError(f"Scene {window['scene']}: final MP4 did not retain the audible voice mix")
