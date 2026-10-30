import { PoolClient } from 'pg';
import { many, one, withTransaction } from '../config/db';
import { DailyCheckinRow, DailyQuestRow, QuestSettingsRow } from '../types/db';
import { ApiError, requireBoolean, requireEnum, requireInt, requireString } from '../utils/http';
import { toUser, UserDto } from '../utils/serialize';
import { awardXp, ensureRankRegistry } from './rank.service';

/**
 * Daily activity: a handful of quests that reset at midnight in the platform's timezone, and a
 * check-in that pays a little more the longer a member keeps the streak.
 *
 * `rank.service` owns the ladder; this file only decides *when* it is climbed. That split is the
 * whole safety argument: nothing here accepts an XP value from a request body. A quest records a
 * counter that a server-side event incremented (a gift posted in the ledger, a chat row stored by
 * the room service), and the reward is a column on the quest row. The phone can show progress; it
 * cannot write it.
 *
 * Two rules shape the storage:
 *
 *   * **"Today" is a date in `quest_settings.reset_timezone`.** PostgreSQL resolves it
 *     (`now() AT TIME ZONE ...`) rather than Node, so a device with a wrong clock, or a server in a
 *     different zone from the operator, cannot open tomorrow early.
 *   * **A day's progress is keyed by that date.** A new day simply has no rows, so no reset job has
 *     to run at midnight and a failed job cannot leave half the platform a day behind.
 */

export const QUEST_METRICS = ['GIFT_SENT', 'DIAMONDS_SPENT', 'CHAT_MESSAGE'] as const;
export type QuestMetric = (typeof QUEST_METRICS)[number];

/** Matches the CHECK on `daily_quests.key`; validated here to fail with a readable message. */
const QUEST_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;

type SettingsWithDay = QuestSettingsRow & { today: string; yesterday: string };

export type QuestSettingsDto = {
  resetTimezone: string;
  checkinBaseXp: number;
  checkinStreakStepXp: number;
  checkinMaxStreakDays: number;
};

export type QuestDto = {
  key: string;
  title: string;
  description: string;
  metric: QuestMetric;
  target: number;
  progress: number;
  xpReward: number;
  completed: boolean;
  completedAt: string | null;
  /** What finishing it actually paid; 0 until then. Not `xpReward` — an operator can re-price later. */
  xpAwarded: number;
};

export type CheckInDto = {
  /** true when this member has not checked in today. */
  available: boolean;
  done: boolean;
  /** The streak that stands right now: today's row, or yesterday's if today is still open. */
  streakDay: number;
  /** What today's check-in paid, or 0. */
  xpAwardedToday: number;
  /** What the next check-in (today or tomorrow) will pay. */
  nextRewardXp: number;
  /** The streak value that next check-in will record. */
  nextStreakDay: number;
  baseXp: number;
  streakStepXp: number;
  maxStreakDays: number;
};

export type QuestsTodayDto = {
  date: string;
  resetTimezone: string;
  quests: QuestDto[];
  completedCount: number;
  xpEarnedToday: number;
  checkIn: CheckInDto;
};

/** One qualifying server-side event. `amount` is never accepted from a client. */
export type QuestEvent = { metric: QuestMetric; amount: number };

// ---------------------------------------------------------------------------
// Settings and the day boundary
// ---------------------------------------------------------------------------

/**
 * The dials and the local date they currently produce. `::text` on the date is deliberate:
 * node-postgres would otherwise hand back a JS `Date` at the *process* timezone's midnight, which
 * is exactly the confusion this column exists to avoid.
 */
async function readSettings(client?: PoolClient): Promise<SettingsWithDay> {
  const sql = `
    SELECT s.*,
           (now() AT TIME ZONE s.reset_timezone)::date::text AS today,
           ((now() AT TIME ZONE s.reset_timezone)::date - 1)::text AS yesterday
      FROM quest_settings s
     WHERE s.singleton`;
  const row = client ? (await client.query<SettingsWithDay>(sql)).rows[0] : await one<SettingsWithDay>(sql);
  if (!row) {
    throw new Error('quest_settings has no row — run npm run db:migrate before starting the API');
  }
  return row;
}

