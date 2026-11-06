'use client';

import { useMemo, useState } from 'react';

export interface SeriesPoint {
  label: string;
  value: number;
}

/** Lightweight interactive SVG line chart (no chart dependency). */
export function LineChart({
  data,
  height = 220,
  color = '#7e9bff',
  secondary,
  secondaryColor = '#a78bfa',
  valueSuffix = '',
}: {
  data: SeriesPoint[];
  height?: number;
  color?: string;
  secondary?: SeriesPoint[];
  secondaryColor?: string;
  valueSuffix?: string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 720;
  const padding = { top: 16, right: 12, bottom: 26, left: 36 };

  const geometry = useMemo(() => {
    const values = [...data.map((point) => point.value), ...(secondary ?? []).map((point) => point.value)];
    const max = Math.max(1, ...values);
    const count = Math.max(1, data.length - 1);
    const innerWidth = width - padding.left - padding.right;
    const innerHeight = height - padding.top - padding.bottom;
    const toPoint = (point: SeriesPoint, index: number, total: number) => ({
      x: padding.left + (index / Math.max(1, total - 1)) * innerWidth,
      y: padding.top + innerHeight - (point.value / max) * innerHeight,
    });
    const primary = data.map((point, index) => toPoint(point, index, data.length));
    const second = secondary?.map((point, index) => toPoint(point, index, secondary.length)) ?? [];
    const path = (points: { x: number; y: number }[]) =>
      points.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ');
    const area = primary.length
      ? `${path(primary)} L${primary[primary.length - 1]?.x ?? 0},${height - padding.bottom} L${primary[0]?.x ?? 0},${height - padding.bottom} Z`
      : '';
    return { primary, second, path, area, max, count, innerWidth, innerHeight };
  }, [data, secondary, height, padding.bottom, padding.left, padding.right, padding.top]);

  if (!data.length) {
    return <div className="flex h-40 items-center justify-center rounded-xl border border-dashed border-white/10 text-sm text-slate-500">No data yet</div>;
  }

  const gradientId = `grad-${color.replace('#', '')}`;
  const hovered = hover !== null ? data[hover] : null;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label={`Chart with ${data.length} points`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          const relative = ((event.clientX - rect.left) / rect.width) * width;
          const index = Math.round(((relative - padding.left) / geometry.innerWidth) * (data.length - 1));
          setHover(Math.max(0, Math.min(data.length - 1, index)));
        }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding.top + geometry.innerHeight * ratio;
          return (
            <g key={ratio}>
              <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
              <text x={4} y={y + 4} fill="#5b6480" fontSize="10">
                {Math.round(geometry.max * (1 - ratio))}
              </text>
            </g>
          );
        })}
        <path d={geometry.area} fill={`url(#${gradientId})`} />
        <path d={geometry.path(geometry.primary)} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        {secondary?.length ? (
          <path d={geometry.path(geometry.second)} fill="none" stroke={secondaryColor} strokeWidth="2" strokeDasharray="4 4" opacity="0.8" />
        ) : null}
        {hover !== null && geometry.primary[hover] ? (
          <g>
            <line
              x1={geometry.primary[hover]!.x}
              x2={geometry.primary[hover]!.x}
              y1={padding.top}
              y2={height - padding.bottom}
              stroke="rgba(255,255,255,0.18)"
              strokeDasharray="3 3"
            />
            <circle cx={geometry.primary[hover]!.x} cy={geometry.primary[hover]!.y} r="4.5" fill={color} stroke="#05070f" strokeWidth="2" />
          </g>
        ) : null}
        {data.map((point, index) =>
          index % Math.ceil(data.length / 7) === 0 ? (
            <text key={`${point.label}-${index}`} x={geometry.primary[index]?.x} y={height - 8} fill="#5b6480" fontSize="10" textAnchor="middle">
              {point.label.slice(5)}
            </text>
          ) : null,
        )}
      </svg>
      {hovered ? (
        <div className="pointer-events-none absolute left-2 top-2 rounded-lg border border-white/10 bg-ink-900/95 px-3 py-1.5 text-xs text-slate-200 shadow-lg">
          <span className="text-slate-400">{hovered.label}</span> · <strong>{hovered.value.toLocaleString()}</strong>
          {valueSuffix}
        </div>
      ) : null}
    </div>
  );
}

export function BarList({ items, max }: { items: { label: string; value: number }[]; max?: number }) {
  const ceiling = max ?? Math.max(1, ...items.map((item) => item.value));
  if (!items.length) return <p className="text-sm text-slate-500">No data.</p>;
  return (
    <ul className="space-y-2.5">
      {items.map((item) => (
        <li key={item.label}>
          <div className="mb-1 flex items-center justify-between text-xs">
            <span className="truncate text-slate-300">{item.label}</span>
            <span className="text-slate-500">{item.value.toLocaleString()}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-white/[0.06]">
            <div className="h-full rounded-full bg-brand-gradient" style={{ width: `${Math.max(2, (item.value / ceiling) * 100)}%` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
