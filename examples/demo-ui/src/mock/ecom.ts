/**
 * E-Commerce Customer CRM — mock data fixtures (single source of truth).
 *
 * Rich, interlinked demo records for the retention/CX-focused customer CRM. Consumed by
 * the client-side fallback and (later) the backend `seed:demo` script. Deterministic IDs.
 */

export type VipTier = 'Standard' | 'Gold' | 'Platinum';
export type Segment = 'New' | 'Active' | 'At-Risk' | 'Churned' | 'VIP';
export type OrderStatus = 'processing' | 'fulfilled' | 'shipped' | 'delivered' | 'cancelled' | 'refunded';
export type TicketStatus = 'open' | 'pending' | 'resolved' | 'closed';
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ReturnStatus = 'requested' | 'approved' | 'rejected' | 'restocked';

export interface EcomCustomer {
  id: string;
  name: string;
  email: string;
  location: string;
  vipTier: VipTier;
  segment: Segment;
  ltv: number;
  orderCount: number;
  lastOrderAt: string | null;
  emailOptIn: boolean;
  // RFM (1-5 each)
  recency: number;
  frequency: number;
  monetary: number;
  createdAt: string;
}

export interface EcomProduct {
  id: string;
  name: string;
  sku: string;
  category: string;
  price: number;
  unitsSold: number;
  stock: number;
}

export interface EcomOrderItem {
  productId: string;
  name: string;
  qty: number;
  price: number;
}

export interface EcomOrder {
  id: string;
  number: string;
  customerId: string;
  status: OrderStatus;
  items: EcomOrderItem[];
  subtotal: number;
  discount: number;
  discountLabel: string;
  total: number;
  shippingMethod: string;
  trackingNumber: string | null;
  placedAt: string;
}

export interface EcomTicketMessage {
  id: string;
  author: string; // customer name or agent name
  fromCustomer: boolean;
  body: string;
  at: string;
}

export interface EcomTicket {
  id: string;
  number: string;
  customerId: string;
  orderId: string | null;
  subject: string;
  category: string;
  status: TicketStatus;
  priority: TicketPriority;
  assignee: string;
  createdAt: string;
  updatedAt: string;
  messages: EcomTicketMessage[];
}

export interface EcomReturn {
  id: string;
  number: string;
  orderId: string;
  customerId: string;
  itemName: string;
  reason: string;
  refund: number;
  status: ReturnStatus;
  createdAt: string;
}

export interface EcomSegment {
  id: string;
  name: string;
  description: string;
  // simple declarative predicate over customers
  rule: { tier?: VipTier; segment?: Segment; minLtv?: number; inactiveDays?: number };
}

const now = new Date('2026-07-24T09:00:00Z');
const iso = (daysFromNow: number, hours = 12): string => {
  const d = new Date(now);
  d.setDate(d.getDate() + daysFromNow);
  d.setHours(hours, 0, 0, 0);
  return d.toISOString();
};

export const AGENTS = ['Riley Morgan', 'Casey Doyle', 'Sam Ortiz'] as const;

export const VIP_TIERS: { key: VipTier; label: string; discount: number; color: string }[] = [
  { key: 'Standard', label: 'Standard', discount: 0, color: '#64748b' },
  { key: 'Gold', label: 'Gold', discount: 0.15, color: '#f59e0b' },
  { key: 'Platinum', label: 'Platinum', discount: 0.15, color: '#8b5cf6' },
];

export const ecomProducts: EcomProduct[] = [
  { id: 'p-01', name: 'Wireless Noise-Cancelling Headphones', sku: 'AUD-NC-100', category: 'Audio', price: 176.46, unitsSold: 1240, stock: 320 },
  { id: 'p-02', name: 'Ultra-Wide 34" Curved Monitor', sku: 'DIS-UW-340', category: 'Displays', price: 799.0, unitsSold: 410, stock: 88 },
  { id: 'p-03', name: 'Ergonomic Mechanical Keyboard', sku: 'INP-MK-200', category: 'Peripherals', price: 129.99, unitsSold: 2130, stock: 540 },
  { id: 'p-04', name: 'Smart Fitness Watch v2', sku: 'WER-FW-002', category: 'Wearables', price: 199.0, unitsSold: 980, stock: 210 },
  { id: 'p-05', name: 'Ergonomic Vertical Mouse v3', sku: 'INP-VM-003', category: 'Peripherals', price: 79.99, unitsSold: 1670, stock: 430 },
  { id: 'p-06', name: '4K Webcam Pro', sku: 'CAM-4K-010', category: 'Peripherals', price: 149.0, unitsSold: 720, stock: 160 },
  { id: 'p-07', name: 'USB-C Docking Station', sku: 'ACC-DK-012', category: 'Accessories', price: 219.0, unitsSold: 540, stock: 95 },
  { id: 'p-08', name: 'Portable SSD 2TB', sku: 'STO-SSD-2T', category: 'Storage', price: 189.0, unitsSold: 860, stock: 275 },
];

