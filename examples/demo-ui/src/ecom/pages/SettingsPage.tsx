import React from 'react';
import { RotateCcw } from 'lucide-react';
import { useEcom } from '../../data/ecomStore';
import { useToast } from '../../ui/Toast';
import { Panel, Badge } from '../../ui/primitives';
import { currency } from '../../lib/format';
import { VIP_TIERS } from '../../mock/ecom';
import { tierTone } from '../meta';

export function SettingsPage() {
  const { products, reset } = useEcom();
  const toast = useToast();

  return (
    <>
      <div className="page-head"><div><h1 className="page-title">Settings</h1><p className="page-sub">Loyalty tiers and product catalog</p></div></div>

      <Panel title="VIP loyalty tiers">
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Tier</th><th>Auto-discount</th></tr></thead>
          <tbody>{VIP_TIERS.map((t) => (
            <tr key={t.key}><td><Badge tone={tierTone[t.key]}>{t.label}</Badge></td><td>{t.discount > 0 ? `${Math.round(t.discount * 100)}% at checkout` : 'None'}</td></tr>
          ))}</tbody>
        </table></div>
      </Panel>

      <Panel title="Product catalog">
        <div className="table-wrap"><table className="data">
          <thead><tr><th>Product</th><th>SKU</th><th>Category</th><th>Price</th><th>Units sold</th><th>Stock</th></tr></thead>
          <tbody>{products.map((p) => (
            <tr key={p.id}><td className="cell-strong">{p.name}</td><td className="cell-mono text-xs">{p.sku}</td><td><Badge tone="gray">{p.category}</Badge></td><td className="cell-mono">{currency(p.price)}</td><td>{p.unitsSold.toLocaleString()}</td><td>{p.stock}</td></tr>
          ))}</tbody>
        </table></div>
      </Panel>

      <Panel title="Demo data">
        <p className="text-sm text-muted mb-8">New orders, ticket replies, and status changes persist to your browser. Reset to restore the seeded dataset.</p>
        <button className="btn btn-secondary" onClick={() => { reset(); toast.info('Demo data reset'); }}><RotateCcw size={15} /> Reset demo data</button>
      </Panel>
    </>
  );
}
