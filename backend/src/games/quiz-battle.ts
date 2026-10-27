import { randomInt } from 'node:crypto';
import { DriverContext, DriverEvent, DriverResult, GameAction, GameDriver, GameStandings } from './types';
import { QUIZ_BANK } from './quiz-bank';

/**
 * Quiz Battle — a round-based race against the server clock.
 *
 * There is no turn owner: the round is open to everyone at once, so `turnOwner` returns a
 * null user and the engine only sets a deadline. Latency is measured with `ctx.nowMs`
 * minus the moment the round opened, both server-side; a client that sends its own timing
 * is ignored, and a client that answers after the window closes is refused.
 */

export type QuizQuestion = { id: number; prompt: string; options: string[]; answerIndex: number };

export type QuizAnswer = { optionIndex: number; correct: boolean; points: number; latencyMs: number };

export type QuizState = {
  questions: QuizQuestion[];
  /** Round being answered now. The engine will not accept an answer for any other. */
  index: number;
  roundStartedAtMs: number;
  secondsPerQuestion: number;
  correctPoints: number;
  maxSpeedBonus: number;
  /** userId -> round number -> answer. A round with no entry was missed. */
  answers: Record<string, Record<string, QuizAnswer>>;
  finished: boolean;
};

/**
 * Slack for one-way network delay on a mobile client. Without it, a player on a bad
 * connection is refused an answer that left before the clock expired, which reads as a
 * rigged game. It is small on purpose: 1.5 s of a 15 s round.
 */
const GRACE_MS = 1_500;

const intOr = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

function shuffle<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * The host's own questions, if the session was created with any, otherwise the bank.
 * Anything malformed is dropped rather than trusted: a prompt over the cap or an answer
 * index outside the options would otherwise become part of an authoritative round.
 */
function customQuestions(raw: unknown): QuizQuestion[] {
  if (!Array.isArray(raw)) return [];
  const accepted: QuizQuestion[] = [];
  for (const item of raw) {
    const prompt = typeof (item as QuizQuestion)?.prompt === 'string' ? (item as QuizQuestion).prompt.trim().slice(0, 200) : '';
    const options = Array.isArray((item as QuizQuestion)?.options)
      ? (item as QuizQuestion).options.filter((o): o is string => typeof o === 'string').slice(0, 6)
      : [];
    const answer = Number((item as QuizQuestion)?.answerIndex);
    if (prompt.length < 5 || options.length < 2 || !Number.isInteger(answer) || answer < 0 || answer >= options.length) continue;
    accepted.push({ id: accepted.length + 1, prompt, options, answerIndex: answer });
  }
  return accepted;
}

function buildQuestions(ctx: DriverContext): QuizQuestion[] {
  const rounds = intOr(ctx.rules.config.rounds, 5, 1, 20);
  const authored = customQuestions(ctx.rules.config.questions);
  const bank = QUIZ_BANK.map((q) => ({ prompt: q.prompt, options: [...q.options], answerIndex: q.answer }));
  const source = authored.length >= rounds ? shuffle(authored).slice(0, rounds) : shuffle(bank).slice(0, rounds);

  return source.map((q, i) => {
    // Shuffle the option order too, so the right answer is not always the letter it was
    // written under, and carry the answer index along with it.
    const pairs = shuffle(q.options.map((text, original) => ({ text, original })));
    return {
      id: i + 1,
      prompt: q.prompt,
      options: pairs.map((p) => p.text),
      answerIndex: pairs.findIndex((p) => p.original === q.answerIndex),
    };
  });
}

function totalScore(state: QuizState, userId: string): number {
  const rounds = state.answers[userId];
  if (!rounds) return 0;
  return Object.values(rounds).reduce((sum, a) => sum + a.points, 0);
}

function totalLatency(state: QuizState, userId: string): number {
  const rounds = state.answers[userId] ?? {};
  const windowMs = state.secondsPerQuestion * 1_000;
  let total = 0;
  for (let index = 0; index < state.questions.length; index += 1) {
    const answer = rounds[String(index)];
    // A missed round counts as a full window of slow, so answering late still beats not
    // answering at all — but never beats a correct answer.
    total += answer ? answer.latencyMs : windowMs;
  }
  return total;
}

/** Move to the next round, or mark the match over. Always server-initiated. */
function advance(state: QuizState, ctx: DriverContext, events: DriverEvent[]) {
  const question = state.questions[state.index];
  if (question) {
    events.push({
      type: 'ROUND_CLOSED',
      actorId: null,
      payload: { index: state.index, answerIndex: question.answerIndex, prompt: question.prompt, options: question.options },
    });
  }
  const next = state.index + 1;
  if (next >= state.questions.length) {
    return { ...state, index: next, finished: true };
  }
  return { ...state, index: next, roundStartedAtMs: ctx.nowMs };
}

