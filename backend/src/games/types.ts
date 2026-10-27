import { PinnedGameRules } from '../types/db';

/**
 * The contract every game plugs into the engine with.
 *
 * Nothing here touches the database, the wallet or the socket. A driver is a pure
 * function of (state, action) -> state, which is what makes an "impossible move" a
 * testable rejection instead of a stack trace, and it is why one engine, one fee
 * reservation and one settlement path can serve every game in the app.
 *
 * Rules that affect money are read from the session's pinned snapshot, never from the
 * live definition, so an operator editing a commission mid-match cannot change what a
 * running game pays.
 */

export type GamePlayer = {
  userId: string;
  /** Board slot, assigned by the engine in join order. Never client-chosen. */
  position: number;
};

export type DriverContext = {
  sessionId: string;
  roomId: string | null;
  rules: PinnedGameRules;
  /** Active players in position order. */
  players: GamePlayer[];
  /**
   * The server's clock, in epoch ms, taken when the engine opened this call. Latency and
   * every "did you answer in time" decision is measured against it, because a client
   * that reports its own elapsed time can report anything it likes.
   */
  nowMs: number;
};

export type GameAction = {
  type: string;
  payload: Record<string, unknown>;
};

export type DriverEvent = {
  /** 'MOVE' | 'ANSWER' | 'DICE' | 'TIMEOUT' | ... — recorded in game_events and broadcast. */
  type: string;
  actorId?: string | null;
  payload?: Record<string, unknown>;
};

export type DriverResult = { ok: true; state: unknown; events: DriverEvent[] } | { ok: false; code: string; message: string };

export type GameStandings = Array<{ userId: string; score: number; tieBreakMs: number }>;

export interface GameDriver {
  readonly key: string;

  /**
   * Build the opening board. Called once, when the session moves READY -> IN_PROGRESS,
   * with the player list frozen for that match.
   */
  initialState(ctx: DriverContext): unknown;

  /**
   * Whose move it is, or null when the game is waiting on the clock rather than a
   * player (Quiz Battle: the round is open to everyone at once).
   */
  turnOwner(state: unknown, ctx: DriverContext): { userId: string | null; seconds: number } | null;

  /**
   * Validate and apply one action from `actorId`. Must reject anything a tampered client
   * could invent: out-of-turn moves, occupied cells, a second answer to a question,
   * a piece hopping onto a blocked square, a payload with keys it has no business
   * sending. Returning `ok: false` costs the player nothing.
   */
  applyAction(state: unknown, ctx: DriverContext, actorId: string, action: GameAction): DriverResult;

  /**
   * The clock ran out. A driver may forfeit, pass, or score the non-answers as zero and
   * move on. The engine persists whatever comes back and then asks `isFinished`, so a
   * driver that only advances the round must leave the game unfinished here.
   */
  onTimeout(state: unknown, ctx: DriverContext): { state: unknown; events: DriverEvent[] };

  /** Final standings, rank 1 first. The engine turns this into ranks, prizes and disputes. */
  rankings(state: unknown, ctx: DriverContext): GameStandings;

  /**
   * True when no further action can change the outcome. The engine settles on the first
   * one it sees, so a driver that reports a finish early over-pays; a driver that reports
   * it late only leaves the game looking stuck.
   */
  isFinished(state: unknown, ctx: DriverContext): boolean;
}
