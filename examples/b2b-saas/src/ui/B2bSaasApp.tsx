import React, { useState, useMemo } from 'react';
import { 
  ShieldCheck, 
  ShieldAlert, 
  Calculator, 
  FileText, 
  TrendingUp, 
  DollarSign, 
  Lock, 
  Sparkles, 
  Check, 
  X, 
  ChevronRight,
  Kanban,
  Table as TableIcon,
  BarChart3,
  Users,
  MessageSquare,
  Building,
  Calendar,
  AlertCircle,
  FileCheck,
  Zap,
  Filter,
  SlidersHorizontal,
  Search,
  Plus
} from 'lucide-react';

export interface B2bDeal {
  id: string;
  title: string;
  account: string;
  stage: 'discovery' | 'proposal' | 'negotiation' | 'closed_won' | 'closed_lost';
  amount: number;
  arr: number;
  contractMonths: number;
  securityReviewPassed: boolean;
  dpaSigned: boolean;
  slaLevel: 'Standard' | 'Gold' | 'Platinum';
  seats: number;
  owner: string;
  closeDate: string;
}

export interface Stakeholder {
  id: string;
  name: string;
  role: 'Executive Sponsor' | 'Champion' | 'Procurement' | 'InfoSec Officer' | 'Technical Evaluator';
  email: string;
  account: string;
  engagementScore: number;
}

export interface InteractionLog {
  id: string;
  timestamp: string;
  type: 'Email' | 'Call' | 'Security Review' | 'Contract Redline' | 'Demo';
  title: string;
  account: string;
  author: string;
  summary: string;
}

const INITIAL_DEALS: B2bDeal[] = [
  {
    id: 'b2b-101',
    title: 'Acme Corp - 500 Enterprise Seats',
    account: 'Acme Corporation',
    stage: 'negotiation',
    amount: 120000,
    arr: 120000,
    contractMonths: 24,
    securityReviewPassed: false,
    dpaSigned: false,
    slaLevel: 'Platinum',
    seats: 500,
    owner: 'Sarah Jenkins',
    closeDate: '2026-08-15',
  },
  {
    id: 'b2b-102',
    title: 'Starlight Tech - 150 Pro Seats',
    account: 'Starlight Technologies',
    stage: 'proposal',
    amount: 35000,
    arr: 35000,
    contractMonths: 12,
    securityReviewPassed: true,
    dpaSigned: true,
    slaLevel: 'Gold',
    seats: 150,
    owner: 'Alex Rivera',
    closeDate: '2026-08-01',
  },
  {
    id: 'b2b-103',
    title: 'Vanguard Systems - 1,000 Global Seats',
    account: 'Vanguard Systems',
    stage: 'negotiation',
    amount: 240000,
    arr: 240000,
    contractMonths: 36,
    securityReviewPassed: true,
    dpaSigned: true,
    slaLevel: 'Platinum',
    seats: 1000,
    owner: 'Sarah Jenkins',
    closeDate: '2026-08-30',
  },
  {
    id: 'b2b-104',
    title: 'Nexus Data - 250 Security Seats',
    account: 'Nexus Data Corp',
    stage: 'discovery',
    amount: 60000,
    arr: 60000,
    contractMonths: 12,
    securityReviewPassed: false,
    dpaSigned: false,
    slaLevel: 'Gold',
    seats: 250,
    owner: 'Michael Chen',
    closeDate: '2026-09-10',
  },
  {
    id: 'b2b-105',
    title: 'OmniGlobal - 2,000 Enterprise Seats',
    account: 'OmniGlobal Inc',
    stage: 'closed_won',
    amount: 480000,
    arr: 480000,
    contractMonths: 24,
    securityReviewPassed: true,
    dpaSigned: true,
    slaLevel: 'Platinum',
    seats: 2000,
    owner: 'Alex Rivera',
    closeDate: '2026-07-20',
  },
];

