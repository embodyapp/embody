import React, { useState } from 'react';
import { KeyRound, Terminal } from 'lucide-react';
import { useIdentity } from '@embody/react';

/**
 * Dev sign-in for the live page.
 *
 * There is no password: `POST /api/session` is a development seam that verifies the
 * membership exists and mints a session cookie. It only answers when the host runs with
 * EMBODY_DEV_IDENTITY=1 — hence the commands below, which are also what produce the ids.
 */
export function LoginCard({ onDone }: { onDone?: () => void }) {
  const { login } = useIdentity();
  const [orgId, setOrgId] = useState('');
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<'owner' | 'member' | 'viewer'>('owner');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await login({ orgId: orgId.trim(), userId: userId.trim(), roles: [role] });
    setBusy(false);
    if (res.ok) onDone?.();
    else setError(res.error.message);
  };

  return (
    <div className="panel" style={{ maxWidth: 620 }}>
      <header className="panel-head">
        <h3 className="panel-title"><KeyRound size={15} /> Sign in to the live deployment</h3>
      </header>
      <div className="panel-body">
        <div className="callout callout-blue">
          <Terminal size={16} />
          <div>
            <div style={{ marginBottom: 6 }}>Start the host and seed an org, then paste the ids it prints:</div>
            <pre style={{ margin: 0, fontSize: '.74rem', whiteSpace: 'pre-wrap' }}>
{`pnpm db:up
pnpm --filter acme-deployment migrate
pnpm --filter acme-deployment seed
EMBODY_DEV_IDENTITY=1 PORT=3100 pnpm --filter acme-deployment dev`}
            </pre>
          </div>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="orgId">Org ID</label>
            <input id="orgId" value={orgId} onChange={(e) => setOrgId(e.target.value)} placeholder="uuid from `embody seed`" required />
          </div>
          <div className="field">
            <label htmlFor="userId">User ID</label>
            <input id="userId" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="uuid from `embody seed`" required />
          </div>
          <div className="field">
            <label htmlFor="role">Act as</label>
            <select id="role" value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
              <option value="owner">owner — full access</option>
              <option value="member">member — read + write</option>
              <option value="viewer">viewer — read only</option>
            </select>
            {/* Signing in as a viewer is how you see RBAC reach the UI: the controls
                disable, and a forced call comes back 403. */}
          </div>
          {error && <div className="field-error" style={{ marginBottom: 12 }}>{error}</div>}
          <button className="btn btn-b2b" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
