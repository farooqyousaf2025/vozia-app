// ---------------------------------------------------------------------------
// Room Ops Console — the moderation view for a single live room.
// State comes from GET /api/admin/rooms/:id, then an admin Socket.IO channel
// patches seats, listeners, hand raises and chat in real time. Metrics are
// polled because nothing streams them.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { categoryBadge } from './OverviewPage';
import { Avatar } from '../components/ui/Avatar';
import { Badge } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Card, StatCard } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { Select } from '../components/ui/Select';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import {
  IconAlert,
  IconBan,
  IconChevronLeft,
  IconDiamond,
  IconGift,
  IconMic,
  IconPlugUnplug,
  IconRefresh,
  IconShieldCheck,
  IconUsers,
} from '../components/ui/Icons';
import { ApiError, api, assetUrl } from '../lib/api';
import { openRoomConsole, type ConsoleLinkState } from '../lib/roomSocket';
import { formatCompact, formatDiamonds, formatRCoin, relativeTime } from '../lib/format';
import { LottiePreview } from '../components/ui/LottiePreview';
import type { RoomBan, RoomChatMessage, RoomConsoleResult, RoomSeatDetail, ThemeCatalogue } from '../types';

const METRICS_POLL_MS = 10_000;
const CHAT_LIMIT = 200;

const BAN_DURATIONS = [
  { value: '10', label: '10 minutes' },
  { value: '60', label: '1 hour' },
  { value: '1440', label: '24 hours' },
  { value: '', label: 'Permanent' },
];

