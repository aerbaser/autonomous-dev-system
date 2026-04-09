"""
Tests for app/services/ollama_service.py

Covers:
- health_check: Ollama running, models parsed
- health_check: connection refused → running=False, no exception
- health_check: HTTP error → running=False, no exception
- health_check: timeout → running=False, no exception
- generate: success path returns response text
- generate: connection error raises OllamaGenerationError
- generate: timeout raises OllamaGenerationError
- generate: bad JSON shape raises OllamaGenerationError
- is_model_available: found / not found / Ollama down
- get_pull_command: returns correct string
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock, patch

import httpx
import pytest

from app.services.ollama_service import (
    ModelInfo,
    OllamaGenerationError,
    OllamaService,
    OllamaStatus,
    _parse_models,
)


# ---------------------------------------------------------------------------
# Helpers / fixtures
# ---------------------------------------------------------------------------

TAGS_RESPONSE = {
    "models": [
        {"name": "gemma4:12b", "size": 8_589_934_592, "loaded": False},  # 8 GB
        {"name": "llama3:8b", "size": 4_294_967_296, "loaded": True},    # 4 GB
    ]
}


def _make_response(
    status_code: int = 200,
    body: dict | None = None,
    headers: dict | None = None,
) -> httpx.Response:
    """Build a fake httpx.Response."""
    content = json.dumps(body or {}).encode()
    return httpx.Response(
        status_code=status_code,
        content=content,
        headers=headers or {},
    )


class _MockTransport(httpx.AsyncBaseTransport):
    """Replay a predefined response or raise an exception."""

    def __init__(self, response: httpx.Response | None = None, exc: Exception | None = None):
        self._response = response
        self._exc = exc

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if self._exc is not None:
            raise self._exc
        assert self._response is not None
        return self._response


def _service_with_transport(transport: httpx.AsyncBaseTransport) -> OllamaService:
    """Return an OllamaService whose AsyncClient uses *transport*."""
    svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

    # Patch AsyncClient to inject our mock transport
    original_init = httpx.AsyncClient.__init__

    def patched_init(self_client, **kwargs):
        kwargs["transport"] = transport
        original_init(self_client, **kwargs)

    svc._patched_init = patched_init  # keep ref
    return svc


# ---------------------------------------------------------------------------
# _parse_models helper
# ---------------------------------------------------------------------------

class TestParseModels:
    def test_empty_list(self):
        assert _parse_models([]) == []

    def test_size_converted_to_gb(self):
        models = _parse_models([{"name": "foo:7b", "size": 7_516_192_768}])
        assert models[0].size_gb == round(7_516_192_768 / (1024 ** 3), 2)

    def test_loaded_flag_passed_through(self):
        models = _parse_models([{"name": "a", "size": 0, "loaded": True}])
        assert models[0].loaded is True

    def test_missing_fields_use_defaults(self):
        models = _parse_models([{}])
        assert models[0].name == ""
        assert models[0].size_gb == 0.0
        assert models[0].loaded is False


# ---------------------------------------------------------------------------
# health_check
# ---------------------------------------------------------------------------

class TestHealthCheck:
    @pytest.mark.asyncio
    async def test_running_true_on_success(self):
        transport = _MockTransport(_make_response(200, TAGS_RESPONSE))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            status = await svc.health_check()

        assert status.running is True
        assert status.error is None
        assert len(status.models) == 2
        assert status.models[0].name == "gemma4:12b"
        assert status.models[0].size_gb == round(8_589_934_592 / (1024 ** 3), 2)

    @pytest.mark.asyncio
    async def test_version_from_header(self):
        transport = _MockTransport(
            _make_response(200, TAGS_RESPONSE, headers={"x-ollama-version": "0.20.1"})
        )
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            status = await svc.health_check()

        assert status.version == "0.20.1"

    @pytest.mark.asyncio
    async def test_connection_refused_returns_not_running(self):
        transport = _MockTransport(exc=httpx.ConnectError("Connection refused"))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            status = await svc.health_check()

        assert status.running is False
        assert status.models == []
        assert status.error is not None
        assert "Connection refused" in status.error

    @pytest.mark.asyncio
    async def test_timeout_returns_not_running(self):
        transport = _MockTransport(exc=httpx.ConnectTimeout("timed out"))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            status = await svc.health_check()

        assert status.running is False
        assert status.error is not None

    @pytest.mark.asyncio
    async def test_http_error_returns_not_running(self):
        transport = _MockTransport(_make_response(500, {"error": "internal"}))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            status = await svc.health_check()

        assert status.running is False

    @pytest.mark.asyncio
    async def test_no_exception_propagated_on_connect_error(self):
        """health_check must NEVER raise — callers depend on this guarantee."""
        transport = _MockTransport(exc=httpx.ConnectError("refused"))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            # Should not raise
            result = await svc.health_check()

        assert isinstance(result, OllamaStatus)


# ---------------------------------------------------------------------------
# generate
# ---------------------------------------------------------------------------

class TestGenerate:
    @pytest.mark.asyncio
    async def test_returns_response_field(self):
        body = {"model": "gemma4:12b", "response": "Hello, world!", "done": True}
        transport = _MockTransport(_make_response(200, body))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            text = await svc.generate("Say hello")

        assert text == "Hello, world!"

    @pytest.mark.asyncio
    async def test_system_prompt_included_in_payload(self):
        """Verify system_prompt is forwarded to Ollama."""
        captured: list[httpx.Request] = []

        class CapturingTransport(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
                captured.append(request)
                body = {"response": "ok", "done": True}
                return httpx.Response(200, content=json.dumps(body).encode())

        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")
        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=CapturingTransport())):
            await svc.generate("prompt", system_prompt="Be concise.")

        payload = json.loads(captured[0].content)
        assert payload["system"] == "Be concise."
        assert payload["stream"] is False

    @pytest.mark.asyncio
    async def test_no_system_prompt_key_when_none(self):
        captured: list[httpx.Request] = []

        class CapturingTransport(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
                captured.append(request)
                return httpx.Response(200, content=json.dumps({"response": "x"}).encode())

        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")
        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=CapturingTransport())):
            await svc.generate("prompt", system_prompt=None)

        payload = json.loads(captured[0].content)
        assert "system" not in payload

    @pytest.mark.asyncio
    async def test_connect_error_raises_generation_error(self):
        transport = _MockTransport(exc=httpx.ConnectError("refused"))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            with pytest.raises(OllamaGenerationError, match="Cannot connect"):
                await svc.generate("hello")

    @pytest.mark.asyncio
    async def test_timeout_raises_generation_error(self):
        transport = _MockTransport(exc=httpx.ReadTimeout("timeout"))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            with pytest.raises(OllamaGenerationError):
                await svc.generate("hello")

    @pytest.mark.asyncio
    async def test_missing_response_field_raises_generation_error(self):
        body = {"done": True}  # no "response" key
        transport = _MockTransport(_make_response(200, body))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            with pytest.raises(OllamaGenerationError, match="Unexpected response shape"):
                await svc.generate("hello")

    @pytest.mark.asyncio
    async def test_http_error_raises_generation_error(self):
        transport = _MockTransport(_make_response(404, {"error": "not found"}))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            with pytest.raises(OllamaGenerationError, match="HTTP 404"):
                await svc.generate("hello")

    @pytest.mark.asyncio
    async def test_options_forwarded(self):
        captured: list[httpx.Request] = []

        class CapturingTransport(httpx.AsyncBaseTransport):
            async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
                captured.append(request)
                return httpx.Response(200, content=json.dumps({"response": "x"}).encode())

        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")
        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=CapturingTransport())):
            await svc.generate("prompt", temperature=0.3, max_tokens=512)

        payload = json.loads(captured[0].content)
        assert payload["options"]["temperature"] == 0.3
        assert payload["options"]["num_predict"] == 512


# ---------------------------------------------------------------------------
# is_model_available
# ---------------------------------------------------------------------------

class TestIsModelAvailable:
    @pytest.mark.asyncio
    async def test_returns_true_when_model_present(self):
        transport = _MockTransport(_make_response(200, TAGS_RESPONSE))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            assert await svc.is_model_available("gemma4:12b") is True

    @pytest.mark.asyncio
    async def test_returns_false_when_model_absent(self):
        transport = _MockTransport(_make_response(200, TAGS_RESPONSE))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            assert await svc.is_model_available("mistral:7b") is False

    @pytest.mark.asyncio
    async def test_returns_false_when_ollama_down(self):
        transport = _MockTransport(exc=httpx.ConnectError("refused"))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            assert await svc.is_model_available("gemma4:12b") is False

    @pytest.mark.asyncio
    async def test_partial_name_match(self):
        """'gemma4' without tag should match 'gemma4:12b'."""
        transport = _MockTransport(_make_response(200, TAGS_RESPONSE))
        svc = OllamaService(base_url="http://localhost:11434", model="gemma4:12b")

        with patch("httpx.AsyncClient", lambda **kw: httpx.AsyncClient(transport=transport)):
            assert await svc.is_model_available("gemma4") is True


# ---------------------------------------------------------------------------
# get_pull_command
# ---------------------------------------------------------------------------

class TestGetPullCommand:
    def test_returns_correct_command(self):
        svc = OllamaService()
        assert svc.get_pull_command("gemma4:e4b") == "ollama pull gemma4:e4b"

    def test_different_model_name(self):
        svc = OllamaService()
        assert svc.get_pull_command("llama3:8b") == "ollama pull llama3:8b"
