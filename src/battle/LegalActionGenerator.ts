import { isRecord, parseCondition } from '../showdown/parser.js';

export interface BattleAction {
  id: string;
  kind: 'move' | 'switch' | 'revive' | 'team';
  command: string;
  label: string;
  uncertain: boolean;
}
export interface ChoiceRequest {
  rqid: number;
  side: { id: 'p1' | 'p2'; name: string; pokemon: { ident: string; details: string; condition: string; active: boolean; reviving?: boolean }[] };
  active?: { moves: { move: string; id: string; pp?: number; maxpp?: number; disabled?: boolean | string }[]; trapped?: boolean; maybeTrapped?: boolean; maybeDisabled?: boolean; canTerastallize?: string }[];
  forceSwitch?: boolean[];
  teamPreview?: boolean;
  maxChosenTeamSize?: number;
  wait?: boolean;
}

/** Fail closed on malformed or unsupported requests; never infer choices from battle history. */
export function parseChoiceRequest(raw: string): ChoiceRequest | null {
  let r: unknown;
  try { r = JSON.parse(raw); } catch { throw new Error('Malformed request JSON'); }
  if (r === null || (isRecord(r) && r.wait === true)) return null;
  if (!isRecord(r) || !Number.isSafeInteger(r.rqid) || Number(r.rqid) < 0 || !isRecord(r.side) ||
    !['p1', 'p2'].includes(String(r.side.id)) || typeof r.side.name !== 'string' || !Array.isArray(r.side.pokemon) ||
    r.side.pokemon.length < 1 || r.side.pokemon.length > 6) throw new Error('Invalid request header');
  const side = r.side;
  const roster = r.side.pokemon;
  if (roster.some((p: unknown) => !isRecord(p) || typeof p.ident !== 'string' || !p.ident.startsWith(`${side.id}: `) ||
    typeof p.details !== 'string' || !p.details || typeof p.condition !== 'string' || !parseCondition(p.condition) ||
    typeof p.active !== 'boolean' || (p.reviving !== undefined && typeof p.reviving !== 'boolean'))) throw new Error('Invalid roster');
  if (r.wait !== undefined && r.wait !== false) throw new Error('Invalid wait flag');
  if (r.teamPreview !== undefined && typeof r.teamPreview !== 'boolean') throw new Error('Invalid preview flag');
  if (r.teamPreview === true) {
    if (r.forceSwitch !== undefined || r.active !== undefined) throw new Error('Conflicting request modes');
    if (r.maxChosenTeamSize !== undefined && (!Number.isInteger(r.maxChosenTeamSize) || Number(r.maxChosenTeamSize) < 1 ||
      Number(r.maxChosenTeamSize) > roster.length)) throw new Error('Invalid preview size');
  } else {
    if (roster.filter(p => isRecord(p) && p.active === true).length !== 1) throw new Error('Expected singles active slot');
    if (r.forceSwitch !== undefined) {
      if (!Array.isArray(r.forceSwitch) || r.forceSwitch.length !== 1 || typeof r.forceSwitch[0] !== 'boolean' || r.active !== undefined) throw new Error('Invalid forced switch');
    } else {
      if (!Array.isArray(r.active) || r.active.length !== 1 || !isRecord(r.active[0])) throw new Error('Expected singles move request');
      const active = r.active[0];
      for (const key of ['trapped', 'maybeTrapped', 'maybeDisabled']) if (active[key] !== undefined && typeof active[key] !== 'boolean') throw new Error('Invalid active flags');
      if (active.canTerastallize !== undefined && typeof active.canTerastallize !== 'string') throw new Error('Invalid Tera flag');
      if (active.canMegaEvo || active.canZMove || active.canDynamax) throw new Error('Unsupported format mechanic');
      if (!Array.isArray(active.moves) || active.moves.length < 1 || active.moves.length > 4 || active.moves.some(m =>
        !isRecord(m) || typeof m.move !== 'string' || !m.move || typeof m.id !== 'string' || !/^[a-z0-9]+$/.test(m.id) ||
        (m.disabled !== undefined && typeof m.disabled !== 'boolean' && typeof m.disabled !== 'string') ||
        (m.pp !== undefined && (!Number.isInteger(m.pp) || Number(m.pp) < 0)) ||
        (m.maxpp !== undefined && (!Number.isInteger(m.maxpp) || Number(m.maxpp) < 1)))) throw new Error('Invalid moves');
    }
  }
  return r as unknown as ChoiceRequest;
}

export function generateLegalActions(request: ChoiceRequest): BattleAction[] {
  if (request.wait) return [];
  const actions: BattleAction[] = [];
  const add = (kind: BattleAction['kind'], command: string, label: string, uncertain = false) =>
    actions.push({ id: command.replaceAll(' ', '-'), kind, command, label, uncertain });
  if (request.teamPreview) {
    const slots = request.side.pokemon.map((_, i) => i + 1);
    const size = request.maxChosenTeamSize ?? slots.length;
    const permutations = (chosen: number[], remaining: number[]) => {
      if (chosen.length === size) { add('team', `team ${chosen.join('')}`, `Team order ${chosen.join(', ')}`); return; }
      for (const slot of remaining) permutations([...chosen, slot], remaining.filter(s => s !== slot));
    };
    permutations([], slots); return actions;
  }
  const active = request.active?.[0];
  const forced = request.forceSwitch?.[0] === true;
  if (request.forceSwitch && !forced) return [];
  const reviving = forced && request.side.pokemon.some(p => p.reviving === true);
  if (forced || !active?.trapped) {
    request.side.pokemon.forEach((p, i) => {
      const hp = parseCondition(p.condition)!;
      if (reviving ? hp.fainted : !p.active && !hp.fainted && hp.hpPercent > 0) {
        add(reviving ? 'revive' : 'switch', `switch ${i + 1}`, `${reviving ? 'Revive' : 'Switch to'} ${p.details}`, !forced && !!active?.maybeTrapped);
      }
    });
  }
  if (!forced && active) {
    active.moves.forEach((move, i) => {
      // Locked moves, Recharge and Struggle may omit PP. Trust explicit request entries.
      if (move.disabled || move.pp === 0) return;
      add('move', `move ${i + 1}`, move.move, !!active.maybeDisabled);
      if (active.canTerastallize) add('move', `move ${i + 1} terastallize`, `${move.move} + Tera ${active.canTerastallize}`, !!active.maybeDisabled);
    });
  }
  return actions;
}

export function validateAction(request: ChoiceRequest, id: unknown): BattleAction | undefined {
  return typeof id === 'string' ? generateLegalActions(request).find(a => a.id === id) : undefined;
}