export default function RoomConsolePage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [view, setView] = useState<RoomConsoleResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<ConsoleLinkState>('connecting');
  const [busy, setBusy] = useState<string | null>(null);
  const [banTarget, setBanTarget] = useState<{ userId: string; username: string } | null>(null);
  const [raised, setRaised] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const result = await api.roomConsole(id);
      setView(result);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load the room.');
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => void load(), METRICS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // ---- realtime -------------------------------------------------------------
  useEffect(() => {
    if (!id) return undefined;
    const close = openRoomConsole(id, {
      onState: setLink,
      onSeats: (next) => setView((current) => (current === null ? current : { ...current, seats: next })),
      onListeners: (count) =>
        setView((current) =>
          current === null
            ? current
            : { ...current, listenerCount: count, room: { ...current.room, listenerCount: count } },
        ),
      onChat: (message) =>
        setView((current) =>
          current === null
            ? current
            : { ...current, chat: [...current.chat, message].slice(-CHAT_LIMIT) },
        ),
      onHandRaise: (user, isRaised) =>
        setRaised((current) => {
          const next = new Set(current);
          if (isRaised) next.add(user.id);
          else next.delete(user.id);
          return next;
        }),
      onTheme: (theme) =>
        setView((current) =>
          current === null ? current : { ...current, room: { ...current.room, theme } },
        ),
      onClosed: () => {
        toast.info('This room was closed.');
        void load();
      },
    });
    return () => close();
  }, [id, load, toast]);

  // ---- actions --------------------------------------------------------------
  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, success: string) => {
      if (busy !== null) return;
      setBusy(key);
      try {
        await action();
        toast.success(success);
        await load();
      } catch (err) {
        toast.error(err instanceof ApiError ? err.message : 'That action failed.');
      } finally {
        setBusy(null);
      }
    },
    [busy, load, toast],
  );

  const seats = view?.seats ?? [];
  const handRaiseIds = useMemo(() => {
    const ids = new Set(raised);
    for (const occupant of view?.handRaises ?? []) ids.add(occupant.userId);
    return ids;
  }, [raised, view]);

  if (view === null && error === null) {
    return (
      <div className="grid h-72 place-items-center text-violet-300">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  if (view === null) {
    return (
      <EmptyState
        title="Room unavailable"
        message={error ?? 'This room could not be loaded.'}
        icon={<IconAlert className="h-6 w-6" />}
        action={<Button onClick={() => navigate('/rooms')}>Back to rooms</Button>}
      />
    );
  }

  const closed = view.room.status === 'CLOSED';

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to="/rooms"
            className="focus-ring inline-flex items-center gap-1 rounded text-xs text-muted hover:text-ink"
          >
            <IconChevronLeft className="h-3.5 w-3.5" /> Room monitor
          </Link>
          <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-bold text-ink">
            {view.room.title}
            <Badge tone={closed ? 'slate' : 'green'}>{closed ? 'CLOSED' : 'LIVE'}</Badge>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${
                link === 'live'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/40 bg-amber-500/10 text-amber-300'
              }`}
            >
              <span className={`h-2 w-2 rounded-full ${link === 'live' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              {link === 'live' ? 'SOCKET LIVE' : link === 'connecting' ? 'CONNECTING' : 'SOCKET DOWN'}
            </span>
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>#{view.room.roomNumber}</span>
            <span className="text-faint">·</span>
            <span className="text-violet-300">{view.room.host.username}</span>
            <span className="text-faint">·</span>
            <span>{view.room.livekitRoomName}</span>
            <span className="text-faint">·</span>
            {categoryBadge(view.room.category)}
            <Badge tone="slate">{view.room.type}</Badge>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button icon={<IconRefresh className="h-4 w-4" />} onClick={() => void load()}>
            Reload
          </Button>
          {!closed && (
            <Button
              variant="danger"
              icon={<IconBan className="h-4 w-4" />}
              loading={busy === 'close'}
              onClick={() => void run('close', () => api.closeRoom(view.room.id), 'Room force-closed.')}
            >
              Force close
            </Button>
          )}
        </div>
      </header>

      {error !== null && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
          <IconAlert className="h-4 w-4 shrink-0" />
          {error}
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-3">
        <div className="space-y-5 xl:col-span-2">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <StatCard label="Listeners" value={formatCompact(view.listenerCount)} tone="sky" icon={<IconUsers className="h-5 w-5" />} />
            <StatCard
              label="Seats live"
              value={`${view.metrics.liveSeats}/${view.room.seatCapacity}`}
              sub={`${view.metrics.mutedSeats} muted`}
              tone="violet"
              icon={<IconMic className="h-5 w-5" />}
            />
            <StatCard
              label="In the SFU"
              value={view.metrics.sfuParticipants === null ? '—' : formatCompact(view.metrics.sfuParticipants)}
              sub={view.metrics.sfuParticipants === null ? 'LiveKit API unreachable' : 'LiveKit participant count'}
              tone="emerald"
              icon={<IconShieldCheck className="h-5 w-5" />}
            />
            <StatCard
              label="Chat / 5 min"
              value={formatCompact(view.metrics.chatLast5m)}
              sub={`${handRaiseIds.size} hand${handRaiseIds.size === 1 ? '' : 's'} raised`}
              tone="amber"
              icon={<IconGift className="h-5 w-5" />}
            />
            <StatCard
              label="Gifts today"
              value={formatCompact(view.metrics.giftsToday)}
              sub={`${formatDiamonds(view.metrics.diamondsToday)} diamonds`}
              tone="fuchsia"
              icon={<IconDiamond className="h-5 w-5" />}
            />
            <StatCard
              label="R-coins today"
              value={formatRCoin(view.metrics.rCoinsToday)}
              sub={`all-time ${formatRCoin(view.room.totalGiftValue)}`}
              tone="fuchsia"
            />
            <StatCard
              label="Top sender"
              value={view.metrics.topSender === null ? '—' : view.metrics.topSender.username}
              sub={view.metrics.topSender === null ? 'no gifts yet today' : formatDiamonds(view.metrics.topSender.diamonds)}
              tone="violet"
            />
            <StatCard label="Audience" value={formatCompact(view.metrics.audienceCount)} tone="sky" />
          </div>

          <Card
            title="Seats"
            subtitle="Mute stops the audio at the SFU, so it works even on a client that ignores the flag."
            actions={
              <>
                <Button
                  size="sm"
                  loading={busy === 'mute-on'}
                  onClick={() =>
                    void run(
                      'mute-on',
                      () => api.muteAllSeats(view.room.id, true),
                      'Every open microphone was muted.',
                    )
                  }
                >
                  Mute all
                </Button>
                <Button
                  size="sm"
                  loading={busy === 'mute-off'}
                  onClick={() =>
                    void run(
                      'mute-off',
                      () => api.muteAllSeats(view.room.id, false),
                      'All seats were unmuted.',
                    )
                  }
                >
                  Unmute all
                </Button>
              </>
            }
          >
            <ul className="grid gap-2 sm:grid-cols-2">
              {seats.map((seat) => (
                <SeatRow
                  key={seat.seatIndex}
                  seat={seat}
                  handRaised={seat.user !== null && handRaiseIds.has(seat.user.id)}
                  busy={busy !== null}
                  onMute={(muted) =>
                    void run(
                      `seat-${seat.seatIndex}`,
                      async () => {
                        const result = await api.muteSeat(view.room.id, seat.seatIndex, muted);
                        setView((current) => (current === null ? current : { ...current, seats: result.seats }));
                      },
                      muted ? 'Seat muted.' : 'Seat unmuted.',
                    )
                  }
                  onLock={(locked) =>
                    void run(
                      `lock-${seat.seatIndex}`,
                      async () => {
                        const result = await api.lockSeat(view.room.id, seat.seatIndex, locked);
                        setView((current) => (current === null ? current : { ...current, seats: result.seats }));
                      },
                      locked ? 'Seat locked.' : 'Seat unlocked.',
                    )
                  }
                  onDisconnect={() =>
                    void run(
                      `disc-${seat.seatIndex}`,
                      () => (seat.user ? api.disconnectRoomUser(view.room.id, seat.user.id) : Promise.resolve({ ok: true })),
                      'Seat cleared and the member was disconnected.',
                    )
                  }
                  onBan={() => {
                    if (seat.user === null) return;
                    setBanTarget({ userId: seat.user.id, username: seat.user.username });
                  }}
                />
              ))}
            </ul>
          </Card>

          <Card title="Audience" subtitle={`${view.audience.length} listener rows in the room`}>
            {view.audience.length === 0 ? (
              <p className="rounded-lg border border-dashed border-edge/60 px-3 py-3 text-xs text-faint">
                Nobody is listening without a seat right now.
              </p>
            ) : (
              <ul className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
                {view.audience.map((occupant) => (
                  <li
                    key={occupant.userId}
                    className="flex items-center gap-2.5 rounded-lg border border-edge/50 bg-elevated/40 px-3 py-2"
                  >
                    <Avatar name={occupant.username} src={occupant.avatarUrl} size="xs" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-ink">
                        {occupant.username}
                        {handRaiseIds.has(occupant.userId) && (
                          <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">
                            raised
                          </span>
                        )}
                      </p>
                      <p className="text-[11px] text-faint">{occupant.role}</p>
                    </div>
                    <IconButton
                      label={`Disconnect ${occupant.username}`}
                      tone="danger"
                      onClick={() =>
                        void run(
                          `disc-${occupant.userId}`,
                          () => api.disconnectRoomUser(view.room.id, occupant.userId),
                          `${occupant.username} disconnected.`,
                        )
                      }
                    >
                      <IconPlugUnplug className="h-4 w-4" />
                    </IconButton>
                    <Button size="sm" variant="ghost" onClick={() => setBanTarget(occupant)}>
                      Ban
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <ChatFeed roomTitle={view.room.title} chat={view.chat} />
        </div>

        <div className="space-y-5">
          <ThemePicker
            roomId={view.room.id}
            current={view.room.theme}
            busy={busy !== null}
            onApplied={(theme) =>
              setView((state) => (state === null ? state : { ...state, room: { ...state.room, theme } }))
            }
          />
          <ModeratorMessage roomId={view.room.id} closed={closed} />
          <WarnHost roomId={view.room.id} host={view.room.host.username} />
          <BannedList roomId={view.room.id} bans={view.bans} />
        </div>
      </div>

      {banTarget !== null && (
        <BanModal
          roomId={view.room.id}
          target={banTarget}
          onClose={() => setBanTarget(null)}
          onBanned={() => {
            setBanTarget(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One seat: mic + lock toggles, disconnect and ban.
// ---------------------------------------------------------------------------
interface SeatRowProps {
  seat: RoomSeatDetail;
  handRaised: boolean;
  busy: boolean;
  onMute: (muted: boolean) => void;
  onLock: (locked: boolean) => void;
  onDisconnect: () => void;
  onBan: () => void;
}

function SeatRow({ seat, handRaised, busy, onMute, onLock, onDisconnect, onBan }: SeatRowProps) {
  const locked = seat.status === 'LOCKED';
  return (
    <li className="flex items-center gap-2.5 rounded-lg border border-edge/50 bg-elevated/40 px-3 py-2">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-surface text-[11px] font-bold tabular-nums text-faint">
        {seat.seatIndex}
      </span>
      {seat.user === null ? (
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-faint">{locked ? 'Locked by moderation' : 'Empty seat'}</p>
        </div>
      ) : (
        <>
          <Avatar name={seat.user.username} src={seat.user.avatarUrl} size="xs" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-ink">
              {seat.user.username}
              {handRaised && (
                <span className="ml-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300">raised</span>
              )}
            </p>
            <p className="text-[11px] text-faint">
              {seat.isSpeaker ? 'Speaker' : 'Seated'} · {seat.isMuted ? 'muted' : 'live mic'}
            </p>
          </div>
          <Button
            size="sm"
            variant={seat.isMuted ? 'success' : 'ghost'}
            disabled={busy}
            icon={<IconMic className="h-3.5 w-3.5" />}
            onClick={() => onMute(!seat.isMuted)}
          >
            {seat.isMuted ? 'Unmute' : 'Mute'}
          </Button>
          <IconButton label={`Disconnect from seat ${seat.seatIndex}`} tone="danger" onClick={onDisconnect}>
            <IconPlugUnplug className="h-4 w-4" />
          </IconButton>
          <Button size="sm" variant="ghost" onClick={onBan}>
            Ban
          </Button>
        </>
      )}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onLock(!locked)}>
        {locked ? 'Unlock' : 'Lock'}
      </Button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Live chat. New lines append from the socket; the feed sticks to the bottom
// unless the operator has scrolled up to read something.
// ---------------------------------------------------------------------------
function ChatFeed({ roomTitle, chat }: { roomTitle: string; chat: RoomChatMessage[] }) {
  const listRef = useRef<HTMLUListElement>(null);
  const [stick, setStick] = useState(true);

  useEffect(() => {
    if (!stick) return;
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [chat.length, stick]);

  return (
    <Card
      title="Live chat"
      subtitle={`${chat.length} recent messages in “${roomTitle}”`}
      actions={
        <Button size="sm" variant={stick ? 'primary' : 'secondary'} onClick={() => setStick((s) => !s)}>
          {stick ? 'Auto-scroll on' : 'Auto-scroll off'}
        </Button>
      }
      bodyClassName="p-0"
    >
      <ul
        ref={listRef}
        onScroll={(event) => {
          const node = event.currentTarget;
          setStick(node.scrollHeight - node.scrollTop - node.clientHeight < 40);
        }}
        className="max-h-[420px] min-h-[220px] space-y-1 overflow-y-auto px-4 py-3 text-sm"
      >
        {chat.map((message) => (
          <li key={message.id} className="flex items-start gap-2 leading-snug">
            <span className="mt-0.5 shrink-0 text-[11px] tabular-nums text-faint">
              {new Date(message.createdAt).toLocaleTimeString()}
            </span>
            {message.type === 'GIFT' && <IconGift className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fuchsia-300" />}
            {message.user === null ? (
              <span className="text-cyan-200">{message.content}</span>
            ) : (
              <span className="min-w-0 text-muted">
                <span className="font-semibold text-ink">{message.user.username}: </span>
                <span className="break-words">{message.content}</span>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Room look: the theme a host's clients paint behind the seat grid, plus a
// preview of the entry animation that ships with it.
// ---------------------------------------------------------------------------
interface ThemePickerProps {
  roomId: string;
  current: string;
  busy: boolean;
  onApplied: (theme: string) => void;
}

function ThemePicker({ roomId, current, busy, onApplied }: ThemePickerProps) {
  const toast = useToast();
  const [catalogue, setCatalogue] = useState<ThemeCatalogue | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .themeCatalogue()
      .then((result) => {
        if (!cancelled) setCatalogue(result);
      })
      .catch(() => {
        if (!cancelled) setUnavailable(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = async (slug: string, name: string) => {
    if (slug === current || pending !== null) return;
    setPending(slug);
    try {
      await api.setRoomTheme(roomId, slug);
      onApplied(slug);
      toast.success(`${name} is now this room's look.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'That theme could not be applied.');
    } finally {
      setPending(null);
    }
  };

  if (unavailable) {
    return (
      <Card title="Room look" subtitle="Theme catalogue unavailable.">
        <p className="text-xs text-muted">
          The backend did not return <code>/api/rooms/themes</code>. Regenerate the asset pack with{' '}
          <code>npm run assets:generate</code>.
        </p>
      </Card>
    );
  }

  if (catalogue === null) {
    return (
      <Card title="Room look">
        <div className="grid h-24 place-items-center text-violet-300">
          <Spinner className="h-5 w-5" />
        </div>
      </Card>
    );
  }

  return (
    <Card
      title="Room look"
      subtitle="Everyone in the room switches wallpaper the moment this changes."
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {catalogue.themes.map((theme) => {
          const active = theme.slug === current;
          return (
            <button
              key={theme.slug}
              type="button"
              disabled={busy || pending !== null}
              onClick={() => void apply(theme.slug, theme.name)}
              className={`focus-ring rounded-lg border p-1.5 text-left transition disabled:opacity-60 ${
                active ? 'border-violet-400 bg-violet-500/10' : 'border-white/10 hover:border-white/25'
              }`}
            >
              <img
                src={assetUrl(theme.wallpaper)}
                alt={`${theme.name} wallpaper`}
                className="h-24 w-full rounded object-cover"
                loading="lazy"
              />
              <span className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-ink">
                <span className="truncate">{theme.name}</span>
                {active && <span className="ml-auto text-violet-300">•</span>}
              </span>
              {pending === theme.slug && <span className="text-[10px] text-muted">applying…</span>}
            </button>
          );
        })}
      </div>
      <div className="mt-3 flex items-end gap-3 border-t border-white/5 pt-3">
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Entry effect</p>
          <LottiePreview src={catalogue.welcome} size={84} loop={false} />
        </div>
        <div>
          <p className="text-[10px] uppercase tracking-wide text-muted">Ambient loop</p>
          <LottiePreview src={catalogue.effects[0]} size={84} />
        </div>
        <p className="ml-auto max-w-[10rem] text-[10px] leading-relaxed text-muted">
          Current: <span className="font-semibold text-ink">{current}</span>
        </p>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Moderator announcement — posts into the room's chat as an attributed SYSTEM line.
// ---------------------------------------------------------------------------
function ModeratorMessage({ roomId, closed }: { roomId: string; closed: boolean }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);

  const send = async () => {
    const message = text.trim();
    if (message.length === 0 || pending) return;
    setPending(true);
    try {
      await api.sendRoomMessage(roomId, message);
      setText('');
      toast.success('Announcement posted to the room.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Announcement failed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card title="Announcement" subtitle="Appears in the room chat as “Moderator <you>”.">
      <div className="space-y-2">
        <Input
          value={text}
          maxLength={300}
          disabled={closed}
          placeholder="e.g. Keep the room friendly — no spam"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void send();
          }}
          aria-label="Announcement text"
        />
        <Button
          variant="primary"
          className="w-full"
          loading={pending}
          disabled={closed || text.trim().length === 0}
          onClick={() => void send()}
        >
          Post to room
        </Button>
      </div>
    </Card>
  );
}

function WarnHost({ roomId, host }: { roomId: string; host: string }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);

  const send = async () => {
    const message = text.trim();
    if (message.length === 0 || pending) return;
    setPending(true);
    try {
      await api.warnRoomHost(roomId, message);
      setText('');
      toast.success(`Warning delivered to ${host}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Warning failed.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Card title="Warn the host" subtitle="Private push to the host device — not visible to the room.">
      <div className="space-y-2">
        <Input
          value={text}
          maxLength={300}
          placeholder={`Message for ${host}`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void send();
          }}
          aria-label="Warning text"
        />
        <Button className="w-full" loading={pending} disabled={text.trim().length === 0} onClick={() => void send()}>
          Send warning
        </Button>
      </div>
    </Card>
  );
}

function BannedList({ roomId, bans }: { roomId: string; bans: RoomBan[] }) {
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);

  const lift = async (userId: string) => {
    if (pending !== null) return;
    setPending(userId);
    try {
      await api.liftRoomBan(roomId, userId);
      toast.success('Ban lifted.');
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not lift the ban.');
    } finally {
      setPending(null);
    }
  };

  return (
    <Card title="Room bans" subtitle="Blocks re-entry to this room only, not the platform.">
      {bans.length === 0 ? (
        <p className="rounded-lg border border-dashed border-edge/60 px-3 py-3 text-xs text-faint">
          Nobody is banned from this room.
        </p>
      ) : (
        <ul className="space-y-2">
          {bans.map((ban) => (
            <li key={ban.userId} className="flex items-center gap-2 rounded-lg border border-edge/50 bg-elevated/40 px-3 py-2">
              <Avatar name={ban.username} size="xs" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">{ban.username}</p>
                <p className="truncate text-[11px] text-faint">
                  {ban.expiresAt === null ? 'permanent' : `until ${relativeTime(ban.expiresAt)}`}
                  {ban.reason ? ` · ${ban.reason}` : ''}
                </p>
              </div>
              <Button size="sm" variant="ghost" loading={pending === ban.userId} onClick={() => void lift(ban.userId)}>
                Lift
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function BanModal({
  roomId,
  target,
  onClose,
  onBanned,
}: {
  roomId: string;
  target: { userId: string; username: string };
  onClose: () => void;
  onBanned: () => void;
}) {
  const toast = useToast();
  const [minutes, setMinutes] = useState('60');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (pending) return;
    setPending(true);
    try {
      await api.banRoomUser(roomId, target.userId, {
        minutes: minutes.length > 0 ? Number(minutes) : undefined,
        reason: reason.trim().length > 0 ? reason.trim() : undefined,
      });
      toast.success(`${target.username} banned and removed from the room.`);
      onBanned();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Ban failed.');
      setPending(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Ban ${target.username}?`}
      subtitle="Disconnects them now and blocks re-entry to this room."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={pending} onClick={() => void submit()}>
            Ban from room
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Select label="Duration" value={minutes} onChange={(event) => setMinutes(event.target.value)}>
          {BAN_DURATIONS.map((option) => (
            <option key={option.label} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <Input
          label="Reason (optional, shown to the operator)"
          value={reason}
          maxLength={200}
          onChange={(event) => setReason(event.target.value)}
          placeholder="Spam, abuse, …"
        />
      </div>
    </Modal>
  );
}
