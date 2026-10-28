// ---------------------------------------------------------------------------
// Users: debounced search + filters + pagination; adjust-balance and
// ban/unban modals. Mutations refresh rows optimistically from the API
// response (the backend returns the post-mutation user).
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDebounce } from '../hooks/useDebounce';
import { Avatar } from '../components/ui/Avatar';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Textarea } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import {
  IconAlert,
  IconBan,
  IconCheck,
  IconCoin,
  IconDiamond,
  IconSearch,
  IconShieldCheck,
  IconTrendUp,
  IconUsers,
} from '../components/ui/Icons';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { ApiError, api, assetUrl } from '../lib/api';
import { formatCompact, formatDiamonds, formatRCoin, parseSignedInt, relativeTime } from '../lib/format';
import type { UserListQuery, UserRow, UserStatus, UserType } from '../types';

const PAGE_LIMIT = 20;

/** users.vip_level is capped at 20 by a CHECK constraint in schema.sql. */
const VIP_LEVELS = Array.from({ length: 21 }, (_, level) => level);

const USER_TYPE_TONES: Record<UserType, BadgeTone> = {
  HOST: 'violet',
  AGENCY_ADMIN: 'fuchsia',
  USER: 'slate',
};

export default function UsersPage() {
  const toast = useToast();
  const [searchParams] = useSearchParams();

  const [search, setSearch] = useState(searchParams.get('q') ?? '');
  const [status, setStatus] = useState<'' | UserStatus>('');
  const [userType, setUserType] = useState<'' | UserType>('');
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounce(search, 350);

  const [rows, setRows] = useState<UserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [balanceTarget, setBalanceTarget] = useState<UserRow | null>(null);
  const [banTarget, setBanTarget] = useState<UserRow | null>(null);
  const [xpTarget, setXpTarget] = useState<UserRow | null>(null);

  const query = useMemo<UserListQuery>(
    () => ({
      search: debouncedSearch.trim() === '' ? undefined : debouncedSearch.trim(),
      status: status === '' ? undefined : status,
      userType: userType === '' ? undefined : userType,
      page,
      limit: PAGE_LIMIT,
    }),
    [debouncedSearch, status, userType, page],
  );

  // Reset to page 1 whenever the filters change.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, status, userType]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listUsers(query);
      setRows(result.users);
      setTotal(result.total);
    } catch (err) {
      setRows([]);
      setTotal(0);
      setError(err instanceof ApiError ? err.message : 'Failed to load users.');
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceRow = (updated: UserRow) => {
    setRows((current) => current.map((row) => (row.id === updated.id ? updated : row)));
  };

  // VIP is the gift spend tier (gifts.min_vip_level), so it is written here and
  // never from the app. One row at a time keeps the select from double-firing.
  const [vipBusy, setVipBusy] = useState<string | null>(null);
  const changeVip = async (user: UserRow, next: number) => {
    setVipBusy(user.id);
    try {
      const result = await api.setVipLevel(user.id, next);
      replaceRow(result.user);
      toast.success(`${result.user.username} is now VIP ${result.user.vipLevel}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'VIP update failed.');
    } finally {
      setVipBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div>
        <h1 className="text-xl font-bold text-ink">Users</h1>
        <p className="mt-0.5 text-sm text-muted">Moderate accounts, wallets and access.</p>
      </div>

      <Card bodyClassName="p-4">
        <div className="flex flex-wrap items-end gap-3">
          <Input
            leadingIcon={<IconSearch className="h-4 w-4" />}
            placeholder="Search phone or username…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-[220px] flex-1"
            aria-label="Search users"
          />
          <Select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => setStatus(e.target.value as '' | UserStatus)}
            className="w-40"
          >
            <option value="">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="BANNED">Banned</option>
          </Select>
          <Select
            aria-label="Filter by user type"
            value={userType}
            onChange={(e) => setUserType(e.target.value as '' | UserType)}
            className="w-44"
          >
            <option value="">All types</option>
            <option value="HOST">Host</option>
            <option value="USER">User</option>
            <option value="AGENCY_ADMIN">Agency admin</option>
          </Select>
        </div>
      </Card>

      <Card bodyClassName="p-0">
        {loading && rows.length === 0 ? (
          <div className="grid h-64 place-items-center text-violet-300">
            <Spinner className="h-8 w-8" />
          </div>
        ) : error !== null ? (
          <EmptyState
            title="Could not load users"
            message={error}
            icon={<IconAlert className="h-6 w-6" />}
            action={<Button onClick={() => void load()}>Retry</Button>}
          />
        ) : rows.length === 0 ? (
          <EmptyState title="No users match" message="Adjust the search or filters above." icon={<IconUsers className="h-6 w-6" />} />
        ) : (
          <div className="p-2">
            <Table>
              <THead>
                <Th>User</Th>
                <Th>Phone</Th>
                <Th>Type</Th>
                <Th>Status</Th>
                <Th>VIP</Th>
                <Th>Earned level</Th>
                <Th align="right">Diamonds</Th>
                <Th align="right">R-coins</Th>
                <Th align="right">Gifts sent / recv</Th>
                <Th>Last seen</Th>
                <Th align="right" className="pr-4">
                  Actions
                </Th>
              </THead>
              <TBody>
                {rows.map((user) => (
                  <Tr key={user.id} className={loading ? 'opacity-50' : ''}>
                    <Td>
                      <div className="flex items-center gap-2.5">
                        <Avatar name={user.username} src={user.avatarUrl} size="sm" />
                        <div className="min-w-0">
                          <p className="flex items-center gap-1 truncate text-sm font-semibold text-ink">
                            {user.username}
                            {user.isVerified && <IconShieldCheck className="h-3.5 w-3.5 text-sky-400" />}
                          </p>
                          <p className="text-[11px] text-faint">joined {relativeTime(user.createdAt)}</p>
                        </div>
                      </div>
                    </Td>
                    <Td className="tabular-nums">{user.phone}</Td>
                    <Td>
                      <Badge tone={USER_TYPE_TONES[user.userType] ?? 'slate'}>{user.userType}</Badge>
                    </Td>
                    <Td>
                      <Badge tone={user.status === 'ACTIVE' ? 'green' : 'red'}>{user.status}</Badge>
                    </Td>
                    <Td>
                      <Select
                        aria-label={`VIP level for ${user.username}`}
                        className="w-[76px]"
                        value={user.vipLevel}
                        disabled={vipBusy === user.id}
                        onChange={(e) => void changeVip(user, Number(e.target.value))}
                      >
                        {VIP_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </Select>
                    </Td>
                    {/* Earned rank, read-only beside the tier an operator sets: a member climbs this
                        one by sending and receiving coins, and only an operator's correction moves it. */}
                    <Td>
                      <span className="flex items-center gap-2">
                        <img
                          src={assetUrl(user.rank.badge)}
                          alt=""
                          loading="lazy"
                          className="h-5 w-5 shrink-0 object-contain"
                          onError={(event) => {
                            event.currentTarget.style.visibility = 'hidden';
                          }}
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-xs font-medium" style={{ color: user.rank.accent }}>
                            {user.rank.name}
                          </span>
                          <span className="block text-[11px] tabular-nums text-faint">
                            {formatCompact(user.xp)} XP
                            {user.nextRank !== null && ` · ${formatCompact(user.nextRank.remainingXp)} to next`}
                          </span>
                        </span>
                      </span>
                    </Td>
                    <Td align="right" className="tabular-nums text-ink">
                      {formatDiamonds(user.diamondBalance)}
                    </Td>
                    <Td align="right" className="tabular-nums text-ink">
                      {formatRCoin(user.rCoinBalance)}
                    </Td>
                    <Td align="right" className="tabular-nums">
                      {formatCompact(user.totalGiftsSent)} / {formatCompact(user.totalGiftsReceived)}
                    </Td>
                    <Td className="whitespace-nowrap">{relativeTime(user.lastSeenAt)}</Td>
                    <Td align="right" className="whitespace-nowrap pr-4">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          size="sm"
                          icon={<IconDiamond className="h-3.5 w-3.5" />}
                          onClick={() => setBalanceTarget(user)}
                        >
                          Balance
                        </Button>
                        <Button
                          size="sm"
                          icon={<IconTrendUp className="h-3.5 w-3.5" />}
                          onClick={() => setXpTarget(user)}
                        >
                          Level
                        </Button>
                        {user.status === 'ACTIVE' ? (
                          <IconButton label={`Ban ${user.username}`} tone="danger" onClick={() => setBanTarget(user)}>
                            <IconBan className="h-4 w-4" />
                          </IconButton>
                        ) : (
                          <IconButton label={`Unban ${user.username}`} onClick={() => setBanTarget(user)}>
                            <IconCheck className="h-4 w-4" />
                          </IconButton>
                        )}
                      </div>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
            <div className="px-3 pb-3">
              <Pagination page={page} limit={PAGE_LIMIT} total={total} onChange={setPage} />
            </div>
          </div>
        )}
      </Card>

      {balanceTarget !== null && (
        <AdjustBalanceModal
          user={balanceTarget}
          onClose={() => setBalanceTarget(null)}
          onUpdated={(updated) => {
            replaceRow(updated);
            setBalanceTarget(null);
            toast.success(`Wallet updated for ${updated.username}.`);
          }}
        />
      )}

      {xpTarget !== null && (
        <AdjustXpModal
          user={xpTarget}
          onClose={() => setXpTarget(null)}
          onUpdated={(updated) => {
            replaceRow(updated);
            setXpTarget(null);
            toast.success(`${updated.username} is now ${updated.rank.name} at ${formatCompact(updated.xp)} XP.`);
          }}
        />
      )}

      {banTarget !== null && (
        <BanModal
          user={banTarget}
          onClose={() => setBanTarget(null)}
          onUpdated={(updated) => {
            replaceRow(updated);
            setBanTarget(null);
            toast.success(
              updated.status === 'BANNED'
                ? `${updated.username} banned.`
                : `${updated.username} unbanned.`,
            );
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Adjust balance modal — validates locally that deltas are integers and can
// never push a balance below zero before calling POST /users/:id/balance.
// ---------------------------------------------------------------------------
interface AdjustBalanceModalProps {
  user: UserRow;
  onClose: () => void;
  onUpdated: (user: UserRow) => void;
}

function AdjustBalanceModal({ user, onClose, onUpdated }: AdjustBalanceModalProps) {
  const [diamondRaw, setDiamondRaw] = useState('');
  const [rCoinRaw, setRCoinRaw] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const diamondDelta = diamondRaw.trim() === '' ? 0 : parseSignedInt(diamondRaw);
  const rCoinDelta = rCoinRaw.trim() === '' ? 0 : parseSignedInt(rCoinRaw);

  const diamondError =
    diamondRaw.trim() !== '' && diamondDelta === null
      ? 'Must be a whole number (e.g. -50 or 120).'
      : diamondDelta !== null && user.diamondBalance + diamondDelta < 0
        ? `Would drive the diamond balance below 0 (currently ${user.diamondBalance}).`
        : null;

  const rCoinError =
    rCoinRaw.trim() !== '' && rCoinDelta === null
      ? 'Must be a whole number (e.g. -50 or 120).'
      : rCoinDelta !== null && user.rCoinBalance + rCoinDelta < 0
        ? `Would drive the R-coin balance below 0 (currently ${user.rCoinBalance}).`
        : null;

  const bothZero = (diamondDelta ?? 0) === 0 && (rCoinDelta ?? 0) === 0;
  const noteTooLong = note.trim().length > 200;
  const formInvalid = diamondError !== null || rCoinError !== null || noteTooLong;
  const canSubmit = !formInvalid && !bothZero && diamondDelta !== null && rCoinDelta !== null && !submitting;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.adjustBalance(user.id, diamondDelta as number, rCoinDelta as number, note.trim());
      onUpdated(result.user);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Balance adjustment failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Adjust wallet"
      subtitle={
        <span className="flex items-center gap-2">
          <Avatar name={user.username} src={user.avatarUrl} size="xs" />
          {user.username} · {user.phone}
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="adjust-balance-form"
            loading={submitting}
            disabled={!canSubmit}
          >
            Apply
          </Button>
        </>
      }
    >
      <form id="adjust-balance-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-edge/60 bg-elevated/40 p-3 text-sm">
          <div>
            <p className="flex items-center gap-1.5 text-xs text-faint">
              <IconDiamond className="h-4 w-4 text-violet-300" /> Current diamonds
            </p>
            <p className="mt-1 font-bold tabular-nums text-ink">{formatCompact(user.diamondBalance)}</p>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-xs text-faint">
              <IconCoin className="h-4 w-4 text-fuchsia-300" /> Current R-coins
            </p>
            <p className="mt-1 font-bold tabular-nums text-ink">{formatCompact(user.rCoinBalance)}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Input
            label="Diamond delta"
            inputMode="numeric"
            placeholder="+1000 or -250"
            value={diamondRaw}
            onChange={(e) => setDiamondRaw(e.target.value)}
            error={diamondError}
          />
          <Input
            label="R-coin delta"
            inputMode="numeric"
            placeholder="+500 or -100"
            value={rCoinRaw}
            onChange={(e) => setRCoinRaw(e.target.value)}
            error={rCoinError}
          />
        </div>

        <Textarea
          label="Note (audit trail)"
          rows={3}
          maxLength={200}
          placeholder="e.g. Goodwill credit for support ticket #412"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          error={noteTooLong ? 'Note is limited to 200 characters.' : null}
        />

        <p className={`text-xs ${bothZero ? 'text-amber-300' : 'text-faint'}`}>
          {bothZero
            ? 'Enter a non-zero delta to create a ledger entry.'
            : `Result: ${formatCompact(user.diamondBalance + (diamondDelta ?? 0))} diamonds · ${formatCompact(
                user.rCoinBalance + (rCoinDelta ?? 0),
              )} R-coins (recorded as ADMIN_ADJUSTMENT).`}
        </p>

        {serverError !== null && (
          <div className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            <IconAlert className="h-4 w-4 shrink-0" />
            {serverError}
          </div>
        )}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Experience correction. The write is a delta rather than an absolute, so a
// correction cannot erase the XP a member earned from gifts while this dialog was
// open, and the server refuses anything that would take the total below zero.
// ---------------------------------------------------------------------------
interface AdjustXpModalProps {
  user: UserRow;
  onClose: () => void;
  onUpdated: (user: UserRow) => void;
}

function AdjustXpModal({ user, onClose, onUpdated }: AdjustXpModalProps) {
  const [deltaRaw, setDeltaRaw] = useState('');
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const delta = parseSignedInt(deltaRaw);
  const result = delta === null ? null : user.xp + delta;
  const deltaError =
    deltaRaw.trim() === ''
      ? 'Enter an amount, positive or negative.'
      : delta === null
        ? 'Must be a whole number (e.g. 5000 or -1200).'
        : result !== null && result < 0
          ? `Would take ${user.username} below 0 XP (currently ${formatCompact(user.xp)}).`
          : null;
  const canSubmit = deltaError === null && delta !== 0 && !submitting;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit || delta === null) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const updated = await api.addXp(user.id, delta, reason.trim());
      onUpdated(updated.user);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Experience adjustment failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Adjust experience"
      subtitle={
        <span className="flex items-center gap-2">
          <Avatar name={user.username} src={user.avatarUrl} size="xs" />
          {user.username} · {user.phone}
        </span>
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            type="submit"
            form="adjust-xp-form"
            loading={submitting}
            disabled={!canSubmit}
          >
            Apply
          </Button>
        </>
      }
    >
      <form id="adjust-xp-form" onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-2 gap-3 rounded-lg border border-edge/60 bg-elevated/40 p-3 text-sm">
          <div>
            <p className="text-xs text-faint">Current level</p>
            <p className="mt-1 flex items-center gap-1.5 font-semibold text-ink">
              <img src={assetUrl(user.rank.badge)} alt="" className="h-5 w-5 object-contain" />
              <span style={{ color: user.rank.accent }}>{user.rank.name}</span>
            </p>
            <p className="mt-0.5 text-[11px] tabular-nums text-faint">{formatCompact(user.xp)} XP</p>
          </div>
          <div>
            <p className="text-xs text-faint">Next rung</p>
            <p className="mt-1 font-semibold text-ink">
              {user.nextRank === null ? 'top of the ladder' : user.nextRank.name}
            </p>
            <p className="mt-0.5 text-[11px] tabular-nums text-faint">
              {user.nextRank === null
                ? 'nothing above level 20'
                : `${formatCompact(user.nextRank.remainingXp)} XP away`}
            </p>
          </div>
        </div>

        <Input
          label="Experience delta"
          inputMode="numeric"
          placeholder="+5000 or -1200"
          value={deltaRaw}
          onChange={(e) => setDeltaRaw(e.target.value)}
          error={deltaRaw.trim() === '' ? null : deltaError}
          hint="Only an operator can move experience; a member's own app cannot write it."
        />

        <Textarea
          label="Reason (goes in the audit log)"
          placeholder="Refunded after a support ticket about a failed gift"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={200}
          error={reason.trim().length > 200 ? 'Limited to 200 characters.' : null}
        />

        {serverError !== null && (
          <div className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            <IconAlert className="h-4 w-4 shrink-0" />
            {serverError}
          </div>
        )}
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Ban / unban confirmation modal.
// ---------------------------------------------------------------------------
interface BanModalProps {
  user: UserRow;
  onClose: () => void;
  onUpdated: (user: UserRow) => void;
}

function BanModal({ user, onClose, onUpdated }: BanModalProps) {
  const banning = user.status === 'ACTIVE';
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const canSubmit = (!banning || reason.trim().length > 0) && !submitting;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await api.setBan(user.id, banning, banning ? reason.trim() : undefined);
      onUpdated(result.user);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Ban update failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={banning ? `Ban ${user.username}?` : `Unban ${user.username}?`}
      subtitle={`${user.phone} · ${user.userType}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={banning ? 'danger' : 'success'}
            onClick={() => void submit()}
            loading={submitting}
            disabled={!canSubmit}
          >
            {banning ? 'Ban user' : 'Unban user'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {banning
            ? 'Banned users cannot sign in, join rooms, send gifts or withdraw. Their balances are preserved.'
            : 'The user will immediately be able to sign in and use all platform features again.'}
        </p>
        {banning && (
          <Textarea
            label="Reason (stored in the audit trail)"
            rows={3}
            maxLength={200}
            placeholder="e.g. Chargeback fraud confirmed"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        )}
        {serverError !== null && (
          <div className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            <IconAlert className="h-4 w-4 shrink-0" />
            {serverError}
          </div>
        )}
      </div>
    </Modal>
  );
}
