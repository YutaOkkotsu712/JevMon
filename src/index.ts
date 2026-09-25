import { JevDecisionProvider } from './decisions/JevDecisionProvider.js';
import { ChallengeGate } from './showdown/ChallengeGate.js';
import { LadderQueue } from './showdown/LadderQueue.js';
import { routeBattleInit } from './showdown/battleRouting.js';
import { acquireInstanceLock, LOCK_FILE, releaseInstanceLock } from './logging/instanceLock.js';
import { BattleManager, isBattleRoom } from './battle/BattleManager.js';
import type { DecisionRecord } from './battle/DecisionLoop.js';
import type { BattleState } from './battle/BattleState.js';
import { BattleLogger } from './logging/BattleLogger.js';
import { BATTLE_COUNT_FILE, LADDER_COUNT_FILE, readBattlesPlayed, recordBattlesPlayed } from './logging/battleCount.js';
import { readConfig } from './config/env.js';
import { ShowdownClient } from './showdown/client.js';
import { ShowdownAuth } from './showdown/auth.js';
import { LiveServer } from './ui/LiveServer.js';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { searchOptions, searchTimeoutMs, searchWorlds } from './search/search.js';

/** Room lines the live view never receives: our private request, and chat, joins and page HTML from others. */
const privateOrChat = new Set(['request', 'c', 'c:', 'chat', 'j', 'J', 'join', 'l', 'L', 'leave', 'n', 'N', 'name', 'html', 'uhtml', 'uhtmlchange', 'pm']);

