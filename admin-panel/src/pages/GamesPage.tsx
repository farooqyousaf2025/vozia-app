// ---------------------------------------------------------------------------
// Games console (§7, §8): the versioned rules an operator owns, the matches that
// were played under them, the replay behind each one, and the dispute queue.
//
// The money switches are deliberately awkward to reach. Turning on paid entry or
// redeemable prizes is the step that takes a casual game into regulated territory,
// so the backend refuses the patch without an explicit `confirmCompliance`, and
// this page shows that refusal rather than papering over it.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Avatar } from '../components/ui/Avatar';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Card, StatCard } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input, Textarea } from '../components/ui/Input';
import { IconAlert, IconCheck, IconEdit, IconGame, IconPlus, IconRefresh, IconTrash } from '../components/ui/Icons';
import { JsonBlock } from '../components/ui/JsonBlock';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { Switch } from '../components/ui/Switch';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { Tabs } from '../components/ui/Tabs';
import { useAuth } from '../context/AuthContext';
import { ApiError, api } from '../lib/api';
import { formatDateTime, formatDiamonds, relativeTime } from '../lib/format';
import type {
  GameDefinition,
  GameDispute,
  GameEvent,
  GameRefundPolicy,
  GameRulePatch,
  GameSession,
  GameSessionStatus,
} from '../types';

const SESSION_TONES: Record<string, BadgeTone> = {
  WAITING: 'slate',
  READY: 'sky',
  IN_PROGRESS: 'violet',
  COMPLETED: 'green',
  CANCELLED: 'amber',
  DISPUTED: 'red',
};

const REFUND_POLICIES: GameRefundPolicy[] = ['NONE', 'CANCELLED', 'DISPUTED', 'ALWAYS'];

