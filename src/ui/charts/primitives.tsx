/** SVG 基元 — 对应原型 svg/line/txt 辅助函数。 */
import type { ReactNode } from 'react';

export function Svg({ w, h, children }: { w: number; h: number; children: ReactNode }) {
  return (
    <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      {children}
    </svg>
  );
}

export function Ln(p: {
  x1: number; y1: number; x2: number; y2: number;
  stroke: string; sw: number; dash?: string;
}) {
  return (
    <line x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={p.stroke} strokeWidth={p.sw} strokeDasharray={p.dash || undefined} />
  );
}

export function Txt(p: {
  x: number; y: number; s: string; fill: string;
  size?: number; anchor?: 'start' | 'middle' | 'end'; weight?: number;
}) {
  return (
    <text
      x={p.x} y={p.y} fill={p.fill} fontSize={p.size ?? 11}
      textAnchor={p.anchor ?? 'start'} fontFamily="IBM Plex Mono, monospace"
      fontWeight={p.weight ?? 400} dominantBaseline="middle"
    >
      {p.s}
    </text>
  );
}
