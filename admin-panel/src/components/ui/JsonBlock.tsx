// ---------------------------------------------------------------------------
// A read-only JSON block: the board state, an event payload, payment evidence,
// an audit detail. Printed as-is because an operator ruling on a match or a
// reversal has to see the exact bytes the server stored, not a paraphrase.
// ---------------------------------------------------------------------------
interface JsonBlockProps {
  label?: string;
  value: unknown;
  className?: string;
  /** Truncate very long payloads; the full object stays in the title tooltip. */
  maxLines?: number;
}

export function JsonBlock({ label, value, className = '', maxLines = 18 }: JsonBlockProps) {
  const text = JSON.stringify(value ?? null, null, 2);
  if (text === undefined) return null;
  const lines = text.split('\n');
  const trimmed = lines.length > maxLines;
  const shown = trimmed ? lines.slice(0, maxLines).join('\n') : text;

  return (
    <div className={className}>
      {label && <p className="mb-1 text-[10px] uppercase tracking-widest text-faint">{label}</p>}
      <pre
        title={trimmed ? 'Shown truncated — hover a row for the full value in the table' : undefined}
        className="max-h-72 overflow-auto rounded-lg border border-edge/60 bg-base/70 p-3 font-mono text-[11px] leading-relaxed text-muted"
      >
        {shown}
        {trimmed && `\n… ${lines.length - maxLines} more lines`}
      </pre>
    </div>
  );
}
