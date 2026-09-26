import type { DecisionInput } from '../decisions/DecisionProvider.js';
import type { GamePlan, PokemonPlan } from './gamePlan.js';
import { afterEntry } from './entry.js';
import { incomingThreats } from './threat.js';
import { damageRange } from './damage.js';
import { turnOrder } from './speed.js';
import { afterTerastallizing } from './forme.js';
import { knockoutBoosts } from './abilities.js';
import { dex, id } from '../pokemon/data.js';
import { healPercentNow } from '../pokemon/mechanics.js';
import { switchPunish } from './prediction.js';

/** These rules express tactical preferences, not legality or strict dominance. */
export const SOFT_GUARDS = new Set(['cyclicSwitch', 'needlessGamble', 'preserveSoleDefensiveAnswer',
  'baitedCrash', 'outhealed', 'recoilIntoRecovery', 'asleepWhileTheyBoost', 'setupIntoPhazer', 'setupRaceLost',
  'chargeWontFire', 'seededAndLosing', 'setupIntoSleep', 'sleeperThrownAway',
  'doomedReplacement', 'futileSubstitute', 'statusIntoKnockout', 'destinyBondTrade', 'endeavorTooEarly',
  'pickedOffOnArrival', 'pivotIntoKnockout', 'savingTheDoomed', 'losingHealLoop']);
export interface TacticalAdvice { action: string; guard: string; reason: string; alternative?: string }
const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const importance = (p: PokemonPlan | undefined) => p ? clamp(0.25 + 0.45 * p.contribution + 0.2 * p.uniqueAnswers.length) : 0.25;

/** Bounded adjustments to the existing ranking. No hypothetical role makes an action illegal,
 * and a strong engine value gap is protected from these approximate one-turn estimates. */
