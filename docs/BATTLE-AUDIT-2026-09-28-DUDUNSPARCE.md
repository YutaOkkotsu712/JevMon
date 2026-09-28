# Dudunsparce investigation and the next 20 completed battles

Scope: finish the reported Dipplin/Dudunsparce investigation, then audit the newest 20 completed local
battles available when this follow-up began. Fix only demonstrated implementation errors. No changes to
strategy weights, guard strengths, search budgets, prompts, or the running bot process.

## Dipplin versus Dudunsparce — 2688847541

The bad sequence is confirmed:

- Turn 18: Dipplin recovered from 150/284 HP while Dudunsparce used Calm Mind.
- Turn 19: Dragon Pulse into a second Calm Mind left Dudunsparce at 92% after Leftovers.
- Turns 20–23: full-HP Dipplin chose Recover four times; each failed while Calm Mind raised Dudunsparce
  from +2 to +6 Special Attack and Special Defense.
- Turn 24: Dipplin chose Recover again and fainted to Earth Power before it could heal.

This was not a guard forcing Recover. Search favored Recover on turns 20–22; Jev also favored it. On turns
23–24 search slightly preferred Yanmega, while the combined ranking still chose Recover. Those search
scores are internal values, not verified win probabilities.

The mechanics checks do **not** reproduce an implementation defect causing this sequence:

- Both boosts are tracked and serialized correctly. Dipplin's Steel Tera and Eviolite are represented.
- Against Calm Mind, the real engine grants both opposing boosts and gives full-HP Dipplin no healing.
- At +2, Earth Power does 50.7–59.9% in the calculator; the engine lets surviving Dipplin heal afterward.
- At +6, Earth Power does 100–118.4%; the engine removes all 284 HP and does not execute Recover.
- An independent Showdown simulation confirms the three relevant outcomes: failed full-HP recovery into
  Calm Mind, useful slower recovery into a surviving hit, and fainting before recovery at +6.

The original search tree and sampled worlds were not recorded, so their exact internal reason for preferring
Recover cannot be recovered. The checked evidence supports a strategic failure, not a missing Calm Mind,
Tera, Eviolite or recovery mechanic. No new anti-setup heuristic or blanket ban on full-HP healing was added.
The repeated-Recover choice is **not claimed fixed**. A blanket rule would also break valid slower healing:
2688837532 turns 8–10 has Slowbro-Galar correctly healing the Thunderbolt damage it takes before Slack Off.

## Frozen 20-game cohort

**546 decisions, 13 wins / 7 losses**, from 2026-09-27 19:54:39 through 20:58:14 UTC.
Every decision has a search record; selected and sent commands match. No server errors. One Jev timeout
in 2688838652 turn 4 used the existing search fallback. No current switch-name/engine-name mismatch.
Zero search-share entries at Revival Blessing's revive selection and forced Recharge are special requests,
not missing ordinary switch scores.

| Battle | Result | Decisions |
| --- | --- | --- |
| 2688851779 | Loss | 27 |
| 2688850528 | Win | 29 |
| 2688849815 | Win | 36 |
| 2688847541 | Loss | 34 |
| 2688845731 | Win | 19 |
| 2688843251 | Win | 20 |
| 2688842061 | Loss | 55 |
| 2688841679 | Win | 6 |
| 2688841043 | Win | 24 |
| 2688840255 | Win | 35 |
| 2688838652 | Win | 8 |
| 2688837532 | Loss | 37 |
| 2688833639 | Loss | 38 |
| 2688832822 | Win | 26 |
| 2688831398 | Win | 24 |
| 2688829924 | Loss | 25 |
| 2688828604 | Win | 27 |
| 2688826173 | Win | 21 |
| 2688825443 | Loss | 33 |
| 2688823986 | Win | 22 |

## Verified fixes

### Conditional priority attacks incorrectly vetoed status moves

2688831398 turn 16: `statusIntoKnockout` penalized Registeel's Thunder Wave and Iron Defense, including
their Tera variants, because the only revealed opposing attack was a lethal Sucker Punch. That attack
fails against these choices. The incorrect penalty changed the selected Thunder Wave to a Hariyama switch.

The guard now excludes Sucker Punch and Thunderclap for ordinary status choices. Their damage remains
available to the general threat calculator and to decisions involving an attack. Other revealed knockout
attacks still trigger the guard. The implementation retains Showdown's Me First exception.

### No Retreat was incorrectly projected as reusable

2688825443 turn 11: `setupRaceLost` projected Falinks from +1 to +2 Speed with another No Retreat even
though its No Retreat volatile was already active. This caused a penalty on Toxtricity's Shift Gear:
the guard claimed Falinks would reach 348 Speed versus Toxtricity's 340. That second boost cannot occur.

The guard now reuses the existing repeated-effect failure check before projecting the opposing boost.
This depends on the active volatile, not on whether No Retreat was ever used. Showdown allows reuse if
the user was already trapped and the first use did not install the No Retreat volatile; that edge case is
independently tested. Existing repeatable-setup and priority/Trick Room controls remain in the full suite.

Mechanics reference: [Showdown move implementations](https://github.com/smogon/pokemon-showdown/blob/master/data/moves.ts).

## Other suspicious sequences checked

- 2688833639 turns 4–6: Ariados's repeated Sticky Web choices never executed because Iron Head flinched it;
  Web was not already installed. The later repeated Will-O-Wisp attempts were also checked against protocol.
- 2688842061 turn 42: both attacks had zero PP; the unchanged +5 boosts follow an interrupted Calm Mind,
  not a missing boost update. The Vespiquen healing stall and later switches remain strategic concerns.
- 2688841043 turns 1–3/15: Protect, Truant's loafing turn and a forced recharge explain the missing attacks.
  The adapter already carries the relevant turn state.
- 2688840255 turn 24: switching Dedenne away from 1% Flapple was questionable, but the opponent could use
  Grav Apple after the preceding Outrage. No new forced-stay rule was introduced.
- The remaining failures/immunities were checked against switches, newly revealed moves/types, sleep,
  depleted PP and protocol events. A loss, missed prediction, flinch or critical hit alone was not classified
  as an implementation bug.

## Verification

- Three new regressions failed before the fixes: Sucker Punch, Thunderclap and active No Retreat.
  The Dudunsparce mechanics control already passed. All four pass afterward.
- Full `npm test`: **539 passed**, zero failed or skipped, including UI and real-engine checks.
- Replaying the two changed guard functions over all **546** frozen decisions changes their output only
  at the two verified positions above; the other **544** are identical. This compares guard outputs on
  recorded states, not counterfactual battle outcomes or future model decisions.
- Independent Showdown checks: **11 passed** via `scripts/test-guard-mechanics-simulator.mjs` with
  `SIMULATOR_DIR` pointing to an installed `@pkmn/sim` package.
- Existing full local simulator suite: **182 / 91 / 67 decisions**, no rejected actions or simulator errors.
  These are integration checks using deterministic/mock decisions, not a ladder-strength measurement.
- TypeScript build and `git diff --check` passed. No Rust implementation changed in this follow-up;
  the earlier complete engine gate remains recorded in the preceding audit.
- No bot stop/restart, commit or push. Changes are built on disk; an already-running TypeScript process
  may retain its previously loaded code until restarted.
