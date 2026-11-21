import shutil
import sys
import threading
from collections.abc import Iterator
from pathlib import Path

import numpy as np
import pytest
from scipy.io import wavfile

from ito_voice.audio import heard_rate
from ito_voice.listen import Voiceprint
from ito_voice.transcribe import (
    CancelledError,
    Heard,
    Models,
    Splitter,
    TranscriptionError,
    decode,
    label_speakers,
    piece_seconds,
    probe_seconds,
    transcribe,
)


def tone(seconds: float, hertz: float = 200) -> np.ndarray:
    steps = np.arange(int(seconds * heard_rate)) / heard_rate
    return (0.3 * np.sin(2 * np.pi * hertz * steps)).astype(np.float32)


def quiet(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * heard_rate), dtype=np.float32)


def loud(samples: np.ndarray) -> float:
    return 1.0 if float(np.sqrt(np.mean(samples**2))) > 0.01 else 0.0


def pitch(samples: np.ndarray) -> float:
    spectrum = np.abs(np.fft.rfft(samples))
    return float(np.fft.rfftfreq(samples.shape[0], 1 / heard_rate)[int(np.argmax(spectrum))])


def in_blocks(audio: np.ndarray, seconds: float = 2.5) -> Iterator[np.ndarray]:
    size = int(seconds * heard_rate)
    for start in range(0, audio.shape[0], size):
        yield audio[start : start + size]


# Two made-up voices: a low one and a high one, each recognised as what it is.
fake_models = Models(
    speech=loud,
    recognise=lambda samples: "A low voice." if pitch(samples) < 500 else "A high voice.",
    voiceprint=lambda samples: np.array([1.0, 0.0]) if pitch(samples) < 500 else np.array([0.0, 1.0]),
)


def test_speech_is_cut_at_pauses_with_a_little_room_either_side() -> None:
    splitter = Splitter(loud)
    audio = np.concatenate([quiet(0.5), tone(1.0), quiet(1.0), tone(0.5), quiet(0.6)])

    pieces = [piece for block in in_blocks(audio, 0.7) for piece in splitter.feed(block)] + splitter.flush()

    assert len(pieces) == 2
    first, second = pieces
    assert first.start / heard_rate == pytest.approx(0.5 - 0.128, abs=0.04)
    assert first.end / heard_rate == pytest.approx(1.5 + 0.15, abs=0.04)
    assert second.start / heard_rate == pytest.approx(2.5 - 0.128, abs=0.04)
    assert second.end / heard_rate <= audio.shape[0] / heard_rate


def test_long_speech_without_a_pause_is_cut_into_pieces_that_meet() -> None:
    splitter = Splitter(loud)

    pieces = [piece for block in in_blocks(tone(45)) for piece in splitter.feed(block)] + splitter.flush()

    assert len(pieces) == 3
    assert all(piece.audio.shape[0] <= piece_seconds * heard_rate for piece in pieces)
    assert [piece.start for piece in pieces[1:]] == [piece.end for piece in pieces[:-1]]
    assert pieces[-1].end == 45 * heard_rate


def test_a_click_too_short_to_be_speech_is_left_out() -> None:
    splitter = Splitter(loud)

    assert splitter.feed(np.concatenate([quiet(1), tone(0.1), quiet(1)])) + splitter.flush() == []


def heard(start: float, seconds: float, vector: list[float] | None) -> Heard:
    return Heard(start, start + seconds, "words", None if vector is None else np.array(vector))


def test_speakers_are_named_in_order_and_the_person_by_their_voiceprint() -> None:
    pieces = [
        heard(0, 5, [1, 0, 0]),
        heard(5, 5, [0, 1, 0]),
        heard(10, 0.5, None),
        heard(11, 5, [1, 0, 0]),
        heard(16, 1.5, [0.35, 0, 0.937]),
        heard(18, 1.5, [0, 0, -1]),
    ]

    labels, speakers = label_speakers(pieces, None)

    assert labels == ["S1", "S2", "S2", "S1", "S1", "S3"]
    assert [(speaker.id, speaker.seconds) for speaker in speakers] == [("S1", 11.5), ("S2", 5.5), ("S3", 1.5)]

    yours, with_you = label_speakers(pieces, Voiceprint(np.array([0.0, 1.0, 0.0]), 0.6))

    assert yours == ["S1", "you", "you", "S1", "S1", "S2"]
    assert [(speaker.id, speaker.you) for speaker in with_you] == [("S1", False), ("you", True), ("S2", False)]


