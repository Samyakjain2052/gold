/**
 * Which products a shop quotes, and how.
 *
 * Two things matter here beyond the obvious. Each control must save on its own,
 * because a shopkeeper who flips three switches and leaves must not find that
 * none of them took. And the browser must never rescale a rate for a new
 * display unit — that is the server's job, and doing it here would be a second
 * pricing implementation.
 */
import { describe, expect, test, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TenantProduct } from "@bullion/contracts";
import { ApiError } from "@/lib/api";
import { ProductSettings, type ProductSaveResult } from "@/components/dashboard/ProductSettings";

function product(overrides: Partial<TenantProduct> = {}): TenantProduct {
  return {
    product_id: "11111111-1111-4111-8111-111111111111",
    label: "Gold 22K (916)",
    metal: "GOLD",
    purity: { num: 916, den: 1000 },
    is_enabled: true,
    display_unit: "per_10_gram",
    show_base_rate: false,
    display_order: 0,
    has_pricing_rule: true,
    ...overrides,
  };
}

const saved = (p: TenantProduct): ProductSaveResult => ({ ok: true, product: p });

const failed = (message: string): ProductSaveResult => ({
  ok: false,
  error: new ApiError(500, null, message),
});

describe("listing products", () => {
  test("Products_showsLabelAndPurity", () => {
    render(<ProductSettings products={[product()]} on_save={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Gold 22K (916)" })).toBeInTheDocument();
    expect(screen.getByText(/916\/1000/)).toBeInTheDocument();
  });

  test("Products_none_saysSo", () => {
    render(<ProductSettings products={[]} on_save={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(/no products/i);
  });

  /**
   * A product that is not quoted has no unit and no breakdown to configure, and
   * offering those controls would suggest they do something.
   */
  test("Products_notQuoted_hidesTheDisplayControls", () => {
    render(<ProductSettings products={[product({ is_enabled: false })]} on_save={vi.fn()} />);

    expect(screen.getByLabelText(/not quoting/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^quote$/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/market rate and my margin/i)).not.toBeInTheDocument();
  });

  /** Enabled but unpriced publishes nothing — a silent gap worth naming. */
  test("Products_enabledWithoutPricing_warns", () => {
    render(
      <ProductSettings products={[product({ has_pricing_rule: false })]} on_save={vi.fn()} />,
    );

    expect(screen.getByText(/no pricing set/i)).toBeInTheDocument();
  });

  test("Products_priced_doesNotWarn", () => {
    render(<ProductSettings products={[product()]} on_save={vi.fn()} />);
    expect(screen.queryByText(/no pricing set/i)).not.toBeInTheDocument();
  });
});

describe("changing a product", () => {
  test("Products_disabling_savesImmediately", async () => {
    const user = userEvent.setup();
    const on_save = vi.fn(async () => saved(product({ is_enabled: false })));

    render(<ProductSettings products={[product()]} on_save={on_save} />);

    await user.click(screen.getByLabelText(/quoting/i));

    expect(on_save).toHaveBeenCalledWith(product().product_id, { is_enabled: false });
    expect(await screen.findByText(/removed from your customer page/i)).toBeInTheDocument();
  });

  test("Products_enablingTheBreakdown_savesImmediately", async () => {
    const user = userEvent.setup();
    const on_save = vi.fn(async () => saved(product({ show_base_rate: true })));

    render(<ProductSettings products={[product()]} on_save={on_save} />);

    await user.click(screen.getByLabelText(/market rate and my margin/i));

    expect(on_save).toHaveBeenCalledWith(product().product_id, { show_base_rate: true });
    expect(
      await screen.findByText(/customers can now see the market rate/i),
    ).toBeInTheDocument();
  });

  test("Products_changingTheUnit_savesImmediately", async () => {
    const user = userEvent.setup();
    const on_save = vi.fn(async () => saved(product({ display_unit: "per_gram" })));

    render(<ProductSettings products={[product()]} on_save={on_save} />);

    await user.selectOptions(screen.getByLabelText(/^quote$/i), "per_gram");

    expect(on_save).toHaveBeenCalledWith(product().product_id, { display_unit: "per_gram" });
  });

  /**
   * The stored rate is an amount *in* the old unit, so it is recomputed by the
   * server. Saying so is what stops a shopkeeper reading the previous figure as
   * though it were in the new unit.
   */
  test("Products_unitChange_saysTheRateWasRecalculated", async () => {
    const user = userEvent.setup();

    render(
      <ProductSettings
        products={[product()]}
        on_save={async () => saved(product({ display_unit: "per_gram" }))}
      />,
    );

    await user.selectOptions(screen.getByLabelText(/^quote$/i), "per_gram");

    expect(await screen.findByText(/recalculated for the new unit/i)).toBeInTheDocument();
  });

  /** The server is the authority on what was stored, not the requested value. */
  test("Products_reflectsTheServersAnswerNotTheRequest", async () => {
    const user = userEvent.setup();

    render(
      <ProductSettings
        products={[product()]}
        // The server refused to enable it — perhaps it has no pricing rule.
        on_save={async () => saved(product({ is_enabled: false }))}
      />,
    );

    await user.click(screen.getByLabelText(/quoting/i));

    expect(await screen.findByLabelText(/not quoting/i)).toBeInTheDocument();
  });

  test("Products_saveFailure_isReportedOnThatProduct", async () => {
    const user = userEvent.setup();

    render(
      <ProductSettings products={[product()]} on_save={async () => failed("Could not save")} />,
    );

    await user.click(screen.getByLabelText(/quoting/i));

    expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
    // The switch stays where the server left it, not where the click put it.
    expect(screen.getByLabelText(/quoting/i)).toBeChecked();
  });

  test("Products_whileSaving_controlsAreDisabled", async () => {
    const user = userEvent.setup();
    let release: (value: ProductSaveResult) => void = () => {};
    const pending = new Promise<ProductSaveResult>((resolve) => {
      release = resolve;
    });

    render(<ProductSettings products={[product()]} on_save={() => pending} />);

    await user.click(screen.getByLabelText(/market rate and my margin/i));

    expect(screen.getByLabelText(/^quote$/i)).toBeDisabled();
    release(saved(product({ show_base_rate: true })));
  });
});

describe("independence", () => {
  const gold = product();
  const silver = product({
    product_id: "22222222-2222-4222-8222-222222222222",
    label: "Silver (999)",
    metal: "SILVER",
    purity: { num: 999, den: 1000 },
    display_unit: "per_kilogram",
  });

  test("Products_changingOne_doesNotTouchAnother", async () => {
    const user = userEvent.setup();
    const on_save = vi.fn(async () => saved({ ...gold, show_base_rate: true }));

    render(<ProductSettings products={[gold, silver]} on_save={on_save} />);

    const rows = screen.getAllByRole("listitem");
    await user.click(within(rows[0]!).getByLabelText(/market rate and my margin/i));

    expect(on_save).toHaveBeenCalledTimes(1);
    expect(on_save).toHaveBeenCalledWith(gold.product_id, { show_base_rate: true });
    // The silver row is untouched, including its own unit.
    expect(within(rows[1]!).getByLabelText(/^quote$/i)).toHaveValue("per_kilogram");
  });

  test("Products_failureOnOne_doesNotAffectTheOther", async () => {
    const user = userEvent.setup();

    render(
      <ProductSettings
        products={[gold, silver]}
        on_save={async () => failed("Could not save")}
      />,
    );

    const rows = screen.getAllByRole("listitem");
    await user.click(within(rows[0]!).getByLabelText(/quoting/i));

    await within(rows[0]!).findByRole("alert");
    expect(within(rows[1]!).queryByRole("alert")).not.toBeInTheDocument();
  });
});
