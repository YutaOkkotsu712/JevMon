# Latest 20 battles and final-knockout handling — 2026-09-28

Scope: the newest 20 completed local logs at the start of this follow-up, plus the user's Life Orb question
about Iron Leaves in 2688538865. No strategy weights, guard rules, search budgets, or live process controls
were changed. Earlier authorized fixes in the workspace were retained.

## Frozen cohort

**523 decisions, 10 wins / 10 losses**, ending at 2026-09-27 18:54:34 UTC (2026-09-28 00:24:34 IST).
All decisions had search results and matched the command sent; no provider fallbacks or server errors.

| Battle | Result | Decisions |
| --- | --- | --- |
| 2688796928 | Loss | 38 |
| 2688795704 | Win | 30 |
| 2688794487 | Loss | 26 |
| 2688793515 | Win | 22 |
| 2688792613 | Loss | 26 |
| 2688779907 | Loss | 42 |
| 2688776918 | Win | 16 |
| 2688776507 | Win | 7 |
| 2688775767 | Win | 19 |
| 2688774504 | Win | 29 |
| 2688772902 | Win | 11 |
| 2688771767 | Win | 18 |
| 2688770692 | Loss | 33 |
| 2688769698 | Loss | 20 |
| 2688768317 | Win | 19 |
| 2688766079 | Loss | 46 |
| 2688764981 | Loss | 32 |
| 2688764000 | Win | 19 |
| 2688762774 | Loss | 27 |
| 2688761269 | Loss | 43 |

## Verified fixes

### Sawsbuck seasonal switch scores

2688771767 turns 1–8: the engine received `SAWSBUCK`, but the application looked up `sawsbuckwinter`.
Sawsbuck's scores were null and shares zero; at turn 3, the remaining action shares totaled only 43.7%.
This is a wiring defect even though the game was won.

Switch lookup now uses the existing cosmetic canonicalization for Sawsbuck. Spring/base, Summer, Autumn
and Winter are covered; the server switch slot is unchanged. Other species mappings are unchanged by this
follow-up. Six of seven new tests failed before the fix; the base-name control already passed. All seven
pass afterward, including real MCTS, forced replacement and endgame searches. Reconstructed turns 1, 3 and
8 retain finite Sawsbuck scores and total shares within rounding of 100%. These are fresh searches, not
recovery of the original votes. Current switch names match engine species throughout all 523 decisions.

### Life Orb final double knockout was assigned to the wrong side

Independent Showdown simulations confirm that a last-target knockout followed by Life Orb fainting the
attacker is the attacker's win, from either player side. The engine formerly checked whether side one had
any HP first, so both teams at zero always meant side one lost. The bot always searches from side one.

The Gen 9 move-completion path now preserves the winner from faint order when both teams are exhausted.
The new instruction reverses with the move and the optional state suffix round-trips without changing old
nonterminal state strings. Both MCTS and endgame search read that result. A living opposing reserve still
makes a recoil-fainted attacker's exhausted team lose. A critical-only win branch is kept separate from
the noncritical loss branches, with no winner leaking between search branches.

