import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  b2bDataset,
  type B2bAccount,
  type B2bContact,
  type B2bDeal,
  type B2bActivity,
  type B2bProduct,
  type DealStage,
  type ActivityType,
} from '../mock/b2b';
import { loadPersisted, savePersisted, newId } from '../lib/persist';

const KEY = 'embody.b2b.v1';

interface B2bState {
  accounts: B2bAccount[];
  contacts: B2bContact[];
  deals: B2bDeal[];
  activities: B2bActivity[];
  products: B2bProduct[];
}

export interface B2bStore extends B2bState {
  accountById: (id: string) => B2bAccount | undefined;
  contactsForAccount: (id: string) => B2bContact[];
  dealsForAccount: (id: string) => B2bDeal[];
  activitiesForDeal: (id: string) => B2bActivity[];
  activitiesForAccount: (id: string) => B2bActivity[];
  dealById: (id: string) => B2bDeal | undefined;
  createDeal: (input: { name: string; accountId: string; amount: number; seats: number; termMonths: number; stage: DealStage; owner: string; closeDate: string }) => B2bDeal;
  updateDeal: (id: string, patch: Partial<B2bDeal>) => { ok: boolean; error?: string; deal?: B2bDeal };
  logActivity: (input: { type: ActivityType; subject: string; body: string; accountId: string; dealId?: string | null; contactId?: string | null; actor: string; dueAt?: string | null }) => B2bActivity;
  toggleTask: (id: string) => void;
  reset: () => void;
}

const Ctx = createContext<B2bStore | null>(null);

const seed = (): B2bState => ({
  accounts: b2bDataset.accounts,
  contacts: b2bDataset.contacts,
  deals: b2bDataset.deals,
  activities: b2bDataset.activities,
  products: b2bDataset.products,
});

export function B2bProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<B2bState>(() => loadPersisted<B2bState>(KEY, seed()));
  // Ref mirrors the latest state synchronously so the copilot can read its own writes within a
  // single agent turn (multiple sequential tool calls) before React re-renders.
  const ref = useRef(state);
  const commit = useCallback((next: B2bState) => { ref.current = next; setState(next); }, []);

  useEffect(() => { savePersisted(KEY, state); }, [state]);

  const accountById = useCallback((id: string) => ref.current.accounts.find((a) => a.id === id), []);
  const dealById = useCallback((id: string) => ref.current.deals.find((d) => d.id === id), []);
  const contactsForAccount = useCallback((id: string) => ref.current.contacts.filter((c) => c.accountId === id), []);
  const dealsForAccount = useCallback((id: string) => ref.current.deals.filter((d) => d.accountId === id), []);
  const activitiesForDeal = useCallback((id: string) => ref.current.activities.filter((a) => a.dealId === id).sort((x, y) => y.at.localeCompare(x.at)), []);
  const activitiesForAccount = useCallback((id: string) => ref.current.activities.filter((a) => a.accountId === id).sort((x, y) => y.at.localeCompare(x.at)), []);

  const createDeal: B2bStore['createDeal'] = useCallback((input) => {
    const nowIso = new Date().toISOString();
    const deal: B2bDeal = {
      id: newId('deal'), name: input.name, accountId: input.accountId, stage: input.stage,
      amount: input.amount, seats: input.seats, termMonths: input.termMonths,
      probability: input.stage === 'closed_won' ? 100 : input.stage === 'negotiation' ? 80 : input.stage === 'proposal' ? 55 : input.stage === 'discovery' ? 30 : 15,
      owner: input.owner, closeDate: input.closeDate, nextStep: 'Set next step',
      securityReviewPassed: false, dpaSigned: false, createdAt: nowIso, updatedAt: nowIso,
    };
    commit({ ...ref.current, deals: [deal, ...ref.current.deals] });
    return deal;
  }, [commit]);

  // Mirrors the B2B InfoSec veto: deals >= $50k can't move to closed_won without a passed security review.
  const updateDeal: B2bStore['updateDeal'] = useCallback((id, patch) => {
    const existing = ref.current.deals.find((d) => d.id === id);
    if (!existing) return { ok: false, error: 'Deal not found' };
    const next = { ...existing, ...patch };
    if (next.stage === 'closed_won' && next.amount >= 50000 && !next.securityReviewPassed) {
      return { ok: false, error: 'Enterprise deals over $50,000 require an approved security review before moving to Closed Won.' };
    }
    if (patch.stage === 'closed_won') next.probability = 100;
    if (patch.stage === 'closed_lost') next.probability = 0;
    next.updatedAt = new Date().toISOString();
    commit({ ...ref.current, deals: ref.current.deals.map((d) => (d.id === id ? next : d)) });
    return { ok: true, deal: next };
  }, [commit]);

  const logActivity: B2bStore['logActivity'] = useCallback((input) => {
    const nowIso = new Date().toISOString();
    const activity: B2bActivity = {
      id: newId('act'), type: input.type, subject: input.subject, body: input.body,
      accountId: input.accountId, dealId: input.dealId ?? null, contactId: input.contactId ?? null,
      actor: input.actor, at: nowIso, done: input.type !== 'task', dueAt: input.dueAt ?? null,
    };
    commit({ ...ref.current, activities: [activity, ...ref.current.activities] });
    return activity;
  }, [commit]);

  const toggleTask: B2bStore['toggleTask'] = useCallback((id) => {
    commit({ ...ref.current, activities: ref.current.activities.map((a) => (a.id === id ? { ...a, done: !a.done } : a)) });
  }, [commit]);

  const reset = useCallback(() => commit(seed()), [commit]);

  const value = useMemo<B2bStore>(
    () => ({ ...state, accountById, dealById, contactsForAccount, dealsForAccount, activitiesForDeal, activitiesForAccount, createDeal, updateDeal, logActivity, toggleTask, reset }),
    [state, accountById, dealById, contactsForAccount, dealsForAccount, activitiesForDeal, activitiesForAccount, createDeal, updateDeal, logActivity, toggleTask, reset],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useB2b(): B2bStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useB2b must be used within B2bProvider');
  return ctx;
}
