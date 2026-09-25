/**
 * Shop details.
 *
 * The behaviour worth pinning down is the diff: this form must send what
 * changed and nothing else, because the API reads an absent key as "leave it"
 * and `null` as "clear it". A form that posted every field would turn an
 * untouched blank into a deliberate erasure.
 */
import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TenantSettings } from "@bullion/contracts";
import { ApiError } from "@/lib/api";
import {
  diff,
  ShopSettingsForm,
  to_form,
  type SettingsSaveResult,
} from "@/components/dashboard/ShopSettingsForm";

function settings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    display_name: "Radhika Jewellers",
    tagline: "Trusted since 1985",
    accent_color: "#8a6516",
    has_logo: false,
    contact: {
      phone: "+919820000000",
      whatsapp: "+919820000000",
      email: "shop@radhika.test",
      address_line1: "12 Zaveri Bazaar",
      address_line2: null,
      city: "Mumbai",
      state: "Maharashtra",
      pincode: "400002",
      show_phone: true,
      show_whatsapp: true,
      show_address: true,
    },
    ...overrides,
  };
}

const saved = (s: TenantSettings): SettingsSaveResult => ({ ok: true, settings: s });

function failed(status: number, message: string, field?: string): SettingsSaveResult {
  return {
    ok: false,
    error: new ApiError(
      status,
      {
        type: "about:blank",
        title: "x",
        status,
        detail: message,
        code: "X",
        request_id: "r",
        ...(field === undefined ? {} : { errors: [{ field, message }] }),
      },
      message,
    ),
  };
}

const save_button = () => screen.getByRole("button", { name: /save shop details/i });

// ---------------------------------------------------------------------------
// The diff — tested directly, because it decides what reaches the database
// ---------------------------------------------------------------------------

describe("diff", () => {
  const before = to_form(settings());

  test("Diff_nothingChanged_isEmpty", () => {
    expect(diff(before, { ...before })).toEqual({});
  });

  test("Diff_oneField_carriesOnlyThatField", () => {
    expect(diff(before, { ...before, tagline: "Now in Dadar" })).toEqual({
      tagline: "Now in Dadar",
    });
  });

  /** An emptied box is how a shopkeeper removes a phone number. */
  test("Diff_clearedField_becomesNull", () => {
    expect(diff(before, { ...before, phone: "" })).toEqual({ phone: null });
  });

  /** Absent and null are different intentions; an untouched field sends neither. */
  test("Diff_alreadyEmptyField_staysAbsent", () => {
    expect(diff(before, { ...before, address_line2: "" })).toEqual({});
  });

  test("Diff_whitespaceOnlyEdit_isNotAChange", () => {
    expect(diff(before, { ...before, city: "  Mumbai  " })).toEqual({});
  });

  test("Diff_trimsBeforeSending", () => {
    expect(diff(before, { ...before, city: "  Pune  " })).toEqual({ city: "Pune" });
  });

  /**
   * A shop with no name is not a shop. The API refuses it too, but sending it
   * would mean a 422 where the right answer is simply not to send it.
   */
  test("Diff_emptiedName_isNeverSent", () => {
    expect(diff(before, { ...before, display_name: "" })).toEqual({});
  });

  test("Diff_toggledFlag_isSentAsABoolean", () => {
    expect(diff(before, { ...before, show_phone: false })).toEqual({ show_phone: false });
  });

  test("Diff_severalChanges_areSentTogether", () => {
    const body = diff(before, {
      ...before,
      display_name: "Radhika Gold",
      whatsapp: "",
      show_address: false,
    });

    expect(body).toEqual({
      display_name: "Radhika Gold",
      whatsapp: null,
      show_address: false,
    });
  });
});

// ---------------------------------------------------------------------------
// The form
// ---------------------------------------------------------------------------

