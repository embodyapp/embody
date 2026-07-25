import React, { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Sparkles, Send, Settings, X, Ban, Check, AlertTriangle, Terminal, ShieldCheck, Trash2, CornerDownLeft } from 'lucide-react';
import { useCopilot } from './CopilotProvider';

const B2B_PROMPTS = [
  "Acme's security review passed — close the deal and log a kickoff activity",
  'Which deals are in negotiation, and what are they worth?',
  'Create a $60k, 200-seat deal for Helio Energy in discovery',
];
const ECOM_PROMPTS = [
  "Approve the return for Jane Doe's defective headphones and reply to her ticket apologizing",
  'List the open support tickets',
  'Place an Express order of the 4K Webcam Pro for a Platinum customer',
];

export function CopilotLauncher() {
  const { open, setOpen } = useCopilot();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); setOpen(!open); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  return (
    <>
      {!open && (
        <button className="copilot-fab" onClick={() => setOpen(true)} title="Copilot (⌘J)">
          <Sparkles size={18} /> <span>Copilot</span> <span className="kbd">⌘J</span>
        </button>
      )}
      {open && <CopilotPanel />}
    </>
  );
}

function CopilotPanel() {
  const { setOpen, items, running, run, clear, apiKey, setApiKey, hasKey, role, setRole } = useCopilot();
  const location = useLocation();
  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(!hasKey);
  const bodyRef = useRef<HTMLDivElement>(null);

  const section = location.pathname.startsWith('/ecom') ? 'ecom' : 'b2b';
  const prompts = section === 'ecom' ? ECOM_PROMPTS : B2B_PROMPTS;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  useEffect(() => { bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' }); }, [items, running]);

  const submit = () => { if (input.trim() && !running) { run(input.trim()); setInput(''); } };

  return (
    <aside className="copilot">
      <header className="copilot-head">
        <div className="row gap-8"><Sparkles size={17} className="text-emerald" /><strong>Copilot</strong></div>
        <div className="row gap-8">
          <span className={`role-pill ${role}`} title="Acting role (governance)">{role === 'owner' ? <ShieldCheck size={12} /> : <Ban size={12} />} {role}</span>
          <button className="icon-btn" onClick={() => setShowSettings((s) => !s)} title="Settings"><Settings size={16} /></button>
          <button className="icon-btn" onClick={clear} title="Clear"><Trash2 size={16} /></button>
          <button className="icon-btn" onClick={() => setOpen(false)} title="Close (Esc)"><X size={18} /></button>
        </div>
      </header>

      {showSettings && (
        <div className="copilot-settings">
          <div className="field" style={{ marginBottom: 10 }}>
            <label>Anthropic API key <span className="text-dim">(stored in your browser)</span></label>
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-ant-..." />
          </div>
          <div className="field" style={{ marginBottom: 4 }}>
            <label>Acting role — governance is enforced on the agent</label>
            <select value={role} onChange={(e) => setRole(e.target.value as 'owner' | 'viewer')}>
              <option value="owner">owner — can read &amp; write</option>
              <option value="viewer">viewer — read-only (writes denied)</option>
            </select>
          </div>
          <p className="text-xs text-dim">The copilot calls Claude directly from your browser and acts through the same governed tool surface (RBAC + domain vetoes) as REST/MCP callers.</p>
        </div>
      )}

      <div className="copilot-body" ref={bodyRef}>
        {items.length === 0 && (
          <div className="copilot-empty">
            <div className="copilot-empty-icon"><Sparkles size={24} /></div>
            <div className="fw-600">Operate your CRM by asking</div>
            <p className="text-sm text-muted">The agent calls real, governed tools; the UI updates live as it works.</p>
            <div className="copilot-suggestions">
              {prompts.map((p) => (
                <button key={p} className="copilot-suggestion" onClick={() => run(p)} disabled={running}>{p}</button>
              ))}
            </div>
          </div>
        )}

        {items.map((it) => {
          if (it.kind === 'user') return <div key={it.id} className="copilot-msg user">{it.text}</div>;
          if (it.kind === 'assistant') return <div key={it.id} className="copilot-msg assistant">{it.text || <span className="text-dim">…</span>}</div>;
          if (it.kind === 'error') return <div key={it.id} className="copilot-error"><AlertTriangle size={15} /> {it.text}</div>;
          // tool chip
          const r = it.result;
          const tone = r.ok ? 'ok' : r.denied ? 'denied' : 'error';
          return (
            <div key={it.id} className={`tool-chip ${tone}`}>
              <div className="tool-chip-head">
                <Terminal size={13} />
                <code>{it.name}</code>
                {r.ok ? <span className="tool-status ok"><Check size={12} /> executed</span> : r.denied ? <span className="tool-status denied"><Ban size={12} /> denied</span> : <span className="tool-status error"><AlertTriangle size={12} /> error</span>}
              </div>
              <div className="tool-chip-input">{summarize(it.input)}</div>
              {!r.ok && <div className="tool-chip-error">{r.error}</div>}
            </div>
          );
        })}

        {running && <div className="copilot-msg assistant working"><span className="dot" /><span className="dot" /><span className="dot" /></div>}
      </div>

      <div className="copilot-input">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } }}
          placeholder={hasKey ? 'Ask the copilot to do something…' : 'Add your API key in settings ⚙'}
          rows={2}
        />
        <button className="btn btn-primary" onClick={submit} disabled={running || !input.trim()}>
          <Send size={15} />
        </button>
      </div>
      <div className="copilot-foot"><CornerDownLeft size={11} /> to send · Shift+Enter for newline · Esc to close</div>
    </aside>
  );
}

function summarize(input: unknown): string {
  if (!input || typeof input !== 'object') return String(input ?? '');
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length === 0) return '(no arguments)';
  return entries.map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join('  ·  ');
}
