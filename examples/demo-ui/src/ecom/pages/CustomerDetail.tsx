import React, { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ChevronRight, ShoppingBag, LifeBuoy, RotateCcw, DollarSign, Repeat, Mail, MapPin, Star } from 'lucide-react';
import { useEcom } from '../../data/ecomStore';
import { Badge, Panel, Tabs, EmptyState, Avatar } from '../../ui/primitives';
import { currency, shortDate, relativeDate } from '../../lib/format';
import { tierTone, segmentTone, orderStatusTone, ticketStatusTone, returnStatusTone } from '../meta';

export function CustomerDetail() {
  const { id = '' } = useParams();
  const { customerById, ordersForCustomer, ticketsForCustomer, returnsForCustomer } = useEcom();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'orders' | 'tickets' | 'returns'>('orders');

  const c = customerById(id);
  if (!c) return <EmptyState title="Customer not found" action={<Link to="/ecom/customers" className="btn btn-secondary">Back to customers</Link>} />;
  const orders = ordersForCustomer(id);
  const tickets = ticketsForCustomer(id);
  const returns = returnsForCustomer(id);

  return (
    <>
      <div className="breadcrumb"><Link to="/ecom/customers">Customers</Link> <ChevronRight size={13} /> <span>{c.name}</span></div>
      <div className="page-head">
        <div className="row" style={{ gap: 14 }}>
          <Avatar name={c.name} size={48} />
          <div>
            <h1 className="page-title">{c.name}</h1>
            <p className="page-sub"><Mail size={13} style={{ verticalAlign: -2 }} /> {c.email} · <MapPin size={13} style={{ verticalAlign: -2 }} /> {c.location}</p>
          </div>
        </div>
        <div className="row"><Badge tone={tierTone[c.vipTier]}><Star size={11} /> {c.vipTier} VIP</Badge><Badge tone={segmentTone[c.segment]}>{c.segment}</Badge></div>
      </div>

      <div className="kpi-row">
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">Lifetime value</span><DollarSign size={16} className="kpi-icon" /></div><div className="kpi-value text-emerald">{currency(c.ltv)}</div></div>
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">Orders</span><ShoppingBag size={16} className="kpi-icon" /></div><div className="kpi-value">{c.orderCount}</div></div>
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">Last order</span><Repeat size={16} className="kpi-icon" /></div><div className="kpi-value" style={{ fontSize: '1.15rem' }}>{c.lastOrderAt ? relativeDate(c.lastOrderAt) : '—'}</div></div>
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">RFM score</span></div><div className="kpi-value cell-mono">{c.recency}·{c.frequency}·{c.monetary}</div><div className="kpi-delta kpi-delta-flat">Recency · Frequency · Monetary</div></div>
      </div>

      <Tabs tabs={[{ key: 'orders', label: 'Orders', count: orders.length }, { key: 'tickets', label: 'Tickets', count: tickets.length }, { key: 'returns', label: 'Returns', count: returns.length }]} active={tab} onChange={setTab} />

      {tab === 'orders' && (
        <div className="panel"><div className="table-wrap">
          {orders.length === 0 ? <EmptyState title="No orders" /> : (
            <table className="data">
              <thead><tr><th>Order</th><th>Items</th><th>Status</th><th>Total</th><th>Placed</th></tr></thead>
              <tbody>{orders.map((o) => (
                <tr key={o.id} className="clickable" onClick={() => navigate(`/ecom/orders/${o.id}`)}>
                  <td className="cell-strong cell-mono">{o.number}</td>
                  <td className="cell-muted">{o.items.map((i) => i.name).join(', ')}</td>
                  <td><Badge tone={orderStatusTone[o.status]}>{o.status}</Badge></td>
                  <td className="cell-mono text-emerald">{currency(o.total)}</td>
                  <td className="cell-muted">{shortDate(o.placedAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div></div>
      )}

      {tab === 'tickets' && (
        <Panel title="Support tickets">
          {tickets.length === 0 ? <EmptyState title="No tickets" hint="This customer has never contacted support." icon={<LifeBuoy size={26} />} /> : (
            <div className="list-plain">{tickets.map((t) => (
              <Link key={t.id} to={`/ecom/support/${t.id}`} className="list-item" style={{ color: 'inherit' }}>
                <LifeBuoy size={16} className="text-dim" />
                <div style={{ flex: 1 }}><div className="text-sm fw-600">{t.subject}</div><div className="text-xs text-dim">{t.number} · {t.category} · {relativeDate(t.updatedAt)}</div></div>
                <Badge tone={ticketStatusTone[t.status]}>{t.status}</Badge>
              </Link>
            ))}</div>
          )}
        </Panel>
      )}

      {tab === 'returns' && (
        <Panel title="Returns">
          {returns.length === 0 ? <EmptyState title="No returns" icon={<RotateCcw size={26} />} /> : (
            <div className="table-wrap"><table className="data">
              <thead><tr><th>RMA</th><th>Item</th><th>Reason</th><th>Refund</th><th>Status</th></tr></thead>
              <tbody>{returns.map((r) => (
                <tr key={r.id}><td className="cell-mono cell-strong">{r.number}</td><td>{r.itemName}</td><td><Badge tone="gray">{r.reason}</Badge></td><td className="cell-mono">{currency(r.refund)}</td><td><Badge tone={returnStatusTone[r.status]}>{r.status}</Badge></td></tr>
              ))}</tbody>
            </table></div>
          )}
        </Panel>
      )}
    </>
  );
}
