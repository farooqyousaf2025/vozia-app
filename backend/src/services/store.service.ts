import { PoolClient } from 'pg';
import { many, one, withTransaction } from '../config/db';
import { rateLimit } from '../config/redis';
import { ProfileFrameRow, RoomThemeRow, UserItemRow, UserRow, VisualEffectRow } from '../types/db';
import { ApiError, requireEnum, requireInt, requireString } from '../utils/http';
import { toTransaction, toUser, TransactionDto, UserDto } from '../utils/serialize';
import { postedTransaction, postLedgerMoves } from './ledger.service';
import { awardXp, ensureRankRegistry, xpForSpend } from './rank.service';

/**
 * The cosmetic store (migration 0019): who owns what, and the money that says so.
 *
 * The art itself is `theme.service`'s business — it already keeps the decoration catalogue and the
 * synchronous snapshot every seat DTO reads. This file is the commerce half, and it is deliberately
 * small: three catalogues, one ownership table, and one rule about how a balance may move.
 *
 *   * A price is read from the database inside the purchase transaction. No caller passes one and no
 *     request body can carry one, so an operator re-pricing a ring between two clicks gets the price
 *     that was true when that click's transaction ran. This is the whole of why a modified Android
 *     client cannot buy a 20,000-diamond ring for 1.
 *   * Diamonds leave one wallet and arrive nowhere. `postLedgerMoves` does the moving, because it is
 *     the only primitive allowed to, and it already owns the locking order, the banned-account
 *     check and the refuse-before-write balance guard.
 *   * Owning is a row, wearing is a column. `user_items` is the history; the `users.*_key` columns
 *     say what a seat grid draws right now. Both are written in the same transaction, so a ring
 *     cannot be worn and unpaid for, nor owned and expired while still showing.
 *
 * A theme is the exception, and the reason is that a theme decorates a room rather than a person:
 * its ownership is checked where a room is styled (`assertMayWearTheme`) and never copied onto the
 * account.
 */