// 40 customers spread across tiers + segments with realistic RFM/LTV.
const firstNames = ['Jane', 'Robert', 'Emily', 'Marcus', 'Sophia', 'Liam', 'Olivia', 'Noah', 'Ava', 'Ethan', 'Mia', 'Lucas', 'Isabella', 'Mason', 'Charlotte', 'Logan', 'Amelia', 'James', 'Harper', 'Benjamin', 'Evelyn', 'Henry', 'Abigail', 'Alexander', 'Emily', 'Daniel', 'Elizabeth', 'Matthew', 'Sofia', 'Jackson', 'Avery', 'David', 'Ella', 'Joseph', 'Scarlett', 'Samuel', 'Grace', 'John', 'Chloe', 'Owen'];
const lastNames = ['Doe', 'Vance', 'Watson', 'Aurelius', 'Lin', 'Mercer', 'Reyes', 'Park', 'Nolan', 'Sharp', 'Bishop', 'Fox', 'Cole', 'Wells', 'Hunt', 'Diaz', 'Frost', 'Grant', 'Shaw', 'Booth', 'Payne', 'Rhodes', 'Sable', 'Voss', 'Quinn', 'Marsh', 'Kerr', 'Dean', 'Blythe', 'Cross', 'Hale', 'Nash', 'Pryor', 'Roth', 'Sweeney', 'Tate', 'Vaughn', 'Webb', 'York', 'Zane'];
const cities = ['Seattle, WA', 'Austin, TX', 'Denver, CO', 'Chicago, IL', 'Miami, FL', 'Boston, MA', 'Portland, OR', 'Atlanta, GA'];

function mkCustomer(i: number): EcomCustomer {
  const first = firstNames[i] ?? 'Customer';
  const last = lastNames[i] ?? `No${i}`;
  const name = `${first} ${last}`;
  const tier: VipTier = i % 9 === 0 ? 'Platinum' : i % 3 === 0 ? 'Gold' : 'Standard';
  // segment distribution
  let segment: Segment;
  if (tier !== 'Standard' && i % 5 === 0) segment = 'VIP';
  else if (i % 11 === 0) segment = 'Churned';
  else if (i % 7 === 0) segment = 'At-Risk';
  else if (i % 4 === 0) segment = 'New';
  else segment = 'Active';

  const orderCount = segment === 'New' ? 1 : segment === 'Churned' ? 2 + (i % 3) : segment === 'VIP' ? 12 + (i % 8) : 3 + (i % 6);
  const avgOrder = tier === 'Platinum' ? 420 : tier === 'Gold' ? 240 : 120;
  const ltv = Math.round(orderCount * avgOrder * (0.8 + (i % 5) * 0.1));
  const lastDays = segment === 'Churned' ? -(200 + i * 3) : segment === 'At-Risk' ? -(70 + i) : segment === 'New' ? -(3 + i) : -(1 + (i % 25));

  const recency = segment === 'Churned' ? 1 : segment === 'At-Risk' ? 2 : segment === 'New' ? 4 : 5;
  const frequency = Math.min(5, Math.max(1, Math.round(orderCount / 3)));
  const monetary = tier === 'Platinum' ? 5 : tier === 'Gold' ? 4 : Math.min(3, Math.max(1, Math.round(ltv / 500)));

  return {
    id: `cus-${String(i + 1).padStart(2, '0')}`,
    name,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${i}@example.com`,
    location: cities[i % cities.length] ?? 'Seattle, WA',
    vipTier: tier,
    segment,
    ltv,
    orderCount,
    lastOrderAt: iso(lastDays),
    emailOptIn: i % 6 !== 0,
    recency,
    frequency,
    monetary,
    createdAt: iso(-(120 + i * 4)),
  };
}

export const ecomCustomers: EcomCustomer[] = Array.from({ length: 40 }, (_, i) => mkCustomer(i));

// Orders: generate a believable history keyed to customers + their tier discount.
function tierDiscount(tier: VipTier): { rate: number; label: string } {
  if (tier === 'Gold') return { rate: 0.15, label: '15% Gold VIP' };
  if (tier === 'Platinum') return { rate: 0.15, label: '15% Platinum VIP' };
  return { rate: 0, label: 'None' };
}
const shipMethods = ['Express Overnight', 'Standard Ground', 'International Air', '2-Day Air'];
const orderStatuses: OrderStatus[] = ['delivered', 'delivered', 'shipped', 'fulfilled', 'processing', 'delivered', 'refunded'];

export const ecomOrders: EcomOrder[] = (() => {
  const orders: EcomOrder[] = [];
  let n = 98400;
  ecomCustomers.forEach((cust, ci) => {
    const count = Math.min(cust.orderCount, 5); // cap items per customer for the demo
    for (let k = 0; k < count; k++) {
      const prod = ecomProducts[(ci + k) % ecomProducts.length]!;
      const prod2 = k % 2 === 0 ? ecomProducts[(ci + k + 3) % ecomProducts.length]! : null;
      const items: EcomOrderItem[] = [{ productId: prod.id, name: prod.name, qty: 1 + (k % 2), price: prod.price }];
      if (prod2) items.push({ productId: prod2.id, name: prod2.name, qty: 1, price: prod2.price });
      const subtotal = Number(items.reduce((s, it) => s + it.price * it.qty, 0).toFixed(2));
      const { rate, label } = tierDiscount(cust.vipTier);
      const discount = Number((subtotal * rate).toFixed(2));
      const total = Number((subtotal - discount).toFixed(2));
      const status = orderStatuses[(ci + k) % orderStatuses.length]!;
      n += 1;
      orders.push({
        id: `ord-${n}`,
        number: `#${n}`,
        customerId: cust.id,
        status,
        items,
        subtotal,
        discount,
        discountLabel: label,
        total,
        shippingMethod: shipMethods[(ci + k) % shipMethods.length]!,
        trackingNumber: status === 'processing' ? null : `TRK-${n}${k}`,
        placedAt: iso(-(k * 14 + (ci % 20))),
      });
    }
  });
  return orders;
})();

