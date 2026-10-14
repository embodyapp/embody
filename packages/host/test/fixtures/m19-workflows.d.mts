import type { EmbodyPlugin } from "@embody/core";

export interface M19Effects {
  apply(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  allow(key: string): Promise<void>;
  ledger(prefix: string): Promise<{ effects: string[]; attempts: Record<string, number> }>;
  close(): Promise<void>;
}
export function createEffects(connectionString: string): M19Effects;
export function createPlugins(
  effects: M19Effects,
  pause?: (point: string) => Promise<void>,
): EmbodyPlugin[];
