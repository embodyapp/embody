import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, Search } from 'lucide-react';
import { useB2b } from '../../data/b2bStore';
import { Badge, EmptyState, Avatar, type BadgeTone } from '../../ui/primitives';
import { currency, shortDate } from '../../lib/format';
import type { AccountHealth } from '../../mock/b2b';

const healthTone: Record<AccountHealth, BadgeTone> = { healthy: 'green', watch: 'amber', at_risk: 'rose' };
const healthLabel: Record<AccountHealth, string> = { healthy: 'Healthy', watch: 'Watch', at_risk: 'At risk' };

export function Accounts() {
  const { accounts, dealsForAccount } = useB2b();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<'name' | 'arr' | 'pipeline'>('pipeline');

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return accounts
      .map((a) => {
        const deals = dealsForAccount(a.id);
        const open = deals.filter((d) => d.stage !== 'closed_won' && d.stage !== 'closed_lost');
        return { ...a, dealCount: deals.length, openPipeline: open.reduce((sum, d) => sum + d.amount, 0) };
      })
      .filter((a) => !s || a.name.toLowerCase().includes(s) || a.industry.toLowerCase().includes(s))
      .sort((x, y) => (sort === 'name' ? x.name.localeCompare(y.name) : sort === 'arr' ? y.arr - x.arr : y.openPipeline - x.openPipeline));
  }, [accounts, q, sort, dealsForAccount]);

  return (
    <>
      <div className="page-head">
        <div><h1 className="page-title">Accounts</h1><p className="page-sub">{accounts.length} companies in your book</p></div>
      </div>
      <div className="toolbar">
        <div className="search-box"><Search size={15} /><input placeholder="Search accounts…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="spacer" />
        <select className="select-inline" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="pipeline">Sort: Open pipeline</option><option value="arr">Sort: Active ARR</option><option value="name">Sort: Name</option>
        </select>
      </div>
      <div className="panel">
        <div className="table-wrap">
          {rows.length === 0 ? <EmptyState title="No accounts match" /> : (
            <table className="data">
              <thead><tr><th>Account</th><th>Industry</th><th>Owner</th><th>Health</th><th>Deals</th><th>Open pipeline</th><th>Active ARR</th><th>Renewal</th></tr></thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => navigate(`/b2b/accounts/${a.id}`)}>
                    <td><div className="cell-entity"><Avatar name={a.name} size={30} /><div><div className="cell-strong">{a.name}</div><div className="text-xs text-dim">{a.location}</div></div></div></td>
                    <td className="cell-muted">{a.industry}</td>
                    <td className="cell-muted">{a.owner}</td>
                    <td><Badge tone={healthTone[a.health]}>{healthLabel[a.health]}</Badge></td>
                    <td>{a.dealCount}</td>
                    <td className="cell-mono">{currency(a.openPipeline, { compact: true })}</td>
                    <td className="cell-mono text-emerald">{a.arr ? currency(a.arr, { compact: true }) : '—'}</td>
                    <td className="cell-muted">{a.renewalDate ? shortDate(a.renewalDate) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
