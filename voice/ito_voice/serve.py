import asyncio
import base64
import os
import sys
import threading
import traceback
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import numpy as np
import torch

from ito_voice import models
from ito_voice.audio import from_pcm, spoken_rate, to_base64
from ito_voice.link import Link, LinkError, claim_stdout, protocol
from ito_voice.session import Session, Tools, to_voiceprint

loading_code = -32_001
failed_code = -32_002


@dataclass(frozen=True)
class Loaded:
    speaker: models.Speaker
    recogniser: Any
    voiceprints: Any
    turn: models.TurnModel


def load() -> Loaded:
    device = models.choose_device()
    speaker = models.load_speaker(device)
    list(models.speak(speaker, "Ready.", "af_heart"))
    recogniser = models.load_recogniser(device)
    models.warm_recogniser(recogniser)
    voiceprints = models.load_voiceprints("cpu")
    models.load_vad()
    return Loaded(speaker, recogniser, voiceprints, models.load_turn_model())


def new_vad() -> tuple[Callable[[np.ndarray], float], Callable[[], None]]:
    vad = models.load_vad()
    return (lambda chunk: models.speech_probability(vad, chunk)), vad.reset_states


def describe_failure(error: BaseException) -> str:
    if isinstance(error, torch.cuda.OutOfMemoryError):
        return f"The GPU ran out of memory loading the voice: {str(error).splitlines()[0]}"
    return str(error) if isinstance(error, RuntimeError) else f"The voice couldn't load: {error}"


class Voice:
    def __init__(self, link: Link) -> None:
        self._link = link
        self._wanted: Sequence[str] = []
        self._arrived = asyncio.Event()
        self._gpu = ThreadPoolExecutor(max_workers=1, thread_name_prefix="gpu")
        self._loaded: Loaded | None = None
        self._failure: str | None = None
        self._applied: Sequence[str] | None = None
        self._reported: tuple[str, str | None] | None = None
        self._gpu_lock = threading.Lock()
        self._sessions: dict[str, Session] = {}

    def _state(self) -> tuple[str, str | None]:
        if self._failure is not None:
            return ("failed", self._failure)
        if self._loaded is None:
            return ("loading", "The voice models are still loading.")
        if self._applied is None:
            return ("loading", "The voice is waiting for memory's vocabulary.")
        return ("ready", None)

    def _report(self) -> None:
        state = self._state()
        if state == self._reported:
            return
        self._reported = state
        name, reason = state
        self._link.notify("status", {"state": name} if reason is None else {"state": name, "reason": reason})

    async def _on_gpu[T](self, work: Callable[[], T]) -> T:
        return await asyncio.get_running_loop().run_in_executor(self._gpu, work)

    async def _apply(self, loaded: Loaded, phrases: Sequence[str]) -> None:
        def configure() -> None:
            with self._gpu_lock:
                models.configure_recogniser(loaded.recogniser, phrases)

        await self._on_gpu(configure)
        self._applied = phrases

    async def start(self) -> None:
        self._report()
        try:
            loaded = await self._on_gpu(load)
        except Exception as error:
            traceback.print_exc()
            self._failure = describe_failure(error)
            self._report()
            return
        self._loaded = loaded
        print("The voice is loaded.", file=sys.stderr)
        self._report()
        await self._arrived.wait()
        await self._apply(loaded, self._wanted)
        self._report()

    def _ready_speaker(self) -> models.Speaker:
        if self._failure is not None:
            raise LinkError(failed_code, self._failure)
        if self._loaded is None:
            raise LinkError(loading_code, "The voice models are still loading.")
        return self._loaded.speaker

    async def initialize(self, _: Mapping[str, Any]) -> Mapping[str, Any]:
        return {"protocol": protocol}

    async def vocabulary(self, params: Mapping[str, Any]) -> Mapping[str, Any]:
        phrases = [phrase for phrase in params.get("phrases", []) if isinstance(phrase, str) and phrase.strip()]
        self._wanted = phrases
        self._arrived.set()
        if self._loaded is not None:
            await self._apply(self._loaded, phrases)
            self._report()
        return {}

    async def speak(self, params: Mapping[str, Any]) -> Mapping[str, Any]:
        speaker = self._ready_speaker()
        text, voice = params.get("text"), params.get("voice")
        if not isinstance(text, str) or not isinstance(voice, str):
            raise LinkError(-32_602, "speak needs text and a voice.")

        def render() -> np.ndarray:
            with self._gpu_lock:
                chunks = list(models.speak(speaker, text, voice))
            return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)

        samples = await self._on_gpu(render)
        return {"audio": to_base64(samples), "rate": spoken_rate}

    def _tools(self, loaded: Loaded) -> Tools:
        def recognise(samples: np.ndarray) -> str:
            with self._gpu_lock:
                return models.recognise(loaded.recogniser, samples)

        return Tools(
            recognise=recognise,
            finished=lambda samples: models.turn_probability(loaded.turn, samples),
            voiceprint=lambda samples: models.voiceprint(loaded.voiceprints, samples),
            vad=new_vad,
        )

    def _session(self, params: Mapping[str, Any]) -> Session:
        session = self._sessions.get(str(params.get("session")))
        if session is None:
            raise LinkError(-32_602, f"There's no session {params.get('session')}.")
        return session

    async def listen(self, params: Mapping[str, Any]) -> Mapping[str, Any]:
        self._ready_speaker()
        loaded = self._loaded
        name = params.get("session")
        if loaded is None or not isinstance(name, str):
            raise LinkError(-32_602, "listen needs a session.")
        previous = self._sessions.pop(name, None)
        if previous is not None:
            previous.stop()
        self._sessions[name] = Session(name, self._tools(loaded), self._link.notify, to_voiceprint(params))
        return {}

    async def flush(self, params: Mapping[str, Any]) -> Mapping[str, Any]:
        done = self._session(params).flush()
        await asyncio.get_running_loop().run_in_executor(None, done.wait)
        return {}

    async def forget(self, _: Mapping[str, Any]) -> Mapping[str, Any]:
        loop = asyncio.get_running_loop()
        for session in list(self._sessions.values()):
            await loop.run_in_executor(None, session.forget().wait)
        return {}

    async def stop(self, params: Mapping[str, Any]) -> Mapping[str, Any]:
        session = self._sessions.pop(str(params.get("session")), None)
        if session is not None:
            await asyncio.get_running_loop().run_in_executor(None, session.stop().wait)
        return {}

    def hear(self, params: Mapping[str, Any]) -> None:
        pcm = params.get("pcm")
        if isinstance(pcm, str):
            self._session(params).hear(from_pcm(base64.b64decode(pcm)))

    def saying(self, params: Mapping[str, Any]) -> None:
        text = params.get("text")
        self._session(params).saying(text if isinstance(text, str) else None)


async def run() -> None:
    link = Link(claim_stdout())
    voice = Voice(link)
    loading = asyncio.create_task(voice.start())
    handlers = {
        "initialize": voice.initialize,
        "vocabulary": voice.vocabulary,
        "speak": voice.speak,
        "listen": voice.listen,
        "flush": voice.flush,
        "stop": voice.stop,
        "forget": voice.forget,
    }
    await link.run(handlers, {"audio": voice.hear, "saying": voice.saying})
    loading.cancel()


def serve() -> None:
    asyncio.run(run())
    sys.stderr.flush()
    os._exit(0)
