"""A whole recording, such as an hour's interview, into a transcript with times and speakers.

ffmpeg decodes any format a phone records in to 16 kHz mono, a block at a time, so an hour never sits in memory.
Silero finds the speech and splits it at pauses into pieces of at most 20 seconds; Parakeet, the model a call
already uses, recognises each piece, steered toward the names in memory. A TitaNet voiceprint of each piece is
clustered to tell the speakers apart, and the speaker whose voice matches the person's own voiceprint is them.
No other model is loaded for it.
"""

import json
import shutil
import subprocess
import threading
import time
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage

from ito_voice.audio import heard_rate
from ito_voice.listen import Voiceprint, frame
from ito_voice.session import split_point

block_seconds = 10
piece_seconds = 20
# Speech shorter than this, such as a click or a cough, isn't a piece.
shortest_piece_ms = 300
pause_ms = 400
pad_ms = 150
speech_threshold = 0.5
# A piece needs a second of speech for its voiceprint to say who it is; shorter ones take their neighbour's.
voiceprint_seconds = 1.0
# Voiceprints closer than this (cosine distance) are one speaker.
same_speaker_distance = 0.55
most_speakers = 8
# A "speaker" heard for less than this, whose voice is still somewhat like another's, is more likely a cough or a
# mismatch, so it joins that voice. One unlike anyone stays itself, however briefly they spoke.
fewest_speaker_seconds = 4.0
mismatch_likeness = 0.25
progress_every_seconds = 1.0

type Speech = Callable[[np.ndarray], float]


class TranscriptionError(Exception):
    """The recording couldn't be transcribed, for a reason the person can act on."""


class CancelledError(Exception):
    """The recording was deleted, or the server stopped asking, while it was being transcribed."""


@dataclass(frozen=True)
class Piece:
    start: int
    audio: np.ndarray

    @property
    def end(self) -> int:
        return self.start + self.audio.shape[0]


@dataclass(frozen=True)
class Heard:
    start: float
    end: float
    text: str
    voiceprint: np.ndarray | None


@dataclass(frozen=True)
class Speaker:
    id: str
    seconds: float
    you: bool


@dataclass(frozen=True)
class Segment:
    start: float
    end: float
    text: str
    speaker: str | None

    def to_json(self) -> dict[str, object]:
        timed = {"start": self.start, "end": self.end, "text": self.text}
        return timed if self.speaker is None else {**timed, "speaker": self.speaker}


@dataclass(frozen=True)
class Transcript:
    seconds: float
    segments: list[Segment]
    speakers: list[Speaker]


def find_tool(name: str) -> str:
    found = shutil.which(name)
    if found is None:
        message = f"{name} isn't installed on this box, so recordings can't be read: sudo apt install ffmpeg."
        raise TranscriptionError(message)
    return found


