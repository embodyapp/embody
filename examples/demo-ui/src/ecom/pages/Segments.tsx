import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Send, Users } from 'lucide-react';
import { useEcom } from '../../data/ecomStore';
import { useToast } from '../../ui/Toast';
import { Panel, Badge, EmptyState, Avatar } from '../../ui/primitives';
import { currency } from '../../lib/format';
import { tierTone, segmentTone } from '../meta';
import type { EcomSegment } from '../../mock/ecom';

export function Segments() {
  const { segments, segmentMembers } = useEcom();
  const toast = useToast();
  const [active, setActive] = useState<EcomSegment | null>(segments[0] ?? null);

  const members = active ? segmentMembers(active) : [];
  const reach = members.filter((c) => c.emailOptIn).length;

  return (
    <>
      <div className="page-head"><div><h1 className="page-title">Segments &amp; campaigns</h1><p className="page-sub">Build audiences and launch win-back campaigns.</p></div></div>

      <div className="grid-2">
        <Panel title="Saved segments">
          <div className="list-plain">
            {segments.map((s) => {
              const count = segmentMembers(s).length;
              return (
                <button key={s.id} className="list-item" style={{ background: active?.id === s.id ? 'var(--bg-active)' : 'transparent', border: 'none', width: '100%', textAlign: 'left', borderRadius: 8, padding: '12px 10px' }} onClick={() => setActive(s)}>
                  <Boxes size={16} className="text-dim" />
                  <div style={{ flex: 1 }}><div className="text-sm fw-600">{s.name}</div><div className="text-xs text-dim">{s.description}</div></div>
                  <Badge tone="blue">{count}</Badge>
                </button>
              );
            })}
          </div>
        </Panel>

        <Panel title={active ? active.name : 'Select a segment'} actions={active && <button className="btn btn-ecom btn-sm" onClick={() => toast.success(`Campaign queued to ${reach} opted-in customers`)}><Send size={14} /> Launch campaign</button>}>
          {!active ? <EmptyState title="No segment selected" /> : (
            <>
              <div className="row gap-16 mb-8" style={{ flexWrap: 'wrap' }}>
                <div><div className="kpi-value" style={{ fontSize: '1.4rem' }}>{members.length}</div><div className="text-xs text-dim">members</div></div>
                <div><div className="kpi-value" style={{ fontSize: '1.4rem' }}>{reach}</div><div className="text-xs text-dim">email-reachable</div></div>
                <div><div className="kpi-value" style={{ fontSize: '1.4rem' }}>{currency(members.reduce((s, c) => s + c.ltv, 0), { compact: true })}</div><div className="text-xs text-dim">combined LTV</div></div>
              </div>
              {members.length === 0 ? <EmptyState title="No customers in this segment" icon={<Users size={26} />} /> : (
                <div className="table-wrap"><table className="data">
                  <thead><tr><th>Customer</th><th>Tier</th><th>Segment</th><th>LTV</th></tr></thead>
                  <tbody>{members.slice(0, 12).map((c) => (
                    <tr key={c.id}>
                      <td><Link to={`/ecom/customers/${c.id}`} className="cell-entity" style={{ color: 'inherit' }}><Avatar name={c.name} size={26} /> <span className="cell-strong">{c.name}</span></Link></td>
                      <td><Badge tone={tierTone[c.vipTier]}>{c.vipTier}</Badge></td>
                      <td><Badge tone={segmentTone[c.segment]}>{c.segment}</Badge></td>
                      <td className="cell-mono text-emerald">{currency(c.ltv, { compact: true })}</td>
                    </tr>
                  ))}</tbody>
                </table>
                {members.length > 12 && <div className="text-xs text-dim mt-8" style={{ padding: 8 }}>+ {members.length - 12} more</div>}
                </div>
              )}
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
