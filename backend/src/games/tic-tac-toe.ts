import { DriverContext, DriverEvent, DriverResult, GameAction, GameDriver, GameStandings } from './types';

/**
 * Tic-Tac-Toe — the smallest game that can prove the engine is authoritative.
 *
 * The board stores *seat positions*, not user ids: a client cannot claim a cell for a
 * player it is not, and a reconnected user finds the same board because positions are
 * stable for the life of the session.
 */

export type TicTacToeState = {
  /** Owner of each cell: seat position, or null while empty. Nine cells, index 0..8. */
  grid: (number | null)[];
  turnPosition: number;
  winnerPosition: number | null;
  winLine: number[] | null;
  draw: boolean;
  /** Seat that forfeited by letting the clock run out, if any. */
  timeoutPosition: number | null;
  moveCount: number;
};

const LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

const GRID_SIZE = 9;

function emptyGrid(): (number | null)[] {
  return Array.from({ length: GRID_SIZE }, () => null);
}

/** First line of three owned by `player`, as the engine writes it into the finish event. */
function findWin(grid: (number | null)[], player: number): number[] | null {
  for (const line of LINES) {
    if (line.every((cell) => grid[cell] === player)) return line;
  }
  return null;
}

export const ticTacToeDriver: GameDriver = {
  key: 'TIC_TAC_TOE',

  initialState(ctx: DriverContext) {
    const state: TicTacToeState = {
      grid: emptyGrid(),
      // Seat 0 opens. It is the creator by construction, and the rule is stated to both
      // players in the start event rather than left to be inferred.
      turnPosition: ctx.players[0]?.position ?? 0,
      winnerPosition: null,
      winLine: null,
      draw: false,
      timeoutPosition: null,
      moveCount: 0,
    };
    return state;
  },

  turnOwner(state: unknown, ctx: DriverContext) {
    const s = state as TicTacToeState;
    if (s.winnerPosition !== null || s.draw) return null;
    const owner = ctx.players.find((p) => p.position === s.turnPosition);
    // A seat that walked out must not stall the match waiting for its move; the engine
    // treats a missing owner as "nobody to wait for" and the timeout sweep ends it.
    return { userId: owner?.userId ?? null, seconds: ctx.rules.turnTimeoutSeconds };
  },

  applyAction(state: unknown, ctx: DriverContext, actorId: string, action: GameAction): DriverResult {
    const s = state as TicTacToeState;
    if (action.type !== 'MOVE') return { ok: false, code: 'unknown_action', message: `Tic-Tac-Toe only accepts MOVE` };
    if (s.winnerPosition !== null || s.draw) return { ok: false, code: 'game_over', message: 'This game is already over' };

    const actor = ctx.players.find((p) => p.userId === actorId);
    if (!actor) return { ok: false, code: 'not_a_player', message: 'Only the two players can move' };
    if (actor.position !== s.turnPosition) {
      return { ok: false, code: 'out_of_turn', message: 'It is not your move' };
    }

    const raw = action.payload.cell;
    const cell = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isInteger(cell) || cell < 0 || cell >= GRID_SIZE) {
      return { ok: false, code: 'bad_cell', message: 'cell must be a whole number from 0 to 8' };
    }
    if (s.grid[cell] !== null) return { ok: false, code: 'cell_taken', message: 'That square is already played' };

    const grid = [...s.grid];
    grid[cell] = actor.position;
    const moveCount = s.moveCount + 1;
    const winLine = findWin(grid, actor.position);
    const events: DriverEvent[] = [{ type: 'MOVE', actorId, payload: { cell, position: actor.position, moveCount } }];

    if (winLine) {
      return { ok: true, state: { ...s, grid, moveCount, winnerPosition: actor.position, winLine }, events };
    }
    if (moveCount === GRID_SIZE) {
      return { ok: true, state: { ...s, grid, moveCount, draw: true }, events };
    }
    const opponent = ctx.players.find((p) => p.position !== actor.position);
    return { ok: true, state: { ...s, grid, moveCount, turnPosition: opponent?.position ?? actor.position }, events };
  },

  onTimeout(state: unknown, ctx: DriverContext) {
    const s = state as TicTacToeState;
    if (s.winnerPosition !== null || s.draw) return { state: s, events: [] };
    const other = ctx.players.find((p) => p.position !== s.turnPosition);
    // A stalled clock ends the match rather than hanging it: the player who was *not*
    // asked to move wins, because leaving a paid game open is the worse failure.
    const winnerPosition = other?.position ?? s.turnPosition;
    return {
      state: { ...s, winnerPosition, winLine: null, timeoutPosition: s.turnPosition },
      events: [{ type: 'TIMEOUT', actorId: null, payload: { position: s.turnPosition, winnerPosition } }],
    };
  },

  rankings(state: unknown, ctx: DriverContext): GameStandings {
    const s = state as TicTacToeState;
    const byScore = [...ctx.players].sort((a, b) => {
      const sa = s.winnerPosition === a.position ? 2 : s.draw ? 1 : 0;
      const sb = s.winnerPosition === b.position ? 2 : s.draw ? 1 : 0;
      // Draws keep seat order so two players never come back with the same rank.
      if (sa !== sb) return sb - sa;
      return a.position - b.position;
    });
    return byScore.map((p) => ({ userId: p.userId, score: s.winnerPosition === p.position ? 1 : s.draw ? 1 : 0, tieBreakMs: 0 }));
  },

  isFinished(state: unknown): boolean {
    const s = state as TicTacToeState;
    return s.winnerPosition !== null || s.draw;
  },
};
