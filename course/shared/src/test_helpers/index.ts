// The workspace test entry: vitest primitives plus a wrapped `it` that runs
// every test body inside whatever isolation the project registers (today:
// a rolled-back database transaction from course/db).
import { it as vitestIt, type TaskCustomOptions } from "vitest";

export { type TaskCustomOptions } from "vitest";

export {
  expect,
  describe,
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  vi,
  type MockInstance,
} from "vitest";

/** Runs one test body inside whatever isolation the project needs. */
export type TestWrapper = (fn: () => Promise<void>) => Promise<void>;

let test_wrapper: TestWrapper | undefined;

/** Called from a project's vitest setup file, before any test runs. */
export function register_test_wrapper(wrapper: TestWrapper): void {
  test_wrapper = wrapper;
}

function wrappedIt(
  name: string,
  arg1?: TaskCustomOptions | (() => void | Promise<void>),
  arg2?: () => void | Promise<void>
) {
  let options: TaskCustomOptions | undefined;
  let fn: () => void | Promise<void> | undefined;
  if (typeof arg1 === "function") {
    fn = arg1;
    options = arg2 as TaskCustomOptions | undefined;
  } else {
    options = arg1;
    fn = arg2 as () => void | Promise<void> | undefined;
  }

  if (!fn) {
    // No body (e.g. it.todo()): pass straight through to vitest.
    return vitestIt(name, options);
  }

  const body = fn;
  const wrappedFn = async () => {
    if (!test_wrapper) {
      throw new Error(
        "No test wrapper registered. The project's vitest setup file must call register_test_wrapper before tests run."
      );
    }
    await test_wrapper(async () => {
      await body();
    });
  };

  return vitestIt(name, options, wrappedFn);
}

// Carry over it.only, it.skip, it.todo, it.each and friends.
Object.setPrototypeOf(wrappedIt, vitestIt);
Object.assign(wrappedIt, vitestIt);

const it = wrappedIt as typeof vitestIt;

export { it };
