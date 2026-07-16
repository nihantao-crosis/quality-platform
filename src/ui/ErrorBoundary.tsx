/**
 * 页面级错误边界 — 任一模块崩溃时显示可恢复的错误卡,而非整应用白屏。
 */
import { Component, type ReactNode } from 'react';
import { useData } from '../store/dataStore';

interface Props {
  children: ReactNode;
  /** 变化时自动重置错误态（如切换页面/数据集） */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{ background: '#fff', border: '1px solid #f0d3d3', borderRadius: 5, padding: '28px 32px', boxShadow: '0 1px 2px rgba(20,30,50,0.04)' }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: '#c22f2f', marginBottom: 8 }}>页面渲染出错</div>
        <div className="mono" style={{ fontSize: 12, color: '#8a929d', marginBottom: 16, whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
          {error.message}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button"
            onClick={() => this.setState({ error: null })}
            style={{ padding: '7px 16px', border: 0, background: '#1f6fb2', color: '#fff', borderRadius: 5, fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
          >
            重试
          </button>
          <button type="button"
            onClick={() => {
              useData.getState().resetDemo();
              this.setState({ error: null });
            }}
            style={{ padding: '7px 16px', border: '1px solid #cfd5dd', background: '#fff', color: '#5b6472', borderRadius: 5, fontFamily: 'inherit', fontSize: 12.5, cursor: 'pointer' }}
          >
            恢复演示数据集并重试
          </button>
        </div>
        <div style={{ fontSize: 11.5, color: '#9aa2ad', marginTop: 14 }}>
          若反复出现,可能是导入数据异常;其他页面不受影响。
        </div>
      </div>
    );
  }
}
