import contextlib
import gc
import json
import os
import platform
import re
import statistics
import subprocess
import sys
import threading
import time
import traceback
from collections.abc import Callable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from importlib.metadata import version
from pathlib import Path
from typing import Any

import numpy as np
import torch

from ito_voice import models
from ito_voice.audio import heard_rate, mix, resample, spoken_rate
from ito_voice.espeak import use_working_espeak
from ito_voice.listen import hold_ms, pause_ms

short_sentence = "Sure, I can do that."
medium_sentence = "She wants one more round on your design before the panel meets again in November."
long_sentence = (
    "I looked through the notes from Tuesday, and the main thing is that the budget review moved to Friday, "
    "so we should send the draft to Maya before Thursday evening."
)
everyday = [
    "Can you remind me to call the dentist tomorrow morning?",
    "I think the meeting went well, but we still need a decision on the budget.",
    "Add oat milk, eggs and a loaf of sourdough to the shopping list.",
    "What time does the last train to Brighton leave on Sunday?",
    "Let's move the design review to Thursday afternoon if everyone is free.",
    "Tell me what I said about the garden project last week.",
]
unfinished = [
    "So I was thinking that maybe we could,",
    "I need to pick up milk, eggs, and",
    "The thing about the proposal is, um,",
    "Can you check whether the",
    "What I really want to know is",
    "Let me think about that for a",
]
names = [
    ("What did Bora say about the QRT panel before Akai left for Lisbon?", ["Bora", "QRT", "Akai", "Lisbon"]),
    ("Ask Divy whether Ito should remind Ari about the Bramhecha dinner.", ["Divy", "Ito", "Ari", "Bramhecha"]),
    ("Tell Saoirse the Kokoro voice sounds better than Siobhan's demo.", ["Saoirse", "Kokoro", "Siobhan"]),
    ("Did Nnamdi send the Okonkwo contract to Joaquin yet?", ["Nnamdi", "Okonkwo", "Joaquin"]),
]
background_text = (
    "No, the other one, by the fountain. We walked past it twice yesterday and the dog wanted to stop every time."
)
background_sentences = [
    "No, the other one, by the fountain.",
    "We walked past it twice yesterday, and the dog wanted to stop every time.",
]
test_voices = ["af_heart", "bf_emma", "am_michael", "bm_george"]
strengths = [0.5, 0.8, 2.0]
pauses_ms = [300, 600, pause_ms]
gate_window = heard_rate
gate_every = 8
enrolled_voice = "af_heart"
around_db = 12
vocabulary_sample = 40
long_call_rounds = 20
first_audio_target_ms = 700
turn_target_ms = 500
recognition_target_ms = 300

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


def words(text: str) -> list[str]:
    return re.sub(r"[^\w']+", " ", text.lower()).split()


def word_errors(reference: str, hypothesis: str) -> tuple[int, int]:
    expected, heard = words(reference), words(hypothesis)
    row = list(range(len(heard) + 1))
    for index, word in enumerate(expected, 1):
        previous, row[0] = row[0], index
        for column, other in enumerate(heard, 1):
            previous, row[column] = row[column], min(row[column] + 1, row[column - 1] + 1, previous + (word != other))
    return row[-1], len(expected)


def contains(text: str, term: str) -> bool:
    wanted, heard = words(term), words(text)
    return bool(wanted) and any(heard[index : index + len(wanted)] == wanted for index in range(len(heard)))


def trimmed(samples: np.ndarray) -> np.ndarray:
    loud = np.flatnonzero(np.abs(samples) > 0.01)
    return samples[: loud[-1] + 1] if loud.size else samples


def street_noise(seconds: float) -> np.ndarray:
    white = np.random.default_rng(7).standard_normal(int(seconds * heard_rate)).astype(np.float32)
    return np.convolve(white, np.ones(8, dtype=np.float32) / 8, mode="same").astype(np.float32)


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


@dataclass(frozen=True)
class Term:
    text: str
    kind: str
    phrase: str


templates = {
    "person": "I had lunch with {} yesterday.",
    "place": "We should go to {} next month.",
    "project": "How is {} going?",
}


