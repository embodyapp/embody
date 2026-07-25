import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KanbanSquare, Table as TableIcon, Plus, Search, ShieldCheck, Lock } from 'lucide-react';
import { useB2b } from '../../data/b2bStore';
import { useToast } from '../../ui/Toast';
import { Badge, Modal, EmptyState } from '../../ui/primitives';
import { currency, shortDate } from '../../lib/format';
import { DEAL_STAGES, REPS, type DealStage, type B2bDeal } from '../../mock/b2b';

const stageMeta = (k: DealStage) => DEAL_STAGES.find((s) => s.key === k)!;

export function Pipeline() {
  const { deals, accounts, updateDeal } = useB2b();
  const toast = useToast();
  const navigate = useNavigate();
  const [view, setView] = useState<'kanban' | 'table'>('kanban');
  const [q, setQ] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('all');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropStage, setDropStage] = useState<DealStage | null>(null);
  const [modal, setModal] = useState(false);

  const acctName = (id: string) => accounts.find((a) => a.id === id)?.name ?? '—';

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return deals.filter((d) => {
      const matchesQ = !s || d.name.toLowerCase().includes(s) || acctName(d.accountId).toLowerCase().includes(s);
      const matchesOwner = ownerFilter === 'all' || d.owner === ownerFilter;
      return matchesQ && matchesOwner;
    });
  }, [deals, q, ownerFilter, accounts]);

  const boardStages = DEAL_STAGES;

  const move = (deal: B2bDeal, stage: DealStage) => {
    if (stage === deal.stage) return;
    const res = updateDeal(deal.id, { stage });
    if (!res.ok) {
      toast.error(res.error ?? 'Could not update deal');
    } else {
      toast.success(`${deal.name} → ${stageMeta(stage).label}`);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Pipeline</h1>
          <p className="page-sub">{filtered.length} deals · {currency(filtered.filter((d) => d.stage !== 'closed_won' && d.stage !== 'closed_lost').reduce((s, d) => s + d.amount, 0), { compact: true })} open</p>
        </div>
        <button className="btn btn-b2b" onClick={() => setModal(true)}><Plus size={16} /> New deal</button>
      </div>

      <div className="toolbar">
        <div className="seg-toggle">
          <button className={view === 'kanban' ? 'active' : ''} onClick={() => setView('kanban')}><KanbanSquare size={14} /> Board</button>
          <button className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}><TableIcon size={14} /> Table</button>
        </div>
        <div className="search-box"><Search size={15} /><input placeholder="Filter deals…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select className="select-inline" value={ownerFilter} onChange={(e) => setOwnerFilter(e.target.value)}>
          <option value="all">All owners</option>
          {REPS.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
      </div>

      {view === 'kanban' && (
        <div className="kanban">
          {boardStages.map((stage) => {
            const cards = filtered.filter((d) => d.stage === stage.key);
            const sum = cards.reduce((s, d) => s + d.amount, 0);
            return (
              <div
                key={stage.key}
                className={`kanban-col ${dropStage === stage.key ? 'drop' : ''}`}
                onDragOver={(e) => { e.preventDefault(); setDropStage(stage.key); }}
                onDragLeave={() => setDropStage((s) => (s === stage.key ? null : s))}
                onDrop={() => {
                  setDropStage(null);
                  const deal = deals.find((d) => d.id === dragId);
                  if (deal) move(deal, stage.key);
                  setDragId(null);
                }}
              >
                <div className="kanban-col-head">
                  <div className="kanban-col-title">
                    <span className="col-dot" style={{ background: stage.color }} /> {stage.label}
                    <span className="col-badge">{cards.length}</span>
                  </div>
                  <span className="kanban-col-sum">{currency(sum, { compact: true })}</span>
                </div>
                <div className="kanban-cards">
                  {cards.map((d) => (
                    <div
                      key={d.id}
                      className={`deal-card ${dragId === d.id ? 'dragging' : ''}`}
                      draggable
                      onDragStart={() => setDragId(d.id)}
                      onDragEnd={() => setDragId(null)}
                      onClick={() => navigate(`/b2b/deals/${d.id}`)}
                    >
                      <div className="deal-card-top">
                        <span className="deal-card-acct">{acctName(d.accountId)}</span>
                        <Badge tone={d.securityReviewPassed ? 'green' : 'amber'}>
                          {d.securityReviewPassed ? <ShieldCheck size={11} /> : <Lock size={11} />}
                          {d.securityReviewPassed ? 'Sec ✓' : 'Sec'}
                        </Badge>
                      </div>
                      <div className="deal-card-title">{d.name}</div>
                      <div className="deal-card-foot">
                        <span className="deal-card-amt">{currency(d.amount, { compact: true })}</span>
                        <span className="text-xs text-dim">{d.probability}%</span>
                      </div>
                    </div>
                  ))}
                  {cards.length === 0 && <div className="text-xs text-dim" style={{ padding: 8, textAlign: 'center' }}>Drop deals here</div>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {view === 'table' && (
        <div className="panel">
          <div className="table-wrap">
            {filtered.length === 0 ? (
              <EmptyState title="No deals match your filters" hint="Try clearing the search or owner filter." />
            ) : (
              <table className="data">
                <thead>
                  <tr><th>Deal</th><th>Account</th><th>Stage</th><th>ARR</th><th>Seats</th><th>Close</th><th>Owner</th><th>Security</th></tr>
                </thead>
                <tbody>
                  {filtered.map((d) => (
                    <tr key={d.id} className="clickable" onClick={() => navigate(`/b2b/deals/${d.id}`)}>
                      <td className="cell-strong">{d.name}</td>
                      <td className="cell-muted">{acctName(d.accountId)}</td>
                      <td><Badge tone="blue">{stageMeta(d.stage).label}</Badge></td>
                      <td className="cell-mono text-emerald">{currency(d.amount)}</td>
                      <td>{d.seats || '—'}</td>
                      <td className="cell-muted">{shortDate(d.closeDate)}</td>
                      <td>{d.owner}</td>
                      <td>{d.securityReviewPassed ? <Badge tone="green"><ShieldCheck size={11} /> Passed</Badge> : <Badge tone="amber"><Lock size={11} /> Pending</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {modal && <NewDealModal onClose={() => setModal(false)} onCreate={(d) => { toast.success('Deal created'); navigate(`/b2b/deals/${d.id}`); }} />}
    </>
  );
}

function NewDealModal({ onClose, onCreate }: { onClose: () => void; onCreate: (d: B2bDeal) => void }) {
  const { accounts, createDeal } = useB2b();
  const [name, setName] = useState('');
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? '');
  const [amount, setAmount] = useState('50000');
  const [seats, setSeats] = useState('200');
  const [term, setTerm] = useState('12');
  const [stage, setStage] = useState<DealStage>('discovery');
  const [owner, setOwner] = useState<string>(REPS[0]);
  const valid = name.trim().length > 1 && accountId && Number(amount) > 0;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    const deal = createDeal({ name: name.trim(), accountId, amount: Number(amount), seats: Number(seats), termMonths: Number(term), stage, owner, closeDate: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) });
    onCreate(deal);
    onClose();
  };

  return (
    <Modal title="New deal" onClose={onClose} footer={<><button className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-b2b" disabled={!valid} onClick={submit}>Create deal</button></>}>
      <form onSubmit={submit}>
        <div className="field"><label>Deal name</label><input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Acme Corp — 500 Enterprise Seats" autoFocus /></div>
        <div className="field"><label>Account</label>
          <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select>
        </div>
        <div className="field-row">
          <div className="field"><label>ARR ($)</label><input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <div className="field"><label>Seats</label><input type="number" value={seats} onChange={(e) => setSeats(e.target.value)} /></div>
        </div>
        <div className="field-row">
          <div className="field"><label>Term (months)</label>
            <select value={term} onChange={(e) => setTerm(e.target.value)}><option value="12">12</option><option value="24">24</option><option value="36">36</option></select>
          </div>
          <div className="field"><label>Stage</label>
            <select value={stage} onChange={(e) => setStage(e.target.value as DealStage)}>{DEAL_STAGES.filter((s) => s.key !== 'closed_lost').map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
          </div>
        </div>
        <div className="field"><label>Owner</label><select value={owner} onChange={(e) => setOwner(e.target.value)}>{REPS.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
      </form>
    </Modal>
  );
}
