import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One bot per account. Two processes logged in as the same user both receive every battle's messages; a copy left
 * running from the day before kept its old settings while a new one laddered, and the two could each answer the same
 * battle. The lock is a pid file beside the logs: a live process holding it keeps a second one from starting, and a
 * dead one's lock is taken over. A container restarts as pid 1 every time, so a lock naming our own pid is stale.
 */
export const LOCK_FILE = 'bot.pid';
export function acquireInstanceLock(directory: string, pid = process.pid, alive = isAlive): { ok: true } | { ok: false; holder: number } {
  const path = join(directory, LOCK_FILE);
  try {
    const holder = Number(readFileSync(path, 'utf8').trim());
    if (Number.isSafeInteger(holder) && holder > 0 && holder !== pid && alive(holder)) return { ok: false, holder };
  } catch { /* no lock yet */ }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${pid}\n`, { mode: 0o600 });
  return { ok: true };
}
export function releaseInstanceLock(directory: string, pid = process.pid): void {
  const path = join(directory, LOCK_FILE);
  try { if (Number(readFileSync(path, 'utf8').trim()) === pid) rmSync(path); } catch { /* already gone */ }
}
function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}
