import { isBattleRoom } from '../battle/BattleManager.js';
import { ANY_CHALLENGER } from '../showdown/ChallengeGate.js';
export const INITIAL_FORMAT = 'gen9randombattle' as const;

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const url = env.SHOWDOWN_URL ?? 'wss://sim3.psim.us/showdown/websocket';
  const parsed = new URL(url);
  if (!['wss:', 'ws:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('SHOWDOWN_URL must be a WebSocket URL without credentials');
  }
  if (env.DEBUG !== undefined && !['true', 'false'].includes(env.DEBUG)) {
    throw new Error('DEBUG must be true or false');
  }
  const username = env.SHOWDOWN_USERNAME ?? '';
  const password = env.SHOWDOWN_PASSWORD ?? '';
  if (Boolean(username) !== Boolean(password)) throw new Error('Set both Showdown credentials');
  if (username && (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,17}$/.test(username) || !/[A-Za-z]/.test(username))) {
    throw new Error('Invalid Showdown username');
  }
  if (username && parsed.protocol !== 'wss:') throw new Error('Account login requires wss');
  let battleRoom = env.SHOWDOWN_BATTLE_ROOM?.trim() || undefined;
  if (battleRoom?.startsWith('https://')) {
    const roomUrl = new URL(battleRoom);
    if (roomUrl.hostname !== 'play.pokemonshowdown.com' || roomUrl.username || roomUrl.password || roomUrl.port) throw new Error('Invalid battle URL');
    battleRoom = roomUrl.pathname.replace(/^\//, '').replace(/\/$/, '');
  }
  if (battleRoom && !isBattleRoom(battleRoom)) throw new Error('Invalid battle room');
  const battleMode = env.BATTLE_MODE ?? 'observe';
  if (!['observe', 'random', 'jev'].includes(battleMode)) throw new Error('Invalid BATTLE_MODE');
  if (env.DRY_RUN !== undefined && !['true', 'false'].includes(env.DRY_RUN)) throw new Error('Invalid DRY_RUN');
  const dryRun = env.DRY_RUN !== 'false';
  // A bare `*` opens the gate to whoever challenges first; anything else names one account.
  const wildcard = env.ACCEPT_CHALLENGES_FROM?.trim() === ANY_CHALLENGER;
  const opponent = wildcard ? ANY_CHALLENGER : (env.ACCEPT_CHALLENGES_FROM?.toLowerCase().replace(/[^a-z0-9]/g, '') || undefined);
  if (env.ACCEPT_CHALLENGES_FROM && (!opponent || /[\r\n|,]/.test(env.ACCEPT_CHALLENGES_FROM))) throw new Error('Invalid opponent');
  if (battleMode !== 'observe' && !username) throw new Error('Decision modes require credentials');
  if (opponent && (battleMode === 'observe' || battleRoom)) throw new Error('Challenge mode requires a decision mode and no configured room');
  if (opponent && opponent !== ANY_CHALLENGER && opponent === username.toLowerCase().replace(/[^a-z0-9]/g, '')) throw new Error('Cannot accept own challenge');
  const maxCalls = Number(env.JEV_MAX_CALLS_PER_BATTLE ?? '60');
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 0 || maxCalls > 1000) throw new Error('Invalid Jev call limit');
  // The tail matters more than the median here: a full payload has run to ~3s while the median sits near 0.5s.
  const timeoutMs = Number(env.JEV_TIMEOUT_MS ?? '6000');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10000) throw new Error('Invalid Jev timeout');
  const model = env.JEV_MODEL || 'jev-latest';
  if (!/^jev-[a-zA-Z0-9.\-]+$/.test(model)) throw new Error('Invalid Jev model');
  if (env.JEV_CALLS_IN_DRY_RUN !== undefined && !['true', 'false'].includes(env.JEV_CALLS_IN_DRY_RUN)) throw new Error('Invalid Jev dry-run setting');
  const callsInDryRun = env.JEV_CALLS_IN_DRY_RUN === 'true';
  const apiKey = env.TYPESAFE_API_KEY ?? '';
  if (/[\r\n]/.test(apiKey)) throw new Error('Invalid TypeSafe key');
  if (battleMode === 'jev' && (!dryRun || callsInDryRun) && !apiKey.trim()) throw new Error('Set TYPESAFE_API_KEY');
  const rate = (name: string) => {
    const value = env[name];
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Invalid token cost rate');
    return parsed;
  };
  const inputRate = rate('JEV_INPUT_USD_PER_MILLION'), outputRate = rate('JEV_OUTPUT_USD_PER_MILLION');
  // Inside a container loopback is unreachable from a published port, so the interface has to be settable.
  // It stays loopback by default: this server has no authentication and is not safe to expose directly.
  const liveViewHost = env.LIVE_VIEW_HOST?.trim() || '127.0.0.1';
  if (/[^a-zA-Z0-9.:_-]/.test(liveViewHost)) throw new Error('LIVE_VIEW_HOST must be a host or interface address');
  const rawBattles = env.MAX_BATTLES?.trim();
  const maxBattles = rawBattles === undefined || rawBattles === '' ? 0 : Number(rawBattles);
  if (!Number.isInteger(maxBattles) || maxBattles < 0) throw new Error('MAX_BATTLES must be a whole number of battles, or 0 for no limit');
  // Ladder battles to play, one at a time, before the bot stops searching.
  const rawLadder = env.LADDER_BATTLES?.trim();
  const ladderBattles = rawLadder === undefined || rawLadder === '' ? 0 : Number(rawLadder);
  if (!Number.isInteger(ladderBattles) || ladderBattles < 0 || ladderBattles > 100) throw new Error('LADDER_BATTLES must be a whole number from 0 to 100');
  /*
   * Where battles come from. `challenges` accepts ACCEPT_CHALLENGES_FROM only; `ladder` searches the ladder and takes
   * challenges only once its run is complete; `both` ladders and takes a challenge between ladder games, never during
   * one. Unset, a LADDER_BATTLES run means `ladder` and anything else means `challenges`, as before this setting.
   */
  const rawPlay = env.PLAY_MODE?.trim().toLowerCase() || undefined;
  if (rawPlay !== undefined && !['challenges', 'ladder', 'both'].includes(rawPlay)) throw new Error('PLAY_MODE must be challenges, ladder or both');
  const playMode = (rawPlay ?? (ladderBattles > 0 ? 'ladder' : opponent ? 'challenges' : null)) as 'challenges' | 'ladder' | 'both' | null;
  const laddering = playMode === 'ladder' || playMode === 'both';
  if (laddering && (battleMode === 'observe' || battleRoom)) throw new Error('Ladder mode requires a decision mode and no configured room');
  if (playMode === 'both' && !opponent) throw new Error('PLAY_MODE=both needs ACCEPT_CHALLENGES_FROM, whose challenges it takes between ladder games');
  if (playMode === 'challenges' && !opponent) throw new Error('PLAY_MODE=challenges needs ACCEPT_CHALLENGES_FROM');
  // A ladder with no run length would search and spend for as long as the process runs, so something must end it.
  if (laddering && ladderBattles === 0 && maxBattles === 0) throw new Error('A ladder without LADDER_BATTLES needs MAX_BATTLES, or it would play without end');
  const rawPort = env.LIVE_VIEW_PORT?.trim();
  const parsedPort = rawPort === undefined || rawPort === '' ? 8733 : Number(rawPort);
  if (!Number.isInteger(parsedPort) || parsedPort < 0 || parsedPort > 65535) throw new Error('LIVE_VIEW_PORT must be a port number, or 0 to disable the live view');
  const livePort = parsedPort;
  // Lookahead by poke-engine: off, advise (its verdict goes into the payload) or blend (also mixed into the choice).
  const searchMode = env.SEARCH_MODE?.trim() || 'off';
  if (!['off', 'advise', 'blend'].includes(searchMode)) throw new Error('SEARCH_MODE must be off, advise or blend');
  const whole = (name: string, fallback: number, min: number, max: number) => {
    const raw = env[name]?.trim(), value = raw ? Number(raw) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
    return value;
  };
  const search = { mode: searchMode as 'off' | 'advise' | 'blend',
    bin: env.POKE_ENGINE_BIN?.trim() || 'vendor/poke-engine/target/release/poke-engine',
    worlds: whole('SEARCH_WORLDS', 16, 1, 64), msPerWorld: whole('SEARCH_MS_PER_WORLD', 100, 20, 1000),
    // A second pass of this many worlds when the first leaves its top two actions close; 0 turns it off.
    extraWorlds: whole('SEARCH_EXTRA_WORLDS', 0, 0, 64),
    closeRatio: (() => { const raw = env.SEARCH_CLOSE_RATIO?.trim(), value = raw ? Number(raw) : 0.6;
      if (!Number.isFinite(value) || value <= 0 || value > 1) throw new Error('SEARCH_CLOSE_RATIO must be above 0 and at most 1');
      return value; })(),
    // Endgames with at most this many Pokémon left on both sides together are solved by expectiminimax; 0 turns it off.
    endgamePokemon: whole('SEARCH_ENDGAME_POKEMON', 0, 0, 12),
    endgameWorlds: whole('SEARCH_ENDGAME_WORLDS', 8, 1, 64), endgameMsPerWorld: whole('SEARCH_ENDGAME_MS', 400, 50, 5000),
    // In blend, how much of the choice the search carries against the provider's probabilities.
    weight: (() => { const raw = env.SEARCH_WEIGHT?.trim(), value = raw ? Number(raw) : 0.5;
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('SEARCH_WEIGHT must be between 0 and 1');
      return value; })(),
    // In blend, the search's visit share on one action at which the provider is not asked: the blend would follow the
    // search anyway, and each call costs credit. 0 asks every time.
    skipProviderAtShare: (() => { const raw = env.JEV_SKIP_AT_SEARCH_SHARE?.trim(), value = raw ? Number(raw) : 0.7;
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('JEV_SKIP_AT_SEARCH_SHARE must be between 0 and 1');
      return value; })(),
    // In blend, the lead in the search's mean score it needs before overruling the provider; below it, the provider's choice stands.
    overrideMargin: (() => { const raw = env.SEARCH_OVERRIDE_MARGIN?.trim(), value = raw ? Number(raw) : 0.03;
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('SEARCH_OVERRIDE_MARGIN must be between 0 and 1');
      return value; })(),
    // Whether Jev sees the search's shares; unset, it does, in blend as in advise. Hiding them in blend keeps Jev's view
    // independent, but on the ladder Jev with them won 147 of 234 games (63%) and without them 24 of 50 (48%), and
    // without them Jev's lean against setup decides more close calls against the search.
    inPayload: (() => { const raw = env.SEARCH_IN_PAYLOAD?.trim();
      if (raw !== undefined && raw !== '' && !['true', 'false'].includes(raw)) throw new Error('SEARCH_IN_PAYLOAD must be true or false');
      return raw !== 'false'; })() };
  return { jev: { apiKey, model, maxCalls, timeoutMs, callsInDryRun,
    ...(inputRate === undefined ? {} : { inputUsdPerMillion: inputRate }),
    ...(outputRate === undefined ? {} : { outputUsdPerMillion: outputRate }) },
    url, battleRoom, battleMode, dryRun, opponent, debug: env.DEBUG === 'true', format: INITIAL_FORMAT,
    // The live view is on by default and loopback-only; LIVE_VIEW_PORT=0 turns it off.
    liveViewPort: livePort, liveViewHost,
    // 0 means keep taking challenges for as long as the process runs.
    maxBattles,
    // 0 in a ladder mode means no run length of its own; MAX_BATTLES then ends it.
    ladderBattles: laddering ? ladderBattles : 0,
    playMode,
    search,
    credentials: username ? { username, password } : undefined };
}
