import contextlib
import gc
import os
import platform
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from collections import Counter
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any

import numpy as np
import torch

from ito_voice import models
from ito_voice.audio import heard_rate, resample, spoken_rate
from ito_voice.espeak import use_working_espeak
from ito_voice.listen import hold_ms

short_sentence = "Sure, I can do that."
medium_sentence = "She wants one more round on your design before the panel meets again in November."
long_sentence = (
    "I looked through the notes from Tuesday, and the main thing is that the budget review moved to Friday, "
    "so we should send the draft to Hana before Thursday evening."
)
everyday = [
    "Can you remind me to call the dentist tomorrow morning?",
    "I think the meeting went well, but we still need a decision on the budget.",
    "Add oat milk, eggs and a loaf of sourdough to the shopping list.",
]
first_audio_target_ms = 700
# Two made-up people for a recording: who says what, in turn.
conversation = [
    ("af_heart", "Thanks for making the time today. Could you start by telling me about your current role?"),
    ("bm_george", "Of course. I lead a small team that builds the tools our analysts use every day."),
    ("af_heart", "What's a decision you made there that you'd make differently now?"),
    ("bm_george", "We rewrote the data loader too early. I'd measure first and only then rebuild it."),
    ("af_heart", "That's honest. How do you decide what your team works on next?"),
    ("bm_george", "We keep a short list, ranked by what blocks people most, and look at it every Monday."),
]

type Lines = list[str]

gpu_lock = threading.Lock()


def progress(text: str) -> None:
    print(f"· {text}", file=sys.stderr, flush=True)


def sync() -> None:
    if torch.cuda.is_available() and torch.cuda.is_initialized():
        torch.cuda.synchronize()


def timed[**P, T](work: Callable[P, T], *args: P.args, **kwargs: P.kwargs) -> tuple[T, float]:
    sync()
    start = time.perf_counter()
    value = work(*args, **kwargs)
    sync()
    return value, (time.perf_counter() - start) * 1000


def spread(values: Sequence[float]) -> str:
    if not values:
        return "n/a"
    if len(values) == 1:
        return f"{values[0]:.0f} ms"
    return f"{statistics.median(values):.0f} ms (min {min(values):.0f}, max {max(values):.0f})"


def gib(size: float) -> str:
    return f"{size / 1024**3:.2f} GB"


def trimmed(samples: np.ndarray) -> np.ndarray:
    loud = np.flatnonzero(np.abs(samples) > 0.01)
    return samples[: loud[-1] + 1] if loud.size else samples


def run_command(arguments: Sequence[str]) -> str:
    try:
        done = subprocess.run(arguments, capture_output=True, text=True, timeout=20, check=False)
    except (OSError, subprocess.TimeoutExpired) as error:
        return f"unavailable ({error})"
    return (done.stdout or done.stderr).strip()


def read_first(path: str, prefix: str) -> str:
    try:
        lines = Path(path).read_text().splitlines()
    except OSError:
        return "unknown"
    return next((line.split(":", 1)[1].strip() for line in lines if line.startswith(prefix)), "unknown")


def gpu_used() -> int:
    free, total = torch.cuda.mem_get_info()
    return total - free


class Report:
    def __init__(self) -> None:
        self.sections: list[tuple[str, Lines]] = []
        self.details: Lines = []
        self.problems: Lines = []
        self.summary: Lines = []

    def section(self, title: str) -> Lines:
        lines: Lines = []
        self.sections.append((title, lines))
        progress(title)
        return lines

    @contextlib.contextmanager
    def step(self, lines: Lines, what: str) -> Iterator[None]:
        try:
            yield
        except Exception as error:
            first = (str(error).strip().splitlines() or [""])[0]
            line = f"{what} failed: {type(error).__name__}: {first}"
            lines.append(f"- **{line}**")
            self.problems.append(line)
            self.details.append(f"### {what}\n\n```text\n{traceback.format_exc()}```\n")
            progress(line)
            if isinstance(error, torch.cuda.OutOfMemoryError):
                torch.cuda.empty_cache()

    def markdown(self) -> str:
        parts = ["# Ito voice check", "", "## Summary", "", *self.summary, ""]
        if self.problems:
            parts += ["## Problems", "", *(f"- {problem}" for problem in self.problems), ""]
        for title, lines in self.sections:
            parts += [f"## {title}", "", *lines, ""]
        return "\n".join(parts)


@dataclass
class Models:
    device: str
    speaker: models.Speaker | None = None
    speaker_device: str | None = None
    recogniser: Any = None
    vad: Any = None
    turn: models.TurnModel | None = None


