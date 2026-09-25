use super::abilities::Abilities;
use super::items::Items;
use super::state::PokemonVolatileStatus;
use super::damage_calc::type_effectiveness_modifier;
use super::generate_instructions::{get_effective_speed, MAX_SLEEP_TURNS};
use crate::choices::MoveCategory;
use crate::state::{Pokemon, PokemonStatus, Side, SideReference, State};
use std::sync::OnceLock;

/// Every weight the evaluation applies. The defaults are the hand-set values it always used; `POKE_ENGINE_WEIGHTS` may
/// name a file of `name value` lines that replaces any of them, which is how weights fitted to game results are tried
/// on the self-play bench before the live bot uses them. An unknown name stops the engine rather than be ignored.
#[derive(Clone, Copy, Debug)]
pub struct Weights {
    pub alive: f32,
    pub hp: f32,
    pub item: f32,
    // What an unspent Tera is worth is what the Pokémon still standing could do with it: 75 with six left, as before, and
    // little with one or two. A flat 75 made the search overrule Terastallising to the end of a game, as with a Terapagos
    // asked to Tera Stellar on five straight turns and a Carbink on three, with three Pokémon left.
    pub used_tera_per_pokemon_left: f32,
    pub attack_boost: f32,
    pub defense_boost: f32,
    pub special_attack_boost: f32,
    pub special_defense_boost: f32,
    pub speed_boost: f32,
    pub frozen: f32,
    // Per turn it can still expect to lose: a fresh sleep, which lasts two more turns on average, keeps the old -25.
    pub asleep_per_turn: f32,
    pub paralyzed: f32,
    pub toxic: f32,
    pub poisoned: f32,
    pub poison_heal: f32,
    pub poison_boosted: f32,
    pub burned: f32,
    pub burn_boosted: f32,
    pub leech_seed: f32,
    // About the quarter of max HP it costs, plus a little for the status it blocks. At 75 a shell was worth three quarters
    // of a full HP bar, so the search put one up turn after turn even when the next hit broke it.
    pub substitute: f32,
    pub confusion: f32,
    pub reflect: f32,
    pub light_screen: f32,
    pub aurora_veil: f32,
    pub safeguard: f32,
    pub tailwind: f32,
    pub healing_wish: f32,
    pub stealth_rock: f32,
    pub spikes: f32,
    pub toxic_spikes: f32,
    pub sticky_web: f32,
    // Terms the hand-set evaluation never had, at zero until fitted: whether our active moves first, and how much
    // harder our active's best hit lands on theirs than theirs on ours.
    pub speed_advantage: f32,
    pub matchup: f32,
}

impl Default for Weights {
    fn default() -> Self {
        Weights {
            alive: 30.0,
            hp: 100.0,
            item: 10.0,
            used_tera_per_pokemon_left: -12.5,
            attack_boost: 30.0,
            defense_boost: 15.0,
            special_attack_boost: 30.0,
            special_defense_boost: 15.0,
            speed_boost: 30.0,
            frozen: -40.0,
            asleep_per_turn: -12.5,
            paralyzed: -25.0,
            toxic: -30.0,
            poisoned: -10.0,
            poison_heal: 15.0,
            poison_boosted: 10.0,
            burned: -25.0,
            burn_boosted: 50.0,
            leech_seed: -30.0,
            substitute: 30.0,
            confusion: -20.0,
            reflect: 20.0,
            light_screen: 20.0,
            aurora_veil: 40.0,
            safeguard: 5.0,
            tailwind: 7.0,
            healing_wish: 30.0,
            stealth_rock: -10.0,
            spikes: -7.0,
            toxic_spikes: -7.0,
            sticky_web: -25.0,
            speed_advantage: 0.0,
            matchup: 0.0,
        }
    }
}

