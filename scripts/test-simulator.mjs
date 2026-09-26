// Optional integration harness: simulator packages are installed outside the project.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { JevDecisionProvider, JEV_MAX_REQUEST_BYTES } from '../dist/src/decisions/JevDecisionProvider.js';
import { BattleManager } from '../dist/src/battle/BattleManager.js';
import { parseFrame } from '../dist/src/showdown/protocol.js';
if (!process.env.SIMULATOR_DIR) throw new Error('Set SIMULATOR_DIR to a directory containing @pkmn/sim and @pkmn/randoms');
const require = createRequire(resolve(process.env.SIMULATOR_DIR, 'package.json'));
const { BattleStreams, Teams } = require('@pkmn/sim');
const { TeamGenerators } = require('@pkmn/randoms');
Teams.setGeneratorFactory(TeamGenerators);
const runs = [];
const runCount = Number(process.env.SIMULATOR_RUNS ?? '3');
assert.ok(Number.isInteger(runCount) && runCount >= 1 && runCount <= 30);
for (let run = 1; run <= runCount; run++) {
  const stream = new BattleStreams.BattleStream();
  const streams = BattleStreams.getPlayerStreams(stream);
  const room = `battle-gen9randombattle-local${run}`;
  let decisions = 0, turns = 0, rejected = 0, ended = false, forcedSwitches = 0, teraChoices = 0, mockedJevCalls = 0;
  let damageDecisions = 0, switchMatchupDecisions = 0, settledOrderDecisions = 0, threatDecisions = 0, evidenceDeductions = 0, largestPayload = 0;
  const managers = [];
  const errors = [];
  let fatal;
  const failure = new Promise((_, reject) => { fatal = reject; });
  const timeout = setTimeout(() => fatal(new Error(`Simulation ${run} timed out`)), 20000);
  const tasks = ['p1', 'p2'].map((side, playerIndex) => {
    let rqid = 0, seed = run * 123 + playerIndex;
    const manager = new BattleManager({
      room, username: `Bot${playerIndex + 1}`,
      send(command) {
        // The battle timer is asked for with the first request; the local simulator has no timer to turn on.
        if (command.endsWith('|/timer on')) return true;
        const match = /\|\/choose (.+)\|(\d+)$/.exec(command);
        assert.ok(match, 'Expected a request-tagged choice');
        assert.equal(Number(match[2]), rqid, 'Choice must belong to latest request');
        void Promise.resolve(streams[side].write(match[1])).catch(fatal);
        return true;
      },
      onStatus(status) {
        if (status.includes('rejected')) rejected++;
        if (/invalid request|no request-supported|retry limit|processing failed/.test(status)) fatal(new Error(status));
      },
      onSnapshot(event, state) {
        turns = Math.max(turns, state.turn);
        if (state.requestKind === 'switch') forcedSwitches++;
        if (event === 'win' || event === 'tie') ended = true;
        for (const side of Object.values(state.sides)) for (const p of side.team) {
          evidenceDeductions = Math.max(evidenceDeductions, p.inference?.observations.length ?? 0);
        }
      },
      play: { dryRun: false,
        provider: run === 3 ? new JevDecisionProvider({ apiKey: 'local-test-only', maxCalls: 1000,
          request: async (_url, options) => {
            mockedJevCalls++;
            const payload = JSON.parse(options.body);
            const choices = Object.keys(payload.questions.battle_action.criteria);
            assert.equal(payload.questions.battle_action.type, 'choice');
            assert.ok(payload.state.ourSide.activeIndex >= 0, 'Our active Pokemon must be identified');
            largestPayload = Math.max(largestPayload, Buffer.byteLength(options.body));
            assert.ok(largestPayload <= JEV_MAX_REQUEST_BYTES, 'Payload must stay inside the conservative hard ceiling');
            assert.equal(choices.length, payload.state.actions.length, 'Every offered action must be described');
            if (payload.state.actions.some(a => a.damageRange?.scenarios > 0)) damageDecisions++;
            if (payload.state.actions.some(a => a.switchIn?.incomingThreat || a.switchIn?.ourBestDamageFromNextTurn)) switchMatchupDecisions++;
            if (payload.state.actions.some(a => a.turnOrder && a.turnOrder.order !== 'uncertain')) settledOrderDecisions++;
            if (payload.state.incomingThreatIfWeStayIn?.damagingMoves?.length) threatDecisions++;
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
            const choice = choices[seed % choices.length];
            return Response.json({ model: 'jev-local-fixture', answers: { battle_action: {
              type: 'choice', choice, confidence: 1,
              probabilities: Object.fromEntries(choices.map(c => [c, c === choice ? 1 : 0])),
            } }, usage: { input_tokens: 100, output_tokens: 20 } });
          },
        }) : { async chooseAction(input) {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
          return { chosenAction: input.legalActions[seed % input.legalActions.length].id };
        } },
        onDecision(record) {
          decisions++;
          assert.ok(record.executedAction);
          assert.equal(record.fallback, false);
          if (record.executedAction.includes('terastallize')) teraChoices++;
        },
      },
    });
    managers.push(manager);
    manager.handle({ room, type: 'init', data: 'battle' });
    return (async () => {
      for await (const chunk of streams[side]) {
        for (const message of parseFrame(`>${room}\n${chunk}`)) {
          if (message.type === 'error') errors.push(message.data);
          if (message.type === 'request') {
            const data = JSON.parse(message.data);
            if (data) { data.rqid = ++rqid; message.data = JSON.stringify(data); }
          }
          manager.handle(message);
        }
      }
    })();
  });
  tasks.push((async () => { for await (const _chunk of streams.omniscient) { /* drain full log */ } })());
  try {
    await streams.omniscient.write(`>start ${JSON.stringify({ formatid: 'gen9randombattle', seed: [run, 2, 3, 4] })}\n>player p1 ${JSON.stringify({ name: 'Bot1', seed: [run, 11, 22, 33] })}\n>player p2 ${JSON.stringify({ name: 'Bot2', seed: [run, 44, 55, 66] })}`);
    await Promise.race([Promise.all(tasks), failure]);
    assert.ok(ended, 'Battle must end normally');
    assert.ok(errors.every(error => error.startsWith('[Unavailable choice]')), 'Only hidden-information rejections may occur');
    assert.ok(decisions > 10); assert.ok(forcedSwitches > 0);
    assert.ok(evidenceDeductions > 0, 'Public turn order and damage must produce hidden-set deductions');
    if (run === 3) {
      assert.ok(mockedJevCalls > 10);
      assert.ok(damageDecisions > 0, 'Real simulator requests must produce damage features');
      assert.ok(threatDecisions > 0, 'Staying in must be priced, not only attacking');
      assert.ok(switchMatchupDecisions > 0, 'Switch actions must carry a matchup evaluation');
      assert.ok(settledOrderDecisions > 0, 'Some turn orders must be settled rather than always uncertain');
    }
    runs.push({ run, turns, decisions, forcedSwitches, teraChoices, rejected, mockedJevCalls,
      damageDecisions, threatDecisions, switchMatchupDecisions, settledOrderDecisions, evidenceDeductions, largestPayload, errors });
  } finally {
    clearTimeout(timeout);
    for (const manager of managers) manager.disconnect();
    if (!ended) stream.destroy();
  }
}
console.log(JSON.stringify({ simulator: JSON.parse(readFileSync(resolve(process.env.SIMULATOR_DIR, 'node_modules/@pkmn/sim/package.json'), 'utf8')).version, runs }, null, 2));
