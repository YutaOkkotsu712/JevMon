# Design notes

How the bot keeps its choices legal, what it tracks, what it sends Jev and which decisions code makes instead.
The overview is in the [README](../README.md).

## Reliability and scope

- Legal actions come exclusively from validated private requests, independent of
  the observational tracker. Commands use numeric move/roster slots and `rqid`.
- Disabled and exhausted moves, active/fainted switch targets, known trapping,
  forced switches, Tera, Struggle/recharge, Revival Blessing and full preview
  permutations are handled. Only the selected singles format is enabled.
- Hidden trapping or move restrictions can still cause server rejection. Those
  actions are marked uncertain. Unavailable choices wait for a revised request;
  invalid choices try another request-supported action. Three rejections per
  request ID stop retries and report the problem.
- Duplicate/stale requests are suppressed. Disconnects, wait requests, battle end
  and the server's `sentchoice` reconnect marker cancel pending decisions. Decisions
  are validated again immediately before sending. Invalid/failed/timed-out providers
  fall back to a legal action; random mode makes no Jev/API calls.
- Reconnect delay grows from 1 to 30 seconds. Initial handshakes time out after 15
  seconds. Half-open sockets still depend on underlying transport failure detection.
  If connection drops before a newly accepted battle's room ID arrives, manual room
  configuration may be needed. After a restart, a ladder game in progress is found again from the
  server's list of our games; per-battle Jev call limits start over.
- Jev is optional; observe/random modes make no API calls.
- A disk write error reports once and disables that logger. State snapshots may
  contain player names/private team information, but no credentials or chat.

The state tracks visible HP/status, switches/faints, boosts, revealed moves,
items/abilities, Tera, weather/terrain, Trick Room, hazards and turns. Private
requests supply the full own roster and exact HP. Unknown values use `null`, and
public HP is approximate. Duplicate private roster slots remain separate.

Tracker improvements include stable Pokémon IDs independent of roster slots,
private stats/moves, Transform with separate copied moves, boost copying/swapping,
volatile start/end events, ability suppression, side conditions, Court Change and
observed field start turns. Illusion marks remaining-team counts unknown instead
of guessing. This is still incomplete: indistinguishable public identities,
Baton Pass/Shed Tail volatile transfer, exact duration bounds, some ability/form
restoration and interactions need further work. Decision legality remains driven
by server requests, independently of strategic state.

The deterministic feature layer supplies move data, base STAB/type-chart factors,
conditional weather/terrain factors and hazard exposure. It distinguishes these
from action-specific damage envelopes computed with `@smogon/calc`. The inference
layer filters official Gen 9 role pools by revealed moves/Tera and uses reproducible
sampled sets for original items, abilities and base-speed ranges. Damage uses private
own stats/HP, known current items/abilities, boosts, weather, terrain and screens.
Envelopes combine rolls across compatible samples. Conditional KO labels describe
raw damage only, before accuracy, Sash/Sturdy, healing or an opponent action, and
are evaluated against the target's whole possible current-HP interval.

Every offered action carries a comparable evaluation, not only attacking moves:

- **Turn order.** Effective speed (modifiers and Trick Room included) against the
  sampled opposing spreads, plus the priority brackets those samples allow. A move is
  reported as moving first only when no sampled opposing move outranks it and it wins
  any equal-priority race; otherwise the opposing moves that would resolve first are
  named with their generation frequencies.
- **Incoming damage.** What the opposing active Pokémon could do to the current active
  Pokémon and to each switch target, over its revealed moves plus the most frequently
  generated moves of its compatible roles. Non-damaging possibilities (Will-O-Wisp,
  Taunt, recovery) are named rather than dropped.
- **Switch matchups.** For each switch target: types, HP, hazard exposure, incoming
  worst case, our own best damage from that Pokémon and its speed relation.
- **Move effects.** Recovery amounts, setup boosts, inflicted status, hazards, weather
  and terrain, forced and self switches, listed accuracy and secondary chances, so
  recovery and setup are comparable with attacking. Amounts the dex leaves out because
  they depend on the weather (Synthesis, Moonlight, Morning Sun, Shore Up) are computed
  from the current weather, and the ones that depend on the target (Strength Sap, Pain
  Split, Wish) say what they depend on.
