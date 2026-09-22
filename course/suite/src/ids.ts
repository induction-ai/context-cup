import { customAlphabet } from "nanoid";

const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
const random = customAlphabet(alphabet, 10);

/** `s_…`, `j_…`, `t_…`: short lowercase ids that are safe as directory names. */
export function newId(prefix: "s" | "j" | "t"): string {
  return `${prefix}_${random()}`;
}
