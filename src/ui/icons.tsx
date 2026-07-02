/** 内联线性图标（1.5px 线宽）— 从原型 icon() 迁移。 */

export type IconName = 'grid' | 'table' | 'chart' | 'bell' | 'gauge' | 'box' | 'bars' | 'flask' | 'check';

export function Icon({ name, color }: { name: IconName; color?: string }) {
  const col = color || '#5b6472';
  const p = {
    width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
    stroke: col, strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'grid':
      return (
        <svg {...p}>
          <rect x={1.5} y={1.5} width={5.5} height={5.5} rx={1} />
          <rect x={9} y={1.5} width={5.5} height={5.5} rx={1} />
          <rect x={1.5} y={9} width={5.5} height={5.5} rx={1} />
          <rect x={9} y={9} width={5.5} height={5.5} rx={1} />
        </svg>
      );
    case 'table':
      return (
        <svg {...p}>
          <rect x={1.5} y={2} width={13} height={12} rx={1} />
          <line x1={1.5} y1={6} x2={14.5} y2={6} />
          <line x1={6} y1={2} x2={6} y2={14} />
        </svg>
      );
    case 'chart':
      return (
        <svg {...p}>
          <path d="M2 10 L6 6 L9 8 L14 3" />
          <line x1={2} y1={14} x2={14} y2={14} />
        </svg>
      );
    case 'bell':
      return (
        <svg {...p}>
          <path d="M2 12 C5 12 5 4 8 4 C11 4 11 12 14 12" />
        </svg>
      );
    case 'gauge':
      return (
        <svg {...p}>
          <path d="M2.5 12 A6 6 0 0 1 13.5 12" />
          <line x1={8} y1={12} x2={11} y2={7} />
        </svg>
      );
    case 'box':
      return (
        <svg {...p}>
          <rect x={3} y={5} width={10} height={6} rx={1} />
          <line x1={8} y1={2} x2={8} y2={5} />
          <line x1={8} y1={11} x2={8} y2={14} />
          <line x1={6} y1={8} x2={10} y2={8} />
        </svg>
      );
    case 'bars':
      return (
        <svg {...p}>
          <line x1={3} y1={14} x2={3} y2={5} />
          <line x1={7} y1={14} x2={7} y2={8} />
          <line x1={11} y1={14} x2={11} y2={3} />
        </svg>
      );
    case 'flask':
      return (
        <svg {...p}>
          <path d="M6 2 L6 6 L3 13 A1 1 0 0 0 4 14.5 L12 14.5 A1 1 0 0 0 13 13 L10 6 L10 2" />
          <line x1={5} y1={2} x2={11} y2={2} />
        </svg>
      );
    case 'check':
      return (
        <svg {...p}>
          <circle cx={8} cy={8} r={6} />
          <path d="M5.5 8 L7.2 9.8 L10.5 6" />
        </svg>
      );
    default:
      return (
        <svg {...p}>
          <circle cx={8} cy={8} r={5} />
        </svg>
      );
  }
}
