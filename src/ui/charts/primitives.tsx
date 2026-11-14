/** SVG 基元 — 对应原型 svg/line/txt 辅助函数。 */
import type { ReactNode } from 'react';

export function Svg({ w, h, children, label, interactive, readable }: {
  w: number; h: number; children: ReactNode; label?: string; interactive?: boolean;
  /**
   * fix2611a D5:具名但图内文字(刻度/数值/项名)本身就是读数依据的图用 role="group" + 名称，
   * 既给出具体图名，又不把子树压成 presentational(role="img" 会让图内文字对辅助技术消失)。
   */
  readable?: boolean;
}) {
  // 无障碍(双审 P3):有具名 label 的图作为单一图像呈现(role="img" + 名称)。
  // interactive:图内含 role="button" 的可点击元素时必须用 role="group" —— role="img"
  // 会把整棵子树压成 presentational,可点击点对辅助技术直接消失(自审 P2)。
  // 自审 P1:**没有具名 label 时不得加 role="img"** —— 它会把整张图变成原子图像,
  // 图内的刻度/UCL 文字与 ControlChart 的可点击点对辅助技术全部消失,而换来的
  // 只是一句无信息量的「统计图表」。无名时保持默认语义,图内文字仍可被读到。
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      {...(label ? { role: interactive || readable ? 'group' : 'img', 'aria-label': label } : {})}
      data-qp-chart=""
      style={{ width: '100%', height: 'auto', display: 'block' }}
    >
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
