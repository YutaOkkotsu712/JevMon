import { test } from 'node:test';
import assert from 'node:assert/strict';
import { switchPunish } from '../src/strategy/prediction.js';
import { battle, ours } from './helpers.js';
import { futileProtect } from '../src/strategy/dominance.js';
import { dedupeCandidates, scenario } from '../src/strategy/calcCore.js';
import { inferOpponent } from '../src/strategy/inference.js';
import { movePriority } from '../src/strategy/speed.js';
import { effectViability } from '../src/strategy/viability.js';
import type { BattleAction } from '../src/battle/LegalActionGenerator.js';

test('a move is priced against the Pokémon they might bring in, not only the one in front of us', () => {
  // The user's case: the move that is worst against what is in front of us is the one that catches the switch.
  const b = battle([ours('Weavile', 79, ['Knock Off', 'Ice Punch'], 'Pressure', 'Heavy-Duty Boots', 'Dark')], 'Conkeldurr');
  b.feed('|switch|p2a: Gengar|Gengar, L80|100/100');
  b.feed('|switch|p2a: Foe|Conkeldurr, L82|100/100');
  const r = switchPunish(b.state, b.me(), 'p1', ['Knock Off', 'Ice Punch'])!;
  const gengar = r.likelyToComeIn.find(x => x.species === 'Gengar');
  assert.ok(gengar, 'a revealed bench Pokémon is ranked as a possible arrival');
  assert.equal(gengar.ourBestAnswer, 'Knock Off', 'Dark catches the Ghost that Ice Punch does not');
  assert.ok(gengar.ourMoveDamage['Knock Off']!.percentOfItsMaxHP[0] > gengar.ourMoveDamage['Ice Punch']!.percentOfItsMaxHP[1],
    'the two moves do not overlap, so the choice is real');
  // The Pokémon actually on the field is never listed as something they could switch to.
  assert.ok(!r.likelyToComeIn.some(x => x.species === 'Conkeldurr'));
});

test('nothing is claimed when their bench is unrevealed or we have no attack', () => {
  const fresh = battle([ours('Weavile', 79, ['Knock Off'], 'Pressure', 'Heavy-Duty Boots', 'Dark')], 'Conkeldurr');
  assert.equal(switchPunish(fresh.state, fresh.me(), 'p1', ['Knock Off']), null, 'their bench is still hidden');
  const b = battle([ours('Weavile', 79, ['Swords Dance'], 'Pressure', 'Heavy-Duty Boots', 'Dark')], 'Conkeldurr');
  b.feed('|switch|p2a: Gengar|Gengar, L80|100/100');
  b.feed('|switch|p2a: Foe|Conkeldurr, L82|100/100');
  assert.equal(switchPunish(b.state, b.me(), 'p1', ['Swords Dance']), null, 'a status move catches nothing');
});

test('a repeated Protect that gains no ground is skipped, but the first is not', () => {
  // No Leftovers on either side, so a successful Protect moves no HP at all: the real battle's swing was 0.
  const b = battle([ours('Garganacl', 80, ['Protect', 'Salt Cure'], 'Purifying Salt', '', 'Fairy')], 'Keldeo');
  const actions: BattleAction[] = [
    { id: 'move-1', kind: 'move', command: 'move 1', label: 'Protect', uncertain: false },
    { id: 'move-2', kind: 'move', command: 'move 2', label: 'Salt Cure', uncertain: false },
  ];
  const request = { rqid: 1, active: [{ moves: [{ move: 'Protect', id: 'protect' }, { move: 'Salt Cure', id: 'saltcure' }] }] } as never;
  const guard = (legalActions = actions) => futileProtect({ state: b.state, legalActions, request });
  const me = b.me();
  me.consecutiveProtects = 0;
  assert.equal(guard().size, 0, 'first Protect can scout');
  me.consecutiveProtects = 1;
  assert.equal(guard().size, 1, 'second empty Protect is skipped');
  me.consecutiveProtects = 3;
  const blocked = guard();
  assert.equal(blocked.size, 1);
  assert.match(blocked.get('move-1')!.reason, /protected 3 turns in a row, so this succeeds about 4% of the time/);
  assert.equal(guard([actions[0]!]).size, 0, 'never leave the turn with nothing to choose');
});