function toSettingsDto(row: SettingsWithDay): QuestSettingsDto {
  return {
    resetTimezone: row.reset_timezone,
    checkinBaseXp: row.checkin_base_xp,
    checkinStreakStepXp: row.checkin_streak_step_xp,
    checkinMaxStreakDays: row.checkin_max_streak_days,
  };
}

/**
 * What a check-in on `streakDay` pays: the base, then one step per consecutive day, capped at
 * `checkinMaxStreakDays` so a very long streak does not turn into a salary.
 */
function checkInReward(streakDay: number, settings: QuestSettingsDto): number {
  const counted = Math.min(Math.max(1, streakDay), settings.checkinMaxStreakDays);
  return settings.checkinBaseXp + (counted - 1) * settings.checkinStreakStepXp;
}

// ---------------------------------------------------------------------------
// The member's screen
// ---------------------------------------------------------------------------

export async function questsForToday(userId: string): Promise<QuestsTodayDto> {
  const settingsRow = await readSettings();
  const today = settingsRow.today;

  const [questRows, progressRows, todayCheckin, yesterdayCheckin] = await Promise.all([
    many<DailyQuestRow>('SELECT * FROM daily_quests WHERE is_active ORDER BY sort_order, key'),
    many<{ quest_key: string; progress: number; completed_at: Date | null; xp_awarded: number }>(
      'SELECT quest_key, progress, completed_at, xp_awarded FROM quest_progress WHERE user_id = $1 AND quest_date = $2::date',
      [userId, today],
    ),
    one<DailyCheckinRow>('SELECT * FROM daily_checkins WHERE user_id = $1 AND checkin_date = $2::date', [userId, today]),
    one<DailyCheckinRow>('SELECT * FROM daily_checkins WHERE user_id = $1 AND checkin_date = $2::date', [
      userId,
      settingsRow.yesterday,
    ]),
  ]);

  const progressByKey = new Map(progressRows.map((row) => [row.quest_key, row]));
  const quests: QuestDto[] = questRows.map((row) => {
    const progress = progressByKey.get(row.key);
    return {
      key: row.key,
      title: row.title,
      description: row.description,
      metric: row.metric as QuestMetric,
      target: row.target,
      progress: progress?.progress ?? 0,
      xpReward: row.xp_reward,
      completed: Boolean(progress?.completed_at),
      completedAt: progress?.completed_at ? progress.completed_at.toISOString() : null,
      xpAwarded: progress?.xp_awarded ?? 0,
    };
  });

  const settings = toSettingsDto(settingsRow);
  const carriedStreak = todayCheckin?.streak_day ?? yesterdayCheckin?.streak_day ?? 0;
  const nextStreakDay = todayCheckin ? todayCheckin.streak_day + 1 : carriedStreak + 1;
  const checkIn: CheckInDto = {
    available: !todayCheckin,
    done: Boolean(todayCheckin),
    streakDay: carriedStreak,
    xpAwardedToday: todayCheckin?.xp_awarded ?? 0,
    nextRewardXp: checkInReward(nextStreakDay, settings),
    nextStreakDay,
    baseXp: settings.checkinBaseXp,
    streakStepXp: settings.checkinStreakStepXp,
    maxStreakDays: settings.checkinMaxStreakDays,
  };

  const questXp = quests.reduce((sum, quest) => sum + quest.xpAwarded, 0);
  return {
    date: today,
    resetTimezone: settings.resetTimezone,
    quests,
    completedCount: quests.filter((quest) => quest.completed).length,
    xpEarnedToday: questXp + checkIn.xpAwardedToday,
    checkIn,
  };
}

/**
 * Check in for the local day.
 *
 * The streak comes from yesterday's row inside the same INSERT, so two taps arriving together
 * cannot each start a streak: the second insert conflicts and returns no row, which is the
 * "already checked in" refusal. The XP is awarded by `rank.service.awardXp` in the same
 * transaction, so a check-in that rolls back leaves no streak behind either.
 */