export const ecomTickets: EcomTicket[] = [
  {
    id: 'tkt-01', number: 'T-1042', customerId: 'cus-01', orderId: 'ord-98401', subject: 'Headphones left earcup crackling', category: 'Product Defect', status: 'open', priority: 'high', assignee: 'Riley Morgan',
    createdAt: iso(-1, 10), updatedAt: iso(0, 9),
    messages: [
      { id: 'm1', author: 'Jane Doe', fromCustomer: true, body: 'The left earcup started crackling after two weeks. Can I get a replacement?', at: iso(-1, 10) },
      { id: 'm2', author: 'Riley Morgan', fromCustomer: false, body: 'So sorry to hear that, Jane! As a Platinum VIP you qualify for priority replacement. I\'ve started an RMA — you\'ll get a prepaid label shortly.', at: iso(-1, 12) },
    ],
  },
  {
    id: 'tkt-02', number: 'T-1043', customerId: 'cus-04', orderId: 'ord-98410', subject: 'Where is my order? Shipped 5 days ago', category: 'Shipping', status: 'pending', priority: 'normal', assignee: 'Casey Doyle',
    createdAt: iso(-2, 14), updatedAt: iso(-1, 11),
    messages: [
      { id: 'm1', author: 'Marcus Aurelius', fromCustomer: true, body: 'Tracking hasn\'t updated in 5 days. Getting worried.', at: iso(-2, 14) },
      { id: 'm2', author: 'Casey Doyle', fromCustomer: false, body: 'I\'ve opened a trace with the carrier and will update you within 24h.', at: iso(-1, 11) },
    ],
  },
  {
    id: 'tkt-03', number: 'T-1044', customerId: 'cus-09', orderId: null, subject: 'How do I redeem my Platinum loyalty points?', category: 'Loyalty', status: 'resolved', priority: 'low', assignee: 'Sam Ortiz',
    createdAt: iso(-4, 9), updatedAt: iso(-3, 15),
    messages: [
      { id: 'm1', author: 'Ava Nolan', fromCustomer: true, body: 'I have 4,200 points — how do I use them at checkout?', at: iso(-4, 9) },
      { id: 'm2', author: 'Sam Ortiz', fromCustomer: false, body: 'Points auto-apply at checkout as a discount. I\'ve added a bonus 500 points for your loyalty!', at: iso(-3, 15) },
    ],
  },
  {
    id: 'tkt-04', number: 'T-1045', customerId: 'cus-13', orderId: 'ord-98430', subject: 'Wrong item received', category: 'Fulfillment Error', status: 'open', priority: 'urgent', assignee: 'Riley Morgan',
    createdAt: iso(0, 8), updatedAt: iso(0, 8),
    messages: [
      { id: 'm1', author: 'Isabella Cole', fromCustomer: true, body: 'I ordered the 34" monitor but received a keyboard. Please help!', at: iso(0, 8) },
    ],
  },
  {
    id: 'tkt-05', number: 'T-1046', customerId: 'cus-19', orderId: 'ord-98440', subject: 'Requesting return for sizing', category: 'Returns', status: 'pending', priority: 'normal', assignee: 'Casey Doyle',
    createdAt: iso(-1, 16), updatedAt: iso(0, 10),
    messages: [
      { id: 'm1', author: 'Harper Shaw', fromCustomer: true, body: 'The watch band is too small. Can I exchange for a larger size?', at: iso(-1, 16) },
      { id: 'm2', author: 'Casey Doyle', fromCustomer: false, body: 'Absolutely — starting an exchange RMA now.', at: iso(0, 10) },
    ],
  },
  {
    id: 'tkt-06', number: 'T-1047', customerId: 'cus-28', orderId: null, subject: 'Cancel my subscription emails', category: 'Account', status: 'closed', priority: 'low', assignee: 'Sam Ortiz',
    createdAt: iso(-6, 11), updatedAt: iso(-5, 9),
    messages: [
      { id: 'm1', author: 'Sofia Blythe', fromCustomer: true, body: 'Please stop the marketing emails.', at: iso(-6, 11) },
      { id: 'm2', author: 'Sam Ortiz', fromCustomer: false, body: 'Done — you\'ve been unsubscribed from marketing. You\'ll still get order updates.', at: iso(-5, 9) },
    ],
  },
];

