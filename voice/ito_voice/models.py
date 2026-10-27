import logging
import os
from collections.abc import Iterator, Sequence
from dataclasses import dataclass
from typing import Any

import numpy as np
import onnxruntime as ort
import torch
from huggingface_hub import hf_hub_download

from ito_voice.audio import heard_rate
from ito_voice.espeak import use_working_espeak

kokoro_repo = "hexgrad/Kokoro-82M"
parakeet_model = "nvidia/parakeet-tdt-0.6b-v2"
voiceprint_model = "nvidia/speakerverification_en_titanet_large"
turn_repo = "pipecat-ai/smart-turn-v3"
turn_file = "smart-turn-v3.2-cpu.onnx"
turn_seconds = 8
vad_frame = 512
speech_threshold = 0.5
turn_threshold = 0.5
boost_strength = 2.0


def choose_device() -> str:
    wanted = os.environ.get("ITO_VOICE_DEVICE", "cuda")
    if wanted != "cuda":
        return wanted
    try:
        torch.cuda.init()
    except Exception as error:
        message = f"There's no NVIDIA GPU this box's PyTorch can use: {error}"
        raise RuntimeError(message) from error
    return wanted


@dataclass(frozen=True)
class Speaker:
    pipelines: dict[str, Any]


def load_speaker(device: str) -> Speaker:
    use_working_espeak()
    from kokoro import KModel, KPipeline

    model = KModel(repo_id=kokoro_repo).to(device).eval()
    pipelines = {code: KPipeline(lang_code=code, repo_id=kokoro_repo, model=model) for code in "ab"}
    if any(getattr(pipeline.g2p, "fallback", None) is None for pipeline in pipelines.values()):
        message = "espeak-ng didn't start, so Ari couldn't say names it doesn't know."
        raise RuntimeError(message)
    return Speaker(pipelines)


def speak(speaker: Speaker, text: str, voice: str) -> Iterator[np.ndarray]:
    pipeline = speaker.pipelines.get(voice[:1])
    if pipeline is None:
        message = f"There's no voice called {voice}."
        raise ValueError(message)
    for result in pipeline(text, voice=voice):
        if result.audio is not None:
            yield result.audio.numpy()


def load_recogniser(device: str) -> Any:
    from nemo.collections.asr.models import ASRModel
    from nemo.utils import logging as nemo_logging

    nemo_logging.setLevel(logging.ERROR)
    model: Any = ASRModel.from_pretrained(parakeet_model, map_location=torch.device(device))
    model.eval()
    model.preprocessor.featurizer.dither = 0.0
    model.preprocessor.featurizer.pad_to = 0
    return model


def configure_recogniser(
    model: Any, phrases: Sequence[str], strength: float = boost_strength, *, cuda_graphs: bool = True
) -> None:
    from omegaconf import open_dict

    decoding = model.cfg.decoding
    with open_dict(decoding):
        decoding.greedy.use_cuda_graph_decoder = cuda_graphs
        decoding.greedy.boosting_tree = (
            {"key_phrases_list": list(phrases), "use_triton": False, "context_score": strength, "depth_scaling": 2.0}
            if phrases
            else None
        )
        decoding.greedy.boosting_tree_alpha = 1.0 if phrases else 0.0
    model.change_decoding_strategy(decoding, verbose=False)


def warm_recogniser(model: Any) -> str | None:
    silence = np.zeros(heard_rate, dtype=np.float32)
    try:
        configure_recogniser(model, [])
        recognise(model, silence)
    except Exception as error:
        if isinstance(error, torch.cuda.OutOfMemoryError):
            raise
        configure_recogniser(model, [], cuda_graphs=False)
        recognise(model, silence)
        return (str(error).strip().splitlines() or [type(error).__name__])[0]
    return None


def recognise(model: Any, samples: np.ndarray) -> str:
    device = next(model.parameters()).device
    with torch.inference_mode():
        signal = torch.from_numpy(samples).unsqueeze(0).to(device)
        length = torch.tensor([samples.shape[0]], device=device)
        encoded, encoded_length = model.forward(input_signal=signal, input_signal_length=length)
        hypotheses = model.decoding.rnnt_decoder_predictions_tensor(
            encoder_output=encoded, encoded_lengths=encoded_length
        )
    return hypotheses[0].text


def load_voiceprints(device: str) -> Any:
    from nemo.collections.asr.models import EncDecSpeakerLabelModel

    model: Any = EncDecSpeakerLabelModel.from_pretrained(voiceprint_model, map_location=torch.device(device))
    model.eval()
    model.preprocessor.featurizer.dither = 0.0
    return model


def voiceprint(model: Any, samples: np.ndarray) -> np.ndarray:
    device = next(model.parameters()).device
    with torch.inference_mode():
        signal = torch.from_numpy(samples).unsqueeze(0).to(device)
        length = torch.tensor([samples.shape[0]], device=device)
        _, embedding = model.forward(input_signal=signal, input_signal_length=length)
    vector = embedding[0].float().cpu().numpy()
    return vector / np.linalg.norm(vector)


def load_vad() -> Any:
    from silero_vad import load_silero_vad

    return load_silero_vad(onnx=True)


def speech_probability(vad: Any, frame: np.ndarray) -> float:
    return float(vad(torch.from_numpy(frame), heard_rate).item())


@dataclass(frozen=True)
class TurnModel:
    session: ort.InferenceSession
    features: Any


def load_turn_model() -> TurnModel:
    from transformers import WhisperFeatureExtractor

    options = ort.SessionOptions()
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    options.inter_op_num_threads = 1
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(
        hf_hub_download(turn_repo, turn_file), sess_options=options, providers=["CPUExecutionProvider"]
    )
    return TurnModel(session, WhisperFeatureExtractor(chunk_length=turn_seconds))


def turn_probability(model: TurnModel, samples: np.ndarray) -> float:
    window = turn_seconds * heard_rate
    clipped = samples[-window:]
    padded = np.pad(clipped, (window - clipped.shape[0], 0))
    features = model.features(
        padded,
        sampling_rate=heard_rate,
        return_tensors="np",
        padding="max_length",
        max_length=window,
        truncation=True,
        do_normalize=True,
    ).input_features.astype(np.float32)
    outputs = model.session.run(None, {"input_features": features})
    return float(np.asarray(outputs[0]).reshape(-1)[0])
