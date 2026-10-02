import type { BenchmarkSuite } from "./standings.ts";

/** Where the site sends people off-site: the public repo's docs. */
export const REPO_URL = "https://github.com/induction-ai/context-cup";

/** Each benchmark's own public page. */
export const BENCHMARK_SITES = {
  tau_banking: "https://taubench.com",
  toolathlon: "https://toolathlon.xyz",
} satisfies Record<BenchmarkSuite, string>;

/** Where entrants get the sandboxes `--harbor_env daytona` runs tasks in. */
export const DAYTONA_URL = "https://www.daytona.io";

/** The cup's sponsors, in the order the home page lists them. */
export const SPONSORS = [
  { name: "Induction", url: "https://induction.ai" },
  { name: "Daytona", url: DAYTONA_URL },
];

export const DOCS = {
  entering: `${REPO_URL}#entering`,
  drivers: `${REPO_URL}/blob/main/docs/drivers.md`,
};
