import type { BenchmarkSuite } from "./standings.ts";

/** Where the site sends people off-site: the public repo's docs. */
export const REPO_URL = "https://github.com/induction-ai/context-cup";

/** Each benchmark's own public page. */
export const BENCHMARK_SITES = {
  tau_banking: "https://taubench.com",
  toolathlon: "https://toolathlon.xyz",
} satisfies Record<BenchmarkSuite, string>;

export const DOCS = {
  entering: `${REPO_URL}#entering`,
  drivers: `${REPO_URL}/blob/main/docs/drivers.md`,
};
