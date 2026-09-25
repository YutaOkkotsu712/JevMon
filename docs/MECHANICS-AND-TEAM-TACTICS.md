# Mechanics and team tactics update

## Correctness fixes

- Bench matchups now project entry hazards before calculating incoming damage, outgoing damage and speed. This includes breaking Sturdy/Focus Sash, a hazard KO, Sticky Web and Toxic Spikes. Projections are copies; retained state is unchanged. Boots and Magic Guard prevention are respected.
- Sturdy's survival check respects Mold Breaker-style bypass, move ability bypass and Ability Shield. Mold Breaker does not bypass Focus Sash.
- Embargo/Klutz disable held-item modifiers in the damage calculator and residual healing. Perish countdown events no longer disable damage calculation.
- Multi-hit ranges model sequential hits, variable hit counts, Skill Link, Loaded Dice, increasing-power triple attacks, Substitute breaking, Sturdy/Sash, several between-hit defensive changes, Sitrus/known resist berries, and contact chip. Later hits may hit the holder after a Substitute breaks; excess damage from the breaking hit does not spill through.
- Stored Power/Power Trip use boosts. Rage Fist uses tracked direct hits when available; unknown history produces a labelled 50–350 BP range. Last Respects uses observed fainting events, retaining the count across revivals. Other previously excluded random/conditional-power moves have bounded scenarios. A range across conditional outcomes is not a probability distribution: Focus Punch may fail, Present may heal, and a reactive move may not double. Accuracy and critical hits remain separate from ordinary damage-roll envelopes.

This is not a full simulator embedded in the decision engine. Opposing choices, unobserved history, random effects between hits and unmodelled volatiles can still prevent an exact forecast. Those should not be interpreted as assured safety. The focused simulator checks below cover the specified cases, not every possible combination of effects.

## Revival Blessing

The legal revive-selection flow already existed. The generic feature layer incorrectly advertised Revival Blessing as switching its user out because of the simulator's internal `selfSwitch` marker. It now describes reviving a fainted teammate to half max HP on the bench, with candidate moves, future entry hazards and damage where private max HP is retained. PP and consumed items are not restored. Max HP is now retained through fainting, and revival selection is explicitly distinguished from a forced replacement.

In battle 2686049527, Rabsca was offered Revival Blessing earlier and selected it on turn 23, but fainted before execution. The new features explain the candidate value and preserve the existing move-order/execution-risk warning. No claim is made that a new Jev ranking has been evaluated.

## Sacrifices and pivots

A team reserve summary was written to distinguish low HP from remaining usefulness, but it was never added to the payload, so it has since been removed; the instructions state the rule directly instead. A weak Pokémon can be useful later as a sacrifice, but saving it now has a cost. Fainting to hazards may not absorb the opponent's attack, and KO-triggered boosts can punish a sacrifice.

The runtime no longer automatically rejects a switch solely because it is knocked out by the modeled incoming attack while another switch survives. That is now a strategic cost for Jev to compare. Empty switch cycles remain guarded, with an exception for a possible deliberate sacrifice.

Pivot moves explain both branches: an opposing ordinary switch resolves first, allowing our replacement to be selected after the new opponent is revealed; if the opponent attacks, a slow pivot can absorb that attack while a fast pivot exposes the replacement. Immunity, protection, a miss or contact damage can prevent a damaging pivot. This is conditional reasoning, not a trained estimate of the opponent's switching probability. Revival Blessing is not classified as a pivot.

## Validation

232 unit/regression tests passed, with the sandbox-blocked UI test rerun with loopback permission. Eight focused official simulator checks from the preceding mechanics update cover Icicle Spear, Population Bomb, Bullet Seed, Substitute interception, Stored Power, Rage Fist, Last Respects and the full Revival Blessing request/selection/restoration flow. The existing four-hit Substitute interval and sound-bypass simulator checks also passed in that update.

Run the focused checks with `SIMULATOR_DIR=/path/to/simulator node scripts/test-audit-simulator.mjs` after `npm run build`. No live or paid Jev call was made during validation.

## Self-changing moves and next-turn setup

Contrary and Simple now modify projected self stat changes exactly once, respecting ability suppression and stage caps. Attacks such as Superpower expose the projected damage of another use after their changes. Jev's instructions explicitly compare those future costs or gains with current damage and switching costs; a drop alone is not an automatic rejection.

Status setup reports current-turn order, modeled remaining HP, and next-turn order at equal priority. A slower defensive setup uses incoming damage before the defensive boost. Some-roll KO risk is uncertain rather than safe. Rock Polish and Dragon Dance regressions cover surviving an initial hit and becoming faster; Trick Room reverses the order correctly. These remain conditional one-step scenarios, not predictions of the opponent's next action.

Choice Scarf already modifies effective speed. Named Protosynthesis/Quark Drive Speed boosts now remain calculable. Sticky Web tests cover Boots, Contrary, Simple and Defiant; a capped Speed stat no longer falsely triggers Defiant/Competitive, and Klutz disables Boots. Belly Drum projects the final Attack stage rather than adding six stages to a negative starting stage.

## Payload generalisation (follow-up)

The rules were not trimmed. The payload was generalised instead, so the same rules fit:

- A Terastallise action is emitted as a delta against the move it came from — `sameAsWithoutTerastallising`
  names the base action and only genuinely different fields are written out. When nothing modelled changes,
  `nothingModelledChangesByTerastallising` says so rather than leaving a contentless action.
- Fields that describe the turn rather than the choice (`hazardExposure`, `defensiveTera`, `executionRisk`,
  `teraChangesOurForme`) are stated once in `sharedByEveryActionBelow` when every action carrying them agrees.
  This is a fixed allowlist: `turnOrder`, `damageRange` and anything else a move is actually chosen on stays
  attached to its own action, because a decision input that must be looked up elsewhere gets ignored.
- The byte budget is a relevance threshold, not a capacity one. TypeSafe's documented ceiling for jev-1.13.0
  is 32,000 tokens for state plus the longest single question, which is what applies here; measured usage is
  a median of 8,662 and a maximum of 10,940 tokens, about a third of it. `JEV_PAYLOAD_BUDGET_BYTES` defaults
  to 28,000 bytes (~11,300 tokens) because TypeSafe reports irrelevant detail reducing accuracy, so the
  headroom is not free to spend. `JEV_TOKEN_LIMIT` and `estimatedTokens` guard the real ceiling, using the
  densest byte-per-token ratio observed (2.18 against a 2.47 median) so the estimate never understates.
  An oversized payload is still sent and marked; it is never traded for a random move.

Measured over all 464 logged decisions: `reduced` now fits 247 times (was 64) and nothing exceeds the budget
(was 114). No rule text was removed.

## Species resolution

`Keldeo` matched no dataset entry because the Gen 9 pools list only `Keldeo-Resolute`, leaving that opponent
with no sets and no damage estimate at all. Dataset lookup now resolves by exact id, then cosmetic base form,
then any key sharing the species' base form. Cosmetic formes (Vivillon, Alcremie, Florges, Gastrodon, Minior,
Sawsbuck) already resolved to their base; `Keldeo-Resolute` was the only remaining orphan.