def check_box(report: Report) -> str:
    lines = report.section("Box")
    lines.append(f"- System: {platform.platform()}, glibc {platform.libc_ver()[1] or 'unknown'}")
    lines.append(f"- CPU: {read_first('/proc/cpuinfo', 'model name')}, {os.cpu_count()} threads")
    lines.append(f"- Memory: {read_first('/proc/meminfo', 'MemTotal')}")
    lines.append(f"- Python {platform.python_version()}, PyTorch {torch.__version__} (CUDA {torch.version.cuda})")
    packages = ["nemo-toolkit", "kokoro", "misaki", "onnxruntime", "silero-vad", "transformers", "huggingface-hub"]
    lines.append("- Packages: " + ", ".join(f"{name} {version(name)}" for name in packages))
    lines.append(
        f"- NVIDIA driver: {run_command(['nvidia-smi', '--query-gpu=driver_version', '--format=csv,noheader'])}"
    )
    device = "cpu"
    with report.step(lines, "Starting CUDA"):
        device = models.choose_device()
    if device == "cuda":
        properties = torch.cuda.get_device_properties(0)
        capability = f"sm_{properties.major}{properties.minor}"
        built = torch.cuda.get_arch_list()
        covered = capability in built or any(
            arch.startswith(f"sm_{properties.major}") and arch <= capability for arch in built
        )
        free, total = torch.cuda.mem_get_info()
        lines.append(f"- GPU: {properties.name}, {capability}, {gib(total)} ({gib(free)} free at the start)")
        lines.append(f"- PyTorch's kernels: {', '.join(built)}; {capability} {'is' if covered else 'is NOT'} covered")
        lines.append(f"- cuDNN {torch.backends.cudnn.version()}")
        listed = run_command(
            ["nvidia-smi", "--query-compute-apps=pid,process_name,used_memory", "--format=csv,noheader"]
        )
        others = "; ".join(line for line in listed.splitlines() if not line.startswith(f"{os.getpid()},"))
        lines.append(f"- Already on the GPU: {others or 'nothing'}")
        if others:
            lines.append("  (If one is ito serve's voice, stop ito serve and run the check again for clean numbers.)")
        if not covered:
            report.problems.append(f"This PyTorch has no kernels for {capability}.")
    else:
        lines.append(f"- GPU: none in use, so every number below is from the CPU ({device})")
    with report.step(lines, "espeak-ng"):
        library = use_working_espeak()
        from misaki import espeak

        fallback = espeak.EspeakFallback(british=False)
        phonemes = fallback.backend.phonemize(["Bramhecha"])
        lines.append(f"- espeak-ng: {library}; it says Bramhecha as {phonemes[0].strip()!r}")
    return device


def check_downloads(report: Report) -> None:
    from huggingface_hub import hf_hub_download, snapshot_download

    lines = report.section("Downloads")
    lines.append(f"- Cache: {os.environ.get('HF_HOME', '~/.cache/huggingface')}")
    downloads: list[tuple[str, Callable[[], object]]] = [
        ("Parakeet", lambda: snapshot_download(models.parakeet_model)),
        ("Kokoro", lambda: snapshot_download(models.kokoro_repo, allow_patterns=["*.json", "*.pth", "voices/*.pt"])),
        ("Smart Turn", lambda: hf_hub_download(models.turn_repo, models.turn_file)),
        ("TitaNet", lambda: snapshot_download(models.voiceprint_model)),
    ]
    for name, download in downloads:
        with report.step(lines, f"Downloading {name}"):
            _, ms = timed(download)
            lines.append(f"- {name}: {ms / 1000:.1f} s")