macro_rules! weight_names {
    ($($name:ident),*) => {
        impl Weights {
            pub const NAMES: &'static [&'static str] = &[$(stringify!($name)),*];
            fn set(&mut self, name: &str, value: f32) {
                match name {
                    $(stringify!($name) => self.$name = value,)*
                    _ => panic!("unknown evaluation weight: {}", name),
                }
            }
        }
        impl Features {
            pub fn values(&self) -> Vec<(&'static str, f32)> { vec![$((stringify!($name), self.$name)),*] }
            pub fn weighted(&self, w: &Weights) -> f32 { 0.0 $(+ self.$name * w.$name)* }
            fn add(&mut self, other: &Features, sign: f32) { $(self.$name += sign * other.$name;)* }
        }
    };
}

/// The evaluation's terms before weighting: counts, fractions and boost multipliers, one per weight.
#[derive(Clone, Copy, Debug, Default)]
pub struct Features {
    pub alive: f32,
    pub hp: f32,
    pub item: f32,
    pub used_tera_per_pokemon_left: f32,
    pub attack_boost: f32,
    pub defense_boost: f32,
    pub special_attack_boost: f32,
    pub special_defense_boost: f32,
    pub speed_boost: f32,
    pub frozen: f32,
    pub asleep_per_turn: f32,
    pub paralyzed: f32,
    pub toxic: f32,
    pub poisoned: f32,
    pub poison_heal: f32,
    pub poison_boosted: f32,
    pub burned: f32,
    pub burn_boosted: f32,
    pub leech_seed: f32,
    pub substitute: f32,
    pub confusion: f32,
    pub reflect: f32,
    pub light_screen: f32,
    pub aurora_veil: f32,
    pub safeguard: f32,
    pub tailwind: f32,
    pub healing_wish: f32,
    pub stealth_rock: f32,
    pub spikes: f32,
    pub toxic_spikes: f32,
    pub sticky_web: f32,
    pub speed_advantage: f32,
    pub matchup: f32,
}

weight_names!(alive, hp, item, used_tera_per_pokemon_left, attack_boost, defense_boost, special_attack_boost,
    special_defense_boost, speed_boost, frozen, asleep_per_turn, paralyzed, toxic, poisoned, poison_heal,
    poison_boosted, burned, burn_boosted, leech_seed, substitute, confusion, reflect, light_screen, aurora_veil,
    safeguard, tailwind, healing_wish, stealth_rock, spikes, toxic_spikes, sticky_web, speed_advantage, matchup);

static WEIGHTS: OnceLock<Weights> = OnceLock::new();

/// The weights in use, read once: the defaults, with any `POKE_ENGINE_WEIGHTS` file applied over them.
pub fn weights() -> &'static Weights {
    WEIGHTS.get_or_init(|| {
        let mut w = Weights::default();
        if let Ok(path) = std::env::var("POKE_ENGINE_WEIGHTS") {
            if !path.is_empty() {
                let text = std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("cannot read POKE_ENGINE_WEIGHTS {}: {}", path, e));
                for line in text.lines() {
                    let line = line.trim();
                    if line.is_empty() || line.starts_with('#') {
                        continue;
                    }
                    let mut parts = line.split_whitespace();
                    let (Some(name), Some(value)) = (parts.next(), parts.next()) else { continue };
                    let value: f32 = value.parse().unwrap_or_else(|_| panic!("bad weight value for {}: {}", name, value));
                    w.set(name, value);
                }
            }
        }
        w
    })
}

