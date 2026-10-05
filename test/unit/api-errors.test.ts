import { afterEach, describe, expect, it, vi } from "vitest";
import { APIError, apiErrorFrom, createApiClient, errorLink } from "../../src/lib/api.js";
import { handle } from "../../src/lib/tool-helpers.js";

const pro402 = {
  error: "INSUFFICIENT_CREDITS",
  code: "PAYMENT_REQUIRED",
  status: "trial_available",
  message: "Start your 7-day Pro trial with $5 in credits to deploy. No charge today, then $19/month.",
  subscribeUrl: "https://lizard.build/profile/account-billing?subscribe=1",
  billingUrl: "https://lizard.build/profile/account-billing",
  topupUrl: "https://lizard.build/profile/account-credits",
  balanceCents: 0,
  availableCents: 100,
};

afterEach(() => vi.unstubAllGlobals());

describe("API errors carry the platform's sentence and the page to open", () => {
  it("a 402 gives the message and the trial link, not the bare code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(pro402), { status: 402 })));
    const err = await createApiClient("liz_test").post("/api/projects/p1/apps", {}).catch((e) => e);
    expect(err).toBeInstanceOf(APIError);
    expect(err.status).toBe(402);
    expect(err.code).toBe("PAYMENT_REQUIRED");
    expect(err.message).toBe(`${pro402.message}\nStart the Pro trial: ${pro402.subscribeUrl}`);
  });

  it.each([
    ["subscription_required", `Start Pro: ${pro402.subscribeUrl}`],
    ["trial_credits_used", `Billing: ${pro402.billingUrl}`],
    ["past_due", `Billing: ${pro402.billingUrl}`],
    ["paused", `Billing: ${pro402.billingUrl}`],
    ["frozen", `Add credits: ${pro402.topupUrl}`],
    ["credits_required", `Add credits: ${pro402.topupUrl}`],
  ])("%s links the right page", (status, line) => {
    expect(apiErrorFrom(402, "Payment Required", { ...pro402, status, message: "m" }).message).toBe(`m\n${line}`);
  });

  it("reads an older server's body that has only error: INSUFFICIENT_CREDITS", () => {
    const err = apiErrorFrom(402, "Payment Required", {
      error: "INSUFFICIENT_CREDITS", status: "credits_required", message: "Add credits to keep deploying.", topupUrl: pro402.topupUrl,
    });
    expect(err.code).toBe("INSUFFICIENT_CREDITS");
    expect(err.message).toBe(`Add credits to keep deploying.\nAdd credits: ${pro402.topupUrl}`);
  });

  it("other coded billing errors keep the sentence, the code and their link", () => {
    const err = apiErrorFrom(409, "Conflict", {
      error: "CREDITS_NOT_AVAILABLE", message: "Credits are replaced by the Pro plan. Open Billing to start Pro.", billingUrl: pro402.billingUrl,
    });
    expect(err.code).toBe("CREDITS_NOT_AVAILABLE");
    expect(err.message).toBe(`Credits are replaced by the Pro plan. Open Billing to start Pro.\nBilling: ${pro402.billingUrl}`);
    expect(errorLink({ error: "UNPAID_INVOICE", invoiceUrl: "https://invoice.stripe.com/i/x" }))
      .toEqual({ label: "Pay the open invoice", url: "https://invoice.stripe.com/i/x" });
  });

  it("plain errors are unchanged", () => {
    expect(apiErrorFrom(409, "Conflict", { error: "Name already taken" }).message).toBe("Name already taken");
    expect(apiErrorFrom(400, "Bad Request", { error: "Volume too small", code: "invalid_volume_size" }))
      .toMatchObject({ message: "Volume too small", code: "invalid_volume_size" });
    expect(apiErrorFrom(502, "Bad Gateway", null).message).toBe("Bad Gateway");
    expect(errorLink({ error: "x", billingUrl: "javascript:alert(1)" })).toBeNull();
  });

  it("a tool error carries the text and the structured code, status and links", async () => {
    const tool = handle(async () => { throw apiErrorFrom(402, "Payment Required", pro402); });
    const result = await tool();
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: `${pro402.message}\nStart the Pro trial: ${pro402.subscribeUrl}` }]);
    expect(result.structuredContent).toEqual({
      error: {
        status: 402, code: "PAYMENT_REQUIRED", paymentStatus: "trial_available",
        subscribeUrl: pro402.subscribeUrl, billingUrl: pro402.billingUrl, topupUrl: pro402.topupUrl,
      },
    });
  });
});
