import { DriverContext, DriverEvent, DriverResult, GameAction, GameDriver, GameStandings } from './types';

export type ConnectFourState = {
  grid: (number | null)[];
  turnPosition: number;
  winnerPosition: number | null;
  winningCells: number[];
  draw: boolean;
  timeoutPosition: number | null;
  moveCount: number;
};

const ROWS = 6;
const COLUMNS = 7;
const DIRECTIONS = [[0, 1], [1, 0], [1, 1], [1, -1]] as const;

function winningLine(grid: (number | null)[], row: number, column: number, seat: number): number[] {
  for (const [dr, dc] of DIRECTIONS) {
    const cells = [row * COLUMNS + column];
    for (const sign of [-1, 1]) {
      let r = row + dr * sign;
      let c = column + dc * sign;
      while (r >= 0 && r < ROWS && c >= 0 && c < COLUMNS && grid[r * COLUMNS + c] === seat) {
        cells.push(r * COLUMNS + c);
        r += dr * sign;
        c += dc * sign;
      }
    }
    if (cells.length >= 4) return cells;
  }
  return [];
}

export const connectFourDriver: GameDriver = {
  key: 'CONNECT_FOUR',

  initialState(ctx: DriverContext): ConnectFourState {
    return {
      grid: Array.from({ length: ROWS * COLUMNS }, () => null),
      turnPosition: ctx.players[0]?.position ?? 0,
      winnerPosition: null,
      winningCells: [],
      draw: false,
      timeoutPosition: null,
      moveCount: 0,
    };
  },

  turnOwner(state: unknown, ctx: DriverContext) {
    const s = state as ConnectFourState;
    if (s.winnerPosition !== null || s.draw) return null;
    const owner = ctx.players.find((p) => p.position === s.turnPosition);
    return { userId: owner?.userId ?? null, seconds: ctx.rules.turnTimeoutSeconds };
  },

  applyAction(state: unknown, ctx: DriverContext, actorId: string, action: GameAction): DriverResult {
    const s = state as ConnectFourState;
    if (action.type !== 'MOVE') return { ok: false, code: 'unknown_action', message: 'Connect Four only accepts MOVE' };
    if (s.winnerPosition !== null || s.draw) return { ok: false, code: 'game_over', message: 'This game is already over' };
    const actor = ctx.players.find((p) => p.userId === actorId);
    if (!actor) return { ok: false, code: 'not_a_player', message: 'Only seated players can drop a disc' };
    if (actor.position !== s.turnPosition) return { ok: false, code: 'out_of_turn', message: 'Wait for your turn' };

    const raw = action.payload.column ?? action.payload.cell;
    const column = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isInteger(column) || column < 0 || column >= COLUMNS) {
      return { ok: false, code: 'bad_column', message: 'Choose a column from 0 to 6' };
    }
    let row = ROWS - 1;
    while (row >= 0 && s.grid[row * COLUMNS + column] !== null) row -= 1;
    if (row < 0) return { ok: false, code: 'column_full', message: 'That column is full' };

    const grid = [...s.grid];
    const cell = row * COLUMNS + column;
    grid[cell] = actor.position;
    const moveCount = s.moveCount + 1;
    const line = winningLine(grid, row, column, actor.position);
    const events: DriverEvent[] = [{
      type: 'MOVE',
      actorId,
      payload: { column, row, cell, position: actor.position, moveCount },
    }];

    if (line.length >= 4) {
      events.push({ type: 'WON', actorId, payload: { position: actor.position, winningCells: line } });
      return { ok: true, state: { ...s, grid, moveCount, winnerPosition: actor.position, winningCells: line }, events };
    }
    if (moveCount === ROWS * COLUMNS) {
      events.push({ type: 'DRAW', actorId: null, payload: { moveCount } });
      return { ok: true, state: { ...s, grid, moveCount, draw: true }, events };
    }
    const next = ctx.players.find((p) => p.position !== actor.position);
    return { ok: true, state: { ...s, grid, moveCount, turnPosition: next?.position ?? actor.position }, events };
  },

  onTimeout(state: unknown, ctx: DriverContext) {
    const s = state as ConnectFourState;
    if (s.winnerPosition !== null || s.draw) return { state: s, events: [] };
    const other = ctx.players.find((p) => p.position !== s.turnPosition);
    const winnerPosition = other?.position ?? s.turnPosition;
    return {
      state: { ...s, winnerPosition, timeoutPosition: s.turnPosition },
      events: [{ type: 'TIMEOUT', actorId: null, payload: { position: s.turnPosition, winnerPosition } }],
    };
  },

  rankings(state: unknown, ctx: DriverContext): GameStandings {
    const s = state as ConnectFourState;
    return [...ctx.players]
      .sort((a, b) => {
        const aScore = s.winnerPosition === a.position ? 1 : 0;
        const bScore = s.winnerPosition === b.position ? 1 : 0;
        return bScore - aScore || a.position - b.position;
      })
      .map((p) => ({ userId: p.userId, score: s.winnerPosition === p.position ? 1 : 0, tieBreakMs: 0 }));
  },

  isFinished(state: unknown): boolean {
    const s = state as ConnectFourState;
    return s.winnerPosition !== null || s.draw;
  },
};