def test_a_voiceprint_that_matches_no_one_closely_enough_names_no_one_as_the_person() -> None:
    labels, _ = label_speakers([heard(0, 5, [1, 0]), heard(5, 5, [0, 1])], Voiceprint(np.array([0.7, -0.7]), 0.9))

    assert labels == ["S1", "S2"]


def test_a_conversation_comes_back_as_timed_segments_with_speakers() -> None:
    audio = np.concatenate([tone(3, 200), quiet(1), tone(2, 800), quiet(1), tone(4, 200), quiet(1)])
    told: list[float] = []

    transcript = transcribe(
        in_blocks(audio), fake_models, Voiceprint(np.array([0.0, 1.0]), 0.6), told.append, threading.Event()
    )

    assert transcript.seconds == pytest.approx(12.0)
    assert [(segment.text, segment.speaker) for segment in transcript.segments] == [
        ("A low voice.", "S1"),
        ("A high voice.", "you"),
        ("A low voice.", "S1"),
    ]
    assert transcript.segments[1].start == pytest.approx(4 - 0.128, abs=0.05)
    assert transcript.segments[0].to_json() == {"start": 0.0, "end": 3.16, "text": "A low voice.", "speaker": "S1"}
    assert [speaker.id for speaker in transcript.speakers] == ["S1", "you"]
    assert told


def test_a_cancelled_transcription_stops() -> None:
    cancelled = threading.Event()
    cancelled.set()

    with pytest.raises(CancelledError):
        transcribe(in_blocks(tone(5)), fake_models, None, lambda _: None, cancelled)


def fake_tool(folder: Path, name: str, script: str) -> None:
    tool = folder / name
    tool.write_text(f"#!{sys.executable}\nimport sys\n{script}\n")
    tool.chmod(0o755)


def test_decoding_reads_what_ffmpeg_writes_as_16_bit_samples(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    fake_tool(tmp_path, "ffmpeg", "sys.stdout.buffer.write((16384).to_bytes(2, 'little', signed=True) * 16000)")
    monkeypatch.setenv("PATH", str(tmp_path))

    samples = np.concatenate(list(decode(tmp_path / "talk.m4a")))

    assert samples.shape == (16000,)
    assert float(samples[0]) == pytest.approx(0.5)


def test_a_recording_ffmpeg_cant_read_says_why(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    said = "talk.m4a: Invalid data found when processing input"
    fake_tool(tmp_path, "ffmpeg", f"sys.stderr.write({said!r} + '\\n')\nsys.exit(1)")
    monkeypatch.setenv("PATH", str(tmp_path))

    with pytest.raises(TranscriptionError, match="Invalid data found when processing input"):
        list(decode(tmp_path / "talk.m4a"))


def test_a_box_without_ffmpeg_says_how_to_install_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PATH", str(tmp_path))

    with pytest.raises(TranscriptionError, match="sudo apt install ffmpeg"):
        list(decode(tmp_path / "talk.m4a"))
    assert probe_seconds(tmp_path / "talk.m4a") is None


@pytest.mark.skipif(shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None, reason="needs ffmpeg")
def test_a_real_stereo_recording_decodes_to_16_khz_mono(tmp_path: Path) -> None:
    steps = np.arange(44_100 * 2) / 44_100
    left = (0.3 * np.sin(2 * np.pi * 220 * steps) * 32_767).astype(np.int16)
    recording = tmp_path / "stereo.wav"
    wavfile.write(recording, 44_100, np.stack([left, left], axis=1))

    samples = np.concatenate(list(decode(recording)))

    assert samples.shape[0] == pytest.approx(2 * heard_rate, abs=200)
    assert pitch(samples) == pytest.approx(220, abs=5)
    assert probe_seconds(recording) == pytest.approx(2.0, abs=0.05)
