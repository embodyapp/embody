/**
 * Provider payload normalisation, without a kernel or a database.
 *
 * These pin the shape a workflow author writes conditions against — `payload.to`,
 * `payload.from`, `payload.subject` — across providers that disagree about every one
 * of them. Getting address extraction wrong is the failure that matters: a rule keyed
 * on `payload.to contains support@` silently never fires if `To` was left as
 * `"Support <support@acme.test>"`.
 */
import { describe, it, expect } from "vitest";
import { parseInbound } from "./providers.ts";
import { verifySignature } from "./plugin.ts";
import { createHmac } from "node:crypto";

describe("generic payloads", () => {
  it("normalises a plain message", () => {
    const msg = parseInbound(
      "generic",
      JSON.stringify({
        from: "Customer <customer@example.com>",
        to: ["Support <support@acme.test>"],
        subject: "Help",
        text: "please",
      }),
    );
    expect(msg).toMatchObject({
      from: "customer@example.com",
      to: ["support@acme.test"],
      subject: "Help",
      text: "please",
    });
  });

  it("splits a comma-separated recipient list and merges cc", () => {
    const msg = parseInbound(
      "generic",
      JSON.stringify({
        from: "a@x.test",
        to: "One <one@acme.test>, two@acme.test",
        cc: ["Three <three@acme.test>"],
      }),
    );
    expect(msg.to).toEqual(["one@acme.test", "two@acme.test", "three@acme.test"]);
  });

  it("lowercases addresses so a condition is not case-sensitive", () => {
    const msg = parseInbound("generic", JSON.stringify({ from: "A@X.TEST", to: ["S@ACME.TEST"] }));
    expect(msg.from).toBe("a@x.test");
    expect(msg.to).toEqual(["s@acme.test"]);
  });

  it("deduplicates a recipient that appears in both to and cc", () => {
    const msg = parseInbound(
      "generic",
      JSON.stringify({ from: "a@x.test", to: ["s@acme.test"], cc: ["s@acme.test"] }),
    );
    expect(msg.to).toEqual(["s@acme.test"]);
  });
});

describe("postmark payloads", () => {
  it("reads the Postmark shape, including attachment metadata", () => {
    const msg = parseInbound(
      "postmark",
      JSON.stringify({
        MessageID: "abc-123",
        From: "customer@example.com",
        FromFull: { Email: "customer@example.com" },
        ToFull: [{ Email: "support@acme.test" }],
        CcFull: [{ Email: "manager@acme.test" }],
        Subject: "Invoice query",
        TextBody: "hello",
        HtmlBody: "<p>hello</p>",
        OriginalRecipient: "Support@Acme.Test",
        Attachments: [{ Name: "inv.pdf", ContentType: "application/pdf", ContentLength: 1024 }],
      }),
    );
    expect(msg).toMatchObject({
      messageId: "abc-123",
      from: "customer@example.com",
      to: ["support@acme.test", "manager@acme.test"],
      subject: "Invoice query",
      deliveredTo: "support@acme.test",
    });
    // Metadata only: attachment bytes have no business travelling in an event payload.
    expect(msg.attachments).toEqual([
      { name: "inv.pdf", contentType: "application/pdf", sizeBytes: 1024 },
    ]);
  });
});

describe("ses payloads", () => {
  it("reads the SES/SNS shape", () => {
    const msg = parseInbound(
      "ses",
      JSON.stringify({
        mail: {
          messageId: "ses-1",
          source: "customer@example.com",
          destination: ["support@acme.test"],
          commonHeaders: {
            from: ["Customer <customer@example.com>"],
            to: ["support@acme.test"],
            subject: "Hi",
          },
        },
        receipt: { recipients: ["support@acme.test"] },
        content: "body text",
      }),
    );
    expect(msg).toMatchObject({
      messageId: "ses-1",
      from: "customer@example.com",
      to: ["support@acme.test"],
      subject: "Hi",
      text: "body text",
    });
  });
});

describe("rejections", () => {
  it("rejects a non-JSON body", () => {
    expect(() => parseInbound("generic", "not json")).toThrow(/not valid JSON/);
  });

  it("rejects a JSON scalar", () => {
    expect(() => parseInbound("generic", '"a string"')).toThrow(/not an object/);
  });

  it("names the likely cause when the shape does not match the provider", () => {
    // A Postmark payload sent to an endpoint configured as SES: the fields are simply
    // absent, and the error should say to check the provider setting.
    expect(() => parseInbound("ses", JSON.stringify({ From: "a@x", To: "b@y" }))).toThrow(
      /check the endpoint's provider setting/,
    );
  });
});

describe("verifySignature", () => {
  const body = '{"from":"a@x.test","to":["s@acme.test"]}';

  it("accepts a base64 HMAC of the raw body", () => {
    const sig = createHmac("sha256", "shhh").update(body).digest("base64");
    expect(verifySignature(body, "shhh", sig)).toBe(true);
  });

  it("accepts hex and the sha256= prefix", () => {
    const hex = createHmac("sha256", "shhh").update(body).digest("hex");
    expect(verifySignature(body, "shhh", hex)).toBe(true);
    expect(verifySignature(body, "shhh", `sha256=${hex}`)).toBe(true);
  });

  it("rejects a signature over re-serialised JSON", () => {
    // The classic mistake: signing JSON.stringify(JSON.parse(body)). Key order and
    // whitespace differ, so it must not verify.
    const reserialised = JSON.stringify(JSON.parse(body));
    const sig = createHmac("sha256", "shhh").update(`${reserialised} `).digest("base64");
    expect(verifySignature(body, "shhh", sig)).toBe(false);
  });

  it("rejects the wrong secret and garbage", () => {
    const sig = createHmac("sha256", "other").update(body).digest("base64");
    expect(verifySignature(body, "shhh", sig)).toBe(false);
    expect(verifySignature(body, "shhh", "")).toBe(false);
    expect(verifySignature(body, "shhh", "nonsense")).toBe(false);
  });
});
