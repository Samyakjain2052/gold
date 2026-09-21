/**
 * The pricing form's failure paths.
 *
 * A shopkeeper changing a rate needs to know three things without ambiguity:
 * that it saved, that a field was rejected and why, and — most importantly —
 * that someone else got there first and their own change did *not* apply.
 */
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { PricingRule } from "@bullion/contracts";
import { ApiError } from "@/lib/api";
import { PricingRuleEditor, type SaveResult } from "@/components/dashboard/PricingRuleEditor";

function rule(overrides: Partial<PricingRule> = {}): PricingRule {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    product_id: "22222222-2222-4222-8222-222222222222",
    product_label: "Gold 22K",
    metal: "GOLD",
    purity: { num: 916, den: 1000 },
    adjustment_kind: "absolute",
    adjustment_rupees_per_gram: "50.00",
    adjustment_bps: null,
    rounding_step_paise: 100,
    rounding_mode: "half_up",
    component_precision_paise: 1,
    is_active: true,
    version: 3,
    created_at: "2026-09-20T10:00:00.000Z",
    updated_at: "2026-09-20T11:00:00.000Z",
    ...overrides,
  };
}

function problem(status: number, detail: string, errors?: { field?: string; message: string }[]) {
  return new ApiError(
    status,
    {
      type: "about:blank",
      title: "Error",
      status,
      detail,
      code: "X",
      request_id: "r",
      ...(errors === undefined ? {} : { errors }),
    },
    detail,
  );
}

describe("saving", () => {
  test("Editor_showsCurrentConfiguredAdjustment", () => {
    render(<PricingRuleEditor rule={rule()} on_save={vi.fn()} on_reload={vi.fn()} />);

    expect(screen.getByLabelText(/rupees per gram/i)).toHaveValue("50.00");
    expect(screen.getByRole("heading", { name: "Gold 22K" })).toBeInTheDocument();
  });

  /** The version the user was looking at must be quoted back, not assumed. */
  test("Editor_save_sendsTheVersionItRendered", async () => {
    const user = userEvent.setup();
    const on_save = vi.fn<(...args: unknown[]) => Promise<SaveResult>>(async () => ({
      ok: true,
      rule: rule({ version: 4 }),
    }));

    render(<PricingRuleEditor rule={rule()} on_save={on_save} on_reload={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(on_save).toHaveBeenCalledWith(
      "11111111-1111-4111-8111-111111111111",
      3,
      expect.objectContaining({
        adjustment_kind: "absolute",
        adjustment_rupees_per_gram: "50.00",
      }),
    );
  });

  test("Editor_successfulSave_confirmsIt", async () => {
    const user = userEvent.setup();
    render(
      <PricingRuleEditor
        rule={rule()}
        on_save={async () => ({ ok: true, rule: rule({ version: 4 }) })}
        on_reload={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByText("Saved.")).toBeInTheDocument();
  });

  test("Editor_switchingToPercentage_sendsBasisPointsAsAnInteger", async () => {
    const user = userEvent.setup();
    const on_save = vi.fn<(...args: unknown[]) => Promise<SaveResult>>(async () => ({
      ok: true,
      rule: rule(),
    }));

    render(<PricingRuleEditor rule={rule()} on_save={on_save} on_reload={vi.fn()} />);

    await user.click(screen.getByRole("radio", { name: /percentage/i }));
    const bps = screen.getByLabelText(/basis points/i);
    await user.clear(bps);
    await user.type(bps, "250");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(on_save).toHaveBeenCalledWith(
      expect.any(String),
      3,
      expect.objectContaining({ adjustment_kind: "percentage", adjustment_bps: 250 }),
    );
  });
});

describe("validation errors", () => {
  test("Editor_fieldError_isShownBesideTheField", async () => {
    const user = userEvent.setup();
    render(
      <PricingRuleEditor
        rule={rule()}
        on_save={async () => ({
          ok: false,
          error: problem(422, "Validation failed", [
            { field: "adjustment_rupees_per_gram", message: "must be at most 100000.00" },
          ]),
        })}
        on_reload={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    expect(await screen.findByText(/at most 100000.00/)).toBeInTheDocument();
    expect(screen.getByLabelText(/rupees per gram/i)).toHaveAttribute("aria-invalid", "true");
  });

  test("Editor_generalError_isAnnouncedAsAnAlert", async () => {
    const user = userEvent.setup();
    render(
      <PricingRuleEditor
        rule={rule()}
        on_save={async () => ({ ok: false, error: problem(500, "Something broke") })}
        on_reload={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something broke");
  });
});

describe("concurrency conflict", () => {
  /**
   * The message must make clear the user's change did NOT apply, and that the
   * other person's did. "Conflict" alone leaves them guessing which won.
   */
  test("Editor_409_explainsThatTheChangeWasNotSaved", async () => {
    const user = userEvent.setup();
    render(
      <PricingRuleEditor
        rule={rule()}
        on_save={async () => ({ ok: false, error: problem(409, "Version mismatch") })}
        on_reload={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/someone else changed this rate/i);
    expect(alert).toHaveTextContent(/was not saved/i);
  });

  test("Editor_409_offersAReloadRatherThanRetrying", async () => {
    const user = userEvent.setup();
    const on_reload = vi.fn();

    render(
      <PricingRuleEditor
        rule={rule()}
        on_save={async () => ({ ok: false, error: problem(409, "Version mismatch") })}
        on_reload={on_reload}
      />,
    );

    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await user.click(await screen.findByRole("button", { name: /reload current values/i }));

    expect(on_reload).toHaveBeenCalledTimes(1);
  });

  /** A conflict must never be silently retried over the other person's change. */
  test("Editor_409_doesNotResubmitByItself", async () => {
    const user = userEvent.setup();
    const on_save = vi.fn<(...args: unknown[]) => Promise<SaveResult>>(async () => ({
      ok: false,
      error: problem(409, "Version mismatch"),
    }));

    render(<PricingRuleEditor rule={rule()} on_save={on_save} on_reload={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: /save changes/i }));
    await screen.findByRole("alert");

    expect(on_save).toHaveBeenCalledTimes(1);
  });
});

describe("accessibility", () => {
  test("Editor_everyControlHasALabel", () => {
    render(<PricingRuleEditor rule={rule()} on_save={vi.fn()} on_reload={vi.fn()} />);

    expect(screen.getByLabelText(/rupees per gram/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/round to/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/rounding rule/i)).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: /adjustment type/i })).toBeInTheDocument();
  });

  test("Editor_savingState_disablesTheButtonAndSaysSo", async () => {
    const user = userEvent.setup();
    let release: (value: SaveResult) => void = () => {};
    const pending = new Promise<SaveResult>((resolve) => {
      release = resolve;
    });

    render(
      <PricingRuleEditor rule={rule()} on_save={() => pending} on_reload={vi.fn()} />,
    );

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    const button = screen.getByRole("button", { name: /saving/i });
    expect(button).toBeDisabled();

    release({ ok: true, rule: rule({ version: 4 }) });
  });
});
