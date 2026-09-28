#![cfg(feature = "gen9")]

use poke_engine::choices::Choices;
use poke_engine::engine::abilities::Abilities;
use poke_engine::engine::evaluate::evaluate;
use poke_engine::engine::generate_instructions::generate_instructions_from_move_pair;
use poke_engine::engine::state::MoveChoice;
use poke_engine::search::expectiminimax_search;
use poke_engine::state::{PokemonMoveIndex, PokemonType, State};
use std::sync::{Arc, Mutex};

fn leaf_blade_position(hp: i16, armor: bool) -> State {
    let mut state = State::default();
    let attacker = state.side_one.get_active();
    attacker.level = 100;
    attacker.attack = 100;
    attacker.speed = 200;
    attacker.types = (PokemonType::GRASS, PokemonType::TYPELESS);
    attacker.replace_move(PokemonMoveIndex::M0, Choices::LEAFBLADE);
    let defender = state.side_two.get_active();
    defender.hp = hp;
    defender.maxhp = 300;
    defender.defense = 100;
    defender.types = (PokemonType::WATER, PokemonType::TYPELESS);
    defender.ability = if armor { Abilities::SHELLARMOR } else { Abilities::NONE };
    defender.replace_move(PokemonMoveIndex::M0, Choices::SPLASH);
    state
}

// Independently inspect the generated outcomes: the solver must weight these by their probabilities,
// not evaluate one average noncritical hit. The raw evaluation is deliberately not a win probability.
fn outcome_value(state: &mut State, branch: bool) -> (f32, f32) {
    let action = MoveChoice::Move(PokemonMoveIndex::M0);
    let outcomes = generate_instructions_from_move_pair(state, &action, &action, branch);
    let mut value = 0.0;
    let mut knockout_percent = 0.0;
    for outcome in outcomes {
        state.apply_instructions(&outcome.instruction_list);
        value += outcome.percentage * evaluate(state) / 100.0;
        if state.side_two.get_active_immutable().hp == 0 { knockout_percent += outcome.percentage; }
        state.reverse_instructions(&outcome.instruction_list);
    }
    (value, knockout_percent)
}

fn solver_value(state: &mut State) -> f32 {
    expectiminimax_search(state, 1,
        vec![MoveChoice::Move(PokemonMoveIndex::M0)],
        vec![MoveChoice::Move(PokemonMoveIndex::M0)],
        false, &Arc::new(Mutex::new(true)))[0]
}

#[test]
fn endgame_leaf_blade_includes_one_in_eight_critical_knockouts() {
    let mut state = leaf_blade_position(300, false);
    let before = state.serialize();
    let (expected, knockout) = outcome_value(&mut state, true);
    assert!((knockout - 12.5).abs() < 0.001, "only a critical Leaf Blade KOs this target: {}", knockout);
    let (average_only, no_crit_ko) = outcome_value(&mut state, false);
    assert_eq!(no_crit_ko, 0.0);
    assert!((average_only - expected).abs() > 1.0);
    assert!((solver_value(&mut state) - expected).abs() < 0.001,
        "endgame must retain Leaf Blade's critical-hit branch");
    assert_eq!(state.serialize(), before);
}

#[test]
fn endgame_respects_critical_immunity() {
    let mut state = leaf_blade_position(300, true);
    let before = state.serialize();
    let (expected, knockout) = outcome_value(&mut state, true);
    assert_eq!(knockout, 0.0);
    assert!((solver_value(&mut state) - expected).abs() < 0.001);
    assert!((outcome_value(&mut state, false).0 - expected).abs() < 0.001);
    assert_eq!(state.serialize(), before);
}

#[test]
fn endgame_also_preserves_damage_roll_knockout_chances_without_criticals() {
    let mut state = leaf_blade_position(220, true);
    let (expected, knockout) = outcome_value(&mut state, true);
    assert!(knockout > 0.0 && knockout < 100.0, "the target straddles the damage range: {}", knockout);
    assert!((solver_value(&mut state) - expected).abs() < 0.001,
        "a possible knockout must not be rounded into one deterministic average hit");
}
