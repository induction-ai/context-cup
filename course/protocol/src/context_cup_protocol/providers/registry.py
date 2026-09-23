from __future__ import annotations

from .base import ProviderAdapter


def adapter_for(provider: str) -> ProviderAdapter:
    if provider == "openai":
        from .openai import OpenAIAdapter

        return OpenAIAdapter()
    if provider == "anthropic":
        from .anthropic import AnthropicAdapter

        return AnthropicAdapter()
    if provider == "gemini":
        from .gemini import GeminiAdapter

        return GeminiAdapter()
    raise ValueError(f"unknown provider {provider!r}")
