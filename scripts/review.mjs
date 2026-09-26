// Flag the turns worth a second look in recent battles: the checks that found most misplays by hand, in one pass.
//   npm run review                   the last 10 battles
//   npm run review -- --last 30      the last 30
//   npm run review -- --game 2687511902
// Offline: it reads logs/battle-*.jsonl through the current strategy code and makes no calls. Every flag names the
// turn, what was played, what was passed over, and the numbers behind it, most serious first within each battle.
//
//   guard-overruled-both  a guard skipped the move Jev and the search both chose, the search by 0.05 or more
//   guard-vs-search       a guard skipped the search's choice for one it rated at least 0.1 lower
//   knockout-passed       a legal attack knocked the target out at every sampled roll and moved first; we did not use it
//   did-nothing           our move was immune or failed, and why: the target switched in on it, Terastallized that
//                         turn, showed an ability, we were locked into the move, or it was already on the field
//   wrong-sacrifice       a Pokémon we sent in, by choice or after a faint, fainted before it acted while a teammate at
//                         25 points of HP less or more could have taken the hit instead
//   fainted-on-entry      a Pokémon we chose to switch in, at half HP or more, fainted before it acted
//   repeated-status       the same status move three turns or more in a row at full HP
// Each battle closes with its luck: critical hits and misses on each side, full paralysis and flinches.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({ options: { last: { type: 'string', default: '10' }, game: { type: 'string' } } });
const root = new URL('..', import.meta.url).pathname;
const { damageRange } = await import(root + 'dist/src/strategy/damage.js');
const { turnOrder } = await import(root + 'dist/src/strategy/speed.js');
const { hitChancePercent } = await import(root + 'dist/src/pokemon/mechanics.js');
const { dex } = await import(root + 'dist/src/pokemon/data.js');

const files = readdirSync(root + 'logs').filter(f => f.startsWith('battle-') && f.endsWith('.jsonl'))
  .filter(f => !args.game || f.includes(args.game))
  .map(f => ({ f, t: statSync(root + 'logs/' + f).mtimeMs })).sort((a, b) => b.t - a.t)
  .slice(0, args.game ? undefined : Number(args.last)).reverse().map(x => x.f);

