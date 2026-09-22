# model-stats

List prices and cache thresholds for OpenAI, Anthropic, Gemini, and Fireworks
models, with a lookup API that always resolves: an unknown model id falls back
to the closest known family and says so through `matched: false`.

This package is **generated** by Induction's model pricing pipeline, which
also publishes the price pages. Prices change there; this directory is
rewritten by the export.

```ts
import { getTokenCost, resolveModel } from "@context-cup/model-stats/index.js";
```
