import { randomInt } from 'node:crypto';
import { DriverContext, DriverEvent, DriverResult, GameAction, GameDriver, GameStandings } from './types';

/**
 * Ludo Party — a ludo-style race, server-rolled.
 *
 * The dice is `randomInt` from node's CSPRNG, rolled inside the action that consumes it
 * and written to `game_events` in the same statement, so a roll is born on the server,
 * is visible in the audit log, and cannot be re-rolled by a client that disliked it.
 *
 * Piece progress is one number, `steps`: -1 in the yard, 0..51 on the shared track,
 * 52..56 in the player's home column, 57 home. A piece may only finish on the exact roll
 * that lands it on 57, which is the rule that makes "just keep rolling" a losing strategy.
 *
 * Simplified on purpose: no own-piece blocking, and captures always send the opponent
 * back to their yard. Two-player boards use seats 0 and 13, the same offsets a four-player
 * board has, so one geometry serves every table size.
 */

export const TRACK = 52;
export const HOME_COLUMN = 6;
/** `steps` value of a piece that is finished. */
export const HOME = TRACK + HOME_COLUMN - 1;

/** The star squares: each player's entry cell and the eight after it. */
const SAFE_CELLS = new Set([0, 8, 13, 21, 26, 34, 39, 47]);

export type LudoPlayerState = {
  position: number;
  /** One entry per piece; -1 = still in the yard, HOME = finished. */
  pieces: number[];
  /** Dice waiting to be spent, cleared by a move, a pass or a timeout. */
  pendingRoll: number | null;
  piecesHome: number;
};

export type LudoState = {
  startRoll: number;
  turnPosition: number;
  /** Seat offsets are fixed per player so a reconnect cannot move anyone's home lane. */
  players: Record<string, LudoPlayerState>;
  /** Seat position -> user id, kept because JSON turns numeric keys into strings. */
  order: number[];
  finished: boolean;
  winnerPosition: number | null;
  rollCount: number;
};

const cellOf = (offset: number, steps: number): number => (offset + steps) % TRACK;
const offsetOf = (position: number): number => (position * 13) % TRACK;

function legalTargets(s: LudoState, me: LudoPlayerState, roll: number): number[] {
  const targets: number[] = [];
  me.pieces.forEach((steps, piece) => {
    if (steps === -1) {
      if (roll === s.startRoll) targets.push(piece);
      return;
    }
    if (steps >= HOME) return;
    if (steps + roll <= HOME) targets.push(piece);
  });
  return targets;
}

/** Who may move next: the next seat clockwise that still has tokens out to play. */
function nextTurn(s: LudoState, fromPosition: number): number {
  const seats = s.order.length;
  for (let hop = 1; hop <= seats; hop += 1) {
    const candidate = (fromPosition + hop) % seats;
    const player = s.players[String(candidate)];
    // A seat that brought all four tokens home is done; it stays skipped for the rest of
    // the match instead of burning turns it cannot use.
    if (player && player.piecesHome < player.pieces.length) return candidate;
  }
  return fromPosition;
}

function withPlayer(s: LudoState, position: number, patch: Partial<LudoPlayerState>): Record<string, LudoPlayerState> {
  const key = String(position);
  return { ...s.players, [key]: { ...s.players[key], ...patch } };
}

function scoreOf(me: LudoPlayerState): number {
  return me.piecesHome * 1_000 + me.pieces.reduce((sum, steps) => sum + Math.max(0, steps), 0);
}