describe("editing shop details", () => {
  test("Settings_showsTheCurrentValues", () => {
    render(<ShopSettingsForm settings={settings()} on_save={vi.fn()} />);

    expect(screen.getByLabelText(/shop name/i)).toHaveValue("Radhika Jewellers");
    expect(screen.getByLabelText(/tagline/i)).toHaveValue("Trusted since 1985");
    expect(screen.getByLabelText(/^phone$/i)).toHaveValue("+919820000000");
  });

  /** Nothing to save is not a state worth offering a button for. */
  test("Settings_unchanged_cannotSubmit", () => {
    render(<ShopSettingsForm settings={settings()} on_save={vi.fn()} />);
    expect(save_button()).toBeDisabled();
  });

  test("Settings_edited_sendsOnlyTheChangedField", async () => {
    const user = userEvent.setup();
    const on_save = vi.fn(async () => saved(settings({ tagline: "Now in Dadar" })));

    render(<ShopSettingsForm settings={settings()} on_save={on_save} />);

    const tagline = screen.getByLabelText(/tagline/i);
    await user.clear(tagline);
    await user.type(tagline, "Now in Dadar");
    await user.click(save_button());

    expect(on_save).toHaveBeenCalledWith({ tagline: "Now in Dadar" });
  });

  test("Settings_clearedPhone_sendsNull", async () => {
    const user = userEvent.setup();
    const on_save = vi.fn(async () =>
      saved(settings({ contact: { ...settings().contact, phone: null } })),
    );

    render(<ShopSettingsForm settings={settings()} on_save={on_save} />);

    await user.clear(screen.getByLabelText(/^phone$/i));
    await user.click(save_button());

    expect(on_save).toHaveBeenCalledWith({ phone: null });
  });

  test("Settings_hidingANumber_sendsTheFlag", async () => {
    const user = userEvent.setup();
    const on_save = vi.fn(async () =>
      saved(settings({ contact: { ...settings().contact, show_phone: false } })),
    );

    render(<ShopSettingsForm settings={settings()} on_save={on_save} />);

    // The first "Show on customer page" belongs to the phone field.
    await user.click(screen.getAllByLabelText(/show on customer page/i)[0]!);
    await user.click(save_button());

    expect(on_save).toHaveBeenCalledWith({ show_phone: false });
  });

  test("Settings_unsavedChanges_areFlagged", async () => {
    const user = userEvent.setup();
    render(<ShopSettingsForm settings={settings()} on_save={vi.fn()} />);

    await user.type(screen.getByLabelText(/tagline/i), "!");

    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
    expect(save_button()).toBeEnabled();
  });

  test("Settings_afterSaving_confirms", async () => {
    const user = userEvent.setup();
    const next = settings({ tagline: "Now in Dadar!" });

    render(<ShopSettingsForm settings={settings()} on_save={async () => saved(next)} />);

    await user.type(screen.getByLabelText(/tagline/i), "!");
    await user.click(save_button());

    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
    expect(screen.queryByText(/unsaved changes/i)).not.toBeInTheDocument();
  });

  /**
   * The next diff must measure against what the server stored, not what was
   * typed — otherwise a normalised value is resent forever.
   */
  test("Settings_afterSaving_reseedsFromTheServersAnswer", async () => {
    const user = userEvent.setup();
    const on_save = vi.fn(async () => saved(settings({ display_name: "Radhika Gold House" })));

    render(<ShopSettingsForm settings={settings()} on_save={on_save} />);

    const name = screen.getByLabelText(/shop name/i);
    await user.clear(name);
    await user.type(name, "radhika gold house");
    await user.click(save_button());

    await screen.findByText(/saved/i);

    // The server's spelling won, and there is nothing left to send.
    expect(name).toHaveValue("Radhika Gold House");
    expect(save_button()).toBeDisabled();
  });
});

describe("failures", () => {
  test("Settings_serverError_isShownAndEditsSurvive", async () => {
    const user = userEvent.setup();

    render(
      <ShopSettingsForm
        settings={settings()}
        on_save={async () => failed(422, "Check the highlighted fields")}
      />,
    );

    await user.type(screen.getByLabelText(/tagline/i), "!");
    await user.click(save_button());

    expect(await screen.findByRole("alert")).toHaveTextContent("Check the highlighted fields");
    // The edit is still pending, so it can be corrected and retried.
    expect(screen.getByText(/unsaved changes/i)).toBeInTheDocument();
    expect(save_button()).toBeEnabled();
  });

  test("Settings_fieldError_marksTheField", async () => {
    const user = userEvent.setup();

    render(
      <ShopSettingsForm
        settings={settings()}
        on_save={async () =>
          failed(422, "Check the highlighted fields", "accent_color")
        }
      />,
    );

    await user.type(screen.getByLabelText(/accent colour hex code/i), "x");
    await user.click(save_button());

    const field = await screen.findByLabelText(/accent colour hex code/i);
    expect(field).toHaveAttribute("aria-invalid", "true");
  });

  test("Settings_afterFailure_canRetry", async () => {
    const user = userEvent.setup();
    const on_save = vi
      .fn<(body: object) => Promise<SettingsSaveResult>>()
      .mockResolvedValueOnce(failed(500, "Something went wrong"))
      .mockResolvedValueOnce(saved(settings({ tagline: "Trusted since 1985!" })));

    render(<ShopSettingsForm settings={settings()} on_save={on_save} />);

    await user.type(screen.getByLabelText(/tagline/i), "!");
    await user.click(save_button());
    await screen.findByRole("alert");

    await user.click(save_button());

    expect(on_save).toHaveBeenCalledTimes(2);
    expect(await screen.findByText(/saved/i)).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  test("Settings_everyFieldIsLabelled", () => {
    render(<ShopSettingsForm settings={settings()} on_save={vi.fn()} />);

    for (const label of [
      /shop name/i,
      /tagline/i,
      /accent colour hex code/i,
      /pick accent colour/i,
      /^phone$/i,
      /whatsapp/i,
      /email/i,
      /address line 1/i,
      /city/i,
      /state/i,
      /PIN code/i,
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  /** A blank shop, straight from onboarding, must render without crashing. */
  test("Settings_emptyShop_rendersEveryFieldBlank", () => {
    render(
      <ShopSettingsForm
        settings={{
          display_name: "New Shop",
          tagline: null,
          accent_color: null,
          has_logo: false,
          contact: {
            phone: null,
            whatsapp: null,
            email: null,
            address_line1: null,
            address_line2: null,
            city: null,
            state: null,
            pincode: null,
            show_phone: true,
            show_whatsapp: true,
            show_address: true,
          },
        }}
        on_save={vi.fn()}
      />,
    );

    expect(screen.getByLabelText(/shop name/i)).toHaveValue("New Shop");
    expect(screen.getByLabelText(/tagline/i)).toHaveValue("");
    expect(save_button()).toBeDisabled();
  });
});
