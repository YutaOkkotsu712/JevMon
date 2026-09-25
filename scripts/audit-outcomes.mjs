// Checks the bot's factual claims against what the logged battles actually did. Payload numbers are only useful if
// they are right, and three bugs in one day — sleep odds one turn early, Diamond Storm's 50% boost given as certain,
// a world sampler that kept one moveset per opponent — were each visible in the logs long before anyone looked.
//   npm run build && node scripts/audit-outcomes.mjs        last 60 games
//   node scripts/audit-outcomes.mjs 120                     last 120 games
// For every move decision it replays the turn from the log and compares:
//   turn order   the order our chosen move was predicted to take against who actually moved first
//   our damage   the predicted range for our move against the HP it actually took off the target
//   knockouts    a predicted certain knockout against whether the target fainted
//   their damage the predicted range of the move they used against the HP it actually took off us
// Turns with a crit, a Substitute, a Tera, a switch or an item or ability that changes damage mid-turn are skipped.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { damageRange } from '../dist/src/strategy/damage.js';
import { turnOrder } from '../dist/src/strategy/speed.js';
import { incomingThreats } from '../dist/src/strategy/threat.js';
import { dex, id } from '../dist/src/pokemon/data.js';

const games = Number(process.argv[2] ?? 60);
const files = readdirSync('logs').filter(f => f.startsWith('battle-') && f.endsWith('.jsonl')).map(f => `logs/${f}`)
  .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs).slice(-games);

const tally = { order: { checked: 0, wrong: 0 }, ours: { checked: 0, low: 0, high: 0 }, ko: { claimed: 0, missed: 0 }, theirs: { checked: 0, low: 0, high: 0 } };
const examples = { order: [], ours: [], ko: [], theirs: [] };
const note = (kind, text) => { if (examples[kind].length < 12) examples[kind].push(text); };
const hpOf = token => { const m = /^(\d+)\/(\d+)/.exec(token ?? ''); return m ? { hp: +m[1], max: +m[2] } : token?.startsWith('0 fnt') ? { hp: 0, max: null } : null; };

