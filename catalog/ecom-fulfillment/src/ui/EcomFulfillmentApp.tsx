import React, { useState, useMemo } from 'react';
import { 
  ShoppingBag, 
  Truck, 
  Package, 
  Star, 
  Activity, 
  Search, 
  Plus, 
  CheckCircle2, 
  Clock, 
  Zap, 
  Bot, 
  RefreshCw, 
  Check, 
  Tag,
  Factory,
  RotateCcw,
  Users,
  AlertTriangle,
  FileSpreadsheet,
  X,
  CreditCard
} from 'lucide-react';

export interface EcomOrder {
  id: string;
  orderNumber: string;
  shopperName: string;
  shopperEmail: string;
  vipTier: 'Gold' | 'Platinum' | 'Standard';
  itemTitle: string;
  originalPrice: number;
  finalPrice: number;
  discountApplied: string;
  shippingMethod: 'Express Overnight' | 'Standard Ground' | 'International Air';
  fulfillmentStatus: 'Processing' | 'Picked' | 'Dispatched' | 'Delivered';
  trackingNumber: string;
  createdAt: string;
}

export interface Supplier {
  id: string;
  name: string;
  category: string;
  leadTimeDays: number;
  moq: number;
  unitCost: number;
  rating: number;
  status: 'Preferred' | 'Active' | 'Under Review';
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  supplierName: string;
  items: string;
  totalCost: number;
  status: 'Draft' | 'Sent' | 'In Transit' | 'Received';
  expectedDate: string;
}

export interface RmaItem {
  id: string;
  rmaNumber: string;
  orderNumber: string;
  shopperName: string;
  itemTitle: string;
  reason: 'Sizing Issue' | 'Defective' | 'Changed Mind' | 'Late Arrival';
  refundAmount: number;
  status: 'Pending Review' | 'Approved & Restocked' | 'Rejected';
}

export interface EventLog {
  id: string;
  time: string;
  name: string;
  details: string;
  highlight?: boolean;
}

const INITIAL_ORDERS: EcomOrder[] = [
  {
    id: 'ord-101',
    orderNumber: 'Order #98432',
    shopperName: 'Jane Doe',
    shopperEmail: 'jane.doe@gmail.com',
    vipTier: 'Gold',
    itemTitle: 'Wireless Noise-Cancelling Headphones',
    originalPrice: 176.46,
    finalPrice: 149.99,
    discountApplied: '15% Gold VIP Discount',
    shippingMethod: 'Express Overnight',
    fulfillmentStatus: 'Dispatched',
    trackingNumber: 'TRK-981247',
    createdAt: '2026-07-24T15:40:00Z',
  },
  {
    id: 'ord-102',
    orderNumber: 'Order #98433',
    shopperName: 'Robert Vance',
    shopperEmail: 'robert.v@tech.com',
    vipTier: 'Platinum',
    itemTitle: 'Ultra-Wide 34" Curved Monitor',
    originalPrice: 799.00,
    finalPrice: 679.15,
    discountApplied: '15% Platinum VIP Discount',
    shippingMethod: 'Express Overnight',
    fulfillmentStatus: 'Picked',
    trackingNumber: 'TRK-881923',
    createdAt: '2026-07-24T15:42:00Z',
  },
  {
    id: 'ord-103',
    orderNumber: 'Order #98434',
    shopperName: 'Emily Watson',
    shopperEmail: 'emily@design.co',
    vipTier: 'Standard',
    itemTitle: 'Ergonomic Mechanical Keyboard',
    originalPrice: 129.99,
    finalPrice: 129.99,
    discountApplied: 'None',
    shippingMethod: 'Standard Ground',
    fulfillmentStatus: 'Processing',
    trackingNumber: 'TRK-771204',
    createdAt: '2026-07-24T15:45:00Z',
  },
];

const INITIAL_SUPPLIERS: Supplier[] = [
  { id: 'sup-1', name: 'AeroAudio Tech Ltd', category: 'Audio Electronics', leadTimeDays: 7, moq: 100, unitCost: 65.00, rating: 4.9, status: 'Preferred' },
  { id: 'sup-2', name: 'VisionTech Displays', category: 'Monitors & Screens', leadTimeDays: 14, moq: 50, unitCost: 320.00, rating: 4.7, status: 'Active' },
  { id: 'sup-3', name: 'Precision Peripherals', category: 'Keyboards & Mice', leadTimeDays: 5, moq: 200, unitCost: 45.00, rating: 4.8, status: 'Preferred' },
];