const POKEMON_BOOST_MULTIPLIER_6: f32 = 3.3;
const POKEMON_BOOST_MULTIPLIER_5: f32 = 3.15;
const POKEMON_BOOST_MULTIPLIER_4: f32 = 3.0;
const POKEMON_BOOST_MULTIPLIER_3: f32 = 2.5;
const POKEMON_BOOST_MULTIPLIER_2: f32 = 2.0;
const POKEMON_BOOST_MULTIPLIER_1: f32 = 1.0;
const POKEMON_BOOST_MULTIPLIER_0: f32 = 0.0;
const POKEMON_BOOST_MULTIPLIER_NEG_1: f32 = -1.0;
const POKEMON_BOOST_MULTIPLIER_NEG_2: f32 = -2.0;
const POKEMON_BOOST_MULTIPLIER_NEG_3: f32 = -2.5;
const POKEMON_BOOST_MULTIPLIER_NEG_4: f32 = -3.0;
const POKEMON_BOOST_MULTIPLIER_NEG_5: f32 = -3.15;
const POKEMON_BOOST_MULTIPLIER_NEG_6: f32 = -3.3;

/// A poisoned Pokémon's term: Poison Heal gains from it, and Guts and the like turn it into a small plus.
fn poison_features(pokemon: &Pokemon, f: &mut Features, toxic: bool) {
    match pokemon.ability {
        Abilities::POISONHEAL => f.poison_heal += 1.0,
        Abilities::GUTS
        | Abilities::MARVELSCALE
        | Abilities::QUICKFEET
        | Abilities::TOXICBOOST
        | Abilities::MAGICGUARD => f.poison_boosted += 1.0,
        _ => {
            if toxic {
                f.toxic += 1.0
            } else {
                f.poisoned += 1.0
            }
        }
    }
}

fn burn_features(pokemon: &Pokemon, f: &mut Features) {
    // burn is not as punishing in certain situations

    // guts, marvel scale, quick feet will result in a positive evaluation
    match pokemon.ability {
        Abilities::GUTS | Abilities::MARVELSCALE | Abilities::QUICKFEET => {
            f.burn_boosted += 1.0;
            return;
        }
        _ => {}
    }

    let mut multiplier = 0.0;
    for mv in pokemon.moves.into_iter() {
        if mv.choice.category == MoveCategory::Physical {
            multiplier += 1.0;
        }
    }

    // don't make burn as punishing for special attackers
    if pokemon.special_attack > pokemon.attack {
        multiplier /= 2.0;
    }

    f.burned += multiplier;
}

fn get_boost_multiplier(boost: i8) -> f32 {
    match boost {
        6 => POKEMON_BOOST_MULTIPLIER_6,
        5 => POKEMON_BOOST_MULTIPLIER_5,
        4 => POKEMON_BOOST_MULTIPLIER_4,
        3 => POKEMON_BOOST_MULTIPLIER_3,
        2 => POKEMON_BOOST_MULTIPLIER_2,
        1 => POKEMON_BOOST_MULTIPLIER_1,
        0 => POKEMON_BOOST_MULTIPLIER_0,
        -1 => POKEMON_BOOST_MULTIPLIER_NEG_1,
        -2 => POKEMON_BOOST_MULTIPLIER_NEG_2,
        -3 => POKEMON_BOOST_MULTIPLIER_NEG_3,
        -4 => POKEMON_BOOST_MULTIPLIER_NEG_4,
        -5 => POKEMON_BOOST_MULTIPLIER_NEG_5,
        -6 => POKEMON_BOOST_MULTIPLIER_NEG_6,
        _ => panic!("Invalid boost value: {}", boost),
    }
}

fn hazard_features(pokemon: &Pokemon, side: &Side, f: &mut Features) {
    let pkmn_is_grounded = pokemon.is_grounded();
    if pokemon.item != Items::HEAVYDUTYBOOTS {
        if pokemon.ability != Abilities::MAGICGUARD {
            f.stealth_rock += side.side_conditions.stealth_rock as f32;
            if pkmn_is_grounded {
                f.spikes += side.side_conditions.spikes as f32;
                f.toxic_spikes += side.side_conditions.toxic_spikes as f32;
            }
        }
        if pkmn_is_grounded {
            f.sticky_web += side.side_conditions.sticky_web as f32;
        }
    }
}

