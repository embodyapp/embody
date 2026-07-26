/**
 * Inbound-mail provider payloads, normalised.
 *
 * Every provider posts a different JSON shape for the same thing. Keeping the parsing
 * here — pure functions over a parsed body, no I/O, no kernel — means a new provider is
 * one function and a table entry, and the normalisation is unit-testable without a
 * database or an HTTP server.
 */

/** What a workflow's conditions and templates see as `payload`. */
export interface InboundMessage {
  /** Provider's message id, when it supplies one. Useful for idempotency. */
  messageId?: string;
  from: string;
  /** Every recipient address across To, Cc, and Bcc, lowercased. */
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Attachment metadata only. Contents are deliberately not carried in an event. */
  attachments: { name: string; contentType: string; sizeBytes: number }[];
  /** The address the provider delivered to, when it distinguishes one. */
  deliveredTo?: string;
}

export type ProviderName = "postmark" | "ses" | "generic";

function lower(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

/**
 * Split one textual field into bare addresses.
 *
 * `"Support <support@acme.test>, ops@acme.test"` -> both addresses, lowercased and
 * stripped of display names. This has to run on array *elements* too, not only on
 * comma-joined strings: providers vary, and a `to` of `["Support <s@acme.test>"]`
 * left unstripped makes `payload.to contains support@acme.test` silently never match.
 */
function splitAddresses(value: string): string[] {
  return value
    .split(",")
    .map((part) => {
      const angled = /<([^>]+)>/.exec(part);
      return lower(angled ? angled[1] : part);
    })
    .filter(Boolean);
}

function addresses(...values: unknown[]): string[] {
  const out = new Set<string>();
  for (const value of values) {
    if (typeof value === "string") {
      for (const addr of splitAddresses(value)) out.add(addr);
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          for (const addr of splitAddresses(item)) out.add(addr);
        } else if (item && typeof item === "object") {
          const rec = item as Record<string, unknown>;
          const addr = lower(rec.Email ?? rec.email ?? rec.address);
          if (addr) out.add(addr);
        }
      }
    }
  }
  return [...out].filter(Boolean);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Postmark's inbound webhook. */
function parsePostmark(body: Record<string, unknown>): InboundMessage {
  const raw = (body.Attachments ?? []) as Record<string, unknown>[];
  return {
    messageId: str(body.MessageID) || undefined,
    from: lower(body.From ?? (body.FromFull as Record<string, unknown>)?.Email),
    to: addresses(body.To, body.ToFull, body.Cc, body.CcFull, body.Bcc, body.BccFull),
    subject: str(body.Subject),
    text: str(body.TextBody),
    html: str(body.HtmlBody) || undefined,
    deliveredTo: lower(body.OriginalRecipient) || undefined,
    attachments: raw.map((a) => ({
      name: str(a.Name),
      contentType: str(a.ContentType),
      sizeBytes: typeof a.ContentLength === "number" ? a.ContentLength : 0,
    })),
  };
}

/** SES via SNS: the mail metadata plus whatever content was included. */
function parseSes(body: Record<string, unknown>): InboundMessage {
  const mail = (body.mail ?? {}) as Record<string, unknown>;
  const common = (mail.commonHeaders ?? {}) as Record<string, unknown>;
  const receipt = (body.receipt ?? {}) as Record<string, unknown>;
  return {
    messageId: str(mail.messageId) || undefined,
    from: addresses(common.from, mail.source)[0] ?? "",
    to: addresses(common.to, common.cc, mail.destination, receipt.recipients),
    subject: str(common.subject),
    text: str(body.content),
    attachments: [],
  };
}

/**
 * A plain shape, for providers not listed above and for testing. Accepts the field
 * names most services already use, so a bespoke forwarder usually needs no adapter.
 */
function parseGeneric(body: Record<string, unknown>): InboundMessage {
  const raw = (body.attachments ?? []) as Record<string, unknown>[];
  return {
    messageId: str(body.messageId ?? body.message_id) || undefined,
    from: addresses(body.from)[0] ?? "",
    to: addresses(body.to, body.cc, body.bcc),
    subject: str(body.subject),
    text: str(body.text ?? body.body),
    html: str(body.html) || undefined,
    attachments: Array.isArray(raw)
      ? raw.map((a) => ({
          name: str(a.name ?? a.filename),
          contentType: str(a.contentType ?? a.content_type),
          sizeBytes: typeof a.sizeBytes === "number" ? a.sizeBytes : 0,
        }))
      : [],
  };
}

const PARSERS: Record<ProviderName, (body: Record<string, unknown>) => InboundMessage> = {
  postmark: parsePostmark,
  ses: parseSes,
  generic: parseGeneric,
};

export function parseInbound(provider: ProviderName, rawBody: string): InboundMessage {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    throw new Error("Inbound mail payload is not valid JSON");
  }
  if (!body || typeof body !== "object") {
    throw new Error("Inbound mail payload is not an object");
  }
  const message = PARSERS[provider](body as Record<string, unknown>);
  if (!message.from && message.to.length === 0) {
    throw new Error(
      `Could not read sender or recipients from a "${provider}" payload — ` +
        `check the endpoint's provider setting.`,
    );
  }
  return message;
}
