// Checks poke-engine's mechanics against the simulator, turn by turn. Self-play games are played with a small search; on
// every turn both sides attack (no switch, no pivot, nobody faints), the engine is asked what the two moves actually
// chosen can do from the true position, the opponent's real sets included, and the HP each active really lost or gained
// is looked for among its outcomes. A turn it cannot explain, beyond damage rolls, points at a mechanic the engine or our
// serialisation gets wrong, and the search plays every turn on those mechanics. Mismatches are grouped by move, ability
// and item, so a pattern shows as a pattern.
//
//   SIMULATOR_DIR=~/.cache/jevmon-sim node scripts/check-engine.mjs --games 20 [--first-seed 1] [--out logs/engine-check.jsonl]
import { appendFileSync, mkdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BattleManager } from '../dist/src/battle/BattleManager.js';
import { parseFrame } from '../dist/src/showdown/protocol.js';
import { engineName, searchOptions, searchTimeoutMs, searchWorlds } from '../dist/src/search/search.js';
import { toEngineState } from '../dist/src/search/engineState.js';
import { dex, id } from '../dist/src/pokemon/data.js';

const { values: args } = parseArgs({ options: {
  games: { type: 'string', default: '10' }, 'first-seed': { type: 'string', default: '1' },
  out: { type: 'string', default: 'logs/engine-check.jsonl' } } });
if (!process.env.SIMULATOR_DIR) throw new Error('Set SIMULATOR_DIR to a directory containing @pkmn/sim and @pkmn/randoms');
const require = createRequire(resolve(process.env.SIMULATOR_DIR, 'package.json'));
const { BattleStreams, Teams } = require('@pkmn/sim');
const { TeamGenerators } = require('@pkmn/randoms');
Teams.setGeneratorFactory(TeamGenerators);
const bin = process.env.POKE_ENGINE_BIN?.trim() || 'vendor/poke-engine/target/release/poke-engine';
const config = { bin, worlds: 4, msPerWorld: 30, extraWorlds: 0, closeRatio: 0.6, endgamePokemon: 0, endgameWorlds: 8, endgameMsPerWorld: 400 };
mkdirSync(dirname(args.out), { recursive: true });

/** The opponent's real sets, in the form a sampled world takes (as scripts/divergence.mjs builds its judge's). */
function truthWorld(state, ourSide, battle) {
  const theirs = ourSide === 'p1' ? 'p2' : 'p1';
  const base = name => id(dex.species.get(name).baseSpecies || name);
  const candidate = set => ({ ability: set.ability, item: set.item, moves: [...set.moves],
    evs: { hp: 84, atk: 84, def: 84, spa: 84, spd: 84, spe: 84, ...set.evs }, ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...set.ivs },
    teraType: set.teraType || dex.species.get(set.species).types[0], probability: 1 });
  const world = { sets: new Map(), unrevealed: [] }, used = new Set();
  for (const p of state.sides[theirs].team) {
    const sim = battle[theirs].pokemon.find(x => !used.has(x) && base(x.set.species) === base(p.species));
    if (sim) { used.add(sim); world.sets.set(p.id, candidate(sim.set)); }
  }
  for (const sim of battle[theirs].pokemon) {
    if (used.has(sim)) continue;
    const name = dex.species.get(sim.set.species).name;
    world.unrevealed.push({ set: candidate(sim.set), pokemon: { id: `unseen:${id(name)}`, slot: 0, ident: `unseen: ${name}`,
      details: `${name}, L${sim.set.level ?? 100}`, species: name, hpPercent: 100, fainted: false, status: null, boosts: {}, volatiles: {},
      knownMoves: [], revealedMoves: [], movePP: {}, moveUses: {}, ability: null, baseAbility: null, abilitySuppressed: false, item: null,
      teraType: null, terastallized: false, transformedInto: null, copiedMoves: [] } });
  }
  return world;
}

