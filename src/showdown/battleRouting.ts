/**
 * What a battle room's `init` means to a bot that plays one battle at a time.
 *
 * - `renamed`: a hidden battle moves to `<room>-<password>pw` once it is hidden, which happens when a player's settings
 *   hide their battles. It is the same game under a new name, so the battle follows it instead of starting another.
 * - `adopt`: a battle begins while we hold none. It is counted only when we asked for it — an accepted challenge or a
 *   ladder search — so a rejoin after a restart is not counted twice. While laddering, any battle the server opens for
 *   us is ours to play: ignoring one because no search was pending once left a game unplayed while a second began.
 * - `ignore`: we already hold a different battle, or this room has finished.
 */
export type InitRoute = { kind: 'ignore' } | { kind: 'renamed'; from: string } | { kind: 'adopt'; sought: boolean };
export function routeBattleInit(room: string, s: { current: string | null; finished: ReadonlySet<string>;
  challengeAwaiting: boolean; laddering: boolean; ladderAwaiting: boolean }): InitRoute {
  if (s.finished.has(room)) return { kind: 'ignore' };
  if (s.current) return room !== s.current && room.startsWith(`${s.current}-`) ? { kind: 'renamed', from: s.current } : { kind: 'ignore' };
  if (s.challengeAwaiting || s.ladderAwaiting) return { kind: 'adopt', sought: true };
  return s.laddering ? { kind: 'adopt', sought: false } : { kind: 'ignore' };
}