- **Stalling.** `residualsPerTurn` is the end-of-turn HP change as a percentage of max HP —
  Leftovers, Black Sludge, burn, poison, Leech Seed, Salt Cure, Sandstorm, Grassy Terrain,
  with Magic Guard and the type immunities applied — which is what decides whether a Pokémon
  climbs out of a damage range. The opponent's item is often unknown, so theirs is a range.
  `survivalIfWeStayIn` counts how many more turns our Pokémon lasts against the worst incoming
  damage once that healing is counted, using the pessimistic end of ours.
- **PP.** Our own remaining PP comes from the private request. The opponent's is counted from
  observed uses against full PP Ups, which is how random battles generate — an upper bound on
  what remains, since turns we did not see are not counted, and moves called by another move
  spend no PP. Our own Pressure doubles what they spend, which is what makes stalling a move
  out realistic.
- **Protect.** A protecting move reports `successChance`, which falls to a third of itself for
  each consecutive protect, and `endOfTurnSwingPercentOfMaxHP`, the worst-case net gain from
  spending a turn taking nothing. The opponent still spends the PP of whatever it was blocked
  doing.
- **What a move's stat change buys.** `afterItsStatChange` projects one step: our best damage
  and speed relation once the stages land. A Dragon Dance that wins the matchup and a Draco
  Meteor that weakens the next hit both show up here.
- **What a status is worth.** `ifTheStatusLands` reports how much less we take once it applies,
  because a burn halves physical damage and paralysis halves speed — neither visible from the
  status name. Sleep Clause is enforced, so a second sleep move is not offered as if it worked.
- **Tera as defence.** `defensiveTera` reports what our own Tera changes about the damage we
  take, which is the half of Tera easiest to miss.
- **Hazards as investment.** A hazard move is priced by how many opposing Pokémon are still to
  come in and what each revealed one takes on entry, since it is paid for once and collected on
  every switch. Removal reports what it clears from each side.
- **The endgame.** `endgame` reads past the active pair: which of our Pokémon beat which of
  theirs, and which of theirs we have no answer to. Coarse on purpose — best move each way from
  full health, turns to knock out, faster side winning the race — and only for Pokémon revealed.
- **Choice lock.** `opponentChoiceLock` names the move a Choice item would have locked them
  into, with the probability from the candidate items still compatible. It is the most
  exploitable read available from public information alone.
- **Abilities.** The calculator models absorption, Unaware, the pinch abilities, the weather speed
  abilities (Swift Swim, Chlorophyll, Sand Rush, Slush Rush), Sand Force, Sheer Force and both Auras —
  including an Aura on the *defender*, which boosts our own move of that type. Protosynthesis and Quark
  Drive it does not model, so their Booster Energy stat is applied directly from the volatile that names
  it. Sheer Force trades a move's secondary effect for damage, so the secondary is no longer advertised
  on a move that will not have one. An ability that absorbs a hit shows up as zero damage, but a zero
  in an envelope is indistinguishable from a low roll. `takesNothingFromIt` names the ability and the
  probability mass of sets it holds for; `takesNothingBecauseOfOurAbility` does the same for incoming,
  where our own ability makes it certain. Both are taken from the calculator's own verdict rather than
  re-deriving the rule, so an attacker with Mold Breaker — which reads straight through Storm Drain,
  Levitate and Unaware alike — cannot turn either into a false promise. `pinchAbilities` name an ability
  that changes damage once its holder is low, with the threshold, and `ignoredByUnawareWithProbability`
  marks setup that the opponent would read straight through.
- **Form changes.** A move that changes the user's form changes its typing and stats while looking like
  an ordinary attack. `changesOurForme` gives what it becomes, the base-stat shifts, the damage and
  incoming figures afterwards, and whether it reaches the new typing without spending the one Tera
  available — Relic Song turning Meloetta into its Pirouette form is the case that occurs in random
  battles. Driven by the dex's own `requiredMove`, so it covers any such move rather than one by name.
- **Terastallising into a form.** Terapagos is the one Pokémon whose Tera changes its form rather than
  only its type, and the change costs it Tera Shell — the ability that halves every hit while it is at
  full health. `teraChangesOurForme` prices that: against Iron Boulder it reports incoming going from
  36.3% to 89.1% for 7.6% more damage of our own. Treating Tera as a type change hides it entirely.