const severity = { 'guard-overruled-both': 0, 'guard-vs-search': 1, 'knockout-passed': 2, 'wrong-sacrifice': 3, 'did-nothing': 4, 'fainted-on-entry': 5, 'repeated-status': 6 };
const totals = {};
for (const f of files) {
  let rows; try { rows = readFileSync(root + 'logs/' + f, 'utf8').trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return {}; } }); } catch { continue; }
  const decisions = rows.filter(r => r.event === 'decision' && r.state && r.decision);
  if (!decisions.length) continue;
  const win = rows.find(r => r.event === 'win');
  const my = (win ?? decisions[0]).state.mySide, foeSide = my === 'p1' ? 'p2' : 'p1';
  const lines = rows.filter(r => r.event === 'line').map(r => r.line ?? '');
  const byTurn = new Map(); { let t = 0; for (const l of lines) { const m = l.match(/^\|turn\|(\d+)/); if (m) t = +m[1]; (byTurn.get(t) ?? byTurn.set(t, []).get(t)).push(l); } }
  const opponent = (win ?? decisions.at(-1)).state.sides[foeSide]?.name ?? '?';
  const result = !win ? 'unfinished' : win.state.winner === (win.state.sides[my]?.name) ? 'WON' : 'LOST';
  const flags = [];
  const flag = (kind, turn, text) => { flags.push({ kind, turn, text }); totals[kind] = (totals[kind] ?? 0) + 1; };
  let streak = { move: null, count: 0, from: 0 };

  for (const r of decisions) {
    const d = r.decision, s = r.state, t = s.turn;
    const L = id => d.legalActions.find(a => a.id === id)?.label ?? id;
    const values = d.search?.values ?? {}, score = id => values[id]?.meanScore;
    const searchTop = Object.entries(values).sort((a, b) => b[1].visitShare - a[1].visitShare)[0]?.[0];
    const jev = d.providerResult?.chosenAction, played = d.selectedAction.id;
    const me = s.sides[my]?.team.find(p => p.id === s.sides[my].activeId);
    const foe = s.sides[foeSide]?.team.find(p => p.id === s.sides[foeSide].activeId);
    const skip = d.skippedDominatedMove;
    const lead = skip && score(skip.from) != null && score(skip.to) != null ? score(skip.from) - score(skip.to) : null;
    if (skip && skip.from === jev && skip.from === searchTop && lead !== null && lead >= 0.05) {
      flag('guard-overruled-both', t, `${L(skip.from)} (Jev and the search both, search ${score(skip.from)?.toFixed(2)}) skipped for ${L(skip.to)} (${score(skip.to)?.toFixed(2)}): ${skip.reason.slice(0, 140)}`);
    } else if (skip && lead !== null && lead >= 0.1) {
      flag('guard-vs-search', t, `${L(skip.from)} (${score(skip.from).toFixed(2)}) skipped for ${L(skip.to)} (${score(skip.to).toFixed(2)}): ${skip.reason.slice(0, 140)}`);
    }
    // A certain knockout that moves first, and a move played instead that is neither it nor another one.
    // Asleep, frozen or recharging, our Pokémon could not have used the knockout: Chi-Yu, Spored, was flagged for a
    // Psychic it could not reach (2687851220).
    const cannotAct = me && (['slp', 'frz'].includes(me.status ?? '') || Object.keys(me.volatiles ?? {}).some(k => /mustrecharge/i.test(k)));
    if (s.requestKind === 'move' && me && foe && !cannotAct && !foe.fainted && !Object.keys(foe.volatiles ?? {}).some(k => /substitute/i.test(k))) {
      const moveOf = a => a.kind === 'move' ? a.label.split(' + Tera')[0] : null;
      const teraOf = a => a.command?.endsWith(' terastallize') ? me.teraType ?? undefined : undefined;
      const certain = (name, tera) => { try { return dex.moves.get(name).category !== 'Status' && damageRange(s, name, tera)?.conditionalKO === 'all-sampled-rolls'; } catch { return false; } };
      // A knockout paid for with recoil or the user's own faint is not one to insist on: Squawkabilly at 13% took a
      // Tera Facade over a Brave Bird whose recoil would have knocked it out too (2687654389).
      const costly = m => !!(m.recoil || m.mindBlownRecoil || m.selfdestruct || m.hasCrashDamage);
      const ko = d.legalActions.map(moveOf).find(n => n && n !== 'Sucker Punch' && !costly(dex.moves.get(n)) && certain(n) &&
        hitChancePercent(n, s.field.weather, me, foe) >= 100 && turnOrder(s, me, n)?.order === 'ours-first');
      const playedMove = moveOf(d.selectedAction);
      if (ko && playedMove !== ko && !(playedMove && certain(playedMove, teraOf(d.selectedAction)))) {
        const teraLeft = !s.sides[foeSide].team.some(p => p.terastallized);
        flag('knockout-passed', t, `${ko} moved first and knocked ${foe.species} (${Math.round(foe.hpPercent ?? 0)}%) out at every sampled roll${teraLeft ? ' (unless it Terastallizes)' : ''}; played ${L(played)} by ${d.decidedBy ?? 'provider'}${jev && jev !== played ? `, Jev wanted ${L(jev)}` : ''}`);
      }
    }
    // What our move did, from the turn's protocol lines.
    const turnLines = byTurn.get(t) ?? [];
    const ourMove = turnLines.findIndex(l => l.startsWith(`|move|${my}a: `));
    if (ourMove >= 0 && s.requestKind === 'move') {
      const next = turnLines[ourMove + 1] ?? '';
      // A move with no target left (it fainted first) is not a wasted choice.
      if (/^\|-(immune|fail)\|/.test(next) && !/^\|-fail\|.*\|(unboost|boost)/.test(next) && !turnLines[ourMove].includes('[notarget]')) {
        // Why it did nothing decides whether it was ours to avoid: a Pokémon switched in on it, or a Tera that turn, is
        // the opponent's read; one already facing us, as it was when we chose, is a move we should not have picked.
        const before = turnLines.slice(0, ourMove);
        const read = before.find(l => new RegExp(`^\\|(switch|drag)\\|${foeSide}a: `).test(l))
          ? 'switched in on it' : before.find(l => l.startsWith(`|-terastallize|${foeSide}a: `))
          ? `Terastallized to ${before.find(l => l.startsWith(`|-terastallize|${foeSide}a: `)).split('|')[3]} that turn` : null;
        const moves = new Set(d.legalActions.filter(a => a.kind === 'move').map(a => a.label.split(' + Tera')[0]));
        const why = read ?? (moves.size === 1 ? 'locked into it' : /\[from\] ability: /.test(next) && !foe?.ability
          ? 'an ability not yet shown' : 'already on the field when chosen');
        flag('did-nothing', t, `${turnLines[ourMove].split('|')[3]} → ${next.split('|').slice(1, 4).join(' ')} (${why})`);
      }
    }
    // A Pokémon we sent in, by choice or as the replacement for one that fainted, that fainted before acting. Below half
    // HP a voluntary one is usually a deliberate sacrifice. Either way, a clearly weaker teammate that could have taken
    // the hit instead makes it the wrong one to lose: a full Copperajah went in to a Spectrier's Tera Blast with a 24%
    // Ludicolo on the bench (2688262107).
    if (d.selectedAction.kind === 'switch') {
      const base = label => label.replace(/^Switch to /, '').split(',')[0].split('-')[0];
      const target = d.selectedAction.label.replace(/^Switch to /, '').split(',')[0];
      const member = label => s.sides[my].team.find(p => p.species.split('-')[0] === base(label) && p.id !== s.sides[my].activeId);
      const incoming = member(d.selectedAction.label);
      const actedAfter = [t, t + 1].flatMap(x => byTurn.get(x) ?? []);
      const entered = actedAfter.findIndex(l => l.startsWith(`|switch|${my}a: `) && l.includes(target));
      // Its own faint and its own move: a teammate that came in after it and fainted is not it.
      const own = (l, kind) => l.startsWith(`|${kind}|${my}a: `) && l.split('|')[2].includes(base(target));
      const left = entered >= 0 ? actedAfter.findIndex((l, i) => i > entered && l.startsWith(`|switch|${my}a: `)) : -1;
      const fainted = entered >= 0 ? actedAfter.findIndex((l, i) => i > entered && (left < 0 || i < left) && own(l, 'faint')) : -1;
      const moved = entered >= 0 ? actedAfter.findIndex((l, i) => i > entered && own(l, 'move')) : -1;
      if (fainted >= 0 && (moved < 0 || moved > fainted)) {
        const hp = Math.round(incoming?.hpPercent ?? 100);
        const weaker = d.legalActions.filter(a => a.kind === 'switch' && a.id !== d.selectedAction.id).map(a => member(a.label))
          .filter(p => p && !p.fainted && (p.hpPercent ?? 100) + 25 <= hp).sort((a, b) => (a.hpPercent ?? 0) - (b.hpPercent ?? 0));
        const instead = weaker.length ? `, while ${weaker.map(p => `${p.species} at ${Math.round(p.hpPercent ?? 0)}%`).join(' and ')} could have gone instead` : '';
        const who = `(Jev ${L(jev) ?? '—'}, search ${L(searchTop) ?? '—'})`;
        if (s.requestKind === 'switch' && weaker.length) flag('wrong-sacrifice', t, `sent ${target} in at ${hp}% after a faint, and it fainted before acting${instead} ${who}`);
        else if (s.requestKind === 'move' && hp >= 50) flag(weaker.length ? 'wrong-sacrifice' : 'fainted-on-entry', t, `switched to ${target} at ${hp}%, which fainted before acting${instead} ${who}`);
      }
    }
    // The same status move turn after turn at full HP.
    const status = d.selectedAction.kind === 'move' && dex.moves.get(d.selectedAction.label.split(' + Tera')[0]).category === 'Status'
      && (me?.hpPercent ?? 0) >= 100 ? d.selectedAction.label : null;
    if (status && status === streak.move) streak.count++;
    else { if (streak.count >= 3) flag('repeated-status', streak.from, `${streak.move} ${streak.count} turns in a row at full HP (turns ${streak.from}–${streak.from + streak.count - 1})`); streak = { move: status, count: status ? 1 : 0, from: t }; }
  }
  if (streak.count >= 3) flag('repeated-status', streak.from, `${streak.move} ${streak.count} turns in a row at full HP (turns ${streak.from}–${streak.from + streak.count - 1})`);

  // Luck, both ways: what the dice did to each side.
  const luck = { ours: { crit: 0, miss: 0, para: 0, flinch: 0 }, theirs: { crit: 0, miss: 0, para: 0, flinch: 0 } };
  for (const l of lines) {
    const side = l.split('|')[2]?.slice(0, 2);
    if (/^\|-crit\|/.test(l)) (side === my ? luck.theirs : luck.ours).crit++; // the crit lands on the side named
    if (/^\|-miss\|/.test(l)) (side === my ? luck.ours : luck.theirs).miss++; // the miss is by the side named
    if (/^\|cant\|.*\|par/.test(l)) (side === my ? luck.ours : luck.theirs).para++;
    if (/^\|cant\|.*\|flinch/.test(l)) (side === my ? luck.ours : luck.theirs).flinch++;
  }
  const bid = f.match(/randombattle-(\d+)/)?.[1] ?? f;
  console.log(`\n${bid}  ${result} vs ${opponent}  (${win?.state.turn ?? decisions.at(-1).state.turn} turns)`);
  console.log(`  luck — our crits ${luck.ours.crit}, misses ${luck.ours.miss}, full paralysis ${luck.ours.para}, flinches ${luck.ours.flinch}; theirs ${luck.theirs.crit}, ${luck.theirs.miss}, ${luck.theirs.para}, ${luck.theirs.flinch}`);
  if (!flags.length) { console.log('  nothing flagged'); continue; }
  for (const x of flags.sort((a, b) => severity[a.kind] - severity[b.kind] || a.turn - b.turn)) console.log(`  t${x.turn} ${x.kind}: ${x.text}`);
}
console.log(`\n${files.length} battles; flags: ${Object.entries(totals).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