export const quizBattleDriver: GameDriver = {
  key: 'QUIZ_BATTLE',

  initialState(ctx: DriverContext): QuizState {
    return {
      questions: buildQuestions(ctx),
      index: 0,
      roundStartedAtMs: ctx.nowMs,
      secondsPerQuestion: intOr(ctx.rules.config.secondsPerQuestion, 15, 5, 120),
      correctPoints: intOr(ctx.rules.config.correctPoints, 100, 1, 10_000),
      maxSpeedBonus: intOr(ctx.rules.config.maxSpeedBonus, 50, 0, 10_000),
      answers: {},
      finished: false,
    };
  },

  turnOwner(state: unknown, ctx: DriverContext) {
    const s = state as QuizState;
    if (s.finished) return null;
    // Everyone answers at once; the deadline is the only thing the engine owes the round.
    return { userId: null, seconds: s.secondsPerQuestion };
  },

  applyAction(state: unknown, ctx: DriverContext, actorId: string, action: GameAction): DriverResult {
    const s = state as QuizState;
    if (action.type !== 'ANSWER') return { ok: false, code: 'unknown_action', message: 'Quiz Battle only accepts ANSWER' };
    if (s.finished) return { ok: false, code: 'game_over', message: 'This quiz is over' };
    if (!ctx.players.some((p) => p.userId === actorId)) return { ok: false, code: 'not_a_player', message: 'You are not in this quiz' };

    const rawIndex = action.payload.questionIndex;
    const index = typeof rawIndex === 'number' || typeof rawIndex === 'string' ? Number(rawIndex) : NaN;
    if (!Number.isInteger(index)) return { ok: false, code: 'bad_question', message: 'questionIndex must be a whole number' };
    // The server decides which round is open. Re-answering an old round or pre-answering
    // a future one both fail here, which is also what makes a replayed payload worthless.
    if (index !== s.index) {
      return { ok: false, code: index < s.index ? 'round_closed' : 'round_not_open', message: 'That question is not the live round' };
    }

    const question = s.questions[s.index];
    const rawOption = action.payload.optionIndex;
    const optionIndex = typeof rawOption === 'number' || typeof rawOption === 'string' ? Number(rawOption) : NaN;
    if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length) {
      return { ok: false, code: 'bad_option', message: 'optionIndex is not one of this question’s answers' };
    }

    const mine = s.answers[actorId] ?? {};
    if (mine[String(index)]) return { ok: false, code: 'already_answered', message: 'You already answered this round' };

    const latencyMs = Math.max(0, ctx.nowMs - s.roundStartedAtMs);
    if (latencyMs > s.secondsPerQuestion * 1_000 + GRACE_MS) {
      return { ok: false, code: 'too_late', message: 'The clock on this round already ran out' };
    }

    const correct = optionIndex === question.answerIndex;
    // Speed bonus decays linearly across the round and never goes negative.
    const speedFraction = Math.max(0, 1 - latencyMs / (s.secondsPerQuestion * 1_000));
    const points = (correct ? s.correctPoints : 0) + (correct ? Math.round(s.maxSpeedBonus * speedFraction) : 0);
    const answer: QuizAnswer = { optionIndex, correct, points, latencyMs };

    const events: DriverEvent[] = [
      { type: 'ANSWER', actorId, payload: { questionIndex: index, correct, points, latencyMs } },
    ];
    let next: QuizState = {
      ...s,
      answers: { ...s.answers, [actorId]: { ...mine, [String(index)]: answer } },
    };
    if (ctx.players.every((p) => next.answers[p.userId]?.[String(index)])) next = advance(next, ctx, events);
    return { ok: true, state: next, events };
  },

  onTimeout(state: unknown, ctx: DriverContext) {
    const s = state as QuizState;
    if (s.finished) return { state: s, events: [] };
    const missed = ctx.players.filter((p) => !s.answers[p.userId]?.[String(s.index)]).map((p) => p.userId);
    const events: DriverEvent[] = [{ type: 'ROUND_TIMEOUT', actorId: null, payload: { index: s.index, missed } }];
    return { state: advance(s, ctx, events), events };
  },

  rankings(state: unknown, ctx: DriverContext): GameStandings {
    const s = state as QuizState;
    return [...ctx.players]
      .map((p) => ({ userId: p.userId, position: p.position, score: totalScore(s, p.userId), tieBreakMs: totalLatency(s, p.userId) }))
      .sort((a, b) => b.score - a.score || a.tieBreakMs - b.tieBreakMs || a.position - b.position)
      .map(({ userId, score, tieBreakMs }) => ({ userId, score, tieBreakMs }));
  },

  isFinished(state: unknown): boolean {
    return (state as QuizState).finished === true;
  },
};
