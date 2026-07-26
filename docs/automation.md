# Automation

Set a trigger. Write a function. That is the whole model.

```ts
// plugins/acme/src/plugin.ts — the function
defineAutomation(mcp, ctx, {
  name: "acme_review_big_deal",
  description: "Open a HIPAA review when a large deal lands",
  async run(event, req) {
    const deal = event.payload as { id: string };
    await req.tx((tx) => tx`insert into acme.reviews (deal_id) values (${deal.id})`);
  },
});
```

```bash
# the trigger — configuration, not code. No deploy, per-org, changeable at runtime.
embody run automation:create \
  --when crm.deal.created \
  --if 'payload.amount > 50000' \
  --do acme_review_big_deal
```

That is it. A deal over 50,000 now opens a review.

## Two ideas hold the whole thing up

**Every trigger is an event.** The engine subscribes to `*` and matches domain events
against workflow rows. There is exactly one trigger primitive. A cron schedule is a row
that publishes an event; a webhook is an HTTP request that publishes an event; an
inbound email is a plugin that publishes an event.

The consequence worth internalising: **adding a new kind of trigger requires no change
to the automation engine.** It is an ordinary plugin publishing an event, which the SPI
has always supported. `--when` accepts any event name, including ones from plugins that
did not exist when the engine was written.

**Every action is a tool.** Dispatch goes through the same executor MCP, the CLI, and
the HTTP bridge use. So an action inherits authorization (`req.assert` still decides),
discovery (`embody tools` lists it), and — the one you will care about at 2am — direct
invocation:

```bash
# Run the action without waiting for the trigger.
embody call acme_review_big_deal --input '{"name":"manual","payload":{"id":"..."}}'
```

`--do` can also name **any** registered tool, not just a `defineAutomation` one. Use an
input map for those:

```bash
embody run automation:create --when crm.deal.created \
  --do crm_update_deal --map '{"id":"{{payload.id}}","stage":"qualified"}'
```

## The other trigger kinds

Because every trigger is an event, the other kinds are not engine features — they are
small things that publish.

### On a schedule

```bash
embody run automation:schedule --name nightly --cron '0 2 * * *' --event ops.nightly
embody run automation:create   --when ops.nightly --do acme_nightly_sync
```

A schedule row publishes `ops.nightly` at 02:00 and advances itself. Any number of
workflows can trigger on that one event, and the schedule does not know about them.
`--timezone` takes an IANA zone (default UTC). `automation:schedules` lists them with
their next fire time. An expression that cannot be parsed is rejected when you create
it, and a schedule that somehow becomes unparseable is disabled rather than retried
forever.

### From an inbound webhook

```bash
embody run automation:endpoint --name stripe --plugin billing --hook events
# -> { "token": "…", "url": "POST /hooks/…" }
```

The token **is** the tenancy: an external caller has no session, and `/hooks/stripe`
cannot say whose Stripe. It is shown once and stored only as a hash, so treat it like a
password and rotate it by deleting and recreating the endpoint. Add `--secret` and the
plugin can verify the provider's signature over the raw bytes.

A plugin serves a hook with `registerWebhooks`, and its handler's whole job is to
return events:

```ts
registerWebhooks(hooks) {
  hooks.webhook({
    name: "events",
    description: "Stripe webhook",
    handler: (req) => {
      if (!verify(req.body, req.secret, req.headers["stripe-signature"])) {
        throw new Error("Invalid signature");   // -> 400, nothing published
      }
      return { events: [{ name: "billing.invoice.paid", payload: JSON.parse(req.body) }] };
    },
  });
}
```

The route answers **202**: the events are durably recorded, not yet acted on. All of a
request's events publish in one transaction, so a sender retrying after a failure
cannot half-apply.

### From an inbound email

`@embody/email` is exactly the above, for mail:

```bash
embody run automation:endpoint --name inbox --plugin email --hook inbound
embody run automation:create --when email.message.received \
  --if 'payload.to contains support@acme.test' --do helpdesk_triage_email
```

The payload is normalised across providers, so `payload.from`, `payload.to` (an array
of bare, lowercased addresses), `payload.subject`, and `payload.text` mean the same
thing whether the mail came from Postmark, SES, or a bespoke forwarder. Test a rule
without sending real mail:

```bash
embody call email_simulate_inbound --input '{"from":"a@x.test","to":["support@acme.test"],"subject":"Help"}'
```

That plugin is worth reading as a worked example: adding an entirely new kind of
trigger required **no change to the automation engine and no change to the framework**.
It publishes an event, and everything else already worked.

## You need a worker running

Automations are driven by durable events, and events are delivered by the outbox
worker. **With no worker, nothing fires** — events pile up in `embody.outbox` and your
automation looks broken.

```bash
embody-host ./embody.config.ts --mode worker    # production: its own process
embody-host ./embody.config.ts --worker         # dev: co-located with serve
```

The worker is also what fires schedules, so a deployment with no worker has no cron
either. See [Middleware & Hooks §3](./middleware-and-hooks.md) for the delivery
guarantees.

Each subscriber has its own cursor and its own delivery rows, which is what lets two
deployables share one database without stealing each other's events — a real
configuration here, since `pnpm dev` runs exactly that.

## Conditions

Stored as a list, ANDed. An empty list matches every occurrence of the event.

```json
[{ "path": "payload.amount", "op": "gt", "value": 50000 },
 { "path": "payload.custom_fields.industry_vertical", "op": "eq", "value": "healthcare" }]
```

`--if 'payload.amount > 50000'` is sugar for one element; repeat `--if` to AND more.

