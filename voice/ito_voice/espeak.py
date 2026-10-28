import ctypes
import ctypes.util

import espeakng_loader


def _loads(library: str) -> bool:
    try:
        ctypes.CDLL(library)
    except OSError:
        return False
    return True


def use_working_espeak() -> str:
    bundled = espeakng_loader.get_library_path()
    if _loads(bundled):
        return bundled
    system = ctypes.util.find_library("espeak-ng")
    if system is None or not _loads(system):
        message = "espeak-ng doesn't load on this box, so Ari couldn't say names: install it (apt install espeak-ng)."
        raise RuntimeError(message)
    espeakng_loader.get_library_path = lambda: system
    espeakng_loader.get_data_path = lambda: None
    return system