const INITIAL_STAKEHOLDERS: Stakeholder[] = [
  { id: 'stk-1', name: 'Eleanor Vance', role: 'Executive Sponsor', email: 'e.vance@acme.com', account: 'Acme Corporation', engagementScore: 92 },
  { id: 'stk-2', name: 'David Kim', role: 'InfoSec Officer', email: 'd.kim@acme.com', account: 'Acme Corporation', engagementScore: 65 },
  { id: 'stk-3', name: 'Rachel Green', role: 'Champion', email: 'rachel@starlight.tech', account: 'Starlight Technologies', engagementScore: 98 },
  { id: 'stk-4', name: 'Marcus Brody', role: 'Procurement', email: 'brody@vanguard.io', account: 'Vanguard Systems', engagementScore: 85 },
];

const INITIAL_LOGS: InteractionLog[] = [
  { id: 'log-1', timestamp: 'Today, 14:20', type: 'Security Review', title: 'SOC2 & Architecture Assessment', account: 'Acme Corporation', author: 'David Kim (InfoSec)', summary: 'Submitted vendor security questionnaire. Awaiting DPA signature approval.' },
  { id: 'log-2', timestamp: 'Yesterday, 11:00', type: 'Call', title: 'Executive Alignment & Multi-Year Pricing', account: 'Vanguard Systems', author: 'Sarah Jenkins', summary: 'Agreed on 36-month term with 15% commitment discount. Procurement reviewing legal terms.' },
  { id: 'log-3', timestamp: 'Jul 22, 16:45', type: 'Demo', title: 'Platform Capabilities Walkthrough', account: 'Nexus Data Corp', author: 'Michael Chen', summary: 'Demonstrated Embody custom entities and REST API plugin extensions to tech leads.' },
];

