import React, { useState } from 'react';
import { Radio, RefreshCw, ShieldCheck, Stethoscope, LogOut, Wrench, ChevronDown } from 'lucide-react';
import {
  useCan,
  useIdentity,
  useToolQuery,
  useToolMutation,
  useTools,
} from '@embody/react';
import type { DealRow } from '@embody/crm/schemas';
import { Badge, EmptyState, Panel, Skeleton } from '../ui/primitives';
import { useToast } from '../ui/Toast';
import { currency } from '../lib/format';
import { LoginCard } from './LoginCard';

/**
 * The rest of this demo runs on an in-browser store. This page does not: every row
 * comes from Postgres through the host's `/api` bridge, on the same executor an AI
 * agent and the CLI use.
 *
 * What that buys, and what this page exists to show: the two rules that block a close
 * are not implemented here. One lives in `catalog/b2b-saas`, the other in
 * `custom/acme-crm` — a customer's own plugin. Neither knows about this UI, and this UI
 * does not know about them. They arrive as `error.kind === "veto"` with their own
 * wording, and the optimistic row rolls back.
 */

const STAGES = ['lead', 'discovery', 'proposal', 'negotiation', 'closed_won', 'closed_lost'];

const stageTone = (stage: string) =>
  stage === 'closed_won' ? 'green' : stage === 'closed_lost' ? 'rose' : stage === 'negotiation' ? 'amber' : 'blue';

const flag = (deal: DealRow, key: string) => deal.custom_fields?.[key] === true;

