# Battle audits and verified fixes — 27 September 2026

The user requested a refreshed latest-20 audit during this work. The initial audit remains below for traceability;
the refreshed cohort and additional fixes follow it. The latest cohort ends at **2688617050**, with 623 decisions.

## Scope

Frozen cohort: 2688520213 through 2688541875, ordered by completion, not file modification time.
7 wins, 13 losses; 665 logged decisions. Reviewed the turn summaries and automated flags, then inspected the
underlying protocol, tracked state, search inputs and relevant code for suspect positions. Flags are leads, not
proof of bugs. All 665 decisions had search results and their executed command matched the selected command.
No server error lines; one provider fallback at 2688524078 turn 5, which still sent a legal replacement.

| Battle | Result | Audit finding |
| --- | --- | --- |
| 2688541875 | Loss | Illumise's turn-30 sacrifice was selected by the blend; search slightly preferred Iron Hands. No verified mechanics defect in that choice. |
| 2688540894 | Loss | No additional verified bug. |
| 2688538865 | Loss | Iron Leaves endgame investigated below. Mimikyu's turn-10 switch lost to Grav Apple; Close Combat immunities on turns 28/49 followed opponent switches into Houndstone. |
| 2688538024 | Win | No additional verified bug. |
| 2688537291 | Win | Poison immunities followed switches into Forretress. No additional verified bug. |
| 2688535781 | Loss | Minior switch scores discarded; Meteor/core identifiers disagreed with stats. Clodsire fell to newly revealed Tera Ice; Slowbro's turn-18 sacrifice remains a strategic failure, with the omitted Minior option also affecting the available search evidence. |
| 2688535072 | Win | Sunflora's Tera guard incorrectly *described* Earthquake as moving first. Corrected its explanation only. Weather Ball without Tera did KO Ursaring. |
| 2688533951 | Loss | Gastrodon-East switch scores discarded. Turn-17 Close Combat immunity followed a switch into Spectrier. |
| 2688532939 | Loss | Turn-11 immunity belongs to Close Combat called by the opponent's Encore, not the chosen Knock Off. No additional verified bug. |
| 2688532027 | Loss | Consecutive Protect overrides match the existing rule. Whether that rule is desirable is a strategy change, not a verified implementation defect. |
| 2688530857 | Win | No additional verified bug. |
| 2688527737 | Loss | Sucker Punch failed into Roost; other sacrificial choices did not establish a mechanics defect. |
| 2688527067 | Win | Minior switch scores discarded and its simulated Shields Down transition missed. |
| 2688526074 | Win | Dachsbun died on entry to a critical Thunderbolt from +2 Minun. The critical hit is recorded. |
| 2688525603 | Loss | No additional verified bug; five full-paralysis turns are recorded on our side. |
| 2688524912 | Loss | Cinderace fell to newly revealed Tera Ground Ribombee. No verified immunity/type-tracking defect. |
| 2688524078 | Win | Cursed Body disabled Passimian's Knock Off on turn 6; search/threat inputs still allowed it on turns 7–8. Covered by the pending Disable fix. |
| 2688522049 | Loss | Swalot's replacement and subsequent faint were checked; they do not establish a coding bug or a guaranteed superior line. |
| 2688521370 | Loss | The other Iron Leaves game: it fell to +1 Masquerain's Hurricane while Choice-locked. Distinct from the Vaporeon/Groudon endgame. |
| 2688520213 | Loss | The Mismagius guard override matched its existing rule. Six Bulk Ups increased stats to +6; they were not attempts to boost past the cap. |

## Verified fixes

### Missing Minior and Gastrodon switch results

The engine received `MINIOR` / `GASTRODON` but the result lookup wanted `miniorindigo` / `gastrodoneast`.
The logged switches therefore had zero share and null scores, even when those switches were the only legal action
(2688535781 turn 21 and 2688533951 turn 25). This is the same mapping defect previously fixed for Alcremie.

The lookup now agrees with the state writer for Minior's core colours and Gastrodon's forms. Minior's current
Meteor form remains mechanically distinct. Other species' existing mappings and the server's team slots are unchanged.
Regression coverage includes every core colour, both Gastrodon appearances, ordinary MCTS, forced replacements,
the endgame solver, finite scores, and preservation of total action share.

