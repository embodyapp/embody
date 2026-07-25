import React, { useMemo } from 'react';
import { useB2b } from '../../data/b2bStore';
import { Panel, BarChart, KpiCard } from '../../ui/primitives';
import { currency } from '../../lib/format';
import { DEAL_STAGES, REPS } from '../../mock/b2b';

export function Reports() {
  const { deals } = useB2b();

  const byStage = useMemo(
    () => DEAL_STAGES.filter((s) => s.key !== 'closed_lost').map((s) => {
      const ds = deals.filter((d) => d.stage === s.key);
      return { label: s.label, count: ds.length, arr: ds.reduce((sum, d) => sum + d.amount, 0), weighted: ds.reduce((sum, d) => sum + (d.amount * d.probability) / 100, 0), color: s.color };
    }),
    [deals],
  );

  const leaderboard = useMemo(
    () => REPS.map((r) => {
      const rd = deals.filter((d) => d.owner === r);
      const won = rd.filter((d) => d.stage === 'closed_won');
      const open = rd.filter((d) => d.stage !== 'closed_won' && d.stage !== 'closed_lost');
      return { rep: r, wonRevenue: won.reduce((s, d) => s + d.amount, 0), openPipeline: open.reduce((s, d) => s + d.amount, 0), wonCount: won.length };
    }).sort((a, b) => b.wonRevenue - a.wonRevenue),
    [deals],
  );

  const won = deals.filter((d) => d.stage === 'closed_won');
  const lost = deals.filter((d) => d.stage === 'closed_lost');
  const winRate = won.length + lost.length ? Math.round((won.length / (won.length + lost.length)) * 100) : 0;
  const weighted = deals.filter((d) => d.stage !== 'closed_won' && d.stage !== 'closed_lost').reduce((s, d) => s + (d.amount * d.probability) / 100, 0);
  const avgDeal = deals.length ? deals.reduce((s, d) => s + d.amount, 0) / deals.length : 0;

  return (
    <>
      <div className="page-head"><div><h1 className="page-title">Reports &amp; forecast</h1><p className="page-sub">Pipeline health and rep performance</p></div></div>

      <div className="kpi-row">
        <KpiCard label="Weighted forecast" value={currency(weighted, { compact: true })} delta="Probability-adjusted open pipeline" tone="flat" />
        <KpiCard label="Win rate" value={`${winRate}%`} delta={`${won.length} won · ${lost.length} lost`} tone="up" />
        <KpiCard label="Avg deal size" value={currency(avgDeal, { compact: true })} delta="Across all deals" tone="flat" />
        <KpiCard label="Closed-won revenue" value={currency(won.reduce((s, d) => s + d.amount, 0), { compact: true })} delta="Booked ARR" tone="up" />
      </div>

      <div className="grid-2">
        <Panel title="Pipeline ARR by stage"><BarChart data={byStage.map((s) => ({ label: s.label, value: s.arr, color: s.color }))} /></Panel>
        <Panel title="Weighted forecast by stage"><BarChart data={byStage.map((s) => ({ label: s.label, value: Math.round(s.weighted), color: s.color }))} /></Panel>
      </div>

      <Panel title="Rep leaderboard">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Rep</th><th>Deals won</th><th>Won revenue</th><th>Open pipeline</th></tr></thead>
            <tbody>{leaderboard.map((l) => (
              <tr key={l.rep}><td className="cell-strong">{l.rep}</td><td>{l.wonCount}</td><td className="cell-mono text-emerald">{currency(l.wonRevenue)}</td><td className="cell-mono">{currency(l.openPipeline)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}