- **Delayed recovery, and passing it.** A Wish heals whoever holds the slot when it lands, so switching
  after casting it passes the healing to the Pokémon coming in; a Healing Wish or Lunar Dance fully
  restores whatever comes in after its caster faints. Both are tracked from the moment they are set
  (`recoveryWaitingOnOurSide`) and described at the point of choosing them (`delayedRecovery`).
- **Effects the dex keeps in code.** Belly Drum, Tidy Up, Take Heart, Haze, Heal Bell and Trick carry
  their effects in behaviour rather than in data, so a move that maximises Attack looked identical to one
  that does nothing. These are described explicitly, and Belly Drum's projection spends the health it
  costs — reporting what is left and whether that still survives the reply.
- **Transforming by leaving.** Zero to Hero transforms Palafin when it switches *out*, and it returns
  with base Attack of 160 instead of 70. That makes switching a gain rather than the cost every other
  field here treats it as, and neither the move list nor the ability name says so.
  `switchingOutTransformsOurActive` reports what it becomes and what that is worth.
- **A knockout that moves first.** When two moves both knock the target out, the extra damage on the
  slower one buys nothing while the faster one wins the exchange untouched. That is the one dominance
  relation the damage comparison has to exclude, since it rests on differing priority, so it is checked
  separately: both knockouts must hold across every modelled set, the faster move may not be less
  accurate, and anything worth its own turn — draining back, pivoting out — is left alone.
- **Substitute and Shed Tail.** A Substitute is priced by whether the shell survives their best sampled
  hit: one that breaks at once has bought a single blocked hit, one that holds blocks status and stat
  changes for as long as it stands. Shed Tail is the same trade at twice the price and hands the shell to
  the Pokémon coming in, which is what makes it a setup move rather than a pivot.
- **Setup that never happens.** Stat changes are lost when their holder faints, and a stat move deals
  no damage to prevent that — so a projection that shows a sweep is misleading when the Pokémon is
  knocked out that turn. `afterItsStatChange` now carries
  `wastedBecauseWeAreKnockedOutFirst` in that case, evaluated *after* the boost so one that saves us is
  not wrongly flagged. It applies only to a move that buys a gain and deals nothing: a self-penalty on
  an attacking move is not a loss worth reporting. A status instead survives its user, so it is only
  marked as never going off when we would also move second.
- **Weather as setup.** Setting weather is setup for whatever our own moves do in it. `afterThisWeather`
  reports the damage after it lands and which move becomes our best, since nothing about a weather move
  says that Hydro Steam is what the sun is for.
- **What Tera buys here.** Tera can be spent once in a battle, so `teraBuysUs` states the difference it
  makes to this particular move — the damage with and without, the points gained, and whether it turns a
  non-knockout into one — rather than leaving that to be found by comparing two separate actions.
- **Whether a move would accomplish anything.** A status the target's type cannot take, a
  target that is already statused, a heal at full HP, boosts already at the cap, a hazard
  or weather already in place, Substitute below a quarter HP, Safeguard or Misty Terrain —
  reported as established facts. Hidden abilities and items that would block it instead
  (Magic Bounce, Good as Gold, Purifying Salt, Insomnia, Overcoat, Safety Goggles) are
  reported as possibilities with their generation frequency. Neither list is exhaustive.
- **Substitute.** A move aimed at a Pokémon behind a Substitute reports whether the
  Substitute absorbs it entirely (a status move accomplishes nothing), breaks first
  (damage never reaches the holder this turn), or is bypassed by a sound move or
  Infiltrator. The tracker starts Substitute HP at floor(max HP / 4), keeps a range
  after observed hits, handles explicit transfers, and clears it on break/switch.
  `damageRange.substituteDamage` reports shield damage and whether it breaks; a
  break is never called a KO and excess single-hit damage does not spill through.
  Critical, multihit or otherwise unmodeled hits leave a conservative HP interval.
- **Why an estimate is missing.** A null damage range, threat or matchup never means
  safety. `estimatesUnavailable` gives the state-wide cause and `damageUnavailable` any
  move-specific one, because a silently empty evaluation reads as an absence of danger
  and leaves whatever is still populated looking like the only option.