def load_models(report: Report, device: str) -> Models:
    lines = report.section("Loading")
    loaded = Models(device)
    on_gpu = device == "cuda"
    if on_gpu:
        torch.zeros(1, device="cuda")
        baseline = gpu_used()
        lines.append(f"- CUDA itself, with anything else on the GPU: {gib(baseline)}")

    def load_speaker(where: str) -> None:
        before = gpu_used() if on_gpu else 0
        speaker, ms = timed(lambda: models.load_speaker(where))
        list(models.speak(speaker, "Ready.", "af_heart"))
        loaded.speaker, loaded.speaker_device = speaker, where
        memory = f", {gib(gpu_used() - before)} of GPU memory" if on_gpu and where == "cuda" else ""
        lines.append(f"- Kokoro on the {where.upper()}: {ms / 1000:.1f} s{memory}")

    def load_recogniser() -> None:
        before = gpu_used() if on_gpu else 0
        recogniser, ms = timed(models.load_recogniser, device)
        models.warm_recogniser(recogniser)
        loaded.recogniser = recogniser
        memory = f", {gib(gpu_used() - before)} of GPU memory" if on_gpu else ""
        lines.append(f"- Parakeet on the {device.upper()}: {ms / 1000:.1f} s{memory}")

    with report.step(lines, f"Loading Kokoro on the {device.upper()}"):
        load_speaker(device)
    fits = True
    with report.step(lines, f"Loading Parakeet on the {device.upper()}"):
        try:
            load_recogniser()
        except torch.cuda.OutOfMemoryError as error:
            fits = False
            lines.append(f"- **Parakeet didn't fit beside Kokoro: {str(error).splitlines()[0]}**")
    if not fits:
        lines.append("- **Trying Parakeet on the GPU and Kokoro on the CPU**")
        report.problems.append("Kokoro and Parakeet don't fit on the GPU together.")
        loaded.speaker, loaded.recogniser = None, None
        gc.collect()
        torch.cuda.empty_cache()
        with report.step(lines, "Loading Parakeet on the GPU, with Kokoro on the CPU"):
            load_recogniser()
            load_speaker("cpu")
    with report.step(lines, "Loading Silero VAD"):
        loaded.vad, ms = timed(models.load_vad)
        lines.append(f"- Silero VAD on the CPU: {ms:.0f} ms")
    with report.step(lines, "Loading Smart Turn"):
        loaded.turn, ms = timed(models.load_turn_model)
        lines.append(f"- Smart Turn on the CPU: {ms:.0f} ms")
    if on_gpu:
        lines.append(f"- GPU memory in use now: {gib(gpu_used())} of {gib(torch.cuda.mem_get_info()[1])}")
        lines.append(f"- The most PyTorch held while loading: {gib(torch.cuda.max_memory_reserved())}")
        torch.cuda.reset_peak_memory_stats()
    return loaded


def first_audio(speaker: models.Speaker, text: str, voice: str) -> tuple[float, float, float]:
    start = time.perf_counter()
    chunks = models.speak(speaker, text, voice)
    first = next(chunks)
    first_ms = (time.perf_counter() - start) * 1000
    samples = sum(len(chunk) for chunk in [first, *chunks])
    return first_ms, (time.perf_counter() - start) * 1000, samples / spoken_rate


def check_speaking(report: Report, loaded: Models) -> dict[str, float]:
    lines = report.section("Ari's voice (Kokoro)")
    found: dict[str, float] = {}
    if loaded.speaker is None:
        lines.append("- Skipped: Kokoro didn't load.")
        return found
    speaker = loaded.speaker
    lines.append(f"Kokoro runs on the {(loaded.speaker_device or '').upper()}. Each figure is 3 runs after warm-up.")
    lines.append("")
    lines.append("| Sentence | First audio | Whole sentence | Audio length |")
    lines.append("| --- | --- | --- | --- |")
    for label, text in [("5 words", short_sentence), ("15 words", medium_sentence), ("30 words", long_sentence)]:
        with report.step(lines, f"Speaking {label}"):
            first_audio(speaker, text, "af_heart")
            runs = [first_audio(speaker, text, "af_heart") for _ in range(3)]
            firsts = [run[0] for run in runs]
            lines.append(f"| {label} | {spread(firsts)} | {spread([run[1] for run in runs])} | {runs[0][2]:.1f} s |")
            if label == "15 words":
                found["first_audio"] = statistics.median(firsts)
    return found


def render(speaker: models.Speaker, text: str, voice: str) -> np.ndarray:
    return trimmed(resample(np.concatenate(list(models.speak(speaker, text, voice))), spoken_rate, heard_rate))


def feed_paced(session: Any, samples: np.ndarray) -> None:
    for index in range(0, samples.shape[0], models.vad_frame):
        session.hear(samples[index : index + models.vad_frame])
        time.sleep(models.vad_frame / heard_rate)


