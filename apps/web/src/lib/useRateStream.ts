"use client";

import { useEffect, useRef, useState } from "react";
import type { PublicRateEvent } from "@bullion/contracts";

/**
 * Subscribe to one shop's rate stream.
 *
 * The transport is `EventSource`, which `ARCHITECTURE.md` §6 picked over
 * WebSocket precisely because the browser sends nothing: it reconnects on its
 * own with backoff, survives proxies, and needs no upgrade handshake.
 *
 * ## What this hook refuses to trust
 *
 * The stream is a public endpoint, so an event is treated as untrusted input
 * even though it arrived on the shop's own channel. Every frame is parsed
 * defensively and discarded unless it has the exact shape expected — a payload
 * that is valid JSON but not a rate update (`null`, an array, a number, an
 * object missing `rate_display_paise`) must not reach React state, or a
 * customer sees `undefined` where a price should be.
 *
 * The server already strips the tenant id and refuses to relay another
 * tenant's event. This is the third layer, not the first.
 */

export type ConnectionState =
  | "connecting"
  | "open"
  /** The browser is retrying on its own; the last known rates remain on screen. */
  | "reconnecting"
  /** No stream available at all — the page falls back to its server-rendered data. */
  | "unavailable";

export interface RateStream {
  readonly state: ConnectionState;
  /** Latest update per product key. Empty until the first event arrives. */
  readonly updates: ReadonlyMap<string, PublicRateEvent>;
  /** Product keys touched by the most recent event, for the highlight. */
  readonly last_changed: readonly string[];
}

/**
 * Narrow an unknown frame to a rate update.
 *
 * Written as an explicit field-by-field check rather than a cast: a cast would
 * compile happily and put `undefined` on screen.
 */
export function parse_rate_event(raw: unknown): PublicRateEvent | null {
  if (typeof raw !== "string") return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const event = parsed as Record<string, unknown>;

  if (event["type"] !== "rate_update") return null;
  if (typeof event["product_key"] !== "string" || event["product_key"] === "") return null;
  // Money must be an integer string. A number here would mean the server sent
  // a float, which the contract forbids; dropping it is safer than rendering it.
  if (typeof event["rate_display_paise"] !== "string") return null;
  if (!/^-?\d+$/.test(event["rate_display_paise"])) return null;
  if (typeof event["display_unit"] !== "string") return null;
  if (typeof event["source_timestamp"] !== "string") return null;

  const freshness = event["freshness"];
  if (freshness !== "fresh" && freshness !== "stale" && freshness !== "expired") {
    return null;
  }

  return {
    type: "rate_update",
    product_key: event["product_key"],
    rate_display_paise: event["rate_display_paise"],
    display_unit: event["display_unit"],
    source_timestamp: event["source_timestamp"],
    freshness,
    emitted_at: typeof event["emitted_at"] === "string" ? event["emitted_at"] : "",
  };
}

export interface RateStreamOptions {
  /** Absent or null disables the stream entirely (used in tests and SSR). */
  readonly url: string | null;
  /**
   * Injectable for tests. Defaults to the platform `EventSource`, which is
   * absent during server rendering and in jsdom.
   */
  readonly create_source?: (url: string) => EventSource;
}

export function useRateStream(options: RateStreamOptions): RateStream {
  const { url, create_source } = options;

  const [state, set_state] = useState<ConnectionState>("connecting");
  const [updates, set_updates] = useState<ReadonlyMap<string, PublicRateEvent>>(new Map());
  const [last_changed, set_last_changed] = useState<readonly string[]>([]);

  // Held in a ref so the effect does not re-run when the factory identity
  // changes on a parent re-render, which would tear down a healthy connection.
  const factory = useRef(create_source);
  factory.current = create_source;

  useEffect(() => {
    if (url === null) {
      set_state("unavailable");
      return;
    }

    const make =
      factory.current ??
      (typeof EventSource === "undefined" ? null : (u: string) => new EventSource(u));

    if (make === null) {
      // No EventSource: the server-rendered rates stay, without live updates.
      set_state("unavailable");
      return;
    }

    let source: EventSource;
    try {
      source = make(url);
    } catch {
      set_state("unavailable");
      return;
    }

    let closed = false;

    source.addEventListener("open", () => {
      if (!closed) set_state("open");
    });

    source.addEventListener("rate_update", (event: Event) => {
      const parsed = parse_rate_event((event as MessageEvent).data);
      if (parsed === null) return; // Malformed frames are dropped silently.

      set_updates((previous) => {
        const next = new Map(previous);
        next.set(parsed.product_key, parsed);
        return next;
      });
      set_last_changed([parsed.product_key]);
    });

    source.addEventListener("error", () => {
      if (closed) return;
      // EventSource reconnects by itself unless it has been closed. Reporting
      // "reconnecting" rather than an error keeps the last known rates on
      // screen, which is what a customer wants to see during a blip.
      set_state(source.readyState === 2 ? "unavailable" : "reconnecting");
    });

    return () => {
      closed = true;
      source.close();
    };
  }, [url]);

  return { state, updates, last_changed };
}
