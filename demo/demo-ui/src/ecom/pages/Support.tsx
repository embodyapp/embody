import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, LifeBuoy } from 'lucide-react';
import { useEcom } from '../../data/ecomStore';
import { Badge, EmptyState, Avatar } from '../../ui/primitives';
import { relativeDate } from '../../lib/format';
import { ticketStatusTone, priorityTone, tierTone } from '../meta';
import { AGENTS, type TicketStatus, type TicketPriority } from '../../mock/ecom';

export function Support() {
  const { tickets, customers } = useEcom();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<TicketStatus | 'all'>('all');
  const [assignee, setAssignee] = useState<string>('all');
  const cust = (id: string) => customers.find((c) => c.id === id);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const prioRank: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    return [...tickets]
      .filter((t) => (!s || t.subject.toLowerCase().includes(s) || t.number.toLowerCase().includes(s)) && (status === 'all' || t.status === status) && (assignee === 'all' || t.assignee === assignee))
      .sort((a, b) => prioRank[a.priority] - prioRank[b.priority] || b.updatedAt.localeCompare(a.updatedAt));
  }, [tickets, q, status, assignee]);

  const openCount = tickets.filter((t) => t.status === 'open' || t.status === 'pending').length;

  return (
    <>
      <div className="page-head"><div><h1 className="page-title">Support</h1><p className="page-sub">{openCount} open · {tickets.length} total tickets</p></div></div>
      <div className="toolbar">
        <div className="search-box"><Search size={15} /><input placeholder="Search tickets…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className="select-inline" value={status} onChange={(e) => setStatus(e.target.value as TicketStatus | 'all')}>
          <option value="all">All statuses</option><option value="open">Open</option><option value="pending">Pending</option><option value="resolved">Resolved</option><option value="closed">Closed</option>
        </select>
        <select className="select-inline" value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="all">All agents</option>{AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      <div className="panel"><div className="table-wrap">
        {rows.length === 0 ? <EmptyState title="No tickets match" icon={<LifeBuoy size={26} />} /> : (
          <table className="data">
            <thead><tr><th>Subject</th><th>Customer</th><th>Category</th><th>Priority</th><th>Status</th><th>Assignee</th><th>Updated</th></tr></thead>
            <tbody>{rows.map((t) => {
              const c = cust(t.customerId);
              return (
                <tr key={t.id} className="clickable" onClick={() => navigate(`/ecom/support/${t.id}`)}>
                  <td><div className="cell-strong">{t.subject}</div><div className="text-xs text-dim cell-mono">{t.number}</div></td>
                  <td>{c ? <div className="cell-entity"><Avatar name={c.name} size={26} /><div><div className="text-sm">{c.name}</div>{c.vipTier !== 'Standard' && <Badge tone={tierTone[c.vipTier]}>{c.vipTier}</Badge>}</div></div> : '—'}</td>
                  <td className="cell-muted">{t.category}</td>
                  <td><Badge tone={priorityTone[t.priority]}>{t.priority}</Badge></td>
                  <td><Badge tone={ticketStatusTone[t.status]}>{t.status}</Badge></td>
                  <td className="cell-muted">{t.assignee}</td>
                  <td className="cell-muted">{relativeDate(t.updatedAt)}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </div></div>
    </>
  );
}
