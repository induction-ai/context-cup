"""Where the trial's proxy mounts each provider, shared by the runner, which
hands a driver its base URL, and the engines, which build another provider's
URL from it: `<proxy>/t/<trial>/<provider><suffix>`, the suffix being the API
version the provider's own SDK expects in a base URL."""

from __future__ import annotations

from .models import PROVIDERS, Provider, ProviderApi, ProviderInfo

PROVIDER_API: dict[Provider, tuple[str, ProviderApi]] = {
    "openai": ("/v1", "responses"),
    "anthropic": ("/v1", "messages"),
    "gemini": ("/v1beta", "generate_content"),
}


def proxy_base_url(proxy_url: str, trial_id: str, provider: Provider) -> str:
    suffix, _ = PROVIDER_API[provider]
    return f"{proxy_url.rstrip('/')}/t/{trial_id}/{provider}{suffix}"


def trial_root(info: ProviderInfo) -> str:
    """The proxy's root for this trial, `<proxy>/t/<trial>`: the run's base
    URL less its provider and version. An engine appends another provider
    and the suffix that provider's client wants."""
    root = info.client.base_url.rstrip("/")
    cut = root.rfind(f"/{info.name}")
    return root if cut < 0 else root[:cut]


def route(model: str, default: Provider) -> tuple[Provider, str]:
    """A model name and its provider. A bare name is on `default`, the run's
    provider; a name with a provider prefix (`openai/`, `anthropic/`,
    `gemini/`) picks another, still through the proxy."""
    for provider in PROVIDERS:
        if model.startswith(f"{provider}/"):
            return provider, model[len(provider) + 1 :]
    return default, model