const INITIAL_POS: PurchaseOrder[] = [
  { id: 'po-1', poNumber: 'PO-2026-089', supplierName: 'AeroAudio Tech Ltd', items: '500x Noise-Cancelling Headphones', totalCost: 32500, status: 'In Transit', expectedDate: '2026-07-28' },
  { id: 'po-2', poNumber: 'PO-2026-090', supplierName: 'VisionTech Displays', items: '100x 34" Curved Monitors', totalCost: 32000, status: 'Sent', expectedDate: '2026-08-05' },
];

const INITIAL_RMAS: RmaItem[] = [
  { id: 'rma-1', rmaNumber: 'RMA-401', orderNumber: 'Order #98410', shopperName: 'Alex Mercer', itemTitle: 'Ergonomic Mouse v3', reason: 'Defective', refundAmount: 79.99, status: 'Approved & Restocked' },
  { id: 'rma-2', rmaNumber: 'RMA-402', orderNumber: 'Order #98415', shopperName: 'Sophia Lin', itemTitle: 'Wireless Noise-Cancelling Headphones', reason: 'Sizing Issue', refundAmount: 149.99, status: 'Pending Review' },
];

const INITIAL_EVENTS: EventLog[] = [
  { id: 'ev-1', time: '15:40:01', name: 'crm.deal.created', details: 'Order #98432 created for Gold VIP Jane Doe ($149.99)' },
  { id: 'ev-2', time: '15:40:02', name: 'ecom.shipment.dispatched', details: 'Dispatched via Express Overnight. Tracking #: TRK-981247', highlight: true },
  { id: 'ev-3', time: '15:42:01', name: 'crm.deal.created', details: 'Order #98433 created for Platinum VIP Robert Vance ($679.15)' },
];