function main(): void {
  const config = readConfig();
  const smoke = process.argv.includes('--smoke');
  const entryEnabledEarly = !process.argv.includes('--smoke') && !process.argv.includes('--login-smoke');
  const loginSmoke = process.argv.includes('--login-smoke');
  if (loginSmoke && !config.credentials) throw new Error('Login smoke requires credentials');
  const live = config.liveViewPort > 0 && entryEnabledEarly ? new LiveServer({ port: config.liveViewPort, host: config.liveViewHost,
    logDirectory: 'logs', onStatus: status => log(status), ...(config.credentials ? { username: config.credentials.username } : {}) }) : undefined;
  const log = (event: string) => { console.log(JSON.stringify({ time: new Date().toISOString(), event })); live?.note(event); };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let battle: BattleManager | undefined;
  // Counted when a battle starts, not when it ends, and kept on disk: the calls are spent from the first turn, and
  // a restart must not reset the allowance. A count that exists but cannot be read stops challenges rather than
  // risk spending past the limit.
  const counted = readBattlesPlayed('logs');
  let played = counted ?? config.maxBattles;
  const limitReached = () => config.maxBattles > 0 && (counted === null || played >= config.maxBattles);
  // The ladder run is counted on its own, and by battles finished: one abandoned, never joined or cut off by a restart
  // does not use up the run. A restart carries on with the same run rather than starting a new one.
  const ladderCounted = config.ladderBattles > 0 ? readBattlesPlayed('logs', LADDER_COUNT_FILE) : 0;
  let laddered = ladderCounted ?? config.ladderBattles;
  let ladderTimer: ReturnType<typeof setTimeout> | undefined;
  // The server can keep listing a game for a moment after it ends; a finished room is never rejoined.
  const finishedRooms = new Set<string>();
  let currentRoom = config.battleRoom;
  // Lookahead needs the engine built (`npm run build:engine`); without it the bot plays exactly as before, and says so.
  const engineReady = config.search.mode !== 'off' && existsSync(config.search.bin);
  if (config.search.mode !== 'off' && !engineReady) log(`search is ${config.search.mode} but ${config.search.bin} is missing; run npm run build:engine. Playing without search`);
  const lanes = Math.max(1, availableParallelism() - 1);
  const search = engineReady ? { mode: config.search.mode as 'advise' | 'blend',
    run: (state: BattleState, actions: Parameters<typeof searchWorlds>[1]) => searchWorlds(state, actions, searchOptions(config.search, lanes)),
    timeoutMs: searchTimeoutMs(config.search, lanes), weight: config.search.weight,
    overrideMargin: config.search.overrideMargin, inPayload: config.search.inPayload, skipProviderAtShare: config.search.skipProviderAtShare } : undefined;
  if (search) log(`search: ${config.search.mode}, ${config.search.worlds} worlds of ${config.search.msPerWorld}ms on ${lanes} lanes` +
    (config.search.extraWorlds ? `, ${config.search.extraWorlds} more when the top two are within ${config.search.closeRatio}` : '') +
    (config.search.endgamePokemon ? `, endgames of ${config.search.endgamePokemon} or fewer solved (${config.search.endgameWorlds} worlds of ${config.search.endgameMsPerWorld}ms)` : '') +
    `, ${config.search.inPayload ? 'shown to' : 'kept from'} Jev`);
  const entryEnabled = !smoke && !loginSmoke;
  if (entryEnabled) {
    const lock = acquireInstanceLock('logs');
    if (!lock.ok) {
      log(`another bot (pid ${lock.holder}) is already running from this folder; stop it first, or delete logs/${LOCK_FILE} if that process is not this bot`);
      process.exitCode = 1; live?.stop(); return;
    }
  }
  const battleLogs = new Map<string, BattleLogger>();
  function createBattle(room: string, source?: string): BattleManager {
    const logger = new BattleLogger('logs', room, () => log('battle logging failed; check disk space and permissions'));
    if (source) logger.status(source);
    // The finished battle's logger stays long enough for the rating line that follows the result; older ones go.
    for (const old of [...battleLogs.keys()].slice(0, -1)) battleLogs.delete(old);
    battleLogs.set(room, logger);
    const fromLadder = !!source?.startsWith('source: ladder');
    const provider = config.battleMode === 'jev' && (!config.dryRun || config.jev.callsInDryRun)
      ? new JevDecisionProvider({ ...config.jev, onEvent: event => { logger.provider(event); log(event.status); } }) : undefined;
    if (config.battleMode === 'jev' && !provider) log('Jev calls disabled in dry-run; using local random decisions');
    return new BattleManager({
      room, ...(config.credentials ? { username: config.credentials.username } : {}),
      send: command => client.send(command), onStatus: status => { log(status); logger.status(status); },
      onSnapshot: (event, state) => {
        logger.snapshot(event, state);
        live?.snapshot(event, state, room);
        // The snapshot named `win` follows any result line, a loss included, so the log calls it the end.
        log(`battle ${event === 'win' ? 'ended' : event}: turn ${state.turn}, known team sizes ${state.sides.p1.team.length}/${state.sides.p2.team.length}`);
      },
      onFinished: outcome => {
        log(`battle finished (${outcome}); leaving ${room}`);
        finishedRooms.add(room);
        // Leaving waits a few seconds: the ladder's rating change arrives just after the result, and only in the room.
        if (ladder && fromLadder) {
          laddered++;
          if (!recordBattlesPlayed('logs', laddered, LADDER_COUNT_FILE)) log(`could not record the ladder count in logs/${LADDER_COUNT_FILE}; the run will restart on restart`);
          log(`ladder battle ${laddered}${config.ladderBattles ? ` of ${config.ladderBattles}` : ''} finished`);
        }
        setTimeout(() => client.send(`|/leave ${room}`), 4000).unref();
        battle = undefined;
        // A reconnect must not rejoin a battle that is already over; a configured room is kept on purpose.
        if (!config.battleRoom) currentRoom = '';
        // Staying up means being challengeable again straight away, by whoever is configured; a pure ladder run only once it is over.
        if (challenges && !limitReached() && (config.playMode !== 'ladder' || ladderDone())) {
          challenges.rearm();
          log(`ready for the next challenge (${played} played${config.maxBattles ? ` of ${config.maxBattles}` : ''})`);
        } else if (challenges && limitReached()) logLimit();
        if (ladder) { clearTimeout(ladderTimer); ladderTimer = setTimeout(nextLadder, 5000); }
      },
      ...(config.battleMode !== 'observe' ? { play: {
        dryRun: config.dryRun,
        ...(provider ? { provider, timeoutMs: config.jev.timeoutMs + 250 } : {}),
        ...(search ? { search } : {}),
        onDecision: (decision: DecisionRecord, state: BattleState) => {
          logger.snapshot('decision', state, decision);
          live?.decision(decision, state, room);
          log(`${decision.dryRun ? 'dry-run choice' : decision.executedAction ? 'choice sent' : 'choice not sent'}: ${decision.selectedAction.command}, rqid ${decision.rqid}`);
        },
      } } : {}),
    });
  }
  // One game at a time from the ladder. Challenges wait for the run to end in `ladder` mode, and for the current ladder
  // game or search in `both`, so two battles never overlap and no ladder game is left for a challenge.
  const laddering = config.playMode === 'ladder' || config.playMode === 'both';
  const ladder = laddering && entryEnabled ? new LadderQueue({
    dryRun: config.dryRun, send: command => client.send(command), onStatus: log,
    onGameInProgress: room => {
      if (battle || finishedRooms.has(room)) return;
      // Leaving first makes the join replay the whole battle even if this connection never left the room.
      client.send(`|/leave ${room}`);
      currentRoom = room; battle = createBattle(room, 'source: ladder, rejoined in progress'); battle.ready();
      log(`rejoining ${room}, which the server says is still in progress`);
    },
    onEnded: () => { clearTimeout(ladderTimer); ladderTimer = setTimeout(nextLadder, 5000); },
  }) : undefined;
  if (ladder && config.opponent) log(config.playMode === 'both'
    ? 'play mode both: laddering, and taking challenges between ladder games'
    : 'play mode ladder: challenges are accepted only once the ladder run is complete');
  const ladderDone = () => ladderCounted !== null && config.ladderBattles > 0 && laddered >= config.ladderBattles;
  let handedOver = false;
  // In `both`, a challenge that arrives mid-search waits for the search to be withdrawn: accepting while the server may
  // still be matching us could start a ladder game and the challenge at once.
  let cancelling = false;
  let cancelTimer: ReturnType<typeof setTimeout> | undefined;
  function takeChallenge(): boolean {
    if (config.playMode !== 'both' || !challenges?.pending || battle || limitReached()) return false;
    if (ladder?.awaitingBattle) {
      if (!cancelling) {
        cancelling = true; ladder.cancel();
        log('withdrawing the ladder search to take a challenge');
        cancelTimer = setTimeout(() => searchWithdrawn([]), 3000);
      }
      return true;
    }
    return challenges.acceptPending();
  }
  /** The server has confirmed the search is gone; `games` lists any battle it had already matched us into. */
  function searchWithdrawn(games: string[]) {
    if (!cancelling) return;
    cancelling = false; clearTimeout(cancelTimer);
    // A match made before the withdrawal arrived is a ladder game: play it, and take the challenge after.
    if (battle || games.some(room => !finishedRooms.has(room))) return;
    if (!challenges?.acceptPending()) { clearTimeout(ladderTimer); ladderTimer = setTimeout(nextLadder, 1000); }
  }
  function nextLadder() {
    if (!ladder || battle || challenges?.awaitingBattle || cancelling) return;
    if (takeChallenge()) return;
    // With challenges configured, the battle that just ended has already said so.
    if (limitReached()) { if (!challenges) logLimit(); return; }
    if (ladderCounted === null) { log(`ladder count in logs/${LADDER_COUNT_FILE} is unreadable; not searching until it is fixed or deleted`); return; }
    if (ladderDone()) {
      if (handedOver) return;
      handedOver = true;
      log(`ladder run complete (${laddered} of ${config.ladderBattles}); not searching again. Delete logs/${LADDER_COUNT_FILE} to start another run`);
      if (config.playMode === 'both') { takeChallenge(); return; }
      // With the run over, the bot is back to taking challenges from whoever ACCEPT_CHALLENGES_FROM names.
      if (challenges) { challenges.authenticate(); challenges.rearm(); log('now accepting challenges'); }
      return;
    }
    ladder.search();
  }
  const challenges = config.opponent && entryEnabled && config.playMode ? new ChallengeGate({
    username: config.credentials!.username, opponent: config.opponent, dryRun: config.dryRun, send: command => client.send(command), onStatus: log,
    // In `both`, a challenge is held and taken when the bot is free, never in the middle of a ladder game.
    hold: config.playMode === 'both',
    onPending: () => { if (!battle) takeChallenge(); },
    onGaveUp: () => { clearTimeout(ladderTimer); ladderTimer = setTimeout(nextLadder, 1000); },
  }) : undefined;
  const logLimit = () => log(counted === null
    ? `battle count in logs/${BATTLE_COUNT_FILE} is unreadable; no challenges will be accepted until it is fixed or deleted`
    : `battle limit reached (${played} of ${config.maxBattles}); no further challenges will be accepted. Delete logs/${BATTLE_COUNT_FILE} to reset`);
  function ready() {
    if (!entryEnabled) return;
    if (challenges && limitReached()) logLimit();
    else if (config.playMode !== 'ladder' || ladderDone()) challenges?.authenticate();
    ladder?.authenticate();
    if (currentRoom) { battle ??= createBattle(currentRoom); battle.ready(); }
    else nextLadder();
  }
  const auth = !smoke && config.credentials ? new ShowdownAuth({
    credentials: config.credentials,
    send: (command) => client.send(command),
    onStatus: log,
    onAuthenticated: () => {
      if (loginSmoke) { log('login smoke passed: server confirmed account identity'); shutdown(); }
      else ready();
    },
    onFailure: () => { process.exitCode = 1; shutdown(); },
  }) : undefined;
  const client = new ShowdownClient({
    url: config.url,
    onStatus: log,
    onDisconnect: () => { auth?.reset(); battle?.disconnect(); challenges?.disconnect(); ladder?.disconnect(); clearTimeout(ladderTimer); },
    onMessage(message) {
      if (config.debug) log(`protocol type: ${message.type.replace(/[^a-zA-Z0-9:-]/g, '').slice(0, 40)}`);
      if (smoke && message.room === null && message.type === 'challstr' && /^\d+\|.+$/.test(message.data)) {
        log('smoke passed: connected to Showdown as a guest');
        shutdown();
      }
      auth?.handle(message);
      if (!auth && !smoke && !loginSmoke && message.room === null && message.type === 'challstr' && /^\d+\|.+$/.test(message.data)) ready();
      challenges?.handle(message);
      ladder?.handle(message);
      if (cancelling && message.room === null && message.type === 'updatesearch') {
        try {
          const data = JSON.parse(message.data) as { searching?: unknown; games?: Record<string, unknown> | null };
          if (!(Array.isArray(data.searching) && data.searching.includes('gen9randombattle'))) searchWithdrawn(Object.keys(data.games ?? {}).filter(isBattleRoom));
        } catch { /* a malformed update is reported by the queue */ }
      }
      // A ladder game that cannot be joined, such as one that ended while we were away, must not hold the queue.
      if (ladder && battle && message.room === currentRoom && (message.type === 'noinit' || message.type === 'deinit')) {
        battle.handle(message);
        finishedRooms.add(currentRoom); battle = undefined; currentRoom = '';
        clearTimeout(ladderTimer); ladderTimer = setTimeout(nextLadder, 5000);
        return;
      }
      const route = message.type === 'init' && message.data === 'battle' && message.room && isBattleRoom(message.room)
        ? routeBattleInit(message.room, { current: battle ? currentRoom || null : null, finished: finishedRooms,
          challengeAwaiting: !!challenges?.awaitingBattle, laddering: !!ladder, ladderAwaiting: !!ladder?.awaitingBattle })
        : null;
      if (route?.kind === 'renamed') {
        battle!.disconnect();
        finishedRooms.add(route.from);
        currentRoom = message.room!;
        battle = createBattle(currentRoom, `source: ${ladder ? 'ladder' : 'challenge'}, renamed from ${route.from}`);
        log(`battle ${route.from} was renamed to ${currentRoom}; following it`);
      } else if (route?.kind === 'adopt') {
        const fromLadder = !!ladder?.awaitingBattle, fromChallenge = !!challenges?.awaitingBattle;
        currentRoom = message.room!;
        battle = createBattle(currentRoom, fromLadder ? 'source: ladder' : fromChallenge ? 'source: challenge' : 'source: ladder, joined without a pending search');
        challenges?.started();
        ladder?.started();
        if (route.sought) {
          played++;
          if (!recordBattlesPlayed('logs', played)) log(`could not record the battle count in logs/${BATTLE_COUNT_FILE}; the limit will reset on restart`);
          if (fromLadder) log(`ladder battle ${laddered + 1}${config.ladderBattles ? ` of ${config.ladderBattles}` : ''} started`);
        } else log(`playing ${currentRoom}, a battle the server opened for us without a pending search`);
      }
      battle?.handle(message);
      if (message.room && !privateOrChat.has(message.type)) battleLogs.get(message.room)?.line(message);
      // The live view narrates the battle from its public lines: never the private request, never the room's chat.
      if (live && message.room && isBattleRoom(message.room) && (message.room === currentRoom || finishedRooms.has(message.room)) &&
        !privateOrChat.has(message.type)) live.protocol(message);
    },
  });
  function shutdown() {
    clearTimeout(timeout);
    clearTimeout(ladderTimer); clearTimeout(cancelTimer);
    ladder?.cancel();
    if (entryEnabled) releaseInstanceLock('logs');
    live?.stop();
    client.stop();
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
  }
  live?.start();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (smoke || loginSmoke) timeout = setTimeout(() => {
    log('smoke failed: connection or login did not complete within 30 seconds');
    process.exitCode = 1;
    shutdown();
  }, 30_000);
  log(`${auth ? 'account' : 'guest'} connection mode; planned format: ${config.format}`);
  client.start();
}

try {
  main();
} catch {
  console.error('Startup failed. Check SHOWDOWN_URL, DEBUG, battle settings and both Showdown credentials in .env.');
  process.exitCode = 1;
}