test('Protect is left alone while end-of-turn damage is working for us, until its odds make it a wasted turn', () => {
  // Leftovers on our side against a known non-healing item: stalling behind Protect really does gain HP.
  // The opponent's item is pinned deliberately — left unknown, its possible Leftovers cancels ours and the
  // swing is zero, which is a case the guard is then right to fire on.
  const b = battle([ours('Garganacl', 80, ['Protect', 'Salt Cure'], 'Purifying Salt', 'Leftovers', 'Fairy')], 'Keldeo');
  b.foe().item = 'Choice Scarf';
  const actions: BattleAction[] = [
    { id: 'move-1', kind: 'move', command: 'move 1', label: 'Protect', uncertain: false },
    { id: 'move-2', kind: 'move', command: 'move 2', label: 'Salt Cure', uncertain: false },
  ];
  const request = { rqid: 1, active: [{ moves: [{ move: 'Protect', id: 'protect' }, { move: 'Salt Cure', id: 'saltcure' }] }] } as never;
  b.me().consecutiveProtects = 1;
  assert.equal(futileProtect({ state: b.state, legalActions: actions, request }).size, 0, 'a second Protect at one in three can still pay');
  // Gaining ground only when it works is worth little once it works one time in nine or less.
  b.me().consecutiveProtects = 2;
  assert.equal(futileProtect({ state: b.state, legalActions: actions, request }).size, 1);
});

test('current-HP moves are damage, not the calculator\'s zero', () => {
  const b = battle([ours('Regirock', 84, ['Body Press'], 'Clear Body', 'Leftovers', 'Fighting')], 'Luvdisc');
  const foe = b.foe(); foe.hpPercent = 2;
  const set = dedupeCandidates(inferOpponent(foe).candidates)[0]!;
  // The real battle: a 2% Luvdisc took a full-health Regirock from 268 to 19 with Endeavor.
  const endeavor = scenario(b.state, foe, b.me(), 'p2', 'Endeavor', set)!;
  assert.ok(endeavor.min > endeavor.defenderMaxHP * 0.9, `Endeavor from 2% is near-lethal, got ${endeavor.min}`);
  const fang = scenario(b.state, foe, b.me(), 'p2', 'Super Fang', set)!;
  assert.equal(fang.min, Math.floor(endeavor.defenderMaxHP / 2), 'Super Fang halves current HP');
  // Both are Normal, so a Ghost takes nothing from either.
  const g = battle([ours('Gengar', 82, ['Shadow Ball'], 'Cursed Body', 'Life Orb', 'Ghost')], 'Luvdisc');
  const gf = g.foe(); gf.hpPercent = 2;
  const gset = dedupeCandidates(inferOpponent(gf).candidates)[0]!;
  for (const move of ['Endeavor', 'Super Fang']) {
    assert.equal(scenario(g.state, gf, g.me(), 'p2', move, gset)!.max, 0, `${move} cannot touch a Ghost`);
  }
});

test('Grassy Glide gets its priority from the terrain rather than being treated as unknown', () => {
  const b = battle([ours('Rillaboom', 78, ['Grassy Glide'], 'Grassy Surge', 'Choice Band', 'Grass')], 'Keldeo');
  assert.equal(movePriority(b.state, b.me(), 'Grassy Glide'), 0, 'no terrain, no boost');
  b.feed('|-fieldstart|move: Grassy Terrain');
  assert.equal(movePriority(b.state, b.me(), 'Grassy Glide'), 1);
  // The boost needs the user on the ground.
  b.me().volatiles['Magnet Rise'] = { sinceTurn: 1, data: null };
  assert.equal(movePriority(b.state, b.me(), 'Grassy Glide'), 0);
});

test('Psychic Terrain refuses a priority move aimed at a grounded target', () => {
  const b = battle([ours('Banette', 93, ['Shadow Sneak', 'Poltergeist'], 'Insomnia', 'Life Orb', 'Ghost')], 'Keldeo');
  const before = effectViability(b.state, 'Shadow Sneak', b.me(), 'p1', b.foe());
  assert.ok(!JSON.stringify(before ?? {}).includes('Psychic Terrain'));
  b.feed('|-fieldstart|move: Psychic Terrain');
  assert.match(JSON.stringify(effectViability(b.state, 'Shadow Sneak', b.me(), 'p1', b.foe())!.certain), /Psychic Terrain blocks/);
  // A move with no priority is untouched by it.
  assert.ok(!JSON.stringify(effectViability(b.state, 'Poltergeist', b.me(), 'p1', b.foe()) ?? {}).includes('Psychic Terrain'));
});