/// Turns a sleeping Pokémon can still expect to lose. Rest counts down to waking; otherwise the wake chance rises each
/// turn already spent asleep, as `chance_to_wake_up` does, so a sleep nearly over is worth far less to the other side.
fn expected_turns_asleep(pokemon: &Pokemon) -> f32 {
    if pokemon.rest_turns > 0 {
        return (pokemon.rest_turns - 1).max(0) as f32;
    }
    let mut expected = 0.0;
    let mut still_asleep = 1.0;
    let mut turns = pokemon.sleep_turns;
    while turns < MAX_SLEEP_TURNS {
        let wake = if turns == 0 { 0.0 } else { 1.0 / (1 + MAX_SLEEP_TURNS - turns) as f32 };
        still_asleep *= 1.0 - wake;
        expected += still_asleep;
        turns += 1;
    }
    expected
}

/// Whether the Pokémon has a move that its attacking stat of this category powers: a boost to a stat it never
/// attacks with changes nothing, yet each stage used to count in full, as Shift Gear's Attack did on a special Magearna.
fn attacks_with(pokemon: &Pokemon, category: MoveCategory) -> bool {
    pokemon.moves.into_iter().any(|mv| mv.choice.category == category)
}

/// HP, status and item: the part of one Pokémon's value that the evaluation floors at zero, so that a low-HP Pokémon
/// never scores below nothing and gives the other side a reason to keep it alive.
fn pokemon_features(pokemon: &Pokemon) -> Features {
    let mut f = Features::default();
    f.hp = pokemon.hp as f32 / pokemon.maxhp as f32;
    match pokemon.status {
        PokemonStatus::BURN => burn_features(pokemon, &mut f),
        PokemonStatus::FREEZE => f.frozen += 1.0,
        PokemonStatus::SLEEP => f.asleep_per_turn += expected_turns_asleep(pokemon),
        PokemonStatus::PARALYZE => f.paralyzed += 1.0,
        PokemonStatus::TOXIC => poison_features(pokemon, &mut f, true),
        PokemonStatus::POISON => poison_features(pokemon, &mut f, false),
        PokemonStatus::NONE => {}
    }
    if pokemon.item != Items::NONE {
        f.item += 1.0;
    }
    f
}

/// One side's terms. With `w`, each Pokémon's own part is floored at zero as the evaluation does and the weighted
/// total is returned alongside; the raw terms leave the floor out, being a linear description for fitting.
fn side_features(side: &Side, w: Option<&Weights>) -> (Features, f32) {
    let mut total = Features::default();
    let mut floored = 0.0;
    let mut used_tera = false;
    let mut alive = 0.0;
    let mut iter = side.pokemon.into_iter();
    while let Some(pkmn) = iter.next() {
        if pkmn.hp > 0 {
            alive += 1.0;
            total.alive += 1.0;
            let own = pokemon_features(pkmn);
            total.add(&own, 1.0);
            if let Some(w) = w {
                floored += own.weighted(w).max(0.0);
            }
            hazard_features(pkmn, side, &mut total);
            if iter.pokemon_index == side.active_index {
                if side.volatile_statuses.contains(&PokemonVolatileStatus::LEECHSEED) {
                    total.leech_seed += 1.0;
                }
                if side.volatile_statuses.contains(&PokemonVolatileStatus::SUBSTITUTE) {
                    total.substitute += 1.0;
                }
                if side.volatile_statuses.contains(&PokemonVolatileStatus::CONFUSION) {
                    total.confusion += 1.0;
                }
                if attacks_with(pkmn, MoveCategory::Physical) {
                    total.attack_boost += get_boost_multiplier(side.attack_boost);
                }
                total.defense_boost += get_boost_multiplier(side.defense_boost);
                if attacks_with(pkmn, MoveCategory::Special) {
                    total.special_attack_boost += get_boost_multiplier(side.special_attack_boost);
                }
                total.special_defense_boost += get_boost_multiplier(side.special_defense_boost);
                total.speed_boost += get_boost_multiplier(side.speed_boost);
            }
        }
        if pkmn.terastallized {
            used_tera = true;
        }
    }
    if used_tera {
        total.used_tera_per_pokemon_left += alive;
    }
    total.reflect += side.side_conditions.reflect as f32;
    total.light_screen += side.side_conditions.light_screen as f32;
    total.aurora_veil += side.side_conditions.aurora_veil as f32;
    total.safeguard += side.side_conditions.safeguard as f32;
    total.tailwind += side.side_conditions.tailwind as f32;
    total.healing_wish += side.side_conditions.healing_wish as f32;
    let weighted = match w {
        // Everything but the per-Pokémon part, which was floored one Pokémon at a time above.
        Some(w) => {
            let mut rest = total;
            rest.hp = 0.0;
            rest.item = 0.0;
            rest.frozen = 0.0;
            rest.asleep_per_turn = 0.0;
            rest.paralyzed = 0.0;
            rest.toxic = 0.0;
            rest.poisoned = 0.0;
            rest.poison_heal = 0.0;
            rest.poison_boosted = 0.0;
            rest.burned = 0.0;
            rest.burn_boosted = 0.0;
            floored + rest.weighted(w)
        }
        None => 0.0,
    };
    (total, weighted)
}

