import { ApiError } from '../utils/http';
import { GameDriver } from './types';
import { ticTacToeDriver } from './tic-tac-toe';
import { quizBattleDriver } from './quiz-battle';
import { ludoDriver } from './ludo';

/**
 * The game registry. Adding a game means writing a driver and listing it here; the
 * engine, the fee reservation, the settlement and the audit log are shared, which is the
 * point — a second, hand-rolled wallet per game is how a platform ends up with two
 * definitions of "paid".
 */
const DRIVERS = new Map<string, GameDriver>(
  [ticTacToeDriver, quizBattleDriver, ludoDriver].map((driver) => [driver.key, driver]),
);

export function driverFor(key: string): GameDriver {
  const driver = DRIVERS.get(key);
  if (!driver) throw ApiError.notFound(`No game engine is registered for ${key}`, 'game_not_supported');
  return driver;
}

export function isRegisteredGame(key: string): boolean {
  return DRIVERS.has(key);
}

export function registeredGameKeys(): string[] {
  return [...DRIVERS.keys()];
}

export type { DriverContext, DriverResult, GameAction, GameDriver, GamePlayer, GameStandings } from './types';