export async function checkIn(userId: string): Promise<{ status: QuestsTodayDto; xpAwarded: number; user: UserDto }> {
  await ensureRankRegistry();

  const result = await withTransaction(async (client) => {
    // Read the dials first so a missing settings row fails before anything is written.
    await readSettings(client);
    const inserted = await client.query<DailyCheckinRow>(
      `INSERT INTO daily_checkins (user_id, checkin_date, streak_day, xp_awarded)
       SELECT $1, s.today::date,
              LEAST(365, COALESCE(prev.streak_day, 0) + 1),
              s.checkin_base_xp
                + (LEAST(s.checkin_max_streak_days, LEAST(365, COALESCE(prev.streak_day, 0) + 1)) - 1)
                  * s.checkin_streak_step_xp
         FROM (SELECT (now() AT TIME ZONE reset_timezone)::date AS today,
                      checkin_base_xp, checkin_max_streak_days, checkin_streak_step_xp
                 FROM quest_settings WHERE singleton) s
         LEFT JOIN daily_checkins prev
                ON prev.user_id = $1
               AND prev.checkin_date = s.today - 1
       ON CONFLICT (user_id, checkin_date) DO NOTHING
       RETURNING *`,
      [userId],
    );
    const row = inserted.rows[0];
    if (!row) throw ApiError.conflict('You already checked in today', 'already_checked_in');

    await awardXp(client, userId, row.xp_awarded);
    const fresh = await client.query('SELECT * FROM users WHERE id = $1', [userId]);
    if (fresh.rows.length === 0) throw ApiError.notFound('Account not found');
    return { xpAwarded: row.xp_awarded, user: toUser(fresh.rows[0]) };
  });

  return { ...result, status: await questsForToday(userId) };
}

// ---------------------------------------------------------------------------
// Recording progress (server-side events only)
// ---------------------------------------------------------------------------

/**
 * Advance every live quest listening to `events` and pay the ones that just finished.
 *
 * Must be called with a client that is already inside the transaction that recorded the qualifying
 * action — the gift ledger does this — so a gift that rolls back cannot leave quest progress (or
 * the XP the progress paid) behind. Rewards are claimed by a conditional UPDATE on
 * `completed_at IS NULL`, which is what makes two qualifying events in one transaction pay once.
 */
export async function recordQuestProgress(
  client: PoolClient,
  userId: string,
  events: QuestEvent[],
): Promise<{ xpAwarded: number; completed: string[] }> {
  const usable = events
    .map((event) => ({ metric: event.metric, amount: Math.floor(event.amount) }))
    .filter((event) => event.amount > 0);
  if (usable.length === 0) return { xpAwarded: 0, completed: [] };

  const { today } = await readSettings(client);

  for (const event of usable) {
    await client.query(
      `INSERT INTO quest_progress (user_id, quest_date, quest_key, progress)
       SELECT $1, $2::date, q.key, LEAST(q.target, $3::int)
         FROM daily_quests q
        WHERE q.is_active AND q.metric = $4
       ON CONFLICT (user_id, quest_date, quest_key) DO UPDATE
          SET progress = LEAST(
                (SELECT t.target FROM daily_quests t WHERE t.key = quest_progress.quest_key),
                quest_progress.progress + EXCLUDED.progress
              ),
              updated_at = now()`,
      [userId, today, event.amount, event.metric],
    );
  }

  const finished = await client.query<{ quest_key: string; xp_reward: number }>(
    `UPDATE quest_progress p
        SET completed_at = now(), xp_awarded = q.xp_reward, updated_at = now()
       FROM daily_quests q
      WHERE q.key = p.quest_key
        AND p.user_id = $1
        AND p.quest_date = $2::date
        AND p.completed_at IS NULL
        AND p.progress >= q.target
      RETURNING p.quest_key, q.xp_reward`,
    [userId, today],
  );

  const xpAwarded = finished.rows.reduce((sum, row) => sum + row.xp_reward, 0);
  if (xpAwarded > 0) await awardXp(client, userId, xpAwarded);
  return { xpAwarded, completed: finished.rows.map((row) => row.quest_key) };
}

/** Same recording, for callers that are not in a transaction and cannot fail because of it. */
export async function recordQuestProgressOutside(userId: string, events: QuestEvent[]): Promise<void> {
  await withTransaction((client) => recordQuestProgress(client, userId, events));
}

// ---------------------------------------------------------------------------
// Admin reads and writes
// ---------------------------------------------------------------------------

export type AdminQuestRow = QuestDto & {
  isActive: boolean;
  sortOrder: number;
  /** Members who finished it today — what an operator checks after making one easier or harder. */
  completedToday: number;
};

