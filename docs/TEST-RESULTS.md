# Validation — 2026-09-22

- 176 unit tests passed (`npm test`), including role elimination, contradictory evidence,
  immunity, screens, weather, Tera, unknown-state fallback and rounded-HP Multiscale
  handling, plus new coverage for the deduction and evaluation layers:
  observed turn order and observed damage eliminating sampled sets, priority moves
  conveying no speed information, Trick Room inverting the speed deduction, overkill
  censoring on a fainting target, crits/extra hits/interrupting effects and residual
  `[from]` damage discarding an observation, Illusion clearing attribution, incoming
  damage and switch matchups, priority-versus-speed turn order, move effects, the
  payload detail ladder, and an itemless generated role. Later additions cover request-supplied item and
  ability IDs reaching the calculator, unrecognised names failing closed, partial narrowing by Choice item,
  a total contradiction retaining the hypothesis space, one point of rounding slack, Substitute absorption
  and bypass, and Slow Start halving speed only while its volatile is up.
- Three deterministic simulator battles completed: 354 decisions, 163 turns, no
  rejected choices. One battle used the Jev adapter with mocked API responses;
  51 of its 64 API payloads contained calculated damage scenarios.
- Real TypeSafe smoke tests succeeded, including one asserting damage features
  were present before sending the API request.
- Controlled live battle: `battle-gen9randombattle-2685569984`. Bot lost in 20 turns.
  It submitted 25 decisions, including one singleton requiring no API call.
  All 24 Jev calls succeeded, with no malformed responses or rejected choices.
  Median recorded decision latency: 413 ms. Usage: 116,111 input tokens and 1,920
  output tokens. Dollar cost unknown because token rates were not configured.
- The test process was stopped after the battle. Start with `npm start` for a new
  allowlisted challenge; no room ID is needed in challenge mode.

The live run loaded the initial damage/inference implementation. Replaying its logged
states through the current feature layer shows why every one of its 20 voluntary
choices was an attack: the payload reported `speedRelation: "unknown"`, gave switch
actions only hazard exposure, gave status moves nothing at all, and recorded no
hidden-set deductions on any opposing Pokémon. Jev's own reported distributions were
near-uniform (top probability 0.17 against 0.13 uniform on turn 1, confidence 0.09),
which is what a payload with nothing to discriminate on should produce.

Since then, both deductions are exercised and covered by tests, and every action
carries a comparable evaluation. Replaying the same 25 logged decisions through the
current feature layer produces a populated speed relation, incoming-damage envelopes,
switch matchups and move effects, with a peak payload of 20,266 bytes against the
24,000-byte local budget (median build time 2 ms, peak 46 ms on the first call).

## Second live battle — `battle-gen9randombattle-2685591553`

Lost in 30 turns, 35 decisions, no rejected choices and no tracker uncertainties.
Median decision latency 446 ms, peak 1,676 ms. 33 API attempts, 32 successful; one
response failed schema validation and fell back to a legal choice, recovering on the
next turn. Usage 234,290 input and 2,814 output tokens — about 7,300 input tokens per
call, against roughly 4,840 in the first battle, for the richer payload.

What changed in behaviour: **6 of 30 voluntary choices were switches**, against 0 of 20
in the first battle, and the bot used setup and recovery moves rather than only
attacking. The highest-confidence voluntary decision of the battle (0.54, against 0.167
uniform) was a switch on turn 19, the one turn where an incoming `all-sampled-rolls` KO
was visible. Hidden-set deductions were recorded live for the first time: four
observations across two opponents.

The battle also exposed three defects, all since fixed and covered by tests:

- **Request item and ability IDs never reached the calculator.** Showdown's private
  request supplies IDs (`"item":"lifeorb"`); `@smogon/calc` matches display names and
  silently ignores anything else. Every estimate involving our own side was therefore
  computed with no item and no ability — Gengar's Shadow Ball read 80.8% of the target's
  HP instead of 105.1%. Names are now resolved through the dex, and an unrecognised name
  fails closed instead of being dropped.
- **One observation could empty the hypothesis space.** That understated damage made a
  turn-2 observation contradict all 12 sampled Annihilape sets, excluding every one of
  them; `inferOpponent` then returned no candidates, so damage, speed, threats and
  matchups were all null for that Pokémon for the rest of the battle. Ruling out every
  remaining set now counts as a contradiction and eliminates nothing, and the damage
  test carries one HP of slack for the formula's rounding chain.
- **A Substitute blanked the whole evaluation layer.** A Regigigas Substitute stood for
  20 turns. `supportedState` vetoes on any volatile, so every damage range, speed
  relation, threat and matchup went null, leaving listed move effects as the only
  populated field — so status moves were the only actions that looked actionable, and
  the bot spent five turns on Will-O-Wisp into the Substitute. Moves aimed at a
  Substitute now report whether it absorbs them entirely, breaks first, or is bypassed;
  speed and turn order are computed through a Substitute, since it changes no speeds;
  Slow Start is modelled from its volatile rather than vetoing speed outright; and a
  missing estimate now states its cause, so absent numbers cannot read as safety.

Replaying the same 35 decisions through the fixed code resolves a speed relation and
settled turn orders on nearly every turn instead of from turn 8 onward, and marks the
absorbed status moves. Peak payload across both battles' 60 decisions is 22,097 bytes
against the 24,000-byte budget; no decision needed the reduced tier, though the margin
on a 13-action turn is thin and the ladder is what covers it.

Not re-run in this session: the simulator harness (`npm run test:sim`, which needs
`SIMULATOR_DIR`). The harness now also asserts that hidden-set deductions occur, that
switch actions carry a matchup, that some turn orders are settled rather than always
uncertain, that staying in is priced, and that the payload stays within budget while
describing every offered action.

## Changes after the second battle

Beyond the three defects above, auditing every chosen move for wasted effect produced two
more gaps and one data-source change:

- **Recovery the dex does not quantify.** Synthesis, Moonlight, Morning Sun, Shore Up and
  Rest carry no `heal` field, so the payload said nothing at all about them healing. They
  are now computed from the current weather (50%, 66.7% in sun, 25% otherwise), and the
  target-dependent ones (Strength Sap, Pain Split, Wish) say what they depend on.
- **Nothing flagged a wasted status move.** Beyond the Substitute, a move can accomplish
  nothing because the target's type cannot take that status, it is already statused, a heal
  is at full HP, boosts are capped, a hazard or weather is already up, Substitute is below a
  quarter HP, or Safeguard or Misty Terrain is protecting it. Hidden abilities and items
  that would block it are reported separately, with their generation frequency.
- **The candidate pool was resampled rather than enumerated.** It came from running
  `@pkmn/randoms` 128 times per species; `pkmn/randbats` publishes the complete joint sets
  it actually recorded. That sampling missed **732 of 5,802 joint sets across 97 species** —
  108 of Mew's 177, 77 of Thundurus's 137 — so the pool could omit the opponent's real set
  and the evidence layer could eliminate on a set never sampled. The pool now comes from
  `data/full`, and every candidate carries the share of 600,000 recorded draws that produced
  it, so a KO is reported as probability mass where candidate sets disagree instead of only
  as "some sampled rolls". All 5,802 sets attributed to exactly one spread, with none
  unaccounted for.

An invalid response is now diagnosable: each rejection names the failing field, the value
is bounded to 120 characters and stripped of control characters, and
`jev_invalid_response` is distinct from a transport `jev_failed`. This cannot recover the
one seen in the battle above, since response bodies were not retained.

110 unit tests pass. Peak payload across both battles' 60 decisions is 23,574 bytes of the
24,000-byte budget, with no decision needing the reduced tier — a thin margin that the
detail ladder covers.

## Third live battle — `battle-gen9randombattle-2685604792`

Lost in 25 turns, 32 decisions. The deduction layer is confirmed working: observations
narrowed the candidate pool partially rather than all-or-nothing — `Krookodile 8 -> 2`
sampled sets — with **zero contradictions** across the whole battle, against the previous
battle's single observation that wrongly excluded all twelve.

It also exposed a behavioural loop worth recording. On five of six forced switches the bot
brought in Darkrai and switched it out again the next turn. The payloads were checked and
were numerically identical across both turns, so this was not an inconsistency in the data:

| Switch-in | Takes | Deals |
| --- | --- | --- |
| Darkrai | 80.8% | 22.5% |
| Furret | 63.5% | 75.4% |
| Basculegion-F | 127.8% (dies) | 228.6% (KOs) |

Darkrai was the worst safe option and was chosen at confidence 0.26 against 0.20 uniform —
close to a coin flip. Two information defects contributed, both fixed:

- **A forced switch after a faint reported a meaningless speed relation.** The active slot
  still holds the fainted Pokémon, so the relation was computed from it and came out
  `unknown`, with `incomingThreatIfWeStayIn` null. That null is correct — there is no
  staying in — but nothing said so, and it sat beside five switch options carrying real
  numbers. Both are now null with `stayingInIsNotAnOption` stating the reason next to them.
- **Nothing represented the cost of undoing a switch.** Leaving a Pokémon that had just
  arrived, forfeiting a second turn to return to a position already left, was priced
  identically to any other switch. `activeSinceTurn` is now tracked, surfacing
  `turnsOurActiveHasBeenIn` and `ourActiveJustSwitchedIn`.

Choosing Darkrai at all was a model call rather than a data gap: Furret's 75.4% against
Darkrai's 22.5% was in the turn-11 payload already. Better framing is not a guarantee the
loop stops.

Two operational limits also came due. Input tokens per call have grown across the three
battles — about 4,800, then 7,300, then 9,200 — and with them the latency tail: median 455 ms
and 90th percentile 1.5 s across all 92 decisions, but a maximum of 3,061 ms that the 3 s
timeout cut off, falling back to a random choice. `JEV_TIMEOUT_MS` is now 6,000 by default.
The payload had also reached 24,593 bytes at full detail, over the 24,000-byte budget on 4 of
92 decisions; removing redundancy — `setPriors` for the active opponent, which its exact
surviving joint sets already describe, and a `possibleUnrevealedMoves` list duplicating
`setPriors.moves` — plus consolidating the glossary brought the peak to 23,342 bytes with
none over budget. The margin remains thin by design: the detail ladder is what covers it.

## Fourth live battle — `battle-gen9randombattle-2685609311`

Lost in 20 turns, 24 decisions. The operational fixes held: 24 of 24 API calls succeeded, with
no timeouts after raising `JEV_TIMEOUT_MS` to 6,000 and no invalid responses.

The switching loop did not stop, and got worse: **12 of 20 voluntary choices were switches**,
nine of them switching out a Pokémon that had arrived the previous turn. Turns 6 to 10 ran
Torkoal to Victreebel to Heatran to Victreebel to Torkoal to Victreebel without attacking once.

The previous round's fix was an information fix — `ourActiveJustSwitchedIn` — and it did not
work. That flag was `true` on every looping turn and the model switched anyway. Nor was this an
evaluation gap: turns 9, 10, 12, 13, 14 and 15 all carried full damage, threat and matchup
numbers with no `estimatesUnavailable`. Only turns 7, 8, 19 and 20 were blanked, by Raging
Bolt's `protosynthesisspa` volatile. The information was present and was not acted on.

So this one is not left to the model. `cyclicSwitch` recognises the shape — a Pokémon that only
just arrived, still facing the opponent it was sent in to answer, switching again — and the
decision loop skips it, taking the provider's next-ranked action rather than substituting a
choice of its own. Replaying the battle's own states through the guard, it would have skipped 7
of the 12 switches, breaking the runs at turns 4, 6 to 9, 12 and 14 while still allowing the
five where the opponent had changed or the Pokémon had settled in. That is an estimate, not a
result: skipping turn 6's switch changes every state after it, so a live battle will differ.

Whether this improves play is unverified. It prevents a specific provable waste of turns; it
does not make the remaining choices better.

Payload peak is 24,373 bytes, over the 24,000-byte budget on 4 of 117 decisions across four
battles. Those four fall to the reduced tier, which peaks at 22,138 and still describes every
action with every damage estimate intact — that is the ladder working as designed rather than a
defect. The full tier is no longer expected to fit on the busiest turns, and shaving prose to
force it there is not worth the loss of the caveat text.

## Stalling, PP and Protect

Added after the fourth battle, none of which the payload previously represented at all:

- **End-of-turn balance.** `residualsPerTurn` totals Leftovers, Black Sludge, burn, poison,
  Leech Seed, Salt Cure, Sandstorm and Grassy Terrain, with Magic Guard and the type immunities
  applied, and `survivalIfWeStayIn` turns that into how many more turns a Pokémon lasts against
  the worst incoming damage. A burn exactly cancels Leftovers; a Steel type ignores Sandstorm;
  Magic Guard leaves only the healing.
- **PP.** Ours from the private request, which needed `maxpp` adding to the request type. The
  opponent's counted from observed uses against full PP Ups, excluding moves called by another
  move, which spend none. Our own Pressure doubles their cost.
- **Protect.** Success falls to a third for each consecutive protect — 1, then 0.333, then
  0.111 — and resets on any other move or on switching. `endOfTurnSwingPercentOfMaxHP` says
  whether spending the turn actually gains ground.

Two defects were caught while building this. Replaying an older log crashed on `moveUses` being
absent, the same class of fault as the earlier `NaN` from a missing entry turn: state recorded
before a field existed, which also happens on a reconnect. Both now read as unknown rather than
failing, with a test for it.

The additions pushed the payload over budget on 26 of 117 decisions, with the reduced tier only
428 bytes clear — meaning a crowded turn would have fallen through to minimal, which drops the
switch matchups that such a turn most needs. Rather than shaving prose a fourth time, the
glossary now explains only the sections a payload actually contains and collapses below full
detail to the caveats that change how a number is read. Full peaks at 25,187 bytes over 11 of
117 decisions, and reduced at 18,816, leaving real headroom.

## Bottleneck analysis over 117 decisions from four battles

Measured rather than estimated, by replaying every logged state through the feature layer:

- **Staying in to die is the dominant loss.** On 29 turns the payload reported a guaranteed
  incoming knockout with no faster knockout of our own. A surviving switch-in existed on 21 of
  them, and it stayed in on 18 — twelve of those with as many as five surviving alternatives on
  the board. The information was present every time.
- **The features are not driving the decision.** Median top probability is 2.45 times uniform
  and median stated confidence 0.30. Even where it takes a guaranteed knockout, which it does on
  16 of the 21 turns one is offered, it barely prefers it. Four of the five misses were switching
  away from a knockout.
- **A quarter of turns had no damage estimate at all**, 23 of 29 caused by a Substitute, because
  damage declines on any volatile.

The two switching pathologies are mirror images of one another — switching when it should not,
and not switching when it must — and both come of the numbers being available and unused.

## Strategic features added

Seven gaps, each verified absent from the code before being built:

- **afterItsStatChange** projects a move's own stat change one step: Dragon Dance on Haxorus
  goes from 63% to 94.4% best damage and outruns the opponent afterwards. The same projection
  shows what a self-lowering move costs the next hit.
- **ifTheStatusLands** prices a status by what it blunts. Will-O-Wisp on Haxorus takes the worst
  incoming from 54.8% to 27.2%; paralysis reports the speed relation and the 25% full-paralysis
  chance.
- **defensiveTera** evaluates our own Tera for what it stops. Gyarados against Raging Bolt goes
  from 172.9% incoming to 43.3%, turning a guaranteed knockout into a survivable hit.
- **hazards** price a hazard move by how many opposing Pokémon are still to come in and what each
  revealed one takes on entry; removal reports what it clears from each side.
- **endgame** reads past the active pair. On the turn the third battle switched to Darkrai, it
  reports Darkrai beating nothing revealed and losing to both, while Furret beats both and loses
  to neither — the read that was missing.
- **opponentChoiceLock** names the move a Choice item would have locked them into, with the
  probability from the candidate items still compatible.
- **Sleep Clause** is enforced, so a second sleep move is no longer offered as if it worked.

Two defects were caught while building these. Hazard values read through by move ID while the
tracker keys hazards by display name, so every Stealth Rock was priced at zero. The endgame
matrix varied only the attacker's sets, so our own attacks tried to build the opponent with no
set at all and produced nothing.

Feature build time is now a median of 14 ms, 49 ms at the 90th percentile and 158 ms at worst,
against a 6-second decision budget. Full detail peaks at 26,783 bytes and is over budget on 32
of 117 decisions; those fall to the reduced tier, which peaks at 19,438 with 4.5 KB to spare.

Whether any of this improves play is unverified. It closes gaps in what the payload can express;
the evidence above is that expressing something is not the same as it being used.

## Fifth live battle — `battle-gen9randombattle-2685822206`

Lost in 15 turns. Reported as a clear improvement in play, with one specific miss: on turn one,
Meloetta had Relic Song available and spent its Tera on Close Combat + Tera Fighting instead.

Relic Song changes Meloetta into its Pirouette form, which is Normal/Fighting with 51 more base
Attack and 38 more base Speed — the same Fighting typing the Tera was spent on, reached without
spending it. Nothing in the payload said so: the move looked like a 75 base power Normal attack.

`changesOurForme` now projects it, driven by the dex's own `requiredMove` rather than by naming
Relic Song, so it covers any such move. On the exact turn that went wrong it reads:

    Close Combat + Tera Fighting    84.1% damage, Tera spent
    Relic Song                      37% damage now, becomes Meloetta-Pirouette (Normal/Fighting),
                                    best damage 56.3% -> 124.2%, Tera still available

Four species in the dex change form through a move; only Meloetta and Rayquaza appear in random
battles, and Mega Rayquaza does not exist in Gen 9, so Meloetta is the case that matters. Keldeo's
Resolute form is cosmetic.

Building it needed the stat fitting extracted from `buildPokemon`: a form recomputes its stats from
the same spread against different base stats, so the projection uses our real fitted spread rather
than assuming one. A Pokémon whose private stats never arrived returns no projection instead of a
guess.

## Sixth live battle — `battle-gen9randombattle-2685826711`

Lost in 19 turns, reported as a clear improvement with two gaps.

**Terapagos.** On turn 8 it Terastallised into Tera Stellar. Every move on that turn had no damage
estimate at all, because `supportedState` excluded any Pokémon whose *Tera type* was Stellar —
a latent property that changes nothing until it is used. Terapagos carries it from turn one, so
every Terapagos turn was blank. Lifting that, and the volatile that blanked the same turn, brought
the estimates back.

Terastallising Terapagos is a form change rather than a type change: Terapagos-Terastal has Tera
Shell, which halves every hit while it is at full health, and Terapagos-Stellar does not. The
calculator models this correctly but only when the species changes, so `teraChangesOurForme` now
projects it. On the turn in question it reports incoming going from 36.3% to 89.1% for 7.6% more
damage of our own — a trade that was invisible when Tera was treated as a type change.

**Stalling.** Wish, Healing Wish and Lunar Dance set a slot condition, and none of it was tracked.
A Wish heals whoever holds the slot when it lands, which is what makes passing it to a switch-in
possible; a Healing Wish restores whatever comes in after its caster faints. Both are now tracked
from the moment they are set and described at the point of choosing them. Toxic was reported at its
first tick regardless of how long it had been in place; the counter is now tracked, restarts when a
Pokémon leaves the field, and feeds the Protect calculation — a Protect behind an escalating toxic
now reports gaining ground, where a flat one reports a wash.

Coverage improved as a side effect. Volatiles were vetoing damage as a class; they are now checked
against an allowlist of ones that provably leave a calculation alone, with Slow Start modelled
through `abilityOn` and the Booster Energy boosts of Protosynthesis and Quark Drive applied directly
because the calculator models neither. Blank turns fell from 22% to 15% of 161 decisions, and what
remains is only a Substitute, which needs the substitute's own HP to model, and a transformed Ditto.

Two things worth recording about the fixes themselves. The volatile check is an allowlist rather
than a denylist, because being wrong there produces a confident wrong number rather than a missing
one. And a rounding asymmetry was found while testing: a sixteenth gained showed as 6.3% and a
sixteenth lost as 6.2%, since rounding half away from zero is not symmetric in JavaScript.

## Seventh live battle — `battle-gen9randombattle-2685834880`

Lost in 31 turns. Recovery decisions were reported as good — the Wish and Recover work holds up.
Two problems, one of which had a deeper cause than it appeared.

**Magic Bounce defeated its own warning.** Toxic Spikes was used into Hatterene on turns 16, 23 and
24, putting two layers on our own side. Magic Bounce was already checked for, and every sampled
Hatterene carries it, so the warning should have been there on all three turns. Three separate
defects stopped it:

- Showdown reports a reflected move as the *opponent* using it, and the tracker recorded it as
  evidence of their set. Hatterene's revealed moves therefore contained our own Toxic Spikes, which
  matched no role, which collapsed the inference — and with it every ability-based warning,
  including the one about Magic Bounce. Moves arriving with a `[from]` are now only recorded when
  the caller picks from the user's own move set, such as Sleep Talk or Instruct.
- A revealed ability was ignored. The ability checks consulted generation frequencies and candidate
  sets but never the ability we had actually seen, so Magic Bounce stayed a possibility on turns 23
  and 24 even though it had been revealed on turn 22. A revealed ability now settles the question in
  both directions, confirming a match and ruling out the rest.
- Being reflected was filed under accomplishing nothing. It is worse than nothing: the hazard lands
  on our side. It now says so, and `hazardValue` reports the move as reflected rather than pricing
  it as an investment.

**Endgame switching.** On turn 30 it switched an 18.6% Forretress into a healthy Skarmory, losing it
for nothing. The payload was not at fault and no guard would have caught it: staying in was 98.9%
incoming against every sampled set and the switch-in was knocked out on entry, so both options lost
a Pokémon. Staying in was better only because it would have traded 37 to 44.7% damage first, which is
a judgement rather than a provable error. The choice was made at 0.13 confidence against 0.167
uniform — below uniform, which is the discrimination problem rather than a missing feature.

What *was* provable showed up in the measurement: across the logs there are **nine** turns where it
switched into a replacement that every sampled set knocks out on entry while another replacement on
offer would have survived. That is strictly dominated, and `doomedSwitch` now skips it, taking the
provider's next preference as the cycle guard does. It fires only when a surviving alternative is
among the switches actually offered, so sacrificing a Pokémon deliberately when nothing survives is
left alone.

