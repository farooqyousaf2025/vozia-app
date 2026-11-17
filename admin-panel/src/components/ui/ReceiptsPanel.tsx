// ---------------------------------------------------------------------------
// The bank slips a coin seller uploaded for one money record (§22, migration 0041).
//
// Money between a member and a seller moves outside this platform's rails, so the only thing a
// reviewer can judge a claim on is the document itself. Two rules shape this component:
//
//   - There is no URL. Receipts do not live in the publicly served uploads directory, so a slip can
//     only be fetched with the operator's own token. That is why opening one is a button that reads
//     bytes, and not an `img src` the page could have built on its own.
//   - A slip is evidence, not a trigger. Whatever is shown here, the credits still happen on the
//     Approve button, so the panel never says a document was "verified" by the system.
//
// Used from both queues: the recharge order a seller claims to have paid, and the payout the seller
// is asked to hand over in cash.
// ---------------------------------------------------------------------------
import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../../lib/api';
import { formatBytes, formatDateTime, relativeTime } from '../../lib/format';
import type { PaymentReceipt } from '../../types';
import { IconAlert, IconEye, IconImage } from './Icons';
import { Spinner } from './Spinner';

export type ReceiptQueue = 'order' | 'withdrawal';

/** The list route and the raw route per queue — they are guarded by different permissions. */
const QUEUES: Record<ReceiptQueue, { list: (id: string) => Promise<{ receipts: PaymentReceipt[] }>; raw: (id: string) => string }> = {
  order: {
    list: (id) => api.orderReceipts(id),
    raw: (id) => `/api/admin/business/receipts/${encodeURIComponent(id)}/raw`,
  },
  withdrawal: {
    list: (id) => api.withdrawalReceipts(id),
    raw: (id) => `/api/admin/withdrawals/receipts/${encodeURIComponent(id)}/raw`,
  },
};

interface ReceiptsPanelProps {
  queue: ReceiptQueue;
  /** The order or payout the documents belong to. */
  recordId: string;
  /** The capability that opens bytes (`recharge:review` / `withdrawal:review`). Listing does not need it. */
  canOpen: boolean;
}

export function ReceiptsPanel({ queue, recordId, canOpen }: ReceiptsPanelProps) {
  const [receipts, setReceipts] = useState<PaymentReceipt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ url: string; contentType: string } | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setReceipts(null);
    setError(null);
    setOpenId(null);
    setPreview(null);
    QUEUES[queue]
      .list(recordId)
      .then((result) => {
        if (!cancelled) setReceipts(result.receipts);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Could not read the receipts.');
      });
    return () => {
      cancelled = true;
    };
  }, [queue, recordId]);

  // An object URL is an allocation the browser keeps until asked. Releasing the previous one when the
  // operator switches slips, closes it, or walks out of the dialog is the whole lifecycle.
  useEffect(() => () => {
    if (preview !== null) URL.revokeObjectURL(preview.url);
  }, [preview]);

  const toggle = async (receipt: PaymentReceipt) => {
    setOpenError(null);
    if (openId === receipt.id) {
      setOpenId(null);
      setPreview(null);
      return;
    }
    if (busyId !== null) return;
    setBusyId(receipt.id);
    try {
      const file = await api.receiptBlob(QUEUES[queue].raw(receipt.id));
      if (!mounted.current) {
        URL.revokeObjectURL(file.url);
        return;
      }
      setPreview(file);
      setOpenId(receipt.id);
    } catch (err) {
      setOpenError(err instanceof ApiError ? err.message : 'This document could not be opened.');
    } finally {
      setBusyId(null);
    }
  };

  if (error !== null) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
        <IconAlert className="h-4 w-4 shrink-0" />
        {error}
      </div>
    );
  }

  if (receipts === null) {
    return (
      <div className="flex items-center gap-2 text-xs text-faint">
        <Spinner className="h-4 w-4" />
        Loading payment receipts…
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-edge/60 bg-elevated/40 p-3">
      <p className="text-[10px] uppercase tracking-wider text-faint">
        Payment receipts ({receipts.length})
      </p>
      {receipts.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted">
          Nothing has been uploaded for this record. A claim with no slip is decided on the payment
          reference alone — the seller may still attach one while it stays open.
        </p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {receipts.map((receipt) => (
            <li key={receipt.id} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 truncate text-xs font-semibold text-ink">
                  <IconImage className="h-3.5 w-3.5 shrink-0 text-violet-300" />
                  <span className="truncate" title={receipt.fileName}>
                    {receipt.fileName}
                  </span>
                </p>
                <p className="mt-0.5 pl-5 text-[11px] text-faint">
                  {formatBytes(receipt.byteSize)} · {receipt.contentType} ·{' '}
                  <span title={formatDateTime(receipt.createdAt)}>{relativeTime(receipt.createdAt)}</span>
                </p>
              </div>
              {canOpen ? (
                <button
                  type="button"
                  onClick={() => void toggle(receipt)}
                  disabled={busyId !== null && busyId !== receipt.id}
                  className="focus-ring inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-edge bg-surface px-2.5 py-1 text-[11px] font-semibold text-muted transition hover:border-violet-500/60 hover:text-violet-200 disabled:opacity-50"
                >
                  {busyId === receipt.id ? <Spinner className="h-3.5 w-3.5" /> : <IconEye className="h-3.5 w-3.5" />}
                  {openId === receipt.id ? 'Hide' : 'Open'}
                </button>
              ) : (
                <span className="shrink-0 text-[11px] text-faint">read only</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {openError !== null && (
        <p className="mt-2 flex items-center gap-2 rounded-lg border border-rose-500/50 bg-rose-950/60 px-2.5 py-1.5 text-[11px] text-rose-200">
          <IconAlert className="h-3.5 w-3.5 shrink-0" />
          {openError}
        </p>
      )}

      {preview !== null && openId !== null && (
        <div className="mt-3 rounded-lg border border-edge/60 bg-surface p-2">
          {preview.contentType.startsWith('image/') ? (
            <img
              src={preview.url}
              alt="Payment receipt uploaded by the seller"
              className="mx-auto max-h-96 w-auto rounded-md"
            />
          ) : preview.contentType === 'application/pdf' ? (
            <iframe src={preview.url} title="Payment receipt uploaded by the seller" className="h-96 w-full rounded-md border-0 bg-white" />
          ) : (
            <a href={preview.url} download className="text-xs font-semibold text-violet-200 underline">
              Download this document
            </a>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-faint">
            This is the seller&apos;s own upload. It proves nothing on its own: the coins or the cash
            move when you decide, and your note is what the audit trail keeps.
          </p>
        </div>
      )}
    </div>
  );
}
