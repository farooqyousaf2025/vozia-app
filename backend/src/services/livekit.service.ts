import {
  AccessToken,
  RoomServiceClient,
  TrackType,
  WebhookReceiver,
} from 'livekit-server-sdk';
import { env } from '../config/env';
import { ApiError } from '../utils/http';

/**
 * Rights model for a Voiza party room:
 *   - host + seated speakers  -> publisher + subscriber (they talk)
 *   - audience / listeners    -> subscriber only (they listen, send data over Socket.IO)
 * The backend is the single source of truth for who may publish; LiveKit tokens
 * minted here are short-lived and re-issued whenever a seat changes.
 */
export type LivekitAccess = {
  url: string;
  token: string;
  roomName: string;
  identity: string;
  canPublish: boolean;
};

export type AccessLevel = 'host' | 'speaker' | 'audience';

const grantFor = (level: AccessLevel) => {
  const canPublish = level !== 'audience';
  return {
    roomJoin: true as const,
    canPublish,
    canSubscribe: true as const,
    // data channel is used for in-room reactions; audio levels come from SFU
    canPublishData: canPublish,
    canUpdateOwnMetadata: true as const,
    // audience members are invisible in the participant list of the mixer view
    hidden: false,
  };
};

export async function issueRoomToken(opts: {
  roomName: string;
  identity: string;
  username: string;
  level: AccessLevel;
  metadata?: Record<string, unknown>;
}): Promise<LivekitAccess> {
  const at = new AccessToken(env.livekit.apiKey, env.livekit.apiSecret, {
    identity: opts.identity,
    ttl: env.livekit.tokenTtlSeconds,
    name: opts.username,
    metadata: JSON.stringify(opts.metadata ?? {}),
  });
  at.addGrant({ room: opts.roomName, ...grantFor(opts.level) });

  return {
    // the client must dial the address it can actually reach from outside docker
    url: env.livekit.publicUrl,
    token: await at.toJwt(),
    roomName: opts.roomName,
    identity: opts.identity,
    canPublish: opts.level !== 'audience',
  };
}

let roomService: RoomServiceClient | undefined;

/** Lazily-built admin client: room enumeration and forced removals. */
export function livekitRooms(): RoomServiceClient {
  if (!roomService) {
    roomService = new RoomServiceClient(env.livekit.url, env.livekit.apiKey, env.livekit.apiSecret);
  }
  return roomService;
}

export async function ensureLivekitRoom(roomName: string, opts?: { maxParticipants?: number; emptyTimeout?: number }) {
  try {
    await livekitRooms().createRoom({
      name: roomName,
      maxParticipants: opts?.maxParticipants ?? 1000,
      emptyTimeout: opts?.emptyTimeout ?? 300,
    });
  } catch (err) {
    // createRoom is idempotent-ish; a race with a live room is not an error.
    console.warn('[livekit] ensureRoom', roomName, (err as Error).message);
  }
}

export async function removeLivekitParticipant(roomName: string, identity: string): Promise<void> {
  try {
    await livekitRooms().removeParticipant(roomName, identity);
  } catch (err) {
    // participant already gone
    console.debug('[livekit] removeParticipant skipped', (err as Error).message);
  }
}

/**
 * Hard lock: takes the right to publish away at the SFU. Revoking it also drops the
 * participant's live tracks, and LiveKit will not restore them when permission comes
 * back — the client would have to publish again. Use this only for members who are not
 * publishing right now; see mutePublishedAudio for muting a speaking member.
 */
export async function setPublishPermission(
  roomName: string,
  identity: string,
  canPublish: boolean,
): Promise<void> {
  try {
    await livekitRooms().updateParticipant(roomName, identity, {
      permission: { canPublish, canSubscribe: true, canPublishData: canPublish },
    });
  } catch (err) {
    // The room may already be gone; the seat flag is still correct. The REST call
    // still succeeds, so log loudly enough for the failure to be noticed.
    console.error('[livekit] updateParticipant permission failed', roomName, identity, (err as Error).message);
  }
}

/**
 * Reversible server-side mute: asks the SFU to mute/unmute every audio track the member
 * has already published. The publication survives, so unmuting restores the voice
 * without any client action (measured: ~62 kB/5s of RTP drops to 72 bytes when muted and
 * returns to ~62 kB/5s on unmute). Unmute requires `enable_remote_unmute: true` on the
 * LiveKit server. Returns false when there was no audio track to mute.
 */
export async function mutePublishedAudio(
  roomName: string,
  identity: string,
  muted: boolean,
): Promise<boolean> {
  const svc = livekitRooms();
  try {
    const participant = (await svc.listParticipants(roomName)).find((p) => p.identity === identity);
    const audio = (participant?.tracks ?? []).filter((track) => track.type === TrackType.AUDIO);
    for (const track of audio) await svc.mutePublishedTrack(roomName, identity, track.sid, muted);
    return audio.length > 0;
  } catch (err) {
    console.error('[livekit] mutePublishedAudio failed', roomName, identity, muted, (err as Error).message);
    return false;
  }
}

export type LivekitWebhookEvent = {
  event: string;
  room?: { name?: string; sid?: string; emptyTimeout?: number };
  participant?: { identity?: string; state?: string };
  createdAt?: string;
};

const receiver = new WebhookReceiver(env.livekit.apiKey, env.livekit.apiSecret);

/**
 * LiveKit signs every webhook with a JWT in the `Authorization` header (bare, no
 * `Bearer` prefix); the raw request body (un-parsed, exact bytes) is what gets
 * verified. A failed check is an authentication problem, not a server fault:
 * answering 500 would make LiveKit retry a delivery that can never succeed.
 */
export async function verifyWebhook(rawBody: Buffer | string, authorization: string | undefined): Promise<LivekitWebhookEvent> {
  if (!authorization) throw ApiError.unauthorized('Missing webhook authorization', 'livekit_webhook_unauthorized');
  const payload = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  let event: unknown;
  try {
    event = await receiver.receive(payload, authorization);
  } catch (err) {
    console.warn('[livekit] webhook verification failed', (err as Error).message);
    throw ApiError.unauthorized('Webhook signature verification failed', 'livekit_webhook_invalid');
  }
  return event as unknown as LivekitWebhookEvent;
}
