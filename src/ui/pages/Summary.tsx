/** 描述性统计 · 图形化摘要（对标 Minitab Graphical Summary）。 */
import { useState } from 'react';
import { sampleOutliers, boxplotStats } from '../charts/gagePanels';
import { useData } from '../../store/dataStore';
import { useApp } from '../../store/appStore';
import { arrMax, arrMin, computeDescriptive, nf, resolveNumericColumn } from '../../core';
import type { ChartTokens } from '../tokens';
import { reportNum } from '../../platform/reportLabels';
import { Card, CardHeader, Badge } from '../common';
import { Histogram } from '../charts/Histogram';
import { coordinateDomain, createPowerOfTwoAxis, projectCoordinate } from '../charts/axisScale';

export function Summary({ T }: { T: ChartTokens }) {
  const { model: M, pendingCells } = useData();
  const { activeVar, setActiveVar } = useApp();
  const [bins, setBins] = useState(13);
  const selected = resolveNumericColumn(M, activeVar);
  const pending = pendingCells.filter((cell) => cell.col === selected.index);
  const d = computeDescriptive(selected.values);

  // 显示小数位;fix2609l G22a(3b 尾巴):与报告层 reportNum 同一派生规则——定点只剩不到 3 位有效数字
  // 时改按有效数字,小量级数据(如 4.7e-9 F)不再显示 0.000。
  const dp = 3;
  const statRows: Array<[string, string, string?]> = [
    ['观测数 N', String(d.n)],
    ['均值', reportNum(d.mean, dp)],
    ['均值标准误 SE', reportNum(d.seMean, dp)],
    ['标准差', reportNum(d.stdev, dp)],
    ['方差', reportNum(d.variance, dp)],
    ['变异系数 CV', d.cv == null ? '—（均值为 0）' : nf(d.cv, 2) + ' %'],
    // 常量列时偏度/峰度为 NaN(不可估计),显示「—」而非伪值
    ['偏度', Number.isFinite(d.skewness) ? nf(d.skewness, 3) : '—'],
    ['峰度', Number.isFinite(d.kurtosis) ? nf(d.kurtosis, 3) : '—'],
    ['最小值', reportNum(d.min, dp)],
    ['第一四分位 Q1', reportNum(d.q1, dp)],
    ['中位数', reportNum(d.median, dp)],
    ['第三四分位 Q3', reportNum(d.q3, dp)],
    ['最大值', reportNum(d.max, dp)],
    ['极差', reportNum(d.range, dp)],
    ['四分位距 IQR', reportNum(d.iqr, dp)],
    ['总和', reportNum(d.sum, dp)],
  ];
  const ciRows: Array<[string, string]> = [
    ['均值 95% CI', `(${reportNum(d.ciMean[0], dp)}, ${reportNum(d.ciMean[1], dp)})`],
    // 蜂群 P3-01:n<6 时区间退回全距,实际覆盖率只有 50%~93.75%,不能无条件标「95%」
    [d.ciMedianAchieved >= 0.95 ? '中位数 95% CI' : `中位数 CI（实际 ${nf(d.ciMedianAchieved * 100, 2)}%）`,
      `(${reportNum(d.ciMedian[0], dp)}, ${reportNum(d.ciMedian[1], dp)})`],
    ['标准差 95% CI', `(${reportNum(d.ciStdev[0], dp)}, ${reportNum(d.ciStdev[1], dp)})`],
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Card style={{ padding: '11px 16px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, color: '#5b6472', fontSize: 12.5 }}>
          分析变量
          <select
            aria-label="描述性统计变量"
            value={selected.name}
            onChange={(event) => setActiveVar(event.target.value)}
            style={{ padding: '5px 9px', border: '1px solid #cfd5dd', borderRadius: 4, background: '#fff', color: '#2a333f' }}
          >
            {M.colNames.map((name, index) => <option key={`${name}-${index}`} value={name}>{name}</option>)}
          </select>
        </label>
        <span style={{ fontSize: 11.5, color: '#8a929d' }}>一次只分析一个数值变量；不会把不同量纲的列展平混算。</span>
      </Card>
      {pending.length > 0 ? (
        <Card style={{ padding: '18px 20px', color: '#b0620f', background: '#fff8e8', lineHeight: 1.7 }}>
          <b>描述性统计尚未运行：</b>「{selected.name}」还有 {pending.length} 个待录入单元格。完成录入后再分析，系统不会把占位值当实测值。
        </Card>
      ) : (
      <>
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <Card className="responsive-card" style={{ flex: '2 1 460px', minWidth: 420 }}>
          <CardHeader
            title="分布图形摘要"
            right={
              <label style={{ fontSize: 12, color: '#8a929d', display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                组数 {bins}
                <input type="range" min={5} max={30} value={bins} onChange={(e) => setBins(+e.target.value)} style={{ width: 110 }} />
              </label>
            }
          />
          <Histogram T={T} data={selected.values} mu={d.mean} sigmaWithin={d.stdev} sigmaOverall={d.stdev} lsl={null} usl={null} tgt={d.mean} tgtLabel="均值" bins={bins} h={210} />
          <BoxPlot T={T} data={selected.values} d={d} />
          <div style={{ fontSize: 11.5, color: '#98a1ac', padding: '2px 4px 4px' }}>
            上:直方图叠正态曲线（μ={reportNum(d.mean, dp)}, σ={reportNum(d.stdev, dp)}）· 下:箱线图（Q1–中位–Q3,须及 1.5·IQR,○ 为离群点）
          </div>
        </Card>

        <Card className="responsive-card" style={{ flex: '1 1 300px', minWidth: 280 }}>
          <CardHeader
            title="正态性检验"
            right={d.adAvailable
              ? <Badge bg={d.ad.normal ? '#e8f4ea' : '#fcf3e3'} color={d.ad.normal ? '#2c8a45' : '#d98324'}>{d.ad.normal ? '近似正态' : '偏离正态'}</Badge>
              : <Badge bg="#eef1f4" color="#8a929d">不可检验</Badge>}
          />
          <div style={{ padding: '4px 4px 8px', fontSize: 13, color: '#3a4350', lineHeight: 1.8 }}>
            {d.adAvailable ? (
              <>
                <Row k="Anderson-Darling A²" v={nf(d.ad.a2star, 3)} />
                <Row k="P 值" v={d.ad.p >= 0.999 ? '>0.999' : nf(d.ad.p, 3)} />
                <div style={{ fontSize: 12, color: '#8a929d', marginTop: 6 }}>
                  {d.ad.normal
                    ? 'P ≥ 0.05,不能拒绝正态假设,可用正态相关方法(能力分析、t 检验)。'
                    : 'P < 0.05,数据显著偏离正态,建议先做 Box-Cox 变换或采用非参数方法。'}
                </div>
              </>
            ) : (
              <div style={{ fontSize: 12.5, color: '#8a929d' }}>{d.adUnavailableReason}</div>
            )}
          </div>
          <div style={{ borderTop: '1px solid #eef0f3', marginTop: 8, paddingTop: 8 }}>
            <div style={{ fontSize: 11.5, color: '#98a1ac', fontWeight: 600, marginBottom: 4 }}>95% 置信区间</div>
            {ciRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="描述性统计量" right={<span style={{ fontSize: 12, color: '#8a929d' }}>变量：{selected.name}（{selected.values.length} 个观测）</span>} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '2px 22px', padding: '2px 4px 6px' }}>
          {statRows.map(([k, v]) => <Row key={k} k={k} v={v} />)}
        </div>
      </Card>
      </>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 2px', borderBottom: '1px solid #f4f6f8', fontSize: 13 }}>
      <span style={{ color: '#5b6472' }}>{k}</span>
      <span className="mono" style={{ color: '#26303c', fontWeight: 600 }}>{v}</span>
    </div>
  );
}

/** 水平箱线图:Q1–中位–Q3 盒,须延伸到 1.5·IQR 内的极值,盒外点为离群。 */
function BoxPlot({ T, data, d }: { T: ChartTokens; data: number[]; d: ReturnType<typeof computeDescriptive> }) {
  const W = 640, H = 74, padL = 14, padR = 14;
  const finiteData = data.filter(Number.isFinite);
  const axis = createPowerOfTwoAxis(finiteData);
  const coordinates = finiteData.map(axis.coordinate);
  // 箱线统计走共享实现(闭环终审 P2:此前本页是第三份独立须端逻辑,
  // [0,0,0,0,0,1000] 会画出「上须从 q3=250 反向指回 0」的图形)
  const box = boxplotStats(coordinates);
  // 自审 P2:slice(0,500) 是方向性偏倚(按值排序后只留最小的一批);改用共享抽稀
  const { shown: outliers, total: outlierTotal } = sampleOutliers(box.outliers);
  const whiskLo = box.whiskerLo;
  const whiskHi = box.whiskerHi;
  // 轴范围:含全部数据（含离群),留白。极值时不在原量纲构造 2·MAX。
  const domain = coordinateDomain(axis, coordinates, {
    padding: 0.06,
    constantHalf: 0.06,
    extremeConstantRelative: 0.06,
  });
  const X = (coordinate: number) => projectCoordinate(coordinate, domain, padL, W - padL - padR);
  const minCoordinate = coordinates.length ? arrMin(coordinates) : 0;
  const maxCoordinate = coordinates.length ? arrMax(coordinates) : 0;
  const meanCoordinate = axis.coordinate(d.mean);
  const cy = 34, bh = 26;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      {...(outlierTotal > outliers.length
        ? { role: 'img' as const, 'aria-label': `箱线图（共 ${outlierTotal} 个离群观测，图上抽样显示 ${outliers.length} 个）` }
        : {})}
    >
      {/* 须 */}
      <line x1={X(whiskLo)} y1={cy} x2={X(box.q1)} y2={cy} stroke={T.axis} strokeWidth={1.4} />
      <line x1={X(box.q3)} y1={cy} x2={X(whiskHi)} y2={cy} stroke={T.axis} strokeWidth={1.4} />
      <line x1={X(whiskLo)} y1={cy - 7} x2={X(whiskLo)} y2={cy + 7} stroke={T.axis} strokeWidth={1.4} />
      <line x1={X(whiskHi)} y1={cy - 7} x2={X(whiskHi)} y2={cy + 7} stroke={T.axis} strokeWidth={1.4} />
      {/* 盒 */}
      <rect x={X(box.q1)} y={cy - bh / 2} width={Math.max(1, X(box.q3) - X(box.q1))} height={bh} fill={T.bar3} stroke={T.bar} strokeWidth={1.4} />
      <line x1={X(box.median)} y1={cy - bh / 2} x2={X(box.median)} y2={cy + bh / 2} stroke={T.bar} strokeWidth={2.2} />
      {/* 均值菱形 */}
      <path d={`M ${X(meanCoordinate)} ${cy - 5} L ${X(meanCoordinate) + 5} ${cy} L ${X(meanCoordinate)} ${cy + 5} L ${X(meanCoordinate) - 5} ${cy} Z`} fill={T.curve} opacity={0.9} />
      {/* 全部离群观测；重复值稍作纵向错位，避免只看见一个点。 */}
      {outliers.map((coordinate, index) => (
        <circle key={index} cx={X(coordinate)} cy={cy + ((index % 3) - 1) * 5} r={3.2} fill="none" stroke={T.limit} strokeWidth={1.3} />
      ))}
      {/* 刻度标注 */}
      {[
        ['min', minCoordinate], ['Q1', box.q1], ['中位', box.median], ['Q3', box.q3], ['max', maxCoordinate],
      ].map(([label, coordinate]) => (
        <text key={label as string} x={X(coordinate as number)} y={H - 6} fontSize={9.5} fill={T.text} textAnchor="middle">
          {nf(axis.restore(coordinate as number), 2)}
        </text>
      ))}
    </svg>
  );
}
