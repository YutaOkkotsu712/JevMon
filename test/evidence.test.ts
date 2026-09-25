import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferOpponent } from '../src/strategy/inference.js';
import { battle, ours } from './helpers.js';
const bronzong = () => ours('Bronzong', 88, ['Body Press', 'Psychic Noise', 'Rest', 'Iron Defense'], 'Levitate', 'Chesto Berry', 'Fighting');
const dragapult = () => ours('Dragapult', 78, ['Shadow Ball', 'Draco Meteor'], 'Infiltrator', 'Choice Specs', 'Ghost');
// Typhlosion's sampled sets split on Choice Scarf: 211 effective speed with Specs, 316 with Scarf.
// Gengar sits between them at 225, so an observed order eliminates exactly one half.
const gengar = () => ours('Gengar', 81, ['Shadow Ball', 'Sludge Wave'], 'Cursed Body', 'Life Orb', 'Ghost');
const exchange = (b: ReturnType<typeof battle>, first: 'ours' | 'theirs') => {
  // Our Shadow Ball is identical against every sampled Typhlosion, and their move is made to miss, so the
  // only thing this turn reveals is the order itself.
  const ourMove = ['|move|p1a: Gengar|Shadow Ball|p2a: Foe', '|-damage|p2a: Foe|48/100'];
  const theirMove = ['|move|p2a: Foe|Fire Blast|p1a: Gengar', '|-miss|p2a: Foe|p1a: Gengar'];
  b.feed([...(first === 'ours' ? [...ourMove, ...theirMove] : [...theirMove, ...ourMove]), '|turn|2'].join('\n'));
};

test('equal-priority turn order eliminates only the sampled sets that contradict it', () => {
  const b = battle([gengar()], 'Typhlosion');
  assert.equal(inferOpponent(b.foe()).candidates.length, 4);
  exchange(b, 'ours');
  const speed = inferOpponent(b.foe()).summary.evidence.find(e => e.kind === 'speed')!;
  assert.ok(speed, 'a speed observation is recorded');
  assert.equal(speed.before, 4);
  assert.equal(speed.after, 2, 'moving before Typhlosion rules out the Choice Scarf spreads and nothing else');
  assert.equal(speed.contradiction, undefined);
  assert.ok(inferOpponent(b.foe()).candidates.every(c => c.item !== 'Choice Scarf'));
  // The opposite order eliminates the other half instead.
  const other = battle([gengar()], 'Typhlosion');
  exchange(other, 'theirs');
  assert.ok(inferOpponent(other.foe()).candidates.every(c => c.item === 'Choice Scarf'));
});

test('a priority move conveys no speed information', () => {
  const b = battle([dragapult()], 'Azumarill');
  // Aqua Jet moving before a faster Pokemon says nothing about speed, only about its priority bracket.
  b.feed(['|move|p2a: Foe|Aqua Jet|p1a: Dragapult', `|-damage|p1a: Dragapult|${b.me().exactHP!.max - 1}/${b.me().exactHP!.max}`,
    '|move|p1a: Dragapult|Shadow Ball|p2a: Foe', '|-damage|p2a: Foe|60/100', '|turn|2'].join('\n'));
  assert.deepEqual(inferOpponent(b.foe()).summary.evidence.filter(e => e.kind === 'speed'), [],
    'unequal priority brackets never eliminate a set by speed');
});

test('Trick Room inverts which sampled speeds the observed order rules out', () => {
  const survivors = (trickRoom: boolean) => {
    const b = battle([gengar()], 'Typhlosion');
    if (trickRoom) b.feed('|-fieldstart|move: Trick Room');
    exchange(b, 'ours');
    return inferOpponent(b.foe()).candidates.map(c => c.item);
  };
  // Moving first means we are the faster Pokemon normally, and the slower one under Trick Room,
  // so the opposite half of the sampled spreads survives.
  assert.ok(survivors(false).every(item => item === 'Choice Specs'));
  assert.ok(survivors(true).every(item => item === 'Choice Scarf'));
});

test('observed damage eliminates only the sampled sets outside the roll envelope', () => {
  const b = battle([bronzong()], 'Azumarill');
  assert.equal(inferOpponent(b.foe()).candidates.length, 4, 'Azumarill samples differ by item, so damage can separate them');
  // Liquidation deals 114-135 with Choice Band and 76-90 with Sitrus Berry against this Bronzong.
  // A loss of 81 is possible only without the Band.
  b.feed(['|move|p2a: Foe|Liquidation|p1a: Bronzong', `|-damage|p1a: Bronzong|${b.me().exactHP!.max - 81}/${b.me().exactHP!.max}`, '|turn|2'].join('\n'));
  const damage = inferOpponent(b.foe()).summary.evidence.find(e => e.kind === 'damage')!;
  assert.ok(damage, 'a damage observation is recorded');
  assert.equal(damage.before, 4);
  assert.ok(damage.after > 0 && damage.after < damage.before, `narrowed 4 -> ${damage.after}`);
  assert.equal(damage.contradiction, undefined);
  const survivors = inferOpponent(b.foe()).candidates;
  assert.equal(survivors.length, damage.after);
  assert.ok(survivors.every(c => c.item === 'Sitrus Berry'), 'only the itemless-attack spreads remain');
  assert.equal(inferOpponent(b.foe()).summary.evidenceConflict, false);
});

