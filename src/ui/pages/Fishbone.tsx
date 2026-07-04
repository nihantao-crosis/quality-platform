/**
 * 鱼骨图（因果图）— 交接文档模块清单「帕累托图 / 鱼骨图」的后半部分。
 * 6M 分类（人/机/料/法/环/测）,问题与原因可编辑,localStorage 持久化。
 */
import { memo, useState, Fragment } from 'react';
import type { CSSProperties } from 'react';
import { useApp } from '../../store/appStore';
import type { ChartTokens } from '../tokens';
import { Card, tabStyle } from '../common';
import { Svg, Ln, Txt } from '../charts/primitives';

export interface FishboneData {
  problem: string;
  categories: { name: string; causes: string[] }[];
}

const LS_KEY = 'qp-fishbone-v1';

export const FISHBONE_DEFAULT: FishboneData = {
  problem: '尺寸超差',
  categories: [
    { name: '人 (Man)', causes: ['新员工操作不熟练', '对刀凭经验无标准'] },
    { name: '机 (Machine)', causes: ['刀具磨损未监控', '主轴热变形'] },
    { name: '料 (Material)', causes: ['毛坯硬度批次波动'] },
    { name: '法 (Method)', causes: ['工序卡未更新', '装夹方式不统一'] },
    { name: '环 (Environment)', causes: ['车间昼夜温差大'] },
    { name: '测 (Measurement)', causes: ['量具未按期校准'] },
  ],
};

export function loadFishbone(): FishboneData {
  try {
    const s = localStorage.getItem(LS_KEY);
    if (s) {
      const d = JSON.parse(s) as FishboneData;
      if (d.problem != null && Array.isArray(d.categories) && d.categories.length === 6) return d;
    }
  } catch { /* 回落默认 */ }
  return FISHBONE_DEFAULT;
}

function saveFishbone(d: FishboneData) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(d));
  } catch { /* 忽略 */ }
}

// ---------- SVG 鱼骨 ----------
const MAX_SHOWN = 4; // 每根骨最多展示的原因数

function FishboneChartImpl({ T, data }: { T: ChartTokens; data: FishboneData }) {
  const W = 960;
  const H = 430;
  const spineY = H / 2;
  const spineX0 = 40;
  const spineX1 = 770;
  const headW = 150;
  const branchLen = 150; // 垂直投影长度
  const branchDx = 78; // 斜骨水平偏移
  const roots = [170, 400, 630]; // 三对骨的根部 x

  const branch = (rootX: number, up: boolean, cat: FishboneData['categories'][number]) => {
    const tipY = up ? spineY - branchLen : spineY + branchLen;
    const tipX = rootX + branchDx;
    const causes = cat.causes.slice(0, MAX_SHOWN);
    return (
      <Fragment key={cat.name}>
        <Ln x1={rootX} y1={spineY} x2={tipX} y2={tipY} stroke={T.axis} sw={1.6} />
        <rect x={tipX - 46} y={up ? tipY - 22 : tipY + 2} width={92} height={20} rx={4} fill={T.bg} stroke={T.point} strokeWidth={1.4} />
        <Txt x={tipX} y={up ? tipY - 12 : tipY + 12} s={cat.name} fill={T.point} size={11} anchor="middle" weight={700} />
        {causes.map((cause, i) => {
          const f = 0.28 + (i * 0.62) / Math.max(1, MAX_SHOWN - 1); // 沿骨位置
          const cx = rootX + branchDx * f;
          const cy = spineY + (tipY - spineY) * f;
          const label = cause.length > 14 ? cause.slice(0, 13) + '…' : cause;
          return (
            <Fragment key={i}>
              <Ln x1={cx} y1={cy} x2={cx - 52} y2={cy} stroke={T.grid === 'transparent' ? T.axis : T.line} sw={1.1} />
              <Txt x={cx - 56} y={cy} s={label} fill={T.text} size={10.5} anchor="end" />
            </Fragment>
          );
        })}
      </Fragment>
    );
  };

  return (
    <Svg w={W} h={H}>
      <rect x={0} y={0} width={W} height={H} fill={T.bg} />
      {/* 脊骨与头部问题框 */}
      <Ln x1={spineX0} y1={spineY} x2={spineX1} y2={spineY} stroke={T.text} sw={2.4} />
      <polygon points={`${spineX1},${spineY - 8} ${spineX1 + 14},${spineY} ${spineX1},${spineY + 8}`} fill={T.text} />
      <rect x={spineX1 + 16} y={spineY - 30} width={headW} height={60} rx={6} fill={T.bg} stroke={T.limit} strokeWidth={2} />
      <Txt x={spineX1 + 16 + headW / 2} y={spineY - 8} s="问题" fill={T.axis} size={10} anchor="middle" />
      <Txt
        x={spineX1 + 16 + headW / 2} y={spineY + 8}
        s={data.problem.length > 10 ? data.problem.slice(0, 9) + '…' : data.problem}
        fill={T.limit} size={13} anchor="middle" weight={700}
      />
      {/* 三上三下六根骨 */}
      {roots.map((x, i) => branch(x, true, data.categories[i]))}
      {roots.map((x, i) => branch(x, false, data.categories[i + 3]))}
    </Svg>
  );
}

