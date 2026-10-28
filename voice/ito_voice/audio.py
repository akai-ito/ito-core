import base64
from math import gcd

import numpy as np
from scipy.signal import resample_poly

heard_rate = 16_000
spoken_rate = 24_000


def to_pcm(samples: np.ndarray) -> bytes:
    return (np.clip(samples, -1, 1) * 32_767).round().astype("<i2").tobytes()


def from_pcm(pcm: bytes) -> np.ndarray:
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32_768


def to_base64(samples: np.ndarray) -> str:
    return base64.b64encode(to_pcm(samples)).decode("ascii")


def resample(samples: np.ndarray, rate: int, to: int) -> np.ndarray:
    common = gcd(rate, to)
    return resample_poly(samples, to // common, rate // common).astype(np.float32)


def mix(speech: np.ndarray, noise: np.ndarray, below_db: float) -> np.ndarray:
    looped = np.resize(noise, speech.shape)
    speech_power = float(np.mean(speech**2)) or 1e-9
    noise_power = float(np.mean(looped**2)) or 1e-9
    scale = np.sqrt(speech_power / noise_power / 10 ** (below_db / 10))
    return (speech + looped * scale).astype(np.float32)