/** The engine's outcomes for one move pair: each branch's probability and the net HP change of each side's active. */
const outcomes = (state, one, two) => new Promise(resolveRun => execFile(bin, ['generate-instructions', '--state', state, '-o', one, '-t', two],
  { timeout: 20_000, maxBuffer: 8 << 20 }, (error, stdout) => {
    if (error) return resolveRun(null);
    const branches = [];
    for (const block of stdout.split(/^Index: \d+$/m).slice(1)) {
      const p = Number(/Percentage: ([\d.]+)/.exec(block)?.[1] ?? 0);
      const net = { SideOne: 0, SideTwo: 0 }, hurt = { SideOne: 0, SideTwo: 0 };
      for (const m of block.matchAll(/^\s*(Damage|Heal) (SideOne|SideTwo): (-?\d+)/gm)) {
        net[m[2]] += (m[1] === 'Damage' ? -1 : 1) * Number(m[3]);
        if (m[1] === 'Damage') hurt[m[2]] += Number(m[3]);
      }
      const switched = /Switch (SideOne|SideTwo)/.test(block);
      branches.push({ p, one: net.SideOne, two: net.SideTwo, hurtOne: hurt.SideOne, hurtTwo: hurt.SideTwo, switched });
    }
    resolveRun(branches);
  }));

