import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Plus, Zap } from 'lucide-react';
import { useEcom } from '../../data/ecomStore';
import { useToast } from '../../ui/Toast';
import { Badge, EmptyState, Modal } from '../../ui/primitives';
import { currency, shortDate } from '../../lib/format';
import { orderStatusTone, tierTone } from '../meta';
import type { OrderStatus, EcomOrderItem } from '../../mock/ecom';

export function Orders() {
  const { orders, customers } = useEcom();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<OrderStatus | 'all'>('all');
  const [modal, setModal] = useState(false);
  const custName = (id: string) => customers.find((c) => c.id === id)?.name ?? '—';

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return [...orders]
      .filter((o) => (!s || o.number.toLowerCase().includes(s) || custName(o.customerId).toLowerCase().includes(s)) && (status === 'all' || o.status === status))
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt));
  }, [orders, q, status, customers]);

  return (
    <>
      <div className="page-head">
        <div><h1 className="page-title">Orders</h1><p className="page-sub">{orders.length} orders · {currency(orders.reduce((s, o) => s + o.total, 0), { compact: true })} revenue</p></div>
        <button className="btn btn-ecom" onClick={() => setModal(true)}><Plus size={16} /> New order</button>
      </div>
      <div className="toolbar">
        <div className="search-box"><Search size={15} /><input placeholder="Search orders…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <div className="spacer" />
        <select className="select-inline" value={status} onChange={(e) => setStatus(e.target.value as OrderStatus | 'all')}>
          <option value="all">All statuses</option>{(['processing', 'fulfilled', 'shipped', 'delivered', 'refunded'] as OrderStatus[]).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
      <div className="panel"><div className="table-wrap">
        {rows.length === 0 ? <EmptyState title="No orders match" /> : (
          <table className="data">
            <thead><tr><th>Order</th><th>Customer</th><th>Items</th><th>Status</th><th>Discount</th><th>Total</th><th>Placed</th></tr></thead>
            <tbody>{rows.map((o) => (
              <tr key={o.id} className="clickable" onClick={() => navigate(`/ecom/orders/${o.id}`)}>
                <td className="cell-mono cell-strong">{o.number}</td>
                <td className="cell-muted">{custName(o.customerId)}</td>
                <td className="cell-muted">{o.items.length}</td>
                <td><Badge tone={orderStatusTone[o.status]}>{o.status}</Badge></td>
                <td>{o.discount > 0 ? <span className="text-amber text-xs">−{currency(o.discount)}</span> : <span className="text-dim">—</span>}</td>
                <td className="cell-mono text-emerald">{currency(o.total)}</td>
                <td className="cell-muted">{shortDate(o.placedAt)}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div></div>
      {modal && <NewOrderModal onClose={() => setModal(false)} onCreated={(id) => navigate(`/ecom/orders/${id}`)} />}
    </>
  );
}

function NewOrderModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const { customers, products, createOrder } = useEcom();
  const toast = useToast();
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? '');
  const [productId, setProductId] = useState(products[0]?.id ?? '');
  const [qty, setQty] = useState('1');
  const [ship, setShip] = useState('Express Overnight');

  const cust = customers.find((c) => c.id === customerId);
  const prod = products.find((p) => p.id === productId);
  const isVip = cust?.vipTier === 'Gold' || cust?.vipTier === 'Platinum';
  const subtotal = prod ? prod.price * Number(qty || 1) : 0;
  const discount = isVip ? subtotal * 0.15 : 0;
  const total = subtotal - discount;

  const submit = () => {
    if (!prod) return;
    const items: EcomOrderItem[] = [{ productId: prod.id, name: prod.name, qty: Number(qty || 1), price: prod.price }];
    const order = createOrder({ customerId, items, shippingMethod: ship });
    toast.success(isVip ? `Order placed — 15% ${cust?.vipTier} VIP discount applied` : 'Order placed');
    onCreated(order.id);
    onClose();
  };

  return (
    <Modal title="New order" onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-ecom" onClick={submit}>Place order</button></>}>
      <div className="field"><label>Customer</label><select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>{customers.map((c) => <option key={c.id} value={c.id}>{c.name} — {c.vipTier}</option>)}</select></div>
      <div className="field-row">
        <div className="field"><label>Product</label><select value={productId} onChange={(e) => setProductId(e.target.value)}>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
        <div className="field"><label>Qty</label><input type="number" min={1} value={qty} onChange={(e) => setQty(e.target.value)} /></div>
      </div>
      <div className="field"><label>Shipping</label><select value={ship} onChange={(e) => setShip(e.target.value)}><option>Express Overnight</option><option>Standard Ground</option><option>2-Day Air</option></select></div>
      <div className="callout callout-blue">
        <Zap size={16} className="text-blue" />
        <div>
          <div className="row" style={{ justifyContent: 'space-between' }}><span>Subtotal</span><span className="cell-mono">{currency(subtotal)}</span></div>
          {isVip && <div className="row" style={{ justifyContent: 'space-between' }}><span className="text-amber">15% {cust?.vipTier} VIP auto-discount</span><span className="cell-mono text-amber">−{currency(discount)}</span></div>}
          <div className="row" style={{ justifyContent: 'space-between' }}><strong>Total</strong><strong className="cell-mono text-emerald">{currency(total)}</strong></div>
        </div>
      </div>
    </Modal>
  );
}