export const ITEM_KINDS = ['FRAME', 'THEME', 'EFFECT'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** A purchase is a deliberate act, so this is an abuse brake, not a product limit. */
const PURCHASES_PER_MINUTE = 20;

export type StoreItemDto = {
  kind: ItemKind;
  key: string;
  name: string;
  /** The exact URL a phone draws: a ring PNG, a wallpaper PNG or a Lottie scene. */
  art: string;
  accent: string | null;
  priceDiamonds: number;
  /** Rental length in days; null means the purchase never expires. */
  periodDays: number | null;
  owned: boolean;
  /** When the caller's copy runs out, or null when it cannot. */
  expiresAt: string | null;
  /** Only meaningful for FRAME and EFFECT — a theme is worn by a room, not by an account. */
  equipped: boolean;
};

export type OwnedItemDto = {
  kind: ItemKind;
  key: string;
  name: string;
  art: string;
  /** false once an operator stops selling it; the member still holds it. */
  onSale: boolean;
  expiresAt: string | null;
  acquiredVia: 'PURCHASE' | 'ADMIN_GRANT';
};

export type PurchaseResult = {
  item: StoreItemDto;
  transaction: TransactionDto;
  wallet: UserDto;
};

// ---------------------------------------------------------------------------
// Catalogue reads
// ---------------------------------------------------------------------------

/** One row of any of the three catalogues, in the shape the rest of this file works with. */
type CatalogueRow = {
  kind: ItemKind;
  key: string;
  name: string;
  art: string;
  accent: string | null;
  priceDiamonds: number;
  periodDays: number | null;
  forSale: boolean;
  sortOrder: number;
};

/**
 * Every row in all three catalogues, on sale or not.
 *
 * A member's receipt can outlive the thing they bought — an operator retires a ring, the ten people
 * wearing it do not stop existing — so the code that names an owned item has to be able to find a
 * row the shop no longer lists.
 */
async function allRows(): Promise<CatalogueRow[]> {
  const [frames, themes, effects] = await Promise.all([
    many<ProfileFrameRow>('SELECT * FROM profile_frames ORDER BY sort_order ASC, key ASC'),
    many<RoomThemeRow>('SELECT * FROM room_themes ORDER BY sort_order ASC, slug ASC'),
    many<VisualEffectRow>("SELECT * FROM visual_effects WHERE kind = 'WELCOME' ORDER BY sort_order ASC, key ASC"),
  ]);
  return [
    ...frames.map((row) => ({
      kind: 'FRAME' as const,
      key: row.key,
      name: row.name,
      art: row.art_url,
      accent: row.accent.trim(),
      priceDiamonds: row.price_diamonds,
      periodDays: row.period_days,
      forSale: row.for_sale,
      sortOrder: row.sort_order,
    })),
    ...themes.map((row) => ({
      kind: 'THEME' as const,
      key: row.slug,
      name: row.name,
      art: row.wallpaper_url,
      accent: row.accent.trim(),
      priceDiamonds: row.price_diamonds,
      periodDays: row.period_days,
      forSale: row.for_sale,
      sortOrder: row.sort_order,
    })),
    ...effects.map((row) => ({
      kind: 'EFFECT' as const,
      key: row.key,
      name: row.name,
      art: row.url,
      // A Lottie scene carries its own colours, so an entry flourish has no accent to fall back on.
      accent: null,
      priceDiamonds: row.price_diamonds,
      periodDays: row.period_days,
      forSale: row.for_sale,
      sortOrder: row.sort_order,
    })),
  ].sort((a, b) => a.sortOrder - b.sortOrder);
}

/** The same rows read inside a purchase, where a second query per item is the point: it is the
 * price at this instant, not the one a screen rendered a minute ago. */
async function catalogueRow(client: PoolClient, kind: ItemKind, key: string): Promise<CatalogueRow | null> {
  if (kind === 'FRAME') {
    const row = (await client.query<ProfileFrameRow>('SELECT * FROM profile_frames WHERE key = $1', [key])).rows[0];
    return row && {
      kind,
      key: row.key,
      name: row.name,
      art: row.art_url,
      accent: row.accent.trim(),
      priceDiamonds: row.price_diamonds,
      periodDays: row.period_days,
      forSale: row.for_sale,
      sortOrder: row.sort_order,
    };
  }
  if (kind === 'THEME') {
    const row = (await client.query<RoomThemeRow>('SELECT * FROM room_themes WHERE slug = $1', [key])).rows[0];
    return row && {
      kind,
      key: row.slug,
      name: row.name,
      art: row.wallpaper_url,
      accent: row.accent.trim(),
      priceDiamonds: row.price_diamonds,
      periodDays: row.period_days,
      forSale: row.for_sale,
      sortOrder: row.sort_order,
    };
  }
  const row = (
    await client.query<VisualEffectRow>("SELECT * FROM visual_effects WHERE key = $1 AND kind = 'WELCOME'", [key])
  ).rows[0];
  return row && {
    kind,
    key: row.key,
    name: row.name,
    art: row.url,
    accent: null,
    priceDiamonds: row.price_diamonds,
    periodDays: row.period_days,
    forSale: row.for_sale,
    sortOrder: row.sort_order,
  };
}

function stamp(kind: ItemKind, key: string): string {
  return `${kind}:${key}`;
}

/** What a member is wearing, so the shop can mark the one row they have equipped. */
async function wornBy(userId: string): Promise<Map<string, boolean>> {
  const row = await one<Pick<UserRow, 'profile_frame_key' | 'welcome_effect_key'>>(
    'SELECT profile_frame_key, welcome_effect_key FROM users WHERE id = $1',
    [userId],
  );
  const worn = new Map<string, boolean>();
  if (row?.profile_frame_key) worn.set(stamp('FRAME', row.profile_frame_key), true);
  if (row?.welcome_effect_key) worn.set(stamp('EFFECT', row.welcome_effect_key), true);
  return worn;
}

function liveCopy(item: UserItemRow | undefined): boolean {
  return Boolean(item && (!item.expires_at || item.expires_at.getTime() > Date.now()));
}

function toItem(row: CatalogueRow, held: UserItemRow | undefined, worn: Map<string, boolean>): StoreItemDto {
  const live = liveCopy(held);
  return {
    kind: row.kind,
    key: row.key,
    name: row.name,
    art: row.art,
    accent: row.accent,
    priceDiamonds: row.priceDiamonds,
    periodDays: row.periodDays,
    owned: live,
    expiresAt: live ? held!.expires_at?.toISOString() ?? null : null,
    equipped: live && worn.get(stamp(row.kind, row.key)) === true,
  };
}

/** The shop as a member sees it: what is on sale, what they hold, and what is on them right now. */
export async function storeFor(userId: string): Promise<{ items: StoreItemDto[]; owned: OwnedItemDto[] }> {
  const [rows, held, worn] = await Promise.all([allRows(), ownedRows(userId), wornBy(userId)]);
  const byKey = new Map(rows.map((row) => [stamp(row.kind, row.key), row]));
  const heldByKey = new Map(held.map((item) => [stamp(item.kind, item.item_key), item]));

  // Only `for_sale` rows appear as things to buy. A free theme or the original welcome flourish is
  // already published by `GET /api/rooms/themes`, and listing it here as "price 0, buy" would
  // advertise a purchase that does not exist.
  const items = rows.filter((row) => row.forSale).map((row) => toItem(row, heldByKey.get(stamp(row.kind, row.key)), worn));

  // Owned rows for delisted items still belong on the account: they were paid for, and a retired
  // theme is still worn by the rooms that carry it.
  const owned = held
    .filter((item) => liveCopy(item))
    .map((item) => {
      const row = byKey.get(stamp(item.kind, item.item_key));
      return {
        kind: item.kind,
        key: item.item_key,
        name: row?.name ?? item.item_key,
        art: row?.art ?? '',
        onSale: row?.forSale ?? false,
        expiresAt: item.expires_at?.toISOString() ?? null,
        acquiredVia: item.acquired_via,
      };
    });

  return { items, owned };
}

async function ownedRows(userId: string): Promise<UserItemRow[]> {
  return many<UserItemRow>('SELECT * FROM user_items WHERE user_id = $1 ORDER BY created_at DESC', [userId]);
}

/** One item as the member who asked about it sees it — the response to a purchase. */
async function describe(userId: string, kind: ItemKind, key: string): Promise<StoreItemDto> {
  const row = (await allRows()).find((candidate) => candidate.kind === kind && candidate.key === key);
  if (!row) throw ApiError.notFound('That item is not in any catalogue', 'item_not_found');
  const [held, worn] = await Promise.all([
    one<UserItemRow>('SELECT * FROM user_items WHERE user_id = $1 AND kind = $2 AND item_key = $3', [userId, kind, key]),
    wornBy(userId),
  ]);
  return toItem(row, held ?? undefined, worn);
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * Record that a member holds an item, or extend the time they already hold it.
 *
 * One row per (member, item) is what makes "own it twice" impossible to represent, so a repeat
 * purchase has to add to the clock instead. `GREATEST(expires_at, now())` is the whole of the
 * fairness in that: renewing a ring with 20 days left grants 30 more, and renewing one that lapsed
 * six weeks ago starts from today rather than quietly rewarding the lapse.
 */
async function upsertOwnership(
  client: PoolClient,
  input: {
    userId: string;
    kind: ItemKind;
    key: string;
    periodDays: number | null;
    acquiredVia: 'PURCHASE' | 'ADMIN_GRANT';
    transactionId: string | null;
  },
): Promise<{ id: string; expiresAt: Date | null }> {
  // `client`, never the pool: this row names the transaction that paid for it, and that row is
  // still uncommitted. Reading it over a second connection would block on the foreign key until
  // the transaction it is part of could commit — a self-deadlock that looks like a slow request.
  const result = await client.query<{ id: string; expires_at: Date | null }>(
    `INSERT INTO user_items (user_id, kind, item_key, acquired_via, transaction_id, expires_at)
     VALUES ($1,$2,$3,$4,$5, CASE WHEN $6::int IS NULL THEN NULL ELSE now() + make_interval(days => $6::int) END)
     ON CONFLICT (user_id, kind, item_key) DO UPDATE
        SET acquired_via   = EXCLUDED.acquired_via,
            transaction_id = COALESCE(EXCLUDED.transaction_id, user_items.transaction_id),
            expires_at     = CASE
                               WHEN EXCLUDED.expires_at IS NULL THEN NULL
                               ELSE GREATEST(COALESCE(user_items.expires_at, now()), now())
                                    + make_interval(days => $6::int)
                             END
     RETURNING id, expires_at`,
    [input.userId, input.kind, input.key, input.acquiredVia, input.transactionId, input.periodDays],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`user_items row for ${input.userId}/${input.kind}:${input.key} vanished`);
  return { id: row.id, expiresAt: row.expires_at };
}

/**
 * Keep the wearing columns honest.
 *
 * A renewal of an item the member is wearing right now has to move the expiry copied onto `users`
 * with it, or their new 30 days would still switch the ring off on the old date.
 */
async function refreshWorn(
  client: PoolClient,
  userId: string,
  kind: ItemKind,
  key: string,
  expiresAt: Date | null,
): Promise<void> {
  if (kind === 'FRAME') {
    await client.query(
      'UPDATE users SET profile_frame_expires_at = $3 WHERE id = $1 AND profile_frame_key = $2',
      [userId, key, expiresAt],
    );
  } else if (kind === 'EFFECT') {
    await client.query(
      'UPDATE users SET welcome_effect_expires_at = $3 WHERE id = $1 AND welcome_effect_key = $2',
      [userId, key, expiresAt],
    );
  }
}

/** Does this member hold a live copy of this item? */
export async function owns(userId: string, kind: ItemKind, key: string): Promise<boolean> {
  const row = await one<{ id: string }>(
    `SELECT id FROM user_items
      WHERE user_id = $1 AND kind = $2 AND item_key = $3
        AND (expires_at IS NULL OR expires_at > now())`,
    [userId, kind, key],
  );
  return row !== null;
}

/**
 * A host may put a free theme on a room immediately; one the shop sells has to be theirs first.
 *
 * This is the only enforcement point, which is why both room creation and `POST /rooms/:id/theme`
 * go through it. An unknown slug is left alone: `theme.service` has already refused it, and a theme
 * deleted after a room was wearing it falls back to the default look rather than blocking the room.
 */
export async function assertMayWearTheme(userId: string, slug: string): Promise<void> {
  const row = await one<RoomThemeRow>('SELECT * FROM room_themes WHERE slug = $1', [slug]);
  if (!row || !row.for_sale) return;
  if (await owns(userId, 'THEME', slug)) return;
  throw ApiError.forbidden(
    `${row.name} costs ${row.price_diamonds} diamonds — buy it from the store before a room wears it`,
    'theme_not_owned',
    { slug, priceDiamonds: row.price_diamonds },
  );
}

// ---------------------------------------------------------------------------
// Buying
// ---------------------------------------------------------------------------

export function readKind(value: unknown): ItemKind {
  return requireEnum(value, 'kind', ITEM_KINDS);
}

export function readItemKey(value: unknown): string {
  return requireString(value, 'key', { min: 2, max: 39 });
}

/**
 * Take diamonds out of one wallet and write the ownership row that says why.
 *
 * `postLedgerMoves` locks the account, so two taps of the buy button serialise into "one purchase,
 * then a refusal" instead of two debits from a balance that could only pay for one. Nothing here
 * re-implements that: a second hand-rolled balance check would be a second set of rules about
 * locking and negative balances, which is how a store ends up selling what it cannot.
 */
export async function purchaseItem(input: { userId: string; kind: ItemKind; key: string }): Promise<PurchaseResult> {
  // The wallet DTO resolves a rank, and a rank needs the ladder — see `ensureRankRegistry`.
  await ensureRankRegistry();

  const remaining = await rateLimit(`store:${input.userId}`, PURCHASES_PER_MINUTE, 60);
  if (remaining === -1) throw ApiError.tooManyRequests('Too many store purchases in one minute');

  const result = await withTransaction(async (client) => {
    const item = await catalogueRow(client, input.kind, input.key);
    if (!item) {
      throw ApiError.notFound(
        input.kind === 'EFFECT' ? 'That entry effect does not exist' : 'That item does not exist',
        'item_not_found',
      );
    }
    if (!item.forSale) {
      throw ApiError.badRequest(
        `${item.name} is not for sale — it is free, and there is nothing to buy`,
        'item_not_for_sale',
      );
    }

    const [move] = await postLedgerMoves(client, [
      {
        type: 'ITEM_PURCHASE',
        direction: 'debit',
        userId: input.userId,
        diamonds: item.priceDiamonds,
        note: `Store: ${item.name}`,
        meta: { kind: item.kind, key: item.key, name: item.name },
        insufficientMessage: `Not enough diamonds for ${item.name}`,
      },
    ]);

    // Spending on a cosmetic is spending: the same rate a gift pays out, from the same function, so
    // the ladder cannot be gamed by choosing the cheaper-looking sink.
    await awardXp(client, input.userId, xpForSpend(item.priceDiamonds));

    const held = await upsertOwnership(client, {
      userId: input.userId,
      kind: item.kind,
      key: item.key,
      periodDays: item.periodDays,
      acquiredVia: 'PURCHASE',
      transactionId: move.transactionId,
    });
    await refreshWorn(client, input.userId, item.kind, item.key, held.expiresAt);

    const fresh = await client.query<UserRow>('SELECT * FROM users WHERE id = $1', [input.userId]);
    return { transactionId: move.transactionId, item, user: fresh.rows[0] };
  });

  const posted = await postedTransaction(result.transactionId);
  return {
    item: await describe(input.userId, result.item.kind, result.item.key),
    transaction: toTransaction(posted!),
    wallet: toUser(result.user),
  };
}

// ---------------------------------------------------------------------------
// Wearing
// ---------------------------------------------------------------------------

/**
 * Put an owned item on the account.
 *
 * The ownership row is re-read here rather than trusted from the phone's shop screen: a copy can
 * have expired, been reversed by an operator, or never have existed while the list was on screen.
 */
export async function equipItem(input: { userId: string; kind: ItemKind; key: string }): Promise<UserDto> {
  await ensureRankRegistry();
  if (input.kind === 'THEME') {
    throw ApiError.badRequest(
      'A room theme decorates a room, not an account — set it with POST /api/rooms/<id>/theme',
      'theme_is_per_room',
    );
  }

  const held = await one<UserItemRow>(
    'SELECT * FROM user_items WHERE user_id = $1 AND kind = $2 AND item_key = $3',
    [input.userId, input.kind, input.key],
  );
  if (!held) throw ApiError.forbidden('You do not own this item', 'item_not_owned');
  if (held.expires_at && held.expires_at.getTime() <= Date.now()) {
    throw ApiError.forbidden('This item has expired — renew it from the store', 'item_expired', {
      expiredAt: held.expires_at.toISOString(),
    });
  }
  // A receipt outlives a retired catalogue row, but there is no art left to draw, so say so here
  // rather than equipping a key `wornFrame()` will resolve to nothing.
  if (!(await catalogueRowExists(input.kind, input.key))) {
    throw ApiError.notFound('The operator has removed this item from the catalogue', 'item_retired');
  }

  const columns =
    input.kind === 'FRAME'
      ? { key: 'profile_frame_key', expiry: 'profile_frame_expires_at' }
      : { key: 'welcome_effect_key', expiry: 'welcome_effect_expires_at' };
  const updated = await one<UserRow>(
    `UPDATE users SET ${columns.key} = $2, ${columns.expiry} = $3 WHERE id = $1 RETURNING *`,
    [input.userId, input.key, held.expires_at],
  );
  return toUser(updated!);
}

/** Take it off. Always allowed, owned or not: refusing would strand a member on a ring. */
export async function unequipItem(input: { userId: string; kind: ItemKind }): Promise<UserDto> {
  await ensureRankRegistry();
  if (input.kind === 'THEME') {
    throw ApiError.badRequest('A room wears a theme — set the room back to a free one instead', 'theme_is_per_room');
  }
  const columns =
    input.kind === 'FRAME'
      ? { key: 'profile_frame_key', expiry: 'profile_frame_expires_at' }
      : { key: 'welcome_effect_key', expiry: 'welcome_effect_expires_at' };
  const updated = await one<UserRow>(
    `UPDATE users SET ${columns.key} = NULL, ${columns.expiry} = NULL WHERE id = $1 RETURNING *`,
    [input.userId],
  );
  return toUser(updated!);
}

async function catalogueRowExists(kind: ItemKind, key: string): Promise<boolean> {
  if (kind === 'FRAME') return Boolean(await one<ProfileFrameRow>('SELECT key FROM profile_frames WHERE key = $1', [key]));
  if (kind === 'THEME') return Boolean(await one<RoomThemeRow>('SELECT slug FROM room_themes WHERE slug = $1', [key]));
  return Boolean(
    await one<VisualEffectRow>("SELECT key FROM visual_effects WHERE key = $1 AND kind = 'WELCOME'", [key]),
  );
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

/**
 * Give an item to a member without money moving.
 *
 * This exists for the two situations a ledger forces on you: a purchase that had to be reversed (the
 * member keeps wearing what they already bought, support hands it back as a grant so the receipt says
 * where it came from), and an event where a host is given a ring. It is recorded as `ADMIN_GRANT`
 * with no transaction id, never as a purchase with a zero price.
 */
export async function grantItem(input: {
  userId: string;
  kind: ItemKind;
  key: string;
  /** Overrides the catalogue period; omitted keeps the catalogue's, including "permanent". */
  days?: number | null;
}): Promise<StoreItemDto> {
  const rows = await allRows();
  const item = rows.find((row) => row.kind === input.kind && row.key === input.key);
  if (!item) throw ApiError.notFound('That item is not in any catalogue', 'item_not_found');
  const periodDays = input.days === undefined ? item.periodDays : input.days;
  if (periodDays !== null) requireInt(periodDays, 'days', { min: 1, max: 3650 });

  await withTransaction(async (client) => {
    const buyer = await client.query<UserRow>('SELECT id FROM users WHERE id = $1 FOR UPDATE', [input.userId]);
    if (!buyer.rows[0]) throw ApiError.notFound('Account not found');
    const held = await upsertOwnership(client, {
      userId: input.userId,
      kind: input.kind,
      key: input.key,
      periodDays,
      acquiredVia: 'ADMIN_GRANT',
      transactionId: null,
    });
    await refreshWorn(client, input.userId, input.kind, input.key, held.expiresAt);
  });

  return describe(input.userId, input.kind, input.key);
}

/** Who holds what — the operator's side of the same rows, including the members who cannot buy. */
export async function holdersOf(
  kind: ItemKind,
  key: string,
): Promise<Array<{ userId: string; username: string; acquiredVia: string; expiresAt: string | null; createdAt: string }>> {
  const rows = await many<UserItemRow & { username: string }>(
    `SELECT ui.*, u.username FROM user_items ui JOIN users u ON u.id = ui.user_id
      WHERE ui.kind = $1 AND ui.item_key = $2
      ORDER BY ui.created_at DESC
      LIMIT 200`,
    [kind, key],
  );
  return rows.map((row) => ({
    userId: row.user_id,
    username: row.username,
    acquiredVia: row.acquired_via,
    expiresAt: row.expires_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  }));
}
