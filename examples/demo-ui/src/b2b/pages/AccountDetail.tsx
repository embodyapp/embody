import React, { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ChevronRight, Building2, Users, Briefcase, DollarSign, Phone, Mail, Calendar, StickyNote, CheckSquare, MapPin } from 'lucide-react';
import { useB2b } from '../../data/b2bStore';
import { Badge, Panel, Tabs, EmptyState, Avatar, ProgressBar, type BadgeTone } from '../../ui/primitives';
import { currency, shortDate, relativeDate } from '../../lib/format';
import { DEAL_STAGES, type DealStage, type AccountHealth, type ActivityType } from '../../mock/b2b';

const stageMeta = (k: DealStage) => DEAL_STAGES.find((s) => s.key === k)!;
const healthTone: Record<AccountHealth, BadgeTone> = { healthy: 'green', watch: 'amber', at_risk: 'rose' };
const actIcon: Record<ActivityType, React.ReactNode> = { call: <Phone size={14} />, email: <Mail size={14} />, meeting: <Calendar size={14} />, note: <StickyNote size={14} />, task: <CheckSquare size={14} /> };

export function AccountDetail() {
  const { id = '' } = useParams();
  const { accountById, contactsForAccount, dealsForAccount, activitiesForAccount } = useB2b();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'deals' | 'contacts' | 'activity'>('deals');

  const account = accountById(id);
  if (!account) return <EmptyState title="Account not found" action={<Link to="/b2b/accounts" className="btn btn-secondary">Back to accounts</Link>} />;
  const contacts = contactsForAccount(id);
  const deals = dealsForAccount(id);
  const activity = activitiesForAccount(id);
  const openPipeline = deals.filter((d) => d.stage !== 'closed_won' && d.stage !== 'closed_lost').reduce((s, d) => s + d.amount, 0);
  const won = deals.filter((d) => d.stage === 'closed_won').reduce((s, d) => s + d.amount, 0);

  return (
    <>
      <div className="breadcrumb"><Link to="/b2b/accounts">Accounts</Link> <ChevronRight size={13} /> <span>{account.name}</span></div>
      <div className="page-head">
        <div className="row" style={{ gap: 14 }}>
          <Avatar name={account.name} size={48} />
          <div>
            <h1 className="page-title">{account.name}</h1>
            <p className="page-sub"><MapPin size={13} style={{ verticalAlign: -2 }} /> {account.location} · {account.industry} · {account.employees.toLocaleString()} employees</p>
          </div>
        </div>
        <Badge tone={healthTone[account.health]}>{account.health.replace('_', ' ')}</Badge>
      </div>

      <div className="kpi-row">
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">Open pipeline</span><Briefcase size={16} className="kpi-icon" /></div><div className="kpi-value">{currency(openPipeline, { compact: true })}</div></div>
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">Active ARR</span><DollarSign size={16} className="kpi-icon" /></div><div className="kpi-value text-emerald">{account.arr ? currency(account.arr, { compact: true }) : '—'}</div></div>
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">Contacts</span><Users size={16} className="kpi-icon" /></div><div className="kpi-value">{contacts.length}</div></div>
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">Renewal</span><Calendar size={16} className="kpi-icon" /></div><div className="kpi-value" style={{ fontSize: '1.15rem' }}>{account.renewalDate ? shortDate(account.renewalDate) : '—'}</div></div>
      </div>

      <Tabs tabs={[{ key: 'deals', label: 'Deals', count: deals.length }, { key: 'contacts', label: 'Contacts', count: contacts.length }, { key: 'activity', label: 'Activity', count: activity.length }]} active={tab} onChange={setTab} />

      {tab === 'deals' && (
        <div className="panel"><div className="table-wrap">
          {deals.length === 0 ? <EmptyState title="No deals for this account" /> : (
            <table className="data">
              <thead><tr><th>Deal</th><th>Stage</th><th>ARR</th><th>Close</th><th>Prob.</th></tr></thead>
              <tbody>{deals.map((d) => (
                <tr key={d.id} className="clickable" onClick={() => navigate(`/b2b/deals/${d.id}`)}>
                  <td className="cell-strong">{d.name}</td>
                  <td><Badge tone="blue">{stageMeta(d.stage).label}</Badge></td>
                  <td className="cell-mono text-emerald">{currency(d.amount)}</td>
                  <td className="cell-muted">{shortDate(d.closeDate)}</td>
                  <td>{d.probability}%</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </div></div>
      )}

      {tab === 'contacts' && (
        <Panel title="Contacts">
          {contacts.length === 0 ? <EmptyState title="No contacts" /> : (
            <div className="list-plain">{contacts.map((c) => (
              <div key={c.id} className="list-item">
                <Avatar name={c.name} />
                <div style={{ flex: 1 }}><div className="text-sm fw-600">{c.name} {c.primary && <Badge tone="blue">Primary</Badge>}</div><div className="text-xs text-dim">{c.title} · {c.email} · {c.phone}</div></div>
                <Badge tone="purple">{c.buyerRole}</Badge>
                <div style={{ width: 80 }}><ProgressBar pct={c.engagement} color={c.engagement >= 80 ? 'var(--accent-emerald)' : 'var(--accent-amber)'} /></div>
              </div>
            ))}</div>
          )}
        </Panel>
      )}

      {tab === 'activity' && (
        <Panel title="Activity timeline">
          {activity.length === 0 ? <EmptyState title="No activity" /> : (
            <div className="timeline">{activity.map((a, i) => (
              <div key={a.id} className="tl-item">
                <div className="tl-rail"><div className="tl-dot">{actIcon[a.type]}</div>{i < activity.length - 1 && <div className="tl-line" />}</div>
                <div className="tl-body"><div className="tl-subject">{a.subject}</div><div className="tl-meta">{a.actor} · {relativeDate(a.at)}</div>{a.body && <div className="tl-text">{a.body}</div>}</div>
              </div>
            ))}</div>
          )}
        </Panel>
      )}
    </>
  );
}
