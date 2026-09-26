import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battle, ours } from './helpers.js';
import { buildGamePlan, compactGamePlan } from '../src/strategy/gamePlan.js';
import { opponentModel, choiceContext, recordChoice } from '../src/strategy/opponentModel.js';
import { rankTacticalChoices } from '../src/strategy/tacticalRanking.js';
import { sampleWorld } from '../src/search/engineState.js';
import { baseSpecies, fitsTeam, revealedProfile, speciesPrior } from '../src/search/teamPrior.js';
import { parseChoiceRequest, generateLegalActions } from '../src/battle/LegalActionGenerator.js';
import { JevDecisionProvider, buildJevPayload, JEV_MAX_REQUEST_BYTES } from '../src/decisions/JevDecisionProvider.js';
import { DecisionLoop, type DecisionRecord } from '../src/battle/DecisionLoop.js';

function fixture() {
  return battle([
    ours('Rotom-Wash', 83, ['Thunderbolt', 'Hydro Pump', 'Will-O-Wisp', 'Pain Split'], 'Levitate', 'Leftovers', 'Steel'),
    ours('Rillaboom', 80, ['Grassy Glide', 'Wood Hammer', 'Knock Off', 'High Horsepower'], 'Grassy Surge', 'Choice Band', 'Grass'),
  ], 'Gyarados', 78);
}
function input(b: ReturnType<typeof battle>, tera = true) {
  const raw = b.payload(20, b.me().exactHP!.current);
  if (tera) Object.assign(raw.active[0]!, { canTerastallize: b.me().teraType });
  const request = parseChoiceRequest(JSON.stringify(raw))!;
  return { state: b.state, request, legalActions: generateLegalActions(request) };
}
const hp = (p: ReturnType<ReturnType<typeof battle>['me']>, percent: number) => {
  p.hpPercent = percent; if (p.exactHP) p.exactHP.current = Math.round(p.exactHP.max * percent / 100);
};

test('a former candidate loses its role when a revealed immunity replaces its favourable matchup', () => {
  const b = fixture(); hp(b.foe(), 10);
  const before = buildGamePlan(input(b))!;
  assert.ok(before.leadingCandidates.includes(b.me().id));
  b.feed('|faint|p2a: Foe\n|switch|p2a: Gastro|Gastrodon, L88|100/100\n|-ability|p2a: Gastro|Storm Drain');
  const after = buildGamePlan(input(b))!;
  assert.equal(after.turn, before.turn, 'same-turn reveals must invalidate the old plan too');
  assert.notEqual(before.revision, after.revision);
  const former = after.roles.find(r => r.pokemon === b.me().id)!;
  assert.equal(former.contribution, 0);
  assert.deepEqual(former.uniqueAnswers, []);
  assert.ok(!after.leadingCandidates.includes(former.pokemon));
  assert.ok(after.roles.find(r => r.species === 'Rillaboom')!.contribution > former.contribution);
  assert.ok(after.roles.every(r => r.matchups.every(m => m.foe !== b.foe().id)), 'fainted threats confer no preservation value');
});

test('a move that knocks out its own user is a trade, not a race won', () => {
  const b = battle([ours('Golem', 88, ['Explosion', 'Stealth Rock'], 'Sturdy', 'Custap Berry', 'Grass')], 'Abomasnow', 84);
  hp(b.foe(), 30);
  const role = buildGamePlan(input(b))!.roles.find(r => r.species === 'Golem')!;
  assert.deepEqual(role.matchups, [], 'Explosion wins no race, since Golem does not live to see the result');
  assert.deepEqual(role.uniqueAnswers, []);
});

test('HP, status, PP, hazards and Tera invalidate the current assessment without mutating battle state', () => {
  const b = fixture(), i = input(b), original = structuredClone(b.state);
  const first = buildGamePlan(i)!;
  assert.deepEqual(b.state, original);
  hp(b.me(), 5); b.me().status = 'par';
  const hurt = buildGamePlan(i)!;
  assert.notEqual(first.revision, hurt.revision);
  assert.ok(hurt.roles[0]!.contribution <= first.roles[0]!.contribution);
  b.me().movePP = { thunderbolt: { remaining: 0, max: 24 }, hydropump: { remaining: 0, max: 8 } };
  const empty = buildGamePlan(i)!;
  assert.equal(empty.roles[0]!.matchups.length, 0, 'spent attacks cannot define a win condition');
  b.me().terastallized = true;
  const spent = buildGamePlan(i)!;
  assert.equal(spent.teraAvailable, false); assert.equal(spent.preferredTera, null);
  assert.ok(spent.roles.every(r => !r.tera));
  b.me().fainted = true;
  assert.ok(buildGamePlan(i)!.roles.every(r => r.pokemon !== b.me().id));
});