export function EcomFulfillmentApp() {
  const [activeTab, setActiveTab] = useState<'orders' | 'suppliers' | 'buyers' | 'returns' | 'fulfillment'>('orders');
  const [orders, setOrders] = useState<EcomOrder[]>(INITIAL_ORDERS);
  const [suppliers] = useState<Supplier[]>(INITIAL_SUPPLIERS);
  const [purchaseOrders] = useState<PurchaseOrder[]>(INITIAL_POS);
  const [rmas, setRmas] = useState<RmaItem[]>(INITIAL_RMAS);
  const [eventLogs, setEventLogs] = useState<EventLog[]>(INITIAL_EVENTS);
  const [selectedOrder, setSelectedOrder] = useState<EcomOrder | null>(INITIAL_ORDERS[0] || null);

  // Checkout Simulator State
  const [itemTitle, setItemTitle] = useState('Smart Fitness Watch v2');
  const [origPrice, setOrigPrice] = useState('200.00');
  const [vipTier, setVipTier] = useState<EcomOrder['vipTier']>('Gold');
  const [shippingMethod, setShippingMethod] = useState<EcomOrder['shippingMethod']>('Express Overnight');
  const [shopperName, setShopperName] = useState('Marcus Aurelius');

  // Tracking Search State
  const [searchTrackingNo, setSearchTrackingNo] = useState('TRK-981247');
  const [trackedShipment, setTrackedShipment] = useState<EcomOrder | null>(INITIAL_ORDERS[0] || null);

  // Price Hook Calculation
  const pricePreview = useMemo(() => {
    const orig = Number(origPrice) || 0;
    const isVip = vipTier === 'Gold' || vipTier === 'Platinum';
    const finalP = isVip ? orig * 0.85 : orig;
    return { orig, finalP, isVip };
  }, [origPrice, vipTier]);

  // Handle New Order Creation
  const handlePlaceOrder = (e: React.FormEvent) => {
    e.preventDefault();
    const orig = Number(origPrice) || 0;
    const isVip = vipTier === 'Gold' || vipTier === 'Platinum';
    const finalP = isVip ? Number((orig * 0.85).toFixed(2)) : orig;
    const trackingNo = `TRK-${Math.floor(100000 + Math.random() * 900000)}`;
    const newOrdNum = `Order #${Math.floor(98435 + Math.random() * 100)}`;

    const newOrder: EcomOrder = {
      id: `ord-${Date.now()}`,
      orderNumber: newOrdNum,
      shopperName: shopperName.trim() || 'Valued Shopper',
      shopperEmail: `${shopperName.toLowerCase().replace(/\s+/g, '')}@gmail.com`,
      vipTier,
      itemTitle,
      originalPrice: orig,
      finalPrice: finalP,
      discountApplied: isVip ? `15% ${vipTier} VIP Discount` : 'None',
      shippingMethod,
      fulfillmentStatus: 'Dispatched',
      trackingNumber: trackingNo,
      createdAt: new Date().toISOString(),
    };

    setOrders(prev => [newOrder, ...prev]);

    const nowTime = new Date().toTimeString().split(' ')[0] || '15:50:00';
    const ev1: EventLog = {
      id: `ev-${Date.now()}-1`,
      time: nowTime,
      name: 'crm.deal.created',
      details: `${newOrdNum} created for ${vipTier} VIP ${shopperName} ($${finalP})`,
    };
    const ev2: EventLog = {
      id: `ev-${Date.now()}-2`,
      time: nowTime,
      name: 'ecom.shipment.dispatched',
      details: `Dispatched via ${shippingMethod}. Tracking #: ${trackingNo}`,
      highlight: true,
    };

    setEventLogs(prev => [ev2, ev1, ...prev]);
    setSelectedOrder(newOrder);
    setSearchTrackingNo(trackingNo);
    setTrackedShipment(newOrder);
    setActiveTab('fulfillment');
  };

  const handleSearchTracking = (e: React.FormEvent) => {
    e.preventDefault();
    const found = orders.find(o => o.trackingNumber.toLowerCase() === searchTrackingNo.trim().toLowerCase());
    setTrackedShipment(found || null);
  };

  const handleApproveRma = (rmaId: string) => {
    setRmas(prev => prev.map(r => r.id === rmaId ? { ...r, status: 'Approved & Restocked' } : r));
  };

  return (
    <div className="ecom-react-container">
      {/* Subheader Toolbar */}
      <div className="ecom-toolbar">
        <div className="ecom-tab-buttons">
          <button 
            className={`ecom-tab-btn ${activeTab === 'orders' ? 'active' : ''}`}
            onClick={() => setActiveTab('orders')}
          >
            <ShoppingBag size={16} /> Retail Orders Feed ({orders.length})
          </button>
          <button 
            className={`ecom-tab-btn ${activeTab === 'suppliers' ? 'active' : ''}`}
            onClick={() => setActiveTab('suppliers')}
          >
            <Factory size={16} /> Suppliers & Purchase Orders
          </button>
          <button 
            className={`ecom-tab-btn ${activeTab === 'buyers' ? 'active' : ''}`}
            onClick={() => setActiveTab('buyers')}
          >
            <Users size={16} /> RFM & VIP Loyalty Simulator
          </button>
          <button 
            className={`ecom-tab-btn ${activeTab === 'returns' ? 'active' : ''}`}
            onClick={() => setActiveTab('returns')}
          >
            <RotateCcw size={16} /> Returns & RMA Center
          </button>
          <button 
            className={`ecom-tab-btn ${activeTab === 'fulfillment' ? 'active' : ''}`}
            onClick={() => setActiveTab('fulfillment')}
          >
            <Truck size={16} /> Fulfillment Bus & AI Tracker
          </button>
        </div>

        <div className="plugin-badge-pill ecom">
          <span className="badge-dot ecom"></span>
          <span>@embody/ecom-fulfillment plugin</span>
        </div>
      </div>

      {/* VIEW 1: RETAIL ORDERS & DISPATCH */}
      {activeTab === 'orders' && (
        <div className="ecom-orders-layout">
          <div className="orders-list-side">
            <div className="panel-header">
              <h3>📦 Customer Retail Orders</h3>
              <span className="notion-badge notion-badge-purple">custom_fields JSONB</span>
            </div>

            <div className="orders-cards-grid">
              {orders.map(ord => (
                <div 
                  key={ord.id} 
                  className={`ecom-order-card ${selectedOrder?.id === ord.id ? 'active' : ''}`}
                  onClick={() => setSelectedOrder(ord)}
                >
                  <div className="card-top">
                    <span className="ord-number">{ord.orderNumber}</span>
                    <span className={`notion-badge ${ord.vipTier === 'Gold' ? 'notion-badge-amber' : ord.vipTier === 'Platinum' ? 'notion-badge-purple' : 'notion-badge-gray'}`}>
                      <Star size={11} /> {ord.vipTier} VIP
                    </span>
                  </div>

                  <div className="ord-item-title">{ord.itemTitle}</div>

                  <div className="ord-pricing-row">
                    <span className="orig-price">${ord.originalPrice.toFixed(2)}</span>
                    <span className="final-price text-emerald">${ord.finalPrice.toFixed(2)}</span>
                    {ord.discountApplied !== 'None' && (
                      <span className="discount-tag">{ord.discountApplied}</span>
                    )}
                  </div>

                  <div className="ord-card-footer">
                    <span className="ship-method"><Truck size={12} /> {ord.shippingMethod}</span>
                    <span className="tracking-code font-mono">{ord.trackingNumber}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Shopper Side Peek Drawer */}
          {selectedOrder && (
            <div className="shopper-profile-side panel-box">
              <h3>👤 Shopper 360° Profile</h3>
              <div className="shopper-card">
                <div className="shopper-name">{selectedOrder.shopperName}</div>
                <div className="shopper-email">{selectedOrder.shopperEmail}</div>
                <div className="shopper-badge-row">
                  <span className="notion-badge notion-badge-amber">
                    ⭐ {selectedOrder.vipTier} VIP Shopper
                  </span>
                </div>
              </div>

              <div className="shopper-stats-grid">
                <div className="stat-box">
                  <span className="s-label">Lifetime Orders</span>
                  <span className="s-val">14 Orders</span>
                </div>
                <div className="stat-box">
                  <span className="s-label">Lifetime Value (LTV)</span>
                  <span className="s-val text-emerald">$1,894.20</span>
                </div>
              </div>

              <div className="active-shipment-box">
                <h4>Active Order & Fulfillment Details</h4>
                <div className="detail-line"><span>Order ID:</span> <strong>{selectedOrder.orderNumber}</strong></div>
                <div className="detail-line"><span>Item Purchased:</span> <strong>{selectedOrder.itemTitle}</strong></div>
                <div className="detail-line"><span>Fulfillment Status:</span> <strong className="text-emerald">{selectedOrder.fulfillmentStatus}</strong></div>
                <div className="detail-line"><span>Assigned Tracking #:</span> <strong className="font-mono">{selectedOrder.trackingNumber}</strong></div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* VIEW 2: SUPPLIERS & PURCHASE ORDERS */}
      {activeTab === 'suppliers' && (
        <div className="b2b-view-layout">
          <div className="panel-box">
            <div className="panel-box-header">
              <h3>🏬 Registered Hardware & Component Suppliers</h3>
              <span className="notion-badge notion-badge-blue">Embody Entity: `ecom.supplier`</span>
            </div>

            <table className="crm-table">
              <thead>
                <tr>
                  <th>Supplier Name</th>
                  <th>Category</th>
                  <th>Lead Time</th>
                  <th>MOQ</th>
                  <th>Unit Cost</th>
                  <th>Supplier Rating</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {suppliers.map(sup => (
                  <tr key={sup.id}>
                    <td><strong>{sup.name}</strong></td>
                    <td>{sup.category}</td>
                    <td>{sup.leadTimeDays} days</td>
                    <td>{sup.moq} units</td>
                    <td className="font-mono text-emerald">${sup.unitCost.toFixed(2)}</td>
                    <td><span className="notion-badge notion-badge-amber">★ {sup.rating}</span></td>
                    <td><span className="notion-badge notion-badge-green">{sup.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel-box">
            <div className="panel-box-header">
              <h3>📦 Active Purchase Orders (POs)</h3>
              <span className="notion-badge notion-badge-purple">Inventory Restock Flow</span>
            </div>

            <table className="crm-table">
              <thead>
                <tr>
                  <th>PO Number</th>
                  <th>Supplier</th>
                  <th>Line Items</th>
                  <th>Total Cost</th>
                  <th>Status</th>
                  <th>Expected Date</th>
                </tr>
              </thead>
              <tbody>
                {purchaseOrders.map(po => (
                  <tr key={po.id}>
                    <td><strong className="font-mono">{po.poNumber}</strong></td>
                    <td>{po.supplierName}</td>
                    <td>{po.items}</td>
                    <td className="font-mono text-emerald">${po.totalCost.toLocaleString()}</td>
                    <td><span className="notion-badge notion-badge-blue">{po.status}</span></td>
                    <td>{po.expectedDate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIEW 3: RFM & VIP LOYALTY SIMULATOR */}
      {activeTab === 'buyers' && (
        <div className="checkout-container">
          <div className="panel-box">
            <div className="panel-box-header">
              <h3>⚡ Retail Checkout & VIP Discount Hook Simulator</h3>
              <span className="notion-badge notion-badge-amber">crm.deal.beforeCreate</span>
            </div>
            <p className="subtitle-text">
              Rule: Gold and Platinum VIP shoppers automatically receive a 15% discount pre-commit.
            </p>

            <form onSubmit={handlePlaceOrder} className="checkout-form">
              <div className="form-row">
                <div className="form-group">
                  <label>Shopper Name</label>
                  <input 
                    type="text" 
                    value={shopperName}
                    onChange={e => setShopperName(e.target.value)}
                    required 
                  />
                </div>
                <div className="form-group">
                  <label>Shopper VIP Loyalty Tier</label>
                  <select value={vipTier} onChange={e => setVipTier(e.target.value as EcomOrder['vipTier'])}>
                    <option value="Gold">⭐ Gold VIP (15% Auto-Discount)</option>
                    <option value="Platinum">💎 Platinum VIP (15% Auto-Discount)</option>
                    <option value="Standard">Standard Shopper (No Discount)</option>
                  </select>
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label>Item Name / Product Title</label>
                  <input 
                    type="text" 
                    value={itemTitle}
                    onChange={e => setItemTitle(e.target.value)}
                    required 
                  />
                </div>
                <div className="form-group">
                  <label>Original Store Price ($)</label>
                  <input 
                    type="number" 
                    value={origPrice}
                    onChange={e => setOrigPrice(e.target.value)}
                    required 
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Fulfillment Speed</label>
                <select value={shippingMethod} onChange={e => setShippingMethod(e.target.value as EcomOrder['shippingMethod'])}>
                  <option value="Express Overnight">⚡ Express Overnight (Priority Dispatch)</option>
                  <option value="Standard Ground">📦 Standard Ground (2-3 Days)</option>
                </select>
              </div>

              <div className="hook-preview-banner">
                <div className="preview-label">Live Hook Computation (`crm.deal.beforeCreate`):</div>
                <div className="preview-values">
                  <span>Original Price: <del>${pricePreview.orig.toFixed(2)}</del></span>
                  <span className="arrow">➔</span>
                  <span className="final text-emerald">Final Price: ${pricePreview.finalP.toFixed(2)}</span>
                </div>
                {pricePreview.isVip && (
                  <div className="vip-hook-tag">
                    <Zap size={14} /> 15% VIP Discount Intercepted & Applied Pre-Commit
                  </div>
                )}
              </div>

              <button type="submit" className="btn btn-success full-width mt-16">
                Place Order & Dispatch to Warehouse Event Bus
              </button>
            </form>
          </div>
        </div>
      )}

      {/* VIEW 4: RETURNS & RMA CENTER */}
      {activeTab === 'returns' && (
        <div className="panel-box">
          <div className="panel-box-header">
            <h3>🔄 Return Merchandise Authorization (RMA) Processing</h3>
            <span className="notion-badge notion-badge-rose">Emits `ecom.rma.approved`</span>
          </div>

          <table className="crm-table">
            <thead>
              <tr>
                <th>RMA Code</th>
                <th>Order Ref</th>
                <th>Shopper</th>
                <th>Item Title</th>
                <th>Return Reason</th>
                <th>Refund Amount</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {rmas.map(rma => (
                <tr key={rma.id}>
                  <td><strong className="font-mono">{rma.rmaNumber}</strong></td>
                  <td>{rma.orderNumber}</td>
                  <td>{rma.shopperName}</td>
                  <td>{rma.itemTitle}</td>
                  <td><span className="notion-badge notion-badge-amber">{rma.reason}</span></td>
                  <td className="font-mono text-emerald">${rma.refundAmount.toFixed(2)}</td>
                  <td>
                    <span className={`notion-badge ${rma.status.includes('Approved') ? 'notion-badge-green' : 'notion-badge-amber'}`}>
                      {rma.status}
                    </span>
                  </td>
                  <td>
                    {rma.status !== 'Approved & Restocked' && (
                      <button 
                        className="btn btn-success btn-sm"
                        onClick={() => handleApproveRma(rma.id)}
                      >
                        Approve & Refund
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* VIEW 5: FULFILLMENT EVENT BUS & AI TRACKER */}
      {activeTab === 'fulfillment' && (
        <div className="b2b-view-layout">
          <div className="panel-box">
            <div className="panel-box-header">
              <h3>📡 Event Bus Stream (`crm.deal.created` ➔ `ecom.shipment.dispatched`)</h3>
              <span className="notion-badge notion-badge-blue">Durable Event Bus Subscriber</span>
            </div>

            <div className="event-stream-container">
              {eventLogs.map(ev => (
                <div key={ev.id} className={`event-stream-card ${ev.highlight ? 'highlight' : ''}`}>
                  <div className="ev-time">{ev.time}</div>
                  <div className="ev-name">{ev.name}</div>
                  <div className="ev-details">{ev.details}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="panel-box">
            <div className="panel-box-header">
              <h3>🤖 AI Support Agent Package Tracker (`ecom_track_shipment` MCP Tool)</h3>
              <span className="notion-badge notion-badge-green">Agentic MCP Surface</span>
            </div>

            <form onSubmit={handleSearchTracking} className="tracker-search-form">
              <input 
                type="text" 
                placeholder="Enter Tracking Number (e.g. TRK-981247)..."
                value={searchTrackingNo}
                onChange={e => setSearchTrackingNo(e.target.value)}
              />
              <button type="submit" className="btn btn-primary">
                <Search size={16} /> Lookup Shipment
              </button>
            </form>

            {trackedShipment ? (
              <div className="tracking-results-card">
                <div className="track-header">
                  <div className="t-status">Status: <span className="text-emerald">In Transit</span></div>
                  <div className="t-carrier">Carrier: FedEx Express</div>
                </div>

                <div className="timeline-visual">
                  <div className="timeline-step completed">
                    <CheckCircle2 size={20} />
                    <span>Order Placed</span>
                  </div>
                  <div className="timeline-line completed"></div>
                  <div className="timeline-step completed">
                    <CheckCircle2 size={20} />
                    <span>Warehouse Picked</span>
                  </div>
                  <div className="timeline-line completed"></div>
                  <div className="timeline-step active">
                    <Truck size={20} />
                    <span>Out for Delivery</span>
                  </div>
                  <div className="timeline-line"></div>
                  <div className="timeline-step">
                    <Package size={20} />
                    <span>Delivered</span>
                  </div>
                </div>

                <div className="track-details-box">
                  <div className="t-line"><span>Order #:</span> <strong>{trackedShipment.orderNumber}</strong></div>
                  <div className="t-line"><span>Shopper:</span> <strong>{trackedShipment.shopperName}</strong></div>
                  <div className="t-line"><span>Item:</span> <strong>{trackedShipment.itemTitle}</strong></div>
                  <div className="t-line"><span>Tracking Code:</span> <strong className="font-mono">{trackedShipment.trackingNumber}</strong></div>
                </div>
              </div>
            ) : (
              <div className="track-error-box">
                No shipment found for tracking number '{searchTrackingNo}'. Try searching 'TRK-981247'.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
export default EcomFulfillmentApp;
