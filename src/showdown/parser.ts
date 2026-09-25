export interface Condition {
  hpPercent: number;
  status: string | null;
  fainted: boolean;
}
const statuses = new Set(['brn', 'par', 'slp', 'frz', 'psn', 'tox']);
export function parseCondition(value: string): Condition | null {
  if (value === '0 fnt') return { hpPercent: 0, status: null, fainted: true };
  const match = /^(\d+)\/(\d+)(?:[gy])?(?: (brn|par|slp|frz|psn|tox))?$/.exec(value);
  if (!match) return null;
  const hp = Number(match[1]), max = Number(match[2]);
  if (!Number.isSafeInteger(hp) || !Number.isSafeInteger(max) || max <= 0 || hp > max) return null;
  return { hpPercent: 100 * hp / max, status: match[3] ?? null, fainted: false };
}
export const isStatus = (value: string) => statuses.has(value);
export const sideId = (value: string): 'p1' | 'p2' | null => /^(p[12])(?::|a:|$)/.exec(value)?.[1] as 'p1' | 'p2' | undefined ?? null;
export const canonicalIdent = (value: string) => value.replace(/^(p[12])a:/, '$1:');
export const speciesFromDetails = (value: string) => value.split(',')[0]!.trim();
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
