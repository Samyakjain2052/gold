import { afterEach, expect } from "vitest";
import { cleanup } from "@testing-library/react";
import * as matchers from "@testing-library/jest-dom/matchers";

// Extended explicitly rather than via the `@testing-library/jest-dom/vitest`
// side-effect entry: with `globals: false` that entry does not reliably reach
// this project's `expect`, and the failure mode is an unhelpful
// "Invalid Chai property: toBeInTheDocument".
expect.extend(matchers);

// Every test starts from an empty document; a leaked tree from a previous test
// makes `getByRole` ambiguous in ways that are very hard to read back.
afterEach(() => {
  cleanup();
});

// The API base URL is read at module scope by `api.ts`. Set here so tests do
// not each have to stub `process.env`.
process.env["NEXT_PUBLIC_API_BASE_URL"] = "http://api.test";