### Minior's Meteor stats with a core identifier

At 2688527067 turn 17 the private request named `Minior-Indigo`, but the actual stats were Meteor's:
Attack/Defense/Sp. Atk/Sp. Def/Speed = 140/204/140/204/140. The engine received those stats under `MINIOR`.
After Shell Smash plus Close Combat reduced HP below half, it believed Minior was already in core form and did
not apply Shields Down's stat change.

The adapter now uses the form already identified by the existing private-stat fitter. The same replay generates
the form change and raises base Speed from 140 to 235, with the corresponding offensive/defensive changes.
An independent local Showdown simulator battle confirmed Meteor → Indigo and those exact stats.

### Disabled Knock Off still offered

2688524078 turns 7–8 reproduce the earlier Hitmontop/Triple Axel bug: a named Disable volatile did not restrict
the serialized opponent's move choices. The fix passes the named slot and remaining duration, removes
the move from immediate threats, expires it in simulated turns, and clears it on switching. It does not infer
the disabled move from a later `lastMoveUsed`, or release an unrelated Choice lock on expiry.

### Tera guard explanation

2688535072 turn 25 said Tera Fire would let Ursaring's Earthquake knock Sunflora out **first**, although that
guard had not established move order. The explanation now describes the damage consequence without inventing
an order. Its blocked-action set is unchanged.

## Iron Leaves endgame: 2688538865 turn 54

Conkeldurr had 38/299 HP and burn; Iron Leaves had 69/275 HP, Life Orb, and **Tera Fighting already active**.
Vaporeon was at 52%; Groudon remained at 88%. The solver assigned essentially all its action share to switching
Iron Leaves into Vaporeon. Scald immediately knocked it out.

The reconstructed engine input correctly includes Fighting Tera, and generating that move pair removes all
69 HP. The damage calculator predicts Scald at 29.4–35.0% of Iron Leaves' maximum HP, above its remaining 25.1%.
Original Grass/Psychic defensive resistances were not retained. Original Grass offensive STAB remains valid:
Leaf Blade could KO Vaporeon if Iron Leaves arrived free, and dealt 80.9–95.9% of the sampled Groudon's maximum
HP before accounting for its next entry hazards. Groudon had 88% HP remaining. That makes preserving Iron Leaves
a meaningful strategic consideration.

The initial typing/damage check was insufficient: after the user specifically raised Leaf Blade's high critical-hit
rate, checking the solver's chance branches revealed another defect, fixed below. In one fixed reconstructed world,
depth-1 and depth-2 matrices preferred sacrificing Iron Leaves despite correctly simulating its death; depth 3
changed that ranking with both the old and corrected solver. That is evidence of a horizon/evaluation limitation
as well as the separately verified RNG omission. The leaf evaluator also rewards burn on Guts users, which can
make a low-HP Conkeldurr worth more material than Iron Leaves at the cutoff; those tested weights were not changed.
The logged 0.500 solver score is relative to the matrix value, not a verified 50% win probability.

## Refreshed latest 20

The ten new completed games below plus the first ten games in the initial table form the refreshed cohort,
**2688532027 through 2688617050**: 10 wins, 10 losses, 623 decisions. The ten new games contain 264 decisions.
All 623 decisions had search results, matched their sent command, and had no provider fallback or server error.

| Newly completed battle | Result | Audit finding |
| --- | --- | --- |
| 2688617050 | Win | No additional verified bug. |
| 2688616411 | Win | One-turn finished game; no additional verified bug. |
| 2688615654 | Loss | No additional verified bug. |
| 2688614702 | Win | Three Quiver Dances were real boosts to +3 against opposing Calm Minds, not attempts past the cap. |
| 2688613638 | Loss | No additional verified bug. |
| 2688611951 | Win | No additional verified bug. |
| 2688611390 | Win | No additional verified bug. |
| 2688610660 | Win | Flip Turn's knockout left our replacement choices without search scores; fixed below. |
| 2688610136 | Win | Contains an active Disable position covered by the existing fix; no additional verified bug. |
| 2688608980 | Loss | Tropius overrides on turns 16/30 match the existing sacrifice rule. Protect failures and the Dragapult switch into Close Combat are recorded; no new implementation defect established. |

