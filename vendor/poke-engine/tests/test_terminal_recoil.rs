#![cfg(feature = "gen9")]

use poke_engine::choices::Choices;
use poke_engine::engine::generate_instructions::generate_instructions_from_move_pair;
use poke_engine::engine::items::Items;
use poke_engine::engine::abilities::Abilities;
use poke_engine::engine::state::{MoveChoice, PokemonVolatileStatus};
use poke_engine::mcts::perform_mcts;
use poke_engine::search::expectiminimax_search;
use poke_engine::state::{pokemon_index_iter, PokemonIndex, PokemonMoveIndex, PokemonStatus, PokemonType, SideReference, State};
use std::sync::{Arc, Mutex};
use std::time::Duration;

fn position(orb: bool, reversed: bool, reserve: bool) -> State {
    let mut state = State::default();
    for index in pokemon_index_iter() {
        state.side_one.pokemon[index].hp = 0;
        state.side_two.pokemon[index].hp = 0;
    }
    let attacker = state.side_one.get_active();
    attacker.hp = 1;
    attacker.maxhp = 100;
    attacker.item = if orb { Items::LIFEORB } else { Items::NONE };
    attacker.types = (PokemonType::GRASS, PokemonType::PSYCHIC);
    attacker.speed = 200;
    attacker.replace_move(PokemonMoveIndex::M0, Choices::LEAFBLADE);
    attacker.replace_move(PokemonMoveIndex::M1, Choices::SWORDSDANCE);
    let defender = state.side_two.get_active();
    defender.hp = 1;
    defender.maxhp = 100;
    defender.types = (PokemonType::WATER, PokemonType::TYPELESS);
    defender.replace_move(PokemonMoveIndex::M0, Choices::SPLASH);
    if reserve { state.side_two.pokemon[PokemonIndex::P1].hp = 100; }
    if reversed { std::mem::swap(&mut state.side_one, &mut state.side_two); }
    state
}

#[test]
fn life_orb_final_double_knockout_awards_the_attacker_on_either_side() {
    for reversed in [false, true] {
        let mut state = position(true, reversed, false);
        let before = state.serialize();
        let action = MoveChoice::Move(PokemonMoveIndex::M0);
        let outcomes = generate_instructions_from_move_pair(&mut state, &action, &action, true);
        assert_eq!(state.serialize(), before);
        for outcome in outcomes {
            state.apply_instructions(&outcome.instruction_list);
            assert_eq!(state.side_one.get_active_immutable().hp, 0);
            assert_eq!(state.side_two.get_active_immutable().hp, 0);
            assert_eq!(state.battle_is_over(), if reversed { -1.0 } else { 1.0 });
            assert_eq!(State::deserialize(&state.serialize()).battle_is_over(), state.battle_is_over());
            state.reverse_instructions(&outcome.instruction_list);
            assert_eq!(state.serialize(), before, "terminal outcome must reverse with the move");
        }
        let result = perform_mcts(&mut state, vec![action.clone()], vec![action], Duration::from_secs(1), 32);
        assert_eq!(result.s1[0].total_score / result.s1[0].visits as f32, if reversed { 0.0 } else { 1.0 });
        assert_eq!(state.serialize(), before);
    }
}

#[test]
fn life_orb_double_knockout_is_still_a_loss_if_the_defender_has_a_reserve() {
    for reversed in [false, true] {
        let mut state = position(true, reversed, true);
        let before = state.serialize();
        let action = MoveChoice::Move(PokemonMoveIndex::M0);
        for outcome in generate_instructions_from_move_pair(&mut state, &action, &action, true) {
            state.apply_instructions(&outcome.instruction_list);
            assert_eq!(state.battle_is_over(), if reversed { 1.0 } else { -1.0 });
            state.reverse_instructions(&outcome.instruction_list);
            assert_eq!(state.serialize(), before);
        }
    }
}

#[test]
fn endgame_recognizes_a_final_knockout_at_the_leaf_instead_of_preferring_a_boost() {
    for orb in [false, true] {
        let mut state = position(orb, false, false);
        let before = state.serialize();
        let scores = expectiminimax_search(&mut state, 1,
            vec![MoveChoice::Move(PokemonMoveIndex::M0), MoveChoice::Move(PokemonMoveIndex::M1)],
            vec![MoveChoice::Move(PokemonMoveIndex::M0)], false, &Arc::new(Mutex::new(true)));
        assert!(scores[0] > scores[1], "winning now must beat Swords Dance's material score: {:?}, orb={}", scores, orb);
        assert_eq!(state.serialize(), before);
    }
}