export function LivePipeline() {
  const toast = useToast();
  const { identity, status: identityStatus, logout } = useIdentity();
  const canWrite = useCan('write', 'crm:deal');
  const [showTools, setShowTools] = useState(false);

  const deals = useToolQuery('crm_query_deals', { limit: 50 }, { enabled: Boolean(identity) });

  /** Shared by every write: refresh the list, and say why if a rule refused. */
  const writeOptions = {
    invalidates: ['crm_query_deals'] as const,
    onError: (error: { message: string }) => toast.error(error.message),
  };

  const updateDeal = useToolMutation('crm_update_deal', {
    ...writeOptions,
    // Move the row immediately; `useToolMutation` reverts it if the server refuses.
    optimistic: (input, tx) => {
      if (!input.stage) return;
      tx.patch<DealRow[]>('crm_query_deals', (rows) =>
        (rows ?? []).map((row) => (row.id === input.id ? { ...row, stage: input.stage! } : row)),
      );
    },
  });
  const createDeal = useToolMutation('crm_create_deal', writeOptions);
  const flagHipaa = useToolMutation('acme_flag_hipaa', writeOptions);

  if (identityStatus === 'loading') return <Skeleton rows={3} />;
  if (!identity) {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Live data</h1>
            <p className="page-sub">Real deals, read and written through the embody host.</p>
          </div>
        </div>
        <LoginCard />
      </>
    );
  }

  const rows = deals.data ?? [];

  const setStage = async (deal: DealRow, stage: string) => {
    const res = await updateDeal.mutate({ id: deal.id, stage });
    if (res.ok) toast.success(`${deal.title} → ${stage.replace('_', ' ')}`);
  };

  const markSecurityReview = async (deal: DealRow) => {
    const res = await updateDeal.mutate({
      id: deal.id,
      // Only this key is sent; the server merges jsonb key-by-key, so the vertical
      // another plugin's rule reads is not dropped.
      customFields: { security_review_passed: true },
    });
    if (res.ok) toast.success('Security review recorded');
  };

  const recordHipaa = async (deal: DealRow) => {
    const res = await flagHipaa.mutate({ dealId: deal.id, reviewer: 'Alex Rivera' });
    if (res.ok) toast.success('HIPAA review recorded');
  };

  const seedDemoDeals = async () => {
    const fixtures = [
      { title: 'Northwind Logistics — Platform', amount: 42000, customFields: {} },
      { title: 'Vertex Analytics — Expansion', amount: 96000, customFields: {} },
      // Healthcare + over $50k: trips the InfoSec gate first, then Acme's HIPAA gate.
      {
        title: 'Brightpath Health — 300 Clinical Seats',
        amount: 84000,
        customFields: { industry_vertical: 'healthcare' },
      },
    ];
    for (const fixture of fixtures) await createDeal.mutate(fixture);
    toast.success('Created 3 demo deals');
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Live data</h1>
          <p className="page-sub">
            Org <code>{identity.principal.orgId.slice(0, 8)}</code> · acting as{' '}
            {identity.principal.roles.join(', ')} · {rows.length} deals from Postgres
          </p>
        </div>
        <div className="toolbar" style={{ margin: 0 }}>
          {!canWrite && <Badge tone="amber">Read-only</Badge>}
          <button className="btn btn-secondary btn-sm" onClick={() => void deals.refetch()}>
            <RefreshCw size={14} className={deals.isFetching ? 'spin' : undefined} /> Refresh
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => void logout()}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </div>

      <div className="callout callout-blue">
        <Radio size={16} />
        <div>
          Every row here is a real <code>crm.deals</code> row, tenant-scoped by RLS. Closing
          <strong> Brightpath Health</strong> is refused twice — once by <code>catalog/b2b-saas</code>,
          then by <code>custom/acme-crm</code> — by rules this page contains no code for.
        </div>
      </div>

      {deals.error && deals.error.kind !== 'unauthenticated' && (
        <div className="callout callout-amber">
          <ShieldCheck size={16} />
          <div>{deals.error.message}</div>
        </div>
      )}

      <Panel title="Deals">
        {deals.status === 'loading' ? (
          <div className="panel-body"><Skeleton rows={5} /></div>
        ) : rows.length === 0 ? (
          <div className="panel-body">
            <EmptyState
              title="No deals in this org yet"
              hint="Create a few to exercise the write path, including the deal both veto rules will refuse."
              action={
                <button className="btn btn-b2b" onClick={() => void seedDemoDeals()} disabled={!canWrite}>
                  Create 3 demo deals
                </button>
              }
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Deal</th>
                  <th>Amount</th>
                  <th>Stage</th>
                  <th>Reviews</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((deal) => (
                  <tr key={deal.id}>
                    <td>{deal.title}</td>
                    <td>{deal.amount ? currency(Number(deal.amount)) : '—'}</td>
                    <td><Badge tone={stageTone(deal.stage)}>{deal.stage.replace('_', ' ')}</Badge></td>
                    <td>
                      {flag(deal, 'security_review_passed') && <Badge tone="green">InfoSec</Badge>}{' '}
                      {flag(deal, 'hipaa_review_passed') && <Badge tone="green">HIPAA</Badge>}
                      {deal.custom_fields?.industry_vertical === 'healthcare' &&
                        !flag(deal, 'hipaa_review_passed') && <Badge tone="amber">Healthcare</Badge>}
                    </td>
                    <td>
                      <div className="toolbar" style={{ margin: 0, justifyContent: 'flex-end' }}>
                        {!flag(deal, 'security_review_passed') && (
                          <button
                            className="btn btn-secondary btn-sm"
                            disabled={!canWrite}
                            onClick={() => void markSecurityReview(deal)}
                          >
                            <ShieldCheck size={13} /> Security review
                          </button>
                        )}
                        {deal.custom_fields?.industry_vertical === 'healthcare' &&
                          !flag(deal, 'hipaa_review_passed') && (
                            <button
                              className="btn btn-secondary btn-sm"
                              disabled={!canWrite}
                              onClick={() => void recordHipaa(deal)}
                            >
                              <Stethoscope size={13} /> HIPAA review
                            </button>
                          )}
                        <select
                          value={deal.stage}
                          disabled={!canWrite}
                          onChange={(e) => void setStage(deal, e.target.value)}
                          aria-label={`Stage for ${deal.title}`}
                        >
                          {STAGES.map((stage) => (
                            <option key={stage} value={stage}>{stage.replace('_', ' ')}</option>
                          ))}
                        </select>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <ToolCatalogue open={showTools} onToggle={() => setShowTools((v) => !v)} />
    </>
  );
}

/**
 * What this deployment can do, read from the live registry. A tool from `custom/`
 * appears here with no change to this component — which is what "install an app" means.
 */
function ToolCatalogue({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { tools, status } = useTools();

  return (
    <Panel
      className="mt"
      title={
        <button className="btn btn-ghost btn-sm" onClick={onToggle} style={{ padding: 0 }}>
          <Wrench size={14} /> Tools in this deployment
          {tools ? ` (${tools.length})` : ''}
          <ChevronDown size={14} style={{ transform: open ? 'rotate(180deg)' : undefined }} />
        </button>
      }
    >
      {open && (
        <div className="panel-body">
          {status === 'loading' ? (
            <Skeleton rows={4} />
          ) : (
            <table className="data">
              <tbody>
                {tools?.map((tool) => (
                  <tr key={tool.name}>
                    <td style={{ width: 220 }}>
                      <code>{tool.name}</code>{' '}
                      {tool.name.startsWith('acme_') && <Badge tone="purple">custom/</Badge>}
                    </td>
                    <td className="text-dim">{tool.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Panel>
  );
}
