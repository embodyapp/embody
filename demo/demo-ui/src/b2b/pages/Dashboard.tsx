import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { DollarSign, TrendingUp, Target, Clock, CheckCircle2, Circle, AlertCircle, Phone, Mail, Calendar, StickyNote, CheckSquare } from 'lucide-react';
import { useB2b } from '../../data/b2bStore';
import { KpiCard, Panel, Badge, BarChart, EmptyState } from '../../ui/primitives';
import { currency, relativeDate } from '../../lib/format';
import { DEAL_STAGES, type ActivityType } from '../../mock/b2b';

const actIcon: Record<ActivityType, React.ReactNode> = {
  call: <Phone size={14} />, email: <Mail size={14} />, meeting: <Calendar size={14} />, note: <StickyNote size={14} />, task: <CheckSquare size={14} />,
};

export function Dashboard() {
  const { deals, accounts, activities, toggleTask } = useB2b();

  const m = useMemo(() => {
    const open = deals.filter((d) => d.stage !== 'closed_won' && d.stage !== 'closed_lost');
    const pipeline = open.reduce((s, d) => s + d.amount, 0);
    const weighted = open.reduce((s, d) => s + (d.amount * d.probability) / 100, 0);
    const won = deals.filter((d) => d.stage === 'closed_won');
    const lost = deals.filter((d) => d.stage === 'closed_lost');
    const winRate = won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : 0;
    const wonRevenue = won.reduce((s, d) => s + d.amount, 0);
    const thisMonth = open.filter((d) => new Date(d.closeDate).getMonth() === new Date().getMonth()).length;
    return { pipeline, weighted, winRate, wonRevenue, openCount: open.length, thisMonth };
  }, [deals]);

  const stageData = DEAL_STAGES.filter((s) => s.key !== 'closed_lost').map((s) => ({
    label: s.label,
    value: deals.filter((d) => d.stage === s.key).reduce((sum, d) => sum + d.amount, 0),
    color: s.color,
  }));

  const myTasks = activities.filter((a) => a.type === 'task').sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? '')).slice(0, 6);

  const needsAttention = deals
    .filter((d) => d.stage !== 'closed_won' && d.stage !== 'closed_lost' && new Date(d.closeDate) < new Date(Date.now() + 21 * 86400000))
    .sort((a, b) => a.closeDate.localeCompare(b.closeDate))
    .slice(0, 5);

  const recent = [...activities].filter((a) => a.done).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6);
  const acctName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '—';

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Good morning, Alex</h1>
          <p className="page-sub">Here's what needs your attention today.</p>
        </div>
      </div>

      <div className="kpi-row">
        <KpiCard label="Open pipeline" value={currency(m.pipeline, { compact: true })} delta="↑ 14% vs last month" tone="up" icon={<DollarSign size={18} />} />
        <KpiCard label="Weighted forecast" value={currency(m.weighted, { compact: true })} delta={`${m.openCount} open deals`} tone="flat" icon={<Target size={18} />} />
        <KpiCard label="Win rate" value={`${m.winRate}%`} delta="Trailing 90 days" tone="up" icon={<TrendingUp size={18} />} />
        <KpiCard label="Closing this month" value={m.thisMonth} delta="Deals with close date in July" tone="flat" icon={<Clock size={18} />} />
      </div>

      <div className="grid-2">
        <Panel title="My open tasks">
          {myTasks.length === 0 ? (
            <EmptyState title="No open tasks" hint="You're all caught up." icon={<CheckCircle2 size={26} />} />
          ) : (
            <div className="list-plain">
              {myTasks.map((t) => (
                <div key={t.id} className="list-item">
                  <button className="icon-btn" onClick={() => toggleTask(t.id)} aria-label="Toggle task">
                    {t.done ? <CheckCircle2 size={18} className="text-emerald" /> : <Circle size={18} className="text-dim" />}
                  </button>
                  <div style={{ flex: 1 }}>
                    <div className="text-sm fw-600" style={{ textDecoration: t.done ? 'line-through' : 'none', opacity: t.done ? 0.6 : 1 }}>{t.subject}</div>
                    <div className="text-xs text-dim">{acctName(t.accountId)} · due {t.dueAt ? relativeDate(t.dueAt) : '—'}</div>
                  </div>
                  {t.dealId && <Link to={`/b2b/deals/${t.dealId}`} className="btn btn-ghost btn-sm">Open deal</Link>}
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="Deals needing attention" actions={<Badge tone="amber">{needsAttention.length}</Badge>}>
          {needsAttention.length === 0 ? (
            <EmptyState title="Nothing slipping" hint="No deals closing in the next 7 days." />
          ) : (
            <div className="list-plain">
              {needsAttention.map((d) => (
                <Link key={d.id} to={`/b2b/deals/${d.id}`} className="list-item" style={{ color: 'inherit' }}>
                  <AlertCircle size={16} className="text-amber" />
                  <div style={{ flex: 1 }}>
                    <div className="text-sm fw-600">{d.name}</div>
                    <div className="text-xs text-dim">{acctName(d.accountId)} · closes {relativeDate(d.closeDate)}</div>
                  </div>
                  <span className="cell-mono text-emerald">{currency(d.amount, { compact: true })}</span>
                </Link>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Pipeline value by stage">
          <BarChart data={stageData} />
        </Panel>
        <Panel title="Recent activity">
          {recent.length === 0 ? (
            <EmptyState title="No recent activity" />
          ) : (
            <div className="timeline">
              {recent.map((a, i) => (
                <div key={a.id} className="tl-item">
                  <div className="tl-rail">
                    <div className="tl-dot">{actIcon[a.type]}</div>
                    {i < recent.length - 1 && <div className="tl-line" />}
                  </div>
                  <div className="tl-body">
                    <div className="tl-subject">{a.subject}</div>
                    <div className="tl-meta">{acctName(a.accountId)} · {a.actor} · {relativeDate(a.at)}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
