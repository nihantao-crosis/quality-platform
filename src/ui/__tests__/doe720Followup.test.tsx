/** 人工审核720·DOE 收口：残差图共轴、轴题语义、随机种子审计。 @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import App from '../../App';
import { useApp } from '../../store/appStore';
import { useData } from '../../store/dataStore';
import { chartTokens } from '../tokens';
import { MiniHist } from '../charts/misc';
import { NormalProbPlot, residualAxisScale } from '../charts/NormalProbPlot';
import { alignUnrandomizedDoeOrders } from '../pages/Doe';

const T = chartTokens('经典', true);

function axisLabels(markup: string, y: number): string[] {
  const host = document.createElement('div');
  host.innerHTML = markup;
  return [...host.querySelectorAll(`text[y="${y}"]`)].map((node) => node.textContent ?? '');
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useData.getState().resetDemo();
  useApp.setState({ page: 'doe', doeTab: 'create', modal: null, openMenu: null });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DOE 残差四联图共享横轴', () => {
  it('正态概率图与直方图使用相同 domain 和刻度', () => {
    const data = [-12.2, -8, -3.1, 0, 2.2, 7.7, 11.9, Number.POSITIVE_INFINITY];
    const scale = residualAxisScale(data);
    const normal = renderToStaticMarkup(<NormalProbPlot T={T} data={data} h={220} xLabel="标准化残差" xDomain={scale.domain} xTicks={scale.ticks} />);
    const hist = renderToStaticMarkup(<MiniHist T={T} data={data} h={220} title="标准化残差分布" xLabel="标准化残差" xDomain={scale.domain} xTicks={scale.ticks} />);

    expect(axisLabels(normal, 196)).toEqual(axisLabels(hist, 196));
    expect(axisLabels(normal, 196)).toHaveLength(scale.ticks.length);
    expect(normal).not.toMatch(/(?:x|y|cx|cy)="(?:NaN|Infinity)/);
    expect(hist).not.toMatch(/(?:x|y|width|height)="(?:NaN|Infinity)/);
  });

  it('正规/标准化/删后残差的标题与横轴各自准确', () => {
    for (const label of ['残差', '标准化残差', '删后残差']) {
      const markup = renderToStaticMarkup(<MiniHist T={T} data={[-2, -1, 0, 1, 2]} h={220} title={`${label}分布`} xLabel={label} />);
      expect(markup).toContain(`${label}分布`);
      expect(axisLabels(markup, 212)).toEqual([label]);
    }
  });

  it('常数、单点、小样本及全部非有限值不输出非法坐标', () => {
    for (const data of [[0], [5, 5, 5], [Number.NaN, Number.POSITIVE_INFINITY]]) {
      const scale = residualAxisScale(data);
      expect(scale.domain.every(Number.isFinite)).toBe(true);
      expect(scale.domain[1]).toBeGreaterThan(scale.domain[0]);
      const normal = renderToStaticMarkup(<NormalProbPlot T={T} data={data} h={180} />);
      const hist = renderToStaticMarkup(<MiniHist T={T} data={data} h={180} />);
      expect(normal).not.toMatch(/(?:x|y|cx|cy)="(?:NaN|Infinity)/);
      expect(hist).not.toMatch(/(?:x|y|width|height)="(?:NaN|Infinity)/);
    }
  });
});

describe('DOE 随机化可复现与审计', () => {
  it('关闭随机化不读随机源，数据集名记录未随机，标准序=运行序', () => {
    const random = vi.spyOn(Math, 'random');
    render(<App />);
    fireEvent.click(screen.getByRole('checkbox', { name: '随机化运行序' }));
    fireEvent.click(screen.getByLabelText('将设计存储在工作表中'));
    fireEvent.click(screen.getByRole('button', { name: '生成设计预览' }));

    expect(random).not.toHaveBeenCalled();
    expect(screen.getByText(/设计预览 · DOE设计_.*_未随机/)).toBeTruthy();
    const rows = screen.getByText(/设计预览 · DOE设计_/).parentElement?.querySelectorAll('tbody tr') ?? [];
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      expect(cells[0].textContent).toBe(cells[1].textContent);
    }
  });

  it('自动模式连续生成换 seed，并把两次实际 seed 写入预览数据集名', () => {
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1).mockReturnValueOnce(0.2);
    render(<App />);
    fireEvent.click(screen.getByLabelText('将设计存储在工作表中'));
    const generate = screen.getByRole('button', { name: '生成设计预览' });
    fireEvent.click(generate);
    const first = screen.getByText(/设计预览 · DOE设计_/).textContent ?? '';
    fireEvent.click(generate);
    const second = screen.getByText(/设计预览 · DOE设计_/).textContent ?? '';

    expect(first).toContain('自动seed-');
    expect(second).toContain('自动seed-');
    expect(second).not.toBe(first);
  });

  it('固定 seed 连续生成可复现，名称持续记录同一种子', () => {
    render(<App />);
    fireEvent.click(screen.getByLabelText('将设计存储在工作表中'));
    fireEvent.change(screen.getByLabelText('随机化种子模式'), { target: { value: 'fixed' } });
    const seedInput = screen.getByLabelText('随机化种子模式').parentElement!.querySelector('input')!;
    fireEvent.change(seedInput, { target: { value: '42' } });
    const generate = screen.getByRole('button', { name: '生成设计预览' });
    fireEvent.click(generate);
    const panel = screen.getByText(/设计预览 · DOE设计_/).parentElement!;
    const firstRows = panel.querySelector('tbody')!.textContent;
    expect(panel.textContent).toContain('固定seed-42');
    fireEvent.click(generate);
    const nextPanel = screen.getByText(/设计预览 · DOE设计_/).parentElement!;
    expect(nextPanel.querySelector('tbody')!.textContent).toBe(firstRows);
    expect(nextPanel.textContent).toContain('固定seed-42');
  });

  it('未随机排序按原标准序恢复因子组合与文本元数据，且不改原对象', () => {
    const source = {
      rows: [[3, 1, 2, 30], [1, 2, 1, 10], [2, 3, 2, 20]],
      textCols: [{ name: '点类型', values: ['中心点', '因子点A', '因子点B'] }],
    };
    const aligned = alignUnrandomizedDoeOrders(source);
    expect(aligned.rows).toEqual([
      [1, 1, 1, 10],
      [2, 2, 2, 20],
      [3, 3, 2, 30],
    ]);
    expect(aligned.textCols?.[0].values).toEqual(['因子点A', '因子点B', '中心点']);
    expect(source.rows).toEqual([[3, 1, 2, 30], [1, 2, 1, 10], [2, 3, 2, 20]]);
    expect(source.textCols[0].values).toEqual(['中心点', '因子点A', '因子点B']);
  });
});