| op | meaning |
| :-- | :-- |
| `eq` `ne` | equal / not equal |
| `gt` `gte` `lt` `lte` | numeric ordering |
| `in` | value is in a list |
| `contains` | array holds it, or string includes it |
| `exists` | present and not null |

`{"any_of": [...]}` as an element gives you OR for that element.

Paths read `name`, `payload`, and `at`. Numeric columns come back from Postgres as
strings (`"45000.00"`), so the ordering operators coerce — `payload.amount > 50000`
compares numbers, as you would expect, rather than comparing text.

### What the language deliberately cannot do

No arithmetic. No function calls. No nesting beyond one `any_of`. Templates substitute
a value; they never compute one.

This is a design boundary, not a backlog item. Embody's core promise is **no low-code
builder and no runtime metadata engine** ([D8](../ARCHITECTURE.md)) — real logic stays
in TypeScript, where it can be typed, tested, reviewed, and debugged. A condition
language grows into an interpreter one reasonable request at a time, and then it needs
its own debugger, and then a UI to make the debugger usable.

**If a rule cannot be said in the vocabulary above, that is the signal to write a
handler, not to extend the language.** Put the logic in `run()`, where you have all of
TypeScript, and let the trigger stay a simple one.

## Input mapping

With no `--map`, the action receives the event envelope — `{ name, payload, at }` —
which is exactly the shape `defineAutomation` declares. That is why the common case
needs no mapping at all.

With a map, each value is a template:

```json
{ "dealId": "{{payload.id}}",
  "note":   "New deal: {{payload.title}}",
  "stage":  "closed_won" }
```

- A string that is *exactly* `{{path}}` is replaced with the value, type intact —
  `{{payload.amount}}` yields the number `45000`, not `"45000"`.
- A template embedded in text is interpolated as text.
- Anything else is a literal, which is how you pass a constant.
- Objects and arrays map recursively.

## Calling something outside embody

`--do` names a registered tool, so reaching Slack or a third-party API means a plugin
registers a tool for it — typed, authorized, testable, and publishable like any other.

For the cases where writing a connector is overkill, `@embody/http` provides a generic
`http_request`. It is **not enabled by default, and that is deliberate**:

```ts
// embody.config.ts — an explicit choice, not a default
import { httpPlugin } from "@embody/http";
export default defineConfig({ plugins: [automationPlugin, httpPlugin] });
```

```bash
EMBODY_HTTP_ALLOWED_HOSTS=api.stripe.com,.hooks.slack.com
EMBODY_HTTP_SECRET_SLACK=xoxb-…
```

```bash
embody run automation:create --when crm.deal.created --do http_request \
  --map '{"url":"https://hooks.slack.com/services/XXX","method":"POST",
          "json":{"text":"New deal: {{payload.title}}"}}'
```

**Why it is opt-in.** A workflow row is data, editable at runtime by anyone with write
access to automations. A generic "make an HTTP request" tool turns that data into a
confused deputy: a row can make your server POST to `169.254.169.254` and read cloud
credentials, or reach an internal admin panel that is firewalled from the internet but
not from your app server. So:

- The allowlist lives in **deployment environment, never the database** — the database
  is precisely what an attacker who reaches the automation tools can already edit.
- Loopback, private ranges, link-local, and cloud-metadata hosts are refused even if
  allowlisted, because "allowlisted" is about intent and this is about reach.
- Redirects are not followed: an allowlisted host that 302s to the metadata endpoint
  would otherwise walk straight around the policy.
- Secrets go in headers as `{{secret:NAME}}`, resolved from the environment, so the key
  never sits in a row that ends up in logs and backups.
- An empty allowlist denies everything. A misconfigured deployment fails closed.

Note the shape: inbound, the world reaches embody by publishing an event; outbound,
embody reaches the world by calling a tool. The engine knows about neither, which is
why both directions are plugins and why this one could be added without touching it.

## Who an automation runs as

Each workflow stores `run_as_roles`, defaulting to the roles of whoever created it. The
action runs as a **system principal**: no `userId` (there is no person to attribute it
to) and `system: true`, which a handler can read from `req.principal`.

You cannot give a workflow authority you do not hold:

```bash
$ embody run automation:create --roles owner ...   # as a `member`
Error: Cannot delegate permissions you do not hold: * *. Your roles are [member].
```

Narrowing is encouraged — an owner creating a `--roles viewer` automation is the safe
direction and is allowed. The check compares *permissions*, not role names, so
de-escalation works and escalation does not.

## Seeing what happened

```bash
embody run automation:list                       # configured automations
embody run automation:runs                       # recent runs, newest first
embody run automation:runs --failed              # only failures, with the error
embody run automation:disable big-deal-review    # stop it without deleting it
```

A workflow whose conditions did not match produces **no run row**. A run log full of
"did not match" is a log nobody reads.

To check a rule before trusting it, use `automation_test` — it evaluates against a
sample event and tells you whether it matched, running as *you* rather than as the
workflow's roles:

```bash
embody call automation_test --input '{
  "name": "big-deal-review",
  "event": "crm.deal.created",
  "payload": { "id": "abc", "amount": 90000 }
}'
```

### A failed automation is not retried

The outbox retries a *delivery*, and the engine's delivery is one subscription covering
every workflow that matched an event. Retrying would replay the whole set — three
workflows that already succeeded would run again to give a fourth another chance,
turning one broken automation into duplicated side effects elsewhere.

So a failure is recorded and the engine moves on. Check `automation:runs --failed`.
Actions that need to survive a transient failure should handle it internally.

## Tenancy

Workflows are ordinary business rows: `org_id` plus RLS, like everything else. An
event only ever matches workflows belonging to the org that produced it, and one
tenant's automations are invisible to another's.
