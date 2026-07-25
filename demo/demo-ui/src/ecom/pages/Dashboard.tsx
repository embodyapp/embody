import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Users, Repeat, DollarSign, AlertTriangle, LifeBuoy, ShoppingBag } from 'lucide-react';
import { useEcom } from '../../data/ecomStore';
import { KpiCard, Panel, Badge, BarChart, EmptyState } from '../../ui/primitives';
import { currency, relativeDate } from '../../lib/format';
import { tierTone, segmentTone, orderStatusTone, ticketStatusTone } from '../meta';
import { VIP_TIERS } from '../../mock/ecom';

export function Dashboard() {
  const { customers, orders, tickets } = useEcom();

  const m = useMemo(() => {
    const active = customers.filter((c) => c.segment === 'Active' || c.segment === 'VIP').length;
    const repeat = customers.filter((c) => c.orderCount > 1).length;
    const repeatRate = customers.length ? Math.round((repeat / customers.length) * 100) : 0;
    const avgLtv = customers.length ? customers.reduce((s, c) => s + c.ltv, 0) / customers.length : 0;
    const atRisk = customers.filter((c) => c.segment === 'At-Risk').length;
    const openTickets = tickets.filter((t) => t.status === 'open' || t.status === 'pending').length;
    return { active, repeatRate, avgLtv, atRisk, openTickets };
  }, [customers, tickets]);

  const tierMix = VIP_TIERS.map((t) => ({ label: t.label, value: customers.filter((c) => c.vipTier === t.key).length, color: t.color }));
  const recentOrders = [...orders].sort((a, b) => b.placedAt.localeCompare(a.placedAt)).slice(0, 6);
  const custName = (id: string) => customers.find((c) => c.id === id)?.name ?? '—';
  const openQueue = tickets.filter((t) => t.status === 'open' || t.status === 'pending').slice(0, 5);

  return (
    <>
      <div className="page-head"><div><h1 className="page-title">Customer overview</h1><p className="page-sub">Retention, loyalty, and support at a glance.</p></div></div>

      <div className="kpi-row">
        <KpiCard label="Active customers" value={m.active} delta="Active + VIP segments" tone="up" icon={<Users size={18} />} />
        <KpiCard label="Repeat rate" value={`${m.repeatRate}%`} delta="Customers with 2+ orders" tone="up" icon={<Repeat size={18} />} />
        <KpiCard label="Avg LTV" value={currency(m.avgLtv, { compact: true })} delta="Across all customers" tone="flat" icon={<DollarSign size={18} />} />
        <KpiCard label="At-risk" value={m.atRisk} delta="No order in 60+ days" tone="down" icon={<AlertTriangle size={18} />} />
      </div>

      <div className="grid-2">
        <Panel title="Recent orders" actions={<Link to="/ecom/orders" className="btn btn-ghost btn-sm">View all</Link>}>
          {recentOrders.length === 0 ? <EmptyState title="No orders yet" /> : (
            <div className="list-plain">
              {recentOrders.map((o) => (
                <Link key={o.id} to={`/ecom/orders/${o.id}`} className="list-item" style={{ color: 'inherit' }}>
                  <ShoppingBag size={16} className="text-dim" />
                  <div style={{ flex: 1 }}><div className="text-sm fw-600">{o.number} · {custName(o.customerId)}</div><div className="text-xs text-dim">{o.items.length} item(s) · {relativeDate(o.placedAt)}</div></div>
                  <Badge tone={orderStatusTone[o.status]}>{o.status}</Badge>
                  <span className="cell-mono text-emerald">{currency(o.total)}</span>
                </Link>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Open support queue" actions={<Badge tone="amber">{m.openTickets}</Badge>}>
          {openQueue.length === 0 ? <EmptyState title="Inbox zero" hint="No open tickets." icon={<LifeBuoy size={26} />} /> : (
            <div className="list-plain">
              {openQueue.map((t) => (
                <Link key={t.id} to={`/ecom/support/${t.id}`} className="list-item" style={{ color: 'inherit' }}>
                  <LifeBuoy size={16} className="text-dim" />
                  <div style={{ flex: 1 }}><div className="text-sm fw-600">{t.subject}</div><div className="text-xs text-dim">{custName(t.customerId)} · {t.assignee}</div></div>
                  <Badge tone={ticketStatusTone[t.status]}>{t.status}</Badge>
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Loyalty tier mix"><BarChart data={tierMix} /></Panel>
        <Panel title="Segments">
          <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
            {(['New', 'Active', 'VIP', 'At-Risk', 'Churned'] as const).map((seg) => (
              <div key={seg} className="kpi-card" style={{ flex: '1 1 120px', padding: 12 }}>
                <div className="kpi-value" style={{ fontSize: '1.3rem' }}>{customers.filter((c) => c.segment === seg).length}</div>
                <Badge tone={segmentTone[seg]}>{seg}</Badge>
              </div>
            ))}
          </div>
        </Panel>
      </div>
    </>
  );
}
