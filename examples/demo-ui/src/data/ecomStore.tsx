import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  ecomDataset,
  type EcomCustomer,
  type EcomProduct,
  type EcomOrder,
  type EcomOrderItem,
  type EcomTicket,
  type EcomReturn,
  type EcomSegment,
  type TicketStatus,
  type ReturnStatus,
  type VipTier,
} from '../mock/ecom';
import { loadPersisted, savePersisted, newId } from '../lib/persist';

const KEY = 'embody.ecom.v1';

interface EcomState {
  customers: EcomCustomer[];
  products: EcomProduct[];
  orders: EcomOrder[];
  tickets: EcomTicket[];
  returns: EcomReturn[];
  segments: EcomSegment[];
}

export interface EcomStore extends EcomState {
  customerById: (id: string) => EcomCustomer | undefined;
  ordersForCustomer: (id: string) => EcomOrder[];
  ticketsForCustomer: (id: string) => EcomTicket[];
  returnsForCustomer: (id: string) => EcomReturn[];
  orderById: (id: string) => EcomOrder | undefined;
  ticketById: (id: string) => EcomTicket | undefined;
  segmentMembers: (seg: EcomSegment) => EcomCustomer[];
  createOrder: (input: { customerId: string; items: EcomOrderItem[]; shippingMethod: string }) => EcomOrder;
  replyTicket: (id: string, body: string, agent: string) => void;
  setTicketStatus: (id: string, status: TicketStatus) => void;
  setReturnStatus: (id: string, status: ReturnStatus) => void;
  reset: () => void;
}

const Ctx = createContext<EcomStore | null>(null);

const seed = (): EcomState => ({
  customers: ecomDataset.customers,
  products: ecomDataset.products,
  orders: ecomDataset.orders,
  tickets: ecomDataset.tickets,
  returns: ecomDataset.returns,
  segments: ecomDataset.segments,
});

function tierDiscount(tier: VipTier): { rate: number; label: string } {
  if (tier === 'Gold') return { rate: 0.15, label: '15% Gold VIP' };
  if (tier === 'Platinum') return { rate: 0.15, label: '15% Platinum VIP' };
  return { rate: 0, label: 'None' };
}

export function EcomProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<EcomState>(() => loadPersisted<EcomState>(KEY, seed()));
  const ref = useRef(state);
  const commit = useCallback((next: EcomState) => { ref.current = next; setState(next); }, []);

  useEffect(() => { savePersisted(KEY, state); }, [state]);

  const customerById = useCallback((id: string) => ref.current.customers.find((c) => c.id === id), []);
  const orderById = useCallback((id: string) => ref.current.orders.find((o) => o.id === id), []);
  const ticketById = useCallback((id: string) => ref.current.tickets.find((t) => t.id === id), []);
  const ordersForCustomer = useCallback((id: string) => ref.current.orders.filter((o) => o.customerId === id).sort((a, b) => b.placedAt.localeCompare(a.placedAt)), []);
  const ticketsForCustomer = useCallback((id: string) => ref.current.tickets.filter((t) => t.customerId === id), []);
  const returnsForCustomer = useCallback((id: string) => ref.current.returns.filter((r) => r.customerId === id), []);

  const segmentMembers = useCallback((seg: EcomSegment) => ref.current.customers.filter((c) => {
    const r = seg.rule;
    if (r.tier && c.vipTier !== r.tier) return false;
    if (r.segment && c.segment !== r.segment) return false;
    if (r.minLtv && c.ltv < r.minLtv) return false;
    if (r.inactiveDays && c.lastOrderAt) {
      const days = (Date.now() - new Date(c.lastOrderAt).getTime()) / 86400000;
      if (days < r.inactiveDays) return false;
    }
    return true;
  }), []);

  // Mirrors the e-com VIP auto-discount hook: Gold/Platinum shoppers get 15% off at order creation.
  const createOrder: EcomStore['createOrder'] = useCallback((input) => {
    const cur = ref.current;
    const cust = cur.customers.find((c) => c.id === input.customerId);
    const subtotal = Number(input.items.reduce((s, it) => s + it.price * it.qty, 0).toFixed(2));
    const { rate, label } = tierDiscount(cust?.vipTier ?? 'Standard');
    const discount = Number((subtotal * rate).toFixed(2));
    const total = Number((subtotal - discount).toFixed(2));
    const num = 98500 + cur.orders.length;
    const order: EcomOrder = {
      id: newId('ord'), number: `#${num}`, customerId: input.customerId, status: 'processing',
      items: input.items, subtotal, discount, discountLabel: label, total,
      shippingMethod: input.shippingMethod, trackingNumber: null, placedAt: new Date().toISOString(),
    };
    commit({
      ...cur,
      orders: [order, ...cur.orders],
      customers: cur.customers.map((c) => c.id === input.customerId
        ? { ...c, orderCount: c.orderCount + 1, ltv: c.ltv + total, lastOrderAt: order.placedAt, segment: c.segment === 'Churned' || c.segment === 'At-Risk' ? 'Active' : c.segment }
        : c),
    });
    return order;
  }, [commit]);

  const replyTicket: EcomStore['replyTicket'] = useCallback((id, body, agent) => {
    const nowIso = new Date().toISOString();
    commit({
      ...ref.current,
      tickets: ref.current.tickets.map((t) => t.id === id
        ? { ...t, status: t.status === 'open' ? 'pending' : t.status, updatedAt: nowIso, messages: [...t.messages, { id: newId('m'), author: agent, fromCustomer: false, body, at: nowIso }] }
        : t),
    });
  }, [commit]);

  const setTicketStatus: EcomStore['setTicketStatus'] = useCallback((id, status) => {
    commit({ ...ref.current, tickets: ref.current.tickets.map((t) => (t.id === id ? { ...t, status, updatedAt: new Date().toISOString() } : t)) });
  }, [commit]);

  const setReturnStatus: EcomStore['setReturnStatus'] = useCallback((id, status) => {
    commit({ ...ref.current, returns: ref.current.returns.map((r) => (r.id === id ? { ...r, status } : r)) });
  }, [commit]);

  const reset = useCallback(() => commit(seed()), [commit]);

  const value = useMemo<EcomStore>(
    () => ({ ...state, customerById, orderById, ticketById, ordersForCustomer, ticketsForCustomer, returnsForCustomer, segmentMembers, createOrder, replyTicket, setTicketStatus, setReturnStatus, reset }),
    [state, customerById, orderById, ticketById, ordersForCustomer, ticketsForCustomer, returnsForCustomer, segmentMembers, createOrder, replyTicket, setTicketStatus, setReturnStatus, reset],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useEcom(): EcomStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useEcom must be used within EcomProvider');
  return ctx;
}
