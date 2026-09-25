/**
 * Shop settings: what may be set, what is recorded, and what a colour may be.
 *
 * These are the three decisions in the settings surface that are worth pinning
 * down exhaustively, and none of them needs a database. The transaction that
 * uses them is covered by tests/integration/tenant_settings.test.ts.
 */
import { describe, expect, test } from "vitest";
import {
  AUDITABLE_SETTINGS_FIELDS,
  EMPTY_CONTACT,
  pick_branding,
  pick_contact,
  to_snapshot,
  update_settings_request,
  type TenantSettings,
  type UpdateSettingsRequest,
} from "../../src/modules/tenant/tenant_settings_dto.js";

const parse = (input: unknown) => update_settings_request.safeParse(input);

function settings(overrides: Partial<TenantSettings> = {}): TenantSettings {
  return {
    display_name: "Sharma Jewellers",
    tagline: "Trusted since 1985",
    accent_color: "#8a6516",
    has_logo: false,
    contact: {
      ...EMPTY_CONTACT,
      phone: "+919820000000",
      city: "Mumbai",
      address_line1: "12 Zaveri Bazaar",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The accent colour reaches a style attribute on a public page
// ---------------------------------------------------------------------------

describe("accent colour", () => {
  test.each([
    ["six digits", "#8a6516"],
    ["three digits", "#fff"],
    ["upper case", "#8A6516"],
  ])("Accent_%s_isAccepted", (_label, accent_color) => {
    expect(parse({ accent_color }).success).toBe(true);
  });

  /**
   * Each of these is a way to get something other than a colour into a style
   * attribute. The frontend sanitises too, but a value that reached the
   * database could be read by a consumer that forgets to.
   */
  test.each([
    ["a remote url", "url(https://evil.test/x)"],
    ["a css variable", "var(--surface-page)"],
    ["a named colour", "red"],
    ["a second declaration", "#fff; content: 'x'"],
    ["an expression", "expression(alert(1))"],
    ["no hash", "8a6516"],
    ["four digits", "#8a65"],
    ["eight digits", "#8a6516ff"],
    ["empty", ""],
    ["whitespace padding", " #8a6516 "],
  ])("Accent_%s_isRefused", (_label, accent_color) => {
    expect(parse({ accent_color }).success).toBe(false);
  });

  /** Clearing it is legitimate: the page falls back to the default. */
  test("Accent_null_isAccepted", () => {
    expect(parse({ accent_color: null }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// What may be set at all
// ---------------------------------------------------------------------------

describe("what the schema refuses", () => {
  /**
   * Identity and status are not settings. `.strict()` makes an attempt a 422
   * rather than something silently dropped, so a caller who tries learns that
   * it did not work.
   */
  test.each([
    ["a tenant id", { tenant_id: "00000000-0000-4000-8000-000000000000" }],
    ["a status", { status: "active" }],
    ["a slug", { slug: "somebody-else" }],
    ["a pricing adjustment", { adjustment_rupees_per_gram: "50.00" }],
    ["a logo path", { logo_blob_path: "tenants/x/logo.png" }],
    ["an unknown field", { nickname: "bk" }],
  ])("Schema_%s_isRefused", (_label, input) => {
    expect(parse(input).success).toBe(false);
  });

  test("Schema_emptyObject_parses", () => {
    // Valid as a shape; the service rejects it as "no changes supplied",
    // because that is a decision about the request, not about the fields.
    expect(parse({}).success).toBe(true);
  });

  test("Schema_notAnObject_isRefused", () => {
    expect(parse("display_name=x").success).toBe(false);
    expect(parse(null).success).toBe(false);
  });
});

describe("field validation", () => {
  test.each([
    ["a name", { display_name: "Sharma Jewellers" }],
    ["a two-character name", { display_name: "BK" }],
    ["an indian mobile", { phone: "+919820000000" }],
    ["a spaced number", { phone: "+91 98200 00000" }],
    ["a hyphenated landline", { phone: "022-2345-6789" }],
    ["an email", { email: "shop@example.test" }],
    ["a pincode", { pincode: "400002" }],
    ["a cleared tagline", { tagline: null }],
    ["a flag", { show_phone: false }],
  ])("Schema_%s_isAccepted", (_label, input) => {
    expect(parse(input).success).toBe(true);
  });

  test.each([
    ["an empty name", { display_name: "" }],
    ["a one-character name", { display_name: "B" }],
    ["a cleared name", { display_name: null }],
    ["a name that is too long", { display_name: "x".repeat(121) }],
    ["a five-digit pincode", { pincode: "40000" }],
    ["a seven-digit pincode", { pincode: "4000021" }],
    ["a non-numeric pincode", { pincode: "40000a" }],
    ["a word for a phone", { phone: "call-me" }],
    ["a too-short phone", { phone: "+9198" }],
    ["a bare address for an email", { email: "not-an-email" }],
    ["a flag as a string", { show_phone: "yes" }],
    ["a tagline that is too long", { tagline: "x".repeat(161) }],
  ])("Schema_%s_isRefused", (_label, input) => {
    expect(parse(input).success).toBe(false);
  });

  /** A shop with no name is not a shop, so the field is not nullable. */
  test("Schema_displayName_isTheOnlyFieldThatCannotBeCleared", () => {
    expect(parse({ display_name: null }).success).toBe(false);

    for (const field of ["tagline", "phone", "email", "city", "pincode"]) {
      expect(parse({ [field]: null }).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

describe("mapping fields onto columns", () => {
  const empty: UpdateSettingsRequest = {};

  test("Pick_nothing_writesNothing", () => {
    expect(pick_branding(empty)).toEqual({});
    expect(pick_contact(empty)).toEqual({});
  });

  /**
   * The load-bearing case. An absent key must not become `undefined` in the
   * update object, which Prisma would treat as "no change" but which would
   * quietly become a column write if the object were ever spread into a create.
   */
  test("Pick_absentField_isNotPresentAsUndefined", () => {
    const branding = pick_branding({ display_name: "Sharma" });

    expect(Object.keys(branding)).toEqual(["display_name"]);
    expect("tagline" in branding).toBe(false);
  });

  test("Pick_null_isKeptAsAnExplicitClear", () => {
    expect(pick_contact({ phone: null })).toEqual({ phone_e164: null });
  });

  /** Request field names and column names differ; this is where they meet. */
  test("Pick_contact_usesColumnNames", () => {
    expect(
      pick_contact({
        phone: "+919820000000",
        whatsapp: "+919820000001",
        email: "shop@example.test",
      }),
    ).toEqual({
      phone_e164: "+919820000000",
      whatsapp_e164: "+919820000001",
      public_email: "shop@example.test",
    });
  });

  test("Pick_branding_takesOnlyBrandingFields", () => {
    expect(pick_branding({ display_name: "Sharma", phone: "+919820000000" })).toEqual({
      display_name: "Sharma",
    });
  });

  test("Pick_contact_takesOnlyContactFields", () => {
    expect(pick_contact({ display_name: "Sharma", city: "Pune" })).toEqual({ city: "Pune" });
  });

  test("Pick_flags_arePassedThrough", () => {
    expect(
      pick_contact({ show_phone: false, show_whatsapp: true, show_address: false }),
    ).toEqual({ show_phone: false, show_whatsapp: true, show_address: false });
  });

  /** Every settable field must reach a column, or it would silently do nothing. */
  test("Pick_everySchemaField_reachesAColumn", () => {
    const every: UpdateSettingsRequest = {
      display_name: "Sharma",
      tagline: "t",
      accent_color: "#fff",
      phone: "+919820000000",
      whatsapp: "+919820000000",
      email: "a@b.test",
      address_line1: "a",
      address_line2: "b",
      city: "c",
      state: "d",
      pincode: "400002",
      show_phone: true,
      show_whatsapp: true,
      show_address: true,
    };

    const written =
      Object.keys(pick_branding(every)).length + Object.keys(pick_contact(every)).length;

    expect(written).toBe(Object.keys(every).length);
  });
});

// ---------------------------------------------------------------------------
// The audit allowlist
// ---------------------------------------------------------------------------

describe("audit snapshots", () => {
  test("Snapshot_carriesTheAllowlistedFields", () => {
    const snapshot = to_snapshot(settings());

    expect(snapshot["display_name"]).toBe("Sharma Jewellers");
    expect(snapshot["city"]).toBe("Mumbai");
    expect(snapshot["show_phone"]).toBe(true);
  });

  /**
   * A durable, tenant-readable log does not need a street address to record
   * that premises changed; city, state and PIN code say so.
   */
  test("Snapshot_omitsTheStreetAddress", () => {
    const snapshot = to_snapshot(settings());

    expect("address_line1" in snapshot).toBe(false);
    expect("address_line2" in snapshot).toBe(false);
    expect(Object.values(snapshot)).not.toContain("12 Zaveri Bazaar");
  });

  /**
   * The allowlist is the point: a column added to `tenant_contacts` later must
   * not reach the audit log by appearing in the settings object.
   */
  test("Snapshot_unknownField_isDropped", () => {
    // Stands in for a column added to `tenant_contacts` later, which would
    // appear here without anyone revisiting the allowlist.
    const smuggled = settings();
    (smuggled.contact as unknown as Record<string, unknown>)["gstin"] = "27AAAAA0000A1Z5";

    expect("gstin" in to_snapshot(smuggled)).toBe(false);
  });

  test("Snapshot_hasNoKeysOutsideTheAllowlist", () => {
    for (const key of Object.keys(to_snapshot(settings()))) {
      expect(AUDITABLE_SETTINGS_FIELDS).toContain(key);
    }
  });

  test("Snapshot_nullsAreRecorded", () => {
    const snapshot = to_snapshot(settings({ tagline: null }));

    // Present and null, not absent: "it was cleared" is what the log is for.
    expect("tagline" in snapshot).toBe(true);
    expect(snapshot["tagline"]).toBeNull();
  });

  test("Snapshot_neverCarriesTheLogoOrInternalFlags", () => {
    expect("has_logo" in to_snapshot(settings({ has_logo: true }))).toBe(false);
  });
});

describe("empty contact", () => {
  /** A shop with no contact row shows blanks, and shows them as visible. */
  test("EmptyContact_hasNoValuesButPermitsDisplay", () => {
    expect(EMPTY_CONTACT.phone).toBeNull();
    expect(EMPTY_CONTACT.show_phone).toBe(true);
    expect(EMPTY_CONTACT.show_whatsapp).toBe(true);
    expect(EMPTY_CONTACT.show_address).toBe(true);
  });
});
