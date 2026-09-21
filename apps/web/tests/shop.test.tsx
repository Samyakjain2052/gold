/**
 * Shop identity, the simulated-rates guard, and the API client's error mapping.
 *
 * The shop header renders tenant-controlled strings, so the questions here are
 * about what a hostile or incomplete tenant record can do to the page.
 */
import { describe, expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import type { PublicShop } from "@bullion/contracts";
import { ShopHeader, safe_accent } from "@/components/ShopHeader";
import { SimulatedBanner } from "@/components/SimulatedBanner";
import { LinkReplaced } from "@/components/LinkReplaced";
import { ApiError, public_stream_url } from "@/lib/api";

function shop(overrides: Partial<PublicShop> = {}): PublicShop {
  return {
    slug: "sharma-jewellers",
    display_name: "Sharma Jewellers",
    tagline: "Since 1974",
    logo_url: null,
    accent_color: "#8a6516",
    contact: {
      phone: null,
      whatsapp: null,
      email: null,
      address: null,
      city: null,
      state: null,
      pincode: null,
    },
    ...overrides,
  };
}

describe("shop header", () => {
  test("ShopHeader_showsNameAndTagline", () => {
    render(<ShopHeader shop={shop()} />);

    expect(screen.getByRole("heading", { name: "Sharma Jewellers" })).toBeInTheDocument();
    expect(screen.getByText("Since 1974")).toBeInTheDocument();
  });

  test("ShopHeader_withholdsContactsTheShopDidNotPublish", () => {
    render(<ShopHeader shop={shop()} />);

    expect(screen.queryByRole("link", { name: /call/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /whatsapp/i })).not.toBeInTheDocument();
  });

  test("ShopHeader_publishedPhone_isATelLink", () => {
    render(
      <ShopHeader
        shop={shop({
          contact: { ...shop().contact, phone: "+919876543210" },
        })}
      />,
    );

    const link = screen.getByRole("link", { name: /call/i });
    expect(link).toHaveAttribute("href", "tel:+919876543210");
  });

  test("ShopHeader_missingTagline_rendersNothingInItsPlace", () => {
    const { container } = render(<ShopHeader shop={shop({ tagline: null })} />);
    expect(container.textContent).not.toContain("null");
  });
});

describe("accent colour is tenant-controlled input", () => {
  test("SafeAccent_acceptsPlainHex", () => {
    expect(safe_accent("#8a6516")).toBe("#8a6516");
    expect(safe_accent("#abc")).toBe("#abc");
  });

  /**
   * The value lands in a style attribute, so anything that is not a hex colour
   * is dropped. The shop loses its colour; it cannot inject CSS.
   */
  test.each([
    ["a url", "url(https://evil.test/x)"],
    ["an expression", "red; background: url(x)"],
    ["a variable", "var(--surface-page)"],
    ["a named colour", "red"],
    ["an injection attempt", "#fff; content: 'x'"],
  ])("SafeAccent_rejects_%s", (_label, value) => {
    expect(safe_accent(value)).toBeNull();
  });

  test("ShopHeader_hostileAccent_isNotPlacedInTheStyleAttribute", () => {
    const { container } = render(
      <ShopHeader shop={shop({ accent_color: "url(https://evil.test/x)" })} />,
    );

    const header = container.firstElementChild;
    expect(header?.getAttribute("style") ?? "").not.toContain("evil.test");
  });
});

describe("simulated rates guard", () => {
  /** The one thing on this page that could cause real financial loss. */
  test("SimulatedBanner_whenSimulated_saysSoUnmissably", () => {
    render(<SimulatedBanner simulated />);

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/simulated rates/i);
    expect(alert).toHaveTextContent(/do not trade/i);
  });

  test("SimulatedBanner_whenLive_rendersNothing", () => {
    const { container } = render(<SimulatedBanner simulated={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  test("SimulatedBanner_isNotDismissible", () => {
    render(<SimulatedBanner simulated />);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("replaced link", () => {
  /**
   * A rotated link must not advertise the new one — rotation is how a shop
   * revokes a link that spread too far.
   */
  test("LinkReplaced_explainsWithoutLeakingTheNewSlug", () => {
    render(<LinkReplaced />);

    expect(screen.getByRole("status")).toHaveTextContent(/has been replaced/i);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("api client", () => {
  test("StreamUrl_encodesTheSlug", () => {
    expect(public_stream_url("sharma-jewellers")).toBe(
      "http://api.test/api/v1/public/shops/sharma-jewellers/stream",
    );
    expect(public_stream_url("a/../b")).toContain("a%2F..%2Fb");
  });

  test("ApiError_409_isRecognisedAsAConflict", () => {
    expect(new ApiError(409, null, "x").is_conflict).toBe(true);
    expect(new ApiError(422, null, "x").is_conflict).toBe(false);
  });

  test("ApiError_401_isRecognisedAsUnauthenticated", () => {
    expect(new ApiError(401, null, "x").is_unauthenticated).toBe(true);
  });

  test("ApiError_fieldErrors_areIndexedByField", () => {
    const error = new ApiError(
      422,
      {
        type: "about:blank",
        title: "Validation",
        status: 422,
        detail: "bad",
        code: "VALIDATION_ERROR",
        request_id: "r",
        errors: [{ field: "adjustment_bps", message: "too large" }, { message: "no field" }],
      },
      "bad",
    );

    expect(error.field_errors.get("adjustment_bps")).toBe("too large");
    expect(error.field_errors.size).toBe(1);
  });
});
