import React, { useEffect, useMemo, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, ShoppingBag, LifeBuoy, Boxes, Settings, Search, User } from 'lucide-react';
import { useEcom } from '../data/ecomStore';
import { Dashboard } from './pages/Dashboard';
import { Customers } from './pages/Customers';
import { CustomerDetail } from './pages/CustomerDetail';
import { Orders } from './pages/Orders';
import { OrderDetail } from './pages/OrderDetail';
import { Support } from './pages/Support';
import { TicketDetail } from './pages/TicketDetail';
import { Segments } from './pages/Segments';
import { SettingsPage } from './pages/SettingsPage';

const NAV = [
  { to: '/ecom/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/ecom/customers', label: 'Customers', icon: Users },
  { to: '/ecom/orders', label: 'Orders', icon: ShoppingBag },
  { to: '/ecom/support', label: 'Support', icon: LifeBuoy },
  { to: '/ecom/segments', label: 'Segments', icon: Boxes },
  { to: '/ecom/settings', label: 'Settings', icon: Settings },
];

function CommandPalette({ onClose }: { onClose: () => void }) {
  const { customers, orders, tickets } = useEcom();
  const [q, setQ] = useState('');
  const navigate = useNavigate();
  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return { customers: customers.slice(0, 4), orders: orders.slice(0, 3), tickets: [] as typeof tickets };
    return {
      customers: customers.filter((c) => c.name.toLowerCase().includes(s) || c.email.toLowerCase().includes(s)).slice(0, 5),
      orders: orders.filter((o) => o.number.toLowerCase().includes(s)).slice(0, 5),
      tickets: tickets.filter((t) => t.subject.toLowerCase().includes(s) || t.number.toLowerCase().includes(s)).slice(0, 5),
    };
  }, [q, customers, orders, tickets]);
  const go = (p: string) => { navigate(p); onClose(); };
  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input"><Search size={18} className="text-dim" /><input autoFocus placeholder="Search customers, orders, tickets…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} /></div>
        <div className="cmdk-results">
          {results.customers.length > 0 && <div className="cmdk-group">Customers</div>}
          {results.customers.map((c) => <div key={c.id} className="cmdk-item" onClick={() => go(`/ecom/customers/${c.id}`)}><User size={15} className="text-dim" /> {c.name} <span className="cmdk-type">{c.vipTier}</span></div>)}
          {results.orders.length > 0 && <div className="cmdk-group">Orders</div>}
          {results.orders.map((o) => <div key={o.id} className="cmdk-item" onClick={() => go(`/ecom/orders/${o.id}`)}><ShoppingBag size={15} className="text-dim" /> {o.number} <span className="cmdk-type">order</span></div>)}
          {results.tickets.length > 0 && <div className="cmdk-group">Tickets</div>}
          {results.tickets.map((t) => <div key={t.id} className="cmdk-item" onClick={() => go(`/ecom/support/${t.id}`)}><LifeBuoy size={15} className="text-dim" /> {t.subject} <span className="cmdk-type">{t.number}</span></div>)}
        </div>
      </div>
    </div>
  );
}

export function EcomSection() {
  const [cmdk, setCmdk] = useState(false);
  const { customers, tickets } = useEcom();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdk(true); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const openTickets = tickets.filter((t) => t.status === 'open' || t.status === 'pending').length;

  return (
    <div className="body">
      <aside className="sidebar">
        <div className="global-search" onClick={() => setCmdk(true)} style={{ cursor: 'pointer' }}>
          <Search size={15} /><input readOnly placeholder="Search…" style={{ cursor: 'pointer' }} /><span className="kbd">⌘K</span>
        </div>
        <div className="sidebar-section">Retain</div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-item ecom ${isActive ? 'active' : ''}`}>
            <n.icon size={16} /> {n.label}
            {n.label === 'Customers' && <span className="nav-count">{customers.length}</span>}
            {n.label === 'Support' && <span className="nav-count">{openTickets}</span>}
          </NavLink>
        ))}
        <div className="sidebar-spacer" />
        <div className="sidebar-persona"><strong>Riley Morgan</strong>Retention &amp; CX Manager</div>
      </aside>

      <main className="workspace">
        <Routes>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="customers" element={<Customers />} />
          <Route path="customers/:id" element={<CustomerDetail />} />
          <Route path="orders" element={<Orders />} />
          <Route path="orders/:id" element={<OrderDetail />} />
          <Route path="support" element={<Support />} />
          <Route path="support/:id" element={<TicketDetail />} />
          <Route path="segments" element={<Segments />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="dashboard" replace />} />
        </Routes>
      </main>
      {cmdk && <CommandPalette onClose={() => setCmdk(false)} />}
    </div>
  );
}
