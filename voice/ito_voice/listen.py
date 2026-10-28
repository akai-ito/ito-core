import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field

import numpy as np

from ito_voice.audio import heard_rate

frame = 512
pause_ms = 300
trail_ms = 1500
hold_ms = 3000
barge_ms = 200
caption_every_ms = 500
lead_ms = 300
tail_ms = 200
gate_window = heard_rate
gate_every = 8
learn_seconds = 120
lowest_threshold = 0.45

joining_words = (
    "and|but|or|so|because|um+|uh+|er+m?|hmm+|like|the|a|an|to|of|with|that|if|when|then|at|for|in|on|by|"
    "from|about|into|onto|my|your|his|her|their|our|its|this|these|those|is|are|was|were|be|been|will|would|"
    "can|could|should|i|we|you|they|which|who|where|while|as|than|whether|just|maybe"
)

unfinished_endings = re.compile(rf"(,|\.\.\.|…|\b({joining_words}))\W*$", re.IGNORECASE)

sentence_end = re.compile(r"[^.][.?!][\"')\]]*$")


@dataclass(frozen=True)
class Ears:
    speech: Callable[[np.ndarray], float]
    reset: Callable[[], None]
    finished: Callable[[np.ndarray], float]
    words: Callable[[np.ndarray], str]
    voiceprint: Callable[[np.ndarray], np.ndarray]


@dataclass(frozen=True)
class Voiceprint:
    vector: np.ndarray
    threshold: float


@dataclass(frozen=True)
class Turn:
    text: str
    audio: np.ndarray


@dataclass(frozen=True)
class Hearing:
    on_hearing: Callable[[], None]
    on_heard: Callable[[str], None]
    on_turn: Callable[[Turn], None]
    on_barge: Callable[[], None]
    on_voiceprint: Callable[[Voiceprint], None]


def sounds_unfinished(text: str) -> bool:
    return bool(unfinished_endings.search(text.strip()))


def ends_like_a_sentence(text: str) -> bool:
    stripped = text.strip()
    if not sentence_end.search(stripped):
        return False
    return stripped.endswith(("?", "!")) or not sounds_unfinished(stripped)


def hold_for(text: str) -> int:
    if ends_like_a_sentence(text):
        return trail_ms
    return hold_ms if sounds_unfinished(text) else trail_ms


def learn_voiceprint(ears: Ears, turns: list[np.ndarray]) -> Voiceprint:
    vectors = [ears.voiceprint(turn) for turn in turns]
    mean = np.mean(vectors, axis=0)
    vector = mean / np.linalg.norm(mean)
    windows = [
        turn[start : start + gate_window]
        for turn in turns
        for start in range(0, turn.shape[0] - gate_window + 1, gate_window // 2)
    ]
    loudness = [float(np.sqrt(np.mean(window**2))) for window in windows]
    typical = float(np.median(loudness)) if loudness else 0.0
    voiced = [window for window, level in zip(windows, loudness, strict=True) if level >= typical / 2]
    likeness = [float(vector @ ears.voiceprint(window)) for window in voiced] or [1.0]
    return Voiceprint(vector, max(lowest_threshold, float(np.percentile(likeness, 5))))


@dataclass
class Listener:
    ears: Ears
    hearing: Hearing
    voiceprint: Voiceprint | None = None
    ari_speaking: bool = False
    _pending: np.ndarray = field(default_factory=lambda: np.zeros(0, dtype=np.float32))
    _recent: list[np.ndarray] = field(default_factory=list)
    _turn: list[np.ndarray] = field(default_factory=list)
    _quiet: int = 0
    _voiced: int = 0
    _asked: bool = False
    _hold_ms: int = hold_ms
    _frames: int = 0
    _since_caption: int = 0
    _caption_cost_ms: float = 0.0
    _you: bool = False
    _barged: bool = False
    _learning: list[np.ndarray] = field(default_factory=list)

    def feed(self, samples: np.ndarray) -> None:
        pending = np.concatenate([self._pending, samples])
        whole = pending.shape[0] // frame * frame
        for start in range(0, whole, frame):
            self._step(pending[start : start + frame])
        self._pending = pending[whole:]

    def forget(self) -> None:
        self.voiceprint = None
        self._learning = []
        self._you = False

    def flush(self) -> None:
        if self._turn:
            self._end_turn()

    def _in_turn(self) -> bool:
        return bool(self._turn)

    def _gate(self, chunk: np.ndarray) -> bool:
        if self.voiceprint is None:
            return True
        if self._frames % gate_every == 0:
            window = np.concatenate([*self._recent, chunk])[-gate_window:]
            self._you = float(self.voiceprint.vector @ self.ears.voiceprint(window)) >= self.voiceprint.threshold
        return self._you

    def _step(self, chunk: np.ndarray) -> None:
        self._frames += 1
        is_speech = self.ears.speech(chunk) >= 0.5
        is_you = self._gate(chunk)
        self._recent = [*self._recent, chunk][-(gate_window // frame) :]
        if is_speech and is_you:
            self._hear(chunk)
            return
        if not self._in_turn():
            return
        self._turn.append(chunk)
        self._quiet += frame
        self._voiced = 0
        quiet_ms = self._quiet * 1000 / heard_rate
        if quiet_ms >= pause_ms and not self._asked:
            self._asked = True
            audio = np.concatenate(self._turn)
            text = self.ears.words(audio)
            self.hearing.on_heard(text)
            if self.ears.finished(audio) >= 0.5 and ends_like_a_sentence(text):
                self._end_turn(text)
                return
            self._hold_ms = hold_for(text)
        if quiet_ms >= self._hold_ms:
            self._end_turn()

    def _hear(self, chunk: np.ndarray) -> None:
        if not self._in_turn():
            lead = lead_ms * heard_rate // 1000 // frame
            self._turn = self._recent[-lead - 1 : -1] if lead else []
            self._since_caption = 0
            self._barged = False
            self.hearing.on_hearing()
        self._turn.append(chunk)
        self._quiet, self._asked, self._hold_ms = 0, False, hold_ms
        self._voiced += frame
        self._since_caption += frame
        if self.ari_speaking and not self._barged and self._voiced * 1000 / heard_rate >= barge_ms:
            self._barged = True
            self.hearing.on_barge()
        if self._since_caption * 1000 / heard_rate >= max(caption_every_ms, 2 * self._caption_cost_ms):
            self._since_caption = 0
            started = time.perf_counter()
            text = self.ears.words(np.concatenate(self._turn))
            self._caption_cost_ms = (time.perf_counter() - started) * 1000
            self.hearing.on_heard(text)

    def _end_turn(self, text: str | None = None) -> None:
        whole = np.concatenate(self._turn)
        audio = whole[: max(whole.shape[0] - self._quiet + tail_ms * heard_rate // 1000, 0)]
        voiced = whole[: whole.shape[0] - self._quiet]
        self._turn, self._quiet, self._voiced, self._asked = [], 0, 0, False
        self.ears.reset()
        words = text if text is not None else self.ears.words(audio)
        if not words.strip():
            return
        self.hearing.on_turn(Turn(words, audio))
        if self.voiceprint is None and voiced.shape[0] > 0:
            self._learn(voiced)

    def _learn(self, audio: np.ndarray) -> None:
        self._learning.append(audio)
        if sum(turn.shape[0] for turn in self._learning) < learn_seconds * heard_rate:
            return
        self.voiceprint = learn_voiceprint(self.ears, self._learning)
        self._learning = []
        self.hearing.on_voiceprint(self.voiceprint)
