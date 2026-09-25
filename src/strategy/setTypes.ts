export type Spread = { hp: number; atk: number; def: number; spa: number; spd: number; spe: number };
export interface Candidate {
  key?: string;
  ability: string;
  item: string;
  moves: string[];
  evs: Spread;
  ivs: Spread;
  teraType: string;
  /** Share of recorded generation draws that produced this exact set, before any battle evidence. */
  probability: number;
}
