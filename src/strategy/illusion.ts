import pools from '../data/gen9-sets.json' with { type: 'json' };
import { dex, id } from '../pokemon/data.js';
import { typeEffectiveness } from '../pokemon/mechanics.js';

/**
 * Zoroark and Zoroark-Hisui enter looking like the last Pokémon in their party, and stay that way until a damaging hit
 * breaks the disguise. Two things give them away before that: a move the disguise's Random Battle sets never carry but
 * a Zoroark's do, and one of our attacks having no effect where the disguise's typing would take it but a Zoroark's
 * would not. Either names the form, which the tracker then treats the Pokémon as while it stays in.
 */
export type IllusionForm = 'Zoroark' | 'Zoroark-Hisui';
const FORMS: IllusionForm[] = ['Zoroark-Hisui', 'Zoroark'];
const data = pools as Record<string, { level?: number; sets?: { movepool?: string[] }[] }>;
const movepool = (species: string) => {
  const entry = data[id(species)];
  return entry?.sets ? new Set(entry.sets.flatMap(r => (r.movepool ?? []).map(id))) : null;
};
const zoroarkMoves = new Map(FORMS.map(f => [f, movepool(f)!]));

/** The level a Random Battle Zoroark form plays at. */
export const illusionLevel = (form: IllusionForm) => data[id(form)]?.level ?? 80;

/** The form a move gives away, when the displayed species could never use it and a Zoroark form could. */
export function formFromMove(displayed: string, move: string, known: string[] = []): IllusionForm | null {
  const own = movepool(displayed), key = id(move);
  if (!own || own.has(key) || !dex.moves.get(move).exists) return null;
  const able = FORMS.filter(f => zoroarkMoves.get(f)!.has(key));
  if (!able.length) return null;
  if (able.length === 1) return able[0]!;
  // A move both forms carry: the other moves it has shown decide, and Zoroark-Hisui otherwise.
  const told = FORMS.find(f => known.some(m => zoroarkMoves.get(f)!.has(id(m)) && !FORMS.some(g => g !== f && zoroarkMoves.get(g)!.has(id(m)))));
  return told ?? 'Zoroark-Hisui';
}

/** The form an unexplained immunity gives away: our attack of this type would hit the displayed typing but not the form's. */
export function formFromImmunity(displayedTypes: string[], moveType: string): IllusionForm | null {
  if ((typeEffectiveness(moveType, displayedTypes) ?? 1) === 0) return null;
  return FORMS.find(f => typeEffectiveness(moveType, [...dex.species.get(f).types]) === 0) ?? null;
}

/** Of the moves a Pokémon showed, the ones its displayed species can carry: a Zoroark's own leave with it. */
export function displayedMoves(displayed: string, moves: string[]) {
  const own = movepool(displayed);
  return own ? moves.filter(m => own.has(id(m))) : moves;
}
