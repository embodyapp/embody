/**
 * Agent tool registry — the surface the AI copilot can act through. These mirror the embody
 * MCP tool names (`b2b_*`, `ecom_*`) and are executed against the CRM stores. Governance is
 * enforced here, not in the model: writes are denied for the `viewer` role, and deal closes
 * pass through the InfoSec veto (built into the store) plus any active customization rule
 * (HIPAA) — exactly as they would for a REST or MCP caller.
 */
import type { B2bStore } from '../data/b2bStore';
import type { EcomStore } from '../data/ecomStore';
import type { DealStage } from '../mock/b2b';
import type { EcomOrderItem, TicketStatus } from '../mock/ecom';

export type Role = 'owner' | 'viewer';

export interface ToolContext {
  role: Role;
  b2b: B2bStore;
  ecom: EcomStore;
  custom: { enabled: boolean; isHipaaFlagged: (id: string) => boolean; flagHipaa: (id: string) => void };
}

export interface ToolResult {
  ok: boolean;
  denied?: boolean; // governance denial (RBAC / veto)
  data?: unknown;
  error?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  write: boolean; // gated by role
}

const str = (desc: string) => ({ type: 'string', description: desc });
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

/** Static tool specs sent to Claude. `acme_flag_hipaa` is included only when customization is on. */
export function toolSpecs(customEnabled: boolean): ToolSpec[] {
  const base: ToolSpec[] = [
    // ---- B2B ----
    { name: 'b2b_list_deals', write: false, description: 'List B2B sales deals, optionally filtered by stage or owner name.', input_schema: obj({ stage: str('lead|discovery|proposal|negotiation|closed_won|closed_lost'), owner: str('owner full name') }) },
    { name: 'b2b_find', write: false, description: 'Find a B2B account or deal by (partial) name. Returns matching ids to use with other tools.', input_schema: obj({ query: str('account or deal name fragment') }, ['query']) },
    { name: 'b2b_get_deal', write: false, description: 'Get a single deal with its account and security/DPA status.', input_schema: obj({ dealId: str('deal id') }, ['dealId']) },
    { name: 'b2b_update_deal', write: true, description: 'Update a deal: change its stage, mark the security review passed / DPA signed, or set the next step. Closing a >$50k deal requires a passed security review.', input_schema: obj({ dealId: str('deal id'), stage: str('target stage'), securityReviewPassed: { type: 'boolean' }, dpaSigned: { type: 'boolean' }, nextStep: str('next step text') }, ['dealId']) },
    { name: 'b2b_create_deal', write: true, description: 'Create a new deal for an account (by account name or id).', input_schema: obj({ name: str('deal name'), account: str('account name or id'), amount: { type: 'number', description: 'annual ARR' }, seats: { type: 'number' }, termMonths: { type: 'number' }, stage: str('initial stage') }, ['name', 'account', 'amount']) },
    { name: 'b2b_log_activity', write: true, description: 'Log an activity/note/task on a deal or account.', input_schema: obj({ dealId: str('deal id (optional)'), accountId: str('account id (optional)'), type: str('call|email|meeting|note|task'), subject: str('short subject'), body: str('details') }, ['type', 'subject']) },
    // ---- E-com ----
    { name: 'ecom_find_customer', write: false, description: 'Find an e-commerce customer by name, email, tier, or segment. Returns matching customer ids.', input_schema: obj({ query: str('name/email fragment'), tier: str('Standard|Gold|Platinum'), segment: str('New|Active|At-Risk|Churned|VIP') }) },
    { name: 'ecom_get_customer', write: false, description: 'Get a customer 360: profile, orders, tickets, returns.', input_schema: obj({ customerId: str('customer id') }, ['customerId']) },
    { name: 'ecom_create_order', write: true, description: 'Place an order for a customer (VIP tiers get an automatic 15% discount).', input_schema: obj({ customerId: str('customer id'), product: str('product name or id'), qty: { type: 'number' }, shipping: str('shipping method') }, ['customerId', 'product']) },
    { name: 'ecom_list_tickets', write: false, description: 'List support tickets, optionally by status.', input_schema: obj({ status: str('open|pending|resolved|closed') }) },
    { name: 'ecom_reply_ticket', write: true, description: 'Post a reply to a support ticket as the assigned agent.', input_schema: obj({ ticketId: str('ticket id'), message: str('reply body') }, ['ticketId', 'message']) },
    { name: 'ecom_set_ticket_status', write: true, description: 'Set a ticket status (open|pending|resolved|closed).', input_schema: obj({ ticketId: str('ticket id'), status: str('new status') }, ['ticketId', 'status']) },
    { name: 'ecom_approve_return', write: true, description: 'Approve a return/RMA for refund and restock.', input_schema: obj({ returnId: str('return id or RMA number') }, ['returnId']) },
  ];
  if (customEnabled) {
    base.push({ name: 'acme_flag_hipaa', write: true, description: '[custom/acme-crm] Record that a healthcare-vertical deal has passed HIPAA review, clearing it to close.', input_schema: obj({ dealId: str('deal id') }, ['dealId']) });
  }
  return base;
}