/// The best hit an attacker has on a defender, as type effectiveness times STAB times base power over 100 (capped at
/// 150), over its usable damaging moves.
fn best_hit(attacker: &Pokemon, defender: &Pokemon) -> f32 {
    let mut best: f32 = 0.0;
    for mv in attacker.moves.into_iter() {
        let choice = &mv.choice;
        if mv.disabled || mv.pp <= 0 || choice.category == MoveCategory::Status || choice.base_power <= 0.0 {
            continue;
        }
        let stab = if attacker.has_type(&choice.move_type) { 1.5 } else { 1.0 };
        let hit = type_effectiveness_modifier(&choice.move_type, defender) * stab * choice.base_power.min(150.0) / 100.0;
        best = best.max(hit);
    }
    best
}

/// The two actives against each other: +1 when ours moves first at equal priority, -1 when theirs does (Trick Room
/// reverses it), and our best hit on theirs minus theirs on ours. Both are side one's view.
fn active_pair_features(state: &State) -> (f32, f32) {
    let ours = state.side_one.get_active_immutable();
    let theirs = state.side_two.get_active_immutable();
    if ours.hp <= 0 || theirs.hp <= 0 {
        return (0.0, 0.0);
    }
    let (a, b) = (get_effective_speed(state, &SideReference::SideOne), get_effective_speed(state, &SideReference::SideTwo));
    let mut speed = if a > b { 1.0 } else if a < b { -1.0 } else { 0.0 };
    if state.trick_room.active {
        speed = -speed;
    }
    (speed, best_hit(ours, theirs) - best_hit(theirs, ours))
}

/// Side one's terms minus side two's, unweighted and without the per-Pokémon floor: the `features` command's output.
pub fn evaluate_features(state: &State) -> Features {
    let (mut ones, _) = side_features(&state.side_one, None);
    let (twos, _) = side_features(&state.side_two, None);
    ones.add(&twos, -1.0);
    let (speed, matchup) = active_pair_features(state);
    ones.speed_advantage = speed;
    ones.matchup = matchup;
    ones
}

pub fn evaluate(state: &State) -> f32 {
    let w = weights();
    let mut score = side_features(&state.side_one, Some(w)).1 - side_features(&state.side_two, Some(w)).1;
    // Skipped at the default zero weights, so the search pays nothing for terms it does not use.
    if w.speed_advantage != 0.0 || w.matchup != 0.0 {
        let (speed, matchup) = active_pair_features(state);
        score += w.speed_advantage * speed + w.matchup * matchup;
    }
    score
}