def stream_like_a_call(session: Any, clips: Sequence[np.ndarray]) -> list[float]:
    ends: list[float] = []
    for clip in clips:
        feed_paced(session, clip)
        ends.append(time.perf_counter())
        feed_paced(session, np.zeros((hold_ms + 500) * heard_rate // 1000, dtype=np.float32))
    return ends


def check_call(report: Report, loaded: Models) -> dict[str, float]:
    lines = report.section("A call through the box")
    found: dict[str, float] = {}
    speaker, recogniser, turn_model = loaded.speaker, loaded.recogniser, loaded.turn
    if speaker is None or recogniser is None or turn_model is None:
        lines.append("- Skipped: Kokoro, Parakeet or Smart Turn didn't load.")
        return found
    lines.append(
        "Three turns stream through a real listening session at the pace of speech, 32 ms at a time, as a "
        "call's microphone would: the same code ito serve runs, from its own thread."
    )
    lines.append("")
    with report.step(lines, "A call through the box"):
        from ito_voice.serve import new_vad
        from ito_voice.session import Session, Tools

        def recognise(samples: np.ndarray) -> str:
            with gpu_lock:
                return models.recognise(recogniser, samples)

        tools = Tools(
            recognise=recognise,
            finished=lambda samples: models.turn_probability(turn_model, samples),
            voiceprint=lambda _samples: np.zeros(1, dtype=np.float32),
            vad=new_vad,
        )
        heard: list[tuple[float, str, Mapping[str, Any]]] = []
        start = time.perf_counter()

        def notify(method: str, params: Mapping[str, Any]) -> None:
            heard.append((time.perf_counter() - start, method, params))

        session = Session("check", tools, notify, None)
        turns = [render(speaker, text, "af_heart") for text in everyday[:3]]
        ends = [end - start for end in stream_like_a_call(session, turns)]
        before_echo = len(heard)
        session.saying(long_sentence)
        feed_paced(session, 0.3 * render(speaker, long_sentence, "bf_emma"))
        session.saying(None)
        feed_paced(session, np.zeros((hold_ms + 500) * heard_rate // 1000, dtype=np.float32))
        echoed = [method for _, method, _ in heard[before_echo:] if method in ("turn", "barge")]
        del heard[before_echo:]
        session.stop().wait(timeout=30)
        finished = [(at, params.get("text", "")) for at, method, params in heard if method == "turn"]
        problems = [params.get("reason") for _, method, params in heard if method == "problem"]
        captions = sum(method == "heard" for _, method, _ in heard)
        delays = [(at - end) * 1000 for (at, _), end in zip(finished, ends, strict=False)]
        lines.append(f"- Turns sent: {len(finished)} of {len(turns)}; live captions: {captions}")
        lines.append(f"- End of speech to the turn's words, as heard: {spread(delays)}")
        for (_, text), expected in zip(finished, everyday, strict=False):
            lines.append(f'  - "{text}" (said: "{expected}")')
        lines.append(
            f"- Ari's own voice played back into the microphone: {'**heard as you**' if echoed else 'ignored'}"
        )
        if echoed:
            report.problems.append("Ari's echo came through a call as a turn or a barge-in.")
        if problems:
            lines.append(f"- **The session failed: {problems[0]}**")
            report.problems.append(f"The listening session failed: {problems[0]}")
        if delays:
            found["call_turn"] = statistics.median(delays)
        if len(finished) != len(turns):
            report.problems.append(f"Only {len(finished)} of {len(turns)} turns came through a call.")
    return found


def speaker_agreement(segments: Sequence[Any], turns: Sequence[tuple[float, float, str]]) -> float:
    pairs = []
    for segment in segments:
        middle = (segment.start + segment.end) / 2
        voice = next((voice for start, end, voice in turns if start <= middle <= end), None)
        if voice is not None:
            pairs.append((voice, segment.speaker))
    if not pairs:
        return 0.0
    usual = {voice: Counter(label for each, label in pairs if each == voice).most_common(1)[0][0] for voice, _ in pairs}
    if len(set(usual.values())) < len(usual):
        return 0.0
    return sum(label == usual[voice] for voice, label in pairs) / len(pairs)


def check_transcription(report: Report, loaded: Models) -> dict[str, float]:
    lines = report.section("Transcribing a recording")
    found: dict[str, float] = {}
    speaker, recogniser = loaded.speaker, loaded.recogniser
    lines.append(f"- ffmpeg: {(run_command(['ffmpeg', '-version']).splitlines() or ['unavailable'])[0]}")
    if speaker is None or recogniser is None:
        lines.append("- Skipped: Kokoro or Parakeet didn't load.")
        return found
    lines.append(
        "Two Kokoro voices hold a short interview, written to a WAV file, which goes through the same code a "
        "recording you upload does: ffmpeg, Silero, Parakeet, and TitaNet voiceprints to tell the speakers apart."
    )
    lines.append("")
    with report.step(lines, "Transcribing a recording"), tempfile.TemporaryDirectory() as folder:
        from scipy.io import wavfile

        from ito_voice.serve import new_vad
        from ito_voice.transcribe import Models as Ears
        from ito_voice.transcribe import decode, transcribe

        voiceprints = models.load_voiceprints("cpu")
        gap = np.zeros(int(0.8 * heard_rate), dtype=np.float32)
        clips = [(voice, render(speaker, text, voice)) for voice, text in conversation * 2]
        turns: list[tuple[float, float, str]] = []
        position = 0
        for voice, clip in clips:
            turns.append((position / heard_rate, (position + clip.shape[0]) / heard_rate, voice))
            position += clip.shape[0] + gap.shape[0]
        audio = np.concatenate([part for _, clip in clips for part in (clip, gap)])
        recording = Path(folder) / "interview.wav"
        wavfile.write(recording, heard_rate, (np.clip(audio, -1, 1) * 32_767).astype(np.int16))
        speech, _ = new_vad()

        def recognise(samples: np.ndarray) -> str:
            with gpu_lock:
                return models.recognise(recogniser, samples)

        ears = Ears(speech, recognise, lambda samples: models.voiceprint(voiceprints, samples))
        transcript, ms = timed(transcribe, decode(recording), ears, None, lambda _: None, threading.Event())
        speed = transcript.seconds / (ms / 1000)
        agreement = speaker_agreement(transcript.segments, turns)
        lines.append(f"- {transcript.seconds:.0f} s of audio in {ms / 1000:.1f} s: {speed:.0f} times real time")
        lines.append(
            f"- An hour's recording would take about {3600 / speed / 60:.1f} minutes (with nothing else on the GPU)"
        )
        lines.append(f"- Segments: {len(transcript.segments)} from {len(clips)} turns")
        lines.append(f"- Speakers found: {len(transcript.speakers)} (2 spoke)")
        lines.append(f"- Segments labelled with the right speaker: {agreement:.0%}")
        for segment in transcript.segments[:4]:
            lines.append(f"  - [{segment.start:.1f} s] {segment.speaker}: {segment.text}")
        if len(transcript.speakers) != 2 or agreement < 0.9:
            report.problems.append("Speaker labels on a two-person recording weren't right; see its section.")
        found["transcription_speed"] = speed
        found["speaker_agreement"] = agreement
    return found


def note_memory(report: Report) -> None:
    if not (torch.cuda.is_available() and torch.cuda.is_initialized()):
        return
    models.release_gpu_memory()
    _, lines = report.sections[-1]
    lines.append("")
    lines.append(
        f"_GPU memory after this section: {gib(torch.cuda.memory_allocated())} in use, "
        f"peak {gib(torch.cuda.max_memory_allocated())}._"
    )
    torch.cuda.reset_peak_memory_stats()


def summarise(report: Report, device: str, loaded: Models, results: Mapping[str, float]) -> None:
    first = results.get("first_audio")
    call = results.get("call_turn")
    speed = results.get("transcription_speed")
    gpu = torch.cuda.get_device_properties(0).name if device == "cuda" else "none (CPU numbers)"
    layout = (
        "Kokoro and Parakeet both on the GPU"
        if loaded.speaker_device == "cuda"
        else (
            "Parakeet on the GPU, Kokoro on the CPU" if loaded.speaker_device == "cpu" and device == "cuda" else device
        )
    )
    everything = all(part is not None for part in [loaded.speaker, loaded.recogniser, loaded.vad, loaded.turn])
    report.summary += [
        f"- GPU: {gpu}; layout: {layout}",
        f"- Everything loaded: {'yes' if everything else 'NO'}",
        "- First audio for 15 words: "
        + (
            "n/a"
            if first is None
            else f"{first:.0f} ms ({'within' if first <= first_audio_target_ms else 'over'} the "
            f"{first_audio_target_ms} ms target)"
        ),
        f"- On a call, end of speech to the turn's words: {'n/a' if call is None else f'{call:.0f} ms'}",
        "- Transcribing a recording: "
        + (
            "n/a"
            if speed is None
            else f"{speed:.0f} times real time, speakers right on {results.get('speaker_agreement', 0):.0%} of segments"
        ),
        f"- Problems: {len(report.problems)}",
    ]


def check(report_file: Path, details_file: Path) -> int:
    report = Report()
    started = time.perf_counter()
    device = check_box(report)
    check_downloads(report)
    loaded = load_models(report, device)
    results: dict[str, float] = {}
    sections: list[Callable[[], Mapping[str, float]]] = [
        lambda: check_speaking(report, loaded),
        lambda: check_call(report, loaded),
        lambda: check_transcription(report, loaded),
    ]
    for section in sections:
        results |= section()
        note_memory(report)
    summarise(report, device, loaded, results)
    report.summary.append(f"- The check took {(time.perf_counter() - started) / 60:.1f} minutes")
    text = report.markdown()
    report_file.write_text(text)
    details_file.write_text("# Ito voice check: details\n\n" + "\n".join(report.details) + "\n")
    print(text)
    return 1 if report.problems else 0
