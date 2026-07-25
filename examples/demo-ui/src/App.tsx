import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { Zap, Briefcase, ShoppingBag, Layers, WifiOff } from 'lucide-react';
import { ToastProvider } from './ui/Toast';
import { B2bProvider } from './data/b2bStore';
import { EcomProvider } from './data/ecomStore';
import { CustomizationProvider } from './copilot/customization';
import { CopilotProvider } from './copilot/CopilotProvider';
import { CopilotLauncher } from './copilot/CopilotPanel';
import { B2bSection } from './b2b/B2bSection';
import { EcomSection } from './ecom/EcomSection';

function TopBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const section = location.pathname.startsWith('/ecom') ? 'ecom' : 'b2b';

  return (
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark"><Zap size={20} /></div>
        <div>
          <span className="brand-name">embody</span>
          <span className="brand-sub">Business OS · CRM</span>
        </div>
      </div>

      <div className="app-switch" role="tablist" aria-label="Choose CRM">
        <button
          className={`app-switch-btn b2b ${section === 'b2b' ? 'active' : ''}`}
          onClick={() => navigate('/b2b')}
        >
          <Briefcase size={16} /> <span className="tab-label">B2B SaaS CRM</span>
        </button>
        <button
          className={`app-switch-btn ecom ${section === 'ecom' ? 'active' : ''}`}
          onClick={() => navigate('/ecom')}
        >
          <ShoppingBag size={16} /> <span className="tab-label">E-Commerce CRM</span>
        </button>
      </div>

      <div className="topbar-right">
        <span className="mode-pill" title="Data is served from the in-browser demo store; edits persist to localStorage.">
          <WifiOff size={13} /> Demo data
        </span>
        <div className="tenant-pill">
          <Layers size={13} />
          <span>Org: <code>demo</code></span>
        </div>
      </div>
    </header>
  );
}

export function App() {
  return (
    <ToastProvider>
      <B2bProvider>
        <EcomProvider>
          <CustomizationProvider>
            <BrowserRouter>
              <CopilotProvider>
                <div className="shell">
                  <TopBar />
                  <Routes>
                    <Route path="/" element={<Navigate to="/b2b" replace />} />
                    <Route path="/b2b/*" element={<B2bSection />} />
                    <Route path="/ecom/*" element={<EcomSection />} />
                    <Route path="*" element={<Navigate to="/b2b" replace />} />
                  </Routes>
                </div>
                <CopilotLauncher />
              </CopilotProvider>
            </BrowserRouter>
          </CustomizationProvider>
        </EcomProvider>
      </B2bProvider>
    </ToastProvider>
  );
}

export default App;
export { NavLink };