*Later withdrawn:* the runtime stopped applying this guard, because a sacrifice can be deliberate
even when another replacement survives (see `MECHANICS-AND-TEAM-TACTICS.md`, "Sacrifices and
pivots"). `doomedSwitch` has since been deleted, and `knockedOutOnEntry` is left for the model
to weigh.

## Eighth live battle — `battle-gen9randombattle-2685841138`

Lost in 23 turns. Three problems reported; one turned out not to be a gap at all.

**Belly Drum was invisible.** Cetitan's Bulky Setup role is built around it, and the bot used Ice
Shard on all five of its turns. Belly Drum carries its effect in code rather than in data — the dex
exposes no `boosts` for it — so `moveEffect` reported nothing but accuracy and the setup projection
never ran. It is now described, along with Tidy Up, Take Heart, Haze, Heal Bell and Trick, which
have the same problem. Belly Drum against that Espeon projects best damage going from 52.5% to
207.4% and knocking it out, leaving us at half health and still surviving the reply. An audit of
every status move in the randbats pool found these; the rest were already covered.

**Weather was not treated as setup.** Walking Wake carried Sunny Day and Hydro Steam, which is the
entire point of the set: Hydro Steam is boosted in sun rather than weakened by it. Nothing connected
the two. `afterThisWeather` now projects it, reporting best damage going from 31.7% to 47.4% and the
best move becoming Hydro Steam.

**Tera was spent cheaply.** On turn 4 it Terastallised for a 10.3 percentage point gain that did not
turn anything into a knockout. `teraBuysUs` now states that directly on the Tera action — damage with
and without, points gained, and whether it changes the knockout verdict — instead of leaving it to be
found by comparing two separate actions. The same field shows a Water Tera on a Normal move gaining
exactly zero.

**Flamethrower over Hydro Steam was not a data gap.** The payload had Hydro Steam at 26.3 to 31.7%
and Flamethrower at 20 to 23.7%, correctly, for six consecutive turns. It picked the weaker move each
time with the right numbers in front of it, at confidences between 0.24 and 0.36. That is the
discrimination problem the bottleneck analysis measured, not something the feature layer can fix.

## Setup that never happens, and an ability audit

Plusle used Nasty Plot at 31% health against a healthy Espeon and fainted to it. The payload was not
silent — it reported the incoming attack as a knockout against every sampled set and survival of one
turn — but `afterItsStatChange` sat beside that saying the boost would knock the opponent out and
outrun it. Both were true in isolation and the combination was nonsense: stat changes are lost when
their holder faints, and a stat move deals no damage to prevent it. That projection is this project's
own feature arguing for the move, at 0.69 confidence, which is the highest of that battle.

It now carries `wastedBecauseWeAreKnockedOutFirst`, evaluated after the boost so that a defensive
boost which saves us is not wrongly flagged. The first version over-fired: Close Combat and Draco
Meteor were flagged for losing their self-penalty, which is not a loss and does not stop the attack
landing. It is now restricted to a move that buys a gain and deals no damage. Across the logs that is
25 offers and 3 taken. A status is treated differently, because it survives its user — it is only
marked as never going off when we would also move second.

An audit of the abilities asked about found the calculator already handles all of them, each checked
against it rather than assumed: Swift Swim, Chlorophyll, Sand Rush and Slush Rush double speed in
their weather, and our own speed path applies them; Sand Force adds three tenths in sand; Sheer Force
adds three tenths to a move with a secondary and nothing to one without; and Fairy Aura and Dark Aura
apply from either side, including from the defender, where the Aura boosts our own move of that type.
Protosynthesis and Quark Drive remain the exception it does not model, which is why their boost is
applied directly from the volatile naming the stat.

One reporting gap did come of it: Sheer Force trades the secondary effect away for that damage, and
the payload still advertised the secondary chance on a move that would not have one. It now says the
secondary is removed instead.

## Zero to Hero

Palafin came in on turn 1 of the seventh battle, attacked for three turns and fainted, never switching
out. Zero to Hero transforms it on switching *out*, and it returns with base Attack of 160 rather than
70 — so switching is a gain there, the opposite of how every other field prices a switch, and nothing in
the move list or the ability name says so. `switchingOutTransformsOurActive` reports it: against that
Weezing it is best damage going from 40% to 75.6%, incoming falling from 64.5% to 51.7%, permanent, and
costing nothing but the switch itself. It reports nothing once the transformation has happened, for an
ordinary Pokémon, or when the ability is suppressed.

Eighteen species in the dex are gated behind an ability, but Zero to Hero is the only one triggered by
switching out; the rest fire on weather, on HP, on being hit or on the move being used.

## Ninth live battle — `battle-gen9randombattle-2685879508`

Lost in 19 turns, six Pokémon to four. *Corrected 2026-09-23:* this was first recorded as a win, but the
log's `win` line names the opponent; the first actual win is `battle-gen9randombattle-2686041453`. Three things were reported; one of them was already
implemented and the report is better read as evidence about how the payload is used.

**A knockout that moves first.** On turn 9, Dodrio at 85% faced a Cinccino on 24%. Every one of its
four attacks was a certain knockout, and the payload said so along with the turn order for each:

    Quick Attack   priority 1    40.8%   all-sampled-rolls   ours-first
    Brave Bird     priority 0   121.2%   all-sampled-rolls   theirs-first

It chose Brave Bird at 0.25 confidence and Dodrio died to the reply and the recoil. Nothing was
missing: priority, damage, knockout verdict and turn order were all present and correct. The
dominance guard could not catch it because that guard requires equal priority — correctly, since
differing priority means differing turn order and raw damage is then not comparable. The lethal case
is the inverse relation: when both moves knock the target out the extra damage is surplus and
priority decides, so it is now checked separately. Replayed across all ten logs it fires on exactly
this turn and no other.

**Substitute and Shed Tail were barely described.** Both reduced to `userVolatile: substitute`, with
no cost, no shell size and, for Shed Tail, nothing about the shell being handed to the Pokémon coming
in — which is the whole point of the move. They are now priced by whether the shell survives their
best sampled hit. On the turns in question Enamorus's shell would have been exactly 61 HP against a
61 HP attack, and Orthworm's Shed Tail would have left it at 5.6% with a shell facing a hit of 692:
both break at once, which is what the payload now says.

**Calm Mind was already implemented.** On turn 12 it projected best damage going from 83.1% to 124.7%,
knocking the opponent out, outrunning it afterwards and surviving to use it. It chose Moonblast, which
did not knock the target out. That is the discrimination problem rather than a missing feature, and it
is the fifth report to resolve that way.

`node scripts/inspect-battle.mjs logs/<file>.jsonl` prints the deductions, the choices
and the model's confidence against uniform for any recorded battle, and
`… turn <n>` prints one turn's full payload. Exclusions already recorded in a log carry
over, so a replay shows the evidence as it stood at the time.

Neither live battle was won, and neither validates playing strength or inference
accuracy across all sets. Hidden-state inference remains partial: the eliminations are over sampled sets
rather than a calibrated posterior, generation frequencies are marginal rather than a
model of opponent choice, and unseen team members are still unrecovered.

Local detailed battle records are in the ignored `logs/` directory. They contain
private team information; the summary above omits player names and teams.

## Discrimination, Substitute and payload audit — 2026-09-22

The decision instructions are now versioned (`2026-09-22-discrimination-v1`) and
explicitly cover survival, turn order, execution risk, setup/status warnings,
endgame, switch costs, Substitute and guards. Production starts at reduced detail;
full detail is diagnostic only. The emergency representation preserves damage,
switch matchups, turn order, setup warnings and endgame. Successful API decisions
record the instruction version, chosen detail tier and payload bytes.

A conservative dominated-move guard follows Jev's next non-guarded preference and
records its override separately from switch guards. It compares every modeled set,
requires equal priority/accuracy/relevant effects/Tera cost and no PP disadvantage,
and declines when coverage or PP is unknown. A stronger damage alternative is also
explicitly named in the payload, alongside actual secondary effects. In particular,
the six Flamethrower/Hydro Steam turns were **not strict dominance**: an unstatused
Sylveon could still be burned. The new prompt can weigh this tradeoff; the guard does
not erase it. No historical chosen move met the strict guard in the offline audit.

Substitute HP starts at floor(max HP / 4), stays an interval after uncertain hits,
and is cleared on break or switching out. Explicit Baton Pass/Shed Tail transfers
retain or conservatively bound the donor's HP. Attacks report shield damage and
break verdicts separately from holder HP: single-hit excess does not spill through,
and sound/Infiltrator bypass normally. Unmodeled hits widen uncertainty. Older logs
lack the new HP tracking, so their substitutes use a conservative remaining-HP range.

The contradiction fixes cover lethal hits before end-of-turn healing, zero future
hazard entries in a last-Pokémon matchup, trapping information, conditional execution
warnings, and forced replacements versus forced pivots. A fainted Pokémon's replacement
is not charged an attack on entry; a fast pivot can still face a pending action.

Validation:

- **172 unit tests pass**, including runtime guard overrides, preserving burn/accuracy/PP
  tradeoffs, critical-hit uncertainty, Substitute breaks/bypass/transfers, hazard value,
  survival ordering, trapping and emergency-payload essentials.
- **Three full simulator battles:** 357 decisions, 164 turns, zero rejected choices.
  The mocked-Jev battle contained 68 calls and 62 switch-matchup payloads; largest
  request was 23,979 bytes. This is an integration test, not a strategic benchmark.
- **Dedicated simulator Substitute test:** four true-HP checks stayed inside inferred
  intervals; Psychic Noise bypassed without changing the Substitute's actual HP.
- **225-decision offline replay:** 222 reduced requests, 3 emergency requests, zero
  over budget; peak 23,986 bytes. All 19 offensive Substitute situations produced
  damage features. There were 25 chosen attacks with a stronger immediate-damage
  alternative and 27 choices with a conditional KO-before-action warning.
- **214 retained distributions:** median top-probability/uniform ratio 2.45, minimum
  1.2; none invalid. Seven executed choices differed from Jev's original choice
  because of guards. The top probability and executed-choice probability are different
  quantities. PP was unavailable in reconstructed requests for 119 decisions.

The reproducible machine-readable audit is `docs/DECISION-AUDIT.json`. Run
`node scripts/audit-decisions.mjs` after building; it uses current code and set data
against retained states, with requests reconstructed from legal labels and tracked PP.
It makes no API calls. No new live battle or paid model comparison was run for this
change, so improved discrimination or win rate remains unmeasured. General opponent
policy modelling was deliberately deferred.

## Seventeenth live battle — `battle-gen9randombattle-2686220008`

Lost in 28 turns, six Pokémon to two, on instructions `2026-09-23-coverage-v2`. Four things were reported.

**Close Combat into a Ghost type.** Terrakion held a Choice Band, so after its first Close Combat that was the
only move on offer. On turn 4 Sinistcha came in, and the payload said plainly that it takes nothing from Close
Combat, by type immunity, for every sampled set. Jev stayed in anyway, at 38% against 35% for switching. The
number was present and unused, so this is now a guard: `lockedIntoImmunity` skips a lone offered attack that the
target is certainly immune to, whenever some switch survives its entry, and takes Jev's next choice. Replayed
over all 17 logs it fires on four decisions, all the same mistake, including a Choice Band Perrserker into
Pecharunt in the third battle; it would have changed only this turn 4, since Jev switched on the others. Our own
lock is now stated as `ourChoiceLock`, beside the opponent's. Turns 15 and 16, Close Combat into Munkidori, were
a quarter damage but still 25% each; staying to chip is a judgement and is left alone.

**The obvious switch-in.** On turn 1 Ogerpon had to leave Glastrier, and Jev sent in Hoopa, which took 88%.
Measured the old way, against the worst move Glastrier could pick against each switch-in, Hoopa was the only one
no sampled roll knocked out, so the choice followed the payload. But the opponent chooses before it sees a
switch, and it chose Icicle Crash, the move aimed at the Grass type. Magearna resists it. The payload now names
`switchTurnAttack`, the attack aimed at our active, and gives each switch `takesSwitchTurnAttack`: 21–37% for
Magearna against 57–100% for Hoopa. The worst case stays beside it for when they anticipate the switch.

**No Tera.** Correct in this battle. The Tera types (Ground on Terrakion, Electric on an Electric Arceus, Fairy on
Oinkologne, Water on Magearna) never turned a survival into a knockout or saved a Pokémon; the largest gain,
Earthquake +43 points on turn 14, came when Close Combat was already a certain knockout.

**Hoopa over Magearna or Arceus.** The same turn-1 switch, above.

Cost: the new fields and one instruction sentence moved 27 of 464 replayed decisions from the reduced to the
minimal tier. The minimal tier, described in the code as an emergency fallback, now carries 253 of 464 (55%) at the
28,000-byte budget; at 32,000 it carries 18 (4%).

## Tera forms: Ogerpon and Terapagos

Terastallising was priced as a type change for everyone, which is wrong for two Pokémon. Ogerpon takes its Tera
form and Embody Aspect raises a stat at once, by mask — Speed (Teal), Attack (Hearthflame), Special Defense
(Wellspring), Defense (Cornerstone) — and it applies to that turn. Terapagos becomes Terapagos-Stellar, 160 base
HP and 130 Special Attack, and loses Tera Shell. `afterTerastallizing` now builds that Pokémon, and the Tera
action's damage, turn order and `defensiveTera` all use it; `teraAlsoRaises` names Ogerpon's boost. Teal Ogerpon's
Tera now turns a Dragapult matchup from theirs-first to ours-first, and a 60%-HP Terapagos takes 40% instead of 55%
once it is Stellar.

Checking this found that the calculator re-applies Download and Embody Aspect on every calculation, as if the
Pokémon had just switched in, so a Pokémon that had really triggered either was counted twice: a Terastallised
Hearthflame Ogerpon hit for 2.7x its plain damage instead of 2x. The calculator is now kept from applying them, and
each is applied once where it happens — from the log, on entry, or on Terastallising. Intimidate, Intrepid Sword
and Dauntless Shield were never affected; the calculator applies those only on a flag this code does not set.

## Eighteenth live battle — `battle-gen9randombattle-2686228211`

Lost in 26 turns, six Pokémon to five: their Crabominable was left on 72%. Reported as the best battle so far,
with caveats. Reviewed before hearing them.

**What held up.** Switching Stonjourner out twice with Girafarig on 28% was right: Stonjourner was slower and
Girafarig's Psychic knocked it out at every sampled roll, while Stone Edge moved second and only might knock out.
On turn 22 Ursaluna stayed in at 24% into a certain knockout, which bought Spectrier a free entry at full HP rather
than an Ice Hammer on the switch.

**Tera was spent without its cost in view.** On turn 14 Lurantis Terastallised to Fighting to make a likely
knockout on a 28% Girafarig certain — a concrete gain, as the instructions ask. Two costs were invisible. Tera
Fighting doubled Girafarig's Psychic, 39.8% to 79.6% worst case, because the new type is in place before the
opposing move; `defensiveTera` only ever reported improvements, and now reports this as
`makesUsWeakerToTheirAttack`. And Tera was gone for Spectrier, whose Tera Blast is only Fighting-type after
Terastallising: against the Crabominable that won the game it would have done 42–74% and then 62–110%, against
Shadow Ball's 21–37% and 31–55%. The payload now names such teammates in `teraIsAlsoNeededBy` while Tera is
still available.

**A random move on turn 19.** Jev's reply summed to 0.99, which the validator rejected by a floating-point hair,
so the turn went to the random fallback. The only other rejection in 18 battles was a 0.23 choice against a 0.24
action. Both are now repaired and recorded as `responseRepaired` rather than discarded: a distribution within 0.05
of one is rescaled, and a choice within 0.05 of the most probable action stands. Larger departures still fail.

At the 32,000-byte budget this battle sent 7 of 31 decisions at minimal; the replay over the earlier 16 battles is
unchanged by these additions at 446 reduced and 18 minimal.

## Nineteenth live battle — `battle-gen9randombattle-2686231644`

Lost in 29 turns, six Pokémon to two, against a team built on pivots: U-turn on Sneasler and Meowscarada, Flip
Turn on Dewgong, Volt Switch on Miraidon.

**Their double switches.** From turn 5 to turn 8 they swapped Dewgong and Excadrill every turn against Rotom-Heat,
each taking the attack the other was weak to: Excadrill the Electric moves, Thick Fat Dewgong the Overheat. Rotom
alternated Discharge and Overheat into each switch and fell to -4 Special Attack. The same swap caught Choice Band
Rayquaza on turn 14. Nothing recorded the opponent's switches, so there was no pattern to see, and 22 of 35
decisions went at the minimal tier, which drops `ifTheySwitch`. The tracker now logs every entry with what it
replaced, what it faced, and whether it was a free replacement, a drag or a pivot; `opponentSwitching` reads it
back at every tier, naming where they have gone from the Pokémon now out and pricing our moves into that arrival.
Replayed, turn 6 would have read Discharge 0% and Overheat 38–69% into Excadrill; turn 14, Dragon Ascent 54–64%
against Earthquake 30–36% into Dewgong.

**Our own switching war.** From turn 17 to turn 22 we switched five turns running while they did the same, and every
entry paid a hit: Flutter Mane 36 to 22 to 9, Rotom-Heat 56 to 30 to 4, Latios 37 to 7. The cycle guard never fired,
correctly by its own rule, since the opponent changed every turn. `opponentSwitching` now carries
`weHaveSwitchedOnEachOfTheLast` beside their streak, and the instructions say what it costs.

**Tera on turn 4 was right.** Rotom-Heat faced a certain knockout from Dewgong's Water attack; Tera Electric removed
the Fire typing and halved it. Excadrill had not been revealed, so the switch into it could not be seen.

**A correction to earlier entries.** At the reduced and minimal tiers — everything production sends — the glossary is
cut to its two essential entries, so per-field glossary text reaches Jev only in diagnostic full-detail payloads.
The stale doomed-switch sentence noted on 2026-09-23 therefore never reached live decisions, and field meanings
that matter live have to be carried by the instructions.

Budget: reduced payloads across all 563 logged decisions have a median of 29,088 bytes and a maximum of 35,342, so
36,000 bytes would keep every one of them out of the minimal tier; at 32,000, 12% fall to it. The instructions
alone are 11,091 bytes.

## Twentieth live battle — `battle-gen9randombattle-2686236942`

Lost in 13 turns, six Pokémon to three, reported as a rout in which Jev still chose well. That holds for all but one
decision.

**The matchup and two misses.** Rillaboom at +2 behind Grassy Glide, which has priority in Grassy Terrain, moved
first against everything we had and took Oricorio, Camerupt, Medicham and Flygon. The one chance to stop it was
Oricorio's Hurricane on turn 5, a possible knockout at 70% accuracy, and it missed. Focus Blast on turn 2 was right
though it missed: a certain knockout on Iron Bundle at 70%, against Thunderbolt's 87–103% that only sometimes
knocked out. On turn 7 Overheat against Will-O-Wisp did not matter, since Camerupt fell to a 225–265% Wood Hammer
before acting; the 36% Rillaboom lost was its own recoil and Life Orb. On turn 12 the payload showing Knock Off
level with Drain Punch was correct: Iron Boulder's Booster Energy was already spent, so Knock Off had no item to
boost it, and Iron Fist Drain Punch matched it while healing.

**Tera for surplus damage.** On turn 8 Medicham chose Close Combat with Tera Fighting although plain Close Combat
already knocked Rillaboom out at every sampled roll and Terastallising changed nothing about the hit it faced. The
instructions forbid exactly that, so it is now a guard: `redundantTera` skips a Tera version whose plain move is
already a certain knockout on the current target, when Terastallising does not lower the damage we take this turn,
and never for Ogerpon or Terapagos. Replayed over all 20 logs it changes three decisions, and the two older ones
were worse than wasted: Moonblast with Tera Fairy would have raised the worst hit on us from 102.5% to 220.7%, and
Close Combat with Tera Fighting from 33.5% to 68.8%.

## Battles twenty-one and twenty-two — `2686254330`, `2686322376`

Lost six to five in 22 turns against daravoth, and six to two in 51 turns against Danksss.

**Stalls.** From turn 6 to 22 of the second battle Registeel paralysed each of our Pokémon with Thunder Wave, then
outsped them with Iron Head. Gothitelle used Thunderbolt seven times while Registeel went from 88% to 84% and
Gothitelle from 64% to 17%, and Lokix picked U-turn three turns running without ever moving. Later Klefki used Play
Rough sixteen times into Roost: Fezandipiti went from 39% to 52% while Klefki went from 100% to 35%. The only
no-progress signal, `repeatedMoveWhileDraining`, fires only when switching would cure a drain on us, which was never
the case. The tracker now records each pairing's HP when it met, and `thisMatchupSoFar` reports both sides' change,
with `theyAreNotLosingGround` when they have lost at most 5% net while we lost 10% or more.

**Flinching.** Turn-loss risk counted paralysis but not a faster opponent's flinch. `flinchRisk` names the flinching
moves of an opponent that moves first, with the chance we act at all if it uses the worst of them: 52.5% for a
paralysed Pokémon facing Iron Head. The instructions now say a switch cannot be lost this way.

**Gale Wings.** Its priority was treated as unknown, but it depends only on full HP, which is public; Talonflame's
Flying moves now carry +1 at full HP and none below it.

**Tera again.** On turn 2 of the first battle Carbink took Tera Fighting for 27 points of Body Press, with no
knockout, while the payload showed it doubling Hoopa-Unbound's Psychic from 49.6% to 99.2%. `redundantTera` now also
skips a Tera attack that buys no certain knockout and makes us weaker to the incoming hit. Over all 22 logs the guard
changes six decisions, every one Tera Fighting on Body Press or Close Combat or Tera Fairy on Moonblast.

Reduced payloads now reach 35,829 bytes; at 32,000, 15% of decisions fall to the minimal tier, and at 36,000 none do.

## Lookahead search — poke-engine

Jaxcalibur, the bot that reached #1 on the Gen 9 Random Battle ladder, did not release its code or weights; its
author credits most of its strength to a network trained on about 100 million self-play games and 100–150 Elo to
search over sampled worlds. The search half is buildable here. poke-engine, the MIT-licensed Rust engine behind Foul
Play, supports Gen 9 and Terastallisation, loads any position from a string, and ran 635,000 Monte Carlo iterations
per second on this Mac. `src/search` converts our tracked battle into its format one sampled world at a time — our
exact stats, moves and PP; one candidate set per revealed opponent; a random pool species for each unrevealed slot —
and restricts our options to the request, including Choice locks, disabled moves, trapping and a spent Tera. First
Impression was at first offered after Lokix's first turn, because the last action was not passed; it now is.

On the known misplays, search disagreed with Jev every time, in plausible directions: plain Body Press over Carbink's
Tera; a switch over Klefki's sixteenth Play Rough into Roost; Knock Off, which removes Leftovers, over Lokix's lost
U-turns. Rankings were stable across repeated runs, with near-ties swapping. Over the 168 move decisions of the last
six battles its top choice differed from Jev's in 77% of them; a 50/50 blend changed 28% of decisions and fixed one of
the six misplays, and a 70/30 blend in favour of search changed 53% and fixed four. Sixteen worlds of 100 ms took a
median of 369 ms. `SEARCH_MODE` is off by default; whether blending improves results can only be settled live.

## First battle with search — `battle-gen9randombattle-2686382438`

Lost six to five in 21 turns against Blackft, with `SEARCH_MODE=blend` at weight 0.7; only their Tera Electric
Miraidon, at 91%, was left. Against Blackft only the one win took more. Every decision was searched, 16 worlds in a
median of 407 ms, and whole decisions took a median of 1.2 seconds. Blending changed 6 of 26 decisions. On turn 7 it
played plain Earthquake over Jev's Earthquake with Tera Ground into Flutter Mane: Wyrdeer is part Normal and immune
to Shadow Ball, and Tera Ground would have given that up. The engine's win estimate fell from about 0.55 to 0.21 when
Virizion arrived and to 0.002 against Miraidon at the end.

**The Tera guard was too strict.** On turn 4 it skipped Facade with Tera Normal because Tera bought no *certain*
knockout and made Flareon weaker to Fighting. But Tera turned Facade from no knockout chance (61–73%, and it did 68%)
into a possible one (92–109%) — a real gain, left to judgement now. The rule skips only a Tera that improves no
knockout odds at all; all six earlier cases are still caught.

**Payload size.** Search adds its instruction and a verdict per action, and half of this battle's decisions went at the
minimal tier under the 32,000-byte budget; the largest reduced payload was 34,459 bytes. 38,000 leaves room across all
logged battles.

## Second battle with search — `battle-gen9randombattle-2686385506`

Lost six to three in 22 turns against Blackft, blend at 0.7, every decision at the reduced tier under the new
38,000-byte budget. Blending changed five decisions, and two were clearly good: Rapid Spin on turn 11, at 79% in the
search, cleared both Stealth Rock and Sticky Web, and on turn 8 the search's replacement, Morpeko, knocked Piloswine
out with Knock Off the next turn.

**The converter left Protect's counter at zero.** Morpeko-Hangry used Protect on turns 14, 15 and 16 against
Mamoswine, for Leftovers alone, and fell when the third failed. The search voted Protect at 52–54% each time because
the engine was never told how many had come before, and treated each as certain. It is now passed, along with a
pending Wish; with the true count Protect falls to 15% on turn 15 and out of the top three on turn 16, with Knock Off
first. The guard also skips a third Protect in a row whatever it would gain: it succeeds one time in nine. An older
test allowed a fifth consecutive Protect because it gains ground when it works; at about 1% it almost never does.
Across all logs the widened guard changes seven decisions, including Garganacl's Protect runs in earlier battles.

**Crash damage was never described.** Zebstrika used Supercell Slam on turns 20 and 21 into Alomomola, which Protected,
and lost half its HP each time. Crash moves now state it, and when the target has Protect among its plausible moves the
payload says the move would crash — certain here, since Alomomola had revealed it.

## Third battle with search — `battle-gen9randombattle-2686389183`

Lost six to two in 22 turns against Blackft. From turn 12 Clawitzer, locked into Aura Sphere by Choice Specs, used it
seven times into a Calm Mind, Rest and Sleep Talk Suicune: each hit did less as Special Defense climbed to +5, Suicune
Rested from 22% back to 90% on turn 16, and Clawitzer fell on turn 18. The answer was Garganacl's Salt Cure, which takes
a quarter of a Water type's max HP every turn and which no boost or Rest removes, brought in while Suicune slept.

Four things kept that line out of view:

- **Salt Cure was priced as its hit.** Garganacl's switch showed Salt Cure at 10–12%. The move and any switch-in that
  carries it now state the chip: 25% a turn against Water and Steel, 12.5% otherwise, until they switch.
- **Sleep Talk was ignored.** A sleeping Pokémon counted as losing its turn although Suicune had Sleep Talk, and the
  switch-in was shown Scald's full 122–145%. A Sleep Talk user now acts through it, with the moves it can call listed;
  when it is not yet revealed, the chance is weighed over the sets still possible — every random-battle Rest set here
  carries it. `whileAsleepItComesAtMostPercent` gives the chance the switch-turn attack really comes: 33.3% here.
- **Sleep turns spent on Sleep Talk were never counted,** because only a `cant` line advanced the counter, so a Rest and
  Sleep Talk user was modelled as never waking. The converter also wrote the engine's Rest counter one short.
- **The stall was flagged and ignored.** `theyAreNotLosingGround` was in the payload from turn 16. A guard,
  `lockedAndLosing`, now skips a Choice-locked attack once the pairing has lasted three turns with them at most 5% down
  and us at least 10% down, provided some switch survives entry. On this battle it fires on turns 16 and 17 only.

Search did not rescue it: it favoured switching to Garganacl from turn 18, and on turns 16 and 17 only tied it with Aura
Sphere at about 30%. Salt Cure pays off over four or more turns, past a 100 ms search's horizon of about two.

## Fourth battle with search — `battle-gen9randombattle-2686395755`

Won six to three in 21 turns against Blackft, with Cinderace's Pyro Ball finishing the last four. The flaw was turn 5.
Jumpluff, at 68%, used Sleep Powder into a 34% Volcanion whose revealed Flamethrower did 66–78% to it: a miss, one time
in four, would have lost Jumpluff on about 85% of rolls. Wyrdeer was a sure alternative. It takes at most 32% from any
sampled attack, so it survives the switch-turn hit and the next one, and its Earthquake knocks Volcanion out at every
roll. The payload's `endgame` already said "Wyrdeer beats Volcanion". The powder landed, but a quarter chance of losing a
healthy Pokémon bought nothing the switch did not.

Jev (36%) and search (52%) both ranked Sleep Powder first. Part of search's preference is its evaluation. poke-engine
scores a sleeping Pokémon at −25 for as long as it sleeps, with no sense of the one to three turns it actually lasts,
so "Volcanion asleep" looks nearly as good as "Volcanion knocked out" at the end of a two-turn search.

- **Guard, `needlessGamble`.** It skips a stay-in move that leaves at least a one-in-ten chance of losing a healthy
  active Pokémon (half HP or more) this turn, when some switch wins outright. There are two such moves: a status move
  that can miss, where a miss lets their revealed attack knock us out on half the rolls or more, and an attack that does
  not remove them before they act. "Wins outright" means the switch-in survives their worst sampled hit, and a second
  one if it is slower, then knocks them out with a move that cannot miss, at every roll, after their end-of-turn
  healing. It stays out when they are asleep or frozen, when either side is behind a Substitute, and for healing,
  draining, pivoting, Protect and status that cannot miss.
- **Instructions.** One sentence: a move that can miss is not worth staking a healthy Pokémon on while a switch-in wins
  outright, and `endgame` beats names who does.

Replayed over all 637 logged move decisions, the guard fires on 8 and changes the move played on 3. Each change is an
improvement:
- **This battle, turn 5:** Sleep Powder becomes the switch to Wyrdeer.
- **Victreebel:** Power Whip, which never lands because Arbok's faster Gunk Shot knocks it out 97% of the time, becomes
  Sucker Punch.
- **Dodrio:** Brave Bird becomes Quick Attack in the same position.

Also seen on turn 17: search's 76% on sending Magmortar in, flagged `knockedOutOnEntry`, outvoted Jev. Magmortar
fell, and Cinderace came in free to knock Phione out. That worked as a sacrifice, but it was search's call alone.

## Fifth battle with search — `battle-gen9randombattle-2686406515`

Won six to two in 35 turns against Blackft, the first battle with `needlessGamble` live; it did not need to fire. The
one costly turn was 15. Mienshao, Choice Banded into High Jump Kick, used it on a 29% Appletun. Blackft switched to
Hoopa, whose Ghost typing takes nothing from it, and Mienshao crashed to 50%. The payload already showed it:
- `ifTheySwitch` showed Hoopa taking 0 from High Jump Kick.
- `opponentSwitching` showed they had gone from Appletun to Hoopa before.

Jev put 88% on the crash move, split across its plain and Tera versions, while search preferred Excadrill at 44%. The
blend tipped to High Jump Kick, 0.344 to 0.326.

The same bait cost Zebstrika in an earlier battle (`2686385506`). On turn 20 Supercell Slam went into an Alomomola whose
known set carried Protect: it Protected, and Zebstrika fell to 24%. On turn 21 it clicked again, the opponent switched to
Mamoswine, and the crash knocked Zebstrika out.

- **Guard, `baitedCrash`.** It skips a crash move (High Jump Kick, Jump Kick, Supercell Slam, Axe Kick) when two
  conditions hold. They must see it coming: we are Choice-locked into it, it knocks their active out at every roll, or
  it is our hardest hit. And they must hold the answer: a revealed or near-certain Protect not used the turn before, or
  a healthy teammate immune to the move in every sampled set that they have switched to from this Pokémon, or brought
  in against ours, before. When the crash would knock us out, a second Protect in a row or any immune teammate from a
  switching opponent is enough. There must be another damaging move or a survivable switch to go to.
- **Instructions.** One sentence naming the reply opponents use against crash moves.

Requiring a history of that exact switch matters. Without it, the guard also fired on turn 14, where High Jump Kick
knocked Donphan out because Blackft let it fall rather than bring Hoopa in, and it would have given up that knockout.

Replayed over 672 logged move decisions, 14 with a crash move offered, it fires on 4 and changes the move played on 3:
Mienshao turn 15 and Zebstrika turns 20 and 21. On each of the three, the opponent made exactly the predicted reply.

## Ladder battle `2686434361`: Keldeo endgame, and a coverage bug

Lost to lobocba865. On turn 19, Clefable (32%, our last Pokémon) faced a 17% Keldeo-Resolute, which had Terastallized
Water, not Steel, and still had two unrevealed teammates. Moonblast was a certain knockout (34–41%). Search put 78% on
Moonlight and outvoted Jev's 60% on Moonblast, even though both values were near a certain loss (0.105 against 0.052).
Keldeo is faster, and its Hydro Pump takes 54–64% a hit, more than Moonlight's 50%, so the heal could only postpone
the same knockout. Air Slash made Clefable flinch that turn, so the choice changed nothing here.

- **Guard, `healingOverAKnockout`.** It skips a fixed-amount heal when a move that cannot miss knocks their active out
  at every roll, the heal has no more priority than that move, and their strongest revealed attack's smallest roll is
  at least what the heal restores. Over 862 logged decisions it changes one move: this one.
- **Bug fix, `coveredProbabilityMass`.** Coverage was measured against the prior's total instead of the sets still
  possible. Evidence narrows the opposing sets in 54% of logged decisions, and every one of those turns labelled its
  damage estimates partly covered (1,133 estimates) although every remaining set was modelled. Jev was told to
  distrust certain knockouts, and the guards that require full coverage stood down. After the fix, no logged estimate
  is partial.

## First ladder run, reviewed

Ten ladder battles, reviewed without numbers 3 and 4. Number 2 was the unplayed game, so seven had data: 5–2, 5.0 knockouts
dealt and 3.7 taken per battle, rating 1040 → about 1110.

- **Search overruled Jev on noise.** It overruled Jev on 40 of 182 decisions (22%). The median lead in its own score was
  0.035, and 18 of the 40 were below 0.03, which is within its run-to-run noise. Three of them gave up a certain knockout
  for Recover, Calm Mind or Moonlight. Blend now overrules Jev only with a lead of at least `SEARCH_OVERRIDE_MARGIN`
  (default 0.03); below that, Jev's choice stands and the blend still ranks the alternatives for the guards.
- **Healing stalls.** Gurdurr attacked a Roosting Illumise for twelve turns (100% → 13%), and Rhyperior's Stone Edge
  watched Skarmory Roost from 26% to 87%. The tracker now counts heals within a pairing. Guard `outhealed`: after two
  heals, when one heal restores more than our best hit and nothing is a certain knockout, our attacks are skipped. A
  switch, a status, Taunt, Encore, Heal Block and setup stay open. On replay it fires on Gurdurr from turn 8 and on
  Rhyperior on turn 16.
- **Sleeping through setup.** Reshiram, asleep, stayed in while Darkrai used Nasty Plot. Guard `asleepWhileTheyBoost`
  applies to a sleeper (not from Rest, no Sleep Talk) that acts at most half the time, against a boosted foe or one with
  a revealed or near-certain boosting move. It fires on four logged turns.
- **Boosting into a phazer.** Guard `setupIntoPhazer` skips a pure boosting move against a revealed or near-certain
  Whirlwind, Roar, Dragon Tail, Circle Throw, Haze or Clear Smog. Suction Cups, Guard Dog and Soundproof (against Roar)
  are respected. Gogoat's Bulk Up into Skarmory is not caught, since Whirlwind was 24% before it was seen; the override
  margin covers that turn, because Jev had wanted to switch.
- **Not addressed: slower switch-ins.** A switch-in slower than every opposing sample takes two hits before it acts.
  Incineroar into a 15% Thundurus-T took two Focus Blasts. The payload prices one hit per switch; this is left for now.
- **Run counting.** A ladder battle now counts toward `LADDER_BATTLES` when it finishes, so unplayed or interrupted
  games no longer use up the run.

## Second ladder run: stalls, Harvest and a Quiver Dance sweep

The run (`PLAY_MODE=both`, 30 games) stood at 19–9 after 28, with rating 1090 → 1398 at its peak.

Game 4 (`2686471063`) was lost 0–6 to one Quiver Dance Oricorio. On turns 1 and 2 Jev chose Sandaconda: Glare cripples
Oricorio and Stone Edge is four times effective on it. Search overruled Jev both times, first with a switch to
Polteageist and then with Shell Smash, by leads of 0.067 and 0.144, clearing the override margin easily. poke-engine
scores +2/+2/+2 above a healthy Pokémon, and its short search does not see Oricorio's next Quiver Dance keeping it
faster.

- **Guard, `setupRaceLost`.** It skips a pure boosting move when the opponent has revealed a Speed-raising move and,
  after one more use, would still outspeed us after our boost, in every sampled set. It stays out when we hold a
  priority attack, and under Trick Room. It fires on three logged turns: this Shell Smash, which now switches to
  Sandaconda, and two Swords Dances into a Dragon Dance Flapple.
- **Substitute, Leech Seed and Harvest.** Our Tropius (Harvest, Sitrus Berry, Leech Seed, Substitute, Protect) raised
  the question of whether that stall is understood.
  - **Substitute and Protect were already modelled.** That covers shell HP against their best hit, falling Protect
    odds, and the end-of-turn swing a Protect buys.
  - **Leech Seed only counted as a loss for the side that was seeded.** The seeder's healing is now counted: an eighth
    of the seeded Pokémon's max HP, or what it has left, in our percentage. Big Root raises it, Liquid Ooze reverses it
    and Magic Guard stops it.
  - **Harvest was not modelled at all.** The tracker now remembers the berry a Pokémon ate itself; one knocked off or
    stolen does not count. At half HP or below, a Harvest Sitrus Berry adds an expected quarter of max HP times the
    regrow chance: 50% a turn, or 100% in sun.
  - **Leech Seed now reports when it cannot work.** It says so for a Grass-type target, a target already seeded, and a
    target behind a Substitute.

## Second ladder run complete: 30 games, audit for erratic behaviour

The run finished 21–9 (70%), rating 1090 → 1398 at its peak → 1377, with no Jev failures, fallbacks or slow decisions.
A scan of every decision found no attacks into immunities and no same-move loops without progress.

- **Search overrides are not worse than Jev's picks.** Our Pokémon fainted before the next decision after 13% of search
  overrides (12 of 89) and after 17% of Jev's own picks (79 of 458). The blend stays as it is.
- **Free knockouts passed up (7).** All seven were search overrides of a knockout Jev had chosen: Quiver Dance over
  Revelation Dance on a 26% Heatran, Rapid Spin over Ice Beam, Tidy Up over Bite, and others. Guard
  `freeKnockoutPassedUp`: when a move that cannot miss (not Sucker Punch or Thunderclap) moves first and knocks the target
  out at every roll, against every Tera type it could still choose, status moves are skipped. It changes two logged
  turns. The Tera condition lets Close Combat into a Dudunsparce that could Tera Ghost, and Ice Beam into a Whiscash with
  resisting Tera types, stand as judgement calls.
- **Heals at full HP (3).** Recover twice and Milk Drink once, two of them Jev's own picks. Guard `healAtFullHP`.
- **Strength Sap stalls.** Kingdra kept attacking a Polteageist whose Strength Sap healed it three turns running while
  lowering Kingdra's Attack. `outhealed` now counts Strength Sap, which targets the opponent, and prices it by our
  current Attack against their max HP. It fires on that turn.
- **Not changed.** One run of three switches in a row, and one move clicked while asleep with no setup threat, are
  judgement calls. In the loss to loquaoso, Magearna kept using Fleur Cannon down to −5 Sp. Atk into a Recovering Ho-Oh.
  Both of its attacks were resisted and the heals fell in different pairings, so no guard applies; the loss is recorded
  as it happened.

## Imposter Ditto, and Air Lock hiding every Speed comparison

A Ditto that Imposters into our Pokémon was invisible to the bot. Everything downstream of the tracker went wrong:

- **The tracker recorded nothing useful.** It blanked the copied stats, recorded only moves the Ditto had since used,
  and let a generic `[from] ability:` rule overwrite the copied ability with "Imposter".
- **Inference, the calculator and the Choice lock all declined.** Inference threw out Ditto's own sets, which carry
  only Transform, against the copied moves. The calculator and the Speed check refused any transformed Pokémon, and
  Choice-lock tracking skipped them.

In game `2686432739` a Ditto copied our Rayquaza and the payload showed no threat at all. It now shows Outrage for
223–263% and Dragon Ascent for 111–132%, knockouts at every roll, from a Choice Scarf copy at 268 Speed against
our 89.

- **Transform now copies what the game copies.** The copy takes the species and types, our exact stats other than
  HP, stat stages, the ability, and all four of our moves. It keeps its own HP, level and item; for Ditto, every Random
  Battle set is Imposter with a Choice Scarf. The last move is forgotten, so the Scarf lock begins with the copy's first
  move. Leaving restores it.
- **Inference keeps a transformed Pokémon's own sets.** Copied moves never eliminate them.
- **The calculator and the Speed check model a transformed Pokémon** whenever its copied stats are known, as they
  always are for a copy of ours.
- **A boost with their revealed Ditto on the bench is flagged,** since Imposter copies stat stages on entry.
- **Air Lock and Cloud Nine now make Speed decline only for weather Speed abilities.** Before, any Rayquaza on the
  field left the whole game without a Speed comparison.

## Accuracy in what Jev reads

The search models misses, and the newer guards used a hit-chance helper, but the numbers Jev reads assumed every move
lands. An 80% Stone Edge read as a certain knockout, opposing threats carried no accuracy at all, and a switch facing
a 70% Focus Blast was marked `knockedOutOnEntry`.

- **Hit chance covers more.** Besides weather, the user's ability and item, and stat stages, it now counts the
  target's evasion (Sand Veil in sand, Snow Cloak in snow, Bright Powder, Tangled Feet while confused), Wonder Skin
  against status, Keen Eye, Mind's Eye and Unaware reading through evasion, No Guard on either side, and a Poison
  type's Toxic.
- **Our knockouts from a move that can miss carry `knockoutOnlyIfItHits`,** with the hit chance and the knockout chance
  once it is counted.
- **Opposing moves that can miss carry `accuracyPercent`.** `knockedOutOnEntry` is claimed only for a knockout that
  cannot miss; otherwise `knockedOutOnEntryIfItHits` names the move and its odds.
- **One instruction sentence explains the fields.**

Rebuilt over the 30-game run (920 move decisions): 144 of our knockout options could miss; 234 switches had been
labelled knocked out on entry when that needed an inaccurate move to hit; 481 decisions faced an attack that could
miss.

The build now sets `noEmitOnError`. A failed compile had still written the files that compiled, leaving a mixed `dist/`
that the bot would have run.

## Stakeout and Outrage-style locks

- **Stakeout.** The calculator doubles a Stakeout attacker only when told its target has just switched in, and we never
  told it, so a switch into Gumshoos was shown half the real hit. A copy made for a calculation now carries
  `stakeoutActive` whenever the target is arriving. That covers their hit on our switch-in and our hit on theirs; the
  Pokémon already on the field takes the ordinary hit.
- **Outrage, Petal Dance, Thrash and Raging Fury.**
  - **The tracker keeps a `rampage`.** It counts the turns (continuations arrive as `[from]lockedmove`) and ends it on
    fatigue confusion, on a turn the user cannot move, or on a switch.
  - **`choiceLock` reports the lock.** The next move is certain after one turn and even odds after two, and confusion
    follows.
  - **A certain lock prices switch-ins against the locked move alone.** This applies to a known Choice item or the first
    turn of a rampage. A Fairy coming in on a locked Outrage now takes 0, where it had been priced against the worst
    move in their set.
  - **Our own rampage moves say what they commit us to.** A healthy opposing Pokémon on the bench that takes nothing
    from the move is named as a free switch-in while we stay locked.
- **Where they appeared.** The recent logs show two opposing Stakeout Gumshoos, one opposing Zekrom using Outrage, and
  five of our Pokémon carrying a rampage move.

## A charge move after its Power Herb was knocked off

In game `2686635873`, Krookodile's Knock Off took Iron Jugulis's Power Herb. On the next turn search overrode Jev, who had
chosen to switch to Feraligatr and given Meteor Beam 0%, with Meteor Beam (score lead 0.15). Iron Jugulis spent the turn
charging and fell before it fired. Every layer knew the item was gone: the tracker recorded it, the payload carried
`chargesFirst`, and the engine received `NONE` and modelled the charge. The engine's scoring counted the +1 Sp. Atk of
the charge turn as a gain, as it does every boost.

A blanket veto on overrides into moves Jev rated at 2% or less was considered and rejected: there were nine such
overrides, eight of them switches, and none led to a faint.

Guard `chargeWontFire` skips a move that charges this turn (no Power Herb, and no sun or rain to skip it) when it would
not knock the target out at every roll anyway, and their likely attacks (revealed, or in at least half their sets)
knock us out before it fires at least half the time. That is one hit when we certainly move first and two otherwise,
with each hit allowed to miss. A switch must survive its entry. Over 2,012 logged decisions it fires once: this turn,
at about 57%.

## Staying seeded against a Leftovers stall

In game `2686664964` (lost to MissterV), a Wo-Chien with Leech Seed, Stun Spore, Protect, Knock Off and Leftovers wore
down five of our Pokémon. At turn 20 the payload had the numbers:

- Wo-Chien regained 18.9% a turn: 6.3% from Leftovers and 12.6% drained through our seed.
- Arceus-Steel was seeded and paralysed, losing about a third of its HP a turn.
- Judgment did 38–46%.

Search overrides into Recover, Calm Mind, Dragon Dance and Swords Dance fed the stall. The engine's evaluation rewards
every boost and every heal, and it does not see that the seed hands the heal straight back.

Guard `seededAndLosing` measures the exchange while we are seeded:

- **What we deal per turn.** Our best hit's average, times its accuracy, less a quarter if we are paralysed and a third
  if they have shown Protect, net of what they regain each turn.
- **What we lose per turn.** Our own residual loss, the seed among it, plus their best revealed hit.
- **When it fires.** It fires when knocking them out would take more than twice the turns we have left. It then skips
  every move except these:
  - stall-breakers: Taunt, Encore, Heal Block, and Knock Off while they still hold an item;
  - pivots, which clear the seed on the way out.

  A switch must survive its entry. It stays silent if any move is a certain knockout, and for a Pokémon under 30%, which
  is spent rather than saved.

Replayed over 2,335 logged move decisions, it fires on 11:

- **Wo-Chien game, turns 19–23.** Arceus-Steel's Judgment and Recover become a switch to Kyurem.
- **Wo-Chien game, turns 27–28.** Kyurem's Scale Shot and Icicle Spear become a switch to Zangoose. Kyurem was losing
  33–44% a turn.
- **Game `2686022833`, turns 21–23.** Empoleon used Roost three times at 88% while Venusaur, behind a Substitute,
  climbed from 58% to 100%. The guard switches to Meganium, which Leech Seed cannot affect.
- **Game `2686597536`, turn 26.** Raging Bolt's Draco Meteor becomes Volt Switch in a 4-v-1 endgame that was won either
  way.

Tests: the Wo-Chien position fires, and it is silent when unseeded, at 20%, or when a knockout is certain. Volt Switch is
never skipped.

## Wish loops, setting up into sleep, spent sleepers, and blind replacements

A review of the games after the restart: two losses, `2686807416` (to RealSeb328) and `2686808710` (to xxghostxx7382),
then `2686813810` in progress. None of the existing guards would have changed a move in either loss. Four gaps showed
up.

- **Wish was invisible to `outhealed`.** Scream Tail alternated Wish and Protect and climbed from 45% to full through
  seven Thunderbolts from Sandy Shocks, each doing about a fifth. The tracker counted each Wish as a heal, but
  `healPercentNow` has no figure for Wish, because its heal arrives a turn later. The guard therefore read a 0% heal and
  stood down.
  - The guard now counts Wish as 50%.
  - It also leaves pivot moves open, as `seededAndLosing` does.
  - Replayed: turns 20–23 become Volt Switch.
- **`setupIntoSleep` (new).** The search overrode Jev's Fleur Cannon with Tera Fairy, choosing Shift Gear instead, into
  a Brute Bonnet whose every set carries Spore. Magearna was asleep the next turn and slept through most of the game.
  Shift Gear's Attack boost was also worthless to a special attacker.
  - **What it blocks.** A move whose only effect is raising our stats, when the opponent can act and has a revealed or
    near-certain sleep move. That move must hit at least 75% of the time and nothing can stop it: status, Substitute,
    type, ability, item, terrain, Safeguard or Sleep Clause.
  - **What gets through.** Terastallizing into Grass together with the boost is allowed against Spore and the powders.
  - **Replayed.** Across every log it fires twice. One is this turn. The other is Cloyster's Shell Smash into Venomoth
    in game `2686468078`: Cloyster fell to 4%, and an unboosted Rock Blast did 78–94%.
- **`sleeperThrownAway` (new).** While one of our Pokémon sleeps from a move, Sleep Clause makes every other sleep move
  fail on us. Magearna, asleep at 42%, stayed in over Jev's switch and fell to Barraskewda's Waterfall without moving.
  Six turns later Spore put Flutter Mane to sleep, and it fell the same way.
  - **When it fires.** Our only sleeper (not from Rest) faces a living opponent that has shown a sleep move, and a
    likely hit knocks it out before it acts at least half the time. Its moves are then skipped.
  - **Replayed.** It fires twice, on both of those turns.
- **The loop guard held in a blind replacement.** In `2686813810`, Blastoise replaced Serperior on the same turn Wo-Chien
  replaced Pawmot. Jev and the search both switched Blastoise out. `cyclicSwitch` blocked the switch as "a second turn on
  the same matchup", although the replacement had cost no turn, and Blastoise was then paralysed by Stun Spore.
  - A Pokémon that replaced a fainted teammate is now exempt.
  - Of the loop guard's 18 skips in the logs, 7 were this case.
- **Protocol lines are now logged.** Dodrio's Drill Runs against a +2 Defense Diancie read as two misses and then a
  critical hit (32% → 60% → 89% → fainted), but the logs held only snapshots, so this could not be confirmed. Each
  public battle line is now appended as `{"event":"line"}`. Chat and the private request are never logged.

Tests: 322 pass.

## Our Imposter Ditto, and feeding a boosted sweeper

Game `2686815308` (lost to Tinotill). Veluza used Fillet Away to reach +2 Attack, Special Attack and Speed at 55%.
When Iron Hands fell, the bot sent in Latios, then Revavroom, then Talonflame. Each was slower and each was knocked out
by one hit. Ditto went in last. Its Choice Scarf and an Imposter copy of those boosts outsped Veluza, and it had a
knockout on every roll. By the time it arrived, Veluza terastallized into Dark on the same turn, which blunted the
Night Slash the bot chose.

- **Imposter is projected on arrival.** `afterEntry` used to price our Ditto as itself: Normal type, 199 Speed, no
  damaging move, knocked out on entry. Jev gave it 5%. The engine only lists Imposter and never applies it, so the search
  scored all four replacements within 0.014 of each other.
  - An arriving Imposter now takes the target's species (its types from before any Tera), its stats other than HP, its
    stat stages, its ability and its moves. It keeps its own HP, level and item.
  - Our own Pokémon's stats and moves are exact. An opponent's come from its most likely set.
  - It fails into a Substitute or a Pokémon already transformed.
  - Rebuilt payload for turn 10: Ditto moves at 504 Speed against 336, with Night Slash at 116–137%.
  - Switch options now say `transformsInto`, with the copied moves and boosts.
  - The same projection applies to their Ditto coming in on our active Pokémon.
- **Heavy-Duty Boots returned early.** Boots now skip only the hazards, so Download, Embody Aspect and Imposter apply
  even to a Pokémon wearing them.
- **`doomedReplacement` (new).** After a faint, the replacement comes in without taking a hit.
  - **When it fires.** The opponent holds a raised stat, and some replacement certainly moves first and knocks it out on
    every roll.
  - **What it skips.** Any replacement that a likely attack knocks out on every roll before it can act.
  - **Why it is this narrow.** A broader version, with no boost or answer required, would have changed 31 of 435
    logged forced switches. In 11 of those the Pokémon actually sent went on to act, because the opponent switched or
    chose another move.
  - **Replayed.** It changes 4: turns 10, 11 and 12 here, where each Pokémon sent fainted without acting, and a
    Revavroom into a +6 Cetitan, which Ditto would also have beaten.
- **Side effects in the move-decision replay.**
  - In `2686607390`, two 70% Hurricanes into a Girafarig at 6% and a Plusle at 5% become Discharge and U-turn, which
    cannot miss. `needlessGamble` now sees Ditto as a safe switch-in with a knockout.

Tests: 325 pass.

## Shed Tail, and a stall forgotten across a switch

The question was whether Shed Tail is too eager, after game `2686817098` (lost to eyesack24).

- **Shed Tail is not overused.** It was chosen 4 times in every log.
  - Two uses came from the search overriding Jev: game `2686559227` turn 14, a win, and this game's turn 36.
  - Two had Jev and the search in agreement.
  - Cyclizar's Regenerator returns a third of its HP as it leaves, so the real cost is about 17%, not 50%.
  - At turn 36 the Substitute did its job: Chimecho never broke it.
- **The engine's bias is real and worth watching.** `evaluate.rs` scores a Substitute at a flat 75 against 100 for a full
  HP bar. Shed Tail therefore always nets +25 and Substitute +50, whatever the position, the same kind of bias as the
  boost and sleep weights.
- **The misplay came after the Shed Tail.** Electrode sat behind the Substitute and used Thunderbolt four times while
  Chimecho used Calm Mind to +3 and Recover. Each Thunderbolt did about 20% and cost 10% in Life Orb recoil, which
  knocked Electrode out. Electrode carried Taunt, which Jev and the search ranked at 12–26%.
  - `outhealed` should have stopped this. Chimecho had used Recover twice against this same Electrode on turns 3–4, and
    the guard fired then.
  - Its heal count lives on the current matchup, which resets when either side switches. On turn 37 it read zero.
  - From turn 38 on, no switch-in survived the boosted Chimecho, and the guard required one.
- **Fixes.**
  - A new `healsAgainst` record counts each Pokémon's heals against each opponent over the whole battle. `outhealed`
    uses the larger of that count and the matchup's own.
  - With no switch that survives, a stall-breaker of our own (Taunt, Encore, Heal Block, Psychic Noise, Torment,
    Disable) now counts as the way out. The attacks are skipped and the stall-breaker is left.
  - Replayed with heal counts rebuilt from every log, these change exactly turns 37–40 of this game. Taunt is next in
    the ranking each time.

## Tera judged move by move, Glaive Rush, repeated Substitutes, and status moves into a knockout

These come from the ten ladder games of 2026-09-24 between `2686820677` and `2686831745`.

- **`defensiveTera` compared only the worst incoming hit.**
  - In `2686831745` turn 13, Beartic was at 15%. Tera Ground made it immune to Regieleki's revealed Volt Switch and to
    Thunderbolt. An unrevealed Explosion stayed the worst hit at 53.6%, so the Tera read as changing nothing.
    `redundantTera` then skipped it, and Volt Switch knocked Beartic out before Earthquake landed.
  - Turn 23 of the same game was the mirror case. Tera Steel on an 18% Latias resisted Explosion, so the worst hit fell
    from 70.8% to 35.2%, still a knockout. It also turned the revealed Thunderbolt from 15% into a knockout, and Latias
    fainted before a certain Draco Meteor could land.
  - `defensiveTera` now reports `stopsTheseFromKnockingUsOut` and `letsTheseKnockUsOut`, move by move.
  - `redundantTera` stands down for the first. It no longer counts a lower worst hit as protection when the second is
    present.
  - Across all 98 logged Teras, the guard now flags 5: the 4 it flagged before, and this Latias.
- **`outhealed` fired on a sleeping healer.** In `2686827996` turn 38, it skipped Crunch on a Latias that had just been
  Spored. We switched to Spidops instead, and Latias woke and knocked it out with Draco Meteor. The guard now stands
  down while the foe is asleep or frozen.
- **Glaive Rush was untracked.** In `2686825659` turn 2, a Choice Band Baxcalibur was locked into Glaive Rush and
  slower than Dewgong. Its Ice Beam was priced at 66–78%. The real hit was double, and it knocked Baxcalibur out.
  - The tracker now records `-singlemove` volatiles (Glaive Rush, Destiny Bond, Grudge). It ends them on the holder's
    next `move` or `cant`.
  - `scenario()` doubles a calculated hit on a Glaive Rush user that lands before the user moves again. Our hits count
    the doubling only when we surely move first. Theirs count it unless we surely do.
  - The search engine gets `GLAIVERUSH` only when the holder is hit first, because the engine never removes it.
  - Replayed, that turn now reads 131–156%, a certain knockout.
- **`futileSubstitute` (new).** It skips a Substitute right after the same opponent broke the last one, when their
  best sampled hit breaks the new shell too.
  - It fires on exactly the 5 repeats in the logs, and each of those Substitutes broke again that turn: Suicune ×3 into
    a +4 Florges, and Darkrai ×2 into Rhyperior.
- **`statusIntoKnockout` (new).** It skips a status move when the opponent moves first with a revealed attack that
  knocks us out at every sampled roll, and a switch survives.
  - Measured first: with the knockout move revealed, 8 of 14 such users fainted before acting. With only sampled
    knockout moves, 9 of 13 acted, so those do not count.
  - Replayed, it skips 7 chosen status moves. All 7 users fainted before acting.
- **Measured, not guarded.**
  - Voluntary switches into a modelled knockout on entry: only 23 of 50 fainted, so a guard would be wrong half the
    time. This covers Sudowoodo in `2686826688` turn 17.
  - Ursaluna's Moonlight in `2686824058` turn 6 read as uncertain order, because `effectiveSpeed` declines on Unburden
    even after Hawlucha's White Herb was publicly consumed.
  - Sableye in `2686826688` turn 15 was not the Indeedee answer by the payload's own endgame.

Tests: 333 pass.

## Choice Scarf from being outsped, recharge, Klefki's Spikes, and a blind Minior

These are from the ladder games reviewed on 2026-09-24.

- **A Scarf went undetected when we fainted first.**
  - In `2686847689` turn 5, a Heracross knocked out a 214-Speed Serperior before its Leaf Storm. Its Choice Band sets
    have 182 Speed and its Scarf sets 273, but nothing was learned: order was read only when both sides moved.
  - `BattleManager` now records our chosen move (`state.ourChoice`). `BattleEvidence` also reads order when they move
    first and ours faints or flinches before acting.
  - Here that leaves only the Scarf sets, which the speed relation, switch-in threats and `opponentChoiceLock` all
    read. A switch on our side tells nothing and is ignored.
- **Recharge is tracked.**
  - `-mustrecharge` sets a volatile until the holder next tries to move, and `theirTurnMayBeLost` reports the turn as
    lost for certain.
  - The volatile is damage-neutral and is passed to the engine, which models it.
  - Hyper Beam and Giga Impact now carry `losesItsNextTurnToRecharge`, marked as no cost for a Truant user.
  - Our Slaking always choosing Giga Impact was correct: its recharge turn is the turn Truant loses anyway.
- **Klefki's Spikes (`2686850487` turn 17).** At a speed tie with a 6% Baxcalibur, search chose Prankster Spikes over
  Jev's Dazzling Gleam, which knocked it out at every roll. The only revealed attack, Earthquake, knocked Klefki out on
  some rolls, so Gleam landed about three times in four.
  - `freeKnockoutPassedUp` now also counts a knockout whose order is uncertain, when no opposing attack able to move
    first knocks us out at every roll. It stands down if they have a heal, a Protect or a sleep move that could go
    first.
  - Replayed over every log, the extension changes 2 choices: this one, and an Ogerpon's Swords Dance in front of a 1%
    Bisharp.
- **Our Minior was unmodelled (`2686851700`).** Showdown names it by core colour while Shields Down holds it in Meteor
  form, so its private stats never fit. Every damage, threat and speed estimate was missing, and the payload blamed "no
  sampled set is compatible".
  - The search saw a placeholder and could only vote to switch: turn 24 overrode Jev's Earthquake at 1.00.
  - Jev, blind, switched out a +2 Minior on turn 22 that moved first and did 43–50% to Arceus while taking at most 51%.
  - `buildPokemon` now tries a species' battle formes when our stats do not fit the name. The search sits a turn out if
    our active still cannot be modelled.
  - Replayed, those turns have their numbers. On turn 21, `setupRaceLost` now skips Shell Smash for the Earthquake
    that knocks out the 7% Oricorio. The 9 "no compatible set" decisions in the last 40 games are gone.
- **Left as is.** Porygon2's switch in `2686852727` turn 12 was sound. It was asleep with a 50% chance to act, Tera
  Blast knocked Lilligant-Hisui out on only some rolls, and Delphox came in taking 27–41% with a super-effective
  answer. The Victory Dance that followed was the opponent's good play.

Tests: 341 pass.

## The slide after 1982: payload bloat and two predictive guards

The bot climbed from 1841 to 1982 (7 wins in 8) and then went 10–10 over the last 20 ladder games, back to about 1890–1910.

- **What did not cause it.**
  - The slide began at 06:05 UTC on the same code that had just won six in a row, against opponents rated near
    2000.
  - Search overrides were no worse. Over the previous 20 games 15% of overrides saw our active faint that turn, and
    18% of turns that followed Jev. Over the last 20 it was 17% and 13%.
  - Jev failures, latency and search time were normal throughout.
  - None of the guards added earlier today cost a game: `statusIntoKnockout`, `futileSubstitute`, `destinyBondTrade`,
    and the extended `freeKnockoutPassedUp`.
- **Payload bloat.** An edit at 12:45 IST (`trick-loop-v1`) added two always-sent instruction paragraphs, for
  `choiceItemTrick` and `triggersTheirAbility`.
  - Together they added about 1.4 KB to every payload. The share of decisions sent at the minimal tier went from 11% to
    31%. That tier drops `ifTheySwitch`, the projections, residuals, item triggers and opposing set detail.
  - Each paragraph is now sent only when its field is present (`CONDITIONAL_INSTRUCTIONS`, `instructionsFor`), as
    version `2026-09-24-conditional-v1`.
  - Rebuilt, the earlier session's decisions are back to 11% minimal, and the last 10 games' fall from 31% to 15%.
- **`baitedCrash` predicted switches that never came.**
  - In `2686879737`, it skipped Supercell Slam four times on the strength of one earlier Kilowattrel switch-in. Twice
    it fell back to Bulk Up, and once it gave up a certain knockout on a 28% Grimmsnarl. Grimmsnarl stayed in every
    time, setting Reflect and using Parting Shot.
  - Across every log, its prediction came true 3 times in 9, and never when our move knocked them out.
  - A predicted switch to an immune teammate now counts only when we are Choice-locked, or when the crash would knock
    us out and our move does not knock them out. A usable Protect still counts as before.
  - Replayed, it keeps the 3 firings that came true and drops all the Electivire ones.
- **`healingOverAKnockout` ignored the heal's own Tera.** In `2686890855` turn 27, it swapped Decidueye-Hisui's
  Roost + Tera Water for a Leaf Blade that the faster Lunala's Psyshock never let move. Tera Water would have taken the
  knockout away. The guard now stands down for a heal whose Tera stops the knockout on us.

Tests: 350 pass.

## Search kept out of Jev's payload, leaner payloads, engine scoring, and three blind spots

These were measured with the new `npm run preflight` over the last 30 games. The baseline, on the build with
conditional instructions, was 12% minimal, a median payload of 33.8 KB, and a p95 of 37.4 KB.

- **The search is no longer counted twice.** In blend, Jev's payload leaves out the search's shares by default
  (`SEARCH_IN_PAYLOAD`). Each decision records `search.inPayload` for comparison.
- **Leaner payloads.**
  - Evidence entries now carry only their facts (kind, turn, move, counts, contradiction), with the method stated once
    in `evidenceMethod`. That note was the largest repeated text, about 350 bytes a decision.
  - `strongerImmediateDamageAvailable` lost its repeated tradeoff sentence, which moved to a conditional instruction.
  - `priorityTradeoff` lost a note that duplicated an instruction paragraph.
- **Explanations that never reached Jev.** `sharedByEveryActionBelow` and `sameAsWithoutTerastallising` were
  explained only in the full-detail glossary, which production never sends. Each now has a short conditional
  instruction.
- **`executionRisk` names the attack.** It now reads, for example, "If the opponent uses Wave Crash (revealed) …" or
  "Explosion (unrevealed, in 56% of sets)". On a Tera action it reflects what that Tera stops or newly allows.
- **Result:** 2% minimal (19% as played), median 32.9 KB, p95 37.0 KB, and no estimates unavailable.
- **Search.** A world's score is now pooled by visits, and `SEARCH_MS_PER_WORLD` is 200.
- **Engine scoring (`evaluate.rs`).**
  - Substitute is scored at 30 instead of 75.
  - An Attack or Sp. Atk stage counts only for a Pokémon with a move of that category.
  - Sleep is scored per expected turn still lost: −25 fresh, −12.5 after one turn, −6.25 after two.
  - The engine's 929 tests pass.
  - Replayed on the logged Substitute loops, the search still gives Substitute 86–96%, at 200 and 600 ms alike. That
    loop is a horizon effect, not a weight, so `futileSubstitute` stays the fix.
- **Endgame at current HP.** `beats` and `losesTo` count turns to knock out from the HP each side has now.
- **Type changes are modelled.** Protean, Libero, Soak and Burn Up pass the new typing to the calculator. Meowscarada
  had lost every estimate for 8 decisions in 30 games.
- **An Illusion reveal no longer blanks the rest of the game.** The side stays flagged `identityUncertain`, but
  estimates run on the Pokémon the reveal named.
- **Preflight flags.** It flags one new guard change, in `2686870587` turn 4. With Meowscarada now modelled,
  `needlessGamble` skips a Knock Off that did not knock Camerupt out while Overheat knocked Meowscarada out on 92% of
  rolls, for a Regidrago that knocks Camerupt out. Meowscarada survived that turn on a low roll.

Tests: 355 pass.

## Rest with a Chesto Berry, Slow Start, and PP in stall matchups

- **Rest was described by its move text alone: "User sleeps 2 turns."**
  - A Rest user holding a Chesto or Lum Berry wakes at once, so Rest costs one turn and the berry. Chesto is the item
    for 14 species' Rest sets without Sleep Talk.
  - In 14 logged games our active held a Chesto Berry and Rest across 48 decisions. It rested 3 times, and 7 times
    stayed below 45% HP without resting.
  - Every Rest action now carries a `rest` plan: full heal and status cured, whether a berry wakes us at once, or two
    turns asleep, acting only through Sleep Talk's picks when it has it. It also gives the HP the worst incoming hit
    leaves after those turns, and whether we survive them.
  - Rest is now reported as failing when the user cannot sleep: Insomnia, Vital Spirit, Sweet Veil, Purifying Salt or
    Comatose, or a grounded user in Electric or Misty Terrain.
- **Slow Start is priced as a clock.**
  - Protect lists "runs down our Slow Start: N weakened turns left" as a payoff, and Substitute carries
    `runsDownOurSlowStart`. Regigigas's Protect and Substitute set exists for this. Our Regigigas spent 16 logged
    decisions under Slow Start and used either move once.
  - Against theirs, Protect carries `spendsTheirSlowStart`, since each protected turn gives a weakened one away.
  - The payload also has a top-level `slowStartTurnsLeft`.
- **PP in stall matchups.**
  - The tracker records `ppSpent` at each use, with two charged when the move hit a Pokémon with Pressure. Before, every
    past use was charged by whichever Pokémon we had out at decision time.
  - `opponentPP` and the engine's opposing PP both read it.
  - `outhealed` stands down when every heal they have shown has one use or none left, since attacking through it is
    how that PP runs out.
- **Preflight:** 2% minimal, median 32.8 KB, no warnings.

Tests: 359 pass.

## Sacrifices past the search's horizon, and near ties inside the blend

Review of the 13 battles `2686910221` to `2686921608`: 7 wins, 5 losses, and one in progress.

- **The search branched damage rolls only in the top two plies.**
  - In `2686920010` turns 26 and 27, the search gave 0.99 of its visits to switching a 4% Oinkologne, then an 81%
    Meowscarada, into Typhlosion-Tera-Fire. It valued each switch at 0.93. Both were knocked out by Fire Blast.
  - Deeper than the root's children, `generate_instructions` used 0.925 of the maximum roll. Toucannon's Beak Blast
    does 143–166 to Typhlosion's 150 HP: a knockout on about half the rolls at the root, but a certain one a ply later.
    The sacrifice was worth making only because it pushed that exchange past the depth where rolls branched.
  - `mcts.rs` now branches rolls at every depth, and `mcts_threaded.rs` matches it. Chance children are sampled by
    probability, so the cost is breadth at expansion: 88% of the old iteration rate at 200 ms, over 90 logged
    positions.
  - On those positions the new top pick differs from both of two old runs in 5 of 90. Two runs of the old binary
    already disagree with each other in 8 of 90.
  - Turns 26 and 27 now go to Beak Blast at 0.997. In `2686831745` turn 24, a switch into a certain knockout that had
    scored 0.982 now loses to Psyshock.
  - `generate_instructions` is unchanged, so the engine's 928 tests still pass as written. The previous binary is in the
    scratchpad as `poke-engine.before-killroll`.
- **Near ties below Jev's top choice are settled by Jev.**
  - The override margin protected only Jev's first choice. In `2686919272` turn 12, Meloetta faced a +2 Thundurus. The
    search fairly rejected Jev's switch to Salamence. It then scored Stonjourner at 0.228 and Hyper Voice at 0.209, and
    the blend took the sacrifice by 0.002, though Jev gave it 0.02 against Hyper Voice's 0.36.
  - Now, once the search clearly beats Jev's top, every action within the margin of the search's best is a tie, and
    Jev's probabilities pick among them. The decision logs `nearTie: { searchBest, chosen }`.
  - This changes 113 of 3,501 logged blend decisions. Most move off a marginal switch, setup move, Substitute, Recover
    or hazard.
  - The blend is now the exported `blendChoice`. Preflight replays it: 15 of 850 recent decisions change, all of them
    through this rule, and there are no other differences.
- **Checked and left alone:**
  - Barraskewda's three Waterfalls into Feraligatr: it was Choice Band-locked, and each hit did 25%.
  - Hatterene attacking at 21% while paralysed: it was doomed, and attacking earned a free switch-in.
  - Toucannon's switch to Oinkologne on turn 13: Oinkologne was at full HP with Thick Fat.
  - Wugtrio into Tauros: Jev chose it (0.57) and the search agreed.
  - Victreebel's 14 Strength Saps against Shift Gear: each Sap cancelled the Attack gained. Revavroom broke the stall
    first, and we won.
- **Open:**
  - Arceus-Electric stopped Calm Mind at +3 while Jolteon went to +6. Calm Mind and Ice Beam tie in the search (0.473
    against 0.479), and Jev preferred attacking, so there is no clear line to guard.
  - The engine's flat `USED_TERA = -75` puts Tera actions about 0.07 below the same move without Tera. Jev's Tera pick
    was overruled to the plain move 61 times, but 50 of those had four or five teammates left, where saving Tera is
    defensible. Unchanged.
- **Preflight:** 2% minimal, median 32.9 KB, no warnings.

Tests: 360 pass. Engine: 928 pass.

## Shift Gear before a sleep that attacking would not stop

`2686936581`, lost. Magearna-Original (Shift Gear, Fleur Cannon, Iron Head, Tera Blast) led into Amoonguss.

- **Turn 1:** the search wanted Shift Gear (0.63 of visits, 0.582 against Iron Head's 0.513). `setupIntoSleep` skipped
  it, so Iron Head did 24–29% into Regenerator, Rocky Helmet took 16% back, and Spore landed anyway. Turn 18 repeated
  the pattern.
- **The Fleur Cannons were not the problem.** Those on turns 16, 24 and 25 were clicked while Magearna was asleep. On
  turn 17 it woke, and the Cannon did 42.6–50.4% to a 46% Slaking. Shift Gear there would have taken Slaking's 67.6% hit
  first and still not finished it. The Slaking switched to Amoonguss.
- **What changed:** the guard assumed attacking was the alternative to a wasted boost. But an attack does not stop the
  sleep; it only spends the turn before it. The guard now stands down when all three hold:
  - two of our best hits would not knock the sleeper out;
  - two turns of its worst hit, the expected sleep, leave us standing, with Stomping Tantrum and the other
    history-doubled moves counted at base power;
  - it likely carries nothing that erases boosts and can touch us. Clear Smog against Steel does not count.
- **Replay over every log:** the guard stands down on the two Magearna vs Amoonguss turns and still fires on the other
  17. Those include Magearna vs Brute Bonnet, where the forgone Fleur Cannon did 82–98%, Tinkaton vs Venomoth with
  Gigaton Hammer at 63–74%, and Cloyster vs Venomoth.
- **Open:**
  - `incomingThreats` prices Stomping Tantrum at double power in its worst case, though that needs the user's previous
    move to have failed, which is not tracked. The payload told Jev that Shift Gear left Magearna at 30%, rather than
    about 65%. A history-doubled move sets the worst case in 13 of 1,398 recent decisions, and creates a phantom
    knockout in 5.
  - Switching the sleeping Magearna out preserved its sleep, and it lost turns 16, 24 and 25 on returning. Benching a
    sleeper keeps Sleep Clause up, so this was left to judgement.
- **Preflight:** no warnings.

Tests: 361 pass.

## Sleep's first turn, Diamond Storm's Defense, and Tera that buys the next hit

- **Sleep was one turn optimistic.**
  - Gen 9 sets the sleep counter to 2–4 and lowers it before each check, so a sleeper loses one to three turns and its
    first attempt never wakes. `wakeChance` gave 33%, 50% and 100% after 0, 1 and 2 lost turns; the right figures are
    0%, 33%, 50% and 100% after 0, 1, 2 and 3.
  - Poke-engine's `chance_to_wake_up` already had it right. Every non-Rest sleeper in our logs that woke had lost 1, 2
    or 3 turns first (4, 4 and 1 of them); the old table expected a third to wake at once.
  - In `2686941222`, Cacturne was slept by Yawn and withdrawn. At t9 it was sent back in against a burned, +2 Speed
    Magearna at 26%, whom its Sucker Punch knocked out at every roll. The payload gave it a 33% chance to act. It had
    none: it lost the turn to sleep, and Fleur Cannon knocked it out.
  - Fixed in `wakeChance`, with Early Bird handled, and in the instructions, glossary and guard text. The instructions
    are now `conditional-v3`.
  - A sleeping switch-in now carries `asleep: { turnsAlreadyLostToSleep, chanceItWakesOnItsFirstTurnBackPercent }`.
    Sleep counts down only on the field, and before this a replacement showed only `status: slp`.
- **Diamond Storm's +2 Defense happens half the time, but the payload gave it as certain.**
  - `@pkmn/dex` stores it as `self: { chance: 50, boosts: { def: 2 } }`, and `moveEffect` ignored the chance. It is the
    only move stored that way.
  - In `2686945784` t19, Diancie at full HP faced Palafin-Hero, whose Jet Punch took 69–82% of its HP. The payload said
    Diamond Storm would cut that to 41.7%, about what Tera Fairy would (40.8%). Jev played Diamond Storm over the Tera
    (0.53 against 0.07); the search saw every line as lost. The Defense boost did not come, and the second Jet Punch
    knocked Diancie out.
  - It is now `userBoostsOnlySometimes` with its chance, and the projection is `afterItsStatChangeIfItHappens`, marked
    `happensPercentOfTheTime`. Serene Grace makes the boost certain; Sheer Force removes it.
- **A Tera that does not stop this turn's hit can stop the next one.**
  - `defensiveTera` said only `stopsItFromKnockingUsOut: false` for Diancie, because it survived one Jet Punch either
    way.
  - It now adds `hitsItTakesToKnockUsOutBecomes` and `wasHitsBefore`, which here are 3 and 2. That was the difference
    between one Diamond Storm and two, with Palafin at 76%.
- **Accuracy was already covered in both directions:**
  - our moves carry their accuracy and `knockoutOnlyIfItHits`;
  - opposing threats carry `accuracyPercent` and `knockoutIsCertain: false`;
  - the guards use hit chance, and the engine branches on hit or miss.
  
  The two errors here were other probabilities that had been treated as certain.
- **Preflight:** 4% minimal, no warnings.

Tests: 363 pass.

## The slide from 2076, and an audit of facts against outcomes

- **Results by build.**
  - `conditional-v2`: 11 wins in 16 games.
  - `conditional-v3`: 4 wins in 10.
  - `loaded-dice-forced-tera-v1`: 2 wins in 6.
  - `harvest-search-gap-v1`: 1 win in 4.
  - Opponents averaged about 2000 to 2020 throughout, so this is not only harder pairings. Changes between 16:20 and
    17:16 came from a Codex session, which left no notes; its patches were read from its rollout log and audited here.
- **Facts checked against outcomes.** The new `scripts/audit-outcomes.mjs` replays each logged move decision and
  compares the claims with what happened. Over 80 games:
  - Turn order was wrong in 3 of 542 definite predictions.
  - Of 371 clean hits of ours, 0.5% did less than the predicted range and 1.1% more.
  - One of 24 predicted certain knockouts failed.
  - Of 290 hits taken, 1.7% did more than predicted.
  - The numbers Jev and the guards see are sound. The problems were in plumbing.
- **The world sampler kept one moveset per opponent.**
  - `sampleWorld` drew from `dedupeCandidates`, which merges sets by stats, ability and item. That is right for the
    calculator and wrong for the search: it kept only the first moveset and Tera type of each group.
  - Volcarona's 38 sets became two, Tera Water or Tera Ground. In `2686956370` it was the Tera Grass Quiver Dance set,
    which no world held; the search rated Liquidation 0.95, Volcarona resisted it, set up, and swept.
  - Now the sampler draws from every candidate. Sampled Tera types now match inference: Water 97, Steel 90, Fire 80,
    Ground 67 and Grass 66 over 400 worlds. The search's top pick changes in 9% of 80 positions, which is the noise
    floor, but its value estimates are now honest where a set matters.
  - The fault was already in the 11:14 copy, so it is old and not the cause of the slide.
- **A certain failure could be the fallback.**
  - In `2686981978`, `outhealed` rightly skipped Play Rough against a Gastrodon that out-healed it. The next action in
    the blend was Thunder Wave, which the search rated like anything else in a lost position. Scream Tail used it
    seven turns running into a Ground type while Ice Beam wore it down.
  - The new `certainlyFails` guard skips a move that viability's established facts say fails outright. It never
    guards on a hidden set's possibility, and it leaves out the "helps the target" and curing-berry costs.
  - Of 10 played moves it would have blocked that can be checked in the logs, all 10 failed or did nothing.
- **Guards cannot cost a turn.** A guard that throws is now skipped for that decision rather than ending it with no
  choice sent.
- **Opposing Pokémon the search could not see.** In 6 of 1,490 engine states, the opposing active was an empty slot.
  - Double Shock left Pawmot as `???/Fighting`, which `buildPokemon` rejected. The typeless slot is now dropped, or
    kept when it is the only type.
  - A Zoroark's Dark Pulse, used as Chimecho, left no set that explained the moves recorded for it. Inference still
    fails closed for the payload, but the sampler now uses the sets that explain the most. An engine-state check of HP,
    status, stages, Tera, hazards, screens, weather, terrain, Trick Room and Substitute across 1,490 states now finds no
    mismatch.
- **Prankster in the engine.** The engine cancelled every Prankster status move against a Dark type. The game cancels
  only moves aimed at the Dark Pokémon; screens, hazards, Substitute, self boosts and field moves still work. The
  search thought our Light Screen or Spikes did nothing against Umbreon.
- **The Trick immunity fix, finished.** Codex's viability change stands: status moves obey type immunity only when the
  move says so, as Thunder Wave does. The remaining places were checked.
  - The guards only apply immunity to damaging moves.
  - The engine's search path treats Seismic Toss, Endeavor, Final Gambit and Pain Split correctly.
  - The wrong type checks in `calculate_damage_rolls` belong only to the `calculate-damage` command, not to play.
- **Codex's changes, audited.** The following were read and left in place: the No Retreat guard, Loaded Dice
  branching in the engine, the forced-replacement Tera line, the Wish, capped-stat and Magic Guard viability fixes,
  Charge and Flash Fire in the calculator, the closed four-move sets, Harvest memory, the Sitrus/Harvest projection,
  and the blend's 0.10 filter. The filter changes 9 of 2,240 logged decisions.
- **Prose.** Every one of the 78 field names in the instructions and glossary has a live producer. Seven are rare and
  did not appear in 1,716 rebuilt payloads.

Tests: 377 pass. Engine: 931 pass.
- **Payload budget.** The `loaded-dice-forced-tera-v1` build played 15.3% of decisions at the minimal tier, against
  5.8% under `conditional-v3`. Its forced-replacement Tera sentence was sent in every payload's instructions and is now
  a conditional paragraph. The Tera threat it describes is trimmed to the same limit as the ordinary switch-in threat.
  Preflight: 8% minimal, the same as the last 30 games as played; median 32.4 KB; no warnings. Instructions are now
  `2026-09-24-audit-v1`.
- **Setting up on a Pokémon we can already knock out.**
  - `freeKnockoutPassedUp` blocked every setup move whenever a certain knockout would land. That is right when we move
    first: setting up hands them a turn they would not otherwise get. It is wrong when we move second and survive,
    because they get one action either way. A Speed boost that makes the knockout go first next turn then costs
    nothing, and the boost stays for whatever comes in next.
  - That case is now allowed. Salamence at +1 outspeeds every Rotom-Mow set, Scarf included, so Dragon Dance goes
    ahead. A Sucker Punch or Shadow Sneak user still gets a priority hit in first, so against Bisharp it stays blocked.
  - In the logs the guard blocked setup 90 times, always while moving first. The search preferred the setup by a
    clear margin in only 4 of those, and each time the foe could hit hard or had Toxic, Encore or similar. No logged
    decision changes.
- **What a boost buys against the rest of their team.** Speed-raising moves now carry
  `afterItsStatChange.theirRemainingPokemon`. It names the revealed bench Pokémon the boost lets us outspeed, from the
  fastest of their possible sets. It also gives the share of the unseen Random Battle pool we outspeed, now and after,
  with Choice Scarf counted. Salamence's Dragon Dance takes that share from 57% to 98%. The search already filled unseen
  slots with sampled Pokémon, but the provider saw only a count.
- **Stored Power and Power Trip** scale with every positive stage in the calculator (20 base power, 60 at +1/+1) and
  in the engine, which counts all seven stats.
- **Preflight:** no warnings; median 32.4 KB.

Tests: 378 pass.

## Still losing after the audit: strength, Tera, trapping, pivots, Endeavor and replacements

- **How strong the bot is.** The performance rating is the average opponent plus 400 × (wins − losses) / games.
  - With the search shown to Jev: 38–26 against opponents averaging 1882, a performance of 1957.
  - `conditional-v2`: 11–5 against 2015, a hot streak at 2165.
  - `v3` onwards: 9–17 against 1984, performance 1861.
  - The whole period with the search hidden, 42 games, comes to about 1977, the same as before. The climb to 2076 was
    a streak and the slide is regression, made worse by the bugs below. Twenty-six games cannot separate a real
    decline from variance.
  - Picks that were neither Jev's top choice nor the search's rose from 2–3% to 7–16% once the search left the
    payload. 94 of 116 such picks came from the near-tie rule. They fall more often in lost games, but that is
    expected: near ties are commonest in positions already lost.
- **The engine's Tera penalty now scales with the Pokémon left.** `USED_TERA` was a flat −75. It is now −12.5 per living
  Pokémon on that side: 75 with six, 25 with two.
  - The flat penalty overruled Terastallizing to the end of games: Terapagos was asked to Tera Stellar five turns
    running and Carbink to Tera Fighting three, with three Pokémon left.
  - Both options now sit within the near-tie margin, so Jev's choice stands. With six Pokémon left the search's top
    pick was a Tera action in 2 of 61 positions, before and after the change.
  - The engine still does not model Terapagos changing forme when it Terastallizes.
- **No Tera on a turn the opponent cannot act.**
  - In `2687051429`, Malamar went Tera Steel with Superpower while Slaking loafed on Truant. Slaking came back with Tera
    Ground Earthquake.
  - When the foe certainly loses the turn (Truant, a recharge, or sleep it cannot wake from), `redundantTera` now
    skips any Tera that does not change our own damage. Tera happens before moves, so it can be taken the next turn.
- **No Tera for chip damage.**
  - Of 114 damaging Teras that added damage, 38 turned a non-knockout into a certain one.
  - Early chip Teras, with no knockout gained and no defensive gain, came in games we went 5–15 in.
  - `redundantTera` now also skips a Tera when four or more of our Pokémon are alive and it raises the knockout
    chance, measured over the rolls, by under 10 points without taking a hit off the knockout. It would have changed
    2 logged picks: Slaking's Giga Impact and Basculin's Wave Crash.
- **Trapping.**
  - The engine already applied Shadow Tag, Arena Trap and Magnet Pull to both sides. It now also leaves one Shadow
    Tag holder free of another.
  - The payload never said when our trapping ability held them. It now carries `theyCannotSwitchOut`, with any
    pivot move that still gets them out, and drops the predicted switch-ins when there is none. This affected 35
    logged decisions with Gothitelle, Magnezone, Probopass or Dugtrio.
- **Faster pivots.**
  - We used 81 pivot moves in the logs, but hard-switched 12 times when a damaging pivot was certain to move first.
    One of those was Bellibolt leaving a 52–61% Volt Switch unused.
  - A voluntary switch is now played as that pivot when it certainly goes first, deals damage, likely meets no
    Protect, and meets no known contact punisher. The decision logs `pivotInsteadOfSwitch`.
- **Immunity abilities** were checked and are right in the calculator, the engine and viability:
  - Levitate, Storm Drain, Water Absorb, Volt Absorb, Motor Drive, Flash Fire, Earth Eater, Sap Sipper, Wind Rider and
    Well-Baked Body all apply;
  - Mold Breaker goes through Levitate;
  - an ability not yet revealed stays a possibility with its frequency, because of Illusion.
- **Endeavor.**
  - In `2687057697`, Luvdisc at 75% was denied a second Substitute by `futileSubstitute`, used Endeavor, and a 94%
    Snorlax fell only to 47%.
  - `futileSubstitute` now stands down for Endeavor, Flail and Reversal users and pinch berry holders.
  - A new `endeavorTooEarly` guard skips Endeavor when no Substitute stands, our HP is above a quarter, a Substitute
    certainly goes up first, and nothing gets through a shell.
- **Replacements picked off by priority.**
  - Four of 404 logged replacements fell to a priority move before acting: Mismagius to Shadow Sneak, Cinccino to
    Vacuum Wave, and Drifblim and Deoxys to Jet Punch.
  - A new `pickedOffOnArrival` guard skips a replacement that a revealed, sure-hitting priority attack knocks out
    after hazards, when another replacement survives it. It ignores Sucker Punch, which a status move beats, and it
    ignores a candidate with its own priority attack at least as quick.
  - It would have changed 2 logged picks, Mismagius and Gliscor. Both were picked off.
- **Hazard-laying attacks.** Ceaseless Edge (Spikes) and Stone Axe (Stealth Rock) are now priced as the hazard they lay,
  and as chip once it is maxed. Smeargle's Ceaseless Edge had been shown only as 2%, including on the turn Spikes
  were already at three layers.
- **Wish then Protect was measured and left alone.** Only 7 of 24 opposing Wishes were followed by a Protect, so it is
  no basis for a prediction.

Tests: 385 pass. Engine: 931 pass. Instructions `2026-09-24-audit-v2`.

## A near tie may not flip the kind of action both sides chose

- **What went wrong.** In `2687072937` t7, the first game with the search shown to Jev, Glalie faced a Rotom-Frost at
  +2.
  - Jev wanted to switch: 0.53 across the switches, with Stantler first. The search wanted Victreebel in, at 0.36.
  - Victreebel beat Jev's top by 0.035, just past the margin. The near-tie rule then took Jev's favourite among the
    options within 0.03 of it, which was Freeze-Dry at 0.37. That is a resisted hit, and Glalie was paralysed.
- **The rule now.** When at least half of the provider's weight is on the kind of action the search's best is (switch
  or move), a near tie stays within that kind. When the provider is split, it still settles the tie, as on the
  Stonjourner turn the rule was made for.
- **Effect on the logs.** Of 115 logged near-tie picks, 34 flipped the kind of action, and 19 change under this rule.
  Examples:
  - Jev Thunderbolt and search Volt Switch now gives Volt Switch, not a switch to Tinkaton.
  - Jev Knock Off and search Bulk Up now gives Bulk Up, not a switch to Typhlosion.

Tests: 386 pass.

## Outrage's lock in the search

- **What happened.** In `2687076523` t11, Salamence faced a 28% Hitmonchan, which either move knocks out. Jev wanted
  Dual Wingbeat (0.50). The search chose Outrage (0.654 against 0.604). Hitmonchan switched to Brute Bonnet, Salamence
  was locked into two Outrages, and Brute Bonnet Spored it.
- **The engine bug it exposed.**
  - `add_available_moves` held a Pokémon to its last move only under Encore. The Outrage lock (`LOCKEDMOVE`) blocked
    switching but let the search choose any other move on the following turns.
  - Every Outrage, Thrash, Petal Dance and Raging Fury therefore looked like its full power with little of the cost of
    being stuck on it.
  - All four option sites in `genx/state.rs` now treat the lock like Encore. A new engine test covers it.
- **Effect.** On 30 logged positions with a locking move available, the search's top pick was a locking move 10 times
  instead of 12, and the top pick changed in 3.
- **Why the Salamence turn stays Outrage.** Dual Wingbeat hits 90% of the time, and a miss hands a 28% Hitmonchan a
  turn with Ice Punch, which is four times effective on Salamence. Outrage cannot miss. With the fix, the search still
  prefers it (0.664), which is defensible for a sure knockout.

Engine: 932 pass.

## Setup, phazing, early Tera and missing interactions (audit-v4)

The 16 audit-v3 games went 5–11. Setup was on offer on 148 turns: the search's top pick was a setup move 30 times,
Jev's 6, and we set up 9 times. Already boosted, we never boosted again (0 of 29).

- **`setupRaceLost` blocked defensive setup.** It skipped any boost when a Speed booster would stay faster.
  - It changed the move on 13 logged turns, and our record in those games was 2–5.
  - 8 of those were Cosmic Power or Iron Defense. Five were Chimecho's Cosmic Power in `2687157918`, where one Dragon
    Dance Tropius then swept all six.
  - Defense and Special Defense boosts are now exempt. A boost with no Speed in it counts only when we move first now.
  - Firings: 221 → 44. The Shell Smash and Dragon Dance races it was built for are still blocked.
- **The near-tie rule was not settling noise.** Jev's pick stood whenever the search's score lead was under 0.03.
  - It kept Jev's pick over the blend's top action 732 times, 103 of them setup moves.
  - I reran the search three times on 40 of these turns. The search again preferred its own pick in 108 of 120
    reruns, and in 71 of 75 when it had given that pick twice the visits.
  - A tie now also needs the visits to be close (`DECISIVE_VISITS = 2`). Replayed, 631 of 6,643 blend decisions change:
    84 now set up (10 stop), and 25 drop an unwanted Tera (6 add one).
- **Tera needs the search's agreement.** A Tera is played only when the search gives it more visits than the same move
  without it; otherwise the plain move goes (`teraHeldBack` in the decision log).
  - We Tera'd at a median of turn 9, opponents at turn 16. We did it with all six alive 16 times in 34; they did 4 in 26.
  - 39 of 197 logged Teras were ones the search ranked below the plain move, 24 of them with five or six of ours standing.
  - Win rates did not separate early from later Teras (59% vs 64%), so this is a pricing rule, not a measured loss.
- **Phazing.** Roar, Whirlwind, Dragon Tail and Circle Throw previously carried only `forcesTargetSwitch: true`.
  - They now carry `phaze`: the stat changes erased, who can be dragged in, our hazards on their side, and `noDrag`
    reasons (last Pokémon, Ingrain, Suction Cups, Guard Dog, Substitute against an attacking phaze).
  - Roar into a last Pokémon is now a certain failure.
  - Example: a Curse Snorlax Body Slammed Piloswine out over two Earthquakes in `2687159529`, while Roar sat unused and
    the search had it nearly tied (0.515 vs 0.518).
- **Prankster Encore.** In `2687149125` Sableye locked Snorlax into Rest at full HP, then Cobalion into Aura Sphere, to
  which it is immune.
  - `theyMayEncoreUsFirst` now warns when their Encore is likely, lands first, and would hold a useless last move.
  - Opponents used Encore on 38% of such turns, against 11% when our last move was a real attack.
- **Crash moves into a Tera immunity.** `crashesIfTheyTerastallizeInto` names the target's unspent Tera types that are
  immune, and their share of its sets. Talonflame's Tera Ground crashed Electivire out in `2687152284`.
- **Payload tier.** 8% of decisions were sent at minimal detail and lost set summaries, switch-in threats and PP.
  - All would fit at reduced under 42,000 bytes; `JEV_PAYLOAD_BUDGET_BYTES` is now 44000.
  - That is about 20k tokens, against Jev's 32k limit.

Tests: 402 pass. Preflight: 0% minimal, no warnings.

## Sheer Force races, Revival Blessing and fainted Pokémon in the search

- **Sheer Force Speed raises.** `setupRaceLost` skipped Haxorus's Swords Dance because Feraligatr had Trailblaze
  (`2687202806` t5). The search had Swords Dance at 0.503 of the visits against 0.170.
  - Every Feraligatr set with Trailblaze has Sheer Force. The Trailblaze on Azumarill raised nothing.
  - All nine Speed-raising attacks carry the raise as a secondary effect, which Sheer Force removes.
  - `speedGain` now takes each sampled set's ability: Sheer Force removes the raise, Contrary reverses it and Simple
    doubles it. It also stops counting Ancient Power, Ominous Wind and Silver Wind, which raise only 10% of the time.
  - If any sampled set cannot raise its Speed, the race does not count.
  - Checked and dropped: inferring Sheer Force from a missing raise. In the random-battle sets, the move already
    decides the ability in every case, so the inference could never change anything.
- **Revival Blessing did nothing in the engine.** poke-engine defined it with no effect.
  - The search scored it as a wasted turn, and it was played once in 29 chances.
  - It now revives the fainted teammate with the highest stat total at half HP. The engine tests cover the revival and
    the no-target case.
- **Fainted Pokémon were placeholders in the search state.** There was nobody real to revive.
  - `num_fainted_pkmn` skips placeholders, so it was always 0. Supreme Overlord and Last Respects were therefore
    searched at base power.
  - Fainted Pokémon are now written as themselves at 0 HP. If our Tera is spent and no written Pokémon shows it, they
    also carry the spent Tera, as the placeholders did.
  - Replayed: in `2686562504` t12, Revival Blessing went from 0.022 to 0.428 of the visits, the search's top move. Where
    attacking was winning (`2687204655` t13) it stayed at 0.011.
- **audit-v4 so far (9 games, 5–3, one unfinished).**
  - Setup played on 13 of 72 turns where it was available (18%, up from 6%).
  - Tera held back twice. The one turn-1 Tera, Copperajah's Tera Fairy into Conkeldurr, was the search's and Jev's pick.
  - No decision was sent at minimal detail.

Tests: 403 pass. Engine: 934 pass. Preflight: no warnings.

## Flamigo's blocked Tera, U-turn fallbacks and the Substitute–Leech Seed loop

- **`redundantTera` blocked a winning Tera** (`2687217753` t26–29).
  - Flamigo at 48% faced Glastrier, their last Pokémon. The search put 0.98–0.99 of its visits on Close Combat + Tera
    Fighting (0.98 win estimate at t26).
  - The guard skipped it: Tera "improves no knockout odds" and "lets High Horsepower knock us out".
  - But Icicle Crash knocked Flamigo out on every roll with or without Tera, and Flamigo moved first. The hit it landed
    was the only one it would get. Tera left Glastrier at 8–22% for the three teammates, instead of 31–42%.
  - Now, when a likely attack knocks us out either way and our move goes first, the "lets X knock us out" and chip
    branches stand down. The chip branch also stands down against their last Pokémon.
  - Replayed over all logged Tera skips, 9 change, including the four Flamigo turns. Surplus-damage skips (the plain
    move already knocks out on every roll) are unchanged.
- **The fallback was U-turn.** The next-ranked action came from Jev's leftover votes: U-turn 0.07 against plain Close
  Combat 0.05.
  - Three U-turns dragged in Garganacl, Mesprit and Magnezone, and each fainted to Icicle Crash. Chilling Neigh took
    Glastrier to +3.
  - When a guard skips a Tera, the fallback is now the same move without Tera, unless that is skipped too.
- **`futileSubstitute` ignored Leech Seed** (`2687219758` t24).
  - Serperior's Leftovers and Leech Seed refunded all but 3.8% of each 25% Substitute. The Substitute also absorbed an
    Air Slash that would otherwise knock Serperior out, and Vespiquen lost 12.5% a turn.
  - At 49% against 27% the guard switched out, and Vespiquen Roosted back to 77%.
  - The guard now uses the residuals, each at its cautious end. It stands down when we can keep making Substitutes (each
    needs more than 25% HP) at least as long as the opponent lasts. At 28% and 32% against 76% it still skips.
  - Across the logs this frees 2 of the 4 skipped Substitutes: this one and `2687057697` t58, which the search had at 0.895.

Tests: 406 pass. Preflight: no warnings.

## Review of 16 audit-v4 games (11–5): the form-change level bug

- **Health.** No fallbacks, no failed provider calls, and all 16 worlds searched on every decision. Turn order was right
  in all 135 definite predictions.
- **`-formechange` erased the level.** The tracker replaced a Pokémon's details with the bare form name, so
  Cramorant-Gorging, Meloetta-Pirouette, Morpeko-Hangry and Minior-Meteor were read as level 100.
  - Against Cramorant (L86), our hits landed 30–50% above prediction and its Surf 25% below.
  - About 138 logged decisions involved such a Pokémon (Luvdisc, Pincurchin, Delibird and Sunflora really are
    level 100).
  - The level and gender are now kept, and a test covers it. `detailschange` carries its own level and was fine.
  - Our own Pokémon were never affected: every request refreshes their details and stats.
- **Audit script.** `audit-outcomes.mjs` now treats a stat change earlier in the same turn as unclean. Gogoat's Bulk Up
  before Copperajah's Play Rough had been reported as a failed "certain" knockout. With that fixed: our damage above
  range 5 of 71, theirs below 5 of 59, and 7 of those 10 are Cramorant or Morpeko.
- **Checked and not bugs.**
  - Four voluntary switch-ins fainted before acting. Three were sacrifices of Pokémon at 6–14% for a free switch; the
    fourth was a 50% Ambipom gamble in a game that was won. Palafin switched out through a sacrificed Grumpig to come
    back as Hero, deliberately.
  - Hyper Voice failed for lack of a target (Floatzel had fainted to recoil), and Thunder Wave hit Jumpluff's
    Substitute.
  - Coalossal's five Flamethrowers came in a lost position, where Stone Edge was a coin flip at 80% accuracy.
  - The Iron Bundle sweep in `2687201048` was a lost position from t23 (search ≈0.02).
- The Flamigo, Serperior and Feraligatr guard skips in these games are fixed in audit-v5, which is not yet running.

Tests: 407 pass.

## Pivots into a knockout

- **What happened.** Flamigo's three U-turns in `2687217753` each brought in a teammate that Glastrier knocked out
  before it acted: Garganacl at 24%, Mesprit at 29%, Magnezone at 7%.
  - Glastrier is slower than all three. After a faint they would have come in free and attacked first.
  - Each knockout also fed Chilling Neigh.
- **Across the logs.** Of 52 pivots that brought a teammate in, only these 3 lost it the same turn. All three were guard
  fallbacks the search gave 0.003 or less.
- **Guard, `pivotIntoKnockout`.** It skips U-turn, Volt Switch and Flip Turn when all of these hold:
  - the pivot goes first;
  - every teammate is knocked out on arrival by a revealed or likely attack at every sampled roll, or by hazards;
  - we have an attack that damages the target.
- **When staying in would knock us out,** the guard also needs a teammate that outspeeds every sampled set, so that it
  would act after a free switch. Against a faster opponent, the pivot's chip may be all anyone gets.
- **Replay.** It fires on 35 of 746 decisions with a pivot on offer. On all but the three Flamigo turns, the bot had
  attacked anyway.

Tests: 408 pass.

## Self-play bench, adaptive search and an endgame solver

- **Bench (`scripts/selfplay.mjs`, `npm run bench`).** Two search configurations play Gen 9 Random Battles on a local
  `@pkmn/sim`, with no Jev and no ladder.
  - Each seed is played twice with the teams swapped, and the bench reports B's win rate with a Wilson 95% interval.
  - Results resume from `logs/bench/<name>.jsonl`. It refuses to start while the ladder bot runs.
  - A config can set `guards: false`, through a new `DecisionLoop` option, to measure what the guards are worth.
  - A smoke pair at a tiny budget finished both games in about 10 seconds each.
- **Adaptive search (`SEARCH_EXTRA_WORLDS`, `SEARCH_CLOSE_RATIO`).** When the second action drew at least 60% of the
  first's visits, a second pass of worlds is pooled with the first. Reruns agreed on the top pick about nine times in
  ten, and the extra worlds go to the tenth.
- **Endgame solver (`SEARCH_ENDGAME_POKEMON`, `_WORLDS`, `_MS`).** With few Pokémon left, each world runs poke-engine's
  fixed-depth expectiminimax, deepened while fifteen times the last depth still fits the budget.
  - On Flamigo's endgame: 0.23 s at depth 4, 3.5 s at depth 5.
  - Our strategy at the root is solved by regret matching over the full matrix, not by the engine's worst-case
    "safest" choice. That choice flipped between U-turn and Close Combat with depth on Flamigo's turn. The equilibrium
    put 0.54–0.61 on Close Combat + Tera Fighting, in about 0.2 s over 8 worlds.
  - The iterative-deepening subcommand was not usable: it prunes, and leaves `NaN` cells in the matrix.
- All of these are off by default. Their live settings wait for bench results.
- **Result, `endgame4` (200 games).** B, the live search plus the endgame solver at ≤4 Pokémon, won 102 of 200 (51.0%,
  95% range 44.1–57.8%, about +7 Elo). Of 100 seeds, B swept 16, A swept 14 and 70 split.
  - Split by whether B's solver ran: B won 56.6% (69/122) where it ran and 42.3% (33/78) where it did not. That split
    is biased by outcome. The solver starts at four Pokémon left in total, which B mostly reaches while winning, and
    games where it never ran were identical configurations.
  - Verdict: no measurable effect. It stays off until the evaluation it scores leaves with is improved.
- **Budget (`budget`, 200 games).** 32 worlds × 300 ms plus 16 on close calls, against 16 × 200 ms. Running.

## Evaluation weights: configurable, and fitted

- **Engine.** `genx/evaluate.rs` now computes the evaluation as unweighted terms times a weight table.
  - The table defaults to the hand-set values. `POKE_ENGINE_WEIGHTS` names a file of `name value` lines that overrides
    any of them, and an unknown name stops the engine.
  - A `features` subcommand prints the terms, ours minus theirs, which is what the weights are fitted against.
  - With no file, 54 of 55 logged states gave identical depth-1 matrices. The 55th differed by at most 0.01 from
    summation order.
  - The tree search still runs about 2.0 million iterations a second. Engine tests: 934 pass.
  - Built into `target-next`, so the running bench's binary was not replaced. It is promoted after the bench finishes.
- **Search.** `SearchOptions.weights` passes a weights file per configuration, so a bench can put two sets of weights
  against each other.
- **Bench.** Every decision's terms from the deciding side go to `<name>.positions.jsonl`, labelled with that side's
  result.
- **Fit (`scripts/fit-weights.mjs`).**
  - Logistic regression pulled toward the current weights, with the current weights rescaled to predict wins first.
  - Five-fold held-out log-loss, split by game. The written weights keep the current overall scale.
- **First fit, 6,559 ladder positions from 284 games.** Current weights, rescaled: 0.5861. Best fit (strongest pull):
  0.5871. Freer fits overfit (0.6425 at the weakest pull).
  - 284 games cannot improve on the current weights. The largest moves were Leech Seed −30 → −39, poison −10 → −18.5
    and confusion −20 → −8, none of them supported on held-out games.
  - As a predictor of the final result, the current evaluation is overconfident: the best scale is 0.0079 against the
    search's 0.0125. That affects how sharply the search's rewards separate; it is untested.
  - More data comes from the bench's position logs. The `guards` run (guards on against off, 200 games) is queued after
    `budget`, and records positions.

## Certain knockouts passed up when the opponent moves first (2026-09-25)

- **What the replays showed.** In the logs, Jev picked an attack that knocked the target out at every roll and the
  blend played something else instead. Most of those turns were status moves: Gogoat's Milk Drink next to a Horn Leech
  on a 19% Darkrai, Palossand's Shore Up next to Earth Power, and Calm Mind, Roost, Recover and Rest. The rest were
  weaker attacks: Rapid Spin, U-turn, Flame Charge, Population Bomb. `freeKnockoutPassedUp` caught none of these.
  - It stood aside whenever the opponent certainly moved first.
  - It never looked at attacks, though its own comment named Rapid Spin over Ice Beam on a 20% Whiscash as a case.
- **The argument.** Whatever the opponent does first falls into one of three cases.
  - It leaves the knockout standing.
  - It stops the knockout while a status move of ours would still have worked: Protect, a heal, Substitute, a screen,
    raised defences, our attack lowered, a burn on a physical attacker, weather or terrain, an item taken, Destiny Bond.
  - It knocks us out or stops us moving (sleep, paralysis, a flinch, Encore). That costs the other move just as much.
  - So a move of ordinary priority is skipped even when their hit might knock us out first.
  - A move that goes first (Prankster, Protect, priority attacks) is skipped only when nothing it would beat to the
    punch knocks us out or is likely to stop us moving. Klefki's Prankster Spikes beside Dazzling Gleam in a speed tie
    stays skipped.
- **`beforeOurHit`.** Each move the opponent could use first is classified.
  - A weakening is tested against how far the knockout overshoots. A burn does not save a 1% Pyroar from an Earthquake
    that deals half its HP when halved, but it does save a 60% one.
  - Status and stat changes are checked against our immunities: Fire types, Guts, Clear Body, Clear Amulet, our
    Substitute.
  - A screen that is already up is already in the numbers. Aurora Veil needs snow.
- **Other changes to the guard.**
  - Priority counts a possible Prankster in any sampled set. Grimmsnarl's Reflect had been read as priority 0.
  - Protean and Libero typings count when the opponent moves first.
  - It stands aside behind a possible Illusion.
  - A knockout that charges first, certainly fails, or faints the user (Explosion, Mind Blown) is never insisted on.
  - Weaker attacks are held to the knockout only when it costs nothing the attack would not: no recoil, no stat drop, no
    recharge, no lock. Wood Hammer, Close Combat and Brave Bird knockouts are still left to judgement. So is a Speed
    boost that outruns the opponent next turn (Rapid Spin, Flame Charge, Dragon Dance).
- **Fallback.** A guard entry can now name the action that beats the one it skips (`prefer`), and the decision loop
  takes that next. Without it, Toucannon's skipped Roost fell back to a switch to Pachirisu, not the Knock Off.
- **On the logs (6,689 move decisions).** The guard now changes 35 turns in 28 games, 33 of them blend decisions. The
  fallback is the knockout in 26; in the other 9 it is another attack that also knocks out.
  - When the bot did play the knockout with the opponent moving first, it landed 53 times.
  - It missed 7 times, all to our full paralysis, a flinch, Encore or a forfeit. Each of those would have cost a status
    move as well.
- **Anomaly checked.** Groudon's Precipice Blades on Jumpluff was not a Flying-immunity bug: Jumpluff had
  Terastallized to Steel.
- **Tests.** Three new ladder-review tests (Gogoat, Jumpluff's Strength Sap, the burn overshoot) and the updated
  Maushold case, where Population Bomb is now skipped. There is also a decision-loop test for the preferred fallback,
  which fails without it. 418 pass.

## Ditto: Imposter in the engine (2026-09-25)

- **What happened.** In 2687491039, Jev put 0.44 on bringing Ditto in after Hariyama fell to a +3 Skeledirge, 0.70 on
  the next forced switch, and 0.65 a turn later. The search gave Ditto 0.01–0.04 of its visits each time, so Jirachi
  came in instead, and Perrserker was sent into Incineroar's Will-O-Wisp and Flare Blitz.
  - poke-engine had no Imposter and no Transform. Imposter was only a name in its ability list.
  - In the search, our Ditto was a Pokémon with base 48 in every stat whose one move, Transform, did nothing.
- **Engine.**
  - On entering, Imposter copies the opposing active Pokémon: its typing (not a Tera), its stats other than HP, its
    ability, its moves at 5 PP each, and its stat stages. HP, item and status stay Ditto's own.
  - It fails into a Substitute or a fainted target, and the copied ability's own switch-in effect does not fire.
  - On switching out it turns back into a Ditto: Transform only, Imposter, and Ditto's own stats.
  - The engine's base-stat table covers only form changers, and recalculating from it panics for Ditto. So Ditto's
    stats are restored from its flat 48s instead.
  - The move change is a new `ChangeMove` instruction carrying the id difference. That keeps every instruction at the
    engine's six bytes, which a test enforces. PP goes with a `DecrementPP` beside it.
- **Search.** A transformed Ditto is written with Imposter as its base ability, so the engine turns it back into a Ditto
  when it leaves during the lookahead.
- **Effect on that game (16 worlds × 200 ms, one lane).**

  | Turn | Ditto's score, old → new | Ditto's visits, old → new |
  | --- | --- | --- |
  | 13, forced switch | 0.22 → 0.45 | 0.02 → 0.03 |
  | 15 | 0.18 → 0.29 | 0.19 → 0.49, now the top choice over Perrserker |
  | 16, forced switch | 0.20 → 0.46 | 0.04 → 0.23 |

  - On turn 13, Jirachi still outspeeds the 27% Skeledirge and knocks it out, and its Unaware would ignore a copied +3.
- **Checks.**
  - Engine tests: 233 unit and 675 battle-mechanics tests pass, including three new ones.
    - Ditto copies a +3 Skeledirge on entry.
    - It turns back on switch-out and copies again on returning.
    - It fails into a Substitute.
  - On 240 logged positions, the depth-2 matrices from the old and new binaries matched everywhere except positions with
    an Imposter Ditto. The only other differences were 0.01, from the weights table's summation order.
  - TypeScript: 418 pass.
- **Deployed.** `target/release/poke-engine` was replaced while the bot ran. The old binary is kept as
  `poke-engine.before-imposter`. This also promotes the weights-table build, whose default weights reproduce the old
  evaluation.
- **Also.** `freeKnockoutPassedUp` doubles secondary chances for a possible Serene Grace user, so a Jirachi's Iron Head
  counts as a 60% flinch. The engine already doubled them.

## Review of the 7 games after the peak, and `needlessGamble` (2026-09-25)

- **Games.** 2687507386 through 2687513738: 5 wins and 2 losses, with the rating peaking at 2210.
- **`needlessGamble` blocked a near-certain win.** In 2687507386, turn 16, Cinccino's Tail Slap knocked a Toxtricity
  out 84% of the time and moved first. Jev (0.49) and the search (0.996 of visits, score 0.96) both chose it. The guard
  sent Ting-Lu in instead, which the search scored 0.43: the 16% chance of losing Cinccino outweighed everything else.
  - The guard weighed only the chance of losing our Pokémon. It never counted what the switch costs: the switch-in
    takes a hit coming in, and another if it is slower.
  - An attack is now staked only when the chance of losing our Pokémon × (30 + its HP), plus the entry hit a free
    switch-in saves after a faint, outweighs the switch-in's hits. The 30 is what the engine counts for a Pokémon being
    alive.
  - Status gambles keep the old test, because a status move that lands still leaves the target on the field.
  - On the logs, 22 of 129 skipped attacks are released. These include Tail Slap, Hurricane and Triple Axel, and attacks
    whose switch-in would have taken a hit of up to 95%. Sure losses that meet a switch-in which wins cheaply stay
    skipped.
  - One new test: at 26% Volcanion, Acrobatics (a 69% knockout, moving first) is no longer blocked; at 29% (an 8%
    knockout) it still is. 419 pass.
- **Looked at and left alone.**
  - The Strength Sap loop in 2687513738 (15 turns at full HP) answered a Regidrago that used Dragon Dance every turn,
    and the bot won.
  - The switching between Granbull and Chi-Yu against a +3 Cobalion in 2687500903 was resist-switching in a lost
    position.
  - In 2687511902, the search gave up Dragapult to keep Excadrill against a +4 Mimikyu. Every option lost a Pokémon
    there.
- **`freeKnockoutPassedUp` against large search leads.** It overrules the search's top pick on 133 logged decisions:
  - 32 of them with a lead above 0.05, and 4 above 0.1.
  - The largest leads were big setup moves (Shell Smash, No Retreat), the moves the engine's +30-per-stage boost value
    inflates.
  - Left as is. The honest fix is in the evaluation's boost terms, which needs a bench.

## Engine gaps: Rage Fist and Anger Shell (2026-09-25)

- **Audit.** 203 abilities appear in the Gen 9 Random Battle sets, and 18 of them are never referenced in the engine.
  Those are Multitype (handled through Judgment and the plates), Harvest, Cursed Body, Frisk, Synchronize, Unnerve,
  Illusion, Dancer, Early Bird, Cud Chew, Sniper, Cheek Pouch, Tera Shift, Power Spot, Cute Charm, Electromorphosis,
  Anger Shell and Poison Puppeteer. Among Gen 9 moves, Rage Fist was a flat 50 base power.
- **Rage Fist.**
  - Engine Pokémon carry `times_attacked`, written as a 30th field. The field is optional, so older states still load.
  - A damaging hit on a Pokémon that carries Rage Fist counts, through a reversible `ChangeTimesAttacked` instruction.
    Only Rage Fist users count, so every other hit's instruction list is unchanged and none of the 900-odd existing
    engine tests moved.
  - Rage Fist is 50 base power plus 50 per hit, capped at 350.
  - The tracker counts hits for every Pokémon, not only the leads, and the search writes the count.
  - In 2687500903, on turns 14–16, Annihilape's Rage Fist scored 0.43–0.57 in the new engine against 0.27–0.45 before.
    The lookahead now sees it growing as Annihilape takes hits.
- **Anger Shell.** It fires where Berserk does: dropping below half HP from a hit gives +1 Attack, Special Attack and
  Speed, and −1 Defense and Special Defense.
- **Still missing.**
  - Random effects: Cursed Body, Harvest, Synchronize, Poison Puppeteer. The engine's on-hit hook cannot branch on a
    chance.
  - Electromorphosis needs Charge to end after an Electric move, which the engine never does.
  - Illusion and Dancer.
  - Minor effects with no impact on the search: Frisk, Power Spot, Cute Charm, Unnerve, Cud Chew, Cheek Pouch, Early
    Bird, Sniper.
- **Checks.**
  - Engine: 233 unit and 679 battle-mechanics tests pass, including four new ones: Rage Fist's power, counting only for
    Rage Fist users, serialization with old states still loading, and Anger Shell.
  - TypeScript: 420 pass.
  - Depth-2 matrices on 245 logged positions match the previous binary except in the positions with a Rage Fist or Anger
    Shell user.
  - Deployed; the previous binary is kept as `poke-engine.before-ragefist`.

## Lock-in moves and unrevealed opponents (2026-09-25, audit-v6)

- In 2687511902, Kingdra's +3 Outrage knocked Hydreigon out. An unrevealed Mimikyu then came in immune, used Swords Dance
  twice while Kingdra stayed locked in, and swept.
- The payload already named revealed teammates that take nothing from a rampage move. It now also reports the Pokémon
  not yet seen, under `wouldAccomplishNothing.possible` for the move:
  - how many are unrevealed;
  - the share of the Random Battle pool that takes nothing from the move, by type or by an absorbing ability (weighted
    by set), with species already seen left out;
  - the chance that at least one of them does.
- For Outrage the share is 6% (the Fairy types). With five unseen, that is a 29% chance.
- `inference.unrevealedTypePool` carries the pool's types and abilities. The glossary line for `possible` now covers
  unrevealed Pokémon. `INSTRUCTIONS_VERSION` is `2026-09-25-audit-v6`.
- One new test; 421 pass.

## Should the search overrule guards? (2026-09-25)

- **Measured.** Of 154 logged guard skips with search values, 57 went against a search lead above 0.05, 28 above 0.1
  and 16 above 0.15. The big leads fall into three groups:
  - **Guard bugs already fixed:** Tail Slap (`needlessGamble`), Serperior's Substitute (`futileSubstitute`).
  - **Correct skips with a poor fallback:** Flamigo's Tera Close Combat three times, now fixed by falling back to the
    same move without Tera; Double-Edge for a Fake Out that also knocked out, which fell to a switch; Recover at full HP.
  - **Setup the evaluation inflates:** Shell Smash, No Retreat, Roost.
- **Decision.** No blanket veto. It would restore Recover at full HP and redundant Teras along with the rare real
  mistake.
- **What changed instead.** A guard's `by`, when it names a legal move, is now the fallback after the plain twin, as
  `prefer` is. That covers `dominatedMoves`, `lethalPriority`, the healing-over-a-knockout guard and Rest. A switch named
  in `by` (`needlessGamble`, `preserveSoleDefensiveAnswer`) is left to the ranking: across the logs the search rated
  another move above it in three of four cases.
- 421 pass.

## Bench `defence`, and the first weights fit that beats the current ones (2026-09-25)

- **`defence` (184 of 200 games, stopped).** The engine whose defensive boosts count only against the current opponent's
  attacks won 87 of 184 against the live engine: 47.3%, 95% range 40.2–54.5%, about −19 Elo.
  - Reaching significance needed 27 wins from the 16 games left, so the run was stopped.
  - Reverted (a3c36c4). The live binary never had it.
  - One game (seed 32, B as p1) spanned a 6.5-minute sleep with the lid closed on battery.
  - A defensive boost has value beyond the Pokémon now out: the opponent can switch in something it does stop.
- **Guards on against off.** Not run; it was queued behind `defence` and cancelled with it.
- **Weights fit on the 9,882 positions from those 184 games** (`scripts/fit-weights.mjs --bench defence`).
  - Held-out log-loss, split by game: current weights rescaled 0.5490, fitted (pull 0.1) 0.5289. This is the first fit
    to beat the current weights; the 284 ladder games alone could not.
  - The largest moves: speed boost 30 → 15; defense and special defense boosts 15 → 8 and 7; asleep per turn −12.5 →
    −8; paralysed −25 → −41; toxic −30 → −72; burn-boosted 50 → 7; Sticky Web −25 → −11; matchup 0 → 6.
  - They agree with the known overvaluation of boosts and sleep.
  - Written to `logs/weights/fitted-bench.txt`. Not deployed: predicting results better is not playing better, so a
    bench of fitted against current weights has to decide (`SearchOptions.weights` per side).

## Stretching the Jev credit (2026-09-25)

- About $0.94 of the $5 was left: roughly 60 ladder games at 12,600 input tokens a call (median payload 32.7 KB) and
  28 calls a game.
- Jev is no longer asked in two cases:
  - When there is one legal action (2.8% of logged calls).
  - In blend, when the search puts at least `JEV_SKIP_AT_SEARCH_SHARE` (default 0.7) of its visits on one action (18.1%
    of calls).
- At 0.7 of the visits the blend cannot be turned by Jev: another action has at most 0.3, and Jev would need a lead of
  over 0.93 to overcome it. The near-tie rule cannot apply either. Only a guard's fallback order changes, and it now
  uses the search's ranking.
- Across 7,555 logged blend decisions, those turns played the search's choice 96.1% of the time. The saving is about
  21% of calls, roughly 60 → 78 games on the remaining credit.
- Decisions record `providerSkipped`, and the live view shows "Jev: not asked".
- One new test. It covers a decisive search, a split search that still asks, 0 turning the skip off, and a single legal
  action. 422 pass.

## `npm run review` (2026-09-25)

- `scripts/review.mjs` runs the checks that found most of today's misplays by hand, over the last N battles. It flags:
  - `guard-overruled-both`: a guard skipped the move Jev and the search both chose, when the search preferred it by
    at least 0.05;
  - `guard-vs-search`: a guard skipped the search's choice for one it rated at least 0.1 lower;
  - `knockout-passed`: a certain first-strike knockout was passed up;
  - `did-nothing`: our move was immune or failed;
  - `fainted-on-entry`: a switch-in at half HP or more fainted before it acted;
  - `repeated-status`: the same status move three turns running at full HP.
- Each battle also gets a luck line, so bad luck is not mistaken for a misplay.
- On the last 10 battles it gave 14 flags. They include Tail Slap, No Retreat, Kingdra's Dragon Dance over Outrage on
  turn 12, the Outrage into Mimikyu, the Dragapult sacrifice and the Strength Sap loop: every case the manual review
  found. Deliberate low-HP sacrifices are left out.

## Engine: Cursed Body, Synchronize, Poison Puppeteer, Electromorphosis, and Disable and Charge made real (2026-09-25)

- **Disable** set its volatile and blocked nothing, for the move itself and for Cursed Body. It now disables the
  target's last-used move until it switches out; the real move lasts four turns, and the search rarely looks further.
- **Cursed Body** (Gengar, Froslass, Banette, Polteageist, Dragapult): a damaging hit is disabled 30% of the time,
  modelled as a secondary effect the way Flame Body and Static are.
- **Synchronize** (Mew, Umbreon): a burn, paralysis or poison from the opponent is passed back to it, subject to the same
  immunity checks.
- **Poison Puppeteer** (Pecharunt): each poison chance comes with a confusion chance. Showdown ties the two together;
  here they are independent.
- **Electromorphosis** (Bellibolt): a hit charges the holder. **Charge** now ends with the next Electric attack; before,
  it doubled every one until switching out.
- **Left out.**
  - Harvest: 50% a turn outside sun, which the engine's end-of-turn step cannot branch on, and none of its Random
    Battle users sets sun.
  - Illusion, Dancer, and the effects that do not matter to the search (Frisk, Unnerve, Cud Chew, Cheek Pouch, Early
    Bird, Sniper, Power Spot, Cute Charm).
- **Checks.**
  - Engine: 233 unit and 684 battle-mechanics tests pass, including five new ones: Disable, Cursed Body at 30%,
    Synchronize, Electromorphosis's charge and its end, and Poison Puppeteer.
  - On 245 logged positions, every depth-2 matrix that changed came from one with these abilities or Disable or Charge
    (74 had one, mostly among the sampled unrevealed Pokémon).
  - Deployed; the previous binary is kept as `poke-engine.before-abilities`.

## Gap audit: moves, status effects and items (2026-09-25)

- **Moves.** Of the 348 moves in the Random Battle sets, 29 are written as code in Showdown and appear in the engine
  only as data.
  - Most are covered some other way. Taunt, Yawn and Heal Block are enforced through their status effects; Triple Axel
    is three hits of 40 (120 in all, as the real 20 + 40 + 60); Supercell Slam and High Jump Kick crash; and every
    Random Battle Curse user is non-Ghost, whose boosts are modelled.
  - The rest are situational or rare: Stomping Tantrum, Lash Out, Fickle Beam, Psychic Fangs and Brick Break breaking
    screens, Shell Side Arm choosing its category, Bleakwind Storm in rain.
- **Status effects set but never read.** Moves set 39 volatile statuses that the engine reads at most twice outside the
  move table. The one that mattered was Throat Chop (23 sets): its volatile was set, and sound moves (Boomburst, Hyper
  Voice, Bug Buzz, Torch Song, Sparkling Aria) were never stopped. They now fail beside Taunt and Heal Block, until the
  Pokémon switches out (two turns in Showdown). Disable had the same fault and was fixed earlier today.
- **Items.** Of the 60 items in the sets, three are never referenced: Light Clay (8-turn screens, past the search's
  horizon), Scope Lens (a crit rate) and Leppa Berry (one set). The rest are handled where the engine applies them.
- Engine: 233 unit and 685 battle-mechanics tests pass, including a new Throat Chop test. Deployed; the previous binary
  is kept as `poke-engine.before-throatchop`.

## Timed effects reach the engine with the turns they have left (2026-09-25)

- The search wrote every timed effect as if it had just started:
  - screens, Mist, Safeguard and Tailwind at 5 turns;
  - weather, terrain and Trick Room at 5;
  - every volatile duration at 0.
- So a Reflect about to end read five turns, a Trick Room on its last turn read five, and a Yawn due to put us to sleep
  this turn read a turn away. Slow Start written at 0 counted down past zero and never ended, leaving Regigigas weakened
  for good. The tracker already had the start turns (`effectStartTurns`, each condition's and volatile's `sinceTurn`)
  and a record of rampages.
- Now written:
  - Screens and the rest: 5 (Tailwind 4) less the ends of turn seen.
  - Weather, terrain and Trick Room likewise.
  - Durations: Encore and Taunt count ends of turn to 2, Yawn to 1, and Slow Start down from 6.
  - An Outrage lock, when the request offers only the rampage move, or for the opponent after its first turn. It is
    written only when the rampage move is the last move used and is in the written moveset, since the engine repeats a
    move by its slot.
  - An effect started before turn 1 counts from turn 1.
- Checks:
  - One new test. It sets up Reflect, Tailwind and Trick Room on turn 2, Taunt on turn 2 and Yawn on turn 3, and an
    opposing Outrage, then reads them on turn 4. 423 pass.
  - The live engine took all 830 logged positions with timed effects without an error. The 15 that could not be written
    fail the same way before this change: they are old logs without `movePP`.
- `npm run review` no longer flags a knockout that would cost our Pokémon to recoil (Squawkabilly at 13% took a Tera
  Facade over a Brave Bird whose recoil would have knocked it out as well), a Tera'd move that knocks out, or a move
  whose target had already fainted.

## The opponent's Choice lock reaches the engine (2026-09-25)

- Our own lock reaches the engine from the request. The opponent's never did: every move of theirs was written as
  available. So a sampled Choice Band set locked into Close Combat could still pick Shadow Claw at the root, and a Ghost
  switching in to take the lock looked worse than it was.
- The opposing active's other moves are now closed when its sampled set holds a Choice item, or has Gorilla Tactics,
  and it has used a move since coming in. The tracker clears the last move on switching. The move must be in the
  written moveset. Across worlds the lock follows each set's item, so it is as likely as the sets make it.
- The engine already locks a Choice holder after a move inside the search; only the starting position lacked it.
- Also found and left: a pending Future Sight is never written, since the engine takes it by turns and user slot. It is
  rare in the sets.
- One new test; 424 pass. The engine took all 830 logged positions with timed effects.

## Effects the engine reads that never reached it (2026-09-25)

- The search passes a volatile to the engine only if it is on an allow-list. Several that the engine reads were
  missing, or the tracker never recorded them:
  - Smack Down (grounding), Tar Shot (Fire at double), Charge, Throat Chop and Torment are now on the list. The
    tracker already recorded each from its `-start` line.
  - **Two-turn moves** (Phantom Force, Shadow Force, Dig, Fly, Bounce, Dive, Solar Beam and Blade, Meteor Beam,
    Electro Shot, Sky Attack and the rest): the tracker now records `-prepare` as a volatile that lasts until the
    holder next moves. The engine then treats the holder as out of reach and forces the strike next turn. Before, a
    Phantom Force in progress looked like an opponent free to do anything.
  - **Type changes** (Soak, Protean, Libero, Burn Up): the typing is written as changed, with the species' own as the
    base types, and a `TYPECHANGE` volatile so the engine reverts it on switching out. Burn Up's `???` is written as
    Typeless.
  - **Truant**: a Truant Pokémon that moved last turn, since its latest switch-in, carries `TRUANT`, so the engine knows
    it loafs this turn. Before, Slaking looked able to attack every turn.
  - **Unburden**: set once the holder's item is lost while it is out.
- Checks:
  - One new test covering Protean's typing, Smack Down, Truant on and off, and Phantom Force's charging turn. 425 pass.
  - The engine read a position carrying all of them, and the opponent's only option was the Phantom Force strike. It
    took all 830 logged positions with timed effects.

## Future Sight and Harvest (2026-09-25)

- **Future Sight** (120 power, landing at the end of the second turn after) never reached the engine, which models it.
  - The tracker now records it per side, as Wish, from the `-start` on its user. It clears it on the `-end` Showdown
    announces on the target.
  - The search writes the turns left, 3 less the ends of turn seen, and the caster's slot, whose stats the engine uses.
    It outlasts the caster switching out.
- **Harvest** (Exeggutor, Exeggutor-Alola, Tropius, Trevenant, Arboliva) brings back an eaten berry at the end of the
  turn, always in sun and otherwise half the time.
  - The engine's end-of-turn step could not branch. It now returns the extra outcomes it splits into; its five callers
    keep them beside the rest, and each outcome's percentage is halved.
  - The berry restored is Sitrus, which every Random Battle Harvest set carries.
  - The search tells the engine of Harvest only once a berry was eaten (`lastBerry`). Knocked off or tricked away, there
    is nothing to bring back, and the engine cannot tell the two apart.
- Checks:
  - Engine: 233 unit and 687 battle-mechanics tests pass, including new ones for Harvest (a 50% split, 100% in sun,
    nothing while a berry is held) and a pending Future Sight striking.
  - TypeScript: 426 pass, including Future Sight written and cleared, and Harvest after an eaten berry but not after
    Knock Off.
  - On logged positions only those with a Harvest user changed. Deployed; the previous binary is kept as
    `poke-engine.before-harvest`.

## Illusion: finding a disguised Zoroark before the hit that breaks it (2026-09-25)

- Zoroark and Zoroark-Hisui enter looking like the last Pokémon in their party. The tracker already re-identified one
  when a damaging hit broke the disguise (`replace`); until then the bot played against the disguise.
- Two clues now give it away sooner (`src/strategy/illusion.ts`):
  - **A move the disguise can never carry and a Zoroark form can**, by the Random Battle movepools: Bitter Malice or
    Poltergeist for Zoroark-Hisui, Dark Pulse, Encore, Psychic or Sludge Bomb for Zoroark. A move both forms carry is
    settled by the moves already shown, with Zoroark-Hisui otherwise. Moves called by another move, and a transformed
    user, are left out.
  - **An unexplained immunity**: our attack had no effect where the disguise's typing would take it and a Zoroark
    form's does not (Fighting, Normal or Ghost into Zoroark-Hisui; Psychic into Zoroark). Immunities from an ability
    (`[from] ability`), and Terastallised, transformed or type-changed targets, are left out.
- The Pokémon is then treated as that form while it stays in: species, and details at the form's Random Battle level,
  so its sets, typing and stats reach the payload, the calculator and the search. The side is marked
  `identityUncertain`, which quiets the guards that rely on identity, and a note joins `uncertainties`. On switching
  out, the entry reverts to the disguise and loses the Zoroark's own moves, so the real Pokémon of that name is not
  confused with it. The disguise returns on every switch-in.
- Replayed over the logs: in 2686970208 the opponent's Zoroark, disguised as Chimecho, is found on turn 36, when our
  Psychic Noise had no effect. The disguise broke on turn 44. The one other logged break was our own Zoroark, correctly
  left alone.
- One new test covering both clues, the revert on switch-out, and two non-triggers (Gholdengo's own Ghost immunity to
  Fighting, and an immunity from an ability). 427 pass. The engine took all 830 logged positions.

## Setup against an attack in a near tie goes to Jev (2026-09-25, audit-v7)

- In the three games after reaching the top 100 (1–2), the blend chose a Dragon Dance three times where Jev wanted the
  attack and the search's scores were within 0.03. The search had twice the visits, so the 2026-09-24 visits rule gave
  it the pick.
  - Lapras set up on a 29% Seviper, which hit it to 11% and switched out.
  - Feraligatr set up into Glare.
  - Crawdaunt set up into Close Combat.
- `blendChoice` now gives the provider the pick when the search's choice raises our own stats (a self-targeted boost,
  or Belly Drum, No Retreat, Clangorous Soul, Fillet Away, Geomancy, Tidy Up), the provider's is an attack, and the
  scores are within the margin, whatever the visits.
  - Two attacks keep the visits rule.
  - A lead beyond the margin stays with the search.
- Replayed over the last 30 games it changes 7 of 846 decisions, all setup to attack, 5 of them in losses. The
  Calm Mind over Judgment test (2687148187) now expects Judgment.
- The visits rule was made because Jev's bias against setup was passing into play. This exception covers only
  setup against an attack at under 0.03, where the search's +30 a stage is the likelier error. It cannot be benched
  offline, since the bench plays without Jev.
- 427 pass. `INSTRUCTIONS_VERSION` is `2026-09-25-audit-v7`, to separate these games.

## Reverted: setup against an attack goes back to the visits rule (2026-09-25, audit-v8)

- Live for four ladder games (3–1), audit-v7 changed three decisions. One was Coil → Supercell Slam, in a win. The
  other two were Florges' Calm Mind → Moonblast against a Calm Mind Latias, in the loss to My Life is Dance
  (2687703481). On turn 17 the plain blend had Calm Mind (0.35 against Moonblast's 0.275; search 0.422 on 44% of
  visits against 0.404 on 17%). The exception gave the turn to Jev, who put 0.52 on Moonblast and 0.14 on Calm Mind.
  Latias kept boosting, and by turn 19 Moonblast did at most 12.9% into its 50% heals.
- Three punished Dragon Dances against one blocked Calm Mind is too few either way. Jev's lean against setup is the
  documented bias the visits rule was written to keep out of play, so the rule stands without the exception.
- Jev's 30% weight still decides some turns against a clearly better search choice. Over the last 40 games it
  outvoted the search's top pick, leading by 0.03 or more, in 13 of 1,090 decisions: 7 switch against switch,
  3 status over an attack, and 1 setup over an attack (Calm Mind 0.684 against Moonblast 0.645, turn 23 of the same
  game).
- `INSTRUCTIONS_VERSION` is `2026-09-25-audit-v8`.

## Lash Out doubles in the engine (2026-09-25)

- poke-engine priced Lash Out at 75 base power always. In 2687705634 Sinistcha, at 18%, used Strength Sap into
  Oinkologne's Lash Out: the search gave it 0.842 on 76% of visits, expecting a heal to full. The Attack drop doubled
  Lash Out, which knocked Sinistcha out from full HP.
- Lash Out now doubles when its user moves second and the opponent's move surely lowered its stats first: Strength Sap,
  a status move's own drop, or a secondary drop with no chance roll. It also doubles after an Intimidate switch-in.
- Clear Body, White Smoke, Full Metal Body, Mirror Armor, Contrary and Clear Amulet block it. So does a Substitute,
  except against Intimidate. Inner Focus, Oblivious, Own Tempo, Scrappy and Guard Dog block only Intimidate's drop.
- The same turn replayed: Strength Sap 0.842 → 0.727 (49% of visits). It stays narrowly on top, because Sinistcha dies
  either way and the drop stays on Oinkologne for the rest of the team.
- Three engine tests: doubled after Eerie Impulse and after Strength Sap; not doubled moving first or holding Clear
  Amulet; doubled against an Intimidate switch-in. The engine suite is 233 unit and 690 battle-mechanics tests, all
  passing.

## Our transformed Pokémon's moves come from the request (2026-09-25)

- On '-transform' the tracker copied only the moves the target had shown. Our Ditto as Latias (2687703481) had Psyshock,
  which Latias had not used yet, so the search held no value for it: 0% of visits, no score. Jev asked for it at 0.44 and
  0.33 on turns 21 and 26. The guards skipped Recover at full HP, and Ditto switched out both times.
- The request lists every move a transformed Pokémon has, so our copy now takes its moves from it. Those moves are
  also recorded as revealed on the target, whose full set Transform has shown.
- Replayed with all four moves, Psyshock scores 0.330 and 0.363. Against a +2/+2 Latias with Recover, the search still
  leans to Recover or the Florges switch, but it now weighs the attack.

## A restart mid-game no longer opens a second ladder game (2026-09-25)

- The bot was restarted mid-game to deploy the audit-v8 revert. On logging in it searched the ladder at once. The game
  in progress (2687705634) then arrived and was taken as the match, and counted a second time against MAX_BATTLES. The
  search itself stayed open on the server and matched Seit417 three seconds later (2687707629).
- That room was ignored, being a second battle. When the first game ended, the bot tried to rejoin it: it sends a leave
  first, so the join replays the battle. The server answers that leave with a deinit, which was taken as the battle
  being unavailable, so the room was dropped just before its join succeeded. The game was lost on the timer (2248 →
  2231).
- `LadderQueue` now holds any search until the server's first search update after login, or three seconds of silence.
  A game that update lists is rejoined first.
- A deinit answering our own rejoin leave is ignored. A battle that opens while another is being played is logged, and
  joined before any search or challenge once the current one ends.
- One new ladder test covers the restart order and the silent server. 429 TypeScript tests pass. Preflight over the
  last 10 games gives no warnings.

## Guards and fallbacks that pushed Florges and Ditto around (2026-09-25, audit-v9)

The loss in 2687703481 had Florges and Ditto swapping in and out against a Calm Mind Latias. Each swap was a guard
overruling the search, or a guard's fallback. Four fixes:

- **`outhealed` leaves our own heals alone.** It skips attacks that cannot outpace an opponent's heals, but it also
  skipped Florges's Synthesis, the search's pick on 53% and 62% of visits, with "cannot outpace" as the reason. The
  fallback was a switch to Ditto both times. Status heals are now `healAtFullHP`'s to judge.
- **`healAtFullHP` allows for a faster hit.** It no longer skips a heal when the opponent surely moves first with an
  attack it has shown that can hurt us, since the heal then restores that hit. Rest is still skipped. An attack we are
  immune to does not count, so Florges's Synthesis against Latias's Draco Meteor alone is still idle. In the last 40
  games this keeps 3 heals the guard had skipped live. Two were real (Boomburst took 35% before Ho-Oh's turn, Wave
  Crash 54% before Noctowl's). The third was our Scarf Ditto, which the next fix handles.
- **A same-turn switch is a fresh matchup for `cyclicSwitch`.** The guard held Sawsbuck in against Morpeko, though the
  search had 68% of its visits and Jev 62% on switching to Florges, because Morpeko arrived on the same turn as
  Sawsbuck. Both switches were chosen blind, so Sawsbuck was never picked for Morpeko. It was knocked out by Aura
  Wheel. A pivot that chose its replacement after the opponent's switch is still held.
- **A guard's fallback keeps the Tera rule.** It no longer plays a Tera the search visited less than the same move
  without it. Sawsbuck's fallback was Jev's Double-Edge + Tera Normal, on 3% of visits against the plain move's 5%.
- Tests: the Florges heals under both guards, the same-turn and pivot cycles, and a DecisionLoop fallback test, which
  fails without the change. 433 pass. Preflight over 40 games gives no warnings.

## Our transformed Pokémon keeps the stats it copied (2026-09-25)

- Showdown's request carries a transformed Pokémon's own stats. The tracker wrote them over the copied ones, so our
  Choice Scarf Ditto as Latias was modelled with Ditto's Speed and Special Attack. `turnOrder` put it behind the Latias
  it outran, and the damage estimates and the engine gave it Ditto's weak hits.
- Copied stats now survive the request. When the target is an opponent whose exact stats are unknown, they are worked
  out at its level with the Random Battle spread: 85 EVs, 31 IVs, neutral nature. Only the rare set with 0 Attack or
  Speed IVs differs. Until the first request, all estimates for the copy used to be dropped ("whose stats are not
  known"); they now go ahead.

## `SEARCH_IN_PAYLOAD` defaults to showing the search in blend too (2026-09-25)

- `.env` had `SEARCH_IN_PAYLOAD=true` from 2026-09-24 14:57 UTC, which nobody meant to set. Every game since, the
  climb into the top 100 included, was played with Jev seeing the search's shares.
- Ladder records in blend:
  - shown to Jev: 50 of 82 won (61%);
  - shown, before the setting existed: 97 of 152 (64%);
  - hidden: 24 of 50 (48%).
- The hidden games all came on 2026-09-24, alongside other changes, so this is not a clean test. It is the evidence
  there is, and it runs against the reason for hiding them (counting the search twice).
- The default is now to show the shares in every mode, and `SEARCH_IN_PAYLOAD=false` hides them. The stray line in
  `.env` is back to blank. Play is unchanged, since the default is what was running.
- `INSTRUCTIONS_VERSION` is `2026-09-25-audit-v9`.

## Let the doomed Pokémon go: `savingTheDoomed` (2026-09-25, audit-v10)

- In 2687729196 Poliwrath, at 23%, faced a Flamigo that had shown Close Combat. The search rated every option 0.013 to
  0.014 on even visits, a lost position by its reckoning, so Jev's 0.42 on switching to Baxcalibur decided it.
  Baxcalibur came in at 57%, fell to 8% and fainted the next turn. Poliwrath came back and fainted anyway, and Flamigo
  swept.
- The new guard applies when a revealed attack that cannot miss knocks our active out at every sampled roll. It skips
  a switch whose Pokémon, after entry hazards, would lose more HP to every such attack than switching saves, and at
  least half of its own. Switching saves our active's HP plus Regenerator's third.
- Cleared stat drops or effects are left out of what switching saves: they only help a Pokémon that survives, which
  is what the switch-in pays for. A switch-in that resists stays open, and a healthy active is never let go, because
  no switch-in can lose more than it has.
- Replayed over all 324 logged games, it would have skipped 31 played switches (0.4% of move decisions). The switch-in
  often fainted soon after (Ditto, Ursaluna, Stantler, Ceruledge, Stonjourner, Slowking, Hitmonchan) or lost a large
  share: Ting-Lu fell to 7% to save a Staraptor at 1%. We lost 22 of those 31 games, which is outcome-biased but
  consistent.
- Test: Baxcalibur is skipped and a resisting Slowking is not; at full HP nothing fires.

## Two-turn charges in reach keep the estimates (2026-09-25)

- Since '-prepare' was recorded as a volatile (c51fb91), a charging Eternatus counted as an unmodelled volatile, which
  dropped every damage estimate for that turn. Charges that leave their user in reach change no damage, so they now
  count as modelled: Meteor Beam, Electro Shot, Solar Beam and Blade, Skull Bash, Sky Attack, Razor Wind, Freeze Shock,
  Ice Burn and Geomancy.
- Fly, Dig, Dive, Bounce, Phantom Force and Shadow Force stay unmodelled, since their user cannot be hit.
- 435 tests pass. Preflight over 40 games gives no warnings. `INSTRUCTIONS_VERSION` is `2026-09-25-audit-v10`.

## `outhealed` skips attacks, not Rapid Spin, hazards or our own heals (2026-09-25, audit-v11)

- In 2687740108 Avalugg's Rapid Spin, the search's pick at 0.63, was skipped three times against a Recover Toxapex, the
  last time for Recover at 0.52. Rapid Spin is used for the hazards, not the damage, and the guard counted it as one
  more hit that Toxapex outheals.
- Now left alone:
  - Rapid Spin and Mortal Spin;
  - phazing attacks (Circle Throw, Dragon Tail) and Clear Smog;
  - hazards and screens, which pay whatever the target heals;
  - Defog, Court Change or Tidy Up while hazards sit on our side;
  - our own heals (as in audit-v9).
- Other idle status moves are still skipped, as before.
- The Wish/Protect test no longer expects Stealth Rock to be skipped. A new test covers Rapid Spin against Toxapex.
  436 tests pass, and preflight over 40 games gives no warnings.

## A heal at full HP is not "certain to fail" against a faster hit (2026-09-25, audit-v12)

- In 2687779585 Reuniclus, at full HP, faced a +1 Life Orb Falinks at 3% that had shown Knock Off. The search's pick
  was Recover (0.692 on 36% of visits). `certainlyFails` removed it: viability.ts counted every heal at full HP as
  certain to restore nothing.
- Psyshock was played. Knock Off took Reuniclus to 20% and knocked off its Life Orb, then Life Orb recoil knocked
  Falinks out before Psyshock could land. Recover would have restored the hit.
- `hitBeforeHeal` in viability.ts now serves both that rule and `healAtFullHP`. A heal at full HP counts as idle only
  unless the opponent surely moves first with a shown attack that can hurt us. Only our own Pokémon is judged,
  since its speed is known.
- Over all logged games, 6 of 9 live full-HP heal skips are lifted. In 4 the opponent did hit first (Regidrago,
  Floatzel's 54%, Dudunsparce's Boomburst, this Falinks). In one, Tropius moved first without damaging us. The sixth
  is the Ditto turn logged before its copied stats were kept.
- Test: Recover is ruled out while Falinks has shown only No Retreat, and kept once Knock Off is shown. 437 pass.

## Asleep without Sleep Talk, sleep alone no longer forces a switch (2026-09-26, audit-v13)

- `certainlyFails` skipped every move of a sleeper that could not wake this turn, which left only switches. In
  2687779585 Misdreavus, asleep at 50%, was switched to Greninja. The search had staying at 0.563 against 0.370, and
  Pachirisu's Thunderbolt knocked Greninja out.
- Every move fails alike while asleep, and choosing one still counts a sleep turn down, where a switch keeps it. So
  without Sleep Talk or Snore, the sleep reason no longer skips anything; other certain failures still do. With Sleep
  Talk or Snore, the other moves still give way to it.
- In the logs, sleep forced 3 switches, all to Pokémon the search rated below staying: Greninja fainted, and
  Indeedee took 45%.
- Test covers both cases. 438 pass.

## A fired charge move stops charging, and a nearly spent active is let go (2026-09-26, audit-v14)

- **Power Herb and second turns.** In 2687788784 Eternatus's Power Herb Meteor Beam fired the turn it charged, but
  '-prepare' had marked it charging and nothing cleared the mark. Next turn the engine offered only Meteor Beam, the
  search put 100% on it, and Eternatus charged a real one into Gothitelle's Psychic Noise. Trapped at 32%, it died
  after firing it.
  - An '-anim' of the charged move on the same turn now clears the mark. That covers Power Herb, Solar Beam in sun
    and Electro Shot in rain.
  - The second turn's `[from] lockedmove` now ends it too; it had counted as a called move and left the mark standing.
  - Re-tracking that game leaves Eternatus with no charge on turn 4.
- **`savingTheDoomed` widened.** In 2687786966 Iron Leaves at 3%, certain to fall to Morpeko-Hangry's Aura Wheel, was
  switched to a Quaquaval that lost 26%. The search preferred Leaf Blade by 0.053. Iron Leaves came back to faint the
  next turn, and every switch fed Morpeko another Speed boost. The half-of-its-HP bar kept the guard quiet.
  - For an active at 35% or less, losing a fifth of a bar is now enough.
  - Over all logs, the search split evenly on such switches: it preferred staying in 37 of 71 cases (median gap
    0.002), so the guard rarely overrules a confident search.
- Tests: the Power Herb, charge and fire sequence; Iron Leaves and Quaquaval. 440 pass. Preflight gives no warnings.

## An eaten berry stays eaten, and a sleeper is switched only for an answer (2026-09-26, audit-v15)

- **Consumed items came back.** Showdown reports a Sitrus Berry as `-enditem ... [eat]` and then its heal as
  `-heal ... [from] item: Sitrus Berry`. The tracker read the second line as revealing the item and put the berry back.
  - In 2687862037 Drifblim therefore kept its berry in our state, and its Unburden was never counted.
  - The speed model had our Arcanine at 208 outspeeding a Drifblim really at 374. Drifblim knocked Arcanine out before
    it moved.
  - The same happened to every berry, Power Herb and White Herb followed by an effect line.
  - A `[from] item:` line no longer sets the item when that item was lost earlier the same turn.
  - With the berry gone, the same position gives Drifblim 374 and "theirs first".
- **`asleepWhileTheyBoost` needs an answer.** It skipped a sleeping Iron Jugulis's moves for a switch to Arcanine, the
  search's lower pick (0.170 against staying at 0.197). Arcanine took 61% on entry and fell before moving, and Iron
  Jugulis then fell asleep in. It was the guard's only live firing in the logs.
  - It now fires only when some switch-in answers the booster: it lives through its entry, then either lives through a
    second hit or moves first.
  - The original Reshiram test now has a Toxapex answer. Its Gardevoir version, slower and badly hit by Sludge Bomb, no
    longer fires.
- Tests: the berry heal line; both sleeper cases. 441 pass.

## A heal loop we are losing is broken: `losingHealLoop` (2026-09-26, audit-v16)

- In 2687868557 Vigoroth, paralysed, used Slack Off six turns running against a Duraludon at 47%. Each 50% heal met a
  46% Flash Cannon. One full paralysis took it from 51% to 5%, and Duraludon never lost a point. The search put about
  60% of its visits on Slack Off throughout; the loss is past its horizon.
- Across the logs there were 19 runs of three or more heals against the same opponent that left its HP untouched. We
  won 5 of those 18 games, against about 60% overall. The runs by statused Pokémon lost our own HP in every case but one.
- The guard skips a heal once it has been used twice running when our active is paralysed, poisoned or burned, and the
  heal's average return is below the least the opponent's strongest revealed attack takes. The average return is a
  quarter less for paralysis, and poison or burn chip is taken off. Rest, which cures the status, is left alone.
- Over all logged games it changes 10 played decisions: Vigoroth ×4, Ho-Oh ×4 (badly poisoned), Vespiquen ×1 and
  Noivern ×1. Nine were in losses; in the Noivern win the search already rated Hurricane above Roost.
- Test: paralysed Vigoroth is skipped; once cured it is not. 442 pass.

## Illusion: a move whose type is set in battle is no clue (2026-09-26, audit-v17)

- In 2687882615 our Oricorio-Sensu used Revelation Dance, which is Ghost-type in its hands, into a switching-in
  Maushold-Four. A real Normal-type is immune to that. The immunity clue used the move's listed type, Normal, and
  decided "a Normal move had no effect on a Normal-type, so this is a Zoroark-Hisui".
  - From turn 5 the bot played against a Pokémon that wasn't there. It switched in Grimmsnarl, which Population Bomb
    knocked out; it used Quiver Dance; it used a Tera Fighting Roost.
  - The game was lost to a player rated 55 below us.
- The clue now ignores moves whose type is set in battle: Revelation Dance, Tera Blast, Weather Ball, Judgment,
  Multi-Attack, Techno Blast, Ivy Cudgel, Raging Bull, Aura Wheel, Hidden Power, Nature Power, Terrain Pulse, Tera
  Starstorm and Struggle. It is also ignored when our attacker's ability rewrites move types: the -ate abilities,
  Normalize and Liquid Voice.
- Of the three unmasks since the detector shipped, the other two were right: a real Zoroark appeared in both games.
- The test fails on the old tracker and passes now. 443 pass.
- Ladder since audit-v11: 7 wins in 23 games against 11.8 expected, about 2 SD below. The guards added since then
  barely fired: losingHealLoop never, the tightened asleepWhileTheyBoost once. The most active overrides were
  freeKnockoutPassedUp (14 skips in 9 games, 3–6, by 0.071 of search score) and savingTheDoomed (9 skips in 7 games,
  4–3). Twenty-three games cannot separate these from luck; a self-play A/B can.

## Self-play: the guards added since audit-v11 are neutral (2026-09-26)

- `newguards` compared the current bot (B) with the same bot without freeKnockoutPassedUp, savingTheDoomed and
  losingHealLoop (A). Both sides searched with 16 worlds × 200 ms and no Jev, over 100 seeds played both ways.
- B won 101 of 200 = 50.5% [95% 43.6–57.4%], about 3 Elo. Sweeps were 20 to 19, with 61 split pairs.
- These guards are not what cost the ladder games since audit-v11 (7 won of 23, against 11.8 expected). A regression
  of the ~150 Elo that slump would imply would have shown here. They stay; neither is measurably good or bad in
  self-play.
- What the bench cannot see is their interaction with Jev, and the non-guard changes: the full-HP heal exemption, the
  sleep rule, and the tracker fixes. The tracker fixes are corrections, and the Illusion misread (audit-v17) cost one
  of those games outright.

## Self-play: the full-HP heal exception and the sleep rule are neutral (2026-09-26)

- `healsleep` put the current bot (B) against the same bot with the pre-audit-v12/v13 rules added back (A):
  every heal at full HP skipped, and every move of a sleeper that cannot wake skipped. It was 100 seeds played both
  ways, with no Jev.
- B won 99 of 200 = 49.5% [95% 42.6–56.4%], about −3 Elo. Sweeps were 16 to 17, with 67 split pairs.
- With `newguards` (50.5%), none of the rule changes since audit-v11 measures as a regression. The current rules stay.

## Sweep for bugs and gaps over the last 60 games (2026-09-26, audit-v18)

- **No errors in 1,702 decisions.** Every choice was sent and every move decision had a search result. Jev fell back
  6 times: 4 HTTP 500s from the provider and 2 timeouts, each played on the search's ranking.
- **Fixed: a replace line without HP.** When Illusion ends, the opponent's `|replace|` line carries no HP. Parsing it
  anyway left a "Malformed HP condition ignored" note in every later decision state of the game (42 states), and
  those notes reach Jev's payload. The HP is now kept from the switch-in and no note is added.
- **Set data is complete.** 35 forms seen in the logs have no entry of their own in gen9-sets.json: cosmetic forms,
  and battle forms such as Maushold-Four, Dudunsparce-Three-Segment, Palafin-Hero, Mimikyu-Busted, Eiscue-Noice and
  Terapagos-Terastal. All of them resolve to candidate sets, 1 to 31 each.
- **The engine has no gaps.** 511 sampled positions rebuilt with no errors and no placeholder Pokémon. Cosmetic forms
  (Alcremie, Vivillon) reach the engine under their base species, with the same stats.
- Preflight over 60 games gives no warnings and no unavailable estimates. 445 tests pass.
