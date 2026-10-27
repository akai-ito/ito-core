import numpy as np

from ito_voice.audio import from_pcm, heard_rate, mix, resample, spoken_rate, to_pcm


def test_pcm_round_trips_and_clips() -> None:
    samples = np.array([0, 0.5, 1.5, -1], dtype=np.float32)

    pcm = to_pcm(samples)

    assert np.frombuffer(pcm, dtype="<i2").tolist() == [0, 16_384, 32_767, -32_767]
    assert np.allclose(from_pcm(pcm), [0, 0.5, 1, -1], atol=1e-4)


def test_resampling_keeps_the_length_in_seconds() -> None:
    one_second = np.zeros(spoken_rate, dtype=np.float32)

    assert resample(one_second, spoken_rate, heard_rate).shape == (heard_rate,)


def test_mixing_puts_the_noise_that_far_below() -> None:
    speech = np.sin(np.linspace(0, 400 * np.pi, heard_rate)).astype(np.float32)
    noise = np.random.default_rng(1).standard_normal(heard_rate // 3).astype(np.float32)

    added = mix(speech, noise, 12) - speech

    assert np.isclose(10 * np.log10(np.mean(speech**2) / np.mean(added**2)), 12, atol=0.01)
