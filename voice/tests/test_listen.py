from dataclasses import dataclass, field

import numpy as np

from ito_voice.audio import heard_rate
from ito_voice.listen import Ears, Hearing, Listener, Turn, Voiceprint, sounds_unfinished


def tone(seconds: float, hertz: float = 200) -> np.ndarray:
    steps = np.arange(int(seconds * heard_rate)) / heard_rate
    return (0.3 * np.sin(2 * np.pi * hertz * steps)).astype(np.float32)


def quiet(seconds: float) -> np.ndarray:
    return np.zeros(int(seconds * heard_rate), dtype=np.float32)


def pitch(samples: np.ndarray) -> float:
    spectrum = np.abs(np.fft.rfft(samples))
    return float(np.fft.rfftfreq(samples.shape[0], 1 / heard_rate)[int(np.argmax(spectrum))])


@dataclass
class Heard:
    starts: int = 0
    captions: list[str] = field(default_factory=list)
    turns: list[Turn] = field(default_factory=list)
    barges: int = 0
    voiceprints: list[Voiceprint] = field(default_factory=list)

    def hearing(self) -> Hearing:
        def barge() -> None:
            self.barges += 1

        def start() -> None:
            self.starts += 1

        return Hearing(start, self.captions.append, self.turns.append, barge, self.voiceprints.append)


def ears(text: str = "Call the dentist tomorrow.", finished: float = 0.9) -> Ears:
    def voiceprint(samples: np.ndarray) -> np.ndarray:
        if float(np.sqrt(np.mean(samples**2))) < 0.01:
            return np.array([0.6, 0.8])
        return np.array([1.0, 0.0]) if pitch(samples) < 500 else np.array([0.0, 1.0])

    return Ears(
        speech=lambda chunk: 1.0 if float(np.sqrt(np.mean(chunk**2))) > 0.05 else 0.0,
        reset=lambda: None,
        finished=lambda _: finished,
        words=lambda _: text,
        voiceprint=voiceprint,
    )


def test_a_finished_thought_ends_the_turn_after_a_short_pause_with_captions_on_the_way() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing())

    listener.feed(np.concatenate([quiet(0.5), tone(1.6), quiet(0.25)]))
    assert heard.turns == []
    listener.feed(quiet(0.1))

    assert heard.starts == 1
    assert [turn.text for turn in heard.turns] == ["Call the dentist tomorrow."]
    assert heard.captions[:3] == ["Call the dentist tomorrow."] * 3
    assert 1.6 * heard_rate < heard.turns[0].audio.shape[0] < 2.3 * heard_rate


def test_it_waits_after_and_or_when_smart_turn_hears_more_coming() -> None:
    for listener_ears in [ears(text="I need milk, eggs and"), ears(finished=0.2)]:
        heard = Heard()
        listener = Listener(listener_ears, heard.hearing())

        listener.feed(np.concatenate([tone(1.0), quiet(2.5)]))
        assert heard.turns == []
        listener.feed(quiet(0.6))

        assert len(heard.turns) == 1


def test_speaking_again_within_the_pause_keeps_one_turn() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing())

    listener.feed(np.concatenate([tone(1.0), quiet(0.2), tone(1.0), quiet(0.4)]))

    assert len(heard.turns) == 1


def test_it_says_once_when_you_talk_over_ari() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing(), ari_speaking=True)

    listener.feed(tone(0.15))
    assert heard.barges == 0
    listener.feed(tone(1.0))

    assert heard.barges == 1


def test_with_a_voiceprint_only_your_voice_starts_a_turn() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing(), voiceprint=Voiceprint(np.array([1.0, 0.0]), 0.6))

    listener.feed(np.concatenate([tone(2.0, hertz=900), quiet(0.5)]))
    assert heard.turns == []
    listener.feed(np.concatenate([tone(1.5), quiet(0.5)]))

    assert len(heard.turns) == 1


def test_it_learns_your_voiceprint_from_two_minutes_of_turns() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing())

    for _ in range(25):
        listener.feed(np.concatenate([tone(5.0), quiet(0.5)]))

    assert len(heard.voiceprints) == 1
    assert np.allclose(heard.voiceprints[0].vector, [1.0, 0.0])
    assert heard.voiceprints[0].threshold >= 0.45
    assert listener.voiceprint == heard.voiceprints[0]


def test_flushing_sends_a_turn_in_progress() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing())

    listener.feed(tone(1.0))
    listener.flush()

    assert len(heard.turns) == 1


def test_trailing_words_that_promise_more() -> None:
    assert sounds_unfinished("So I was thinking that maybe we could,")
    assert sounds_unfinished("I need to pick up milk, eggs and")
    assert sounds_unfinished("The thing about the proposal is, um")
    assert not sounds_unfinished("Can you remind me to call the dentist tomorrow morning?")
    assert not sounds_unfinished("Let's go to Brighton.")