def probe_seconds(path: Path) -> float | None:
    try:
        done = subprocess.run(
            [find_tool("ffprobe"), "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
        duration = json.loads(done.stdout or "{}").get("format", {}).get("duration")
        return float(duration) if duration is not None else None
    except (TranscriptionError, OSError, subprocess.TimeoutExpired, ValueError):
        return None


def decode(path: Path) -> Iterator[np.ndarray]:
    command = [
        find_tool("ffmpeg"),
        *("-nostdin", "-hide_banner", "-loglevel", "error", "-i", str(path)),
        *("-vn", "-ac", "1", "-ar", str(heard_rate), "-f", "s16le", "-"),
    ]
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if process.stdout is None or process.stderr is None:
        message = "ffmpeg didn't start."
        raise TranscriptionError(message)
    errors: list[bytes] = []
    reading = threading.Thread(target=lambda: errors.append(process.stderr.read() if process.stderr else b""))
    reading.start()
    finished = False
    try:
        while block := process.stdout.read(block_seconds * heard_rate * 2):
            usable = len(block) // 2 * 2
            yield np.frombuffer(block[:usable], dtype="<i2").astype(np.float32) / 32_768
        finished = True
    finally:
        if not finished:
            process.kill()
        process.stdout.close()
        code = process.wait()
        reading.join()
    if code != 0:
        said = b"".join(errors).decode(errors="replace").strip().splitlines()
        message = f"ffmpeg couldn't read the recording: {said[-1] if said else f'it exited with {code}'}"
        raise TranscriptionError(message)


@dataclass
class Splitter:
    """Cuts a stream of audio into pieces of speech, at pauses, each at most `piece_seconds` long."""

    speech: Speech
    _pending: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    _position: int = 0
    _recent: list[np.ndarray] = field(default_factory=list)
    _piece: list[np.ndarray] = field(default_factory=list)
    _piece_start: int = 0
    _quiet: int = 0
    _voiced: int = 0

    def feed(self, samples: np.ndarray) -> list[Piece]:
        pending = np.concatenate([self._pending, samples])
        whole = pending.shape[0] // frame * frame
        pieces = [piece for start in range(0, whole, frame) for piece in self._step(pending[start : start + frame])]
        self._pending = pending[whole:]
        return pieces

    def flush(self) -> list[Piece]:
        tail = [*self._piece, self._pending] if self._piece else []
        self._pending = np.zeros(0, dtype=np.float32)
        return self._close(np.concatenate(tail)) if tail else []

    def _step(self, chunk: np.ndarray) -> list[Piece]:
        start = self._position
        self._position += chunk.shape[0]
        is_speech = self.speech(chunk) >= speech_threshold
        lead = pad_ms * heard_rate // 1000 // frame
        if not self._piece:
            self._recent = [*self._recent, chunk][-(lead + 1) :]
            if not is_speech:
                return []
            self._piece = list(self._recent)
            self._piece_start = start + chunk.shape[0] - sum(each.shape[0] for each in self._piece)
            self._quiet, self._voiced = 0, chunk.shape[0]
            self._recent = []
            return []
        self._piece.append(chunk)
        self._quiet = 0 if is_speech else self._quiet + chunk.shape[0]
        self._voiced += chunk.shape[0] if is_speech else 0
        if self._quiet * 1000 >= pause_ms * heard_rate:
            audio = np.concatenate(self._piece)
            keep = audio.shape[0] - self._quiet + pad_ms * heard_rate // 1000
            return self._close(audio[:keep])
        audio = np.concatenate(self._piece)
        if audio.shape[0] < piece_seconds * heard_rate:
            return []
        cut = split_point(audio, audio.shape[0])
        first = Piece(self._piece_start, audio[:cut])
        self._piece_start += cut
        self._piece = [audio[cut:]]
        return [first]

    def _close(self, audio: np.ndarray) -> list[Piece]:
        piece, voiced = Piece(self._piece_start, audio), self._voiced
        self._piece, self._quiet, self._voiced, self._recent = [], 0, 0, []
        return [piece] if voiced * 1000 >= shortest_piece_ms * heard_rate else []


def cluster(prints: Sequence[np.ndarray]) -> list[int]:
    if len(prints) < 2:
        return [0] * len(prints)
    tree = linkage(np.stack(prints), method="average", metric="cosine")
    groups = fcluster(tree, same_speaker_distance, "distance")
    if len(set(groups)) > most_speakers:
        groups = fcluster(tree, most_speakers, "maxclust")
    return [int(group) for group in groups]


def unit(vector: np.ndarray) -> np.ndarray:
    return vector / (np.linalg.norm(vector) or 1.0)


def label_speakers(heard: Sequence[Heard], you: Voiceprint | None) -> tuple[list[str | None], list[Speaker]]:
    """Names each piece's speaker S1, S2… in order of first appearance, or `you` for the person's own voice."""
    printed = [(index, unit(piece.voiceprint)) for index, piece in enumerate(heard) if piece.voiceprint is not None]
    if not printed:
        return [None] * len(heard), []
    groups = cluster([vector for _, vector in printed])
    seconds: dict[int, float] = {}
    for (index, _), group in zip(printed, groups, strict=True):
        seconds[group] = seconds.get(group, 0.0) + heard[index].end - heard[index].start
    centres = {
        group: unit(np.mean([vector for (_, vector), each in zip(printed, groups, strict=True) if each == group], 0))
        for group in seconds
    }
    longest = max(seconds, key=lambda group: seconds[group])
    big = [group for group, total in seconds.items() if total >= fewest_speaker_seconds] or [longest]

    def nearest(group: int) -> int:
        closest = max(big, key=lambda kept: float(centres[kept] @ centres[group]))
        return closest if float(centres[closest] @ centres[group]) >= mismatch_likeness else group

    joins = {group: group if group in big else nearest(group) for group in seconds}
    main = sorted(set(joins.values()))
    merged = [joins[group] for group in groups]
    you_group = None
    if you is not None:
        likeness = {group: float(centres[group] @ unit(you.vector)) for group in main}
        best = max(likeness, key=lambda group: likeness[group])
        you_group = best if likeness[best] >= you.threshold else None
    others = [group for group in dict.fromkeys(merged) if group != you_group]
    names = {group: f"S{position + 1}" for position, group in enumerate(others)} | (
        {you_group: "you"} if you_group is not None else {}
    )
    by_piece = {index: names[group] for (index, _), group in zip(printed, merged, strict=True)}
    labels = fill_gaps([by_piece.get(index) for index in range(len(heard))])
    totals: dict[str, float] = {}
    for piece, label in zip(heard, labels, strict=True):
        if label is not None:
            totals[label] = totals.get(label, 0.0) + piece.end - piece.start
    speakers = [
        Speaker(label, round(total, 1), label == "you")
        for label, total in sorted(totals.items(), key=lambda item: labels.index(item[0]))
    ]
    return labels, speakers


def fill_gaps(labels: Sequence[str | None]) -> list[str | None]:
    """A piece too short for a voiceprint takes the speaker before it, or after it at the start."""
    filled: list[str | None] = []
    for label in labels:
        filled.append(label if label is not None else (filled[-1] if filled else None))
    following: str | None = None
    for index in range(len(filled) - 1, -1, -1):
        if filled[index] is None:
            filled[index] = following
        else:
            following = filled[index]
    return filled


@dataclass(frozen=True)
class Models:
    speech: Speech
    recognise: Callable[[np.ndarray], str]
    voiceprint: Callable[[np.ndarray], np.ndarray]


def transcribe(
    blocks: Iterator[np.ndarray],
    ears: Models,
    you: Voiceprint | None,
    progress: Callable[[float], None],
    cancelled: threading.Event,
) -> Transcript:
    splitter = Splitter(ears.speech)
    heard: list[Heard] = []
    told = 0.0
    done = 0

    def take(pieces: list[Piece]) -> None:
        for piece in pieces:
            if cancelled.is_set():
                raise CancelledError
            text = ears.recognise(piece.audio).strip()
            if not text:
                continue
            long_enough = piece.audio.shape[0] >= voiceprint_seconds * heard_rate
            heard.append(
                Heard(
                    piece.start / heard_rate,
                    piece.end / heard_rate,
                    text,
                    ears.voiceprint(piece.audio) if long_enough else None,
                )
            )

    for block in blocks:
        if cancelled.is_set():
            raise CancelledError
        take(splitter.feed(block))
        done += block.shape[0]
        if time.monotonic() - told >= progress_every_seconds:
            told = time.monotonic()
            progress(done / heard_rate)
    take(splitter.flush())
    labels, speakers = label_speakers(heard, you)
    segments = [
        Segment(round(piece.start, 2), round(piece.end, 2), piece.text, label)
        for piece, label in zip(heard, labels, strict=True)
    ]
    return Transcript(round(done / heard_rate, 2), segments, speakers)
