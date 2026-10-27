import asyncio
import os
import sys
import traceback
from collections.abc import Callable, Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from typing import Any

import numpy as np
import torch

from ito_voice import models
from ito_voice.audio import spoken_rate, to_base64
from ito_voice.link import Link, LinkError, claim_stdout, protocol

loading_code = -32_001
failed_code = -32_002


@dataclass(frozen=True)
class Loaded:
    speaker: models.Speaker
    recogniser: Any
    vad: Any
    turn: models.TurnModel
    cuda_graphs: bool


def load() -> Loaded:
    device = models.choose_device()
    speaker = models.load_speaker(device)
    list(models.speak(speaker, "Ready.", "af_heart"))
    recogniser = models.load_recogniser(device)
    graphs_failure = models.warm_recogniser(recogniser)
    if graphs_failure is not None:
        print(f"CUDA graphs failed, so decoding runs without them: {graphs_failure}", file=sys.stderr)
    return Loaded(speaker, recogniser, models.load_vad(), models.load_turn_model(), graphs_failure is None)


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
            models.configure_recogniser(loaded.recogniser, phrases, cuda_graphs=loaded.cuda_graphs)

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
        print(f"The voice is loaded, with CUDA graphs {'on' if loaded.cuda_graphs else 'off'}.", file=sys.stderr)
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
            chunks = list(models.speak(speaker, text, voice))
            return np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)

        samples = await self._on_gpu(render)
        return {"audio": to_base64(samples), "rate": spoken_rate}


async def run() -> None:
    link = Link(claim_stdout())
    voice = Voice(link)
    loading = asyncio.create_task(voice.start())
    await link.run({"initialize": voice.initialize, "vocabulary": voice.vocabulary, "speak": voice.speak})
    loading.cancel()


def serve() -> None:
    asyncio.run(run())
    sys.stderr.flush()
    os._exit(0)
