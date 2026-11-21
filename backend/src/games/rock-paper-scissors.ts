import { DriverContext, DriverEvent, DriverResult, GameAction, GameDriver, GameStandings } from './types';

type Choice = 'ROCK' | 'PAPER' | 'SCISSORS';
export type RockPaperScissorsState = {
  choices: Record<string, Choice>;
  winnerPosition: number | null;
  draw: boolean;
  timeoutPosition: number | null;
};

const CHOICES = new Set<Choice>(['ROCK', 'PAPER', 'SCISSORS']);
function winner(a: Choice, b: Choice): number {
  if (a === b) return 0;
  return (a === 'ROCK' && b === 'SCISSORS') ||
    (a === 'PAPER' && b === 'ROCK') ||
    (a === 'SCISSORS' && b === 'PAPER') ? 1 : 2;
}

export const rockPaperScissorsDriver: GameDriver = {
  key: 'ROCK_PAPER_SCISSORS',

  initialState(): RockPaperScissorsState {
    return { choices: {}, winnerPosition: null, draw: false, timeoutPosition: null };
  },

  turnOwner() {
    // Both players choose simultaneously; the engine's shared turn clock governs the round.
    return null;
  },

  applyAction(state: unknown, ctx: DriverContext, actorId: string, action: GameAction): DriverResult {
    const s = state as RockPaperScissorsState;
    if (action.type !== 'CHOOSE') return { ok: false, code: 'unknown_action', message: 'Choose rock, paper or scissors' };
    if (s.winnerPosition !== null || s.draw || s.timeoutPosition !== null) {
      return { ok: false, code: 'game_over', message: 'This round is already over' };
    }
    const actor = ctx.players.find((p) => p.userId === actorId);
    if (!actor) return { ok: false, code: 'not_a_player', message: 'Only match players can choose' };
    if (s.choices[String(actor.position)]) {
      return { ok: false, code: 'already_chosen', message: 'Your choice is already locked' };
    }
    const raw = action.payload.choice;
    const choice = typeof raw === 'string' ? raw.toUpperCase() as Choice : null;
    if (!choice || !CHOICES.has(choice)) {
      return { ok: false, code: 'bad_choice', message: 'Choose ROCK, PAPER or SCISSORS' };
    }
    const choices = { ...s.choices, [String(actor.position)]: choice };
    const events: DriverEvent[] = [{ type: 'CHOOSE', actorId, payload: { position: actor.position, choiceLocked: true } }];
    const [first, second] = ctx.players;
    if (first && second && choices[String(first.position)] && choices[String(second.position)]) {
      const result = winner(choices[String(first.position)], choices[String(second.position)]);
      if (result === 0) {
        events.push({ type: 'DRAW', actorId: null, payload: { result: 'DRAW' } });
        return { ok: true, state: { ...s, choices, draw: true }, events };
      }
      const winnerPosition = result === 1 ? first.position : second.position;
      events.push({ type: 'WON', actorId: null, payload: { winnerPosition } });
      return { ok: true, state: { ...s, choices, winnerPosition }, events };
    }
    return { ok: true, state: { ...s, choices }, events };
  },

  onTimeout(state: unknown, ctx: DriverContext) {
    const s = state as RockPaperScissorsState;
    if (s.winnerPosition !== null || s.draw || s.timeoutPosition !== null) return { state: s, events: [] };
    const submitted = ctx.players.filter((p) => Boolean(s.choices[String(p.position)]));
    if (submitted.length === 1) {
      return {
        state: { ...s, winnerPosition: submitted[0].position, timeoutPosition: ctx.players.find((p) => p.position !== submitted[0].position)?.position ?? null },
        events: [{ type: 'TIMEOUT', actorId: null, payload: { winnerPosition: submitted[0].position, forfeitedPosition: ctx.players.find((p) => p.position !== submitted[0].position)?.position ?? null } }],
      };
    }
    return { state: { ...s, draw: true, timeoutPosition: -1 }, events: [{ type: 'TIMEOUT', actorId: null, payload: { result: 'DRAW', reason: 'no_choices' } }] };
  },

  rankings(state: unknown, ctx: DriverContext): GameStandings {
    const s = state as RockPaperScissorsState;
    return [...ctx.players].sort((a, b) => {
      const aScore = s.winnerPosition === a.position ? 1 : 0;
      const bScore = s.winnerPosition === b.position ? 1 : 0;
      return bScore - aScore || a.position - b.position;
    }).map((p) => ({ userId: p.userId, score: s.winnerPosition === p.position ? 1 : 0, tieBreakMs: 0 }));
  },

  isFinished(state: unknown): boolean {
    const s = state as RockPaperScissorsState;
    return s.winnerPosition !== null || s.draw || s.timeoutPosition !== null;
  },
};
