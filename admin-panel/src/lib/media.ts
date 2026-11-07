// ---------------------------------------------------------------------------
// Everything the panel needs to know about the media store, in one place.
// The caps mirror POLICY in backend/src/services/media.service.ts. The server
// re-checks all of it — magic bytes, size, kind — so this copy exists only to
// let the OS picker grey out what a slot rejects and to refuse an oversized
// file before the upload round-trips.
// ---------------------------------------------------------------------------
import type { MediaKind } from '../types';

export const MEDIA_KINDS: readonly MediaKind[] = [
  'GIFT_ICON',
  'GIFT_ANIMATION',
  'GIFT_SOUND',
  'EFFECT',
  'RIDE',
  'BANNER',
  'BADGE',
  'WALLPAPER',
  'EMOJI',
];

export interface MediaKindMeta {
  label: string;
  /** Passed to the file input's `accept`. Extensions are included because browsers report
   *  `application/octet-stream` for a hand-authored Lottie JSON file. */
  accept: string;
  maxBytes: number;
  hint: string;
}

export const MEDIA_KIND_META: Record<MediaKind, MediaKindMeta> = {
  GIFT_ICON: {
    label: 'Gift icon',
    accept: '.png,.webp,.gif,.jpg,.jpeg,image/png,image/webp,image/gif,image/jpeg',
    maxBytes: 2 * 1024 * 1024,
    hint: 'PNG, WebP, GIF or JPEG · up to 2 MB',
  },
  GIFT_ANIMATION: {
    label: 'Gift animation',
    accept: '.json,.svga,.mp4,application/json,video/mp4,application/octet-stream',
    // Three containers, three budgets: the server caps a Lottie scene at 2 MB and an SVGA or MP4
    // at 8 MB, so the picker only refuses what is oversized for the format it can identify.
    maxBytes: 8 * 1024 * 1024,
    hint: 'Lottie JSON up to 2 MB · SVGA or MP4 up to 8 MB · the renderer is chosen by the gift’s animation format',
  },
  GIFT_SOUND: {
    label: 'Gift sound',
    accept: '.wav,.mp3,.m4a,audio/wav,audio/mpeg,audio/mp4',
    maxBytes: 2 * 1024 * 1024,
    hint: 'WAV, MP3 or M4A · up to 2 MB',
  },
  EFFECT: {
    label: 'Room effect',
    accept: '.json,application/json',
    maxBytes: 3 * 1024 * 1024,
    hint: 'Lottie JSON · up to 3 MB',
  },
  RIDE: {
    label: 'Entrance ride',
    accept: '.json,.svga,.mp4,application/json,video/mp4,application/octet-stream',
    // Three containers, three budgets, exactly as with a gift animation: the server caps a Lottie
    // scene at 3 MB and an SVGA or MP4 at 8 MB, so the picker only refuses what is oversized for the
    // format it can identify. The ride row's `format` is what tells the phone which renderer opens it.
    maxBytes: 8 * 1024 * 1024,
    hint: 'Lottie JSON up to 3 MB · SVGA or MP4 up to 8 MB · set the ride’s format to match the file',
  },
  // The server's BANNER budgets sit under the gift slots' on purpose: a splash image arrives on a
  // cold start, on whatever network a member happens to have, whether or not they asked for it.
  // The picker takes the loosest of those (6 MB, the SVGA/MP4 ceiling) so a static cut is never
  // refused here for a size the server would accept.
  BANNER: {
    label: 'Promotional banner',
    accept: '.png,.webp,.gif,.jpg,.jpeg,.json,.svga,.mp4,application/json,video/mp4,application/octet-stream',
    maxBytes: 6 * 1024 * 1024,
    hint: 'Image up to 3 MB · Lottie up to 2 MB · SVGA or MP4 up to 6 MB · set the banner’s format to match the file',
  },
  BADGE: {
    label: 'Rank badge',
    accept: '.png,.webp,.gif,image/png,image/webp,image/gif',
    maxBytes: 512 * 1024,
    hint: 'PNG, WebP or GIF · up to 512 KB',
  },
  WALLPAPER: {
    label: 'Room wallpaper',
    accept: '.png,.webp,.gif,.jpg,.jpeg,image/png,image/webp,image/gif,image/jpeg',
    maxBytes: 3 * 1024 * 1024,
    hint: 'PNG, WebP, GIF or JPEG · up to 3 MB · portrait art works best',
  },
  EMOJI: {
    label: 'Chat emoji',
    accept: '.png,.webp,.gif,image/png,image/webp,image/gif',
    maxBytes: 256 * 1024,
    hint: 'PNG, WebP or GIF · up to 256 KB · a picker loads dozens of these at once',
  },
};

/**
 * Read a picked file as plain base64 (the `data:` prefix the browser adds is stripped; the
 * backend tolerates it either way).
 */
export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name} from disk.`));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`Could not read ${file.name} from disk.`));
        return;
      }
      const comma = reader.result.indexOf(',');
      resolve(comma >= 0 ? reader.result.slice(comma + 1) : reader.result);
    };
    reader.readAsDataURL(file);
  });
}