test('bench Tera never protects its holder from hazards paid before it can Terastallize', () => {
  const b = battle([
    ours('Blastoise', 84, ['Surf'], 'Torrent', 'Leftovers', 'Steel'),
    ours('Charizard', 84, ['Flamethrower'], 'Blaze', 'Life Orb', 'Steel'),
  ], 'Scizor', 80);
  const charizard = b.state.sides.p1.team[1]!; hp(charizard, 40);
  b.feed('|-sidestart|p1: Test Bot|move: Stealth Rock');
  const p = buildGamePlan(input(b))!;
  const r = p.roles.find(r => r.pokemon === charizard.id)!;
  assert.equal(r.hpAfterEntry, 0); assert.equal(r.tera, undefined);
  assert.ok(!p.leadingCandidates.includes(charizard.id));
});

test('every Tera comparison follows current living threats and changed opposing typing', () => {
  const b = fixture(); const first = buildGamePlan(input(b))!;
  b.feed('|-terastallize|p2a: Foe|Flying');
  const changed = buildGamePlan(input(b))!;
  assert.notEqual(first.revision, changed.revision);
  for (const r of changed.roles) if (r.tera) {
    assert.ok(r.tera.matchups.every(m => changed.roles.some(x => x.matchups.some(y => y.foe === m.foe))));
    assert.ok(Number.isFinite(r.tera.gain));
  }
  b.feed('|faint|p2a: Foe');
  const over = buildGamePlan(input(b))!;
  assert.equal(over.preferredTera, null);
  assert.ok(over.roles.every(r => !r.tera && !r.uniqueAnswers.length));
});

test('RNG and uncertain identities do not become certain preservation orders', () => {
  const b = fixture(); hp(b.foe(), 10);
  b.me().status = 'par';
  const p = buildGamePlan(input(b))!;
  assert.ok(p.roles[0]!.matchups.every(m => m.raceCoverage[1] <= 0.75));
  assert.match(p.limitations, /not win probabilities/);
  b.state.sides.p2.identityUncertain = true;
  assert.equal(buildGamePlan(input(b)), null);
});

test('opponent observations use pre-action context and exclude forced replacements and called moves', () => {
  const b = fixture(), original = b.state.turnContext!.p2!;
  b.feed('|move|p2a: Foe|Dragon Dance|p2a: Foe\n|-boost|p2a: Foe|atk|1');
  b.feed('|move|p2a: Foe|Waterfall|p1a: Rotom-Wash|[from] move: Sleep Talk');
  assert.equal(b.state.actionHistory?.filter(o => o.side === 'p2').length, 1);
  assert.equal(b.state.actionHistory![0]!.kind, 'setup');
  assert.equal(b.state.actionHistory![0]!.boosted, original.boosted);
  b.feed('|turn|2\n|faint|p2a: Foe\n|switch|p2a: Gastro|Gastrodon, L88|100/100');
  assert.equal(b.state.actionHistory?.filter(o => o.kind === 'switch').length, 0);
  b.feed('|turn|3\n|drag|p2a: Foo|Scizor, L80|100/100');
  assert.equal(b.state.actionHistory?.filter(o => o.kind === 'switch').length, 0);
});

