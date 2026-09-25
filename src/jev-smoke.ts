import { Pokemon } from '@smogon/calc';
import { extractFeatures } from './strategy/features.js';
import { loadEnvFile } from 'node:process';
import { JevDecisionProvider } from './decisions/JevDecisionProvider.js';
import { BattleTracker } from './battle/BattleTracker.js';
import { generateLegalActions, parseChoiceRequest } from './battle/LegalActionGenerator.js';

async function main() {
  try { loadEnvFile('.env'); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey?.trim()) { console.error('Set TYPESAFE_API_KEY in .env before running the Jev smoke test.'); process.exitCode = 1; return; }
  const room = 'battle-gen9randombattle-smoke';
  const tracker = new BattleTracker(room, 'Bot');
  for (const [type, data] of [
    ['player', 'p1|Bot'], ['player', 'p2|Opponent'], ['teamsize', 'p1|1'], ['teamsize', 'p2|1'],
    ['switch', 'p1a: Charizard|Charizard, L85|100/100'], ['switch', 'p2a: Venusaur|Venusaur, L84|100/100'], ['turn', '1'],
  ]) tracker.handle({ room, type: type!, data: data! });
  const own = new Pokemon(9, 'Charizard', { level: 85, evs: { hp: 85, atk: 85, def: 85, spa: 85, spd: 85, spe: 85 } });
  const raw = JSON.stringify({ rqid: 1, side: { id: 'p1', name: 'Bot', pokemon: [
    { ident: 'p1: Charizard', details: 'Charizard, L85', active: true, condition: `${own.maxHP()}/${own.maxHP()}`, stats: own.rawStats, baseAbility: 'Blaze', ability: 'Blaze', item: '' },
  ] }, active: [{ moves: [{ move: 'Flamethrower', id: 'flamethrower', pp: 10 }, { move: 'Dragon Pulse', id: 'dragonpulse', pp: 10 }] }] });
  tracker.handle({ room, type: 'request', data: raw });
  const request = parseChoiceRequest(raw)!;
  const provider = new JevDecisionProvider({ apiKey, maxCalls: 1, timeoutMs: 5000, model: process.env.JEV_MODEL || 'jev-latest' });
  const input = { state: tracker.state, request, legalActions: generateLegalActions(request) };
  const features = extractFeatures(input);
  if (!features.actions.some(a => 'damageRange' in a && a.damageRange)) throw new Error('Damage features missing');
  if (features.speedRelation?.relation !== 'faster-than-all-samples' && features.speedRelation?.relation !== 'slower-than-all-samples' &&
      features.speedRelation?.relation !== 'overlapping-or-speed-tie') throw new Error('Turn order features missing');
  if (!features.incomingThreatIfWeStayIn?.damagingMoves.length) throw new Error('Incoming damage features missing');
  if (!features.actions.some(a => 'turnOrder' in a && a.turnOrder)) throw new Error('Per-move turn order missing');
  const decision = await provider.chooseAction(input);
  if (decision.provider !== 'jev') {
    console.error(`Jev smoke failed: ${decision.fallbackReason ?? 'no API decision'}`); process.exitCode = 1; return;
  }
  console.log(JSON.stringify({ event: 'jev smoke passed', damageFeaturesIncluded: true,
    turnOrderIncluded: true, incomingDamageIncluded: true, decision, metrics: provider.getMetrics() }, null, 2));
}
main().catch(() => { console.error('Jev smoke failed; check your local configuration and service access.'); process.exitCode = 1; });
