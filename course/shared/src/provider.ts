import z from "zod";

/** The model providers a target can name and a driver can support. One
 *  definition for the suite, the database, and everything between. The
 *  Python side mirrors it as a Literal in its protocol models. */
export const PROVIDERS = ["openai", "anthropic", "gemini"] as const;
export type Provider = (typeof PROVIDERS)[number];
export const zProvider = z.enum(PROVIDERS);

export function isProvider(value: unknown): value is Provider {
  return zProvider.safeParse(value).success;
}

/** The API shape a recorded call used, as the engine names it from the
 *  request path. OpenAI is always driven over `responses`; `completions`
 *  can still appear when a driver calls that endpoint itself. */
export const WIRES = [
  "responses",
  "completions",
  "anthropic",
  "gemini",
] as const;
export type Wire = (typeof WIRES)[number];
export const zWire = z.enum(WIRES);