export const ludoDriver: GameDriver = {
  key: 'LUDO',

  initialState(ctx: DriverContext): LudoState {
    const pieces = Math.max(1, Math.min(4, Math.round(Number(ctx.rules.config.pieces ?? 4))));
    const startRoll = Math.max(1, Math.min(6, Math.round(Number(ctx.rules.config.startRoll ?? 6))));
    const order: number[] = [];
    const players: Record<string, LudoPlayerState> = {};
    for (const p of ctx.players) {
      order.push(p.position);
      players[String(p.position)] = { position: p.position, pieces: Array.from({ length: pieces }, () => -1), pendingRoll: null, piecesHome: 0 };
    }
    order.sort((a, b) => a - b);
    return {
      startRoll,
      // Highest seat starts, so the creator does not automatically get first move every time.
      turnPosition: order[order.length - 1] ?? 0,
      players,
      order,
      finished: false,
      winnerPosition: null,
      rollCount: 0,
    };
  },

  turnOwner(state: unknown, ctx: DriverContext) {
    const s = state as LudoState;
    if (s.finished) return null;
    const owner = ctx.players.find((p) => p.position === s.turnPosition);
    // A seat that left the audio room never gets its turn back; the sweep passes it.
    return { userId: owner?.userId ?? null, seconds: ctx.rules.turnTimeoutSeconds };
  },

  applyAction(state: unknown, ctx: DriverContext, actorId: string, action: GameAction): DriverResult {
    const s = state as LudoState;
    if (s.finished) return { ok: false, code: 'game_over', message: 'This game is already over' };
    const seat = ctx.players.find((p) => p.userId === actorId);
    if (!seat) return { ok: false, code: 'not_a_player', message: 'You are not seated at this board' };
    const me = s.players[String(seat.position)];
    if (!me) return { ok: false, code: 'not_seated', message: 'This board has no seat for you' };
    if (s.turnPosition !== me.position) return { ok: false, code: 'out_of_turn', message: 'Wait for your turn' };

    if (action.type === 'ROLL') {
      if (me.pendingRoll !== null) return { ok: false, code: 'already_rolled', message: 'Spend the dice you already have' };
      const roll = randomInt(1, 7);
      const events: DriverEvent[] = [{ type: 'DICE', actorId, payload: { roll, position: me.position, targets: legalTargets(s, me, roll) } }];
      // Recorded before the choice, so the number a player then moves against is on the log.
      return { ok: true, state: { ...s, rollCount: s.rollCount + 1, players: withPlayer(s, me.position, { pendingRoll: roll }) }, events };
    }

    if (action.type !== 'MOVE') return { ok: false, code: 'unknown_action', message: 'Ludo accepts ROLL or MOVE' };
    if (me.pendingRoll === null) return { ok: false, code: 'no_roll', message: 'Roll the dice first' };

    const raw = action.payload.piece;
    const piece = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isInteger(piece) || piece < 0 || piece >= me.pieces.length) {
      return { ok: false, code: 'bad_piece', message: 'piece is not one of your tokens' };
    }
    const roll = me.pendingRoll;
    if (!legalTargets(s, me, roll).includes(piece)) {
      // Covers moving a yard piece without a six, overshooting home, and moving a token
      // that already finished — the three impossible moves a tampered client tries most.
      return { ok: false, code: 'illegal_move', message: 'That token cannot move this way' };
    }

    const steps = me.pieces[piece] === -1 ? 0 : me.pieces[piece] + roll;
    const pieces = [...me.pieces];
    pieces[piece] = steps;
    const piecesHome = pieces.filter((v) => v >= HOME).length;
    const events: DriverEvent[] = [
      { type: 'MOVE', actorId, payload: { piece, from: me.pieces[piece], to: steps, roll, position: me.position } },
    ];

    let players = withPlayer(s, me.position, { pieces, piecesHome, pendingRoll: null });
    let captured = false;
    // Capture: an opponent on the same track cell, off a star square, goes back to their
    // yard. Home-column cells belong to one lane only, so nothing there can be taken.
    if (steps < TRACK) {
      const cell = cellOf(offsetOf(me.position), steps);
      if (!SAFE_CELLS.has(cell)) {
        for (const other of Object.values(s.players)) {
          if (other.position === me.position) continue;
          const hit = other.pieces.findIndex((v) => v >= 0 && v < TRACK && cellOf(offsetOf(other.position), v) === cell);
          if (hit < 0) continue;
          const reset = [...other.pieces];
          reset[hit] = -1;
          players = { ...players, [String(other.position)]: { ...other, pieces: reset, piecesHome: 0 } };
          captured = true;
          events.push({ type: 'CAPTURE', actorId, payload: { cell, victimPosition: other.position, piece: hit } });
          break;
        }
      }
    }

    const finished = piecesHome >= pieces.length;
    const earnedAnotherTurn = roll === s.startRoll || captured || steps === HOME;
    const next: LudoState = {
      ...s,
      players,
      finished,
      winnerPosition: finished ? me.position : null,
      // A six, a capture or a token brought home keeps the dice in the same hand; the
      // turn only passes when the roll bought nothing.
      turnPosition: finished || earnedAnotherTurn ? me.position : nextTurn({ ...s, players }, me.position),
    };
    if (finished) events.push({ type: 'WON', actorId, payload: { position: me.position } });
    return { ok: true, state: next, events };
  },

  onTimeout(state: unknown, ctx: DriverContext) {
    const s = state as LudoState;
    if (s.finished) return { state: s, events: [] };
    const me = s.players[String(s.turnPosition)];
    if (!me) return { state: s, events: [] };
    // A frozen player loses the dice rather than the board: nothing they moved is undone,
    // and the seat behind them is not held hostage by a phone in a tunnel.
    const players = withPlayer(s, me.position, { pendingRoll: null });
    const turnPosition = nextTurn({ ...s, players }, me.position);
    return {
      state: { ...s, players, turnPosition },
      events: [{ type: 'TIMEOUT', actorId: null, payload: { position: me.position, turnPosition } }],
    };
  },

  rankings(state: unknown, ctx: DriverContext): GameStandings {
    const s = state as LudoState;
    return ctx.players
      .map((p) => {
        const me = s.players[String(p.position)];
        return {
          userId: p.userId,
          position: p.position,
          score: me ? scoreOf(me) : 0,
          tieBreakMs: 0,
        };
      })
      .sort((a, b) => b.score - a.score || a.position - b.position)
      .map(({ userId, score, tieBreakMs }) => ({ userId, score, tieBreakMs }));
  },

  isFinished(state: unknown): boolean {
    return (state as LudoState).finished === true;
  },
};