const results = { turns: 0, checked: 0, explained: 0, unexplained: 0, engineErrors: 0, trackerDesyncs: 0 };
const statusOf = { '': null, slp: 'slp', brn: 'brn', par: 'par', psn: 'psn', tox: 'tox', frz: 'frz' };
/** Where the tracker's picture of both actives, as the bot searched it, differs from the simulator's. */
function desync(state, battle) {
  const out = [];
  for (const side of ['p1', 'p2']) {
    const t = state.sides[side].team.find(p => p.id === state.sides[side].activeId), a = battle[side].active[0];
    if (!t || !a) continue;
    const boosts = Object.fromEntries(Object.entries(a.boosts).filter(([, v]) => v));
    const tracked = Object.fromEntries(Object.entries(t.boosts ?? {}).filter(([, v]) => v));
    if (JSON.stringify(Object.entries(boosts).sort()) !== JSON.stringify(Object.entries(tracked).sort())) out.push({ side, what: 'boosts', tracked, real: boosts, species: a.species.name });
    if ((t.status ?? null) !== (statusOf[a.status] ?? a.status ?? null)) out.push({ side, what: 'status', tracked: t.status, real: a.status, species: a.species.name });
    const hp = Math.round(100 * a.hp / a.maxhp);
    if (t.hpPercent !== null && Math.abs(t.hpPercent - hp) > 1) out.push({ side, what: 'hp', tracked: t.hpPercent, real: hp, species: a.species.name });
  }
  return out;
}
async function play(seed) {
  const stream = new BattleStreams.BattleStream();
  const streams = BattleStreams.getPlayerStreams(stream);
  const room = `battle-gen9randombattle-check${seed}`;
  const names = { p1: 'Bot1', p2: 'Bot2' };
  const chosen = {};
  let pending = null, done = false;
  const checks = [];
  /** HP and identity of each side's active, from the simulator. */
  const actives = () => Object.fromEntries(['p1', 'p2'].map(side => {
    const a = stream.battle[side].active[0];
    return [side, a ? { species: a.species.name, hp: a.hp, maxhp: a.maxhp, fainted: a.fainted, ability: a.ability, item: a.item,
      status: a.status, tera: a.terastallized ?? null } : null];
  }));
  const settle = () => {
    if (!pending) return;
    const { before, check } = pending; pending = null;
    const after = actives();
    checks.push(check.then(async c => {
      if (!c) return;
      const { branches, info } = c;
      if (!branches) { results.engineErrors++; return; }
      // Only a turn with the same two actives before and after, and neither fainted, is compared.
      for (const side of ['p1', 'p2']) if (!after[side] || after[side].species !== before[side].species || after[side].fainted) return;
      results.checked++;
      const actual = { one: after.p1.hp - before.p1.hp, two: after.p2.hp - before.p2.hp };
      // A damage roll spans 85-100% and the engine takes the average: allow 9% of the damage in the branch either way (a
      // heal beside it cancels none of that spread), and 3% of max HP for the opponent's rounded HP.
      const fits = (pred, hurt, real, max) => Math.abs(pred - real) <= Math.max(0.09 * hurt, 0.03 * max, 2);
      const ok = branches.filter(b => !b.switched).some(b => fits(b.one, b.hurtOne, actual.one, before.p1.maxhp) && fits(b.two, b.hurtTwo, actual.two, before.p2.maxhp));
      if (ok) { results.explained++; return; }
      results.unexplained++;
      appendFileSync(args.out, JSON.stringify({ seed, ...info, actual, before, after,
        branches: branches.filter(b => !b.switched).map(b => ({ p: Math.round(b.p * 10) / 10, one: b.one, two: b.two })) }) + '\n');
    }));
  };
  const tasks = ['p1', 'p2'].map(side => {
    let rqid = 0;
    const manager = new BattleManager({ room, username: names[side],
      // Written a tick later: the simulator runs the turn inside write(), before onDecision could see the position.
      send(command) { const m = /\|\/choose (.+)\|(\d+)$/.exec(command); if (m) void Promise.resolve().then(() => streams[side].write(m[1])).catch(() => {}); return true; },
      onStatus() {}, onSnapshot(event) { if (event === 'win' || event === 'tie') done = true; },
      play: { dryRun: false, timeoutMs: 50, provider: { async chooseAction() { throw new Error('search only'); } },
        search: { mode: 'blend', weight: 1, overrideMargin: 0.03, inPayload: false, timeoutMs: searchTimeoutMs(config, 1),
          run: (state, actions) => searchWorlds(state, actions, searchOptions(config, 1)) },
        onDecision(record, state) {
          chosen[side] = { turn: state.turn, action: record.selectedAction, state, kind: state.requestKind };
          const a = chosen.p1, b = chosen.p2;
          if (!a || !b || a.turn !== b.turn || a.kind !== 'move' || b.kind !== 'move') return;
          results.turns++;
          const usable = x => x.action.kind === 'move' && !dex.moves.get(x.action.label.split(' + Tera')[0]).selfSwitch;
          if (!usable(a) || !usable(b) || a.state.sides.p2.identityUncertain || a.state.sides.p1.identityUncertain) { delete chosen.p1; delete chosen.p2; return; }
          const before = actives();
          // The side deciding sees its own and the opposing active: check what it believes against the simulator.
          const drift = desync(a.state, stream.battle);
          if (drift.length) { results.trackerDesyncs++; appendFileSync(args.out.replace(/\.jsonl$/, '.desync.jsonl'), JSON.stringify({ seed, turn: a.turn, drift }) + '\n'); }
          const one = engineName(a.action, a.state), two = engineName(b.action, b.state);
          const mine = a.state.sides.p1.team.find(p => p.id === a.state.sides.p1.activeId);
          const info = { turn: a.turn, trackedBoosts: mine?.boosts, realBoosts: stream.battle.p1.active[0]?.boosts,
            p1: { move: a.action.label, species: before.p1.species, ability: before.p1.ability, item: before.p1.item },
            p2: { move: b.action.label, species: before.p2.species, ability: before.p2.ability, item: before.p2.item } };
          let engineState;
          try { engineState = toEngineState(a.state, 'p1', truthWorld(a.state, 'p1', stream.battle)).state; } catch { delete chosen.p1; delete chosen.p2; return; }
          pending = { before, check: outcomes(engineState, one, two).then(branches => ({ branches, info })) };
          delete chosen.p1; delete chosen.p2;
        } } });
    manager.handle({ room, type: 'init', data: 'battle' });
    return (async () => {
      for await (const chunk of streams[side]) for (const message of parseFrame(`>${room}\n${chunk}`)) {
        if (message.type === 'request') { const d = JSON.parse(message.data); if (d) { d.rqid = ++rqid; message.data = JSON.stringify(d); } }
        if (message.type === 'turn' && side === 'p1') settle();
        manager.handle(message);
      }
    })();
  });
  tasks.push((async () => { for await (const _ of streams.omniscient) { /* drain */ } })());
  await streams.omniscient.write(`>start ${JSON.stringify({ formatid: 'gen9randombattle', seed: [seed, 2, 3, 4] })}\n` +
    `>player p1 ${JSON.stringify({ name: names.p1, seed: [seed, 11, 22, 33] })}\n>player p2 ${JSON.stringify({ name: names.p2, seed: [seed, 44, 55, 66] })}`);
  await Promise.race([Promise.all(tasks), new Promise(r => setTimeout(r, 10 * 60_000))]);
  pending = null;
  await Promise.all(checks);
  console.log(`seed ${seed}: ${done ? 'finished' : 'timed out'}; so far ${JSON.stringify(results)}`);
}
for (let seed = Number(args['first-seed']); seed < Number(args['first-seed']) + Number(args.games); seed++) await play(seed);
console.log(`${results.checked} turns compared, ${results.unexplained} the engine's outcomes do not explain (${(100 * results.unexplained / Math.max(1, results.checked)).toFixed(1)}%); details in ${args.out}`);