for (const f of files) {
  let rows; try { rows = readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)); } catch { continue; }
  const game = f.match(/-(\d{10})-/)?.[1];
  // Lines of each turn, keyed by the turn number they lead up to the end of.
  const turnLines = new Map(); let t = 0;
  for (const r of rows) {
    if (r.event !== 'line') continue;
    const m = /^\|turn\|(\d+)/.exec(r.line); if (m) { t = +m[1]; continue; }
    if (!turnLines.has(t)) turnLines.set(t, []); turnLines.get(t).push(r.line);
  }
  for (const r of rows) {
    if (r.event !== 'decision' || r.state.requestKind !== 'move') continue;
    const s = r.state, side = s.mySide, foeSide = side === 'p1' ? 'p2' : 'p1';
    const me = s.sides[side].team.find(p => p.id === s.sides[side].activeId), foe = s.sides[foeSide].team.find(p => p.id === s.sides[foeSide].activeId);
    const action = r.decision.selectedAction;
    if (!me || !foe || me.fainted || foe.fainted || action.kind !== 'move') continue;
    const lines = turnLines.get(s.turn) ?? [];
    if (lines.some(l => /^\|(switch|drag|replace|detailschange)\|/.test(l.split('|').slice(0, 2).join('|') + '|') && l.startsWith('|switch|' + foeSide))) continue;
    if (lines.some(l => l.startsWith('|-terastallize|'))) continue;
    const moveName = action.label.split(' + Tera')[0];
    const move = dex.moves.get(moveName);
    const ourMoveAt = lines.findIndex(l => l.startsWith(`|move|${side}a:`));
    const theirMoveAt = lines.findIndex(l => l.startsWith(`|move|${foeSide}a:`));

    // Turn order, only when both actually moved and the claim was definite.
    if (ourMoveAt >= 0 && theirMoveAt >= 0) {
      let order; try { order = turnOrder(s, me, moveName)?.order; } catch { order = undefined; }
      if (order === 'ours-first' || order === 'theirs-first') {
        tally.order.checked++;
        const actual = ourMoveAt < theirMoveAt ? 'ours-first' : 'theirs-first';
        const theirMove = lines[theirMoveAt].split('|')[3];
        const theirPriority = dex.moves.get(theirMove).priority ?? 0;
        if (actual !== order) { tally.order.wrong++; note('order', `${game} t${s.turn} ${me.species} ${moveName} vs ${foe.species} ${theirMove} (prio ${theirPriority}): predicted ${order}, was ${actual}`); }
      }
    }

    // Our damage: the first damage line on their active after our move, before anything else moves.
    if (ourMoveAt >= 0 && move.category !== 'Status') {
      const after = lines.slice(ourMoveAt + 1);
      const end = after.findIndex(l => l.startsWith('|move|') || l.startsWith('|switch|') || l.startsWith('|faint|'));
      const window = end < 0 ? after : after.slice(0, end + (after[end]?.startsWith('|faint|') ? 1 : 0));
      // A stat change earlier in the turn (their Bulk Up before our hit) is not in the predicted state either.
      const changedFirst = lines.slice(0, ourMoveAt).some(l => /^\|-(boost|unboost|setboost|clearboost|clearallboost|clearnegativeboost|copyboost|swapboost|invertboost)\|/.test(l));
      const clean = !changedFirst && !window.some(l => /^\|-(crit|miss|immune|fail)\|/.test(l) || /Substitute|\[from\] item: (Focus Sash|Air Balloon)|ability: (Sturdy|Disguise|Ice Face|Multiscale)/.test(l));
      const hits = window.filter(l => l.startsWith(`|-damage|${foeSide}a:`) && !l.includes('[from]'));
      if (clean && hits.length === 1 && !move.multihit) {
        let range; try { range = damageRange(s, moveName); } catch { range = null; }
        // Their HP just before our move: replay what happened to it earlier in the turn, such as a Roost.
        let before = foe.hpPercent;
        for (const l of lines.slice(0, ourMoveAt)) { if (l.startsWith(`|-damage|${foeSide}a:`) || l.startsWith(`|-heal|${foeSide}a:`)) { const h = hpOf(l.split('|')[3]); if (h) before = h.hp; } }
        const after = hpOf(hits[0].split('|')[3]);
        if (range && before !== null && after && (after.max === 100 || after.hp === 0)) {
          const dealt = before - after.hp, [lo, hi] = range.percentOfMaxHP;
          const fainted = after.hp === 0;
          // A target that faints takes only the HP it had, and one that moved first may have changed what it takes:
          // Roost drops Flying for the turn, a Prankster screen or a boost lands before our hit.
          const movedFirst = theirMoveAt >= 0 && theirMoveAt < ourMoveAt && dex.moves.get(lines[theirMoveAt].split('|')[3]).category === 'Status';
          if (!fainted && !movedFirst) {
            tally.ours.checked++;
            if (dealt < lo - 2) { tally.ours.low++; note('ours', `${game} t${s.turn} ${me.species} ${moveName} -> ${foe.species}: dealt ${dealt.toFixed(0)}%, predicted ${lo}-${hi}%`); }
            else if (dealt > hi + 2 && !fainted) { tally.ours.high++; note('ours', `${game} t${s.turn} ${me.species} ${moveName} -> ${foe.species}: dealt ${dealt.toFixed(0)}%, predicted ${lo}-${hi}%`); }
          }
          // The claim was made at the HP of the decision; only a target no healthier when hit can test it.
          if (range.conditionalKO === 'all-sampled-rolls' && before <= (foe.hpPercent ?? 100)) {
            tally.ko.claimed++;
            if (!fainted) { tally.ko.missed++; note('ko', `${game} t${s.turn} ${me.species} ${moveName} -> ${foe.species} at ${before}%: predicted a certain knockout, left it at ${after.hp}%`); }
          }
        }
      }
    }

    // Their damage to us, against the predicted range for the move they actually used.
    if (theirMoveAt >= 0) {
      const theirMove = lines[theirMoveAt].split('|')[3];
      const after = lines.slice(theirMoveAt + 1);
      const end = after.findIndex(l => l.startsWith('|move|') || l.startsWith('|switch|') || l.startsWith('|faint|'));
      const window = end < 0 ? after : after.slice(0, end);
      const changedFirst = lines.slice(0, theirMoveAt).some(l => /^\|-(boost|unboost|setboost|clearboost|clearallboost|clearnegativeboost|copyboost|swapboost|invertboost)\|/.test(l));
      const clean = !changedFirst && !window.some(l => /^\|-(crit|miss|immune|fail)\|/.test(l) || /Substitute|\[from\] item: Focus Sash|ability: (Sturdy|Disguise|Multiscale)/.test(l));
      const hits = window.filter(l => l.startsWith(`|-damage|${side}a:`) && !l.includes('[from]'));
      const tm = dex.moves.get(theirMove);
      if (clean && hits.length === 1 && tm.category !== 'Status' && !tm.multihit && me.exactHP) {
        // Our HP just before their move: replay any damage or healing to us earlier in the turn.
        let hp = me.exactHP.current;
        for (const l of lines.slice(0, theirMoveAt)) { if (l.startsWith(`|-damage|${side}a:`) || l.startsWith(`|-heal|${side}a:`)) { const h = hpOf(l.split('|')[3]); if (h) hp = h.hp; } }
        const now = hpOf(hits[0].split('|')[3]);
        let threat; try { threat = incomingThreats(s, me, side, Infinity); } catch { threat = null; }
        const predicted = threat?.damagingMoves.find(m => id(m.move) === id(theirMove));
        if (predicted && now && now.hp > 0) {
          tally.theirs.checked++;
          const taken = (hp - now.hp) / me.exactHP.max * 100, [lo, hi] = predicted.percentOfMaxHP;
          if (taken > hi + 2) { tally.theirs.high++; note('theirs', `${game} t${s.turn} ${foe.species} ${theirMove} -> ${me.species}: took ${taken.toFixed(1)}%, predicted ${lo}-${hi}%`); }
          else if (taken < lo - 2) { tally.theirs.low++; note('theirs', `${game} t${s.turn} ${foe.species} ${theirMove} -> ${me.species}: took ${taken.toFixed(1)}%, predicted ${lo}-${hi}%`); }
        }
      }
    }
  }
}

const pct = (a, b) => (b ? `${(a / b * 100).toFixed(1)}%` : '-');
console.log(`outcome audit over the last ${files.length} games`);
console.log(`turn order: ${tally.order.checked} definite predictions, wrong ${tally.order.wrong} (${pct(tally.order.wrong, tally.order.checked)})`);
console.log(`our damage: ${tally.ours.checked} clean hits, below range ${tally.ours.low} (${pct(tally.ours.low, tally.ours.checked)}), above ${tally.ours.high} (${pct(tally.ours.high, tally.ours.checked)})`);
console.log(`knockouts: ${tally.ko.claimed} certain knockouts landed cleanly, ${tally.ko.missed} left the target standing (${pct(tally.ko.missed, tally.ko.claimed)})`);
console.log(`their damage: ${tally.theirs.checked} clean hits, above range ${tally.theirs.high} (${pct(tally.theirs.high, tally.theirs.checked)}), below ${tally.theirs.low} (${pct(tally.theirs.low, tally.theirs.checked)})`);
for (const [kind, list] of Object.entries(examples)) if (list.length) { console.log(`\n${kind}:`); for (const e of list) console.log('  ' + e); }
