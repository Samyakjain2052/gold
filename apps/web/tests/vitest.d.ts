/**
 * Registers the jest-dom matcher types with vitest's `expect`.
 *
 * Needed because `tests/setup.ts` calls `expect.extend` explicitly rather than
 * importing the `@testing-library/jest-dom/vitest` side-effect entry. That
 * entry carries these declarations with it; extending manually gains the
 * runtime matchers but not their types, so `toBeInTheDocument` type-errors
 * while passing at runtime.
 */
import type { TestingLibraryMatchers } from "@testing-library/jest-dom/matchers";

declare module "vitest" {
  interface Assertion<T = unknown> extends TestingLibraryMatchers<T, void> {}
  interface AsymmetricMatchersContaining
    extends TestingLibraryMatchers<unknown, void> {}
}
