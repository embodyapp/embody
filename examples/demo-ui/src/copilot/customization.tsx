import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import { loadPersisted, savePersisted } from '../lib/persist';

/**
 * "custom/acme-crm" — a customization layer that extends the B2B CRM WITHOUT editing the
 * CRM pages, stores, or tools. It adds:
 *   1. a vetoable rule (healthcare-vertical deals need a HIPAA review before Closed Won), and
 *   2. a new agent tool (`acme_flag_hipaa`) the copilot can call the moment it's enabled.
 * Toggling it on/off proves the platform picks up the customization live. This mirrors, on the
 * client, what a `custom/*` plugin does on the embody backend (migration + hook + MCP tool).
 */
const KEY = 'embody.custom.acme.v1';

interface CustomState {
  enabled: boolean;
  hipaaFlagged: string[]; // deal ids that passed HIPAA review
}

interface CustomizationApi extends CustomState {
  setEnabled: (v: boolean) => void;
  flagHipaa: (dealId: string) => void;
  isHipaaFlagged: (dealId: string) => boolean;
}

const Ctx = createContext<CustomizationApi | null>(null);

export function CustomizationProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<CustomState>(() => loadPersisted<CustomState>(KEY, { enabled: false, hipaaFlagged: [] }));

  const persist = useCallback((next: CustomState) => { setState(next); savePersisted(KEY, next); }, []);

  const setEnabled = useCallback((v: boolean) => persist({ ...state, enabled: v }), [state, persist]);
  const flagHipaa = useCallback((dealId: string) => {
    if (state.hipaaFlagged.includes(dealId)) return;
    persist({ ...state, hipaaFlagged: [...state.hipaaFlagged, dealId] });
  }, [state, persist]);
  const isHipaaFlagged = useCallback((dealId: string) => state.hipaaFlagged.includes(dealId), [state.hipaaFlagged]);

  const value = useMemo<CustomizationApi>(
    () => ({ ...state, setEnabled, flagHipaa, isHipaaFlagged }),
    [state, setEnabled, flagHipaa, isHipaaFlagged],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCustomization(): CustomizationApi {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useCustomization must be used within CustomizationProvider');
  return ctx;
}