export type AdminQuestsDto = {
  today: string;
  settings: QuestSettingsDto;
  quests: AdminQuestRow[];
};

export async function listAdminQuests(): Promise<AdminQuestsDto> {
  const settingsRow = await readSettings();
  const [rows, counts] = await Promise.all([
    many<DailyQuestRow>('SELECT * FROM daily_quests ORDER BY sort_order, key'),
    many<{ quest_key: string; n: string }>(
      'SELECT quest_key, count(*)::text AS n FROM quest_progress WHERE quest_date = $1::date AND completed_at IS NOT NULL GROUP BY quest_key',
      [settingsRow.today],
    ),
  ]);
  const completedByKey = new Map(counts.map((row) => [row.quest_key, Number(row.n)]));
  return {
    today: settingsRow.today,
    settings: toSettingsDto(settingsRow),
    quests: rows.map((row) => ({
      key: row.key,
      title: row.title,
      description: row.description,
      metric: row.metric as QuestMetric,
      target: row.target,
      progress: 0,
      xpReward: row.xp_reward,
      completed: false,
      completedAt: null,
      xpAwarded: 0,
      isActive: row.is_active,
      sortOrder: row.sort_order,
      completedToday: completedByKey.get(row.key) ?? 0,
    })),
  };
}

type QuestChanges = {
  title?: string;
  description?: string;
  metric?: QuestMetric;
  target?: number;
  xpReward?: number;
  isActive?: boolean;
  sortOrder?: number;
};

function readQuestBody(body: Record<string, unknown>): QuestChanges {
  const changes: QuestChanges = {};
  if (body.title !== undefined) changes.title = requireString(body.title, 'title', { min: 1, max: 80 });
  if (body.description !== undefined) changes.description = requireString(body.description, 'description', { min: 0, max: 300 });
  if (body.metric !== undefined) changes.metric = requireEnum(body.metric, 'metric', QUEST_METRICS);
  if (body.target !== undefined) changes.target = requireInt(body.target, 'target', { min: 1, max: 1_000_000 });
  if (body.xpReward !== undefined) changes.xpReward = requireInt(body.xpReward, 'xpReward', { min: 1, max: 100_000 });
  if (body.isActive !== undefined) changes.isActive = requireBoolean(body.isActive, 'isActive');
  if (body.sortOrder !== undefined) changes.sortOrder = requireInt(body.sortOrder, 'sortOrder', { min: -1000, max: 1000 });
  return changes;
}

function readQuestKey(value: unknown): string {
  const key = requireString(value, 'key', { min: 2, max: 40 });
  if (!QUEST_KEY_PATTERN.test(key)) {
    throw ApiError.badRequest('key must be lowercase letters, digits and dashes, e.g. gift-1', 'quest_key_invalid');
  }
  return key;
}

async function adminQuestByKey(key: string): Promise<AdminQuestRow> {
  const row = await one<DailyQuestRow>('SELECT * FROM daily_quests WHERE key = $1', [key]);
  if (!row) throw ApiError.notFound('Quest not found', 'quest_not_found');
  return {
    key: row.key,
    title: row.title,
    description: row.description,
    metric: row.metric as QuestMetric,
    target: row.target,
    progress: 0,
    xpReward: row.xp_reward,
    completed: false,
    completedAt: null,
    xpAwarded: 0,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    completedToday: 0,
  };
}

