import { describe, expect, test } from "vitest";
import { AppError, to_problem_body } from "../../src/platform/errors.js";

describe("AppError", () => {
  test("AppError_validation_maps422", () => {
    const error = AppError.validation("bad input", [
      { field: "adjustment_bps", message: "exceeds bounds" },
    ]);
    expect(error.status).toBe(422);
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details).toHaveLength(1);
  });

  test("AppError_unauthenticated_maps401", () => {
    expect(AppError.unauthenticated().status).toBe(401);
  });

  test("AppError_forbidden_maps403", () => {
    expect(AppError.forbidden().status).toBe(403);
  });

  test("AppError_notFound_maps404", () => {
    expect(AppError.not_found().status).toBe(404);
  });

  test("AppError_upstreamUnavailable_maps503", () => {
    expect(AppError.upstream_unavailable("provider down").status).toBe(503);
  });
});

describe("to_problem_body", () => {
  test("ToProblemBody_appError_rendersRfc9457Shape", () => {
    const body = to_problem_body(AppError.forbidden("Not permitted"), "req-1");

    expect(body).toMatchObject({
      status: 403,
      code: "FORBIDDEN",
      title: "Forbidden",
      detail: "Not permitted",
      request_id: "req-1",
    });
    expect(body.type).toContain("forbidden");
  });

  test("ToProblemBody_validationDetails_areIncluded", () => {
    const body = to_problem_body(
      AppError.validation("failed", [{ field: "slug", message: "reserved" }]),
      "req-2",
    );
    expect(body.errors).toEqual([{ field: "slug", message: "reserved" }]);
  });

  test("ToProblemBody_noDetails_omitsErrorsKey", () => {
    const body = to_problem_body(AppError.not_found(), "req-3");
    expect(body).not.toHaveProperty("errors");
  });

  /**
   * An unexpected internal failure must not leak its message, and definitely
   * not its stack. The caller gets a request ID to quote and nothing else.
   */
  test("ToProblemBody_unexpectedError_collapsesToGeneric500WithoutLeaking", () => {
    const leaky = new Error("connection string postgres://user:hunter2@db/prod");
    const body = to_problem_body(leaky, "req-4");

    expect(body.status).toBe(500);
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.detail).toBe("An unexpected error occurred");
    expect(JSON.stringify(body)).not.toContain("hunter2");
    expect(JSON.stringify(body)).not.toContain("postgres://");
  });

  test("ToProblemBody_nonErrorThrown_stillRenders500", () => {
    const body = to_problem_body("a bare string", "req-5");
    expect(body.status).toBe(500);
    expect(body.request_id).toBe("req-5");
  });

  test("ToProblemBody_alwaysCarriesRequestId", () => {
    for (const error of [AppError.not_found(), new Error("x"), null, undefined]) {
      expect(to_problem_body(error, "req-6").request_id).toBe("req-6");
    }
  });
});
