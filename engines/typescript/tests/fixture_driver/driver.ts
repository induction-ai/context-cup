import type { TypeScriptContext } from "../../src/index.ts";

export async function run(ctx: TypeScriptContext) {
  if (!ctx.first || ctx.provider.name !== "openai") {
    throw new Error("unexpected turn");
  }
  const conversation = ctx.view();
  const roles = conversation.messages.map((m) => m.role).join(",");
  if (roles !== "user,assistant,tool") throw new Error(roles);
  conversation.messages.at(-1)!.text = ctx.config.label;
  ctx.write(conversation);
  ctx.state = { seen: conversation.messages.length };
  if (process.env.FIXTURE_FAIL) throw new Error("driver failed on purpose");
  return { id: "resp_1", output: [], dropped: undefined };
}
