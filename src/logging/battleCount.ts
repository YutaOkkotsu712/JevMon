import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * MAX_BATTLES has to survive a restart to mean anything. Under a restart policy a failed login or a crash starts
 * a fresh process, and a count held only in memory would hand it a fresh allowance of paid battles. So the count
 * lives beside the battle logs, in the directory that outlives the container. Deleting the file resets it.
 */
export const BATTLE_COUNT_FILE = 'battles-played';
/** Ladder battles started in the current run of LADDER_BATTLES; deleting it starts a fresh run. */
export const LADDER_COUNT_FILE = 'ladder-battles-played';

/** Battles already played, or null when a count exists but cannot be read, which callers treat as exhausted. */
export function readBattlesPlayed(directory: string, file = BATTLE_COUNT_FILE): number | null {
  let text: string;
  try { text = readFileSync(join(directory, file), 'utf8'); }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 0 : null; }
  const played = Number(text.trim());
  return text.trim() !== '' && Number.isSafeInteger(played) && played >= 0 ? played : null;
}

export function recordBattlesPlayed(directory: string, played: number, file = BATTLE_COUNT_FILE): boolean {
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, file), `${played}\n`, { mode: 0o600 });
    return true;
  } catch { return false; }
}
