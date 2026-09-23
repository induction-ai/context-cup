"""Post a native request body through the proxy and return the provider's
response object.

This is the convenience behind `ctx.call`. A driver may use any client it
likes instead: everything reaches the provider through the same proxy, which
does the accounting.
"""

from __future__ import annotations

import copy
import random
import time
from typing import Any

import httpx

from .protocol import Payload, Provider, ProviderInfo

ANTHROPIC_VERSION = "2023-06-01"
RETRY_STATUSES = {408, 409, 429, 500, 502, 503, 504, 529}
MAX_ATTEMPTS = 5


class ProviderError(RuntimeError):
    def __init__(self, provider: Provider, status: int, body: str) -> None:
        super().__init__(f"{provider} returned HTTP {status}: {body[:2000]}")
        self.provider = provider
        self.status = status
        self.body = body


def request_for(
    provider: ProviderInfo, payload: Payload
) -> tuple[str, dict[str, str], Payload]:
    """The URL, headers, and body for one native call."""
    base = provider.client.base_url.rstrip("/")
    api = provider.client.api
    if api == "responses":
        return (
            f"{base}/responses",
            {"authorization": f"Bearer {provider.api_key}"},
            payload,
        )
    if api == "messages":
        return (
            f"{base}/messages",
            {"x-api-key": provider.api_key, "anthropic-version": ANTHROPIC_VERSION},
            payload,
        )
    model = payload.get("model")
    if not isinstance(model, str) or not model:
        raise ValueError("a generate_content payload must carry `model`")
    body = copy.copy(payload)
    del body["model"]
    return (
        f"{base}/models/{model}:generateContent",
        {"x-goog-api-key": provider.api_key},
        body,
    )


def call(
    provider: ProviderInfo,
    payload: Payload,
    *,
    purpose: str = "turn",
    timeout_sec: float = 600.0,
    client: httpx.Client | None = None,
    sleep: Any = time.sleep,
) -> Payload:
    """POST the payload and return the parsed response object, retrying
    transient failures with backoff."""
    url, headers, body = request_for(provider, payload)
    headers = {**headers, "x-cc-purpose": purpose}
    own_client = client is None
    http = client or httpx.Client(timeout=timeout_sec)
    try:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                response = http.post(url, headers=headers, json=body)
            except (httpx.TransportError, httpx.TimeoutException):
                if attempt == MAX_ATTEMPTS:
                    raise
                sleep(_backoff(attempt))
                continue
            if response.status_code in RETRY_STATUSES and attempt < MAX_ATTEMPTS:
                sleep(_backoff(attempt, response.headers.get("retry-after")))
                continue
            if response.status_code >= 400:
                raise ProviderError(provider.name, response.status_code, response.text)
            parsed = response.json()
            if not isinstance(parsed, dict):
                raise ProviderError(provider.name, response.status_code, response.text)
            return parsed
        raise AssertionError("unreachable")
    finally:
        if own_client:
            http.close()


def _backoff(attempt: int, retry_after: str | None = None) -> float:
    if retry_after:
        try:
            return min(float(retry_after), 60.0)
        except ValueError:
            pass
    return min(2.0 ** (attempt - 1), 30.0) * (0.5 + random.random())
