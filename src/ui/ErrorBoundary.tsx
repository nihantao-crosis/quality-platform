/**
 * 错误边界 — 任一模块崩溃时显示可恢复的错误卡,而非整应用白屏。
 * 默认渲染页面级错误卡;壳层/对话框层通过 fallback 自定义恢复入口(fix2609c UI-02)。
 */
import { Component, type ReactNode } from 'react';
import { useData } from '../store/dataStore';
import { errText } from '../platform/adapter';

/**
 * 错误卡「恢复演示数据集」逃生口(页面级与壳层错误卡共用)。resetDemo 先过数据集替换闸门:
 * 最近数据集列表尚未落盘等情况下会抛错拒绝替换(STORE-07 复核残余)。错误卡的按钮处理器里
 * 抛出会变成未捕获异常、按钮看起来毫无反应;这里接住并返回可直接显示的原因。成功返回 null。
 */
export function recoverDemoDataset(): string | null {
  try {
    useData.getState().resetDemo();
    return null;
  } catch (error) {
    return `未能恢复演示数据集：${errText(error)}`;
  }
}

interface Props {
  children: ReactNode;
  /** 变化时自动重置错误态（如切换页面/数据集） */
  resetKey?: string;
  /** 自定义错误卡;reset 清除错误态并重新渲染子树。缺省为页面级错误卡。 */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
  /** 「恢复演示数据集」被拒绝时的原因(就地显示;错误卡可能盖住了全局 toast)。 */
  recoverError?: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, recoverError: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null, recoverError: null });
    }
  }

  private readonly reset = () => this.setState({ error: null, recoverError: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(error, this.reset);
    return (
      <div style={{ background: '#fff', border: '1px solid #f0d3d3', borderRadius: 5, padding: '28px 32px', boxShadow: '0 1px 2px rgba(20,30,50,0.04)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#c22f2f', marginBottom: 8 }}>页面渲染出错</div>
        <div className="mono" style={{ fontSize: 12, color: '#8a929d', marginBottom: 16, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
          {error.message}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button"
            onClick={this.reset}
            style={{ padding: '7px 16px', border: 0, background: '#1f6fb2', color: '#fff', borderRadius: 5, fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
          >
            重试
          </button>
          <button type="button"
            onClick={() => {
              const recoverError = recoverDemoDataset();
              if (recoverError) this.setState({ recoverError });
              else this.reset();
            }}
            style={{ padding: '7px 16px', border: '1px solid #cfd5dd', background: '#fff', color: '#5b6472', borderRadius: 5, fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer' }}
          >
            恢复演示数据集并重试
          </button>
        </div>
        {this.state.recoverError && (
          <div role="alert" style={{ fontSize: 12, color: '#c22f2f', marginTop: 12, lineHeight: 1.6 }}>{this.state.recoverError}</div>
        )}
        <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 14 }}>
          若反复出现,可能是导入数据异常;其他页面不受影响。
        </div>
      </div>
    );
  }
}