export function rankTacticalChoices(input: DecisionInput, base: Record<string, number>, chosen: string,
  plan: GamePlan | null, advice: TacticalAdvice[]) {
  const s = input.state, side = s.mySide;
  const corrections: Record<string, { logAdjustment: number; reasons: string[] }> = {};
  // Teras whose defensive typing turns a knockout into a survivable hit: the one case where these estimates may move a
  // plain choice onto a Tera. Anything else spent the Tera on a heuristic's say-so, early and for little.
  const rescues = new Set<string>();
  const add = (action: string, amount: number, why: string) => {
    if (!Number.isFinite(amount) || Math.abs(amount) < 0.005) return;
    const row = corrections[action] ??= { logAdjustment: 0, reasons: [] };
    row.logAdjustment += amount; row.reasons.push(why);
  };
  for (const a of input.legalActions) {
    const concerns = advice.filter(x => x.action === a.id);
    // Several related guards are one concern, not independent evidence to multiply forever.
    if (concerns.length) add(a.id, -Math.min(2.3, 2.1 + (concerns.length - 1) * 0.1), concerns.map(x => `${x.guard}: ${x.reason}`).join('; '));
    if (advice.some(x => x.alternative === a.id)) add(a.id, 0.4, 'A tactical concern identifies this legal alternative; it must still compete with all choices');
    // A concern about a Tera is a concern about the Tera, so the same move without it is its first alternative: skipped
    // Tera Close Combats fell back to U-turn three turns running, each one feeding a teammate to Glastrier (2687217753).
    else if (!concerns.length && advice.some(x => x.action === `${a.id}-terastallize`)) add(a.id, 0.4, 'The same move without the Tera the concern is about');
  }
  if (side && plan) {
    const ours = s.sides[side], theirs = s.sides[side === 'p1' ? 'p2' : 'p1'];
    const me = ours.team.find(p => p.id === ours.activeId), foe = theirs.team.find(p => p.id === theirs.activeId);
    const role = plan.roles.find(p => p.pokemon === me?.id);
    if (me && foe && !foe.fainted) {
      const attackShare = plan.opponent?.probabilities.attack ?? 0.65;
      const incoming = me.fainted ? null : incomingThreats(s, me, side, 2);
      const normalHit = incoming?.worstCasePercentOfMaxHP;
      const danger = normalHit == null || me.hpPercent === null ? null : clamp(normalHit / Math.max(1, me.hpPercent));
      const snowball = knockoutBoosts(foe)?.reduce((v, a) => v + (a.probability ?? 0), 0) ?? 0;
      const futureReservation = Math.max(0, ...plan.roles.filter(p => p.pokemon !== me.id).map(p => p.tera?.gain ?? 0));
      const responses = plan.opponent && plan.opponent.evidence >= 1
        ? switchPunish(s, me, side, me.knownMoves, 6)?.likelyToComeIn ?? [] : [];
      for (const action of input.legalActions) {
        if (action.uncertain || action.kind === 'revive') continue;
        if (action.kind === 'switch') {
          const target = ours.team.find(p => p.slot === Number(action.command.split(' ')[1]));
          if (!target) continue;
          const q = afterEntry(s, target, side), targetRole = plan.roles.find(p => p.pokemon === target.id);
          const hazards = Math.max(0, (target.hpPercent ?? 0) - (q.hpPercent ?? 0));
          const free = me.fainted || (!!input.request?.forceSwitch?.[0] && foe.lastActedTurn === s.turn);
          const threat = free ? null : incomingThreats(s, target, side, 2);
          const hit = threat?.worstCasePercentOfMaxHP;
          const death = q.fainted ? 1 : hit == null || q.hpPercent === null ? 0 : clamp(hit / Math.max(1, q.hpPercent));
          const loss = hazards / 100 + (free || hit == null ? 0 : Math.min(q.hpPercent ?? 100, hit) / 100 * attackShare);
          const saved = free || danger === null ? 0 : danger * attackShare * (importance(role) - 0.25);
          add(action.id, saved - loss * importance(targetRole) - death * (importance(targetRole) - 0.25) * (free ? 1 : attackShare),
            'Current contribution saved versus hazards, entry damage and loss of the arriving teammate');
          if (free) add(action.id, 0.4 * (targetRole?.contribution ?? 0), 'Contribution after this free entry');
          if (snowball && !free && death >= 0.95) add(action.id, -0.25 * snowball * attackShare,
            'This entry can feed an opposing knockout boost; a sacrifice is still allowed');
        } else if (action.kind === 'move' && !me.fainted) {
          const tera = action.command.endsWith(' terastallize') ? input.request?.active?.[0]?.canTerastallize : undefined;
          const move = dex.moves.get(action.label.split(' + Tera')[0]!);
          const d = move.category === 'Status' ? null : damageRange(s, move.name, tera);
          const firstKO = d?.conditionalKO === 'all-sampled-rolls' && turnOrder(s, tera ? afterTerastallizing(me, tera) : me, move.name)?.order === 'ours-first';
          const threat = tera ? incomingThreats(s, me, side, 2, tera) : incoming;
          const hit = threat?.worstCasePercentOfMaxHP;
          if (!firstKO && hit != null && me.hpPercent !== null) {
            // Recovery helps only if it can occur, and only up to full HP: a heal at 90% restores 10 when it goes first
            // and the hit lands after it. Protect's setup risks remain with search and the guards.
            const heal = hit < me.hpPercent ? healPercentNow(move.name, s.field.weather) ?? 0 : 0;
            const healsFirst = heal > 0 && turnOrder(s, me, move.name)?.order === 'ours-first';
            const after = healsFirst ? Math.min(100, me.hpPercent + heal) - hit : Math.min(100, Math.max(0, me.hpPercent - hit) + heal);
            // A protect succeeds a third as often for each one in a row before it.
            const blocked = move.stallingMove ? (1 / 3) ** (me.consecutiveProtects ?? 0) : 0;
            const lost = (1 - blocked) * Math.max(0, me.hpPercent - Math.max(0, after)) / 100;
            add(action.id, -lost * (importance(role) - 0.25) * attackShare, 'HP lost from a currently useful remaining answer');
          }
          if (tera && plan.teraAvailable) {
            // Only ever a reason to keep it: a teammate whose Tera wins more against what is revealed now. The plan's
            // own gain is a coarse race over four sampled sets, too rough to spend the once-a-battle Tera on.
            add(action.id, 0.5 * Math.min(0, (role?.tera?.gain ?? 0) - futureReservation), 'Another living teammate gains more from the Tera against current reveals');
            if (hit != null && normalHit != null && me.hpPercent !== null && normalHit >= me.hpPercent && hit < me.hpPercent &&
                ((d?.percentOfMaxHP[1] ?? 0) > 0 || (healPercentNow(move.name, s.field.weather) ?? 0) > 0)) {
              add(action.id, 0.65 * attackShare, 'Defensive Tera changes this hit from lethal to survivable and allows useful action');
              rescues.add(action.id);
            }
          }
          if (plan.opponent && plan.opponent.evidence >= 1) {
            if (move.id === 'suckerpunch') add(action.id, 0.35 * (plan.opponent.probabilities.attack - 0.5),
              'Opponent attack tendency, with uncertainty and switch/status alternatives retained');
            if (move.boosts && move.target === 'self') add(action.id, 0.15 * plan.opponent.probabilities.recover,
              'Observed recovery tendency can create a setup opportunity');
            if (!tera && d && plan.opponent.likelySwitches.length) {
              let weighted = 0, mass = 0;
              for (const next of plan.opponent.likelySwitches) {
                const name = theirs.team.find(p => p.id === next.pokemon)?.species;
                const hit = responses.find(p => p.species === name)?.ourMoveDamage[move.name]?.percentOfItsMaxHP;
                if (hit) { weighted += (hit[0] + hit[1]) / 2 * next.weight; mass += next.weight; }
              }
              if (mass) add(action.id, clamp((weighted / mass - (d.percentOfMaxHP[0] + d.percentOfMaxHP[1]) / 2) / 100, -1, 1) *
                plan.opponent.probabilities.switch * 0.3, 'Damage into observed switch destinations, discounted by uncertain switch likelihood');
            }
          }
        }
      }
    }
  }
  const bestScore = Math.max(-Infinity, ...input.legalActions.map(a => input.search?.[a.id]?.meanScore ?? -Infinity));
  const anchor = Math.max(0, ...Object.values(base));
  const plainPick = !chosen.endsWith('-terastallize');
  const searchTop = Object.entries(input.search ?? {}).sort((x, y) => (y[1].visitShare ?? 0) - (x[1].visitShare ?? 0))[0]?.[0];
  const ranking = Object.fromEntries(input.legalActions.map(a => {
    const c = corrections[a.id];
    if (c) c.logAdjustment = clamp(c.logAdjustment, -2.6, 0.8);
    // The blend's own choice always stays in the running. Anything it already ruled out stays out: a zero is a Tera
    // held back, or one the search did not back, and a floor under it handed back Earthquake + Tera Ground the blend
    // had just held (2688081115).
    if (a.id === chosen) return [a.id, Math.max(0.0001, anchor) * Math.exp(c?.logAdjustment ?? 0)];
    const value = input.search?.[a.id]?.meanScore;
    const viable = value == null || value >= bestScore - 0.1;
    const tera = a.id.endsWith('-terastallize');
    // From a plain choice, a Tera is reachable only as a rescue that is also the search's own first choice, the rule the
    // guard fallback keeps: a rescue on 7% of visits would have spent Tera Poison over a Knock Off (2688074287).
    // Without a search there is no first choice to check, and the rescue stands on its own.
    const teraAllowed = !tera || !plainPick || rescues.has(a.id) && (!input.search || a.id === searchTop &&
      (value ?? -Infinity) >= (input.search[chosen]?.meanScore ?? -Infinity));
    return [a.id, viable && teraAllowed ? (base[a.id] ?? 0) * Math.exp(c?.logAdjustment ?? 0) : 0];
  }));
  // Preserve the blend's selected near-tie unless some actual strategic evidence changes it.
  const preferred = input.legalActions.find(a => a.id === chosen) ?? input.legalActions[0]!;
  const best = Object.keys(corrections).length ? input.legalActions.reduce((a, b) => ranking[b.id]! > ranking[a.id]! ? b : a, preferred) : preferred;
  return { chosen: best.id, ranking, corrections };
}
