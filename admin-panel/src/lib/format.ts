// ---------------------------------------------------------------------------
// Formatting helpers shared across the panel.
// ---------------------------------------------------------------------------

/** 1,234,567 with locale separators. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return Math.round(value).toLocaleString('en-US');
}

/** Compact notation: 1234 -> 1.2k, 12_400_000 -> 12.4M. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  const trim = (s: string): string => s.replace(/\.0$/, '');
  if (abs >= 1_000_000_000) return `${sign}${trim((abs / 1_000_000_000).toFixed(2))}B`;
  if (abs >= 1_000_000) return `${sign}${trim((abs / 1_000_000).toFixed(2))}M`;
  if (abs >= 1_000) return `${sign}${trim((abs / 1_000).toFixed(1))}k`;
  return `${sign}${Math.round(abs).toLocaleString('en-US')}`;
}

/** Diamonds are the paid spend-side currency (users.diamond_balance). */
export function formatDiamonds(value: number): string {
  return `\u25C6 ${formatCompact(value)}`; // "◆ 12.4k"
}

/** R-coins are the host earnings / withdrawable currency (users.r_coin_balance). */
export function formatRCoin(value: number): string {
  return `R ${formatCompact(value)}`;
}

/**
 * Real money is always stored in minor units, and a number without its currency code is the
 * kind of figure a partner disputes. 150000 + 'PKR' -> "PKR 1,500.00".
 */
export function formatCents(value: number, currency: string): string {
  if (!Number.isFinite(value)) return `${currency} 0.00`;
  return `${currency} ${(value / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/** Basis points as a plain percentage: 2500 -> "25%". */
export function formatBps(value: number): string {
  const percent = value / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(2)}%`;
}

/** Signed delta: 120 -> "+120", -30 -> "-30", 0 -> "0". */
export function formatSigned(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value);
  return rounded > 0 ? `+${formatCompact(rounded)}` : formatCompact(rounded);
}

/** Parse a signed integer from user input; null when not a clean integer. */
export function parseSignedInt(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (!/^[+-]?\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Parse an unsigned integer from user input; null when invalid. */
export function parseUnsignedInt(raw: string): number | null {
  const parsed = parseSignedInt(raw);
  if (parsed === null || parsed < 0) return null;
  return parsed;
}

/** "just now" / "12m ago" / "3h ago" / "5d ago" / "Oct 2, 2026". */
export function relativeTime(input: string | null | undefined): string {
  if (!input) return 'never';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 45_000) return 'just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(input);
}

/** Oct 2, 2026 */
export function formatDate(input: string | null | undefined): string {
  if (!input) return '—';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Oct 2, 2026, 14:35 */
export function formatDateTime(input: string | null | undefined): string {
  if (!input) return '—';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Initials for avatar fallbacks: "Sara Lee" -> "SL", "nodev" -> "N". */
export function initials(name: string | null | undefined): string {
  const clean = (name ?? '?').trim();
  if (clean.length === 0) return '?';
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

/** Short day label for chart axes: "Mon"; falls back to MM-DD. */
export function weekdayLabel(isoDate: string): string {
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate.length >= 5 ? isoDate.slice(-5) : isoDate;
  return date.toLocaleDateString('en-US', { weekday: 'short' });
}

/** File size the way an operator reads it: 1.4 MB, not 1468006. */
export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
}
