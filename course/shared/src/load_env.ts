import path from "node:path";
import { config } from "dotenv";
import { REPO_ROOT } from "./repo_root.ts";

export const fileEnv = config({
  path: path.join(REPO_ROOT, ".env"),
  quiet: true,
}).parsed;