This follows [Showdown's faint processing and checkWin](https://github.com/smogon/pokemon-showdown/blob/master/sim/battle.ts).
The independent simulator also verifies ordinary move recoil, Rocky Helmet, Rough Skin, Destiny Bond,
Explosion's opposite faint order, and Protect, from both sides.

### Endgame cutoff ignored completed wins and losses

At its last search ply, expectiminimax used the material evaluator even when the game had ended. A regression
with a 1-HP attacker gave **31 points for a guaranteed final knockout versus 60 for Swords Dance**. With fatal
Life Orb recoil, a completed win could instead leave zero material. A deeper terminal node only added a
depth-dependent bonus; at the cutoff that bonus was zero.

Gen 9 completed outcomes now receive a finite terminal payoff of ±1,000,000, including at the cutoff.
The existing material evaluator, chance weighting, depth bonus, and search budgets are unchanged. This is
a correction to completed-game scoring, not a calibrated win probability or a retuning of material weights.
Other generations retain their previous terminal-scoring behavior.

### Residual damage continued after the game ended

A second terminal regression showed a 1-HP burned attacker winning with its hit, then being incorrectly
fainted by end-of-turn burn. Showdown ends that battle before the residual. Gen 9 end-of-turn processing
now stops when a move has already ended the game. Ordinary ongoing turns keep their existing residual logic.

### Optional Python interface

The engine's new final-result field is carried through the optional Python interface. Compile verification
also exposed the missing Python mapping for the earlier Disable duration/slot field; that mapping is now
complete, with backward-compatible constructor defaults. The live bot uses the engine executable, not this
Python interface.

## What this establishes about Iron Leaves

At 2688538865 turn 54, Iron Leaves had **69/275 HP**, Life Orb, Tera Fighting, and **no hazards on our side**.
Life Orb costs floor(275/10) = 27 HP per damaging move: two attacks cost 54, leaving 15 HP if nothing else
damages it. Thus recoil alone was not a reason to sacrifice it, even without invoking the final-double-KO rule.
Leaf Blade retained its Grass STAB. On a free entry it could knock out the 52% Vaporeon and threaten Groudon;
the opponent still had Tera available, so this is not proof of a forced win.

The original position was also replayed at fixed depths in one fixed reconstructed world:

| Depth | Before terminal fixes | After terminal fixes |
| --- | --- | --- |
| 1–2 | Approximately 99.97% Iron Leaves switch | Same preference |
| 3 | 81.4% Mach Punch, 18.5% Facade | Approximately 99.98% Mach Punch |
| 4 | 55.2% Mach Punch, 26.6% Facade, 18.1% switch | Approximately 99.97% Mach Punch |
| 5 | 65.2% Mach Punch, 31.8% Facade, 3.0% switch | 59.1% Mach Punch, 4.6% Knock Off, 36.2% switch |

The cutoff's preference for keeping a burned Guts Conkeldurr remains at shallow depth. The terminal bugs
are independently verified, but the original sampled worlds and reached depth were not logged. These
replays do not establish a single cause of the original sacrifice or guarantee its elimination at every
depth. No preservation rule or extra search time was added to force a preferred answer.

## Other flagged turns examined

- **2688766079 turns 5/20:** Brambleghast created Substitute before Toxic on that same turn. The substitute
  was not already up when the decision was made. No status-immunity or state-tracking defect established.
- **2688761269 turns 12–13:** Urshifu survived entry; Sleep Talk called Body Slam, paralyzed it, and a second
  Body Slam knocked it out next turn. The opponent also revealed Tera Ghost. This was not a one-hit entry KO.
- **2688769698 turns 6/10:** Misdreavus took sun-boosted Flare Blitz; Glastrier took newly revealed Close
  Combat. Both survived entry and fainted on the following turn. No additional mechanics defect established.
- **2688770692 turn 13:** Cursed Body disabled Moonblast and Taunt blocked setup, leaving Body Press into
  Froslass's immunity. The switching guard correctly recognized the current legal moves. Turn 17's
  Bombirdier entry was critically hit; Dedenne later died to a boosted, faster Triple Axel.
- **2688762774 turn 19:** Lugia displayed as 0% after rounding but actually had 1 HP and paralysis. The
  replacement ranking was poor, but those logs do not establish a faulty HP or type calculation.
- **2688779907 turns 23–24:** Electrode survived a critical Thunderbolt on entry, then died to Explosion.
  **2688794487 turns 17–18:** Gouging Fire critically hit Barraskewda and then Lanturn with Outrage.
- **2688792613:** a different Iron Leaves had Choice Band, not Life Orb. Haxorus boosted Speed and Attack
  and then swept. Its identity and item should not be mixed with the Vaporeon/Groudon game.

No new behavioral rule was added for these questionable choices without an established implementation bug.

## Verification

- Full application suite: **535 passed**, zero failed/skipped, including UI and real-engine integration tests.
- Full Gen 9 engine suite: **975 passed**, including seven new terminal-result regressions.
- Independent Showdown oracle: **18 cases passed**, across both player sides.
- Three full local simulator games: **182, 91 and 67 decisions**, no rejected actions or simulator errors.
  These use deterministic/mock decisions and do not measure ladder strength.
- TypeScript and release-engine builds passed. Optional Python binding compile check passed.
- `git diff --check` passed. No bot stop/restart, commit or push was performed. A running TypeScript process
  may still need a restart to load the Sawsbuck lookup change.