test('opponent habits fade and lose influence when Tera or the matchup changes', () => {
  const b = fixture();
  for (let t = 1; t < 7; t++) {
    b.state.turn = t; b.state.turnContext = { p2: choiceContext(b.state, 'p2')! };
    recordChoice(b.state, 'p2', 'setup');
  }
  b.state.turn = 7;
  const learned = opponentModel(b.state, 'p1')!;
  assert.ok(learned.probabilities.setup > 0.3);
  assert.ok(learned.probabilities.attack > 0, 'repetition never means certainty');
  b.foe().terastallized = true; b.foe().teraType = 'Flying';
  const changed = opponentModel(b.state, 'p1')!;
  assert.ok(changed.evidence < learned.evidence);
  b.state.turn = 70;
  assert.ok(opponentModel(b.state, 'p1')!.evidence < changed.evidence);
  assert.ok(Math.abs(Object.values(changed.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9);
});

test('team sampling respects species clause, reproduces a seed and retains rare possibilities', () => {
  const b = fixture();
  const rng = () => { let n = 17; return () => ((n = (Math.imul(n, 1664525) + 1013904223) >>> 0) / 2 ** 32); };
  const a = sampleWorld(b.state, 'p1', rng()), c = sampleWorld(b.state, 'p1', rng());
  assert.deepEqual(a, c);
  const names = [...b.state.sides.p2.team.map(p => p.species), ...a.unrevealed.map(p => p.pokemon.species)].map(baseSpecies);
  assert.equal(names.length, 6); assert.equal(new Set(names).size, 6);
  assert.ok(a.unrevealed.every(p => p.set.moves.length === 4));
});

test('hidden Pokémon follow the generator\'s team rules and species odds', () => {
  const team = (...names: string[]) => names.map(n => revealedProfile(n, `${n}, L85`));
  // Two of a type is the limit: no third Water type beside Gyarados and Gastrodon.
  assert.equal(fitsTeam('vaporeon', team('Gyarados', 'Gastrodon')), false);
  assert.equal(fitsTeam('vaporeon', team('Gyarados')), true);
  // The generator counts an immunity as neutral, so Skarmory is Ground-weak there: a fourth Ground weakness is refused.
  assert.equal(fitsTeam('skarmory', team('Excadrill', 'Raichu', 'Arcanine')), false);
  assert.equal(fitsTeam('gyarados', team('Excadrill', 'Raichu', 'Arcanine')), true);
  // One double weakness to a type, and never two Sticky Web setters.
  assert.equal(fitsTeam('abomasnow', team('Scizor')), false);
  assert.equal(fitsTeam('ribombee', team('Galvantula')), false);
  // One level-100 Pokémon: details leave the level out at 100, so a revealed one reads as 100.
  assert.equal(fitsTeam('delibird', [revealedProfile('Luvdisc', 'Luvdisc, F')]), false);
  assert.equal(fitsTeam('delibird', team('Arcanine')), true);
  // Every listed forme can be drawn: the crowned legends were missing from the old table and drawn 1 time in 25,000.
  for (const key of ['zaciancrowned', 'zamazentacrowned', 'stantler']) if (speciesPrior.has(key)) assert.ok(speciesPrior.get(key)! > 0.3);
  // Tauros's four formes share one base species' weight; Squawkabilly's share a weight of one.
  const tauros = [...speciesPrior].filter(([k]) => k.startsWith('tauros')).reduce((n, [, w]) => n + w, 0);
  assert.ok(Math.abs(tauros - 2) < 1e-9 || Math.abs(tauros - 1) < 1e-9);
  // Sampled teams keep every rule against everything else on the team.
  const b = fixture();
  let n = 7; const rng = () => ((n = (Math.imul(n, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < 40; i++) {
    const w = sampleWorld(b.state, 'p1', rng);
    const members = [...b.state.sides.p2.team.map(p => revealedProfile(p.species, p.details)),
      ...w.unrevealed.map(u => revealedProfile(u.pokemon.species, u.pokemon.details))];
    members.forEach((m, j) => assert.ok(fitsTeam(m.key, members.filter((_, k) => k !== j)), `${m.key} breaks a team rule`));
  }
});

test('soft advice keeps an overwhelmingly supported action and compares all fallbacks', () => {
  const b = fixture(), i = input(b, false), [a, c] = i.legalActions;
  assert.ok(a && c);
  const values = Object.fromEntries(i.legalActions.map(x => [x.id, { visitShare: x.id === a.id ? 0.98 : 0.001,
    meanScore: x.id === a.id ? 0.8 : 0.4 }]));
  const base = Object.fromEntries(i.legalActions.map(x => [x.id, x.id === a.id ? 0.98 : 0.001]));
  const result = rankTacticalChoices({ ...i, search: values }, base, a.id, null,
    [{ action: a.id, guard: 'preserveSoleDefensiveAnswer', reason: 'conditional advice', alternative: c.id }]);
  assert.equal(result.chosen, a.id);
  assert.ok(result.ranking[a.id]! > 0, 'advice cannot ban the move');
  assert.ok(Object.values(result.ranking).every(Number.isFinite));
});

test('a current defensive Tera can outweigh reserving it for a teammate', () => {
  const b = battle([ours('Blastoise', 84, ['Surf'], 'Torrent', 'Leftovers', 'Ground'),
    ours('Charizard', 84, ['Flamethrower'], 'Blaze', 'Heavy-Duty Boots', 'Fire')], 'Regieleki', 77);
  hp(b.me(), 45); b.foe().revealedMoves = ['Thunderbolt'];
  b.foe().item = 'Choice Specs'; b.foe().lastMoveUsed = 'Thunderbolt';
  const i = input(b), p = buildGamePlan(i)!;
  const plain = i.legalActions.find(a => a.id === 'move-1')!, tera = i.legalActions.find(a => a.id === 'move-1-terastallize')!;
  const base = Object.fromEntries(i.legalActions.map(a => [a.id, a.id === plain.id ? 0.51 : a.id === tera.id ? 0.48 : 0.01]));
  const ranked = rankTacticalChoices(i, base, plain.id, p, []);
  assert.equal(ranked.chosen, tera.id);
  assert.ok(ranked.corrections[tera.id]!.reasons.some(r => r.includes('lethal to survivable')));
  // With a search, the rescue must also be its own first choice; otherwise the plain move stays.
  const search = (top: string) => Object.fromEntries(i.legalActions.map(a => [a.id, { visitShare: a.id === top ? 0.5 : 0.1, meanScore: 0.5 }]));
  assert.equal(rankTacticalChoices({ ...i, search: search(tera.id) }, base, plain.id, p, []).chosen, tera.id);
  assert.equal(rankTacticalChoices({ ...i, search: search(plain.id) }, base, plain.id, p, []).chosen, plain.id);
});

test('tactical scoring never revives a Tera the blend held back, and keeps the blend\'s own choice in the running', () => {
  const b = fixture(), i = input(b);
  const plain = i.legalActions.find(a => a.id === 'move-1')!, tera = i.legalActions.find(a => a.id === 'move-1-terastallize')!;
  // The blend held the Tera back (zero) and chose the plain move, which the search scores 0.11 below the Tera.
  const base = Object.fromEntries(i.legalActions.map(a => [a.id, a.id === tera.id ? 0 : a.id === plain.id ? 0.2 : 0.01]));
  const values = Object.fromEntries(i.legalActions.map(a => [a.id, { visitShare: a.id === tera.id ? 0.4 : 0.1,
    meanScore: a.id === tera.id ? 0.64 : a.id === plain.id ? 0.53 : 0.3 }]));
  const ranked = rankTacticalChoices({ ...i, search: values }, base, plain.id, buildGamePlan(i), []);
  assert.equal(ranked.ranking[tera.id], 0);
  assert.ok(ranked.ranking[plain.id]! > 0);
  assert.notEqual(ranked.chosen, tera.id);
});

test('a heal is worth only what it restores below full HP, and a repeated protect mostly fails', () => {
  const b = battle([ours('Slowbro', 84, ['Slack Off', 'Scald', 'Protect'], 'Regenerator', 'Leftovers', 'Water')], 'Great Tusk', 80);
  b.foe().revealedMoves = ['Headlong Rush'];
  hp(b.me(), 95);
  const i = input(b, false), p = buildGamePlan(i)!;
  const base = Object.fromEntries(i.legalActions.map(a => [a.id, 0.3]));
  const lost = (id: string) => rankTacticalChoices(i, base, 'move-2', p, []).corrections[id]?.logAdjustment ?? 0;
  const fresh = lost('move-3');
  b.me().consecutiveProtects = 1;
  assert.ok(lost('move-3') < fresh, 'a second protect in a row is priced as the hit it mostly fails to block');
  // At 95%, Slack Off restores 5 before a hit or refills after one; either way less than the whole hit is saved.
  assert.ok(lost('move-1') <= 0);
});

test('both payload tiers retain the current plan and oversized Unicode never reaches Jev', async () => {
  const b = fixture(), i = input(b);
  const p = buildGamePlan(i)!;
  assert.deepEqual(compactGamePlan(p).leadingCandidates, p.leadingCandidates);
  const payload = buildJevPayload({ ...i, gamePlan: p })!;
  assert.ok(payload.bytes <= JEV_MAX_REQUEST_BYTES);
  assert.equal((payload.state as any).currentGamePlan.revision, p.revision);
  b.state.uncertainties = ['🧪'.repeat(15000)];
  let calls = 0;
  const provider = new JevDecisionProvider({ apiKey: 'test', maxCalls: 1, request: async () => { calls++; throw new Error('must not send'); } });
  const result = await provider.chooseAction(i);
  assert.equal(result.fallbackReason, 'jev_context_limit');
  assert.equal(calls, 0); assert.equal(provider.getMetrics().attempts, 0);
});

test('the live decision path records a fresh plan even when Jev is skipped', async () => {
  const b = fixture(), i = input(b);
  const values = Object.fromEntries(i.legalActions.map(a => [a.id, { visitShare: a.id === 'move-1' ? 0.98 : 0.001, meanScore: 0.5 }]));
  let called = false;
  const record = await new Promise<DecisionRecord>(resolve => {
    const loop = new DecisionLoop({ room: b.state.battleId, username: 'Test Bot', dryRun: true, send: () => true,
      state: () => b.state, onStatus: () => {}, onDecision: resolve,
      provider: { async chooseAction() { called = true; throw new Error('must skip'); } },
      search: { mode: 'blend', timeoutMs: 1000, skipProviderAtShare: 0.7, run: async () => ({ values, worldsSearched: 1, msTotal: 1 }) } });
    loop.request(JSON.stringify(i.request));
  });
  assert.equal(called, false); assert.ok(record.gamePlan); assert.ok(record.tacticalRanking);
  assert.equal(record.gamePlan.revision, buildGamePlan(i)!.revision);
  assert.ok(i.legalActions.some(a => a.id === record.selectedAction.id));
});
