import asyncio
import io
import json
from collections.abc import Mapping
from typing import Any

from ito_voice.link import Link, LinkError


def answers(message: Mapping[str, Any]) -> dict[str, Any]:
    output = io.BytesIO()

    async def greet(params: Mapping[str, Any]) -> Mapping[str, Any]:
        return {"hello": params.get("name")}

    async def refuse(_: Mapping[str, Any]) -> Mapping[str, Any]:
        raise LinkError(-32_001, "The voice models are still loading.")

    async def break_down(_: Mapping[str, Any]) -> Mapping[str, Any]:
        message = "out of memory"
        raise RuntimeError(message)

    handlers = {"greet": greet, "refuse": refuse, "break": break_down}
    asyncio.run(Link(output).answer(handlers, message))
    return json.loads(output.getvalue())


def test_it_answers_a_request_with_its_id() -> None:
    assert answers({"id": 4, "method": "greet", "params": {"name": "ito"}}) == {
        "jsonrpc": "2.0",
        "id": 4,
        "result": {"hello": "ito"},
    }


def test_it_refuses_with_the_handler_s_code_or_an_internal_error() -> None:
    assert answers({"id": 5, "method": "refuse"})["error"] == {
        "code": -32_001,
        "message": "The voice models are still loading.",
    }
    assert answers({"id": 6, "method": "break"})["error"] == {"code": -32_603, "message": "out of memory"}
    assert answers({"id": 7, "method": "sing"})["error"] == {"code": -32_601, "message": "No sing."}


def test_notifications_carry_no_id() -> None:
    output = io.BytesIO()

    Link(output).notify("status", {"state": "ready"})

    assert json.loads(output.getvalue()) == {"jsonrpc": "2.0", "method": "status", "params": {"state": "ready"}}