export default function GamesPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState('rules');
  const [definitions, setDefinitions] = useState<GameDefinition[]>([]);
  const [sessions, setSessions] = useState<GameSession[]>([]);
  const [disputes, setDisputes] = useState<GameDispute[]>([]);
  const [sessionFilter, setSessionFilter] = useState<{ gameKey: string; status: string }>({ gameKey: '', status: '' });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rulesTarget, setRulesTarget] = useState<GameDefinition | null>(null);
  const [sessionTarget, setSessionTarget] = useState<GameSession | null>(null);
  const [disputeTarget, setDisputeTarget] = useState<GameDispute | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [games, disputeList] = await Promise.all([
        api.adminGames({
          gameKey: sessionFilter.gameKey === '' ? undefined : sessionFilter.gameKey,
          status: sessionFilter.status === '' ? undefined : sessionFilter.status,
          limit: 100,
        }),
        // The dispute queue is a separate permission, so a read-only operator never requests it.
        can('game:dispute') ? api.listDisputes({ limit: 100 }) : Promise.resolve({ disputes: [] as GameDispute[] }),
      ]);
      setDefinitions(games.games);
      setSessions(games.sessions);
      setDisputes(disputeList.disputes);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the games console.');
    } finally {
      setLoading(false);
    }
  }, [sessionFilter, can]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDisputes = disputes.filter((d) => d.status === 'OPEN').length;
  const liveSessions = sessions.filter((s) => s.status === 'IN_PROGRESS' || s.status === 'WAITING' || s.status === 'READY');

  const rulesFor = (key: string): GameDefinition | undefined => definitions.find((game) => game.key === key);

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            <IconGame className="h-5 w-5 text-violet-300" />
            Games
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            Rules are versioned per match, fees are collected by the server, and prizes settle once.
          </p>
        </div>
        <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
          Refresh
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Games defined" value={definitions.length} sub={`${definitions.filter((g) => g.isActive).length} switched on`} />
        <StatCard label="Live matches" value={liveSessions.length} sub="waiting, ready or in progress" tone="sky" />
        <StatCard
          label="Paid games"
          value={definitions.filter((g) => g.entryFeeEnabled && g.entryFeeDiamonds > 0).length}
          sub="entry fee above zero"
          tone="fuchsia"
        />
        <StatCard label="Open disputes" value={openDisputes} sub={openDisputes > 0 ? 'awaiting an operator ruling' : 'queue is clear'} tone={openDisputes > 0 ? 'amber' : 'emerald'} />
      </div>

      <Tabs
        active={tab}
        onChange={setTab}
        items={[
          { id: 'rules', label: 'Rules' },
          { id: 'matches', label: 'Matches', count: sessions.length },
          { id: 'disputes', label: 'Disputes', count: disputes.length, alert: openDisputes > 0 },
        ]}
      />

      {loading && definitions.length === 0 ? (
        <Card>
          <div className="grid h-48 place-items-center text-violet-300">
            <Spinner className="h-8 w-8" />
          </div>
        </Card>
      ) : error !== null ? (
        <Card>
          <EmptyState
            title="Could not load games"
            message={error}
            icon={<IconAlert className="h-6 w-6" />}
            action={<Button onClick={() => void load()}>Retry</Button>}
          />
        </Card>
      ) : tab === 'rules' ? (
        <Card bodyClassName="p-0" title="Rule sets" subtitle="Every save raises rules_version and is written to the audit log.">
          <Table>
            <THead>
              <Th>Game</Th>
              <Th align="center">Seats</Th>
              <Th align="right">Entry fee</Th>
              <Th align="right">Fee band</Th>
              <Th align="right">Prize</Th>
              <Th align="right">Turn clock</Th>
              <Th align="right">Daily limit</Th>
              <Th align="center">Version</Th>
              <Th align="center">Live</Th>
              {can('game:manage') && (
                <Th align="right" className="pr-4">
                  Rules
                </Th>
              )}
            </THead>
            <TBody>
              {definitions.map((game) => (
                <Tr key={game.key}>
                  <Td>
                    <p className="text-sm font-semibold text-ink">{game.name}</p>
                    <p className="text-[11px] uppercase tracking-wider text-faint">{game.key}</p>
                  </Td>
                  <Td align="center" className="tabular-nums text-muted">
                    {game.minPlayers}–{game.maxPlayers}
                  </Td>
                  <Td align="right" className="tabular-nums">
                    {game.entryFeeEnabled ? (
                      <span className={game.entryFeeDiamonds > 0 ? 'font-semibold text-fuchsia-300' : 'text-muted'}>
                        {formatDiamonds(game.entryFeeDiamonds)}
                      </span>
                    ) : (
                      <Badge tone="slate">free</Badge>
                    )}
                  </Td>
                  <Td align="right" className="tabular-nums text-xs text-muted">
                    {game.entryFeeMin}–{game.entryFeeMax}
                  </Td>
                  <Td align="right" className="text-xs">
                    {game.prizeEnabled ? (
                      <span className="text-emerald-300">
                        {(game.commissionBps / 100).toFixed(2)}% cut · {game.prizeRules.length} ranks
                      </span>
                    ) : (
                      <span className="text-faint">no prizes</span>
                    )}
                  </Td>
                  <Td align="right" className="tabular-nums text-xs text-muted">{game.turnTimeoutSeconds}s</Td>
                  <Td align="right" className="tabular-nums text-xs text-muted">
                    {game.dailyEntryLimit === 0 ? 'unlimited' : game.dailyEntryLimit}
                  </Td>
                  <Td align="center" className="tabular-nums text-xs text-faint">v{game.rulesVersion}</Td>
                  <Td align="center">
                    <Badge tone={game.isActive ? 'green' : 'slate'}>{game.isActive ? 'on' : 'off'}</Badge>
                  </Td>
                  {can('game:manage') && (
                    <Td align="right" className="pr-4">
                      <div className="flex justify-end">
                        <Button size="sm" icon={<IconEdit className="h-3.5 w-3.5" />} onClick={() => setRulesTarget(game)}>
                          Edit
                        </Button>
                      </div>
                    </Td>
                  )}
                </Tr>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : tab === 'matches' ? (
        <Card
          bodyClassName="p-0"
          title="Matches"
          subtitle="The board a player saw is the board stored here, with any answer keys removed by the engine."
          actions={
            <>
              <Select
                aria-label="Filter by game"
                value={sessionFilter.gameKey}
                onChange={(e) => setSessionFilter((f) => ({ ...f, gameKey: e.target.value }))}
                className="w-40"
              >
                <option value="">All games</option>
                {definitions.map((game) => (
                  <option key={game.key} value={game.key}>
                    {game.name}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Filter by status"
                value={sessionFilter.status}
                onChange={(e) => setSessionFilter((f) => ({ ...f, status: e.target.value }))}
                className="w-40"
              >
                <option value="">All statuses</option>
                {(['WAITING', 'READY', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'DISPUTED'] as GameSessionStatus[]).map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </Select>
            </>
          }
        >
          {sessions.length === 0 ? (
            <EmptyState title="No matches" message="Nothing has been played under these filters." icon={<IconGame className="h-6 w-6" />} />
          ) : (
            <Table>
              <THead>
                <Th>Match</Th>
                <Th>Players</Th>
                <Th>Status</Th>
                <Th align="center">Rules</Th>
                <Th align="right">Fee</Th>
                <Th>Settlement</Th>
                <Th>Started</Th>
                <Th align="right" className="pr-4">
                  Replay
                </Th>
              </THead>
              <TBody>
                {sessions.map((session) => (
                  <Tr key={session.id} active={sessionTarget?.id === session.id}>
                    <Td>
                      <p className="text-sm font-semibold text-ink">{rulesFor(session.gameKey)?.name ?? session.gameKey}</p>
                      <p className="font-mono text-[11px] text-faint">{session.id.slice(0, 8)}</p>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        {session.participants.slice(0, 4).map((p) => (
                          <span key={p.userId} title={`${p.username} · ${p.prizeDiamonds > 0 ? `prize ${p.prizeDiamonds}` : p.score} pts`}>
                            <Avatar name={p.username} src={p.avatarUrl} size="sm" />
                          </span>
                        ))}
                        <span className="ml-1 text-xs text-faint">{session.participants.length}</span>
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={SESSION_TONES[session.status] ?? 'slate'}>{session.status}</Badge>
                    </Td>
                    <Td align="center" className="tabular-nums text-xs text-faint">v{session.rulesVersion}</Td>
                    <Td align="right" className="tabular-nums text-xs text-muted">
                      {session.entryFeeDiamonds > 0 ? formatDiamonds(session.entryFeeDiamonds) : '—'}
                    </Td>
                    <Td>
                      <span className="text-xs text-muted">{session.settlementStatus}</span>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted" title={formatDateTime(session.startedAt ?? session.createdAt)}>
                      {relativeTime(session.startedAt ?? session.createdAt)}
                    </Td>
                    <Td align="right" className="pr-4">
                      <Button size="sm" variant="ghost" onClick={() => setSessionTarget(session)}>
                        Open
                      </Button>
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      ) : (
        <Card bodyClassName="p-0" title="Disputes" subtitle="A player objects after the result; only an operator ruling moves money.">
          {disputes.length === 0 ? (
            <EmptyState title="No disputes" message="Nobody has objected to a result." icon={<IconCheck className="h-6 w-6" />} />
          ) : (
            <Table>
              <THead>
                <Th>Raised by</Th>
                <Th>Reason</Th>
                <Th>Match</Th>
                <Th>Status</Th>
                <Th>Opened</Th>
                {can('game:dispute') && (
                  <Th align="right" className="pr-4">
                    Ruling
                  </Th>
                )}
              </THead>
              <TBody>
                {disputes.map((dispute) => (
                  <Tr key={dispute.id}>
                    <Td>
                      <div className="flex items-center gap-2">
                        <Avatar name={dispute.raisedBy.username} src={dispute.raisedBy.avatarUrl} size="sm" />
                        <span className="text-sm text-ink">{dispute.raisedBy.username}</span>
                      </div>
                    </Td>
                    <Td>
                      <span className="line-clamp-2 max-w-md break-words text-xs text-muted">{dispute.reason}</span>
                    </Td>
                    <Td className="font-mono text-[11px] text-faint">{dispute.sessionId.slice(0, 8)}</Td>
                    <Td>
                      <Badge tone={dispute.status === 'OPEN' ? 'amber' : dispute.status === 'RESOLVED' ? 'green' : 'slate'}>
                        {dispute.status}
                      </Badge>
                    </Td>
                    <Td className="whitespace-nowrap text-xs text-muted" title={formatDateTime(dispute.createdAt)}>
                      {relativeTime(dispute.createdAt)}
                    </Td>
                    {can('game:dispute') && (
                      <Td align="right" className="pr-4">
                        {dispute.status === 'OPEN' ? (
                          <Button size="sm" variant="primary" onClick={() => setDisputeTarget(dispute)}>
                            Review
                          </Button>
                        ) : (
                          <span className="block text-right text-xs text-faint">{dispute.resolution ?? 'closed'}</span>
                        )}
                      </Td>
                    )}
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}

      {rulesTarget !== null && (
        <RulesModal
          game={rulesTarget}
          onClose={() => setRulesTarget(null)}
          onSaved={(saved) => {
            setDefinitions((current) => current.map((game) => (game.key === saved.key ? saved : game)));
            setRulesTarget(null);
          }}
        />
      )}
      {sessionTarget !== null && (
        <SessionModal
          session={sessionTarget}
          onClose={() => setSessionTarget(null)}
        />
      )}
      {disputeTarget !== null && (
        <DisputeModal
          dispute={disputeTarget}
          onClose={() => setDisputeTarget(null)}
          onRuled={(ruled) => {
            setDisputes((current) => current.map((d) => (d.id === ruled.id ? ruled : d)));
            setDisputeTarget(null);
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rule editor. Only the fields the operator touched are sent, so an untouched
// band stays exactly as seeded.
// ---------------------------------------------------------------------------
interface RulesModalProps {
  game: GameDefinition;
  onClose: () => void;
  onSaved: (game: GameDefinition) => void;
}

function RulesModal({ game, onClose, onSaved }: RulesModalProps) {
  const [form, setForm] = useState({
    isActive: game.isActive,
    entryFeeEnabled: game.entryFeeEnabled,
    entryFeeDiamonds: String(game.entryFeeDiamonds),
    entryFeeMin: String(game.entryFeeMin),
    entryFeeMax: String(game.entryFeeMax),
    prizeEnabled: game.prizeEnabled,
    commissionBps: String(game.commissionBps),
    refundPolicy: game.refundPolicy,
    turnTimeoutSeconds: String(game.turnTimeoutSeconds),
    maxPlayers: String(game.maxPlayers),
    dailyEntryLimit: String(game.dailyEntryLimit),
    promoFreeEntry: game.promoFreeEntry,
    promoUntil: game.promoUntil ? game.promoUntil.slice(0, 10) : '',
  });
  const [ladder, setLadder] = useState<Array<{ rank: number; shareBps: number }>>(
    game.prizeRules.length ? game.prizeRules : [{ rank: 1, shareBps: 10000 }],
  );
  const [confirmCompliance, setConfirmCompliance] = useState(false);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const int = (value: string): number => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const ladderTotal = useMemo(() => ladder.reduce((sum, row) => sum + row.shareBps, 0), [ladder]);
  const editsMoney =
    (form.entryFeeEnabled && int(form.entryFeeDiamonds) > 0) ||
    form.prizeEnabled ||
    int(form.entryFeeMax) > int(form.entryFeeMin);
  const needsCompliance = editsMoney && !confirmCompliance;

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setServerError(null);
    const patch: GameRulePatch = {
      isActive: form.isActive,
      entryFeeEnabled: form.entryFeeEnabled,
      entryFeeDiamonds: int(form.entryFeeDiamonds),
      entryFeeMin: int(form.entryFeeMin),
      entryFeeMax: int(form.entryFeeMax),
      prizeEnabled: form.prizeEnabled,
      commissionBps: int(form.commissionBps),
      refundPolicy: form.refundPolicy,
      turnTimeoutSeconds: int(form.turnTimeoutSeconds),
      maxPlayers: int(form.maxPlayers),
      dailyEntryLimit: int(form.dailyEntryLimit),
      promoFreeEntry: form.promoFreeEntry,
      promoUntil: form.promoUntil === '' ? null : `${form.promoUntil}T00:00:00.000Z`,
      prizeRules: ladder,
      confirmCompliance: confirmCompliance || undefined,
    };
    try {
      const result = await api.setGameRules(game.key, patch);
      onSaved(result.game);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'The rules were not saved.');
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`${game.name} — rules v${game.rulesVersion}`}
      subtitle="Changing any money field publishes a new version. Matches already opened keep the rules they started under."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={needsCompliance && editsMoney} onClick={() => void submit()}>
            Save rules
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="Seats (1–8)"
            value={form.maxPlayers}
            onChange={(e) => setForm((f) => ({ ...f, maxPlayers: e.target.value }))}
            inputMode="numeric"
          />
          <Input
            label="Turn clock, seconds (5–300)"
            value={form.turnTimeoutSeconds}
            onChange={(e) => setForm((f) => ({ ...f, turnTimeoutSeconds: e.target.value }))}
            inputMode="numeric"
          />
          <Input
            label="Entries per player per day (0 = unlimited)"
            value={form.dailyEntryLimit}
            onChange={(e) => setForm((f) => ({ ...f, dailyEntryLimit: e.target.value }))}
            inputMode="numeric"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="Entry fee floor"
            value={form.entryFeeMin}
            onChange={(e) => setForm((f) => ({ ...f, entryFeeMin: e.target.value }))}
            inputMode="numeric"
            hint="A 0–0 band keeps the game free to play by construction."
          />
          <Input
            label="Entry fee ceiling"
            value={form.entryFeeMax}
            onChange={(e) => setForm((f) => ({ ...f, entryFeeMax: e.target.value }))}
            inputMode="numeric"
          />
          <Input
            label="Fee charged per entry"
            value={form.entryFeeDiamonds}
            onChange={(e) => setForm((f) => ({ ...f, entryFeeDiamonds: e.target.value }))}
            inputMode="numeric"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-elevated/50 px-3 py-2.5">
            <span className="text-sm text-ink">Charge the entry fee</span>
            <Switch checked={form.entryFeeEnabled} onChange={(next) => setForm((f) => ({ ...f, entryFeeEnabled: next }))} label="Charge entry fee" />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-elevated/50 px-3 py-2.5">
            <span className="text-sm text-ink">Pay out prizes</span>
            <Switch checked={form.prizeEnabled} onChange={(next) => setForm((f) => ({ ...f, prizeEnabled: next }))} label="Pay out prizes" />
          </label>
          <label className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-elevated/50 px-3 py-2.5">
            <span className="text-sm text-ink">Game is playable</span>
            <Switch checked={form.isActive} onChange={(next) => setForm((f) => ({ ...f, isActive: next }))} label="Game is playable" />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Input
            label="Platform cut (bps of the pool, 0–5000)"
            value={form.commissionBps}
            onChange={(e) => setForm((f) => ({ ...f, commissionBps: e.target.value }))}
            inputMode="numeric"
            hint={`${(int(form.commissionBps) / 100).toFixed(2)}% of every settled pool`}
          />
          <Select
            label="Refund policy"
            value={form.refundPolicy}
            onChange={(e) => setForm((f) => ({ ...f, refundPolicy: e.target.value as GameRefundPolicy }))}
          >
            {REFUND_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {policy}
              </option>
            ))}
          </Select>
          <Input
            label="Free-entry promo until (YYYY-MM-DD, blank = off)"
            type="date"
            value={form.promoUntil}
            onChange={(e) => setForm((f) => ({ ...f, promoUntil: e.target.value }))}
          />
        </div>

        <label className="flex items-center justify-between gap-3 rounded-lg border border-edge bg-elevated/50 px-3 py-2.5">
          <span className="text-sm text-ink">
            Promo: everyone enters free
            <span className="ml-2 text-xs text-faint">until the date above, if set</span>
          </span>
          <Switch checked={form.promoFreeEntry} onChange={(next) => setForm((f) => ({ ...f, promoFreeEntry: next }))} label="Promo free entry" />
        </label>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted">Prize ladder</p>
            <Button
              size="sm"
              variant="ghost"
              icon={<IconPlus className="h-3.5 w-3.5" />}
              onClick={() => setLadder((rows) => [...rows, { rank: rows.length + 1, shareBps: 0 }])}
            >
              Add rank
            </Button>
          </div>
          <div className="space-y-2">
            {ladder.map((row, index) => (
              <div key={row.rank} className="flex items-center gap-2">
                <Input
                  aria-label={`Rank ${index + 1}`}
                  className="w-24"
                  value={String(row.rank)}
                  inputMode="numeric"
                  onChange={(e) =>
                    setLadder((rows) => rows.map((r, i) => (i === index ? { ...r, rank: Number.parseInt(e.target.value, 10) || 0 } : r)))
                  }
                />
                <Input
                  aria-label={`Share of the prize pool in bps for rank ${index + 1}`}
                  value={String(row.shareBps)}
                  inputMode="numeric"
                  onChange={(e) =>
                    setLadder((rows) =>
                      rows.map((r, i) => (i === index ? { ...r, shareBps: Number.parseInt(e.target.value, 10) || 0 } : r)),
                    )
                  }
                />
                <span className="w-14 shrink-0 text-right text-xs tabular-nums text-faint">
                  {((row.shareBps / 10000) * 100).toFixed(1)}%
                </span>
                <IconButton
                  label={`Remove rank ${row.rank}`}
                  tone="danger"
                  onClick={() => setLadder((rows) => rows.filter((_, i) => i !== index))}
                >
                  <IconTrash className="h-4 w-4" />
                </IconButton>
              </div>
            ))}
          </div>
          <p className={`mt-2 text-xs ${ladderTotal > 10000 ? 'text-rose-400' : 'text-faint'}`}>
            {ladderTotal.toLocaleString('en-US')} bps of 10,000 — leftover shares are never invented, and the server refuses a ladder over 100%.
          </p>
        </div>

        {editsMoney && (
          <label
            className={`flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-3 ${
              confirmCompliance ? 'border-emerald-500/50 bg-emerald-950/30' : 'border-amber-500/50 bg-amber-950/25'
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0 accent-emerald-500"
              checked={confirmCompliance}
              onChange={(e) => setConfirmCompliance(e.target.checked)}
            />
            <span className="text-xs leading-relaxed text-ink">
              A compliance review for the target market has been completed for paid entry and redeemable
              prizes in this game. Saving with this ticked records that decision against the new rules
              version; leaving it unticked keeps the game free to play.
            </span>
          </label>
        )}

        {serverError !== null && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
            <IconAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{serverError}</span>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Match replay: the stored board plus the ordered event log.
// ---------------------------------------------------------------------------
function SessionModal({ session, onClose }: { session: GameSession; onClose: () => void }) {
  const [events, setEvents] = useState<GameEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .gameEvents(session.id)
      .then((result) => {
        if (!cancelled) setEvents(result.events);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load the event log.');
      });
    return () => {
      cancelled = true;
    };
  }, [session.id]);

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={`Match ${session.id.slice(0, 8)}`}
      subtitle={`${session.status} · settled ${session.settlementStatus} · rules v${session.rulesVersion}`}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border border-edge/60 bg-elevated/40 p-3">
            <p className="text-[10px] uppercase tracking-widest text-faint">Players</p>
            <ul className="mt-2 space-y-1.5">
              {session.participants.map((p) => (
                <li key={p.userId} className="flex items-center gap-2 text-sm">
                  <Avatar name={p.username} src={p.avatarUrl} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-ink">{p.username}</span>
                  <span className="text-xs tabular-nums text-muted">
                    {p.rank !== null ? `#${p.rank}` : p.status} · {p.score} pts
                  </span>
                  <span className="w-20 text-right text-xs tabular-nums text-fuchsia-300">
                    {p.prizeDiamonds > 0 ? formatDiamonds(p.prizeDiamonds) : '—'}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border border-edge/60 bg-elevated/40 p-3 text-xs text-muted">
            <p className="text-[10px] uppercase tracking-widest text-faint">Match</p>
            <dl className="mt-2 space-y-1">
              <div className="flex justify-between gap-3">
                <dt>Fee per seat</dt>
                <dd className="tabular-nums text-ink">{formatDiamonds(session.entryFeeDiamonds)}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Turn owner</dt>
                <dd className="truncate font-mono text-ink">{session.turnOwnerId ? session.turnOwnerId.slice(0, 8) : '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Turn deadline</dt>
                <dd className="text-ink">{session.turnDeadlineAt ? formatDateTime(session.turnDeadlineAt) : '—'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt>Room</dt>
                <dd className="truncate font-mono text-ink">{session.roomId ? session.roomId.slice(0, 8) : 'no room'}</dd>
              </div>
            </dl>
          </div>
        </div>

        {session.result !== null && <JsonBlock label="Result" value={session.result} />}
        <JsonBlock label="Board state (as stored, secrets removed)" value={session.state} />

        <div>
          <p className="mb-1 text-[10px] uppercase tracking-widest text-faint">Event log</p>
          {error !== null ? (
            <p className="text-xs text-rose-400">{error}</p>
          ) : events === null ? (
            <div className="grid h-16 place-items-center text-violet-300">
              <Spinner />
            </div>
          ) : (
            <Table>
              <THead>
                <Th align="right" width="60px">
                  #
                </Th>
                <Th>Type</Th>
                <Th>Payload</Th>
                <Th align="right" className="pr-4">
                  At
                </Th>
              </THead>
              <TBody>
                {events.map((event) => (
                  <Tr key={`${event.seq}-${event.type}`}>
                    <Td align="right" className="tabular-nums text-xs text-faint">{event.seq}</Td>
                    <Td>
                      <Badge tone="slate">{event.type}</Badge>
                    </Td>
                    <Td>
                      <span className="block max-w-md truncate font-mono text-[11px] text-muted" title={JSON.stringify(event.payload)}>
                        {JSON.stringify(event.payload)}
                      </span>
                    </Td>
                    <Td align="right" className="pr-4 text-xs text-faint" title={formatDateTime(event.createdAt)}>
                      {relativeTime(event.createdAt)}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Dispute ruling.
// ---------------------------------------------------------------------------
function DisputeModal({ dispute, onClose, onRuled }: { dispute: GameDispute; onClose: () => void; onRuled: (d: GameDispute) => void }) {
  const [decision, setDecision] = useState<'UPHELD' | 'REJECTED' | 'REFUNDED'>('UPHELD');
  const [resolution, setResolution] = useState('');
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = async () => {
    if (saving || resolution.trim().length < 3) return;
    setSaving(true);
    setServerError(null);
    try {
      const result = await api.reviewDispute(dispute.id, decision, resolution.trim());
      onRuled(result.dispute);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'The ruling was not recorded.');
      setSaving(false);
    }
  };

  const options: Array<{ id: 'UPHELD' | 'REJECTED' | 'REFUNDED'; label: string; note: string }> = [
    { id: 'UPHELD', label: 'Uphold result', note: 'Prizes already paid stay paid.' },
    { id: 'REJECTED', label: 'Reject complaint', note: 'Nothing moves; the result stands.' },
    { id: 'REFUNDED', label: 'Refund entry fees', note: 'Both seats get their entry fee back.' },
  ];

  return (
    <Modal
      open
      onClose={onClose}
      title="Ruling on a dispute"
      subtitle={`Match ${dispute.sessionId.slice(0, 8)} · raised by ${dispute.raisedBy.username}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} disabled={resolution.trim().length < 3} onClick={() => void submit()}>
            Record ruling
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="rounded-lg border border-edge/60 bg-elevated/40 p-3">
          <p className="text-[10px] uppercase tracking-widest text-faint">Player’s reason</p>
          <p className="mt-1 text-sm text-ink">{dispute.reason}</p>
        </div>

        <div className="space-y-2">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setDecision(option.id)}
              aria-pressed={decision === option.id}
              className={`focus-ring flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition ${
                decision === option.id ? 'border-violet-500/70 bg-brand-gradient-soft' : 'border-edge bg-elevated/50 hover:text-ink'
              }`}
            >
              <span className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-full border ${decision === option.id ? 'border-violet-400 bg-violet-500' : 'border-edge'}`}>
                {decision === option.id && <IconCheck className="h-3 w-3 text-white" />}
              </span>
              <span>
                <span className="block text-sm font-semibold text-ink">{option.label}</span>
                <span className="block text-xs text-muted">{option.note}</span>
              </span>
            </button>
          ))}
        </div>

        <Textarea
          label="What you decided, and why (kept in the audit log)"
          rows={3}
          maxLength={500}
          value={resolution}
          onChange={(e) => setResolution(e.target.value)}
          placeholder="e.g. Reviewed the replay: every move was made inside the turn clock; result stands."
        />

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