#[test]
fn terminal_wins_and_losses_are_decisive_at_every_depth_and_keep_the_depth_bonus() {
    for winner in [SideReference::SideOne, SideReference::SideTwo] {
        let mut state = position(false, false, false);
        state.get_side(&winner.get_other_side()).get_active().hp = 0;
        let value = |s: &mut State, depth| expectiminimax_search(s, depth,
            vec![MoveChoice::None], vec![MoveChoice::None], false, &Arc::new(Mutex::new(true)))[0];
        let shallow = value(&mut state, 1);
        assert!(shallow.abs() > 10000.0, "a completed game must dominate material estimates");
        assert_eq!(value(&mut state, 3) - shallow, if winner == SideReference::SideOne { 200.0 } else { -200.0 });
        assert_eq!(shallow.signum(), if winner == SideReference::SideOne { 1.0 } else { -1.0 });
    }
}

#[test]
fn final_move_faint_order_also_handles_contact_recoil_destiny_bond_and_explosion() {
    for kind in ["recoil", "helmet", "roughskin", "destinybond", "explosion"] {
        for reversed in [false, true] {
            let mut state = position(false, false, false);
            match kind {
                "recoil" => {
                    state.side_one.get_active().replace_move(PokemonMoveIndex::M0, Choices::BRAVEBIRD);
                    state.side_two.get_active().hp = 30;
                }
                "helmet" => state.side_two.get_active().item = Items::ROCKYHELMET,
                "roughskin" => state.side_two.get_active().ability = Abilities::ROUGHSKIN,
                "destinybond" => { state.side_two.volatile_statuses.insert(PokemonVolatileStatus::DESTINYBOND); }
                "explosion" => state.side_one.get_active().replace_move(PokemonMoveIndex::M0, Choices::EXPLOSION),
                _ => unreachable!(),
            }
            if reversed { std::mem::swap(&mut state.side_one, &mut state.side_two); }
            let before = state.serialize();
            let action = MoveChoice::Move(PokemonMoveIndex::M0);
            for outcome in generate_instructions_from_move_pair(&mut state, &action, &action, true) {
                state.apply_instructions(&outcome.instruction_list);
                assert_eq!(state.side_one.get_active_immutable().hp, 0, "{}", kind);
                assert_eq!(state.side_two.get_active_immutable().hp, 0, "{}", kind);
                let attacker_wins = kind != "explosion";
                assert_eq!(state.battle_is_over(), if attacker_wins != reversed { 1.0 } else { -1.0 }, "{}", kind);
                state.reverse_instructions(&outcome.instruction_list);
                assert_eq!(state.serialize(), before);
            }
        }
    }
}

#[test]
fn a_completed_knockout_is_not_undone_by_later_burn_damage() {
    for reversed in [false, true] {
        let mut state = position(false, reversed, false);
        let attacker_side = if reversed { SideReference::SideTwo } else { SideReference::SideOne };
        state.get_side(&attacker_side).get_active().status = PokemonStatus::BURN;
        let before = state.serialize();
        let action = MoveChoice::Move(PokemonMoveIndex::M0);
        for outcome in generate_instructions_from_move_pair(&mut state, &action, &action, true) {
            state.apply_instructions(&outcome.instruction_list);
            assert_eq!(state.get_side_immutable(&attacker_side).get_active_immutable().hp, 1, "the battle ends before residual damage");
            assert_eq!(state.battle_is_over(), if reversed { -1.0 } else { 1.0 });
            state.reverse_instructions(&outcome.instruction_list);
            assert_eq!(state.serialize(), before);
        }
    }
}

#[test]
fn life_orb_winner_does_not_leak_between_critical_and_noncritical_branches() {
    let mut state = position(true, false, false);
    state.side_two.get_active().hp = 350;
    state.side_two.get_active().maxhp = 350;
    let before = state.serialize();
    let action = MoveChoice::Move(PokemonMoveIndex::M0);
    let mut wins = 0.0;
    let mut losses = 0.0;
    for outcome in generate_instructions_from_move_pair(&mut state, &action, &action, true) {
        state.apply_instructions(&outcome.instruction_list);
        match state.battle_is_over() {
            1.0 => wins += outcome.percentage,
            -1.0 => losses += outcome.percentage,
            _ => panic!("Life Orb always faints the attacker at 1 HP"),
        }
        state.reverse_instructions(&outcome.instruction_list);
        assert_eq!(state.serialize(), before);
    }
    assert!((wins - 12.5).abs() < 0.001, "only a critical Leaf Blade wins: {}", wins);
    assert!((losses - 87.5).abs() < 0.001);
}
