import type { EmbodyPlugin, Principal } from "@embody/core";
import type { WakeQueue, WakeTask } from "../../src/index.js";

export const APP_ID: string;
export const SHIP_DELAY_MS: number;
export const FAN_LEAVES: number;
export const FIXTURE_TABLES: string;
export function FIXTURE_GRANTS(role: string): string;
export interface M20Effects {
  apply(key: string): Promise<void>;
  ledger(prefix: string): Promise<{ effects: string[]; attempts: Record<string, number> }>;
  close(): Promise<void>;
}
export function createEffects(connectionString: string): M20Effects;
export interface TableQueue extends WakeQueue {
  outage: boolean;
  due(org: string, now?: Date): Promise<WakeTask[]>;
  all(org: string): Promise<{ name: string; body: unknown; delivered: boolean }[]>;
  acknowledge(name: string): Promise<void>;
  close(): Promise<void>;
}
export function createTableQueue(connectionString: string): TableQueue;
export function createPlugins(
  effects: M20Effects,
  pause?: (point: string) => Promise<void>,
): EmbodyPlugin[];
export function principal(orgId: string): Principal;
