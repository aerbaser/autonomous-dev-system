"""
Async HTTP client for the Ollama REST API.

Usage:
    service = OllamaService()
    status = await service.health_check()
    if status.running and await service.is_model_available(service.model):
        text = await service.generate("Summarise this email: ...")
"""

from __future__ import annotations

from dataclasses import dataclass, field

import httpx
import structlog

from app.config import settings

logger = structlog.get_logger(__name__)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------


class OllamaGenerationError(Exception):
    """Raised when text generation via Ollama fails."""


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------


@dataclass
class ModelInfo:
    name: str
    size_gb: float
    loaded: bool


@dataclass
class OllamaStatus:
    running: bool
    version: str | None
    models: list[ModelInfo] = field(default_factory=list)
    error: str | None = None


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class OllamaService:
    """Thin async wrapper around the Ollama REST API."""

    def __init__(
        self,
        base_url: str = settings.OLLAMA_HOST,
        model: str = settings.OLLAMA_MODEL,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def health_check(self) -> OllamaStatus:
        """Return Ollama running state and available models.

        Never raises — connection errors are captured and returned as
        OllamaStatus(running=False, error=...).
        """
        url = f"{self.base_url}/api/tags"
        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(url, timeout=5.0)
                response.raise_for_status()
        except (httpx.ConnectError, httpx.ConnectTimeout, ConnectionRefusedError) as exc:
            msg = f"Connection refused: {exc}"
            logger.warning("ollama_unreachable", url=url, error=msg)
            return OllamaStatus(running=False, version=None, models=[], error=msg)
        except httpx.TimeoutException as exc:
            msg = f"Connection timed out: {exc}"
            logger.warning("ollama_timeout", url=url, error=msg)
            return OllamaStatus(running=False, version=None, models=[], error=msg)
        except httpx.HTTPStatusError as exc:
            msg = f"HTTP {exc.response.status_code}: {exc.response.text}"
            logger.warning("ollama_http_error", url=url, error=msg)
            return OllamaStatus(running=False, version=None, models=[], error=msg)
        except Exception as exc:  # noqa: BLE001
            msg = f"Unexpected error: {exc}"
            logger.warning("ollama_unexpected_error", url=url, error=msg)
            return OllamaStatus(running=False, version=None, models=[], error=msg)

        data = response.json()
        version = response.headers.get("x-ollama-version") or data.get("version")
        models = _parse_models(data.get("models", []))

        logger.debug("ollama_healthy", version=version, model_count=len(models))
        return OllamaStatus(running=True, version=version, models=models)

    async def generate(
        self,
        prompt: str,
        system_prompt: str | None = None,
        temperature: float = 0.7,
        max_tokens: int = 2048,
    ) -> str:
        """Generate text from *prompt* using the configured model.

        Args:
            prompt: The user-facing prompt text.
            system_prompt: Optional system-level instruction.
            temperature: Sampling temperature (0.0–1.0).
            max_tokens: Maximum tokens to generate.

        Returns:
            Generated text string.

        Raises:
            OllamaGenerationError: On network failure, timeout, or bad response.
        """
        url = f"{self.base_url}/api/generate"
        payload: dict = {
            "model": self.model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
        }
        if system_prompt is not None:
            payload["system"] = system_prompt

        log = logger.bind(model=self.model, url=url)
        log.debug("ollama_generate_start", prompt_len=len(prompt))

        try:
            async with httpx.AsyncClient() as client:
                response = await client.post(url, json=payload, timeout=60.0)
                response.raise_for_status()
        except httpx.TimeoutException as exc:
            raise OllamaGenerationError(
                f"Generation timed out after 60 s — model may still be loading: {exc}"
            ) from exc
        except (httpx.ConnectError, httpx.ConnectTimeout, ConnectionRefusedError) as exc:
            raise OllamaGenerationError(
                f"Cannot connect to Ollama at {self.base_url}: {exc}"
            ) from exc
        except httpx.HTTPStatusError as exc:
            raise OllamaGenerationError(
                f"Ollama returned HTTP {exc.response.status_code}: {exc.response.text}"
            ) from exc
        except Exception as exc:  # noqa: BLE001
            raise OllamaGenerationError(f"Unexpected error during generation: {exc}") from exc

        try:
            body = response.json()
            text: str = body["response"]
        except (KeyError, ValueError) as exc:
            raise OllamaGenerationError(
                f"Unexpected response shape from Ollama: {response.text[:200]}"
            ) from exc

        log.debug("ollama_generate_done", response_len=len(text))
        return text

    async def is_model_available(self, model_name: str) -> bool:
        """Return True if *model_name* is present in the Ollama model list."""
        status = await self.health_check()
        if not status.running:
            return False
        return any(m.name == model_name or m.name.startswith(f"{model_name}:") for m in status.models)

    def get_pull_command(self, model_name: str) -> str:
        """Return the CLI command to pull *model_name* into Ollama."""
        return f"ollama pull {model_name}"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_models(raw: list[dict]) -> list[ModelInfo]:
    """Convert the raw /api/tags model list into ModelInfo objects."""
    result: list[ModelInfo] = []
    for entry in raw:
        name: str = entry.get("name", "")
        # size is in bytes — convert to GB
        size_bytes: int = entry.get("size", 0)
        size_gb = round(size_bytes / (1024 ** 3), 2)
        # Ollama does not expose a "loaded" flag in /api/tags;
        # /api/ps would be needed for that.  Default to False.
        loaded: bool = entry.get("loaded", False)
        result.append(ModelInfo(name=name, size_gb=size_gb, loaded=loaded))
    return result
