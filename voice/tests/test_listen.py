from dataclasses import dataclass, field

import numpy as np

from ito_voice.audio import heard_rate
from ito_voice.listen import (
    Ears,
    Hearing,
    Listener,
    Turn,
    Voiceprint,
    echoes,
    ends_like_a_sentence,
    sounds_unfinished,
)


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
    dropped: int = 0
    voiceprints: list[Voiceprint] = field(default_factory=list)

    def hearing(self) -> Hearing:
        def barge() -> None:
            self.barges += 1

        def start() -> None:
            self.starts += 1

        def drop() -> None:
            self.dropped += 1

        return Hearing(start, self.captions.append, self.turns.append, barge, self.voiceprints.append, drop)


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


def test_a_finished_thought_ends_the_turn_after_a_pause_with_captions_on_the_way() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing())

    listener.feed(np.concatenate([quiet(0.5), tone(1.6), quiet(1.15)]))
    assert heard.turns == []
    listener.feed(quiet(0.1))

    assert heard.starts == 1
    assert [turn.text for turn in heard.turns] == ["Call the dentist tomorrow."]
    assert heard.captions[:3] == ["Call the dentist tomorrow."] * 3
    assert 1.6 * heard_rate < heard.turns[0].audio.shape[0] < 2.3 * heard_rate


def quiet_before_the_turn_ends(listener_ears: Ears) -> float:
    heard = Heard()
    listener = Listener(listener_ears, heard.hearing())
    listener.feed(tone(1.0))
    for step in range(1, 51):
        listener.feed(quiet(0.1))
        if heard.turns:
            return step / 10
    return float("inf")


def test_words_that_trail_off_hold_the_turn_open_longer() -> None:
    assert quiet_before_the_turn_ends(ears(text="Call the dentist tomorrow.")) == 1.3
    assert quiet_before_the_turn_ends(ears(text="Call the dentist tomorrow.", finished=0.2)) == 2.6
    assert quiet_before_the_turn_ends(ears(text="I'm writing a note")) == 2.6
    assert quiet_before_the_turn_ends(ears(text="Exceptional work at")) == 4.1
    assert quiet_before_the_turn_ends(ears(text="I need milk, eggs and")) == 4.1


def test_speaking_again_within_the_pause_keeps_one_turn() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing())

    listener.feed(np.concatenate([tone(1.0), quiet(1.0), tone(1.0), quiet(1.5)]))

    assert len(heard.turns) == 1


yours = Voiceprint(np.array([1.0, 0.0]), 0.6)

ari_says = "Which part of that? The voice mode or the captions?"


def test_your_voice_talking_over_ari_stops_it_once_after_600_ms_and_becomes_a_turn() -> None:
    heard = Heard()
    listener = Listener(ears(text="Wait, the captions."), heard.hearing(), voiceprint=yours)
    listener.saying(ari_says)

    listener.feed(tone(0.5))
    assert heard.barges == 0
    listener.feed(tone(1.0))
    assert heard.barges == 1
    listener.saying(None)
    listener.feed(quiet(1.5))

    assert [turn.text for turn in heard.turns] == ["Wait, the captions."]


def test_ari_s_echo_is_never_a_barge_in_or_a_turn() -> None:
    heard = Heard()
    listener = Listener(ears(text="Which part of that?"), heard.hearing(), voiceprint=yours)
    listener.saying(ari_says)

    listener.feed(np.concatenate([tone(1.5), quiet(0.6)]))
    listener.saying(None)
    listener.feed(quiet(3.0))

    assert (heard.barges, heard.turns) == (0, [])
    assert heard.dropped >= 1


def test_a_short_sound_over_ari_is_dropped_rather_than_posted() -> None:
    heard = Heard()
    listener = Listener(ears(text="Mm-hm."), heard.hearing(), voiceprint=yours)
    listener.saying(ari_says)

    listener.feed(np.concatenate([tone(0.4), quiet(0.6)]))
    listener.saying(None)
    listener.feed(quiet(3.0))

    assert (heard.barges, heard.turns, heard.dropped) == (0, [], 1)


def test_without_a_voiceprint_nothing_said_over_ari_counts() -> None:
    heard = Heard()
    listener = Listener(ears(text="Stop."), heard.hearing())
    listener.saying(ari_says)

    listener.feed(np.concatenate([tone(2.0), quiet(1.0)]))
    listener.saying(None)
    listener.feed(quiet(3.0))

    assert (heard.starts, heard.barges, heard.turns) == (0, 0, [])


def test_it_never_learns_your_voiceprint_from_turns_that_overlapped_ari() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing())

    for _ in range(25):
        listener.feed(tone(5.12))
        listener.saying(ari_says)
        listener.feed(tone(2.56))
        listener.saying(None)
        listener.feed(quiet(3.008))

    assert len(heard.turns) == 25
    assert heard.voiceprints == []


def test_with_a_voiceprint_only_your_voice_starts_a_turn() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing(), voiceprint=yours)

    listener.feed(np.concatenate([tone(2.0, hertz=900), quiet(1.5)]))
    assert heard.turns == []
    listener.feed(np.concatenate([tone(1.5), quiet(1.5)]))

    assert len(heard.turns) == 1


def test_it_learns_your_voiceprint_from_two_minutes_of_turns() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing())

    for _ in range(25):
        listener.feed(np.concatenate([tone(5.0), quiet(1.5)]))

    assert len(heard.voiceprints) == 1
    assert np.allclose(heard.voiceprints[0].vector, [1.0, 0.0])
    assert heard.voiceprints[0].threshold >= 0.45
    assert listener.voiceprint == heard.voiceprints[0]


def test_forgetting_the_voiceprint_lets_any_voice_through_until_it_relearns() -> None:
    heard = Heard()
    listener = Listener(ears(), heard.hearing(), voiceprint=Voiceprint(np.array([0.0, 1.0]), 0.6))

    listener.feed(np.concatenate([tone(1.5), quiet(1.5)]))
    assert heard.turns == []
    listener.forget()
    listener.feed(np.concatenate([tone(1.5), quiet(1.5)]))

    assert len(heard.turns) == 1
    assert listener.voiceprint is None


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
    assert sounds_unfinished("Writing for")
    assert not sounds_unfinished("Can you remind me to call the dentist tomorrow morning?")
    assert not sounds_unfinished("Let's go to Brighton.")


def test_only_words_that_end_like_a_sentence_end_a_turn_quickly() -> None:
    assert ends_like_a_sentence("Can you call him about that?")
    assert ends_like_a_sentence("Let's go to Brighton.")
    assert not ends_like_a_sentence("Exceptional work at")
    assert not ends_like_a_sentence("I'm quite happy with the call of…")
    assert not ends_like_a_sentence("So I was thinking that maybe we could,")
    assert not ends_like_a_sentence("I went there and.")
    assert not ends_like_a_sentence("Um.")


def test_words_mostly_in_what_ari_is_saying_are_its_echo() -> None:
    assert echoes("which part of that", ari_says)
    assert echoes("The voice mode", ari_says)
    assert not echoes("No, stop, I meant the walk tomorrow", ari_says)
    assert not echoes("", ari_says)