test('an observation that rules out every sampled set is a contradiction, not a deduction', () => {
  const b = battle([bronzong()], 'Azumarill');
  const before = inferOpponent(b.foe()).candidates.length;
  // One point of damage is below every sampled Liquidation roll, so our model must be wrong, not the samples.
  b.feed(['|move|p2a: Foe|Liquidation|p1a: Bronzong', `|-damage|p1a: Bronzong|${b.me().exactHP!.max - 1}/${b.me().exactHP!.max}`, '|turn|2'].join('\n'));
  const summary = inferOpponent(b.foe()).summary;
  const damage = summary.evidence.find(e => e.kind === 'damage')!;
  assert.equal(damage.contradiction, true);
  assert.equal(damage.after, damage.before, 'nothing is eliminated');
  assert.equal(summary.evidenceContradictions, 1, 'the contradiction is counted and surfaced');
  assert.equal(inferOpponent(b.foe()).candidates.length, before, 'the hypothesis space survives, so later estimates still work');
  assert.equal(b.foe().inference!.excluded.length, 0);
});

test('a single point of rounding disagreement does not eliminate a set', () => {
  const b = battle([bronzong()], 'Azumarill');
  // Sitrus Berry Liquidation tops out at 90; 91 is one point beyond it and must be absorbed as model error.
  b.feed(['|move|p2a: Foe|Liquidation|p1a: Bronzong', `|-damage|p1a: Bronzong|${b.me().exactHP!.max - 91}/${b.me().exactHP!.max}`, '|turn|2'].join('\n'));
  assert.ok(inferOpponent(b.foe()).candidates.some(c => c.item === 'Sitrus Berry'), 'the borderline set is retained');
});

test('a fainting target censors overkill, so damage keeps only a lower bound', () => {
  const b = battle([bronzong(), dragapult()], 'Azumarill');
  b.feed(b.request(3, 26)); // Low enough that every sampled Liquidation is a KO with room to spare.
  b.feed(['|move|p2a: Foe|Liquidation|p1a: Bronzong', '|-damage|p1a: Bronzong|0 fnt', '|faint|p1a: Bronzong', '|turn|2'].join('\n'));
  const damage = inferOpponent(b.foe()).summary.evidence.find(e => e.kind === 'damage');
  assert.ok(damage, 'the observation is still made');
  assert.equal(damage.after, damage.before, 'an overkill KO excludes nothing, because damage has no observable upper bound');
});

test('critical hits, multiple hits and interrupting effects discard the observation', () => {
  for (const interruption of ['|-crit|p1a: Bronzong', '|-activate|p1a: Bronzong|move: Substitute', '|-enditem|p1a: Bronzong|Chesto Berry']) {
    const b = battle([bronzong()], 'Azumarill');
    b.feed(['|move|p2a: Foe|Liquidation|p1a: Bronzong', interruption,
      `|-damage|p1a: Bronzong|${b.me().exactHP!.max - 1}/${b.me().exactHP!.max}`, '|turn|2'].join('\n'));
    assert.deepEqual(inferOpponent(b.foe()).summary.evidence.filter(e => e.kind === 'damage'), [], interruption);
  }
  const twice = battle([bronzong()], 'Azumarill');
  twice.feed(['|move|p2a: Foe|Liquidation|p1a: Bronzong', `|-damage|p1a: Bronzong|${twice.me().exactHP!.max - 1}/${twice.me().exactHP!.max}`,
    `|-damage|p1a: Bronzong|${twice.me().exactHP!.max - 2}/${twice.me().exactHP!.max}`, '|turn|2'].join('\n'));
  assert.deepEqual(inferOpponent(twice.foe()).summary.evidence.filter(e => e.kind === 'damage'), []);
});

test('residual damage from items, weather and hazards is not attributed to the move', () => {
  const b = battle([bronzong()], 'Azumarill');
  b.feed(['|move|p2a: Foe|Liquidation|p1a: Bronzong', `|-damage|p1a: Bronzong|${b.me().exactHP!.max - 1}/${b.me().exactHP!.max}|[from] item: Life Orb`, '|turn|2'].join('\n'));
  assert.deepEqual(inferOpponent(b.foe()).summary.evidence, []);
});

test('Illusion and Transform discard evidence gathered under the wrong identity', () => {
  const b = battle([bronzong()], 'Azumarill');
  b.feed(['|move|p2a: Foe|Liquidation|p1a: Bronzong', `|-damage|p1a: Bronzong|${b.me().exactHP!.max - 1}/${b.me().exactHP!.max}`, '|turn|2'].join('\n'));
  assert.ok(b.foe().inference);
  b.feed('|replace|p2a: Foe|Zoroark, L82, M|100/100');
  assert.equal(b.foe().inference, undefined, 'a revealed Illusion invalidates earlier attribution');
  assert.equal(b.state.sides.p2.identityUncertain, true);
  assert.equal(inferOpponent(b.foe()).summary.evidenceConflict, false, 'stale exclusions never survive as a contradiction');
});

test('a realistic exchange records both a turn-order and a damage deduction', () => {
  const b = battle([bronzong(), dragapult()], 'Azumarill');
  b.feed(['|', '|t:|1758511048',
    '|move|p2a: Foe|Liquidation|p1a: Bronzong', '|-damage|p1a: Bronzong|140/261',
    '|move|p1a: Bronzong|Body Press|p2a: Foe', '|-supereffective|p2a: Foe', '|-damage|p2a: Foe|88/100',
    '|', '|upkeep', '|turn|2', b.request(3, 140)].join('\n'));
  const kinds = inferOpponent(b.foe()).summary.evidence.map(e => e.kind);
  assert.ok(kinds.includes('speed'), 'turn order is deduced from the public exchange');
  assert.ok(kinds.includes('damage'), 'damage is deduced from the public exchange');
  assert.equal(b.me().hpPrecision, 'exact', 'our own exact HP survives the turn, which the deductions depend on');
});