def to_terms(vocabulary: Mapping[str, Any]) -> list[Term]:
    terms: list[Term] = []
    for term in vocabulary.get("terms", []):
        text, kind = str(term.get("text", "")).strip(), str(term.get("kind", "term"))
        if not text:
            continue
        usable = [
            phrase
            for phrase in term.get("phrases", [])
            if contains(phrase, text) and not re.search(r"https?:|[`*#\[\]<>|]", phrase)
        ]
        terms.append(
            Term(text, kind, usable[0] if usable else templates.get(kind, "Tell me more about {}.").format(text))
        )
    return terms


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
    lines.append("| Sentence | Voice | First audio | Whole sentence | Audio length |")
    lines.append("| --- | --- | --- | --- | --- |")
    for label, text in [("5 words", short_sentence), ("15 words", medium_sentence), ("30 words", long_sentence)]:
        for voice in ["af_heart", "bf_emma"]:
            with report.step(lines, f"Speaking {label} as {voice}"):
                first_audio(speaker, text, voice)
                runs = [first_audio(speaker, text, voice) for _ in range(3)]
                firsts = [run[0] for run in runs]
                whole = spread([run[1] for run in runs])
                lines.append(f"| {label} | {voice} | {spread(firsts)} | {whole} | {runs[0][2]:.1f} s |")
                if label == "15 words" and voice == "af_heart":
                    found["first_audio"] = statistics.median(firsts)
    if loaded.speaker_device == "cuda":
        with report.step(lines, "Kokoro on the CPU, for comparison"):
            cpu = models.load_speaker("cpu")
            first_audio(cpu, medium_sentence, "af_heart")
            runs = [first_audio(cpu, medium_sentence, "af_heart") for _ in range(3)]
            lines.append("")
            lines.append(f"On the CPU instead, 15 words take {spread([run[1] for run in runs])}.")
            del cpu
    return found


def render(speaker: models.Speaker, text: str, voice: str) -> np.ndarray:
    return trimmed(resample(np.concatenate(list(models.speak(speaker, text, voice))), spoken_rate, heard_rate))


def recognised(loaded: Models, samples: np.ndarray) -> tuple[str, float]:
    return timed(lambda: models.recognise(loaded.recogniser, samples))


def boosted(loaded: Models, phrases: Sequence[str], strength: float = models.boost_strength) -> float:
    _, ms = timed(lambda: models.configure_recogniser(loaded.recogniser, phrases, strength))
    return ms