export function B2bSaasApp() {
  const [activeTab, setActiveTab] = useState<'pipeline' | 'analytics' | 'contracts' | 'cpq' | 'stakeholders'>('pipeline');
  const [pipelineDisplayMode, setPipelineDisplayMode] = useState<'kanban' | 'table'>('kanban');
  const [deals, setDeals] = useState<B2bDeal[]>(INITIAL_DEALS);
  const [selectedDeal, setSelectedDeal] = useState<B2bDeal | null>(null);

  // Veto Hook Modal State
  const [vetoModalOpen, setVetoModalOpen] = useState(false);
  const [vetoDeal, setVetoDeal] = useState<B2bDeal | null>(null);

  // Search & Filter
  const [searchQuery, setSearchQuery] = useState('');
  const [filterOwner, setFilterOwner] = useState<string>('all');

  // CPQ Calculator State
  const [cpqSeats, setCpqSeats] = useState(500);
  const [cpqPricePerSeat, setCpqPricePerSeat] = useState(240);
  const [cpqMonths, setCpqMonths] = useState(24);
  const [includeCsm, setIncludeCsm] = useState(true);

  // CPQ Output Calculation (Uses b2b.pricing DI service calculation)
  const cpqQuote = useMemo(() => {
    const rawArr = cpqSeats * cpqPricePerSeat + (includeCsm ? 15000 : 0);
    const hasDiscount = cpqMonths >= 24;
    const discountedArr = hasDiscount ? rawArr * 0.85 : rawArr;
    const tcv = (discountedArr / 12) * cpqMonths;
    return { rawArr, discountedArr, tcv, hasDiscount };
  }, [cpqSeats, cpqPricePerSeat, cpqMonths, includeCsm]);

  // Filtered Deals
  const filteredDeals = useMemo(() => {
    return deals.filter(d => {
      const matchesSearch = d.title.toLowerCase().includes(searchQuery.toLowerCase()) || d.account.toLowerCase().includes(searchQuery.toLowerCase());
      const matchesOwner = filterOwner === 'all' || d.owner === filterOwner;
      return matchesSearch && matchesOwner;
    });
  }, [deals, searchQuery, filterOwner]);

  // Handle Stage Update with InfoSec Veto
  const handleStageChange = (deal: B2bDeal, targetStage: B2bDeal['stage']) => {
    if (targetStage === 'closed_won' && deal.amount >= 50000 && !deal.securityReviewPassed) {
      // VETO TRIGGERED BY HOOK crm.deal.beforeUpdate
      setVetoDeal(deal);
      setVetoModalOpen(true);
      return;
    }

    setDeals(prev => prev.map(d => d.id === deal.id ? { ...d, stage: targetStage } : d));
  };

  // Toggle Security Review Passed in Modal
  const handlePassSecurity = () => {
    if (!vetoDeal) return;
    setDeals(prev => prev.map(d => {
      if (d.id === vetoDeal.id) {
        return { ...d, securityReviewPassed: true, dpaSigned: true, stage: 'closed_won' };
      }
      return d;
    }));
    setVetoModalOpen(false);
    setVetoDeal(null);
  };

  return (
    <div className="b2b-react-container">
      {/* Subheader Toolbar & Notion View Selector */}
      <div className="b2b-toolbar">
        <div className="b2b-tab-buttons">
          <button 
            className={`b2b-tab-btn ${activeTab === 'pipeline' ? 'active' : ''}`}
            onClick={() => setActiveTab('pipeline')}
          >
            <Kanban size={16} /> Pipeline & Deals
          </button>
          <button 
            className={`b2b-tab-btn ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <BarChart3 size={16} /> ARR & Pipeline Analytics
          </button>
          <button 
            className={`b2b-tab-btn ${activeTab === 'contracts' ? 'active' : ''}`}
            onClick={() => setActiveTab('contracts')}
          >
            <FileCheck size={16} /> Contracts & InfoSec Gates
          </button>
          <button 
            className={`b2b-tab-btn ${activeTab === 'cpq' ? 'active' : ''}`}
            onClick={() => setActiveTab('cpq')}
          >
            <Calculator size={16} /> CPQ & Quote Engine
          </button>
          <button 
            className={`b2b-tab-btn ${activeTab === 'stakeholders' ? 'active' : ''}`}
            onClick={() => setActiveTab('stakeholders')}
          >
            <Users size={16} /> Stakeholders & Activity
          </button>
        </div>

        <div className="plugin-badge-pill">
          <span className="badge-dot"></span>
          <span>embody-plugin-b2b-saas plugin</span>
        </div>
      </div>

      {/* VIEW 1: PIPELINE & DEALS */}
      {activeTab === 'pipeline' && (
        <div className="b2b-view-layout">
          {/* Notion Database Filter Bar */}
          <div className="notion-db-header">
            <div className="notion-view-tabs">
              <button 
                className={`notion-view-tab ${pipelineDisplayMode === 'kanban' ? 'active' : ''}`}
                onClick={() => setPipelineDisplayMode('kanban')}
              >
                <Kanban size={14} /> Board View
              </button>
              <button 
                className={`notion-view-tab ${pipelineDisplayMode === 'table' ? 'active' : ''}`}
                onClick={() => setPipelineDisplayMode('table')}
              >
                <TableIcon size={14} /> Database Table
              </button>
            </div>

            <div className="search-input-wrapper">
              <Search size={14} className="search-icon" />
              <input 
                type="text" 
                placeholder="Filter deals or accounts..." 
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
              />
            </div>
          </div>

          {/* Rules Banner */}
          <div className="notion-callout warning">
            <ShieldAlert size={20} className="text-amber" />
            <div>
              <strong>Embody Vetoable Domain Hook Active: <code>crm.deal.beforeUpdate</code></strong>
              <p>Rule: Deals over $50,000 require approved Security Review & DPA clearance before moving to 'Closed Won'.</p>
            </div>
          </div>

          {/* KANBAN BOARD DISPLAY */}
          {pipelineDisplayMode === 'kanban' && (
            <div className="kanban-stage-board">
              {(['discovery', 'proposal', 'negotiation', 'closed_won', 'closed_lost'] as const).map(stage => {
                const stageDeals = filteredDeals.filter(d => d.stage === stage);
                const stageSum = stageDeals.reduce((sum, d) => sum + d.arr, 0);

                return (
                  <div key={stage} className="kanban-col">
                    <div className="col-header">
                      <div className="col-title-group">
                        <span className={`col-color-dot ${stage}`} />
                        <span className="text-capitalize">{stage.replace('_', ' ')}</span>
                        <span className="col-badge">{stageDeals.length}</span>
                      </div>
                      <span className="col-sum">${(stageSum / 1000).toFixed(0)}k ARR</span>
                    </div>

                    {stageDeals.map(deal => (
                      <div 
                        key={deal.id} 
                        className="deal-kanban-card"
                        onClick={() => setSelectedDeal(deal)}
                      >
                        <div className="card-top">
                          <span>{deal.account}</span>
                          <span className={`notion-badge ${deal.securityReviewPassed ? 'notion-badge-green' : 'notion-badge-amber'}`}>
                            {deal.securityReviewPassed ? <ShieldCheck size={11} /> : <Lock size={11} />}
                            {deal.securityReviewPassed ? 'InfoSec Passed' : 'InfoSec Pending'}
                          </span>
                        </div>

                        <div className="card-title">{deal.title}</div>

                        <div className="b2b-tags-list">
                          <span className="notion-badge notion-badge-purple">{deal.seats} Seats</span>
                          <span className="notion-badge notion-badge-blue">{deal.contractMonths}m Term</span>
                        </div>

                        <div className="card-bottom">
                          <span className="card-amount">${deal.arr.toLocaleString()} ARR</span>
                          {deal.stage !== 'closed_won' ? (
                            <button 
                              className="btn btn-primary btn-nano"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleStageChange(deal, 'closed_won');
                              }}
                            >
                              Win Deal
                            </button>
                          ) : (
                            <span className="notion-badge notion-badge-green"><Check size={11} /> Closed Won</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          )}

          {/* TABLE DISPLAY */}
          {pipelineDisplayMode === 'table' && (
            <div className="panel-box">
              <table className="crm-table">
                <thead>
                  <tr>
                    <th>Account</th>
                    <th>Deal Title</th>
                    <th>Stage</th>
                    <th>Annual ARR</th>
                    <th>Seats</th>
                    <th>Term</th>
                    <th>InfoSec Gate</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDeals.map(deal => (
                    <tr key={deal.id} onClick={() => setSelectedDeal(deal)} style={{ cursor: 'pointer' }}>
                      <td><strong>{deal.account}</strong></td>
                      <td>{deal.title}</td>
                      <td>
                        <span className={`notion-badge ${deal.stage === 'closed_won' ? 'notion-badge-green' : 'notion-badge-blue'}`}>
                          {deal.stage.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="font-mono text-emerald">${deal.arr.toLocaleString()}</td>
                      <td>{deal.seats}</td>
                      <td>{deal.contractMonths} mos</td>
                      <td>
                        <span className={`notion-badge ${deal.securityReviewPassed ? 'notion-badge-green' : 'notion-badge-amber'}`}>
                          {deal.securityReviewPassed ? <ShieldCheck size={12} /> : <Lock size={12} />}
                          {deal.securityReviewPassed ? 'Approved' : 'Pending'}
                        </span>
                      </td>
                      <td>
                        {deal.stage !== 'closed_won' && (
                          <button 
                            className="btn btn-secondary btn-sm"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleStageChange(deal, 'closed_won');
                            }}
                          >
                            Mark Won
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* VIEW 2: ARR & PIPELINE ANALYTICS */}
      {activeTab === 'analytics' && (
        <div className="b2b-view-layout">
          <div className="kpi-row">
            <div className="kpi-card">
              <div className="kpi-header">
                <span className="kpi-label">Total Active Pipeline ARR</span>
                <TrendingUp size={16} className="text-emerald" />
              </div>
              <div className="kpi-value text-emerald">$935,000</div>
              <div className="kpi-subtext text-muted">+24% vs last quarter</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-header">
                <span className="kpi-label">Average Contract Value (ACV)</span>
                <DollarSign size={16} className="text-purple" />
              </div>
              <div className="kpi-value text-purple">$187,000</div>
              <div className="kpi-subtext text-muted">24-month avg commitment</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-header">
                <span className="kpi-label">Win/Loss Conversion</span>
                <Check size={16} className="text-blue" />
              </div>
              <div className="kpi-value text-blue">78.4%</div>
              <div className="kpi-subtext text-muted">High intent enterprise leads</div>
            </div>

            <div className="kpi-card">
              <div className="kpi-header">
                <span className="kpi-label">Avg Sales Cycle Length</span>
                <Calendar size={16} className="text-amber" />
              </div>
              <div className="kpi-value text-amber">34 Days</div>
              <div className="kpi-subtext text-muted">InfoSec review takes avg 9d</div>
            </div>
          </div>

          <div className="panel-box">
            <div className="panel-box-header">
              <h3>📈 ARR Breakdown by Pipeline Stage</h3>
              <span className="notion-badge notion-badge-blue">Embody Plugin REST Query</span>
            </div>

            <table className="crm-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Deal Count</th>
                  <th>Total Pipeline ARR</th>
                  <th>Weighted ARR (Probability)</th>
                  <th>Stage Health</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td><strong>Discovery</strong></td>
                  <td>1 Deal</td>
                  <td>$60,000</td>
                  <td>$12,000 (20%)</td>
                  <td><span className="notion-badge notion-badge-blue">Normal</span></td>
                </tr>
                <tr>
                  <td><strong>Proposal</strong></td>
                  <td>1 Deal</td>
                  <td>$35,000</td>
                  <td>$17,500 (50%)</td>
                  <td><span className="notion-badge notion-badge-green">High Engagement</span></td>
                </tr>
                <tr>
                  <td><strong>Negotiation</strong></td>
                  <td>2 Deals</td>
                  <td>$360,000</td>
                  <td>$288,000 (80%)</td>
                  <td><span className="notion-badge notion-badge-amber">InfoSec Pending</span></td>
                </tr>
                <tr>
                  <td><strong>Closed Won</strong></td>
                  <td>1 Deal</td>
                  <td>$480,000</td>
                  <td>$480,000 (100%)</td>
                  <td><span className="notion-badge notion-badge-green">Active ARR</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* VIEW 3: CONTRACTS & INFOSEC GATES */}
      {activeTab === 'contracts' && (
        <div className="panel-box">
          <div className="panel-box-header">
            <h3>📑 Active Enterprise Contracts & Event Bus</h3>
            <span className="notion-badge notion-badge-purple">Emits `b2b.contract.signed`</span>
          </div>

          <table className="crm-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Contract Term</th>
                <th>Annual ARR</th>
                <th>InfoSec Clearance</th>
                <th>DPA / SOC2</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {deals.map(deal => (
                <tr key={deal.id}>
                  <td><strong>{deal.account}</strong></td>
                  <td>{deal.contractMonths} Months</td>
                  <td className="font-mono text-emerald">${deal.arr.toLocaleString()}</td>
                  <td>
                    {deal.securityReviewPassed ? (
                      <span className="notion-badge notion-badge-green"><ShieldCheck size={12} /> Passed</span>
                    ) : (
                      <span className="notion-badge notion-badge-amber"><Lock size={12} /> Pending Review</span>
                    )}
                  </td>
                  <td>
                    {deal.dpaSigned ? (
                      <span className="notion-badge notion-badge-blue">DPA Signed</span>
                    ) : (
                      <span className="notion-badge notion-badge-rose">DPA Outstanding</span>
                    )}
                  </td>
                  <td>
                    <span className={`notion-badge ${deal.stage === 'closed_won' ? 'notion-badge-green' : 'notion-badge-amber'}`}>
                      {deal.stage === 'closed_won' ? 'Active ARR' : 'In Negotiation'}
                    </span>
                  </td>
                  <td>
                    <button 
                      className="btn btn-secondary btn-sm"
                      onClick={() => handleStageChange(deal, 'closed_won')}
                    >
                      {deal.stage === 'closed_won' ? 'View Contract' : 'Test InfoSec Gate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* VIEW 4: CPQ CALCULATOR */}
      {activeTab === 'cpq' && (
        <div className="cpq-container">
          <div className="panel-box">
            <div className="panel-box-header">
              <h3>🧮 B2B Enterprise CPQ Quote Builder</h3>
              <span className="notion-badge notion-badge-green">Powered by `b2b.pricing` DI Service</span>
            </div>

            <div className="cpq-grid">
              <div className="cpq-form">
                <div className="form-group">
                  <label>Enterprise Seat Quantity</label>
                  <input 
                    type="range" 
                    min="100" 
                    max="2000" 
                    step="50" 
                    value={cpqSeats}
                    onChange={e => setCpqSeats(Number(e.target.value))}
                  />
                  <div className="range-val">{cpqSeats} Licensed Seats</div>
                </div>

                <div className="form-row">
                  <div className="form-group">
                    <label>Base Price per Seat / Year ($)</label>
                    <input 
                      type="number" 
                      value={cpqPricePerSeat}
                      onChange={e => setCpqPricePerSeat(Number(e.target.value))}
                    />
                  </div>

                  <div className="form-group">
                    <label>Contract Commitment</label>
                    <select value={cpqMonths} onChange={e => setCpqMonths(Number(e.target.value))}>
                      <option value={12}>12 Months (Standard ARR)</option>
                      <option value={24}>24 Months (15% Multi-Year Discount)</option>
                      <option value={36}>36 Months (15% Multi-Year Discount)</option>
                    </select>
                  </div>
                </div>

                <div className="form-group inline-check">
                  <label className="checkbox-container">
                    <input 
                      type="checkbox" 
                      checked={includeCsm} 
                      onChange={e => setIncludeCsm(e.target.checked)} 
                    />
                    <span>Include Dedicated Customer Success Manager ($15,000/yr)</span>
                  </label>
                </div>
              </div>

              {/* Quote Result Box */}
              <div className="cpq-summary-card">
                <div className="summary-title">Executive Proposal Summary</div>
                <div className="summary-line">
                  <span>Gross Annual ARR:</span>
                  <span>${cpqQuote.rawArr.toLocaleString()}</span>
                </div>
                <div className="summary-line highlight">
                  <span>Net Annual ARR (after discount):</span>
                  <strong className="text-emerald">${cpqQuote.discountedArr.toLocaleString()}</strong>
                </div>
                <div className="summary-line">
                  <span>Total Contract Value (TCV):</span>
                  <strong className="text-purple">${cpqQuote.tcv.toLocaleString()}</strong>
                </div>

                {cpqQuote.hasDiscount && (
                  <div className="notion-callout success mt-12">
                    <Sparkles size={16} /> 15% Multi-Year Commitment Discount Auto-Applied
                  </div>
                )}

                <button className="btn btn-success full-width mt-12">
                  Generate Formal B2B Proposal PDF
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* VIEW 5: STAKEHOLDERS & ACTIVITY */}
      {activeTab === 'stakeholders' && (
        <div className="ecom-orders-layout">
          <div className="panel-box">
            <div className="panel-box-header">
              <h3>👥 Account Stakeholders & Buyer Personas</h3>
              <span className="notion-badge notion-badge-blue">Multi-touch Mapping</span>
            </div>

            <table className="crm-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Account</th>
                  <th>Email</th>
                  <th>Engagement Score</th>
                </tr>
              </thead>
              <tbody>
                {INITIAL_STAKEHOLDERS.map(s => (
                  <tr key={s.id}>
                    <td><strong>{s.name}</strong></td>
                    <td><span className="notion-badge notion-badge-purple">{s.role}</span></td>
                    <td>{s.account}</td>
                    <td className="font-mono text-muted">{s.email}</td>
                    <td>
                      <span className={`notion-badge ${s.engagementScore >= 80 ? 'notion-badge-green' : 'notion-badge-amber'}`}>
                        {s.engagementScore} / 100
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel-box">
            <h3>📜 Communication Feed</h3>
            {INITIAL_LOGS.map(log => (
              <div key={log.id} className="notion-activity-item">
                <div className="notion-activity-icon"><MessageSquare size={16} className="text-blue" /></div>
                <div>
                  <div className="font-semibold text-sm">{log.title}</div>
                  <div className="text-xs text-muted">{log.account} • {log.timestamp}</div>
                  <div className="text-xs mt-1">{log.summary}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* VETO HOOK ERROR MODAL */}
      {vetoModalOpen && vetoDeal && (
        <div className="modal-overlay" onClick={() => setVetoModalOpen(false)}>
          <div className="modal-content veto-modal" onClick={e => e.stopPropagation()}>
            <div className="veto-modal-header">
              <ShieldAlert size={28} className="text-rose" />
              <div>
                <h3>🛑 Vetoed by Domain Hook (`crm.deal.beforeUpdate`)</h3>
                <span className="veto-sub">Execution blocked by `embody-plugin-b2b-saas` security policy</span>
              </div>
            </div>

            <div className="veto-error-box">
              <code>Error: Veto: Enterprise deals over $50,000 require an approved Security Review before moving to 'closed_won'.</code>
            </div>

            <div className="infosec-checklist">
              <h4>Required InfoSec & Legal Checklist for {vetoDeal.account}:</h4>
              <div className="checklist-item">
                <label className="checkbox-container">
                  <input type="checkbox" defaultChecked />
                  <span>SOC2 Type II Compliance Report Verified</span>
                </label>
              </div>
              <div className="checklist-item">
                <label className="checkbox-container">
                  <input type="checkbox" defaultChecked />
                  <span>Standard DPA & GDPR Addendum Signed</span>
                </label>
              </div>
              <div className="checklist-item">
                <label className="checkbox-container">
                  <input type="checkbox" id="modal-sec-check" />
                  <strong>Security Review Clearance Approved by InfoSec Officer</strong>
                </label>
              </div>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={() => setVetoModalOpen(false)}>
                Cancel Stage Change
              </button>
              <button className="btn btn-success" onClick={handlePassSecurity}>
                Approve Security Clearance & Close Deal
              </button>
            </div>
          </div>
        </div>
      )}

      {/* NOTION SIDE PEEK PROPERTY DRAWER FOR SELECTED DEAL */}
      {selectedDeal && (
        <div className="notion-property-drawer">
          <div className="notion-drawer-header">
            <div className="font-semibold text-lg">{selectedDeal.account}</div>
            <button className="btn btn-secondary btn-nano" onClick={() => setSelectedDeal(null)}>
              <X size={14} />
            </button>
          </div>

          <div className="notion-drawer-body">
            <h3 className="mb-4">{selectedDeal.title}</h3>

            <div className="notion-property-row">
              <span className="notion-property-label"><Kanban size={14} /> Stage</span>
              <span className="notion-property-value">
                <span className="notion-badge notion-badge-blue">{selectedDeal.stage.replace('_', ' ')}</span>
              </span>
            </div>

            <div className="notion-property-row">
              <span className="notion-property-label"><DollarSign size={14} /> Annual ARR</span>
              <span className="notion-property-value font-mono text-emerald">${selectedDeal.arr.toLocaleString()}</span>
            </div>

            <div className="notion-property-row">
              <span className="notion-property-label"><Users size={14} /> Seats</span>
              <span className="notion-property-value">{selectedDeal.seats} Licensed Seats</span>
            </div>

            <div className="notion-property-row">
              <span className="notion-property-label"><Calendar size={14} /> Term</span>
              <span className="notion-property-value">{selectedDeal.contractMonths} Months</span>
            </div>

            <div className="notion-property-row">
              <span className="notion-property-label"><ShieldCheck size={14} /> InfoSec Clearance</span>
              <span className="notion-property-value">
                <span className={`notion-badge ${selectedDeal.securityReviewPassed ? 'notion-badge-green' : 'notion-badge-amber'}`}>
                  {selectedDeal.securityReviewPassed ? 'Approved' : 'Pending Review'}
                </span>
              </span>
            </div>

            <div className="notion-property-row">
              <span className="notion-property-label"><Building size={14} /> Account Owner</span>
              <span className="notion-property-value">{selectedDeal.owner}</span>
            </div>

            <div className="mt-6">
              <button 
                className="btn btn-primary full-width"
                onClick={() => handleStageChange(selectedDeal, 'closed_won')}
              >
                Advance Deal Stage to Closed Won
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
export default B2bSaasApp;
