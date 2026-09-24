/**
 * The first screen a new shopkeeper sees.
 *
 * Before this existed, a verified account with no shop hit a 403 on every
 * endpoint and had nowhere to go. These cover the path out of that, and the
 * ways it can fail.
 */
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ApiError } from "@/lib/api";
import {
  OnboardingForm,
  slugify,
  type CreateResult,
} from "@/components/dashboard/OnboardingForm";

function created(slug: string): CreateResult {
  return { ok: true, shop: { slug, display_name: "Radhika Jewellers", products: 3 } };
}

function failed(status: number, message: string): CreateResult {
  return {
    ok: false,
    error: new ApiError(
      status,
      { type: "about:blank", title: "x", status, detail: message, code: "X", request_id: "r" },
      message,
    ),
  };
}

describe("creating a shop", () => {
  test("Onboarding_submitsTheShopName", async () => {
    const user = userEvent.setup();
    const on_create = vi.fn(async () => created("radhika-jewellers"));

    render(<OnboardingForm on_create={on_create} />);

    await user.type(screen.getByLabelText(/shop name/i), "Radhika Jewellers");
    await user.click(screen.getByRole("button", { name: /create my shop/i }));

    // No slug supplied: the server derives it.
    expect(on_create).toHaveBeenCalledWith("Radhika Jewellers", undefined);
  });

  test("Onboarding_explicitLink_isPassedThrough", async () => {
    const user = userEvent.setup();
    const on_create = vi.fn(async () => created("radhika-bk"));

    render(<OnboardingForm on_create={on_create} />);

    await user.type(screen.getByLabelText(/shop name/i), "Radhika Jewellers Pvt Ltd");
    await user.type(screen.getByLabelText(/your link/i), "radhika-bk");
    await user.click(screen.getByRole("button", { name: /create my shop/i }));

    expect(on_create).toHaveBeenCalledWith("Radhika Jewellers Pvt Ltd", "radhika-bk");
  });

  /** The URL is what they will print and share, so show it before committing. */
  test("Onboarding_previewsTheLinkAsTheyType", async () => {
    const user = userEvent.setup();
    render(<OnboardingForm on_create={vi.fn(async () => created("x"))} />);

    await user.type(screen.getByLabelText(/shop name/i), "Radhika Jewellers");

    expect(screen.getByText(/\/r\/radhika-jewellers/)).toBeInTheDocument();
  });

  test("Onboarding_explicitLink_overridesThePreview", async () => {
    const user = userEvent.setup();
    render(<OnboardingForm on_create={vi.fn(async () => created("x"))} />);

    await user.type(screen.getByLabelText(/shop name/i), "Radhika Jewellers");
    await user.type(screen.getByLabelText(/your link/i), "bk-gold");

    expect(screen.getByText(/\/r\/bk-gold/)).toBeInTheDocument();
  });

  /** An empty name cannot produce a shop, so the button stays inert. */
  test("Onboarding_withoutAName_cannotSubmit", () => {
    render(<OnboardingForm on_create={vi.fn(async () => created("x"))} />);
    expect(screen.getByRole("button", { name: /create my shop/i })).toBeDisabled();
  });

  test("Onboarding_whileCreating_disablesTheButton", async () => {
    const user = userEvent.setup();
    let release: (value: CreateResult) => void = () => {};
    const pending = new Promise<CreateResult>((resolve) => {
      release = resolve;
    });

    render(<OnboardingForm on_create={() => pending} />);

    await user.type(screen.getByLabelText(/shop name/i), "Radhika Jewellers");
    await user.click(screen.getByRole("button", { name: /create my shop/i }));

    expect(screen.getByRole("button", { name: /creating/i })).toBeDisabled();
    release(created("radhika-jewellers"));
  });
});

describe("failures", () => {
  /**
   * A repeat is almost always a double-submitted form. Telling the user to
   * reload is actionable; "409 Conflict" is not.
   */
  test("Onboarding_alreadyHasAShop_saysSoPlainly", async () => {
    const user = userEvent.setup();
    render(<OnboardingForm on_create={async () => failed(409, "This account already has a shop")} />);

    await user.type(screen.getByLabelText(/shop name/i), "Radhika Jewellers");
    await user.click(screen.getByRole("button", { name: /create my shop/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/already has a shop/i);
    expect(alert).toHaveTextContent(/reload/i);
  });

  test("Onboarding_validationFailure_showsTheServerMessage", async () => {
    const user = userEvent.setup();
    render(
      <OnboardingForm on_create={async () => failed(422, "Check the shop name and link")} />,
    );

    await user.type(screen.getByLabelText(/shop name/i), "Radhika Jewellers");
    await user.click(screen.getByRole("button", { name: /create my shop/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Check the shop name and link");
  });

  test("Onboarding_afterFailure_canRetry", async () => {
    const user = userEvent.setup();
    const on_create = vi
      .fn<(name: string, slug: string | undefined) => Promise<CreateResult>>()
      .mockResolvedValueOnce(failed(422, "Check the shop name and link"))
      .mockResolvedValueOnce(created("radhika-jewellers"));

    render(<OnboardingForm on_create={on_create} />);

    await user.type(screen.getByLabelText(/shop name/i), "Radhika Jewellers");
    await user.click(screen.getByRole("button", { name: /create my shop/i }));
    await screen.findByRole("alert");

    await user.click(screen.getByRole("button", { name: /create my shop/i }));

    expect(on_create).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("accessibility", () => {
  test("Onboarding_everyFieldIsLabelled", () => {
    render(<OnboardingForm on_create={vi.fn(async () => created("x"))} />);

    expect(screen.getByLabelText(/shop name/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/your link/i)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /set up your shop/i })).toBeInTheDocument();
  });
});

/**
 * The preview mirrors the server's rule. It is a hint, not a promise — the
 * server owns the real slug, including collision suffixes this cannot know.
 */
describe("link preview", () => {
  test.each([
    ["Sharma Jewellers", "sharma-jewellers"],
    ["Ravi & Sons", "ravi-sons"],
    ["Café Jewellers", "cafe-jewellers"],
    ["  Spaced  Out  ", "spaced-out"],
    ["Jewellers!!!", "jewellers"],
  ])("Preview_%s_becomes_%s", (name, expected) => {
    expect(slugify(name)).toBe(expected);
  });

  test("Preview_nonLatinName_yieldsNothing", () => {
    // The server refuses this too, and asks for an explicit link.
    expect(slugify("राधिका ज्वेलर्स")).toBe("");
  });
});
