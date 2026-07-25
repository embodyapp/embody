import React, { useEffect, useMemo, useState } from 'react';
import { Routes, Route, NavLink, Navigate, useNavigate } from 'react-router-dom';
import { LayoutDashboard, KanbanSquare, Building2, Users, BarChart3, Settings, Search, Briefcase } from 'lucide-react';
import { useB2b } from '../data/b2bStore';
import { Dashboard } from './pages/Dashboard';
import { Pipeline } from './pages/Pipeline';
import { DealDetail } from './pages/DealDetail';
import { Accounts } from './pages/Accounts';
import { AccountDetail } from './pages/AccountDetail';
import { Contacts } from './pages/Contacts';
import { Reports } from './pages/Reports';
import { SettingsPage } from './pages/SettingsPage';

const NAV = [
  { to: '/b2b/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/b2b/pipeline', label: 'Pipeline', icon: KanbanSquare },
  { to: '/b2b/accounts', label: 'Accounts', icon: Building2 },
  { to: '/b2b/contacts', label: 'Contacts', icon: Users },
  { to: '/b2b/reports', label: 'Reports', icon: BarChart3 },
  { to: '/b2b/settings', label: 'Settings', icon: Settings },
];

function CommandPalette({ onClose }: { onClose: () => void }) {
  const { accounts, deals, contacts } = useB2b();
  const [q, setQ] = useState('');
  const navigate = useNavigate();

  const results = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return { accounts: accounts.slice(0, 4), deals: deals.slice(0, 4), contacts: [] as typeof contacts };
    return {
      accounts: accounts.filter((a) => a.name.toLowerCase().includes(s)).slice(0, 5),
      deals: deals.filter((d) => d.name.toLowerCase().includes(s)).slice(0, 5),
      contacts: contacts.filter((c) => c.name.toLowerCase().includes(s)).slice(0, 5),
    };
  }, [q, accounts, deals, contacts]);

  const go = (path: string) => { navigate(path); onClose(); };

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk" onClick={(e) => e.stopPropagation()}>
        <div className="cmdk-input">
          <Search size={18} className="text-dim" />
          <input autoFocus placeholder="Search accounts, deals, contacts…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} />
        </div>
        <div className="cmdk-results">
          {results.accounts.length > 0 && <div className="cmdk-group">Accounts</div>}
          {results.accounts.map((a) => (
            <div key={a.id} className="cmdk-item" onClick={() => go(`/b2b/accounts/${a.id}`)}>
              <Building2 size={15} className="text-dim" /> {a.name} <span className="cmdk-type">account</span>
            </div>
          ))}
          {results.deals.length > 0 && <div className="cmdk-group">Deals</div>}
          {results.deals.map((d) => (
            <div key={d.id} className="cmdk-item" onClick={() => go(`/b2b/deals/${d.id}`)}>
              <Briefcase size={15} className="text-dim" /> {d.name} <span className="cmdk-type">deal</span>
            </div>
          ))}
          {results.contacts.length > 0 && <div className="cmdk-group">Contacts</div>}
          {results.contacts.map((c) => (
            <div key={c.id} className="cmdk-item" onClick={() => go(`/b2b/accounts/${c.accountId}`)}>
              <Users size={15} className="text-dim" /> {c.name} <span className="cmdk-type">contact</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function B2bSection() {
  const [cmdk, setCmdk] = useState(false);
  const { deals, accounts } = useB2b();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCmdk(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const openCount = deals.filter((d) => d.stage !== 'closed_won' && d.stage !== 'closed_lost').length;

  return (
    <div className="body">
      <aside className="sidebar">
        <div className="global-search" onClick={() => setCmdk(true)} style={{ cursor: 'pointer' }}>
          <Search size={15} />
          <input readOnly placeholder="Search…" style={{ cursor: 'pointer' }} />
          <span className="kbd">⌘K</span>
        </div>
        <div className="sidebar-section">Sell</div>
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} className={({ isActive }) => `nav-item b2b ${isActive ? 'active' : ''}`}>
            <n.icon size={16} /> {n.label}
            {n.label === 'Pipeline' && <span className="nav-count">{openCount}</span>}
            {n.label === 'Accounts' && <span className="nav-count">{accounts.length}</span>}
          </NavLink>
        ))}
        <div className="sidebar-spacer" />
        <div className="sidebar-persona">
          <strong>Alex Rivera</strong>
          Account Executive · West
        </div>
      </aside>

      <main className="workspace">
        <Routes>
          <Route index element={<Navigate to="dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="pipeline" element={<Pipeline />} />
          <Route path="deals/:id" element={<DealDetail />} />
          <Route path="accounts" element={<Accounts />} />
          <Route path="accounts/:id" element={<AccountDetail />} />
          <Route path="contacts" element={<Contacts />} />
          <Route path="reports" element={<Reports />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="dashboard" replace />} />
        </Routes>
      </main>

      {cmdk && <CommandPalette onClose={() => setCmdk(false)} />}
    </div>
  );
}
