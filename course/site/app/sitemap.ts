import { SITE_URL } from "@/src/lib/brand";
import { BENCHMARK_SUITES } from "@/src/lib/standings";
import type { MetadataRoute } from "next";

// The pages worth finding from a search. Runs and trials are reached from
// these; there are too many, and they change too often, to list.
export default function sitemap(): MetadataRoute.Sitemap {
  const paths = [
    "/",
    ...BENCHMARK_SUITES.map((name) => `/leaderboard/${name}`),
  ];
  return paths.map((p) => ({ url: new URL(p, SITE_URL).href }));
}
