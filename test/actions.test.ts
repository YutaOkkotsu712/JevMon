import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChoiceRequest, generateLegalActions, validateAction, type ChoiceRequest } from '../src/battle/LegalActionGenerator.js';
export function request(): ChoiceRequest {
  return { rqid: 1, side: { id: 'p1', name: 'Bot', pokemon: [
    { ident: 'p1: Same', details: 'Pikachu', active: true, condition: '50/100' },
    { ident: 'p1: Same', details: 'Pikachu', active: false, condition: '50/100' },
    { ident: 'p1: Fainted', details: 'Charizard', active: false, condition: '0 fnt' },
  ] }, active: [{ moves: [
    { move: 'Thunderbolt', id: 'thunderbolt', pp: 10 }, { move: 'Surf', id: 'surf', pp: 0 },
    { move: 'Protect', id: 'protect', pp: 5, disabled: true },
  ], canTerastallize: 'Flying' }] };
}
const ids = (r: ChoiceRequest) => generateLegalActions(r).map(a => a.id);
test('request-derived moves, Tera, PP, disabled slots and duplicate switch slots', () => {
  const r = parseChoiceRequest(JSON.stringify(request()))!;
  assert.deepEqual(ids(r), ['switch-2', 'move-1', 'move-1-terastallize']);
  assert.equal(validateAction(r, 'move-2'), undefined);
  assert.equal(validateAction(r, '|/forfeit'), undefined);
});
test('known trap blocks switches; possible trap remains uncertain', () => {
  const r = request(); r.active![0]!.trapped = true;
  assert.ok(!ids(r).includes('switch-2'));
  r.active![0]!.trapped = false; r.active![0]!.maybeTrapped = true;
  assert.equal(generateLegalActions(r)[0]!.uncertain, true);
});
test('forced switches and Revival Blessing use different eligible targets', () => {
  const r = request(); delete r.active; r.forceSwitch = [true];
  r.side.pokemon[0]!.condition = '0 fnt';
  assert.deepEqual(ids(r), ['switch-2']);
  r.side.pokemon[0]!.condition = '50/100'; r.side.pokemon[0]!.reviving = true;
  assert.deepEqual(ids(r), ['switch-3']);
  assert.equal(generateLegalActions(r)[0]!.kind, 'revive');
});
test('Struggle and recharge without PP are not discarded', () => {
  const r = request(); r.active = [{ trapped: true, moves: [{ move: 'Struggle', id: 'struggle' }] }];
  assert.deepEqual(ids(r), ['move-1']);
  r.active[0]!.moves = [{ move: 'Recharge', id: 'recharge' }];
  assert.deepEqual(ids(r), ['move-1']);
});
test('wait/null requests require no decision; preview permutations are unique and complete', () => {
  assert.equal(parseChoiceRequest('null'), null); assert.equal(parseChoiceRequest('{"wait":true}'), null);
  const r = request(); delete r.active; r.teamPreview = true; r.maxChosenTeamSize = 2;
  assert.equal(new Set(ids(r)).size, 6);
  assert.ok(ids(r).includes('team-21'));
});
test('malformed and unsupported requests fail closed', () => {
  const r = request();
  for (const raw of ['oops', '{}', JSON.stringify({ ...r, rqid: -1 }), JSON.stringify({ ...r, active: [r.active![0], r.active![0]] }),
    JSON.stringify({ ...r, forceSwitch: [true] }), JSON.stringify({ ...r, side: { ...r.side, pokemon: [{}] } })]) {
    assert.throws(() => parseChoiceRequest(raw));
  }
});
