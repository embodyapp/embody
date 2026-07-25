import React, { useState, useMemo } from 'react';
import { 
  Building2, 
  Users, 
  DollarSign, 
  TrendingUp, 
  Plus, 
  Search, 
  Kanban, 
  List, 
  BarChart3, 
  CheckCircle2, 
  Clock, 
  X, 
  ChevronRight,
  Filter,
  ArrowUpRight
} from 'lucide-react';

export interface Deal {
  id: string;
  title: string;
  account: string;
  stage: 'lead' | 'discovery' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost';
  amount: number;
  probability: number;
  contactName: string;
  contactEmail: string;
  createdAt: string;
}

export interface Party {
  id: string;
  name: string;
  type: 'organization' | 'person';
  email?: string;
  phone?: string;
  dealsCount: number;
  totalValue: number;
}

const INITIAL_DEALS: Deal[] = [
  {
    id: 'deal-101',
    title: 'Acme Corp - Enterprise License',
    account: 'Acme Corporation',
    stage: 'negotiation',
    amount: 120000,
    probability: 80,
    contactName: 'Sarah Jenkins',
    contactEmail: 'sarah@acme.com',
    createdAt: '2026-07-20T10:00:00Z',
  },
  {
    id: 'deal-102',
    title: 'Starlight Tech - Mid-Market Plan',
    account: 'Starlight Technologies',
    stage: 'proposal',
    amount: 35000,
    probability: 60,
    contactName: 'David Chen',
    contactEmail: 'david@starlight.io',
    createdAt: '2026-07-21T14:30:00Z',
  },
  {
    id: 'deal-103',
    title: 'Apex Global - Cloud Expansion',
    account: 'Apex Global Logistics',
    stage: 'discovery',
    amount: 48000,
    probability: 40,
    contactName: 'Elena Rostova',
    contactEmail: 'elena@apex.com',
    createdAt: '2026-07-22T09:15:00Z',
  },
  {
    id: 'deal-104',
    title: 'Nexus Soft - Core Subscription',
    account: 'Nexus Software',
    stage: 'lead',
    amount: 18000,
    probability: 20,
    contactName: 'Marcus Vance',
    contactEmail: 'marcus@nexus.net',
    createdAt: '2026-07-23T11:45:00Z',
  },
  {
    id: 'deal-105',
    title: 'Vanguard Systems - Annual SLA',
    account: 'Vanguard Systems',
    stage: 'closed_won',
    amount: 95000,
    probability: 100,
    contactName: 'Rachel Miller',
    contactEmail: 'rachel@vanguard.org',
    createdAt: '2026-07-18T16:20:00Z',
  },
];

const INITIAL_PARTIES: Party[] = [
  { id: 'p-1', name: 'Acme Corporation', type: 'organization', dealsCount: 2, totalValue: 180000 },
  { id: 'p-2', name: 'Starlight Technologies', type: 'organization', dealsCount: 1, totalValue: 35000 },
  { id: 'p-3', name: 'Apex Global Logistics', type: 'organization', dealsCount: 1, totalValue: 48000 },
  { id: 'p-4', name: 'Sarah Jenkins', type: 'person', email: 'sarah@acme.com', phone: '+1 555-0192', dealsCount: 1, totalValue: 120000 },
  { id: 'p-5', name: 'David Chen', type: 'person', email: 'david@starlight.io', phone: '+1 555-0144', dealsCount: 1, totalValue: 35000 },
];

const STAGES: { key: Deal['stage']; label: string; color: string }[] = [
  { key: 'lead', label: 'Lead', color: '#64748b' },
  { key: 'discovery', label: 'Discovery', color: '#3b82f6' },
  { key: 'proposal', label: 'Proposal', color: '#8b5cf6' },
  { key: 'negotiation', label: 'Negotiation', color: '#f59e0b' },
  { key: 'closed_won', label: 'Closed Won', color: '#10b981' },
];

