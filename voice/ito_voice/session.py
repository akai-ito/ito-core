import queue
import threading
import traceback
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any

import numpy as np

from ito_voice.audio import heard_rate, to_base64
from ito_voice.listen import Ears, Hearing, Listener, Turn, Voiceprint, frame

piece_seconds = 20
search_seconds = 2


@dataclass(frozen=True)
class Tools:
    recognise: Callable[[np.ndarray], str]
    finished: Callable[[np.ndarray], float]
    voiceprint: Callable[[np.ndarray], np.ndarray]
    vad: Callable[[], tuple[Callable[[np.ndarray], float], Callable[[], None]]]


def split_point(audio: np.ndarray, limit: int) -> int:
    start = max(limit - search_seconds * heard_rate, 0)
    frames = [audio[index : index + frame] for index in range(start, limit - frame + 1, frame)]
    if not frames:
        return limit
    quietest = int(np.argmin([float(np.mean(chunk**2)) for chunk in frames]))
    return start + quietest * frame + frame // 2


class Transcriber:
    def __init__(self, recognise: Callable[[np.ndarray], str]) -> None:
        self._recognise = recognise
        self._done: list[tuple[int, str]] = []

    def words(self, audio: np.ndarray) -> str:
        start = self._done[-1][0] if self._done else 0
        while audio.shape[0] - start > piece_seconds * heard_rate:
            end = split_point(audio, start + piece_seconds * heard_rate)
            self._done.append((end, self._recognise(audio[start:end]).strip()))
            start = end
        rest = self._recognise(audio[start:]).strip() if audio.shape[0] - start >= frame else ""
        return " ".join(text for text in [*(text for _, text in self._done), rest] if text)

    def reset(self) -> None:
        self._done = []


def to_voiceprint(params: Mapping[str, Any]) -> Voiceprint | None:
    saved = params.get("voiceprint")
    if not isinstance(saved, Mapping):
        return None
    vector, threshold = saved.get("vector"), saved.get("threshold")
    if not isinstance(vector, list) or not isinstance(threshold, int | float):
        return None
    return Voiceprint(np.asarray(vector, dtype=np.float32), float(threshold))


class Session:
    def __init__(
        self,
        name: str,
        tools: Tools,
        notify: Callable[[str, Mapping[str, Any]], None],
        voiceprint: Voiceprint | None,
    ) -> None:
        self._name = name
        self._notify = notify
        self._commands: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._dead = threading.Event()
        speech, reset_vad = tools.vad()
        transcriber = Transcriber(tools.recognise)

        def reset() -> None:
            reset_vad()
            transcriber.reset()

        ears = Ears(speech, reset, tools.finished, transcriber.words, tools.voiceprint)
        hearing = Hearing(self._heard, self._turn, self._barge, self._voiceprint)
        self._listener = Listener(ears, hearing, voiceprint)
        self._thread = threading.Thread(target=self._run, name=f"session-{name}", daemon=True)
        self._thread.start()

    def _say(self, method: str, params: Mapping[str, Any]) -> None:
        self._notify(method, {"session": self._name, **params})

    def _heard(self, text: str) -> None:
        self._say("heard", {"text": text})

    def _turn(self, turn: Turn) -> None:
        self._say("turn", {"text": turn.text, "audio": to_base64(turn.audio)})

    def _barge(self) -> None:
        self._say("barge", {})

    def _voiceprint(self, voiceprint: Voiceprint) -> None:
        self._say("voiceprint", {"vector": voiceprint.vector.tolist(), "threshold": voiceprint.threshold})

    def _run(self) -> None:
        while True:
            kind, value = self._commands.get()
            try:
                if kind == "audio":
                    self._listener.feed(value)
                elif kind == "speaking":
                    self._listener.ari_speaking = value
                elif kind == "flush":
                    self._listener.flush()
            except Exception as error:
                traceback.print_exc()
                self._dead.set()
                self._say("problem", {"reason": f"The voice failed while listening: {error}"})
                return
            finally:
                if isinstance(value, threading.Event):
                    value.set()
            if kind == "stop":
                return

    def hear(self, samples: np.ndarray) -> None:
        self._commands.put(("audio", samples))

    def speaking(self, *, on: bool) -> None:
        self._commands.put(("speaking", on))

    def _ask(self, kind: str) -> threading.Event:
        if self._dead.is_set() or not self._thread.is_alive():
            return self._dead
        done = threading.Event()
        self._commands.put((kind, done))
        return done

    def flush(self) -> threading.Event:
        return self._ask("flush")

    def stop(self) -> threading.Event:
        return self._ask("stop")
