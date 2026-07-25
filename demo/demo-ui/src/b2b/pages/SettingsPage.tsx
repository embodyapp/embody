import React from 'react';
import { RotateCcw, Puzzle, ShieldPlus, Check } from 'lucide-react';
import { useB2b } from '../../data/b2bStore';
import { useToast } from '../../ui/Toast';
import { useCustomization } from '../../copilot/customization';
import { Panel, Badge } from '../../ui/primitives';
import { currency } from '../../lib/format';
import { DEAL_STAGES } from '../../mock/b2b';

export function SettingsPage() {
  const { products, reset, accounts, deals } = useB2b();
  const custom = useCustomization();
  const toast = useToast();

  const healthcareDeals = deals.filter((d) => accounts.find((a) => a.id === d.accountId)?.industry === 'Healthcare');

  return (
    <>
      <div className="page-head"><div><h1 className="page-title">Settings</h1><p className="page-sub">Pipeline configuration, price book, and customizations</p></div></div>

      <Panel
        title={<span className="row gap-8"><Puzzle size={16} className="text-purple" /> Platform customizations</span>}
        actions={<label className="checkbox-row"><input type="checkbox" checked={custom.enabled} onChange={(e) => { custom.setEnabled(e.target.checked); toast.info(custom.enabled ? 'Disabled custom/acme-crm' : 'Enabled custom/acme-crm'); }} /> Enable <code>custom/acme-crm</code></label>}
      >
        <p className="text-sm text-muted mb-8">
          A customization plugin extends the CRM <strong>without forking core</strong> — it layers on a new
          rule and a new agent tool. Enabling it is a one-line change to <code>embody.config.ts</code>; the
          running app (and the copilot) pick it up immediately.
        </p>
        {custom.enabled ? (
          <>
            <div className="callout callout-blue">
              <ShieldPlus size={18} className="text-blue" />
              <div>
                <strong>Active:</strong> healthcare-vertical deals now require a <strong>HIPAA review</strong> before Closed
                Won (a vetoable rule layered on top of the built-in InfoSec veto), and the copilot gains a new
                <code> acme_flag_hipaa</code> tool. No CRM page, store, or core file was changed.
              </div>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Healthcare deal</th><th>Account</th><th>HIPAA review</th><th>Action</th></tr></thead>
                <tbody>
                  {healthcareDeals.length === 0 ? (
                    <tr><td colSpan={4} className="cell-muted">No healthcare-vertical deals.</td></tr>
                  ) : healthcareDeals.map((d) => (
                    <tr key={d.id}>
                      <td className="cell-strong">{d.name}</td>
                      <td className="cell-muted">{accounts.find((a) => a.id === d.accountId)?.name}</td>
                      <td>{custom.isHipaaFlagged(d.id) ? <Badge tone="green"><Check size={11} /> Passed</Badge> : <Badge tone="amber">Required</Badge>}</td>
                      <td>{!custom.isHipaaFlagged(d.id) && <button className="btn btn-secondary btn-sm" onClick={() => { custom.flagHipaa(d.id); toast.success('HIPAA review recorded'); }}>Mark reviewed</button>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-xs text-dim">Toggle it on to see the HIPAA rule take effect and the new agent tool appear.</p>
        )}
      </Panel>

      <Panel title="Pipeline stages">
        <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
          {DEAL_STAGES.map((s, i) => (
            <div key={s.key} className="row" style={{ gap: 8 }}>
              <span className="col-dot" style={{ background: s.color }} /> <span className="text-sm fw-600">{s.label}</span>
              {i < DEAL_STAGES.length - 1 && <span className="text-dim">→</span>}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title="Price book">
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Product</th><th>Category</th><th>Unit</th><th>List price</th></tr></thead>
            <tbody>{products.map((p) => (
              <tr key={p.id}><td className="cell-strong">{p.name}</td><td><Badge tone="gray">{p.category}</Badge></td><td className="cell-muted">{p.unit}</td><td className="cell-mono">{currency(p.listPrice)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </Panel>

      <Panel title="Demo data">
        <p className="text-sm text-muted mb-8">Edits you make (new deals, stage moves, logged activity) persist to your browser. Reset to restore the original seeded dataset.</p>
        <button className="btn btn-secondary" onClick={() => { reset(); toast.info('Demo data reset'); }}><RotateCcw size={15} /> Reset demo data</button>
      </Panel>
    </>
  );
}
