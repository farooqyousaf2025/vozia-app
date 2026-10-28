// ---------------------------------------------------------------------------
// Media library: the files behind gift icons, gift animations, gift sounds,
// room effects, room wallpapers and rank badges. Upload puts art on the
// server, a catalogue row points at it, and this is where a retired file gets
// deleted.
// ---------------------------------------------------------------------------
import { useCallback, useEffect, useState } from 'react';
import { Badge, type BadgeTone } from '../components/ui/Badge';
import { Button, IconButton } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { LottiePreview } from '../components/ui/LottiePreview';
import { Modal } from '../components/ui/Modal';
import { Pagination } from '../components/ui/Pagination';
import { Spinner } from '../components/ui/Spinner';
import { Tabs } from '../components/ui/Tabs';
import { UploadField } from '../components/ui/UploadField';
import { IconAlert, IconCopy, IconEye, IconImage, IconRefresh, IconTrash } from '../components/ui/Icons';
import { useToast } from '../components/ui/Toast';
import { ApiError, api, assetUrl } from '../lib/api';
import { formatBytes, relativeTime } from '../lib/format';
import { MEDIA_KIND_META, MEDIA_KINDS } from '../lib/media';
import type { MediaAsset, MediaKind } from '../types';

const PAGE_LIMIT = 24;

const KIND_TONES: Record<MediaKind, BadgeTone> = {
  GIFT_ICON: 'pink',
  GIFT_ANIMATION: 'fuchsia',
  GIFT_SOUND: 'sky',
  EFFECT: 'violet',
  BADGE: 'amber',
  WALLPAPER: 'green',
  EMOJI: 'slate',
};

