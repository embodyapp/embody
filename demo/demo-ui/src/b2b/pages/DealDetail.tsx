import React, { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { ChevronRight, DollarSign, Users, Calendar, ShieldCheck, Lock, Building2, Phone, Mail, StickyNote, CheckSquare, Plus, ArrowRight, Sparkles } from 'lucide-react';
import { useB2b } from '../../data/b2bStore';
import { useToast } from '../../ui/Toast';
import { Badge, Panel, Tabs, ProgressBar, EmptyState, Avatar } from '../../ui/primitives';
import { currency, shortDate, relativeDate } from '../../lib/format';
import { DEAL_STAGES, type DealStage, type ActivityType } from '../../mock/b2b';

const stageMeta = (k: DealStage) => DEAL_STAGES.find((s) => s.key === k)!;
const actIcon: Record<ActivityType, React.ReactNode> = { call: <Phone size={14} />, email: <Mail size={14} />, meeting: <Calendar size={14} />, note: <StickyNote size={14} />, task: <CheckSquare size={14} /> };

export function DealDetail() {
  const { id = '' } = useParams();
  const { dealById, accountById, contactsForAccount, activitiesForDeal, updateDeal, logActivity } = useB2b();
  const toast = useToast();
  const navigate = useNavigate();
  const [tab, setTab] = useState<'overview' | 'contacts' | 'activity' | 'quote'>('overview');

  const deal = dealById(id);
  if (!deal) return <EmptyState title="Deal not found" hint="It may have been removed." action={<Link to="/b2b/pipeline" className="btn btn-secondary">Back to pipeline</Link>} />;
  const account = accountById(deal.accountId);
  const contacts = contactsForAccount(deal.accountId);
  const activity = activitiesForDeal(deal.id);
  const stageIdx = DEAL_STAGES.findIndex((s) => s.key === deal.stage);

  const advance = (stage: DealStage) => {
    const res = updateDeal(deal.id, { stage });
    if (!res.ok) toast.error(res.error ?? 'Could not update'); else toast.success(`Moved to ${stageMeta(stage).label}`);
  };

  const passSecurity = () => { updateDeal(deal.id, { securityReviewPassed: true, dpaSigned: true }); toast.success('Security review approved'); };

  return (
    <>
      <div className="breadcrumb">
        <Link to="/b2b/pipeline">Pipeline</Link> <ChevronRight size={13} /> <span>{deal.name}</span>
      </div>

      <div className="page-head">
        <div>
          <h1 className="page-title">{deal.name}</h1>
          <p className="page-sub">
            {account && <Link to={`/b2b/accounts/${account.id}`} className="text-muted"><Building2 size={13} style={{ verticalAlign: -2 }} /> {account.name}</Link>}
            {' · '}Owned by {deal.owner}
          </p>
        </div>
        <div className="row">
          {!deal.securityReviewPassed && <button className="btn btn-secondary" onClick={passSecurity}><ShieldCheck size={15} /> Approve security</button>}
          {deal.stage !== 'closed_won' && deal.stage !== 'closed_lost' && (
            <button className="btn btn-b2b" onClick={() => advance(DEAL_STAGES[Math.min(stageIdx + 1, 4)]!.key)}>
              Advance <ArrowRight size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">ARR</span><DollarSign size={16} className="kpi-icon" /></div><div className="kpi-value">{currency(deal.amount)}</div><div className="kpi-delta kpi-delta-flat">TCV {currency((deal.amount / 12) * deal.termMonths, { compact: true })}</div></div>
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">Stage</span></div><div className="kpi-value" style={{ fontSize: '1.1rem' }}><Badge tone="blue">{stageMeta(deal.stage).label}</Badge></div><div className="mt-8"><ProgressBar pct={(stageIdx / 4) * 100} color={stageMeta(deal.stage).color} /></div></div>
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">Probability</span></div><div className="kpi-value">{deal.probability}%</div><div className="kpi-delta kpi-delta-flat">{deal.seats} seats · {deal.termMonths}mo</div></div>
        <div className="kpi-card"><div className="kpi-head"><span className="kpi-label">Close date</span><Calendar size={16} className="kpi-icon" /></div><div className="kpi-value" style={{ fontSize: '1.15rem' }}>{shortDate(deal.closeDate)}</div><div className="kpi-delta kpi-delta-flat">{relativeDate(deal.closeDate)}</div></div>
      </div>

      {!deal.securityReviewPassed && deal.amount >= 50000 && (
        <div className="callout callout-amber">
          <Lock size={18} className="text-amber" />
          <div><strong>Security review required.</strong> This deal is over $50,000 — it can't move to Closed Won until InfoSec approves the security review and DPA.</div>
        </div>
      )}

      <Tabs
        tabs={[{ key: 'overview', label: 'Overview' }, { key: 'contacts', label: 'Buying committee', count: contacts.length }, { key: 'activity', label: 'Activity', count: activity.length }, { key: 'quote', label: 'Quote' }]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'overview' && (
        <div className="grid-2">
          <Panel title="Deal details">
            <div className="prop-row"><span className="prop-label">Account</span><span className="prop-value">{account?.name}</span></div>
            <div className="prop-row"><span className="prop-label">Owner</span><span className="prop-value">{deal.owner}</span></div>
            <div className="prop-row"><span className="prop-label">Seats</span><span className="prop-value">{deal.seats}</span></div>
            <div className="prop-row"><span className="prop-label">Term</span><span className="prop-value">{deal.termMonths} months</span></div>
            <div className="prop-row"><span className="prop-label"><ShieldCheck size={13} /> Security review</span><span className="prop-value">{deal.securityReviewPassed ? <Badge tone="green">Passed</Badge> : <Badge tone="amber">Pending</Badge>}</span></div>
            <div className="prop-row"><span className="prop-label">DPA signed</span><span className="prop-value">{deal.dpaSigned ? <Badge tone="green">Yes</Badge> : <Badge tone="rose">Outstanding</Badge>}</span></div>
          </Panel>
          <Panel title="Next step">
            <p className="text-sm">{deal.nextStep}</p>
            <div className="mt-16">
              <div className="text-xs text-dim mb-8">Move stage</div>
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {DEAL_STAGES.map((s) => (
                  <button key={s.key} className={`btn btn-sm ${s.key === deal.stage ? 'btn-b2b' : 'btn-secondary'}`} onClick={() => advance(s.key)}>{s.label}</button>
                ))}
              </div>
            </div>
          </Panel>
        </div>
      )}

      {tab === 'contacts' && (
        <Panel title="Buying committee">
          {contacts.length === 0 ? <EmptyState title="No contacts yet" /> : (
            <div className="list-plain">
              {contacts.map((c) => (
                <div key={c.id} className="list-item">
                  <Avatar name={c.name} />
                  <div style={{ flex: 1 }}>
                    <div className="text-sm fw-600">{c.name} {c.primary && <Badge tone="blue">Primary</Badge>}</div>
                    <div className="text-xs text-dim">{c.title} · {c.email}</div>
                  </div>
                  <Badge tone="purple">{c.buyerRole}</Badge>
                  <div style={{ width: 90 }}><ProgressBar pct={c.engagement} color={c.engagement >= 80 ? 'var(--accent-emerald)' : 'var(--accent-amber)'} /></div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}

      {tab === 'activity' && <ActivityTab dealId={deal.id} accountId={deal.accountId} />}

      {tab === 'quote' && <QuoteTab arr={deal.amount} termMonths={deal.termMonths} />}
    </>
  );
}

function ActivityTab({ dealId, accountId }: { dealId: string; accountId: string }) {
  const { activitiesForDeal, logActivity, toggleTask } = useB2b();
  const toast = useToast();
  const [type, setType] = useState<ActivityType>('note');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const activity = activitiesForDeal(dealId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim()) return;
    logActivity({ type, subject: subject.trim(), body: body.trim(), accountId, dealId, actor: 'Alex Rivera' });
    setSubject(''); setBody('');
    toast.success('Activity logged');
  };

  return (
    <div className="grid-2">
      <Panel title="Log activity">
        <form onSubmit={submit}>
          <div className="field"><label>Type</label>
            <select value={type} onChange={(e) => setType(e.target.value as ActivityType)}>
              <option value="note">Note</option><option value="call">Call</option><option value="email">Email</option><option value="meeting">Meeting</option><option value="task">Task</option>
            </select>
          </div>
          <div className="field"><label>Subject</label><input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="What happened?" /></div>
          <div className="field"><label>Details</label><textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} /></div>
          <button className="btn btn-b2b full-width" disabled={!subject.trim()}><Plus size={15} /> Log activity</button>
        </form>
      </Panel>
      <Panel title="Timeline">
        {activity.length === 0 ? <EmptyState title="No activity yet" hint="Log the first touchpoint." /> : (
          <div className="timeline">
            {activity.map((a, i) => (
              <div key={a.id} className="tl-item">
                <div className="tl-rail"><div className="tl-dot">{actIcon[a.type]}</div>{i < activity.length - 1 && <div className="tl-line" />}</div>
                <div className="tl-body">
                  <div className="tl-subject">{a.subject} {a.type === 'task' && <button className="btn btn-ghost btn-sm" onClick={() => toggleTask(a.id)}>{a.done ? 'Done ✓' : 'Mark done'}</button>}</div>
                  <div className="tl-meta">{a.actor} · {relativeDate(a.at)}</div>
                  {a.body && <div className="tl-text">{a.body}</div>}
                </div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function QuoteTab({ arr, termMonths }: { arr: number; termMonths: number }) {
  const [seats, setSeats] = useState(500);
  const [pricePerSeat, setPricePerSeat] = useState(240);
  const [months, setMonths] = useState(termMonths);
  const [csm, setCsm] = useState(true);

  const gross = seats * pricePerSeat + (csm ? 15000 : 0);
  const hasDiscount = months >= 24;
  const net = hasDiscount ? gross * 0.85 : gross;
  const tcv = (net / 12) * months;

  return (
    <div className="grid-2">
      <Panel title="Configure quote">
        <div className="field"><label>Seats: {seats}</label><input type="range" min={50} max={2000} step={50} value={seats} onChange={(e) => setSeats(Number(e.target.value))} /></div>
        <div className="field-row">
          <div className="field"><label>Price / seat / yr ($)</label><input type="number" value={pricePerSeat} onChange={(e) => setPricePerSeat(Number(e.target.value))} /></div>
          <div className="field"><label>Term</label><select value={months} onChange={(e) => setMonths(Number(e.target.value))}><option value={12}>12 months</option><option value={24}>24 months (−15%)</option><option value={36}>36 months (−15%)</option></select></div>
        </div>
        <label className="checkbox-row"><input type="checkbox" checked={csm} onChange={(e) => setCsm(e.target.checked)} /> Dedicated CSM (+$15,000/yr)</label>
      </Panel>
      <Panel title="Proposal summary">
        <div className="prop-row"><span className="prop-label">Gross ARR</span><span className="prop-value">{currency(gross)}</span></div>
        <div className="prop-row"><span className="prop-label">Net ARR (after discount)</span><span className="prop-value text-emerald">{currency(net)}</span></div>
        <div className="prop-row"><span className="prop-label">Total contract value</span><span className="prop-value">{currency(tcv)}</span></div>
        {hasDiscount && <div className="callout callout-blue mt-16"><Sparkles size={16} className="text-blue" /> 15% multi-year commitment discount applied.</div>}
      </Panel>
    </div>
  );
}
