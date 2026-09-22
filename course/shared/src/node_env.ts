import z from "zod";

export const NODE_ENVS = ["development", "test", "production"] as const;
export type NodeEnv = (typeof NODE_ENVS)[number];

const zNodeEnv = z.enum(NODE_ENVS).default("development");

/** Parses true/false environment strings; unset or empty defaults to false. */
export const zBooleanEnv = z
  .string()
  .toLowerCase()
  .pipe(z.enum(["true", "false", ""]))
  .transform((value) => value === "true")
  .optional()
  .default(false);

export function readNodeEnv(): NodeEnv {
  return zNodeEnv.parse(process.env.NODE_ENV);
}