export default function MediaPage() {
  const toast = useToast();
  const [assets, setAssets] = useState<MediaAsset[] | null>(null);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState<string>('ALL');
  const [page, setPage] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<MediaAsset | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.listUploads({
        kind: kind === 'ALL' ? undefined : (kind as MediaKind),
        limit: PAGE_LIMIT,
        offset: (page - 1) * PAGE_LIMIT,
      });
      setAssets(result.assets);
      setTotal(result.total);
    } catch (err) {
      setAssets([]);
      setTotal(0);
      setError(err instanceof ApiError ? err.message : 'Failed to load the media library.');
    } finally {
      setLoading(false);
    }
  }, [kind, page, reloadKey]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => setReloadKey((key) => key + 1);

  const copyPath = async (asset: MediaAsset) => {
    try {
      await navigator.clipboard.writeText(asset.url);
      toast.success(`Copied ${asset.url}`);
    } catch {
      toast.error('The browser refused clipboard access — select the path and copy it manually.');
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-ink">Media library</h1>
          <p className="mt-0.5 text-sm text-muted">
            Every file an operator has uploaded. A gift points at one of these paths, so the art
            can be swapped without rebuilding the app.
          </p>
        </div>
        <Button icon={<IconRefresh className="h-4 w-4" />} onClick={refresh}>
          Refresh
        </Button>
      </div>

      <Card
        title="Upload art"
        subtitle="The server names the stored file after a UUID and works out the real type from its bytes, so a renamed file is refused rather than served."
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          {MEDIA_KINDS.map((each) => (
            <div key={each} className="space-y-2.5 rounded-xl border border-edge/60 bg-elevated/40 p-3">
              <p className="text-xs font-semibold text-ink">{MEDIA_KIND_META[each].label}</p>
              <UploadField
                kind={each}
                onUploaded={(asset, duplicate) => {
                  toast.success(
                    duplicate
                      ? `“${asset.fileName}” was already in the library — no second file was written.`
                      : `“${asset.fileName}” uploaded (${formatBytes(asset.byteSize)}).`,
                  );
                  if (!duplicate) refresh();
                }}
                onError={(message) => toast.error(message)}
              />
              <p className="text-[11px] leading-relaxed text-faint">{MEDIA_KIND_META[each].hint}</p>
            </div>
          ))}
        </div>
      </Card>

      <Tabs
        items={[{ id: 'ALL', label: 'All' }, ...MEDIA_KINDS.map((each) => ({ id: each, label: MEDIA_KIND_META[each].label }))]}
        active={kind}
        onChange={(id) => {
          setKind(id);
          setPage(1);
        }}
      />

      {loading && assets === null ? (
        <div className="grid h-64 place-items-center text-violet-300">
          <Spinner className="h-8 w-8" />
        </div>
      ) : error !== null ? (
        <div className="panel flex items-center gap-3 border-rose-500/40 p-4 text-sm text-rose-200">
          <IconAlert className="h-5 w-5 shrink-0" />
          <span className="flex-1">{error}</span>
          <Button size="sm" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : (assets ?? []).length === 0 ? (
        <Card bodyClassName="p-0">
          <EmptyState
            title={kind === 'ALL' ? 'Nothing uploaded yet' : `No ${MEDIA_KIND_META[kind as MediaKind].label.toLowerCase()} files yet`}
            message="Files uploaded here are served by the API and loaded by URL on the phone, so new art shows up without an app update."
            icon={<IconImage className="h-6 w-6" />}
          />
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {(assets ?? []).map((asset) => (
              <Card key={asset.id} className="flex flex-col gap-3">
                <div className="flex items-start gap-3">
                  <AssetPreview asset={asset} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-ink" title={asset.fileName}>
                      {asset.fileName}
                    </p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge tone={KIND_TONES[asset.kind]}>{MEDIA_KIND_META[asset.kind].label}</Badge>
                      <span className="text-[11px] text-faint">{formatBytes(asset.byteSize)}</span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-faint">
                      {asset.width !== null && asset.height !== null ? `${asset.width}×${asset.height} · ` : ''}
                      {asset.contentType} · {relativeTime(asset.createdAt)}
                    </p>
                  </div>
                </div>

                <p
                  className="truncate rounded-lg bg-elevated/60 px-2 py-1.5 font-mono text-[11px] text-muted"
                  title={asset.url}
                >
                  {asset.url}
                </p>

                <div className="mt-auto flex items-center justify-between border-t border-edge/50 pt-2.5">
                  <div className="flex items-center gap-1">
                    <IconButton label={`Copy the path of ${asset.fileName}`} onClick={() => void copyPath(asset)}>
                      <IconCopy className="h-4 w-4" />
                    </IconButton>
                    <IconButton label={`Open ${asset.fileName} in a new tab`}>
                      <a
                        href={assetUrl(asset.url)}
                        target="_blank"
                        rel="noreferrer"
                        className="grid h-full w-full place-items-center"
                        aria-label={`Open ${asset.fileName} in a new tab`}
                      >
                        <IconEye className="h-4 w-4" />
                      </a>
                    </IconButton>
                  </div>
                  <IconButton
                    label={`Delete ${asset.fileName}`}
                    tone="danger"
                    onClick={() => setDeleteTarget(asset)}
                  >
                    <IconTrash className="h-4 w-4" />
                  </IconButton>
                </div>
              </Card>
            ))}
          </div>
          <Pagination page={page} limit={PAGE_LIMIT} total={total} onChange={setPage} />
        </>
      )}

      {deleteTarget !== null && (
        <DeleteAssetModal
          asset={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={() => {
            setDeleteTarget(null);
            toast.success(`“${deleteTarget.fileName}” deleted.`);
            refresh();
          }}
        />
      )}
    </div>
  );
}

function AssetPreview({ asset }: { asset: MediaAsset }) {
  const resolved = assetUrl(asset.url);
  if (asset.contentType.startsWith('image/')) {
    return (
      <span className="grid h-14 w-14 shrink-0 place-items-center overflow-hidden rounded-xl border border-edge/60 bg-elevated">
        <img src={resolved} alt="" loading="lazy" className="h-full w-full object-contain" />
      </span>
    );
  }
  if (asset.kind === 'GIFT_ANIMATION' || asset.kind === 'EFFECT') {
    return <LottiePreview src={asset.url} size={56} className="shrink-0 rounded-xl border border-edge/60 bg-elevated" fallback="still" />;
  }
  if (asset.contentType.startsWith('audio/')) {
    return <audio controls preload="none" src={resolved} className="h-10 min-w-0 flex-1" />;
  }
  return (
    <span className="grid h-14 w-14 shrink-0 place-items-center rounded-xl border border-edge/60 bg-elevated text-[10px] uppercase text-faint">
      file
    </span>
  );
}

interface DeleteAssetModalProps {
  asset: MediaAsset;
  onClose: () => void;
  onDeleted: () => void;
}

function DeleteAssetModal({ asset, onClose, onDeleted }: DeleteAssetModalProps) {
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setServerError(null);
    try {
      await api.deleteUpload(asset.id);
      onDeleted();
    } catch (err) {
      setServerError(err instanceof ApiError ? err.message : 'Delete failed.');
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title={`Delete “${asset.fileName}”?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} loading={submitting}>
            Delete file
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-muted">
        <p>
          This erases <span className="font-semibold text-ink">{asset.url}</span> from the server and
          from the library. The deletion is recorded in the audit log; the bytes are not recoverable.
        </p>
        <p className="text-xs text-faint">
          A gift, effect or badge that still points at this file makes the server refuse with
          “still used as …” — move those rows onto another file first.
        </p>
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
