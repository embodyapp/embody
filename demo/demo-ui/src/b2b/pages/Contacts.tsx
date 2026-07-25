import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { useB2b } from '../../data/b2bStore';
import { Badge, EmptyState, Avatar, ProgressBar } from '../../ui/primitives';
import type { BuyerRole } from '../../mock/b2b';

const ROLES: (BuyerRole | 'all')[] = ['all', 'Champion', 'Economic Buyer', 'InfoSec', 'Procurement', 'Technical Evaluator', 'End User'];

export function Contacts() {
  const { contacts, accounts } = useB2b();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [role, setRole] = useState<BuyerRole | 'all'>('all');
  const acctName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '—';

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return contacts.filter((c) => {
      const matchesQ = !s || c.name.toLowerCase().includes(s) || c.email.toLowerCase().includes(s) || acctName(c.accountId).toLowerCase().includes(s);
      const matchesRole = role === 'all' || c.buyerRole === role;
      return matchesQ && matchesRole;
    });
  }, [contacts, q, role, accounts]);

  return (
    <>
      <div className="page-head"><div><h1 className="page-title">Contacts</h1><p className="page-sub">{contacts.length} people across your accounts</p></div></div>
      <div className="toolbar">
        <div className="search-box"><Search size={15} /><input placeholder="Search contacts…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="spacer" />
        <select className="select-inline" value={role} onChange={(e) => setRole(e.target.value as BuyerRole | 'all')}>
          {ROLES.map((r) => <option key={r} value={r}>{r === 'all' ? 'All buyer roles' : r}</option>)}
        </select>
      </div>
      <div className="panel"><div className="table-wrap">
        {rows.length === 0 ? <EmptyState title="No contacts match" /> : (
          <table className="data">
            <thead><tr><th>Name</th><th>Title</th><th>Account</th><th>Buyer role</th><th>Engagement</th></tr></thead>
            <tbody>{rows.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => navigate(`/b2b/accounts/${c.accountId}`)}>
                <td><div className="cell-entity"><Avatar name={c.name} size={30} /><div><div className="cell-strong">{c.name}</div><div className="text-xs text-dim">{c.email}</div></div></div></td>
                <td className="cell-muted">{c.title}</td>
                <td className="cell-muted">{acctName(c.accountId)}</td>
                <td><Badge tone="purple">{c.buyerRole}</Badge></td>
                <td><div className="row" style={{ gap: 8 }}><div style={{ width: 90 }}><ProgressBar pct={c.engagement} color={c.engagement >= 80 ? 'var(--accent-emerald)' : 'var(--accent-amber)'} /></div><span className="text-xs text-dim">{c.engagement}</span></div></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div></div>
    </>
  );
}