- **What a switch costs.** Switching forfeits the turn, so `incomingThreatIfWeStayIn` is
  the comparison and a switch target's damage is `ourBestDamageFromNextTurn`, not something
  comparable with a move's `damageRange`. `turnsOurActiveHasBeenIn`, `ourActiveJustSwitchedIn`
  and a target's `wasActiveTurnsAgo` say whether switching would undo the last one. A forced switch is framed explicitly:
  after a faint the active slot still holds the fainted Pokémon, so a speed relation or
  incoming threat computed from it would be meaningless — both are null, and
  `stayingInIsNotAnOption` states why beside them rather than leaving nulls that read as
  safety. The per-switch matchups still carry real numbers, which is what the choice
  should turn on.

One decision is not left to the model. A Pokémon that only just arrived, still facing the
opponent it was sent in to answer, switching again spends a second turn on a matchup already
chosen and gives up another free hit; repeated, it is a loop that never attacks. Describing
that cost in the payload did not stop it, so `cyclicSwitch` recognises the shape directly and
the decision loop skips it — taking the provider's **next-ranked action** rather than
substituting a choice of its own, so the model's judgement still decides. The skip is recorded
as `skippedCyclicSwitch` on the decision and reported in the status log.

Switching into a Pokémon that every sampled set knocks out on entry is *not* guarded, even when
another switch target would survive. An earlier guard skipped it, but a deliberate sacrifice can
buy a free replacement after the opposing attack, so entry death is a cost the model weighs
rather than proof the switch is dominated. The payload marks it as `knockedOutOnEntry` and the
loop sends it unchanged.

The cycle guard is deliberately narrow, because double switching is ordinary play. It never applies to a
forced switch, nor once a Pokémon has settled in, nor when the opposing Pokémon has changed
since we arrived — re-pivoting against a new opponent is a real decision — nor when staying in
is a certain knockout, which is worth a turn to escape. Actions are never removed from the
payload: the model still sees and ranks every legal option, and `wouldUndoLastSwitch` marks the
ones the guard would skip.

Hidden-set inference also learns from the battle itself. Observed turn order
eliminates sampled spreads that could not have produced it, and observed damage
eliminates sampled sets outside the roll envelope; a fainting target censors overkill,
so damage only ever yields a lower bound. Critical hits, extra hits, interrupting
effects, residual `[from]` damage, Illusion and Transform discard the observation
instead of attributing it. Every deduction is recorded with the candidate counts before
and after.

Ruling out *every* remaining set is treated as a contradiction rather than a deduction:
it means the model is wrong or the true set was never sampled, so nothing is eliminated,
the contradiction is counted in `evidenceContradictions`, and later estimates keep
working. The damage test also allows one HP of slack, because the damage formula rounds
at several steps and a single-point disagreement is model error, not evidence. Turn order
stays observable behind a Substitute, which changes no speeds; Slow Start's halving is
applied from its volatile, so it is modelled while it lasts and dropped when it expires.

This is **not complete hidden-state recovery**. Samples are not exhaustive or
probability estimates, and generation frequencies are marginal, not a posterior or a
model of what the opponent will choose. Unknown team members, team-generation
constraints, server updates and changed moves/identities remain unresolved.
Transform, unmodeled active volatiles, multihit and some
history-dependent moves return null damage. Switch matchups exclude the switch turn
itself: no entry abilities such as Intimidate, and the opponent may switch too.
Unsupported states and no compatible samples never silently fall back to an
invented set.