const ok = (data: unknown): ToolResult => ({ ok: true, data });
const deny = (error: string): ToolResult => ({ ok: false, denied: true, error });
const fail = (error: string): ToolResult => ({ ok: false, error });

export function executeTool(name: string, input: Record<string, any>, ctx: ToolContext): ToolResult {
  const spec = toolSpecs(ctx.custom.enabled).find((t) => t.name === name);
  if (!spec) return fail(`Unknown tool "${name}"`);
  if (spec.write && ctx.role !== 'owner') return deny(`Denied: role "${ctx.role}" is not permitted to perform "${name}" (write). RBAC is enforced for the agent, same as for humans and REST.`);

  const { b2b, ecom, custom } = ctx;

  switch (name) {
    // ---------- B2B ----------
    case 'b2b_list_deals': {
      let rows = b2b.deals;
      if (input.stage) rows = rows.filter((d) => d.stage === input.stage);
      if (input.owner) rows = rows.filter((d) => d.owner.toLowerCase().includes(String(input.owner).toLowerCase()));
      return ok(rows.map((d) => ({ id: d.id, name: d.name, stage: d.stage, amount: d.amount, owner: d.owner, securityReviewPassed: d.securityReviewPassed })));
    }
    case 'b2b_find': {
      const q = String(input.query ?? '').toLowerCase();
      return ok({
        accounts: b2b.accounts.filter((a) => a.name.toLowerCase().includes(q)).map((a) => ({ id: a.id, name: a.name, industry: a.industry })),
        deals: b2b.deals.filter((d) => d.name.toLowerCase().includes(q)).map((d) => ({ id: d.id, name: d.name, stage: d.stage, accountId: d.accountId })),
      });
    }
    case 'b2b_get_deal': {
      const d = b2b.dealById(input.dealId);
      if (!d) return fail('Deal not found');
      const acct = b2b.accountById(d.accountId);
      return ok({ ...d, account: acct ? { id: acct.id, name: acct.name, industry: acct.industry } : null });
    }
    case 'b2b_update_deal': {
      const d = b2b.dealById(input.dealId);
      if (!d) return fail('Deal not found');
      // Customization veto (HIPAA) — layered on top of the built-in InfoSec veto.
      if (custom.enabled && input.stage === 'closed_won') {
        const acct = b2b.accountById(d.accountId);
        if (acct?.industry === 'Healthcare' && !custom.isHipaaFlagged(d.id)) {
          return deny(`Vetoed by custom/acme-crm: healthcare-vertical deals require a HIPAA review before Closed Won. Call acme_flag_hipaa first.`);
        }
      }
      const patch: any = {};
      if (input.stage) patch.stage = input.stage as DealStage;
      if (typeof input.securityReviewPassed === 'boolean') patch.securityReviewPassed = input.securityReviewPassed;
      if (typeof input.dpaSigned === 'boolean') patch.dpaSigned = input.dpaSigned;
      if (input.nextStep) patch.nextStep = input.nextStep;
      const res = b2b.updateDeal(d.id, patch);
      if (!res.ok) return deny(res.error ?? 'Update vetoed');
      return ok(res.deal);
    }
    case 'b2b_create_deal': {
      const acct = b2b.accounts.find((a) => a.id === input.account || a.name.toLowerCase() === String(input.account).toLowerCase() || a.name.toLowerCase().includes(String(input.account).toLowerCase()));
      if (!acct) return fail(`No account matches "${input.account}"`);
      const deal = b2b.createDeal({
        name: input.name, accountId: acct.id, amount: Number(input.amount), seats: Number(input.seats ?? 0), termMonths: Number(input.termMonths ?? 12),
        stage: (input.stage as DealStage) ?? 'discovery', owner: 'Alex Rivera', closeDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
      });
      return ok(deal);
    }
    case 'b2b_log_activity': {
      const dealId = input.dealId as string | undefined;
      const accountId = (input.accountId as string | undefined) ?? (dealId ? b2b.dealById(dealId)?.accountId : undefined);
      if (!accountId) return fail('Provide a dealId or accountId');
      const a = b2b.logActivity({ type: (input.type as any) ?? 'note', subject: input.subject, body: input.body ?? '', accountId, dealId: dealId ?? null, actor: 'Alex Rivera' });
      return ok(a);
    }
    // ---------- E-com ----------
    case 'ecom_find_customer': {
      const q = String(input.query ?? '').toLowerCase();
      const rows = ecom.customers.filter((c) =>
        (!q || c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)) &&
        (!input.tier || c.vipTier === input.tier) && (!input.segment || c.segment === input.segment),
      );
      return ok(rows.slice(0, 12).map((c) => ({ id: c.id, name: c.name, tier: c.vipTier, segment: c.segment, ltv: c.ltv })));
    }
    case 'ecom_get_customer': {
      const c = ecom.customerById(input.customerId);
      if (!c) return fail('Customer not found');
      return ok({ ...c, orders: ecom.ordersForCustomer(c.id).map((o) => ({ id: o.id, number: o.number, status: o.status, total: o.total })), tickets: ecom.ticketsForCustomer(c.id).map((t) => ({ id: t.id, number: t.number, subject: t.subject, status: t.status })), returns: ecom.returnsForCustomer(c.id).map((r) => ({ id: r.id, number: r.number, status: r.status })) });
    }
    case 'ecom_create_order': {
      const c = ecom.customerById(input.customerId);
      if (!c) return fail('Customer not found');
      const prod = ecom.products.find((p) => p.id === input.product || p.name.toLowerCase().includes(String(input.product).toLowerCase()));
      if (!prod) return fail(`No product matches "${input.product}"`);
      const items: EcomOrderItem[] = [{ productId: prod.id, name: prod.name, qty: Number(input.qty ?? 1), price: prod.price }];
      const order = ecom.createOrder({ customerId: c.id, items, shippingMethod: input.shipping ?? 'Express Overnight' });
      return ok(order);
    }
    case 'ecom_list_tickets': {
      let rows = ecom.tickets;
      if (input.status) rows = rows.filter((t) => t.status === input.status);
      return ok(rows.map((t) => ({ id: t.id, number: t.number, subject: t.subject, status: t.status, priority: t.priority, customerId: t.customerId })));
    }
    case 'ecom_reply_ticket': {
      const t = ecom.ticketById(input.ticketId);
      if (!t) return fail('Ticket not found');
      ecom.replyTicket(t.id, input.message, t.assignee);
      return ok({ id: t.id, replied: true });
    }
    case 'ecom_set_ticket_status': {
      const t = ecom.ticketById(input.ticketId);
      if (!t) return fail('Ticket not found');
      ecom.setTicketStatus(t.id, input.status as TicketStatus);
      return ok({ id: t.id, status: input.status });
    }
    case 'ecom_approve_return': {
      const r = ecom.returns.find((x) => x.id === input.returnId || x.number.toLowerCase() === String(input.returnId).toLowerCase());
      if (!r) return fail('Return not found');
      ecom.setReturnStatus(r.id, 'approved');
      return ok({ id: r.id, status: 'approved' });
    }
    // ---------- custom/acme-crm ----------
    case 'acme_flag_hipaa': {
      const d = b2b.dealById(input.dealId);
      if (!d) return fail('Deal not found');
      custom.flagHipaa(d.id);
      return ok({ dealId: d.id, hipaaReview: 'passed' });
    }
    default:
      return fail(`Unhandled tool "${name}"`);
  }
}