export function CrmApp() {
  const [activeTab, setActiveTab] = useState<'pipeline' | 'parties' | 'analytics'>('pipeline');
  const [deals, setDeals] = useState<Deal[]>(INITIAL_DEALS);
  const [parties, setParties] = useState<Party[]>(INITIAL_PARTIES);
  const [searchQuery, setSearchQuery] = useState('');
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [selectedDeal, setSelectedDeal] = useState<Deal | null>(null);

  // New Deal Form State
  const [newTitle, setNewTitle] = useState('');
  const [newAccount, setNewAccount] = useState('');
  const [newAmount, setNewAmount] = useState('50000');
  const [newStage, setNewStage] = useState<Deal['stage']>('lead');

  // Metrics
  const pipelineMetrics = useMemo(() => {
    const totalVal = deals.reduce((acc, d) => acc + (d.stage !== 'closed_lost' ? d.amount : 0), 0);
    const wonVal = deals.filter(d => d.stage === 'closed_won').reduce((acc, d) => acc + d.amount, 0);
    const activeCount = deals.filter(d => d.stage !== 'closed_won' && d.stage !== 'closed_lost').length;
    const winRate = Math.round((wonVal / (totalVal || 1)) * 100);
    return { totalVal, wonVal, activeCount, winRate };
  }, [deals]);

  // Filtered Deals
  const filteredDeals = useMemo(() => {
    if (!searchQuery.trim()) return deals;
    const q = searchQuery.toLowerCase();
    return deals.filter(d => d.title.toLowerCase().includes(q) || d.account.toLowerCase().includes(q));
  }, [deals, searchQuery]);

  // Handle Move Stage
  const handleMoveStage = (id: string, nextStage: Deal['stage']) => {
    setDeals(prev => prev.map(d => {
      if (d.id === id) {
        const prob = nextStage === 'closed_won' ? 100 : nextStage === 'negotiation' ? 80 : nextStage === 'proposal' ? 60 : 40;
        return { ...d, stage: nextStage, probability: prob };
      }
      return d;
    }));
  };

  // Handle Add Deal
  const handleCreateDeal = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newAccount.trim()) return;

    const created: Deal = {
      id: `deal-${Date.now()}`,
      title: newTitle,
      account: newAccount,
      stage: newStage,
      amount: Number(newAmount) || 0,
      probability: 40,
      contactName: 'Primary Contact',
      contactEmail: `contact@${newAccount.toLowerCase().replace(/\s+/g, '')}.com`,
      createdAt: new Date().toISOString(),
    };

    setDeals(prev => [created, ...prev]);
    setNewTitle('');
    setNewAccount('');
    setNewAmount('50000');
    setIsModalOpen(false);
  };

  return (
    <div className="crm-react-container">
      {/* Subheader Toolbar */}
      <div className="crm-toolbar">
        <div className="crm-tab-buttons">
          <button 
            className={`crm-tab-btn ${activeTab === 'pipeline' ? 'active' : ''}`}
            onClick={() => setActiveTab('pipeline')}
          >
            <Kanban size={16} /> Pipeline Kanban
          </button>
          <button 
            className={`crm-tab-btn ${activeTab === 'parties' ? 'active' : ''}`}
            onClick={() => setActiveTab('parties')}
          >
            <Users size={16} /> Parties & Accounts ({parties.length})
          </button>
          <button 
            className={`crm-tab-btn ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <BarChart3 size={16} /> Sales Analytics
          </button>
        </div>

        <div className="crm-toolbar-actions">
          <div className="search-input-wrapper">
            <Search size={15} className="search-icon" />
            <input 
              type="text" 
              placeholder="Search deals, accounts..."
              value={searchQuery}
              onChange={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
            />
          </div>
          <button className="btn btn-primary" onClick={() => setIsModalOpen(true)}>
            <Plus size={16} /> New Deal
          </button>
        </div>
      </div>

      {/* KPI Cards Row */}
      <div className="kpi-row">
        <div className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-label">Pipeline Total Value</span>
            <DollarSign className="kpi-icon text-blue" size={18} />
          </div>
          <div className="kpi-value">${pipelineMetrics.totalVal.toLocaleString()}</div>
          <div className="kpi-subtext text-emerald">↑ 14% vs last month</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-label">Closed Won Revenue</span>
            <CheckCircle2 className="kpi-icon text-emerald" size={18} />
          </div>
          <div className="kpi-value">${pipelineMetrics.wonVal.toLocaleString()}</div>
          <div className="kpi-subtext text-muted">{deals.filter(d => d.stage === 'closed_won').length} deals closed</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-label">Active Opportunities</span>
            <Clock className="kpi-icon text-amber" size={18} />
          </div>
          <div className="kpi-value">{pipelineMetrics.activeCount}</div>
          <div className="kpi-subtext text-muted">In active negotiation</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-header">
            <span className="kpi-label">Win Ratio</span>
            <TrendingUp className="kpi-icon text-purple" size={18} />
          </div>
          <div className="kpi-value">{pipelineMetrics.winRate}%</div>
          <div className="kpi-subtext text-purple">High velocity pipeline</div>
        </div>
      </div>

      {/* VIEW: PIPELINE KANBAN */}
      {activeTab === 'pipeline' && (
        <div className="kanban-stage-board">
          {STAGES.map(stage => {
            const stageDeals = filteredDeals.filter(d => d.stage === stage.key);
            const stageSum = stageDeals.reduce((a, b) => a + b.amount, 0);

            return (
              <div key={stage.key} className="kanban-col">
                <div className="col-header">
                  <div className="col-title-group">
                    <span className="col-color-dot" style={{ backgroundColor: stage.color }}></span>
                    <span className="col-name">{stage.label}</span>
                    <span className="col-badge">{stageDeals.length}</span>
                  </div>
                  <span className="col-sum">${stageSum.toLocaleString()}</span>
                </div>

                <div className="col-cards-list">
                  {stageDeals.map(deal => (
                    <div key={deal.id} className="deal-kanban-card" onClick={() => setSelectedDeal(deal)}>
                      <div className="card-top">
                        <span className="card-account">{deal.account}</span>
                        <span className="card-prob">{deal.probability}%</span>
                      </div>
                      <div className="card-title">{deal.title}</div>
                      <div className="card-bottom">
                        <span className="card-amount">${deal.amount.toLocaleString()}</span>
                        
                        {/* Quick Stage Controls */}
                        <div className="quick-stage-menu" onClick={e => e.stopPropagation()}>
                          {stage.key !== 'closed_won' && (
                            <button 
                              className="btn-nano" 
                              title="Advance to next stage"
                              onClick={() => {
                                const nextMap: Record<Deal['stage'], Deal['stage']> = {
                                  lead: 'discovery',
                                  discovery: 'proposal',
                                  proposal: 'negotiation',
                                  negotiation: 'closed_won',
                                  closed_won: 'closed_won',
                                  closed_lost: 'closed_lost',
                                };
                                handleMoveStage(deal.id, nextMap[deal.stage]);
                              }}
                            >
                              Advance <ChevronRight size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* VIEW: PARTIES DIRECTORY */}
      {activeTab === 'parties' && (
        <div className="panel-box">
          <div className="panel-box-header">
            <h3>🏢 Unified Parties System of Record (`core.parties`)</h3>
            <span className="pill-info">Single source of truth for accounts & contacts</span>
          </div>

          <table className="crm-table">
            <thead>
              <tr>
                <th>Entity Name</th>
                <th>Type</th>
                <th>Contact Info</th>
                <th>Associated Deals</th>
                <th>Total Value</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {parties.map(party => (
                <tr key={party.id}>
                  <td>
                    <div className="entity-cell">
                      {party.type === 'organization' ? <Building2 size={16} className="text-blue" /> : <Users size={16} className="text-purple" />}
                      <strong>{party.name}</strong>
                    </div>
                  </td>
                  <td>
                    <span className={`tag ${party.type === 'organization' ? 'tag-info' : 'tag-success'}`}>
                      {party.type}
                    </span>
                  </td>
                  <td>{party.email || party.phone || 'Primary Corporate'}</td>
                  <td>{party.dealsCount} active deal(s)</td>
                  <td className="font-mono">${party.totalValue.toLocaleString()}</td>
                  <td>
                    <button className="btn btn-secondary btn-sm">View 360° Profile</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* VIEW: SALES ANALYTICS */}
      {activeTab === 'analytics' && (
        <div className="analytics-grid">
          <div className="panel-box">
            <h3>📈 Pipeline Value Breakdown by Stage</h3>
            <div className="bar-chart-mock">
              {STAGES.map(stage => {
                const sum = deals.filter(d => d.stage === stage.key).reduce((a, b) => a + b.amount, 0);
                const pct = Math.min(100, Math.round((sum / (pipelineMetrics.totalVal || 1)) * 100));
                return (
                  <div key={stage.key} className="chart-bar-row">
                    <span className="bar-label">{stage.label} (${sum.toLocaleString()})</span>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${pct}%`, backgroundColor: stage.color }}></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="panel-box">
            <h3>⚡ Revenue Forecast & Win Velocity</h3>
            <div className="metric-box-group">
              <div className="metric-row">
                <span>Weighted Expected Value:</span>
                <strong className="text-emerald">
                  ${deals.reduce((a, d) => a + (d.amount * d.probability / 100), 0).toLocaleString()}
                </strong>
              </div>
              <div className="metric-row">
                <span>Average Deal Size:</span>
                <strong>${Math.round(pipelineMetrics.totalVal / (deals.length || 1)).toLocaleString()}</strong>
              </div>
              <div className="metric-row">
                <span>Sales Velocity Score:</span>
                <strong className="text-blue">94.2 pts</strong>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* NEW DEAL MODAL */}
      {isModalOpen && (
        <div className="modal-overlay" onClick={() => setIsModalOpen(false)}>
          <div className="modal-content" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3>Create New Deal Opportunity</h3>
              <button className="close-btn" onClick={() => setIsModalOpen(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleCreateDeal}>
              <div className="form-group">
                <label>Deal Title</label>
                <input 
                  type="text" 
                  placeholder="e.g. Enterprise License Expansion"
                  value={newTitle}
                  onChange={e => setNewTitle((e.target as HTMLInputElement).value)}
                  required 
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Account / Company</label>
                  <input 
                    type="text" 
                    placeholder="e.g. Acme Corp"
                    value={newAccount}
                    onChange={e => setNewAccount((e.target as HTMLInputElement).value)}
                    required 
                  />
                </div>
                <div className="form-group">
                  <label>Amount ($)</label>
                  <input 
                    type="number" 
                    value={newAmount}
                    onChange={e => setNewAmount((e.target as HTMLInputElement).value)}
                    required 
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Initial Stage</label>
                <select value={newStage} onChange={e => setNewStage((e.target as HTMLSelectElement).value as Deal['stage'])}>
                  {STAGES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" onClick={() => setIsModalOpen(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Create Deal</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
