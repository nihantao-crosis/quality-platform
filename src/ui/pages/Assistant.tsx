/** 助手 — Minitab 式引导:逐层回答问题,最终推荐并跳转到正确的分析模块。 */
import { useState } from 'react';
import { useApp } from '../../store/appStore';
import { PAGES } from '../pagesMeta';
import { ROOT, getNode, isRec, type Recommendation } from '../assistant/decisionTree';

export function Assistant() {
  const { goTo, setSpcType, setHypoTab, showToast } = useApp();
  // 路径栈:记录已选择的问题节点 id(不含当前)。当前节点 = cur。
  const [path, setPath] = useState<string[]>([]);
  const [cur, setCur] = useState<string>(ROOT);
  const node = getNode(cur);

  const reset = () => { setPath([]); setCur(ROOT); };
  const back = () => {
    const p = [...path];
    const prev = p.pop() ?? ROOT;
    setPath(p);
    setCur(prev);
  };
  const choose = (to: string) => { setPath((p) => [...p, cur]); setCur(to); };

  const start = (rec: Recommendation) => {
    if (rec.setup?.spcType) setSpcType(rec.setup.spcType);
    if (rec.setup?.hypoTab) setHypoTab(rec.setup.hypoTab);
    goTo(rec.page);
    showToast(`助手已为你打开「${rec.module}」`);
  };

  // 面包屑:每一步选了哪个选项
  const crumbs = path.map((qid, i) => {
    const q = getNode(qid);
    if (!q || q.kind !== 'q') return '';
    const nextId = i + 1 < path.length ? path[i + 1] : cur;
    return q.choices.find((c) => c.to === nextId)?.label ?? '';
  }).filter(Boolean);

  if (!node) return <div style={{ color: '#8a929d' }}>助手节点缺失。</div>;

  return (
    <div style={{ maxWidth: 860 }}>
      <Header onReset={reset} />

      {crumbs.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, margin: '4px 0 16px', fontSize: 12.5, color: '#5b6472' }}>
          <span
            className="hov-act"
            onClick={reset}
            style={{ color: '#1f6fb2', cursor: 'pointer', fontWeight: 500 }}
          >
            开始
          </span>
          {crumbs.map((c, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: '#c2c8d0' }}>›</span>
              <span style={{ background: '#eef4fa', color: '#2b6aa0', borderRadius: 4, padding: '2px 8px' }}>{c}</span>
            </span>
          ))}
        </div>
      )}

      {isRec(node) ? (
        <RecCard rec={node} onStart={() => start(node)} onBack={back} onReset={reset} />
      ) : (
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: '#26303c', margin: '2px 0 14px' }}>{node.prompt}</div>
          <div style={{ display: 'grid', gap: 10 }}>
            {node.choices.map((c) => (
              <div
                key={c.to}
                className="hov-card"
                onClick={() => choose(c.to)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', background: '#fff',
                  border: '1px solid #e0e4ea', borderRadius: 8, cursor: 'pointer',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: '#2b3440' }}>{c.label}</div>
                  {c.hint && <div style={{ fontSize: 12.5, color: '#8a929d', marginTop: 3 }}>{c.hint}</div>}
                </div>
                <span style={{ color: '#1f6fb2', fontSize: 18, fontWeight: 300 }}>›</span>
              </div>
            ))}
          </div>
          {path.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <BackBtn onClick={back} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Header({ onReset }: { onReset: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: 18 }}>
      <div style={{ width: 40, height: 40, borderRadius: 10, background: 'linear-gradient(135deg,#2b83c4,#1f6fb2)', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 'none', color: '#fff', fontSize: 20 }}>✦</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: '#26303c' }}>不确定该用哪个分析?让助手带你选。</div>
        <div style={{ fontSize: 12.5, color: '#8a929d', marginTop: 3 }}>回答几个关于你的目标与数据的问题,助手会推荐合适的模块并说明理由,一键进入。</div>
      </div>
      <div className="hov-act" onClick={onReset} style={{ padding: '6px 12px', border: '1px solid #cfd5dd', borderRadius: 5, cursor: 'pointer', fontSize: 12.5, color: '#3a4350', background: '#fff', flex: 'none' }}>重新开始</div>
    </div>
  );
}

function RecCard({ rec, onStart, onBack, onReset }: { rec: Recommendation; onStart: () => void; onBack: () => void; onReset: () => void }) {
  const meta = PAGES.find((p) => p.key === rec.page);
  return (
    <div style={{ background: '#fff', border: '1px solid #d8e6f2', borderRadius: 10, overflow: 'hidden' }}>
      <div style={{ background: 'linear-gradient(135deg,#eaf3fb,#f5f9fd)', padding: '16px 20px', borderBottom: '1px solid #e3edf6' }}>
        <div style={{ fontSize: 12, color: '#7a93a8', fontWeight: 600, letterSpacing: '0.04em' }}>助手推荐</div>
        <div style={{ fontSize: 19, fontWeight: 700, color: '#1c4e7a', marginTop: 4 }}>{rec.module}</div>
        {meta && <div style={{ fontSize: 12.5, color: '#6b8299', marginTop: 2 }}>模块:{meta.label}</div>}
      </div>
      <div style={{ padding: '18px 20px', display: 'grid', gap: 14 }}>
        <Field label="这个分析做什么" text={rec.what} />
        <Field label="需要什么数据" text={rec.needs} />
        <Field label="为什么推荐它" text={rec.why} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '0 20px 18px' }}>
        <div
          className="hov-act-primary"
          onClick={onStart}
          style={{ padding: '9px 20px', border: '1px solid #1f6fb2', borderRadius: 6, cursor: 'pointer', fontSize: 13.5, color: '#fff', background: '#1f6fb2', fontWeight: 600 }}
        >
          开始分析 →
        </div>
        <BackBtn onClick={onBack} />
        <div className="hov-act" onClick={onReset} style={{ padding: '8px 14px', border: '1px solid #cfd5dd', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: '#3a4350', background: '#fff' }}>重新开始</div>
      </div>
    </div>
  );
}

function Field({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: '#98a1ac', fontWeight: 600, letterSpacing: '0.04em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 13.5, color: '#3a4350', lineHeight: 1.65 }}>{text}</div>
    </div>
  );
}

function BackBtn({ onClick }: { onClick: () => void }) {
  return (
    <div className="hov-act" onClick={onClick} style={{ padding: '8px 14px', border: '1px solid #cfd5dd', borderRadius: 6, cursor: 'pointer', fontSize: 13, color: '#3a4350', background: '#fff' }}>← 上一步</div>
  );
}
