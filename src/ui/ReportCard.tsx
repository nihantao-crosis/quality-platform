/** 助手结论卡视图 — 红绿灯 verdict + 人话 headline + 逐项体检。 */
import { Card } from './common';
import type { ReportData, Level } from './reportData';

const COLORS: Record<Level, { dot: string; bg: string; text: string; label: string }> = {
  ok: { dot: '#2c8a45', bg: '#e8f4ea', text: '#2c8a45', label: '通过' },
  warn: { dot: '#d98324', bg: '#fcf3e3', text: '#d98324', label: '需注意' },
  bad: { dot: '#c22f2f', bg: '#fdecec', text: '#c22f2f', label: '需处理' },
};

export function ReportCard({ data }: { data: ReportData }) {
  const v = COLORS[data.verdict];
  return (
    <Card style={{ padding: '13px 16px', borderLeft: `4px solid ${v.dot}` }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 340px', minWidth: 300 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
            <span style={{ fontSize: 11.5, letterSpacing: '0.05em', color: '#98a1ac', fontWeight: 700 }}>助手结论</span>
            <span style={{ background: v.bg, color: v.text, fontSize: 11, fontWeight: 700, padding: '2px 9px', borderRadius: 9 }}>{v.label}</span>
          </div>
          <div style={{ fontSize: 13.5, color: '#2b3440', lineHeight: 1.65, fontWeight: 500 }}>{data.headline}</div>
        </div>
        <div style={{ flex: '1 1 300px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {data.checks.map((c) => {
            const cc = COLORS[c.level];
            return (
              <div key={c.name} style={{ display: 'flex', alignItems: 'baseline', gap: 7, fontSize: 12 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: cc.dot, flex: 'none', position: 'relative', top: 0 }} />
                <span style={{ color: '#3a4350', fontWeight: 600, flex: 'none' }}>{c.name}</span>
                <span style={{ color: '#8a929d', lineHeight: 1.5 }}>{c.note}</span>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}