def check_recognition(report: Report, loaded: Models) -> dict[str, float]:
    lines = report.section("Recognition (Parakeet)")
    found: dict[str, float] = {}
    if loaded.recogniser is None or loaded.speaker is None:
        lines.append("- Skipped: Parakeet or Kokoro didn't load.")
        return found
    speaker = loaded.speaker
    boosted(loaded, [])
    clips = [render(speaker, text, test_voices[index % len(test_voices)]) for index, text in enumerate(everyday)]
    gap = np.zeros(heard_rate // 4, dtype=np.float32)
    talk = np.concatenate([part for clip in clips for part in (clip, gap)])
    while talk.shape[0] < 30 * heard_rate:
        talk = np.concatenate([talk, talk])
    lines.append("| Speech | Recognition |")
    lines.append("| --- | --- |")
    for seconds in [2, 5, 10, 20, 30]:
        with report.step(lines, f"Recognising {seconds} s"):
            piece = talk[: seconds * heard_rate]
            recognised(loaded, piece)
            runs = [recognised(loaded, piece)[1] for _ in range(3)]
            lines.append(f"| {seconds} s | {spread(runs)} |")
            if seconds == 5:
                found["recognition_5s"] = statistics.median(runs)
    if loaded.device == "cuda":
        lines.append("")
        lines.append(f"Peak GPU memory PyTorch held so far: {gib(torch.cuda.max_memory_reserved())}.")
    with report.step(lines, "Captions while you speak"):
        updates = [recognised(loaded, talk[: step * heard_rate // 2])[1] for step in range(1, 31)]
        lines.append("")
        lines.append(
            "Captions while you speak, recognising the whole turn again every 0.5 s up to 15 s: "
            f"{spread(updates)} per update, {updates[-1]:.0f} ms at 15 s."
        )
    with report.step(lines, "Accuracy"):
        noise = street_noise(30)
        background = render(speaker, background_text, "am_michael")
        conditions = [
            ("Quiet", lambda clip: clip),
            ("Street noise, 15 dB below", lambda clip: mix(clip, noise, 15)),
            ("Another voice nearby, 12 dB below", lambda clip: mix(clip, background, 12)),
        ]
        lines.append("")
        lines.append("| Everyday sentences, 4 voices | Word error rate |")
        lines.append("| --- | --- |")
        for label, condition in conditions:
            errors = [
                word_errors(text, recognised(loaded, condition(clip))[0])
                for text, clip in zip(everyday, clips, strict=True)
            ]
            rate = sum(error for error, _ in errors) / sum(count for _, count in errors)
            lines.append(f"| {label} | {rate:.1%} |")
            if label == "Quiet":
                found["wer"] = rate
    return found


def score_terms(
    loaded: Models, rendered: Sequence[tuple[str, Sequence[str], np.ndarray]], vocabulary: Sequence[str]
) -> tuple[int, int, int, float, list[str]]:
    right = total = invented = 0
    errors = counted = 0
    heard_lines: list[str] = []
    for text, expected, samples in rendered:
        heard, _ = recognised(loaded, samples)
        right += sum(contains(heard, term) for term in expected)
        total += len(expected)
        invented += sum(contains(heard, term) and not contains(text, term) for term in vocabulary)
        error, count = word_errors(text, heard)
        errors, counted = errors + error, counted + count
        heard_lines.append(f"- {heard}")
    return right, total, invented, errors / max(counted, 1), heard_lines


def compare_boosting(
    report: Report,
    lines: Lines,
    loaded: Models,
    *,
    title: str,
    rendered: Sequence[tuple[str, Sequence[str], np.ndarray]],
    vocabulary: Sequence[str],
    private: bool,
) -> dict[str, float]:
    found: dict[str, float] = {}
    heard: list[tuple[str, list[str]]] = []
    lines.append("")
    lines.append(f"| {title} | Names right | Names it invented | Word error rate |")
    lines.append("| --- | --- | --- | --- |")
    report.details.append(f"### {title}\n")
    report.details += [f"- {text}" for text, _, _ in rendered]
    for strength in [0.0, *strengths]:
        label = "Without the vocabulary" if strength == 0 else f"Boosted, strength {strength:g}"
        with report.step(lines, f"{title}: {label}"):
            build_ms = boosted(loaded, vocabulary if strength else [], strength or models.boost_strength)
            right, total, invented, rate, heard_lines = score_terms(loaded, rendered, vocabulary)
            lines.append(f"| {label} | {right}/{total} | {invented} | {rate:.1%} |")
            report.details += [f"- {label}:", *heard_lines]
            found[f"{strength:g}"] = right / max(total, 1)
            if strength == models.boost_strength:
                found["build_ms"] = build_ms
            if not private and strength in (0.0, models.boost_strength):
                heard.append((label, heard_lines))
    boosted(loaded, [])
    for label, heard_lines in heard:
        lines += ["", f"{label}, Parakeet heard:", "", *heard_lines]
    return found


def check_vocabulary(report: Report, loaded: Models, vocabulary: Mapping[str, Any]) -> dict[str, float]:
    lines = report.section("Vocabulary boosting")
    found: dict[str, float] = {}
    if loaded.recogniser is None or loaded.speaker is None:
        lines.append("- Skipped: Parakeet or Kokoro didn't load.")
        return found
    speaker = loaded.speaker
    terms = to_terms(vocabulary)
    texts = list(dict.fromkeys(term.text for term in terms))
    boosted_list = vocabulary.get("boosted")
    boost = [text for text in boosted_list if isinstance(text, str)] if isinstance(boosted_list, list) else texts
    lines.append(
        f"Kokoro says each sentence in one of 4 voices, and Parakeet hears it without the vocabulary and boosted "
        f"with it. Your memory has {len(texts)} vocabulary terms, and calls boost the {len(boost)} names among them "
        "you've used lately. This report shows no words from your memory: "
        "the details file beside it, which stays on this box, has every sentence and what was heard."
    )
    built_in_vocabulary = sorted({term for _, expected in names for term in expected})
    with report.step(lines, "Built-in names"):
        rendered = [
            (text, expected, render(speaker, text, test_voices[index % len(test_voices)]))
            for index, (text, expected) in enumerate(names)
        ]
        found |= {
            f"names_{key}": value
            for key, value in compare_boosting(
                report,
                lines,
                loaded,
                title="Built-in names",
                rendered=rendered,
                vocabulary=built_in_vocabulary,
                private=False,
            ).items()
        }
    if not terms:
        lines.append("")
        lines.append("Your memory has no vocabulary yet, so only the built-in names were tried.")
        return found
    with report.step(lines, "Your vocabulary"):
        sample = terms[:vocabulary_sample]
        rendered = [
            (term.phrase, [term.text], render(speaker, term.phrase, test_voices[index % len(test_voices)]))
            for index, term in enumerate(sample)
        ]
        found |= {
            f"yours_{key}": value
            for key, value in compare_boosting(
                report,
                lines,
                loaded,
                title=f"Your {len(sample)} most used terms",
                rendered=rendered,
                vocabulary=boost,
                private=True,
            ).items()
        }
    with report.step(lines, "Everyday sentences with your names boosted"):
        rendered = [
            (text, [], render(speaker, text, test_voices[index % len(test_voices)]))
            for index, text in enumerate(everyday)
        ]
        found |= {
            f"everyday_{key}": value
            for key, value in compare_boosting(
                report,
                lines,
                loaded,
                title="Everyday sentences, none of your names in them",
                rendered=rendered,
                vocabulary=boost,
                private=True,
            ).items()
        }
    return found


@dataclass(frozen=True)
class Turn:
    ended_by: str | None
    probability: float | None
    after_ms: float | None
    decisions_ms: tuple[float, ...]


def scaled_bed(around: np.ndarray, speech: np.ndarray, length: int) -> np.ndarray:
    bed = np.resize(around, length)
    return (bed * np.sqrt(np.mean(speech**2) / np.mean(bed**2) / 10 ** (around_db / 10))).astype(np.float32)


def follow_turn(
    vad: Any,
    turn: models.TurnModel,
    speech: np.ndarray,
    pause_ms: int,
    around: np.ndarray | None,
    *,
    is_you: Callable[[np.ndarray], bool] | None = None,
) -> Turn:
    lead = np.zeros(heard_rate // 2, dtype=np.float32)
    tail = np.zeros(hold_ms * heard_rate // 1000 + heard_rate, dtype=np.float32)
    timeline = np.concatenate([lead, speech, tail])
    if around is not None:
        timeline = timeline + scaled_bed(around, speech, timeline.shape[0])
    speech_end = (lead.shape[0] + speech.shape[0]) / heard_rate
    vad.reset_states()
    frame = models.vad_frame
    started: int | None = None
    quiet = 0
    asked = False
    probability: float | None = None
    decisions: list[float] = []
    you = True
    for index in range(timeline.shape[0] // frame):
        end = (index + 1) * frame
        chunk = timeline[index * frame : end]
        now = end / heard_rate
        if is_you is not None and index % gate_every == 0:
            you = is_you(timeline[max(0, end - gate_window) : end])
        if models.speech_probability(vad, chunk) >= models.speech_threshold and you:
            started = index * frame if started is None else started
            quiet, asked = 0, False
            continue
        if started is None:
            continue
        quiet += frame
        quiet_ms = quiet * 1000 / heard_rate
        if quiet_ms >= pause_ms and not asked:
            asked = True
            probability, ms = timed(models.turn_probability, turn, timeline[started : (index + 1) * frame])
            decisions.append(ms)
            if probability >= models.turn_threshold:
                after = (now + ms / 1000 - speech_end) * 1000
                return Turn("smart_turn", probability, after, tuple(decisions))
        if quiet_ms >= hold_ms:
            return Turn("quiet", probability, (now - speech_end) * 1000, tuple(decisions))
    return Turn(None, probability, None, tuple(decisions))


def on_time_ms(turns: Sequence[Turn]) -> list[float]:
    return [
        turn.after_ms
        for turn in turns
        if turn.ended_by == "smart_turn" and turn.after_ms is not None and turn.after_ms >= 0
    ]


def describe_finished(turns: Sequence[Turn]) -> str:
    on_time = on_time_ms(turns)
    cut = sum(turn.after_ms is not None and turn.after_ms < 0 for turn in turns)
    waited = sum(turn.ended_by == "quiet" for turn in turns)
    never = sum(turn.ended_by is None for turn in turns)
    parts = [f"{len(on_time)}/{len(turns)} in {spread(on_time)}"]
    parts += [f"**{cut} cut off mid-sentence**"] if cut else []
    parts += [f"{waited} waited {hold_ms / 1000:.0f} s"] if waited else []
    parts += [f"**{never} never ended**"] if never else []
    return ", ".join(parts)


def describe_unfinished(turns: Sequence[Turn]) -> str:
    early = sum(turn.ended_by == "smart_turn" for turn in turns)
    never = sum(turn.ended_by is None for turn in turns)
    parts = [f"{len(turns) - early - never}/{len(turns)} waited"]
    parts += [f"**{early} ended too soon**"] if early else []
    parts += [f"**{never} never ended**"] if never else []
    return ", ".join(parts)


def speech_share(vad: Any, sound: np.ndarray) -> float:
    vad.reset_states()
    frames = range(0, sound.shape[0] - models.vad_frame, models.vad_frame)
    flagged = [
        models.speech_probability(vad, sound[index : index + models.vad_frame]) >= models.speech_threshold
        for index in frames
    ]
    return sum(flagged) / max(len(flagged), 1)


def check_turns(report: Report, loaded: Models) -> dict[str, float]:
    lines = report.section("Turn-taking")
    found: dict[str, float] = {}
    vad, turn, speaker = loaded.vad, loaded.turn, loaded.speaker
    if vad is None or turn is None or speaker is None:
        lines.append("- Skipped: Silero, Smart Turn or Kokoro didn't load.")
        return found
    with report.step(lines, "Silero's speed"):
        frames = street_noise(10)
        _, ms = timed(speech_share, vad, frames)
        lines.append(
            f"- Silero VAD: {ms / (frames.shape[0] // models.vad_frame):.2f} ms per 32 ms of sound, on the CPU"
        )
    finished_clips = [render(speaker, text, test_voices[index % 4]) for index, text in enumerate(everyday)]
    unfinished_clips = [render(speaker, text, test_voices[index % 4]) for index, text in enumerate(unfinished)]
    background = np.concatenate(
        [render(speaker, sentence, "am_michael") for sentence in background_sentences + background_sentences]
    )
    noise = street_noise(20)
    reference = np.concatenate(finished_clips)
    with report.step(lines, "What Silero takes for speech"):
        for label, bed in [("street noise", noise), ("another voice", background)]:
            share = speech_share(vad, scaled_bed(bed, reference, 10 * heard_rate))
            lines.append(f"- Silero takes {share:.0%} of {label} {around_db} dB quieter than you, alone, for speech")
    decisions: list[float] = []
    lines.append(
        f"- Each turn: Silero waits for a pause, then Smart Turn decides; if it says unfinished, the turn ends after "
        f"{hold_ms / 1000:.0f} s of quiet. Times run from the end of speech to `turn_ended`; street noise and the "
        f"other voice are {around_db} dB quieter than you, and go on after you stop."
    )
    lines.append("")
    lines.append(
        "| Pause before Smart Turn | Sound | 6 finished turns: ended | 6 unfinished turns "
        "| Smart Turn's scores, finished / unfinished |"
    )
    lines.append("| --- | --- | --- | --- | --- |")
    sounds: list[tuple[str, np.ndarray | None]] = [
        ("Quiet", None),
        ("Street noise", noise),
        ("Another voice", background),
    ]
    for pause in pauses_ms:
        for label, around in sounds:
            with report.step(lines, f"Turns with a {pause} ms pause, {label}"):
                done = [follow_turn(vad, turn, clip, pause, around) for clip in finished_clips]
                held = [follow_turn(vad, turn, clip, pause, around) for clip in unfinished_clips]
                decisions += [ms for one in [*done, *held] for ms in one.decisions_ms]
                scores = " / ".join(
                    " ".join(f"{one.probability:.2f}" if one.probability is not None else "-" for one in group)
                    for group in (done, held)
                )
                lines.append(
                    f"| {pause} ms | {label} | {describe_finished(done)} | {describe_unfinished(held)} | {scores} |"
                )
                on_time = on_time_ms(done)
                if pause == pause_ms and label == "Quiet" and on_time:
                    found["turn"] = statistics.median(on_time)
                    found["turn_cut"] = sum(one.after_ms is not None and one.after_ms < 0 for one in done)
    lines.append("")
    lines.append(f"- Smart Turn: {spread(decisions)} per decision, on the CPU")
    return found


def windows_of(samples: np.ndarray) -> list[np.ndarray]:
    hop = gate_window // 2
    return [samples[start : start + gate_window] for start in range(0, samples.shape[0] - gate_window + 1, hop)]


def best_threshold(yours: Sequence[float], others: Sequence[float]) -> tuple[float, float, float]:
    def score(threshold: float) -> tuple[float, float, float]:
        passed = sum(value >= threshold for value in yours) / len(yours)
        refused = sum(value < threshold for value in others) / len(others)
        return passed + refused, passed, 1 - refused

    candidates = sorted({*yours, *others})
    chosen = max(candidates, key=lambda threshold: score(threshold)[0])
    _, passed, let_in = score(chosen)
    return chosen, passed, let_in


def check_voiceprints(report: Report, loaded: Models) -> dict[str, float]:
    lines = report.section("Your voice only (TitaNet)")
    found: dict[str, float] = {}
    vad, turn, speaker = loaded.vad, loaded.turn, loaded.speaker
    if vad is None or turn is None or speaker is None:
        lines.append("- Skipped: Silero, Smart Turn or Kokoro didn't load.")
        return found
    lines.append(
        f"Kokoro's {enrolled_voice} stands in for you: enrolled from 3 sentences, then compared, a second at a "
        "time, with other sentences of its own and with other voices. A real voice from your recordings will differ."
    )
    lines.append("")
    model: Any = None
    with report.step(lines, "Loading TitaNet"):
        model, ms = timed(models.load_voiceprints, "cpu")
        lines.append(f"- TitaNet on the CPU: {ms / 1000:.1f} s")
    if model is None:
        return found
    with report.step(lines, "Comparing voices"):
        enrolled = models.voiceprint(
            model, np.concatenate([render(speaker, text, enrolled_voice) for text in everyday[:3]])
        )
        background = render(speaker, background_text, "am_michael")
        yours = [render(speaker, text, enrolled_voice) for text in everyday[3:]]
        groups = [
            ("You, other sentences", yours, True),
            (
                f"You, with another voice {around_db} dB quieter",
                [mix(clip, background, around_db) for clip in yours],
                True,
            ),
            (
                "Someone who sounds like you (af_bella)",
                [render(speaker, text, "af_bella") for text in everyday[3:]],
                False,
            ),
            (
                "Someone else (am_michael, bf_emma, af_sarah)",
                [
                    render(speaker, text, voice)
                    for text, voice in zip(everyday[3:], ["am_michael", "bf_emma", "af_sarah"], strict=True)
                ],
                False,
            ),
        ]
        times: list[float] = []
        similar: dict[bool, list[float]] = {True: [], False: []}
        lines.append("| 1 s of speech | Likeness to you, median (min, max) |")
        lines.append("| --- | --- |")
        for label, clips, is_yours in groups:
            values: list[float] = []
            for window in [window for clip in clips for window in windows_of(clip)]:
                print_, ms = timed(models.voiceprint, model, window)
                times.append(ms)
                values.append(float(enrolled @ print_))
            similar[is_yours] += values
            lines.append(f"| {label} | {statistics.median(values):.2f} ({min(values):.2f}, {max(values):.2f}) |")
        threshold, passed, let_in = best_threshold(similar[True], similar[False])
        found |= {"voiceprint_threshold": threshold, "voiceprint_passed": passed, "voiceprint_let_in": let_in}
        lines.append("")
        lines.append(
            f"- At a likeness of {threshold:.2f}, {passed:.0%} of your seconds pass and {let_in:.0%} of others' do"
        )
        lines.append(f"- TitaNet: {spread(times)} per second of speech, on the CPU")

        def is_you(window: np.ndarray) -> bool:
            return float(enrolled @ models.voiceprint(model, window)) >= threshold

        finished_clips = [render(speaker, text, enrolled_voice) for text in everyday]
        unfinished_clips = [render(speaker, text, enrolled_voice) for text in unfinished]
        lines.append("")
        lines.append(
            f"Turns in {enrolled_voice}'s voice beside another voice, with a {pause_ms} ms pause before Smart "
            "Turn, without and with the gate: a sound holds the turn open only while the last second sounds like you."
        )
        lines.append("")
        lines.append("| Beside another voice | 6 finished turns: ended | 6 unfinished turns |")
        lines.append("| --- | --- | --- |")
        for label, gate in [("Without the gate", None), ("With the gate", is_you)]:
            done = [follow_turn(vad, turn, clip, pause_ms, background, is_you=gate) for clip in finished_clips]
            held = [follow_turn(vad, turn, clip, pause_ms, background, is_you=gate) for clip in unfinished_clips]
            lines.append(f"| {label} | {describe_finished(done)} | {describe_unfinished(held)} |")
            on_time = on_time_ms(done)
            if on_time:
                found["gated_turn" if gate else "ungated_turn"] = statistics.median(on_time)
    return found


def check_together(report: Report, loaded: Models) -> None:
    lines = report.section("Speaking and listening at once, taking turns on the GPU")
    if loaded.recogniser is None or loaded.speaker is None:
        lines.append("- Skipped: Parakeet or Kokoro didn't load.")
        return
    speaker = loaded.speaker
    with report.step(lines, "Speaking and listening at once"):
        speech = np.concatenate([render(speaker, text, "af_heart") for text in everyday[:3]])[: 10 * heard_rate]
        alone_speaking = [first_audio(speaker, long_sentence, "af_heart")[1] for _ in range(3)]
        alone_hearing = [recognised(loaded, speech)[1] for _ in range(3)]
        speaking: list[float] = []
        hearing: list[float] = []
        barrier = threading.Barrier(2)

        def speak_once() -> float:
            started = time.perf_counter()
            with gpu_lock:
                first_audio(speaker, long_sentence, "af_heart")
            return (time.perf_counter() - started) * 1000

        def hear_once() -> float:
            started = time.perf_counter()
            with gpu_lock:
                recognised(loaded, speech)
            return (time.perf_counter() - started) * 1000

        def speak_loop() -> None:
            barrier.wait()
            speaking.extend(speak_once() for _ in range(3))

        def hear_loop() -> None:
            barrier.wait()
            hearing.extend(hear_once() for _ in range(3))

        threads = [threading.Thread(target=speak_loop), threading.Thread(target=hear_loop)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        lines.append(
            f"- Kokoro saying 30 words: {spread(alone_speaking)} alone, {spread(speaking)} while Parakeet listens"
        )
        lines.append(
            f"- Parakeet hearing {speech.shape[0] / heard_rate:.0f} s: {spread(alone_hearing)} alone, "
            f"{spread(hearing)} while Kokoro speaks"
        )
        if loaded.device == "cuda":
            lines.append(
                f"- Peak GPU memory PyTorch held over the whole check: {gib(torch.cuda.max_memory_reserved())}"
            )


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


def check_long_call(report: Report, loaded: Models) -> dict[str, float]:
    lines = report.section("A long call")
    found: dict[str, float] = {}
    speaker, recogniser = loaded.speaker, loaded.recogniser
    if speaker is None or recogniser is None:
        lines.append("- Skipped: Kokoro or Parakeet didn't load.")
        return found
    lines.append(
        f"{long_call_rounds} rounds of what a long call does, one at a time on the GPU: the vocabulary changes, "
        "Ari says a sentence, and Parakeet hears a turn. GPU memory should stay flat."
    )
    lines.append("")
    with report.step(lines, "A long call"):
        turn = np.concatenate([render(speaker, text, "af_heart") for text in everyday[:2]])
        sentences = [medium_sentence, long_sentence, everyday[2]]
        terms = [term for _, expected in names for term in expected]
        held: list[float] = []
        for index in range(long_call_rounds):
            with gpu_lock:
                models.configure_recogniser(recogniser, terms[: 4 + index % len(terms)])
            with gpu_lock:
                list(models.speak(speaker, sentences[index % len(sentences)], "af_heart"))
            with gpu_lock:
                models.recognise(recogniser, turn)
            if loaded.device == "cuda":
                held.append(torch.cuda.memory_allocated())
        if held:
            lines.append(
                f"- GPU memory in use: {gib(held[0])} after the first round, {gib(held[-1])} after the last, "
                f"peak {gib(torch.cuda.max_memory_allocated())}"
            )
            found["long_call_growth"] = (held[-1] - held[0]) / 1024**2
        lines.append(f"- All {long_call_rounds} rounds came through")
    models.configure_recogniser(recogniser, [])
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
    def verdict(value: float | None, target: float) -> str:
        return (
            "n/a"
            if value is None
            else f"{value:.0f} ms ({'within' if value <= target else 'over'} the {target} ms target)"
        )

    gpu = torch.cuda.get_device_properties(0).name if device == "cuda" else "none (CPU numbers)"
    together = (
        "Kokoro and Parakeet both on the GPU"
        if loaded.speaker_device == "cuda"
        else (
            "Parakeet on the GPU, Kokoro on the CPU" if loaded.speaker_device == "cpu" and device == "cuda" else device
        )
    )
    names_plain, names_boosted = results.get("names_0"), results.get(f"names_{models.boost_strength:g}")
    yours_plain, yours_boosted = results.get("yours_0"), results.get(f"yours_{models.boost_strength:g}")

    everything = all(part is not None for part in [loaded.speaker, loaded.recogniser, loaded.vad, loaded.turn])

    def ms_or_na(value: float | None) -> str:
        return "n/a" if value is None else f"{value:.0f} ms"

    def share(value: float | None) -> str:
        return "n/a" if value is None else f"{value:.0%}"

    report.summary += [
        f"- GPU: {gpu}; layout: {together}",
        f"- Everything loaded: {'yes' if everything else 'NO'}",
        f"- First audio for 15 words: {verdict(results.get('first_audio'), first_audio_target_ms)}",
        f"- End of speech to `turn_ended`, finished thoughts, quiet: {verdict(results.get('turn'), turn_target_ms)}"
        + (f", {results['turn_cut']:.0f} of 6 cut off mid-sentence" if results.get("turn_cut") else ""),
        f"- Recognising a 5 s turn: {verdict(results.get('recognition_5s'), recognition_target_ms)}",
        f"- On a call, end of speech to the turn's words: {ms_or_na(results.get('call_turn'))}",
        (
            f"- A long call: GPU memory grew {results['long_call_growth']:.0f} MB over {long_call_rounds} rounds"
            if "long_call_growth" in results
            else "- A long call: n/a"
        ),
        f"- Word error rate, everyday sentences: {share(results.get('wer'))}",
        f"- Built-in names right: {share(names_plain)} plain, {share(names_boosted)} boosted",
        f"- Your names right: {share(yours_plain)} plain, {share(yours_boosted)} boosted",
        (
            f"- Your voice only: {share(results.get('voiceprint_passed'))} of your seconds pass, "
            f"{share(results.get('voiceprint_let_in'))} of others'; beside another voice, finished turns end in "
            f"{ms_or_na(results.get('gated_turn'))} with the gate, {ms_or_na(results.get('ungated_turn'))} without"
        ),
        f"- Problems: {len(report.problems)}",
    ]


def check(vocabulary_file: Path | None, report_file: Path, details_file: Path) -> int:
    report = Report()
    started = time.perf_counter()
    vocabulary: Mapping[str, Any] = {}
    if vocabulary_file is not None:
        vocabulary = json.loads(vocabulary_file.read_text())
    device = check_box(report)
    check_downloads(report)
    loaded = load_models(report, device)
    results: dict[str, float] = {}
    sections: list[Callable[[], Mapping[str, float] | None]] = [
        lambda: check_speaking(report, loaded),
        lambda: check_recognition(report, loaded),
        lambda: check_vocabulary(report, loaded, vocabulary),
        lambda: check_turns(report, loaded),
        lambda: check_voiceprints(report, loaded),
        lambda: check_call(report, loaded),
        lambda: check_long_call(report, loaded),
        lambda: check_together(report, loaded),
    ]
    for section in sections:
        results |= section() or {}
        note_memory(report)
    summarise(report, device, loaded, results)
    report.summary.append(f"- The check took {(time.perf_counter() - started) / 60:.1f} minutes")
    text = report.markdown()
    report_file.write_text(text)
    details_file.write_text("# Ito voice check: details\n\n" + "\n".join(report.details) + "\n")
    print(text)
    return 1 if report.problems else 0
