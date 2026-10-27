// ---------------------------------------------------------------------------
// Room Monitor: polls GET /api/admin/rooms every 5s (pausable), force-closes
// rooms, and opens a per-room drawer with seat/audience rosters + disconnect.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { categoryBadge } from './OverviewPage';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import {
  IconAlert,
  IconBan,
  IconClose,
  IconEye,
  IconMic,
  IconPause,
  IconPlay,
  IconPlugUnplug,
  IconRefresh,
} from '../components/ui/Icons';
import { Table, TBody, Td, Th, THead, Tr } from '../components/ui/Table';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { formatCompact, formatRCoin, parseUnsignedInt, relativeTime } from '../lib/format';
import type { AdminRoom, RoomOccupant, SeatPolicyResult } from '../types';

const POLL_INTERVAL_MS = 5000;

export default function RoomsPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const [rooms, setRooms] = useState<AdminRoom[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const [closeTarget, setCloseTarget] = useState<AdminRoom | null>(null);
  const [drawerRoomId, setDrawerRoomId] = useState<string | null>(null);

  // Keep the freshest list readable from stable callbacks.
  const roomsRef = useRef<AdminRoom[]>([]);

  const load = useCallback(async () => {
    try {
      const result = await api.listRooms({ status: 'ACTIVE' });
      setRooms(result.rooms);
      roomsRef.current = result.rooms;
      setError(null);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reach the backend.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [paused, load]);

  // Deep-link support: /rooms?focus=<id> opens that room's drawer once loaded.
  useEffect(() => {
    const focus = searchParams.get('focus');
    if (!focus || rooms === null) return;
    if (rooms.some((room) => room.id === focus)) {
      setDrawerRoomId(focus);
      setSearchParams({}, { replace: true });
    }
  }, [rooms, searchParams, setSearchParams]);

  const drawerRoom = drawerRoomId === null ? null : (roomsRef.current.find((r) => r.id === drawerRoomId) ?? null);

  const onRoomClosed = (room: AdminRoom) => {
    toast.success(`Room “${room.title}” force-closed.`);
    setCloseTarget(null);
    if (drawerRoomId === room.id) setDrawerRoomId(null);
    void load();
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-ink">
            Room Monitor
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
              {paused ? (
                <>
                  <span className="h-2 w-2 rounded-full bg-amber-400" /> PAUSED
                </>
              ) : (
                <>
                  <span className="relative flex h-2 w-2">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-70" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-400" />
                  </span>
                  LIVE · 5s
                </>
              )}
            </span>
          </h1>
          <p className="mt-0.5 text-sm text-muted">
            {lastUpdated === null ? 'Connecting…' : `Refreshed ${relativeTime(lastUpdated.toISOString())}`}
            {error !== null && <span className="ml-2 text-rose-300">· {error}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
            Refresh
          </Button>
          <Button
            variant={paused ? 'primary' : 'secondary'}
            icon={paused ? <IconPlay className="h-4 w-4" /> : <IconPause className="h-4 w-4" />}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? 'Resume' : 'Pause'}
          </Button>
        </div>
      </div>

      <SeatPolicyCard />

      <Card bodyClassName="p-0">
        {rooms === null && error === null ? (
          <div className="grid h-64 place-items-center text-violet-300">
            <Spinner className="h-8 w-8" />
          </div>
        ) : rooms !== null && rooms.length === 0 ? (
          <EmptyState
            title="No active rooms"
            message="Every party has to start somewhere. Live rooms appear here automatically."
            icon={<IconMic className="h-6 w-6" />}
          />
        ) : (
          <Table>
            <THead>
              <Th width="28%">Room</Th>
              <Th>Host</Th>
              <Th>Category</Th>
              <Th align="center">Seats</Th>
              <Th align="center">Listeners</Th>
              <Th align="right">Gift value</Th>
              <Th>Opened</Th>
              <Th align="right" className="pr-4">
                Actions
              </Th>
            </THead>
            <TBody>
              {(rooms ?? []).map((room) => (
                <Tr key={room.id} active={drawerRoomId === room.id}>
                  <Td>
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-ink">{room.title}</p>
                      <p className="text-xs text-faint">
                        #{room.roomNumber} · <span className="uppercase">{room.type}</span>
                      </p>
                    </div>
                  </Td>
                  <Td>
                    <span className="flex items-center gap-2">
                      <Avatar name={room.host.username} src={room.host.avatarUrl} size="xs" />
                      <span className="truncate">{room.host.username}</span>
                    </span>
                  </Td>
                  <Td>{categoryBadge(room.category)}</Td>
                  <Td align="center">
                    <span className="tabular-nums">
                      <span className={room.onlineSeatCount > 0 ? 'text-ink' : ''}>{room.onlineSeatCount}</span>
                      <span className="text-faint">/{room.seatCapacity}</span>
                    </span>
                  </Td>
                  <Td align="center" className="tabular-nums">
                    {formatCompact(room.listenerCount)}
                  </Td>
                  <Td align="right" className="tabular-nums text-ink">
                    {formatRCoin(room.totalGiftValue)}
                  </Td>
                  <Td className="whitespace-nowrap">{relativeTime(room.createdAt)}</Td>
                  <Td align="right" className="pr-4">
                    <div className="flex items-center justify-end gap-1.5">
                      <Button size="sm" icon={<IconEye className="h-3.5 w-3.5" />} onClick={() => setDrawerRoomId(room.id)}>
                        Monitor
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => navigate(`/rooms/${room.id}`)}>
                        Console
                      </Button>
                      <IconButton label={`Close ${room.title}`} tone="danger" onClick={() => setCloseTarget(room)}>
                        <IconBan className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {closeTarget !== null && (
        <CloseRoomModal room={closeTarget} onClose={() => setCloseTarget(null)} onClosed={onRoomClosed} />
      )}

      {drawerRoom !== null && (
        <RoomDrawer
          room={drawerRoom}
          onClose={() => setDrawerRoomId(null)}
          onDisconnected={() => void load()}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Force-close confirmation.
// ---------------------------------------------------------------------------
interface CloseRoomModalProps {
  room: AdminRoom;
  onClose: () => void;
  onClosed: (room: AdminRoom) => void;
}

function CloseRoomModal({ room, onClose, onClosed }: CloseRoomModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const submit = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await api.closeRoom(room.id);
      onClosed(room);
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Failed to close the room.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Force-close room?"
      subtitle={`#${room.roomNumber} · ${room.title}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void submit()} loading={submitting}>
            Close room
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>
          The room will be shut down immediately and everyone inside (host included) is disconnected.
          This cannot be undone — the host must open a new room.
        </p>
        <div className="grid grid-cols-3 gap-2 rounded-lg border border-edge/60 bg-elevated/40 p-3 text-center">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-faint">Seats live</p>
            <p className="mt-0.5 font-bold tabular-nums text-ink">
              {room.onlineSeatCount}/{room.seatCapacity}
            </p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-faint">Listeners</p>
            <p className="mt-0.5 font-bold tabular-nums text-ink">{formatCompact(room.listenerCount)}</p>
          </div>
          <div>
            <p className="text-[11px] uppercase tracking-wide text-faint">Gift value</p>
            <p className="mt-0.5 font-bold tabular-nums text-ink">{formatRCoin(room.totalGiftValue)}</p>
          </div>
        </div>
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

// ---------------------------------------------------------------------------
// Per-room drawer: aggregates + roster (when the backend includes it) with a
// disconnect action per user; manual user-id disconnect as a universal path.
// ---------------------------------------------------------------------------
interface RoomDrawerProps {
  room: AdminRoom;
  onClose: () => void;
  onDisconnected: () => void;
}

function OccupantRow({ room, occupant, onDisconnected }: { room: AdminRoom; occupant: RoomOccupant; onDisconnected: () => void }) {
  const toast = useToast();
  const [pending, setPending] = useState(false);

  const disconnect = async () => {
    if (pending) return;
    setPending(true);
    try {
      await api.disconnectRoomUser(room.id, occupant.userId);
      toast.success(`${occupant.username} disconnected.`);
      onDisconnected();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Disconnect failed.');
      setPending(false);
    }
  };

  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-edge/50 bg-elevated/40 px-3 py-2">
      <Avatar name={occupant.username} src={occupant.avatarUrl} size="xs" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">
          {occupant.username}
          {occupant.handRaised === true && (
            <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">raised</span>
          )}
        </p>
        <p className="text-[11px] text-faint">
          {occupant.seatIndex !== null && occupant.seatIndex !== undefined
            ? `Seat ${occupant.seatIndex}`
            : 'Audience'}
          {occupant.role !== undefined ? ` · ${occupant.role}` : ''}
        </p>
      </div>
      <Button size="sm" variant="ghost" loading={pending} onClick={() => void disconnect()} icon={<IconPlugUnplug className="h-3.5 w-3.5" />}>
        Disconnect
      </Button>
    </li>
  );
}

function RoomDrawer({ room, onClose, onDisconnected }: RoomDrawerProps) {
  const toast = useToast();
  const [manualUserId, setManualUserId] = useState('');
  const [manualPending, setManualPending] = useState(false);

  const seats = room.seats ?? [];
  const audience = room.audience ?? [];
  const hasRoster = seats.length > 0 || audience.length > 0;

  const disconnectManual = async () => {
    const userId = manualUserId.trim();
    if (userId.length === 0 || manualPending) return;
    setManualPending(true);
    try {
      await api.disconnectRoomUser(room.id, userId);
      toast.success('User disconnected.');
      setManualUserId('');
      onDisconnected();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Disconnect failed.');
    } finally {
      setManualPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 animate-fade-in bg-black/60 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <aside
        role="dialog"
        aria-label={`Room ${room.roomNumber} details`}
        className="absolute inset-y-0 right-0 flex w-full max-w-md animate-slide-in-right flex-col border-l border-edge/60 bg-surface shadow-glow"
      >
        <header className="flex items-start justify-between gap-3 border-b border-edge/60 px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-bold text-ink">{room.title}</h2>
            <p className="mt-0.5 text-xs text-muted">
              #{room.roomNumber} · host{' '}
              <span className="text-violet-300">{room.host.username}</span> ·{' '}
              {room.description ?? 'no description'}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {categoryBadge(room.category)}
              <Badge tone="slate">{room.type}</Badge>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close room details"
            className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-elevated hover:text-ink"
          >
            <IconClose className="h-4 w-4" />
          </button>
        </header>

        <div className="grid grid-cols-3 gap-2 border-b border-edge/60 px-5 py-4 text-center">
          <div className="rounded-lg bg-elevated/50 py-2">
            <p className="text-[10px] uppercase tracking-wide text-faint">Seats</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums text-ink">
              {room.onlineSeatCount}/{room.seatCapacity}
            </p>
          </div>
          <div className="rounded-lg bg-elevated/50 py-2">
            <p className="text-[10px] uppercase tracking-wide text-faint">Listeners</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums text-ink">{formatCompact(room.listenerCount)}</p>
          </div>
          <div className="rounded-lg bg-elevated/50 py-2">
            <p className="text-[10px] uppercase tracking-wide text-faint">Gift value</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums text-fuchsia-300">{formatRCoin(room.totalGiftValue)}</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">On the mic</h3>
            {seats.length === 0 ? (
              <p className="rounded-lg border border-dashed border-edge/60 px-3 py-3 text-xs text-faint">
                No seat roster included in the live snapshot for this room.
              </p>
            ) : (
              <ul className="space-y-2">
                {seats.map((occupant) => (
                  <OccupantRow key={occupant.userId} room={room} occupant={occupant} onDisconnected={onDisconnected} />
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-faint">
              Audience {audience.length > 0 ? `(${audience.length})` : ''}
            </h3>
            {audience.length === 0 ? (
              <p className="rounded-lg border border-dashed border-edge/60 px-3 py-3 text-xs text-faint">
                No audience entries in the live snapshot for this room.
              </p>
            ) : (
              <ul className="space-y-2">
                {audience.map((occupant) => (
                  <OccupantRow key={occupant.userId} room={room} occupant={occupant} onDisconnected={onDisconnected} />
                ))}
              </ul>
            )}
          </section>

          <section className="rounded-lg border border-edge/60 bg-elevated/30 p-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-faint">Disconnect by user id</h3>
            <p className="mt-1 text-[11px] text-faint">
              Universal escape hatch — works even when the live snapshot omits the roster. Paste any user
              (UUID) currently inside the room.
            </p>
            <div className="mt-2 flex items-end gap-2">
              <Input
                placeholder="userId (uuid)"
                value={manualUserId}
                onChange={(e) => setManualUserId(e.target.value)}
                className="flex-1"
                aria-label="User id to disconnect"
              />
              <Button
                variant="danger"
                onClick={() => void disconnectManual()}
                loading={manualPending}
                disabled={manualUserId.trim().length === 0}
              >
                Kick
              </Button>
            </div>
          </section>

          {!hasRoster && (
            <p className="text-[11px] text-faint">
              Tip: counters above refresh every poll cycle; roster detail depends on what the backend
              attaches to each live room.
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// rooms.seats — how many microphones a room may hand out.
//
// The number is a platform policy rather than a constant baked into a client: 15
// speaker seats by default, and an operator may move it anywhere inside the ceiling
// the schema will accept. Writing takes `config:manage` and the backend records the
// change in the audit trail. Seat 0 is the host seat, so every count here is one
// smaller than the number of seats a room actually gets.
// ---------------------------------------------------------------------------
function SeatPolicyCard() {
  const toast = useToast();
  const { can } = useAuth();
  const canWrite = can('config:manage');

  const [policy, setPolicy] = useState<SeatPolicyResult | null>(null);
  const [speakerSeats, setSpeakerSeats] = useState('');
  const [maxSpeakerSeats, setMaxSpeakerSeats] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.seatPolicy();
      setPolicy(result);
      setSpeakerSeats(String(result.speakerSeats));
      setMaxSpeakerSeats(String(result.maxSpeakerSeats));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to read the seat policy.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // The server names the ceiling it will accept; 64 is what migration 0012 allows, and
  // a speaker count is one seat less than the room it makes.
  const ceiling = (policy?.ceiling ?? 64) - 1;
  const speakers = parseUnsignedInt(speakerSeats);
  const maxSpeakers = parseUnsignedInt(maxSpeakerSeats);
  const inRange =
    speakers !== null &&
    maxSpeakers !== null &&
    speakers >= 1 &&
    speakers <= ceiling &&
    maxSpeakers >= speakers &&
    maxSpeakers <= ceiling;

  const save = async () => {
    if (busy || speakers === null || maxSpeakers === null || !inRange) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.writeSeatPolicy({ speakerSeats: speakers, maxSpeakerSeats: maxSpeakers });
      // The write response names the new numbers but not the ceiling; keep reading it
      // from the GET so the card still shows the bound a policy cannot pass.
      setPolicy({ ...result, ceiling: policy?.ceiling });
      toast.success('Seat policy saved. New rooms get it immediately.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The write was refused.');
    } finally {
      setBusy(false);
    }
  };

  if (policy === null) {
    return error !== null ? (
      <Card title="Seat policy">
        <div className="flex items-center gap-3 text-xs text-rose-300">
          <IconAlert className="h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      </Card>
    ) : (
      <Card title="Seat policy">
        <div className="grid h-20 place-items-center text-violet-300">
          <Spinner className="h-5 w-5" />
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Seat policy"
      subtitle="Speaker seats a new room gets, and the most a host may choose. Seat 0 is the host, so a room holds one more seat than the number below."
      actions={
        canWrite ? (
          <Button variant="primary" size="sm" onClick={() => void save()} loading={busy} disabled={!inRange}>
            Save policy
          </Button>
        ) : undefined
      }
    >
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-edge/60 bg-elevated/40 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-faint">Default speaker seats</p>
          <Input
            className="mt-2"
            inputMode="numeric"
            value={speakerSeats}
            disabled={!canWrite}
            onChange={(e) => setSpeakerSeats(e.target.value)}
            aria-label="Default speaker seats"
          />
          <p className="mt-2 text-[11px] text-faint">
            {policy.seatCapacity.default} seats in a room whose host picks no capacity.
          </p>
        </div>
        <div className="rounded-xl border border-edge/60 bg-elevated/40 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-faint">Largest room allowed</p>
          <Input
            className="mt-2"
            inputMode="numeric"
            value={maxSpeakerSeats}
            disabled={!canWrite}
            onChange={(e) => setMaxSpeakerSeats(e.target.value)}
            aria-label="Maximum speaker seats"
          />
          <p className="mt-2 text-[11px] text-faint">
            A host may ask for up to {policy.seatCapacity.max} seats; anything larger is refused.
          </p>
        </div>
        <div className="rounded-xl border border-edge/60 bg-elevated/40 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-faint">Schema ceiling</p>
          <p className="mt-2 text-lg font-semibold text-ink">{policy.ceiling ?? '—'}</p>
          <p className="mt-2 text-[11px] text-faint">
            The most seats PostgreSQL will accept. A policy above it is rejected before it is stored.
          </p>
        </div>
        <div className="rounded-xl border border-edge/60 bg-elevated/40 p-4">
          <p className="text-xs font-medium uppercase tracking-wider text-faint">Last changed</p>
          <p className="mt-2 text-sm text-ink">{policy.updatedAt ? relativeTime(policy.updatedAt) : 'Set by the migration'}</p>
          <p className="mt-2 text-[11px] text-faint">Written to the audit trail as SYSTEM_CONFIG_UPDATE.</p>
        </div>
      </div>
      {!inRange && (
        <p className="mt-3 text-[11px] text-amber-300">
          Speaker seats must be between 1 and {ceiling}, and the largest room cannot be smaller than the default.
        </p>
      )}
      {error !== null && (
        <div className="mt-3 flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
          <IconAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}
      <p className="mt-3 text-[11px] text-faint">
        {canWrite
          ? 'Rooms already open keep the seats they were created with; this applies to new rooms.'
          : 'Reading the policy is part of room:read. Changing it needs config:manage.'}
      </p>
    </Card>
  );
}
