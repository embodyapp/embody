import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useEcom } from '../../data/ecomStore';
import { Badge, EmptyState, Avatar } from '../../ui/primitives';
import { currency, relativeDate } from '../../lib/format';
import { tierTone, segmentTone } from '../meta';
import type { VipTier, Segment } from '../../mock/ecom';

export function Customers() {
  const { customers } = useEcom();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [tier, setTier] = useState<VipTier | 'all'>('all');
  const [seg, setSeg] = useState<Segment | 'all'>('all');
  const [sort, setSort] = useState<'ltv' | 'recent' | 'name'>('ltv');

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return customers
      .filter((c) => (!s || c.name.toLowerCase().includes(s) || c.email.toLowerCase().includes(s)) && (tier === 'all' || c.vipTier === tier) && (seg === 'all' || c.segment === seg))
      .sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'recent' ? (b.lastOrderAt ?? '').localeCompare(a.lastOrderAt ?? '') : b.ltv - a.ltv));
  }, [customers, q, tier, seg, sort]);

  return (
    <>
      <div className="page-head"><div><h1 className="page-title">Customers</h1><p className="page-sub">{customers.length} customers · {rows.length} shown</p></div></div>
      <div className="toolbar">
        <div className="search-box"><Search size={15} /><input placeholder="Search customers…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className="select-inline" value={tier} onChange={(e) => setTier(e.target.value as VipTier | 'all')}>
          <option value="all">All tiers</option><option value="Gold">Gold</option><option value="Platinum">Platinum</option><option value="Standard">Standard</option>
        </select>
        <select className="select-inline" value={seg} onChange={(e) => setSeg(e.target.value as Segment | 'all')}>
          <option value="all">All segments</option><option value="New">New</option><option value="Active">Active</option><option value="VIP">VIP</option><option value="At-Risk">At-Risk</option><option value="Churned">Churned</option>
        </select>
        <div className="spacer" />
        <select className="select-inline" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="ltv">Sort: LTV</option><option value="recent">Sort: Last order</option><option value="name">Sort: Name</option>
        </select>
      </div>
      <div className="panel"><div className="table-wrap">
        {rows.length === 0 ? <EmptyState title="No customers match" hint="Try clearing filters." /> : (
          <table className="data">
            <thead><tr><th>Customer</th><th>Tier</th><th>Segment</th><th>Orders</th><th>LTV</th><th>Last order</th><th>RFM</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => navigate(`/ecom/customers/${c.id}`)}>
                <td><div className="cell-entity"><Avatar name={c.name} size={30} /><div><div className="cell-strong">{c.name}</div><div className="text-xs text-dim">{c.email}</div></div></div></td>
                <td><Badge tone={tierTone[c.vipTier]}>{c.vipTier}</Badge></td>
                <td><Badge tone={segmentTone[c.segment]}>{c.segment}</Badge></td>
                <td>{c.orderCount}</td>
                <td className="cell-mono text-emerald">{currency(c.ltv, { compact: true })}</td>
                <td className="cell-muted">{c.lastOrderAt ? relativeDate(c.lastOrderAt) : '—'}</td>
                <td className="cell-mono text-xs">{c.recency}·{c.frequency}·{c.monetary}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div></div>
    </>
  );
}
