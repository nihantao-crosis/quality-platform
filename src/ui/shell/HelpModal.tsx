/** 帮助中心 — 各模块统计方法精要(F1)。 */
import { useState } from 'react';
import { useApp } from '../../store/appStore';

interface Topic {
  key: string;
  title: string;
  lines: string[];
}

const TOPICS: Topic[] = [
  {
    key: 'spc', title: 'SPC 控制图',
    lines: [
      'X̄-R：X̿ ± A2·R̄;R 图 UCL = D4·R̄。σ̂组内 = R̄/d₂(常数表 n=2..10)。',
      'X̄-S：X̿ ± A3·S̄;I-MR：X̄ ± 3·MR̄/1.128。',
      'P 图：p̄ ± 3√(p̄(1−p̄)/n);C 图：c̄ ± 3√c̄(LCL 截 0)。',
      'EWMA(λ=0.2, L=2.7)与 CUSUM(k=0.5, h=4/5)对 ≤1.5σ 的小漂移更敏感。',
      'Nelson 准则:①单点>3σ ②连续9点同侧 ③连续6点单调 ④3点中2点>2σ 同侧。',
      '分阶段:选择阶段列后各连续段独立估计控制限,判异在段内进行。',
    ],
  },
  {
    key: 'capability', title: '过程能力',
    lines: [
      'Cp=(USL−LSL)/6σ组内;Cpk=min(CPU,CPL);Pp/Ppk 用 σ整体。',
      'Cpm=(USL−LSL)/6τ,τ²=Σ(x−T)²/n(惩罚偏离目标)。',
      '判定:Cpk ≥ 1.33 充足;1.0–1.33 临界;< 1.0 不足。',
      '单侧规格:仅有一侧限值时 Cpk 取可用侧,Cp/Pp/Cpm 不适用。',
      'Z.bench = Φ⁻¹(1−PPM整体/10⁶);西格玛水平 = Z.bench + 1.5。',
      '前提:数据近似正态——先看 Anderson-Darling 检验与概率图;非正态用 Box-Cox。',
    ],
  },
  {
    key: 'msa', title: '测量系统分析 Gage R&R',
    lines: [
      '交叉设计(ANOVA 法):方差分解为 重复性 + 再现性(操作员+交互) + 部件间。',
      '%研究变异 = 6σ分量/6σ总;%公差 = 6σGRR/(USL−LSL)。',
      'AIAG 判定:GRR < 10% 可接受;10–30% 视用途临界;> 30% 不可接受。',
      '导入数据需含 部件、操作员 两个文本列,且每个组合 ≥ 2 次重复。',
    ],
  },
  {
    key: 'hypo', title: '假设检验与回归',
    lines: [
      '单因子 ANOVA:F = MS组间/MS组内,P < 0.05 拒绝「各组均值相等」。',
      '单样本 t:检验均值是否偏离目标 μ₀;双样本 t 用 Welch 校正(不假设等方差)。',
      '回归:最小二乘 y = a + bx;R² 为可解释变异占比;斜率 t 检验判显著性。',
      '注意:P ≥ 0.05 表示「证据不足」,不等于「无差异」。',
    ],
  },
  {
    key: 'doe', title: '实验设计 DOE',
    lines: [
      '2³ 全因子:效应 = Σ(y·符号列)/4;系数 = 效应/2。',
      'Lenth 检验:PSE = 1.5·median(|效应| < 2.5·s₀);显著界限 ME = 2.57·PSE。',
      '主效应图看单因子影响;交互图两线不平行 → 存在交互作用。',
    ],
  },
  {
    key: 'aql', title: '抽样检验 AQL',
    lines: [
      'GB/T 2828.1:批量+检验水平 → 字码 → 样本量 n;Ac 满足 Pa(AQL) ≥ 95%。',
      'OC 曲线:Pa(p) = BinomCDF(Ac, n, p);RQL 为 Pa = 10% 的批质量。',
      '转移规则:正常⇄加严⇄放宽,依据连续批的接收/拒收记录(见 AQL 页模拟器)。',
      '生产方风险 α = 1 − Pa(AQL);使用方风险 β = Pa(RQL) = 10%。',
    ],
  },
  {
    key: 'data', title: '数据操作',
    lines: [
      '导入:CSV/剪贴板/.xlsx,每行一个子组(n=1..10),文本列自动成为分组列。',
      '手工录入:工作表双击单元格编辑;编辑演示集自动另存「副本」。',
      '堆叠列:多测量列 → 单列+「来源列」,可直接做 ANOVA;转置:行列互换。',
      '撤销/重做:Ctrl+Z / Ctrl+Y(20 层);全部数据本地持久化,重启自动恢复。',
    ],
  },
];

export function HelpModal({ onClose }: { onClose: () => void }) {
  const [topic, setTopic] = useState('spc');
  const cur = TOPICS.find((t) => t.key === topic)!;
  const goTo = useApp((s) => s.goTo);
  return (
    <div style={{ position: 'relative', width: 720, background: '#fff', borderRadius: 10, boxShadow: '0 24px 60px rgba(10,20,40,0.32)', overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', padding: '16px 20px', borderBottom: '1px solid #edf0f3' }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#26303c' }}>帮助中心 · 统计指南</div>
        <div onClick={onClose} style={{ marginLeft: 'auto', cursor: 'pointer', color: '#9aa2ad', fontSize: 17 }}>✕</div>
      </div>
      <div style={{ display: 'flex', minHeight: 340 }}>
        <div style={{ width: 168, borderRight: '1px solid #edf0f3', padding: '10px 0', background: '#fbfcfd' }}>
          {TOPICS.map((t) => (
            <div
              key={t.key}
              onClick={() => setTopic(t.key)}
              className={topic === t.key ? undefined : 'hov-nav'}
              style={{
                padding: '8px 16px', fontSize: 12.5, cursor: 'pointer',
                ...(topic === t.key
                  ? { background: '#e7f0f9', color: '#1f6fb2', fontWeight: 600, borderLeft: '3px solid #1f6fb2' }
                  : { color: '#4a5462', borderLeft: '3px solid transparent' }),
              }}
            >
              {t.title}
            </div>
          ))}
        </div>
        <div style={{ flex: 1, padding: '16px 22px' }}>
          <div style={{ fontWeight: 700, color: '#26303c', marginBottom: 10 }}>{cur.title}</div>
          {cur.lines.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: 12.5, color: '#3a4350', lineHeight: 1.6 }}>
              <span style={{ color: '#1f6fb2', fontWeight: 700 }}>·</span>
              <span>{l}</span>
            </div>
          ))}
          {topic !== 'data' && (
            <div
              onClick={() => {
                const page = ({ spc: 'spc', capability: 'capability', msa: 'gagerr', hypo: 'anova', doe: 'doe', aql: 'aql' } as const)[topic];
                if (page) {
                  goTo(page);
                  onClose();
                }
              }}
              style={{ display: 'inline-block', marginTop: 14, padding: '6px 14px', border: '1px solid #bcd6ee', color: '#1f6fb2', borderRadius: 5, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
            >
              打开对应模块 →
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
