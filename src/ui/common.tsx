/** 通用卡片 / 徽章 / 键值行 — 复用原型的卡片样式令牌。 */
import type { CSSProperties, ReactNode } from 'react';

export const card: CSSProperties = {
  background: '#fff',
  border: '1px solid #e2e5ea',
  borderRadius: 5,
  boxShadow: '0 1px 2px rgba(20,30,50,0.04)',
};

export function Card({ style, children }: { style?: CSSProperties; children: ReactNode }) {
  return <div style={{ ...card, ...style }}>{children}</div>;
}

export function CardHeader({ title, right }: { title: ReactNode; right?: ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
      <div style={{ fontWeight: 600, color: '#33404f' }}>{title}</div>
      {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
    </div>
  );
}

/** 键值行列表（控制限与参数 / 列统计 / 风险指标等） */
export function KvRows({ rows, valueWeight = 600 }: { rows: { k: string; v: string }[]; valueWeight?: number }) {
  return (
    <>
      {rows.map((r) => (
        <div key={r.k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid #f2f4f6', fontSize: 12.5 }}>
          <span style={{ color: '#7a828d' }}>{r.k}</span>
          <span className="mono" style={{ color: '#2a333f', fontWeight: valueWeight }}>{r.v}</span>
        </div>
      ))}
    </>
  );
}

export function Badge({ bg, color, children }: { bg: string; color: string; children: ReactNode }) {
  return (
    <span style={{ background: bg, color, fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 9 }}>{children}</span>
  );
}

export const tabStyle = (a: boolean): CSSProperties =>
  a
    ? { padding: '6px 15px', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, fontWeight: 600, background: '#1f6fb2', color: '#fff', whiteSpace: 'nowrap' }
    : { padding: '6px 15px', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, color: '#4a5462', background: '#eef1f4', whiteSpace: 'nowrap' };

export const chipStyle = (on: boolean): CSSProperties =>
  on
    ? { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 14, cursor: 'pointer', fontSize: 12, fontWeight: 600, background: '#e7f0f9', color: '#1f6fb2', border: '1px solid #bcd6ee' }
    : { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 11px', borderRadius: 14, cursor: 'pointer', fontSize: 12, background: '#f4f6f8', color: '#9aa2ad', border: '1px solid #e5e9ee' };

export const numInput: CSSProperties = {
  width: 76, padding: '5px 8px', border: '1px solid #cfd5dd', borderRadius: 4,
  fontFamily: 'IBM Plex Mono,monospace', fontSize: 12.5, color: '#2a333f', textAlign: 'right',
};

export const thStyle: CSSProperties = { padding: '9px 16px', fontWeight: 600 };