Data comes from [pkmn/randbats](https://github.com/pkmn/randbats), the public feed behind
Showdex and the Randbats Tooltip, plus the official Showdown role pools. All three
snapshots are dated 2026-09-22 and refresh with a script that validates the shape before
writing:

- `gen9-joint-sets.json` — the candidate pool: every complete (item, ability, moves, Tera)
  combination the dataset recorded, with the share of 600,000 generation draws that
  produced it. Because these are joint sets rather than marginals, each candidate carries
  a real `probability`, and a KO can be reported as probability mass rather than only as
  "some sampled rolls". `data/full` records no EVs or IVs, so each set is attributed to
  the roles whose pool could have produced it and takes their spread — random battles use
  85 EVs and 31 IVs except where a role overrides them. Where attributed roles disagree on
  the spread, every distinct spread is emitted and the probability is split by role weight
  rather than guessing. Refresh with `node scripts/fetch-randbats-sets.mjs`.
- `gen9-randbats-stats.json` — per-role move, item, ability and Tera frequencies, used for
  role compatibility and for the coarser `setPriors`. Roles that generate no item report
  the missing mass as `noItemProbability` rather than implying it away. Refresh with
  `node scripts/fetch-randbats-stats.mjs`.
- `gen9-sets.json` — the official
  [Showdown source](https://github.com/smogon/pokemon-showdown/blob/master/data/random-battles/gen9/sets.json)
  role pools, for compatible movepools, abilities and Tera types.

This replaced an earlier approach that resampled the generator locally with
`@pkmn/randoms`, 128 draws per species. That sampling missed 732 of the 5,802 recorded
joint sets across 97 species — as much as 108 of Mew's 177 — so the candidate pool could
omit the opponent's actual set, and the evidence layer could eliminate on a set that was
never sampled. The simulator is no longer needed to build the set data.

Production requests start at **reduced** detail within a 28,000-byte budget. Full
features remain available for local diagnostics only. The emergency minimal payload
retains all legal actions, damage, switch threats, turn order, setup warnings and
endgame context; it drops detailed set summaries and secondary projections and
names those omissions. The versioned instructions explicitly explain survival,
execution risk, endgame, Substitute, effects and guards. Successful decisions log
`instructionsVersion`, `payloadDetail` and `payloadBytes`.

A third runtime guard skips narrowly dominated simple attacks using Jev's next
ranked non-guarded legal action. It compares every modeled set and requires equal
accuracy, priority, relevant effects and Tera cost, with no PP disadvantage. It
never invents an action and logs `skippedDominatedMove`. Different useful effects
remain a choice: Flamethrower's burn prevents treating Hydro Steam's extra damage
as strict dominance against a healthy, unstatused target. A separate
`strongerImmediateDamageAvailable` comparison makes that tradeoff explicit.

Before restarting on new code, run `npm run preflight` (or `npm run preflight -- 60` for more games). It rebuilds
the recent logged decisions with the current build and the live `.env`. It reports the payload tier split against
what was played, payload sizes, build errors, whether our own active Pokémon can be modelled, missing estimates, and
which guards would now change a logged choice. It warns, and exits non-zero, when more decisions fall to the minimal
tier or anything fails to build.

`npm run build && node scripts/audit-decisions.mjs` replays every retained decision
state in `logs/` through current features without API calls, and rewrites `docs/DECISION-AUDIT.json`. See `docs/DECISION-AUDIT.json`
for budget counts and historical choice flags. Reconstructed requests can lack PP;
this audit does not rerun Jev or measure the prompt's effect on winning.

Snapshots mark turn starts, private requests and battle end. Rejoins can append
replayed snapshots; observation logs are not deduplicated analytics.

The feature layer is deterministic, so `node scripts/inspect-battle.mjs logs/<file>.jsonl`
rebuilds exactly what was sent for every decision in a recorded battle and prints the
deductions, the choices, and the model's confidence against uniform; add `turn <n>` for
one turn's full payload. Exclusions already recorded in a log carry over, so a replay
shows the evidence as it stood at the time rather than as the current code would derive
it. Because the calculator matches items and abilities by display name while private
requests supply IDs, both are resolved through the dex before any calculation, and an
unrecognised name declines the estimate rather than being silently dropped.

## Protocol sources

- [Official Showdown protocol](https://github.com/smogon/pokemon-showdown/blob/master/PROTOCOL.md)
- [Battle protocol and choices](https://github.com/smogon/pokemon-showdown/blob/master/sim/SIM-PROTOCOL.md)
- [Authoritative choice implementation](https://github.com/smogon/pokemon-showdown/blob/master/sim/side.ts)
- [Request generation](https://github.com/smogon/pokemon-showdown/blob/master/sim/pokemon.ts)
- [Current challenge messages](https://github.com/smogon/pokemon-showdown/blob/master/server/ladders-challenges.ts)
- [Server request/reconnect handling](https://github.com/smogon/pokemon-showdown/blob/master/server/room-battle.ts)