export const ecomReturns: EcomReturn[] = [
  { id: 'rma-01', number: 'RMA-401', orderId: 'ord-98401', customerId: 'cus-01', itemName: 'Wireless Noise-Cancelling Headphones', reason: 'Defective', refund: 149.99, status: 'approved', createdAt: iso(-1, 13) },
  { id: 'rma-02', number: 'RMA-402', orderId: 'ord-98440', customerId: 'cus-19', itemName: 'Smart Fitness Watch v2', reason: 'Sizing Issue', refund: 199.0, status: 'requested', createdAt: iso(-1, 16) },
  { id: 'rma-03', number: 'RMA-403', orderId: 'ord-98415', customerId: 'cus-07', itemName: 'Ergonomic Vertical Mouse v3', reason: 'Changed Mind', refund: 79.99, status: 'restocked', createdAt: iso(-9, 10) },
  { id: 'rma-04', number: 'RMA-404', orderId: 'ord-98430', customerId: 'cus-13', itemName: 'Ergonomic Mechanical Keyboard', reason: 'Wrong Item', refund: 129.99, status: 'approved', createdAt: iso(0, 9) },
  { id: 'rma-05', number: 'RMA-405', orderId: 'ord-98422', customerId: 'cus-11', itemName: '4K Webcam Pro', reason: 'Late Arrival', refund: 149.0, status: 'rejected', createdAt: iso(-12, 14) },
];

export const ecomSegments: EcomSegment[] = [
  { id: 'seg-01', name: 'Gold & Platinum VIPs', description: 'All high-tier loyalty members', rule: { segment: 'VIP' } },
  { id: 'seg-02', name: 'At-Risk — win back', description: 'No order in 60+ days, previously active', rule: { segment: 'At-Risk' } },
  { id: 'seg-03', name: 'High-value (LTV > $2k)', description: 'Top spenders across all tiers', rule: { minLtv: 2000 } },
  { id: 'seg-04', name: 'New customers', description: 'First purchase in the last 30 days', rule: { segment: 'New' } },
];

export interface EcomDataset {
  customers: EcomCustomer[];
  products: EcomProduct[];
  orders: EcomOrder[];
  tickets: EcomTicket[];
  returns: EcomReturn[];
  segments: EcomSegment[];
}

export const ecomDataset: EcomDataset = {
  customers: ecomCustomers,
  products: ecomProducts,
  orders: ecomOrders,
  tickets: ecomTickets,
  returns: ecomReturns,
  segments: ecomSegments,
};
