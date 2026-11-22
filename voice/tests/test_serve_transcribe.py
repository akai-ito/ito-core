import asyncio
import threading
from collections.abc import Iterator, Mapping
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from ito_voice import models, serve
from ito_voice.link import LinkError
from ito_voice.transcribe import TranscriptionError
from tests.test_transcribe import fake_models, in_blocks, quiet, tone


class Notes:
    def __init__(self) -> None:
        self.sent: list[tuple[str, Mapping[str, Any]]] = []

    def notify(self, method: str, params: Mapping[str, Any]) -> None:
        self.sent.append((method, params))


def ready_voice(notes: Notes, monkeypatch: pytest.MonkeyPatch, blocks: Iterator[np.ndarray]) -> serve.Voice:
    voice = serve.Voice(notes)  # type: ignore[arg-type]
    voice._loaded = serve.Loaded(object(), object(), object(), object())  # type: ignore[arg-type]  # noqa: SLF001
    monkeypatch.setattr(serve, "new_vad", lambda: (fake_models.speech, lambda: None))
    monkeypatch.setattr(models, "recognise", lambda _model, samples: fake_models.recognise(samples))
    monkeypatch.setattr(models, "voiceprint", lambda _model, samples: fake_models.voiceprint(samples))
    monkeypatch.setattr(serve, "decode", lambda _path: blocks)
    monkeypatch.setattr(serve, "probe_seconds", lambda _path: 9.0)
    return voice


def test_a_recording_is_transcribed_over_the_link_with_its_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    notes = Notes()
    audio = np.concatenate([tone(3, 200), quiet(1), tone(3, 800), quiet(2)])
    voice = ready_voice(notes, monkeypatch, in_blocks(audio))

    heard = asyncio.run(voice.transcribe({"job": "f_1", "path": str(Path("talk.m4a"))}))

    assert heard["seconds"] == pytest.approx(9.0)
    assert [segment.get("speaker") for segment in heard["segments"]] == ["S1", "S2"]
    assert heard["speakers"] == [
        {"id": "S1", "seconds": pytest.approx(3.3, abs=0.2), "you": False},
        {"id": "S2", "seconds": pytest.approx(3.3, abs=0.2), "you": False},
    ]
    assert heard["model"] == models.parakeet_model
    assert notes.sent[0] == ("transcribing", {"job": "f_1", "done": pytest.approx(2.5), "total": 9.0})


def test_a_recording_that_cant_be_read_answers_with_its_own_code(monkeypatch: pytest.MonkeyPatch) -> None:
    def unreadable() -> Iterator[np.ndarray]:
        message = "ffmpeg couldn't read the recording: Invalid data"
        raise TranscriptionError(message)
        yield np.zeros(1)

    voice = ready_voice(Notes(), monkeypatch, unreadable())

    with pytest.raises(LinkError) as raised:
        asyncio.run(voice.transcribe({"job": "f_2", "path": "talk.m4a"}))
    assert raised.value.code == serve.unreadable_code
    assert raised.value.message == "ffmpeg couldn't read the recording: Invalid data"


def test_a_transcription_stops_when_cancelled(monkeypatch: pytest.MonkeyPatch) -> None:
    started = threading.Event()

    def endless() -> Iterator[np.ndarray]:
        while True:
            started.set()
            yield tone(0.5)

    voice = ready_voice(Notes(), monkeypatch, endless())

    async def cancel_once_started() -> None:
        transcribing = asyncio.create_task(voice.transcribe({"job": "f_3", "path": "talk.m4a"}))
        await asyncio.get_running_loop().run_in_executor(None, started.wait)
        await voice.cancel_transcription({"job": "f_3"})
        await transcribing

    with pytest.raises(LinkError) as raised:
        asyncio.run(cancel_once_started())
    assert raised.value.code == serve.cancelled_code


def test_nothing_is_transcribed_before_the_voice_has_loaded() -> None:
    voice = serve.Voice(Notes())  # type: ignore[arg-type]

    with pytest.raises(LinkError) as raised:
        asyncio.run(voice.transcribe({"job": "f_4", "path": "talk.m4a"}))
    assert raised.value.code == serve.loading_code