const FishboneChart = memo(FishboneChartImpl);

// ---------- 编辑面板 + 页面 ----------
const inputStyle: CSSProperties = {
  width: '100%', padding: '6px 9px', border: '1px solid #cfd5dd', borderRadius: 4,
  fontSize: 12.5, color: '#2a333f', boxSizing: 'border-box',
};

export function Fishbone({ T }: { T: ChartTokens }) {
  const showToast = useApp((s) => s.showToast);
  const [data, setData] = useState<FishboneData>(loadFishbone);
  const [catIdx, setCatIdx] = useState(0);
  const [draft, setDraft] = useState('');

  const update = (next: FishboneData) => {
    setData(next);
    saveFishbone(next);
  };
  const addCause = () => {
    const cause = draft.trim();
    if (!cause) return;
    const categories = data.categories.map((c, i) => (i === catIdx ? { ...c, causes: [...c.causes, cause] } : c));
    update({ ...data, categories });
    setDraft('');
  };
  const removeCause = (ci: number) => {
    const categories = data.categories.map((c, i) => (i === catIdx ? { ...c, causes: c.causes.filter((_, j) => j !== ci) } : c));
    update({ ...data, categories });
  };
  const cat = data.categories[catIdx];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 300px', gap: 16 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', padding: '11px 16px', borderBottom: '1px solid #edf0f3' }}>
          <div style={{ fontWeight: 600, color: '#33404f' }}>因果图（鱼骨图）· 6M 分析</div>
          <div style={{ marginLeft: 'auto', fontSize: 11, color: '#a3abb5' }}>每根骨展示前 {MAX_SHOWN} 条原因</div>
        </div>
        <div style={{ padding: '10px 14px 6px' }}>
          <FishboneChart T={T} data={data} />
        </div>
      </Card>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Card style={{ padding: '14px 16px' }}>
          <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>问题（鱼头）</div>
          <input
            value={data.problem}
            onChange={(e) => update({ ...data, problem: e.target.value })}
            style={inputStyle}
            placeholder="待分析的质量问题"
          />
        </Card>
        <Card style={{ padding: '14px 16px' }}>
          <div style={{ fontWeight: 600, color: '#33404f', marginBottom: 10 }}>原因编辑</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: 10 }}>
            {data.categories.map((c, i) => (
              <div key={c.name} style={{ ...tabStyle(i === catIdx), padding: '4px 10px', fontSize: 11.5 }} onClick={() => setCatIdx(i)}>
                {c.name.split(' ')[0]}
              </div>
            ))}
          </div>
          {cat.causes.length === 0 && <div style={{ fontSize: 12, color: '#9aa2ad', padding: '4px 0' }}>暂无原因,在下方添加</div>}
          {cat.causes.map((cause, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid #f2f4f6', fontSize: 12.5 }}>
              <span style={{ flex: 1, color: '#3a4350' }}>{cause}</span>
              <span onClick={() => removeCause(i)} style={{ cursor: 'pointer', color: '#c22f2f', fontWeight: 700, padding: '0 4px' }}>×</span>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addCause()}
              style={{ ...inputStyle, flex: 1 }}
              placeholder={`添加「${cat.name.split(' ')[0]}」类原因…`}
            />
            <div onClick={addCause} style={{ padding: '6px 14px', background: '#1f6fb2', color: '#fff', borderRadius: 4, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}>添加</div>
          </div>
          <div
            onClick={() => { update(FISHBONE_DEFAULT); setCatIdx(0); showToast('鱼骨图已重置为演示内容'); }}
            style={{ marginTop: 10, fontSize: 11.5, color: '#8a929d', cursor: 'pointer', textDecoration: 'underline' }}
          >
            重置为演示内容
          </div>
        </Card>
      </div>
    </div>
  );
}
