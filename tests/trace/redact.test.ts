import { describe, expect, it } from "vitest";
import { redact } from "../../src/trace/tracer.ts";

describe("redact", () => {
  it("hides credential fields and bearer values", () => {
    const out = redact({
      token: "a", api_key: "b", METERLESS_RUNTIME_TOKEN: "c", access_token: "d", Authorization: "Bearer xyz.abc", password: "e",
      clientSecret: "f", note: "sent Bearer abc123 to the API",
    }) as Record<string, unknown>;
    for (const k of ["token", "api_key", "METERLESS_RUNTIME_TOKEN", "access_token", "Authorization", "password", "clientSecret"]) expect(out[k]).toBe("[redacted]");
    expect(out.note).toBe("sent Bearer [redacted] to the API");
  });

  it("keeps token usage counters from Nightshift receipts", () => {
    // Field names from a real meterless.compute_receipt.v1 (2026-10-25).
    const out = redact({ usage: { input_tokens: 41, output_tokens: 4, total_tokens: 45 }, phases: [{ tokensIn: 41, tokensOut: 4 }] });
    expect(out).toEqual({ usage: { input_tokens: 41, output_tokens: 4, total_tokens: 45 }, phases: [{ tokensIn: 41, tokensOut: 4 }] });
  });
});
