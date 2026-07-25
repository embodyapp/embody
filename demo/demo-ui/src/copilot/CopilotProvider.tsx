import React, { createContext, useContext, useState, useRef, useCallback, useMemo } from 'react';
import Anthropic from '@anthropic-ai/sdk';
import { useB2b } from '../data/b2bStore';
import { useEcom } from '../data/ecomStore';
import { useCustomization } from './customization';
import { toolSpecs, executeTool, type Role, type ToolContext, type ToolResult } from './tools';
import { loadPersisted, savePersisted } from '../lib/persist';

export type RunItem =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'tool'; name: string; input: unknown; result: ToolResult }
  | { id: string; kind: 'error'; text: string };

interface CopilotApi {
  open: boolean;
  setOpen: (v: boolean) => void;
  items: RunItem[];
  running: boolean;
  run: (prompt: string) => Promise<void>;
  clear: () => void;
  apiKey: string;
  setApiKey: (k: string) => void;
  hasKey: boolean;
  role: Role;
  setRole: (r: Role) => void;
}

const Ctx = createContext<CopilotApi | null>(null);
const KEY_STORE = 'embody.copilot.key';
const rid = () => Math.random().toString(36).slice(2);

const SYSTEM = `You are the embody Copilot, an AI agent that operates a company's CRM by calling tools.
You act on behalf of the current user and are subject to the same permissions and business rules as any human or REST caller — some actions may be denied (RBAC) or vetoed (domain rules like a required security or HIPAA review). When a tool is denied or vetoed, read the reason and either satisfy the prerequisite (e.g. approve the security review, then retry) or explain clearly why you cannot proceed.
Operate across two apps in one platform: a B2B SaaS sales CRM (b2b_* tools) and an e-commerce customer CRM (ecom_* tools). Resolve names to ids with the find/list tools before acting. Take the actions the user asks for directly; don't ask for confirmation on routine, reversible steps. Keep replies brief — a sentence or two on what you did. Never invent ids.`;

export function CopilotProvider({ children }: { children: React.ReactNode }) {
  const b2b = useB2b();
  const ecom = useEcom();
  const custom = useCustomization();

  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<RunItem[]>([]);
  const [running, setRunning] = useState(false);
  const [apiKey, setApiKeyState] = useState<string>(() => loadPersisted<string>(KEY_STORE, ''));
  const [role, setRole] = useState<Role>('owner');

  // Latest values for the async loop.
  const ctxRef = useRef<ToolContext>({ role, b2b, ecom, custom: { enabled: custom.enabled, isHipaaFlagged: custom.isHipaaFlagged, flagHipaa: custom.flagHipaa } });
  ctxRef.current = { role, b2b, ecom, custom: { enabled: custom.enabled, isHipaaFlagged: custom.isHipaaFlagged, flagHipaa: custom.flagHipaa } };

  // Anthropic conversation history (persists across prompts within a panel session).
  const convo = useRef<Anthropic.MessageParam[]>([]);

  const setApiKey = useCallback((k: string) => { setApiKeyState(k); savePersisted(KEY_STORE, k); }, []);
  const clear = useCallback(() => { setItems([]); convo.current = []; }, []);

  const run = useCallback(async (prompt: string) => {
    if (!prompt.trim() || running) return;
    const key = apiKey.trim();
    if (!key) {
      setItems((x) => [...x, { id: rid(), kind: 'user', text: prompt }, { id: rid(), kind: 'error', text: 'Add your Anthropic API key in Copilot settings to run.' }]);
      return;
    }
    setItems((x) => [...x, { id: rid(), kind: 'user', text: prompt }]);
    setRunning(true);

    const client = new Anthropic({ apiKey: key, dangerouslyAllowBrowser: true });
    const tools = toolSpecs(ctxRef.current.custom.enabled).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema as Anthropic.Tool.InputSchema }));
    convo.current.push({ role: 'user', content: prompt });

    try {
      for (let guard = 0; guard < 8; guard++) {
        const assistantId = rid();
        setItems((x) => [...x, { id: assistantId, kind: 'assistant', text: '' }]);

        const stream = client.messages.stream({
          model: 'claude-opus-4-8',
          max_tokens: 4000,
          system: SYSTEM,
          tools,
          thinking: { type: 'disabled' },
          messages: convo.current,
        });
        stream.on('text', (delta) => {
          setItems((x) => x.map((it) => (it.id === assistantId && it.kind === 'assistant' ? { ...it, text: it.text + delta } : it)));
        });
        const final = await stream.finalMessage();
        // Drop an empty assistant bubble (tool-only turn with no prose).
        setItems((x) => x.filter((it) => !(it.id === assistantId && it.kind === 'assistant' && it.text.trim() === '')));
        convo.current.push({ role: 'assistant', content: final.content });

        const toolUses = final.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
        if (final.stop_reason !== 'tool_use' || toolUses.length === 0) break;

        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const tu of toolUses) {
          const res = executeTool(tu.name, (tu.input ?? {}) as Record<string, any>, ctxRef.current);
          setItems((x) => [...x, { id: rid(), kind: 'tool', name: tu.name, input: tu.input, result: res }]);
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: !res.ok, content: JSON.stringify(res.ok ? res.data : { error: res.error, denied: res.denied }) });
        }
        convo.current.push({ role: 'user', content: results });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setItems((x) => [...x, { id: rid(), kind: 'error', text: msg.includes('401') || msg.toLowerCase().includes('authentication') ? 'Authentication failed — check your Anthropic API key in settings.' : msg }]);
    } finally {
      setRunning(false);
    }
  }, [apiKey, running]);

  const value = useMemo<CopilotApi>(
    () => ({ open, setOpen, items, running, run, clear, apiKey, setApiKey, hasKey: apiKey.trim().length > 0, role, setRole }),
    [open, items, running, run, clear, apiKey, setApiKey, role],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCopilot(): CopilotApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCopilot must be used within CopilotProvider');
  return ctx;
}