export async function createQuest(body: Record<string, unknown>): Promise<AdminQuestRow> {
  const key = readQuestKey(body?.key);
  const changes = readQuestBody(body ?? {});
  const missing = (['title', 'metric', 'target', 'xpReward'] as const).filter((field) => changes[field] === undefined);
  if (missing.length > 0) throw ApiError.badRequest(`${missing.join(', ')} required`, 'quest_fields_missing');
  if (await one<DailyQuestRow>('SELECT key FROM daily_quests WHERE key = $1', [key])) {
    throw ApiError.conflict(`A quest with key "${key}" already exists`, 'quest_exists');
  }
  const row = await one<DailyQuestRow>(
    `INSERT INTO daily_quests (key, title, description, metric, target, xp_reward, is_active, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      key,
      changes.title,
      changes.description ?? '',
      changes.metric,
      changes.target,
      changes.xpReward,
      changes.isActive ?? true,
      changes.sortOrder ?? 0,
    ],
  );
  if (!row) throw new Error(`quest ${key} was not stored`);
  return adminQuestByKey(key);
}

export async function updateQuest(key: string, body: Record<string, unknown>): Promise<AdminQuestRow> {
  const existing = await one<DailyQuestRow>('SELECT * FROM daily_quests WHERE key = $1', [key]);
  if (!existing) throw ApiError.notFound('Quest not found', 'quest_not_found');
  const changes = readQuestBody(body ?? {});
  await one<DailyQuestRow>(
    `UPDATE daily_quests
        SET title = $2, description = $3, metric = $4, target = $5, xp_reward = $6,
            is_active = $7, sort_order = $8, updated_at = now()
      WHERE key = $1
      RETURNING *`,
    [
      key,
      changes.title ?? existing.title,
      changes.description ?? existing.description,
      changes.metric ?? existing.metric,
      changes.target ?? existing.target,
      changes.xpReward ?? existing.xp_reward,
      changes.isActive ?? existing.is_active,
      changes.sortOrder ?? existing.sort_order,
    ],
  );
  return adminQuestByKey(key);
}

/**
 * Remove a quest. Refused once anybody has progress against it: those rows are the record of XP
 * that was paid, and `ON DELETE CASCADE` would erase the evidence while leaving the experience in
 * place. Retiring it (`isActive: false`) is the reversible option and is offered in the message.
 */
export async function deleteQuest(key: string): Promise<{ ok: true; key: string }> {
  const existing = await one<DailyQuestRow>('SELECT * FROM daily_quests WHERE key = $1', [key]);
  if (!existing) throw ApiError.notFound('Quest not found', 'quest_not_found');
  const used = await one<{ n: string }>('SELECT count(*)::text AS n FROM quest_progress WHERE quest_key = $1', [key]);
  if (Number(used?.n ?? 0) > 0) {
    throw ApiError.conflict(
      `${used!.n} progress row(s) reference this quest, and some of them paid XP. Set isActive=false to retire it instead.`,
      'quest_in_use',
    );
  }
  await one('DELETE FROM daily_quests WHERE key = $1', [key]);
  return { ok: true, key };
}

export async function updateQuestSettings(body: Record<string, unknown>): Promise<QuestSettingsDto> {
  const existing = await readSettings();
  const timezone = body?.resetTimezone !== undefined ? requireString(body.resetTimezone, 'resetTimezone', { min: 1, max: 64 }) : existing.reset_timezone;
  if (timezone !== existing.reset_timezone) {
    // The CHECK on the column only proves it looks like a name. This proves PostgreSQL can actually
    // resolve it, which is what `now() AT TIME ZONE` will do on every quests read.
    const known = await one('SELECT 1 FROM pg_timezone_names WHERE name = $1', [timezone]);
    if (!known) throw ApiError.badRequest(`Unknown timezone "${timezone}"`, 'quest_timezone_unknown');
  }
  const baseXp = body?.checkinBaseXp !== undefined ? requireInt(body.checkinBaseXp, 'checkinBaseXp', { min: 0, max: 10_000 }) : existing.checkin_base_xp;
  const stepXp = body?.checkinStreakStepXp !== undefined ? requireInt(body.checkinStreakStepXp, 'checkinStreakStepXp', { min: 0, max: 10_000 }) : existing.checkin_streak_step_xp;
  const maxDays = body?.checkinMaxStreakDays !== undefined
    ? requireInt(body.checkinMaxStreakDays, 'checkinMaxStreakDays', { min: 1, max: 365 })
    : existing.checkin_max_streak_days;

  const row = await one<QuestSettingsRow>(
    `UPDATE quest_settings
        SET reset_timezone = $1, checkin_base_xp = $2, checkin_streak_step_xp = $3,
            checkin_max_streak_days = $4, updated_at = now()
      WHERE singleton
      RETURNING *`,
    [timezone, baseXp, stepXp, maxDays],
  );
  if (!row) throw new Error('quest_settings row vanished while updating');
  return {
    resetTimezone: row.reset_timezone,
    checkinBaseXp: row.checkin_base_xp,
    checkinStreakStepXp: row.checkin_streak_step_xp,
    checkinMaxStreakDays: row.checkin_max_streak_days,
  };
}
