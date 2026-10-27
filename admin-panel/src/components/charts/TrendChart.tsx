// ---------------------------------------------------------------------------
// Dependency-free 7-day trend chart: dual-series SVG line/area.
//   - diamonds: violet area + line (left axis scale)
//   - rooms:    fuchsia dashed line (own scale)
// Pure inline SVG; no chart library.
// ---------------------------------------------------------------------------
import { useMemo } from 'react';
import type { StatsSeriesPoint } from '../../types';
import { formatCompact, weekdayLabel } from '../../lib/format';

interface TrendChartProps {
  points: StatsSeriesPoint[];
}

const W = 720;
const H = 260;
const PAD = { top: 18, right: 20, bottom: 36, left: 56 };

export function TrendChart({ points }: TrendChartProps) {
  const geometry = useMemo(() => {
    const n = points.length;
    const innerW = W - PAD.left - PAD.right;
    const innerH = H - PAD.top - PAD.bottom;
    const baseline = H - PAD.bottom;

    const maxDiamonds = Math.max(1, ...points.map((p) => Math.max(0, p.diamonds)));
    const maxRooms = Math.max(1, ...points.map((p) => Math.max(0, p.rooms)));

    const xAt = (i: number): number =>
      n <= 1 ? PAD.left + innerW / 2 : PAD.left + (i / (n - 1)) * innerW;
    const yDiamonds = (v: number): number => baseline - (Math.max(0, v) / maxDiamonds) * innerH;
    const yRooms = (v: number): number => baseline - (Math.max(0, v) / maxRooms) * innerH;

    const diamondLine = points.map((p, i) => `${xAt(i)},${yDiamonds(p.diamonds)}`).join(' ');
    const roomLine = points.map((p, i) => `${xAt(i)},${yRooms(p.rooms)}`).join(' ');

    const firstX = xAt(0);
    const lastX = xAt(Math.max(0, n - 1));
    const diamondArea =
      n > 0 ? `M ${firstX},${baseline} L ${points.map((p, i) => `${xAt(i)},${yDiamonds(p.diamonds)}`).join(' L ')} L ${lastX},${baseline} Z` : '';

    const gridLines = [0, 0.25, 0.5, 0.75, 1].map((t) => ({
      y: baseline - t * innerH,
      label: formatCompact(Math.round(maxDiamonds * t)),
    }));

    return { xAt, yDiamonds, yRooms, diamondLine, roomLine, diamondArea, gridLines, maxDiamonds, maxRooms };
  }, [points]);

  if (points.length === 0) {
    return (
      <div className="grid h-48 place-items-center text-xs text-faint">
        No trend data returned yet.
      </div>
    );
  }

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm bg-gradient-to-br from-violet-400 to-fuchsia-500" />
          Diamonds spent
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-0.5 w-4 rounded bg-fuchsia-400" />
          Rooms opened
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="7 day diamonds and rooms trend">
        <defs>
          <linearGradient id="diamond-area" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8b5cf6" stopOpacity="0.45" />
            <stop offset="1" stopColor="#8b5cf6" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* horizontal grid + left axis labels (diamonds scale) */}
        {geometry.gridLines.map((line) => (
          <g key={line.y}>
            <line x1={PAD.left} x2={W - PAD.right} y1={line.y} y2={line.y} stroke="rgb(47 42 88)" strokeWidth="1" strokeDasharray="3 4" />
            <text x={PAD.left - 8} y={line.y + 3.5} textAnchor="end" fontSize="10" fill="rgb(113 104 158)">
              {line.label}
            </text>
          </g>
        ))}

        {/* diamonds area + line */}
        <path d={geometry.diamondArea} fill="url(#diamond-area)" stroke="none" />
        <polyline
          points={geometry.diamondLine}
          fill="none"
          stroke="#8b5cf6"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* rooms line (own scale) */}
        <polyline
          points={geometry.roomLine}
          fill="none"
          stroke="#e879f9"
          strokeWidth="2"
          strokeDasharray="5 4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* data points + x axis labels */}
        {points.map((p, i) => (
          <g key={`${p.date}-${i}`}>
            <circle cx={geometry.xAt(i)} cy={geometry.yDiamonds(p.diamonds)} r="3.5" fill="#0b0918" stroke="#a78bfa" strokeWidth="2" />
            <circle cx={geometry.xAt(i)} cy={geometry.yRooms(p.rooms)} r="3" fill="#0b0918" stroke="#e879f9" strokeWidth="1.8" />
            <text
              x={geometry.xAt(i)}
              y={H - 12}
              textAnchor="middle"
              fontSize="11"
              fill="rgb(167 158 214)"
            >
              {weekdayLabel(p.date)}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
