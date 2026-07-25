import React from 'react';
import { useParams, Link } from 'react-router-dom';
import { ChevronRight, CheckCircle2, Package, Truck, Clock, User } from 'lucide-react';
import { useEcom } from '../../data/ecomStore';
import { Badge, Panel, EmptyState, Avatar } from '../../ui/primitives';
import { currency, dateTime } from '../../lib/format';
import { orderStatusTone, tierTone } from '../meta';
import type { OrderStatus } from '../../mock/ecom';

const STEPS: { key: OrderStatus; label: string; icon: React.ReactNode }[] = [
  { key: 'processing', label: 'Placed', icon: <Clock size={16} /> },
  { key: 'fulfilled', label: 'Fulfilled', icon: <Package size={16} /> },
  { key: 'shipped', label: 'Shipped', icon: <Truck size={16} /> },
  { key: 'delivered', label: 'Delivered', icon: <CheckCircle2 size={16} /> },
];
const stepIndex = (s: OrderStatus): number => {
  const order: OrderStatus[] = ['processing', 'fulfilled', 'shipped', 'delivered'];
  const i = order.indexOf(s);
  return i === -1 ? 0 : i;
};

export function OrderDetail() {
  const { id = '' } = useParams();
  const { orderById, customerById } = useEcom();
  const order = orderById(id);
  if (!order) return <EmptyState title="Order not found" action={<Link to="/ecom/orders" className="btn btn-secondary">Back to orders</Link>} />;
  const cust = customerById(order.customerId);
  const active = stepIndex(order.status);
  const isRefunded = order.status === 'refunded' || order.status === 'cancelled';

  return (
    <>
      <div className="breadcrumb"><Link to="/ecom/orders">Orders</Link> <ChevronRight size={13} /> <span>{order.number}</span></div>
      <div className="page-head">
        <div><h1 className="page-title">Order {order.number}</h1><p className="page-sub">Placed {dateTime(order.placedAt)} · {order.shippingMethod}</p></div>
        <Badge tone={orderStatusTone[order.status]}>{order.status}</Badge>
      </div>

      {!isRefunded && (
        <Panel title="Fulfillment">
          <div className="steps">
            {STEPS.map((s, i) => (
              <React.Fragment key={s.key}>
                <div className={`step ${i < active ? 'done' : i === active ? 'active' : ''}`}>
                  <div className="step-ic">{s.icon}</div><span>{s.label}</span>
                </div>
                {i < STEPS.length - 1 && <div className={`step-line ${i < active ? 'done' : ''}`} />}
              </React.Fragment>
            ))}
          </div>
          {order.trackingNumber && <div className="text-sm text-muted">Tracking: <span className="cell-mono">{order.trackingNumber}</span> · FedEx Express</div>}
        </Panel>
      )}

      <div className="grid-2">
        <Panel title="Line items">
          <div className="table-wrap"><table className="data">
            <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th className="right">Subtotal</th></tr></thead>
            <tbody>{order.items.map((it) => (
              <tr key={it.productId}><td className="cell-strong">{it.name}</td><td>{it.qty}</td><td className="cell-mono">{currency(it.price)}</td><td className="cell-mono right">{currency(it.price * it.qty)}</td></tr>
            ))}</tbody>
          </table></div>
          <div className="mt-16">
            <div className="prop-row"><span className="prop-label">Subtotal</span><span className="prop-value cell-mono">{currency(order.subtotal)}</span></div>
            {order.discount > 0 && <div className="prop-row"><span className="prop-label text-amber">{order.discountLabel} discount</span><span className="prop-value cell-mono text-amber">−{currency(order.discount)}</span></div>}
            <div className="prop-row"><span className="prop-label"><strong>Total</strong></span><span className="prop-value cell-mono text-emerald"><strong>{currency(order.total)}</strong></span></div>
          </div>
        </Panel>

        <Panel title="Customer">
          {cust ? (
            <>
              <div className="list-item">
                <Avatar name={cust.name} size={40} />
                <div style={{ flex: 1 }}><div className="fw-600">{cust.name}</div><div className="text-xs text-dim">{cust.email}</div></div>
                <Badge tone={tierTone[cust.vipTier]}>{cust.vipTier}</Badge>
              </div>
              <div className="prop-row"><span className="prop-label">Lifetime value</span><span className="prop-value text-emerald">{currency(cust.ltv)}</span></div>
              <div className="prop-row"><span className="prop-label">Total orders</span><span className="prop-value">{cust.orderCount}</span></div>
              <Link to={`/ecom/customers/${cust.id}`} className="btn btn-secondary full-width mt-16"><User size={15} /> View customer 360</Link>
            </>
          ) : <EmptyState title="Customer unavailable" />}
        </Panel>
      </div>
    </>
  );
}