### Endgame solver discarded damage rolls and critical hits

`expectiminimax_search` called the turn generator with `branch_on_damage = false`, unlike MCTS. It therefore
used an average noncritical hit where a possible high roll or critical knockout should have been weighted by its
chance. Leaf Blade's increased critical rate was already implemented as 1/8 in the engine, but the endgame caller
never requested that branch. This also affects other roll-dependent knockouts, rather than being an Iron Leaves rule.

The endgame solver now requests the existing chance branches at every depth. No new preservation guard, search
time increase, priority rule or evaluation weight was added. Regression tests independently establish a 12.5%
Leaf Blade critical knockout branch, zero critical knockouts into Shell Armor, and a partial knockout probability
from ordinary rolls even with critical immunity. The two RNG regressions failed before the one-argument correction;
the immunity control passed. All three pass afterward, including unchanged state after search.

At the same fixed reconstructed position and depth 4, the old solver's refined mix was approximately 53.1% Mach
Punch / 29.0% Facade / 17.8% Iron Leaves switch; the corrected mix was 55.2% / 26.6% / 18.1%. At depth 5 it was
64.2% / 31.3% / 4.5% before and 65.2% / 31.8% / 3.0% after. At depths 1–2 both still prefer the sacrifice.
These checks **do not prove the RNG omission caused the original selected switch**, recover its random worlds,
or show that the game would have been won. The preserved chance branches fix a real defect; the questionable
heuristic preference at shallow depth remains. Existing grouped damage branches are still an approximation,
not exhaustive enumeration of every damage roll.

Eight reconstructed endgames completed with finite results under the unchanged 400 ms per-world solver setting;
the corrected one-world runs took 42–207 ms in this small timing check. This is a timeout/smoke check, not an Elo
benchmark. A same-budget Iron Leaves replay preferred Mach Punch after the fix, but timing-dependent depth makes
that weaker evidence than the controlled fixed-depth comparisons above.

### Our replacement was omitted after a pivot knockout

2688610660 turn 20: Alomomola's Flip Turn knocked out Reshiram, and Showdown requested our replacement before
the opponent's. The adapter set its free-replacement flag only if the opponent was still alive and had acted.
With the opponent fainted and our active alive, the engine therefore offered only the opponent's replacement;
all three of our legal switches received zero shares and null scores.

The flag now also covers a fainted opponent when our living active is required to switch. Faster pivots into a
living opponent and replacements of our fainted active retain their previous handling. A regression with two
legal replacements failed before the fix and now retains finite scores and total share. Replaying the actual
three-choice position now yields finite scores for Chansey, Kricketune and Ambipom, totaling 100% of search share.

## Verification and limits

- Before the new Minior/Gastrodon fixes, 14 of 16 new tests failed (the two base-name controls passed).
- **Full `npm test`: 524 passed**, none failed or skipped, including UI tests. This includes the earlier Alcremie
  regressions and 29 new TypeScript tests across this batch and the pending three-fix batch.
- Full engine tests passed: 237 library + 699 battle-mechanics + 15 damage + 13 last-used-move + 3 search-chance
  + 1 documentation = **968**.
- Three local simulator games completed: 182, 91 and 67 decisions; zero rejected actions or simulator errors.
  The third uses a mocked Jev response through the real request/payload path; this does not measure model quality.
- Fixed-world comparison against HEAD across all 665 decisions: state serialization changed only at the two
  Minior Meteor positions and two active Disable positions. `outhealed` and `redundantTera` blocked-action sets
  were identical throughout this cohort. No search weights or budgets changed.
- The complete suite's initial permission review failed due to an account usage limit. After the reported reset
  time passed, a fresh permission-reviewed run succeeded, including all temporary localhost UI listeners.
- TypeScript build and whitespace/diff checks passed. The bot was not stopped or restarted, and no commit or
  push was made. No claim is made that every running process has loaded the new TypeScript.
