export type SideId = 'p1' | 'p2';
export interface PokemonState {
  entryProjected?: boolean;
  hitsTaken?: number;
  inference?: { excluded: string[]; contradictions: number;
    observations: { kind: 'speed' | 'damage'; turn: number; before: number; after: number; contradiction?: true; note: string }[] };
  id: string;
  ident: string;
  slot: number | null;
  details: string;
  species: string;
  transformedInto: string | null;
  knownMoves: string[];
  copiedMoves: string[];
  stats: Record<string, number>;
  volatiles: Record<string, { sinceTurn: number; data: string | null }>;
  baseAbility: string | null;
  /** The last berry this Pokémon ate itself, which Harvest can grow back; one knocked off or stolen does not count. */
  lastBerry?: string;
  /** The turn its item was last lost or used up, which is what switches Unburden on until it leaves the field. */
  itemLostOnTurn?: number;
  /** PP spent per move id, counted at each use: two when the move hit a Pokémon with Pressure, one otherwise. */
  ppSpent?: Record<string, number>;
  /**
   * An Outrage-style lock in progress: the move and how many turns it has run. It runs two or three turns and ends in
   * confusion, so after the first turn its next move is certain and after the second it is even odds.
   */
  rampage?: { move: string; turns: number };
  /** A Zoroark found under a disguise (Illusion): what it looked like, restored when it leaves the field. */
  illusion?: { species: string; details: string };
  /** Set only on a copy used for a calculation: the target of its attack has just switched in, so Stakeout applies. */
  stakeoutActive?: boolean;
  abilitySuppressed: boolean;
  substitute?: { hp: [number, number]; initialHP: [number, number]; hits: number; source: 'created' | 'unknown-transfer' };
  exactHP?: { current: number; max: number };
  hpPercent: number | null;
  hpPrecision: 'exact' | 'public' | 'unknown';
  status: string | null;
  fainted: boolean;
  boosts: Record<string, number>;
  revealedMoves: string[];
  ability: string | null;
  item: string | null;
  teraType: string | null;
  terastallized: boolean;
  /** Turn this Pokémon last entered the field, so undoing a switch has a visible cost. */
  activeSinceTurn: number | null;
  /** Turn this Pokémon last left the field, so returning to it is recognisable as a cycle. */
  lastActiveTurn: number | null;
  /** Times each move has been seen used, by move ID. Calls that spend no PP are not counted. */
  moveUses: Record<string, number>;
  /** Our own remaining PP, by move ID, as the private request reports it. */
  movePP: Record<string, { remaining: number; max: number }>;
  /** Consecutive protecting turns, which is what makes the next one likely to fail. */
  consecutiveProtects: number;
  /** Turns spent badly poisoned, since toxic damage grows by a sixteenth each turn. */
  toxicTurns: number;
  /** Turns already lost to sleep, which is what narrows the 1-3 turn duration into a wake-up chance. */
  sleepTurns: number;
  /** Deduplicates a sleep `cant` line and the Sleep Talk move when both describe the same turn. */
  lastSleepTurnCounted?: number | null;
  /** Rest sleeps for exactly two turns, so its counter is known rather than estimated. */
  sleepFromRest: boolean;
  /** Turn this Pokémon last spent its action, which is what Truant counts. Absent in states from older logs. */
  lastActedTurn?: number | null;
  /** The last move seen used, which is what a Choice item locks a Pokémon into. */
  lastMoveUsed: string | null;
  /** Consecutive turns the same move has been used, the public sign of a Choice lock. */
  sameMoveStreak: number;
}
/** One Pokémon entering the field, with enough context to tell a free replacement from a chosen switch. */
export interface SwitchRecord {
  turn: number;
  from: string | null;
  to: string;
  /** Our or their Pokémon on the field at that moment, which is what the switch was answering. */
  facing: string | null;
  /** A replacement after a faint is free, not a choice. */
  afterFaint: boolean;
  /** Roar, Whirlwind, Dragon Tail and the like drag a Pokémon in; the side did not choose it. */
  dragged: boolean;
  /** The pivot move that carried the switch, such as U-turn or Flip Turn, when there was one. */
  via: string | null;
}
export interface SideState {
  totalFaints?: number;
  /** Every entry this battle, most recent last. Absent in states from older logs. */
  switches?: SwitchRecord[];
  name: string | null;
  rating: number | null;
  teamSize: number | null;
  team: PokemonState[];
  activeId: string | null;
  hazards: Record<string, number>;
  /** `turns` is how long it lasts when not the usual five: a screen from a Light Clay holder lasts eight. */
  conditions: Record<string, { sinceTurn: number; turns?: number }>;
  /**
   * Recovery waiting on this side's slot. A Wish heals whoever occupies the slot when it lands, which is
   * what makes passing it possible; a Healing Wish restores whatever comes in after its user faints.
   */
  slotConditions: { wish?: { setOnTurn: number; healsHP: number | null; from: string; fromId?: string }; healingWish?: { from: string; move: string };
    /** A Future Sight this side cast, striking the other side's slot at the end of the second turn after. */
    futureSight?: { setOnTurn: number; fromId: string } };
  identityUncertain: boolean;
}
export interface BattleState {
  /** Public choices recorded against the position before either player acted. */
  actionHistory?: import('../strategy/opponentModel.js').ActionObservation[];
  turnContext?: Partial<Record<SideId, import('../strategy/opponentModel.js').ChoiceContext>>;
  battleId: string;
  format: 'gen9randombattle';
  turn: number;
  mySide: SideId | null;
  sides: Record<SideId, SideState>;
  field: { weather: string | null; terrain: string | null; trickRoom: boolean };
  effectStartTurns: Record<string, number>;
  ended: boolean;
  winner: string | null;
  /**
   * The pair of Pokémon now facing each other, with the turn they met and both HPs then, so a stalled exchange —
   * one side's recovery or lost turns outpacing the other's damage — shows as numbers. Absent in older logs.
   */
  /** The current pairing: who met when, at what HP, and how many healing moves each side has used since. */
  matchup?: { p1: string; p2: string; sinceTurn: number; p1HP: number | null; p2HP: number | null; heals?: { p1: number; p2: number } };
  /**
   * Healing moves used over the whole battle by one Pokémon while facing another, keyed `healer>facing` by Pokémon id.
   * A pairing that breaks up and meets again keeps its history: a Chimecho that Recovered twice against Electrode is
   * the same staller when Electrode returns. Absent in older logs.
   */
  healsAgainst?: Record<string, number>;
  /** The move we chose this turn, private to us: when the opponent acts first and we never do, it is what they outsped. */
  ourChoice?: { turn: number; move: string | null };
  requestKind: 'none' | 'move' | 'switch' | 'wait' | 'preview';
  /** Limitations are explicit; this tracker is not ready to drive decisions yet. */
  uncertainties: string[];
}
export function createBattleState(battleId: string): BattleState {
  const side = (): SideState => ({ name: null, rating: null, teamSize: null, team: [], activeId: null,
    hazards: {}, conditions: {}, slotConditions: {}, identityUncertain: false });
  return { battleId, format: 'gen9randombattle', turn: 0, mySide: null,
    sides: { p1: side(), p2: side() }, field: { weather: null, terrain: null, trickRoom: false },
    effectStartTurns: {}, ended: false, winner: null, requestKind: 'none', uncertainties: [] };
}
export function remainingPokemon(side: SideState): number | null {
  return side.teamSize === null || side.identityUncertain ? null : Math.max(0, side.teamSize - side.team.filter(p => p.fainted).length);
}
