import asyncio
import json
import os
import sys
from collections.abc import Awaitable, Callable, Mapping
from typing import Any, BinaryIO

protocol = "0.1"
line_limit = 64 * 1024 * 1024

type Handler = Callable[[Mapping[str, Any]], Awaitable[Mapping[str, Any]]]


class LinkError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def claim_stdout() -> BinaryIO:
    link = os.fdopen(os.dup(sys.stdout.fileno()), "wb", buffering=0)
    os.dup2(sys.stderr.fileno(), sys.stdout.fileno())
    return link


class Link:
    def __init__(self, output: BinaryIO) -> None:
        self._output = output

    def _send(self, message: Mapping[str, Any]) -> None:
        self._output.write(json.dumps(message, separators=(",", ":")).encode() + b"\n")

    def notify(self, method: str, params: Mapping[str, Any]) -> None:
        self._send({"jsonrpc": "2.0", "method": method, "params": params})

    async def answer(self, handlers: Mapping[str, Handler], message: Mapping[str, Any]) -> None:
        identifier = message.get("id")
        method = message.get("method")
        handler = handlers.get(method) if isinstance(method, str) else None
        if handler is None:
            self._send({"jsonrpc": "2.0", "id": identifier, "error": {"code": -32_601, "message": f"No {method}."}})
            return
        try:
            params = message.get("params")
            result = await handler(params if isinstance(params, Mapping) else {})
            self._send({"jsonrpc": "2.0", "id": identifier, "result": result})
        except LinkError as error:
            self._send({"jsonrpc": "2.0", "id": identifier, "error": {"code": error.code, "message": error.message}})
        except Exception as error:
            self._send({"jsonrpc": "2.0", "id": identifier, "error": {"code": -32_603, "message": str(error)}})

    async def run(self, handlers: Mapping[str, Handler]) -> None:
        loop = asyncio.get_running_loop()
        reader = asyncio.StreamReader(limit=line_limit)
        await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
        answering: set[asyncio.Task[None]] = set()
        while line := await reader.readline():
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                print(f"Unreadable line from ito-core: {line[:200]!r}", file=sys.stderr)
                continue
            if not isinstance(message, dict) or "id" not in message:
                continue
            task = asyncio.create_task(self.answer(handlers, message))
            answering.add(task)
            task.add_done_callback(answering.discard)
