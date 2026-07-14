import { describe, expect, it } from 'vitest';
import { computeVarModel } from '../model';
import { parseMatrix } from '../csv';
import { numericSpcRole, prepareSpcData, spcMeasurementColumnNames, spcRoleOptions, textSpcRole } from '../spcData';

describe('SPC 数据角色与形态转换', () => {
  it('人工反馈行式样例：数值“子组”只作标签，不进入 5 次直径测量', () => {
    const model = computeVarModel('黄广洋样例', ['子组', '直径1', '直径2', '直径3', '直径4', '直径5'], [
      [1, 4.5, 10.1, 13.5, 11.0, 11.1],
      [2, 8.1, 10.7, 5.8, 3.1, 8.7],
      [3, 11.1, 4.7, 11.6, 3.8, 10.4],
    ]);
    const prepared = prepareSpcData(model, [], { layout: 'auto', valueColumn: null, subgroupColumn: null });
    expect(prepared.error).toBeUndefined();
    expect(prepared.layout).toBe('rows');
    expect(prepared.model?.n).toBe(5);
    expect(prepared.model?.subs[0].vals).toEqual([4.5, 10.1, 13.5, 11.0, 11.1]);
    expect(prepared.model?.subs[0].mean).toBeCloseTo(10.04, 10);
    expect(prepared.subgroupLabels).toEqual(['1', '2', '3']);
    expect(prepared.subgroupColumn).toBe(numericSpcRole('子组'));
    expect(prepared.variableName).toBe('直径');
    expect(prepared.note).toContain('未参与测量计算');
  });

  it('常用堆叠格式支持文本子组 ID，并提升组内恒定阶段列', () => {
    const model = computeVarModel('堆叠文本', ['直径'], [[10], [11], [20], [21]]);
    const text = [
      { name: '批次', values: ['A', 'A', 'B', 'B'] },
      { name: '阶段', values: ['改善前', '改善前', '改善后', '改善后'] },
    ];
    const prepared = prepareSpcData(model, text, { layout: 'auto', valueColumn: null, subgroupColumn: null });
    expect(prepared.error).toBeUndefined();
    expect(prepared.layout).toBe('stacked');
    expect(prepared.model?.subs.map((s) => s.vals)).toEqual([[10, 11], [20, 21]]);
    expect(prepared.subgroupLabels).toEqual(['A', 'B']);
    expect(prepared.subgroupColumn).toBe(textSpcRole('批次'));
    expect(prepared.textCols).toEqual([{ name: '阶段', values: ['改善前', '改善后'] }]);
  });

  it('堆叠表同时有唯一数值序号和重复文本批次时，优先按批次成组', () => {
    const model = computeVarModel('序号+批次', ['序号', '直径'], [
      [1, 10], [2, 11], [3, 20], [4, 21],
    ]);
    const prepared = prepareSpcData(model, [{ name: '批次', values: ['A', 'A', 'B', 'B'] }], {
      layout: 'auto', valueColumn: null, subgroupColumn: null,
    });
    expect(prepared.error).toBeUndefined();
    expect(prepared.layout).toBe('stacked');
    expect(prepared.valueColumn).toBe('直径');
    expect(prepared.subgroupColumn).toBe(textSpcRole('批次'));
    expect(prepared.model?.subs.map((subgroup) => subgroup.vals)).toEqual([[10, 11], [20, 21]]);
  });

  it('堆叠格式支持数值子组 ID，ID 不污染均值/极差', () => {
    const model = computeVarModel('堆叠数值', ['子组', '压入力'], [
      [101, 500], [101, 520], [102, 600], [102, 640],
    ]);
    const prepared = prepareSpcData(model, [], { layout: 'auto', valueColumn: null, subgroupColumn: null });
    expect(prepared.layout).toBe('stacked');
    expect(prepared.valueColumn).toBe('压入力');
    expect(prepared.model?.subs.map((s) => s.mean)).toEqual([510, 620]);
    expect(prepared.model?.n).toBe(2);
  });

  it('手动选行式但留下“自动 / 无”时，数值子组列仍不会静默进入测量', () => {
    const model = computeVarModel('行式', ['子组', '直径1', '直径2'], [
      [1, 10, 11], [2, 12, 13], [3, 14, 15],
    ]);
    const prepared = prepareSpcData(model, [], { layout: 'rows', valueColumn: null, subgroupColumn: null });
    expect(prepared.error).toBeUndefined();
    expect(prepared.model?.n).toBe(2);
    expect(prepared.model?.subs[0].vals).toEqual([10, 11]);
    expect(prepared.subgroupLabels).toEqual(['1', '2', '3']);
  });

  it('手动行式选文本点标签时，数值“子组”列仍被排除', () => {
    const model = computeVarModel('行式标签', ['子组', '测量1', '测量2'], [
      [101, 10, 11], [102, 12, 13], [103, 14, 15],
    ]);
    const prepared = prepareSpcData(model, [{ name: '日期', values: ['7/1', '7/2', '7/3'] }], {
      layout: 'rows', valueColumn: null, subgroupColumn: textSpcRole('日期'),
    });
    expect(prepared.error).toBeUndefined();
    expect(prepared.model?.n).toBe(2);
    expect(prepared.model?.subs[0].vals).toEqual([10, 11]);
    expect(prepared.subgroupLabels).toEqual(['7/1', '7/2', '7/3']);
    expect(prepared.note).toContain('数值 ID「子组」未参与测量计算');
  });

  it('手动选堆叠并只指定 ID 时，唯一数值候选列自动成为测量值', () => {
    const model = computeVarModel('堆叠', ['压入力'], [[500], [520], [600], [640]]);
    const prepared = prepareSpcData(model, [{ name: '子组', values: ['A', 'A', 'B', 'B'] }], {
      layout: 'stacked', valueColumn: null, subgroupColumn: textSpcRole('子组'),
    });
    expect(prepared.error).toBeUndefined();
    expect(prepared.valueColumn).toBe('压入力');
    expect(prepared.model?.subs.map((s) => s.vals)).toEqual([[500, 520], [600, 640]]);
  });

  it('行式重复数值批次列被排除测量后，仍可作阶段列', () => {
    const model = computeVarModel('分阶段', ['批次', '直径1', '直径2'], [
      [1, 10, 11], [1, 12, 13], [2, 14, 15], [2, 16, 17],
    ]);
    const prepared = prepareSpcData(model, [], { layout: 'rows', valueColumn: null, subgroupColumn: null });
    expect(prepared.model?.n).toBe(2);
    expect(prepared.textCols).toEqual([{ name: '批次', values: ['1', '1', '2', '2'] }]);
  });

  it('重复数值子组 ID 后存在多个候选测量列时拒绝静默混算', () => {
    const model = computeVarModel('歧义数据', ['子组', '直径', '温度'], [
      [1, 10, 20], [1, 11, 21], [2, 12, 22], [2, 13, 23],
    ]);
    const auto = prepareSpcData(model, [], { layout: 'auto', valueColumn: null, subgroupColumn: null });
    expect(auto.error).toContain('请选择哪一列是测量值');
    const explicit = prepareSpcData(model, [], {
      layout: 'stacked', valueColumn: '直径', subgroupColumn: numericSpcRole('子组'),
    });
    expect(explicit.error).toBeUndefined();
    expect(explicit.model?.subs.map((s) => s.vals)).toEqual([[10, 11], [12, 13]]);
  });

  it('堆叠数据中非测量数值列若组内恒定，只提升为阶段列', () => {
    const model = computeVarModel('数值阶段', ['子组', '阶段', '压入力'], [
      [101, 1, 500], [101, 1, 520], [102, 2, 600], [102, 2, 640],
    ]);
    const prepared = prepareSpcData(model, [], {
      layout: 'stacked', valueColumn: '压入力', subgroupColumn: numericSpcRole('子组'),
    });
    expect(prepared.model?.subs.map((s) => s.vals)).toEqual([[500, 520], [600, 640]]);
    expect(prepared.textCols).toEqual([{ name: '阶段', values: ['1', '2'] }]);
  });

  it('列式子组可超过 10 个数值列导入，并按列转为 12×5 控制图矩阵', () => {
    const names = Array.from({ length: 12 }, (_, i) => `批次${i + 1}`);
    const rows = Array.from({ length: 5 }, (_, r) => names.map((_, c) => 100 + c + r / 10));
    const text = `${names.join(',')}\n${rows.map((r) => r.join(',')).join('\n')}`;
    const parsed = parseMatrix(text);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.colNames).toHaveLength(12);
    const raw = computeVarModel('列式', parsed.colNames, parsed.rows);
    expect(raw.hasSubgroups).toBe(false); // 不会把 12 列静默当 n=12 行式子组计算控制限
    const prepared = prepareSpcData(raw, [], { layout: 'auto', valueColumn: null, subgroupColumn: null });
    expect(prepared.error).toBeUndefined();
    expect(prepared.layout).toBe('columns');
    expect(prepared.model?.k).toBe(12);
    expect(prepared.model?.n).toBe(5);
    expect(prepared.model?.subs[0].vals).toEqual([100, 100.1, 100.2, 100.3, 100.4]);
    expect(prepared.subgroupLabels).toEqual(names);
    expect(prepared.variableName).toBe('测量值');
  });

  it('超 10 列的列式数据自动排除连续“测量序号”列', () => {
    const groups = Array.from({ length: 11 }, (_, i) => `G${i + 1}`);
    const names = ['测量序号', ...groups];
    const rows = Array.from({ length: 5 }, (_, i) => [i + 1, ...groups.map((_, j) => 100 + j + i / 10)]);
    const raw = computeVarModel('带行索引列式', names, rows);
    const prepared = prepareSpcData(raw, [], { layout: 'auto', valueColumn: null, subgroupColumn: null });
    expect(prepared.error).toBeUndefined();
    expect(prepared.layout).toBe('columns');
    expect(prepared.model?.k).toBe(11);
    expect(prepared.model?.n).toBe(5);
    expect(prepared.subgroupLabels).toEqual(groups);
    expect(prepared.model?.subs[0].vals).toEqual([100, 100.1, 100.2, 100.3, 100.4]);
    expect(prepared.note).toContain('已排除 1 个数值索引列');
  });

  it('列式数据中非连续的“测量序号”也不会被当成子组', () => {
    const groups = Array.from({ length: 11 }, (_, i) => `G${i + 1}`);
    const rows = [10, 20, 40, 80, 160].map((sequence, i) => [
      sequence, ...groups.map((_, j) => 100 + j + i / 10),
    ]);
    const raw = computeVarModel('非连续索引', ['测量序号', ...groups], rows);
    const prepared = prepareSpcData(raw, [], { layout: 'auto', valueColumn: null, subgroupColumn: null });
    expect(prepared.error).toBeUndefined();
    expect(prepared.layout).toBe('columns');
    expect(prepared.subgroupLabels).toEqual(groups);
    expect(prepared.model?.k).toBe(11);
    expect(prepared.note).toContain('已排除 1 个数值索引列');
  });

  it('单值模式只使用所选列，其他数值字段不被展平', () => {
    const model = computeVarModel('单值', ['时间', '扭矩'], [[1, 10], [2, 11], [3, 12]]);
    const prepared = prepareSpcData(model, [], {
      layout: 'individuals', valueColumn: '扭矩', subgroupColumn: numericSpcRole('时间'),
    });
    expect(prepared.error).toBeUndefined();
    expect(prepared.model?.indiv).toEqual([10, 11, 12]);
    expect(prepared.subgroupLabels).toEqual(['1', '2', '3']);
  });

  it('不等大小堆叠子组给出可操作错误', () => {
    const model = computeVarModel('不等组', ['直径'], [[10], [11], [12], [20], [21]]);
    const prepared = prepareSpcData(model, [{ name: '批次', values: ['A', 'A', 'A', 'B', 'B'] }], {
      layout: 'stacked', valueColumn: '直径', subgroupColumn: textSpcRole('批次'),
    });
    expect(prepared.error).toContain('组内样本量不一致');
  });

  it('行式子组会拦截实际测量列中的待录入值', () => {
    const model = computeVarModel('行式待录入', ['子组', '测量1', '测量2'], [
      [1, 10, 11], [2, 12, 13], [3, 14, 15],
    ]);
    const prepared = prepareSpcData(model, [], {
      layout: 'auto', valueColumn: null, subgroupColumn: null,
      pendingCells: [{ row: 1, col: 2 }],
    });
    expect(prepared.model).toBeNull();
    expect(prepared.error).toContain('1 个待录入单元格');
  });

  it('堆叠格式会拦截测量值或数值子组 ID 中的待录入值', () => {
    const model = computeVarModel('堆叠待录入', ['子组', '测量值'], [
      [1, 10], [1, 11], [2, 12], [2, 13],
    ]);
    for (const pendingCells of [[{ row: 0, col: 1 }], [{ row: 0, col: 0 }]]) {
      const prepared = prepareSpcData(model, [], {
        layout: 'stacked', valueColumn: '测量值', subgroupColumn: numericSpcRole('子组'), pendingCells,
      });
      expect(prepared.error).toContain('1 个待录入单元格');
    }
  });

  it('列式子组只拦截参与转置的子组列，排除的索引列不影响分析', () => {
    const names = ['测量序号', ...Array.from({ length: 11 }, (_, i) => `G${i + 1}`)];
    const rows = Array.from({ length: 5 }, (_, row) => [row + 1, ...Array.from({ length: 11 }, (_, col) => 100 + col + row / 10)]);
    const model = computeVarModel('列式待录入', names, rows);
    const ignored = prepareSpcData(model, [], {
      layout: 'auto', valueColumn: null, subgroupColumn: null, pendingCells: [{ row: 0, col: 0 }],
    });
    expect(ignored.error).toBeUndefined();
    const blocked = prepareSpcData(model, [], {
      layout: 'auto', valueColumn: null, subgroupColumn: null, pendingCells: [{ row: 0, col: 1 }],
    });
    expect(blocked.error).toContain('1 个待录入单元格');
  });

  it('单值格式只拦截所选测量值或数值点标签，不被无关数值列误伤', () => {
    const model = computeVarModel('单值待录入', ['序号', '扭矩', '温度'], [
      [1, 10, 100], [2, 11, 110], [3, 12, 120],
    ]);
    const ignored = prepareSpcData(model, [], {
      layout: 'individuals', valueColumn: '扭矩', subgroupColumn: numericSpcRole('序号'),
      pendingCells: [{ row: 0, col: 2 }],
    });
    expect(ignored.error).toBeUndefined();
    const blocked = prepareSpcData(model, [], {
      layout: 'individuals', valueColumn: '扭矩', subgroupColumn: numericSpcRole('序号'),
      pendingCells: [{ row: 0, col: 1 }, { row: 1, col: 0 }],
    });
    expect(blocked.error).toContain('2 个待录入单元格');
  });

  it('不同物理量的业务列在自动模式下阻断混算，明确选择响应后按 I-MR 分析', () => {
    const model = computeVarModel('压装 DOE', ['过盈量', '轴硬度', '压入力'], [
      [0.045, 28, 970], [0.09, 32, 940], [0.0675, 30, 980], [0.0675, 30, 690],
      [0.045, 32, 1380], [0.09, 28, 1180], [0.0675, 30, 530],
    ]);
    const auto = prepareSpcData(model, [], { layout: 'auto', valueColumn: null, subgroupColumn: null });
    expect(auto.model).toBeNull();
    expect(auto.error).toContain('多个名称不同的业务数值列');
    const chosen = prepareSpcData(model, [], { layout: 'auto', valueColumn: '压入力', subgroupColumn: null });
    expect(chosen.error).toBeUndefined();
    expect(chosen.layout).toBe('individuals');
    expect(chosen.model?.indiv).toEqual([970, 940, 980, 690, 1380, 1180, 530]);
  });

  it('DOE 元数据和存储输出不进入 SPC 测量候选，写回前后所选响应口径不变', () => {
    const rows = [
      [1, 1, 1, 0.045, 28, 970, 900, 70, 0.5],
      [2, 2, 1, 0.09, 32, 940, 950, -10, -0.1],
      [3, 3, 1, 0.0675, 30, 980, 960, 20, 0.2],
    ];
    const names = ['标准序', '运行序', '区组', '过盈量', '轴硬度', '压入力', 'DOE拟合值', 'DOE残差', 'DOE标准化残差'];
    const model = computeVarModel('DOE 写回', names, rows);
    expect(spcMeasurementColumnNames(model)).toEqual(['过盈量', '轴硬度', '压入力']);
    expect(spcRoleOptions(model, [{ name: 'DOE模型项', values: ['常量', '过盈量', '轴硬度'] }]).map((role) => role.name))
      .not.toContain('DOE模型项');
    const prepared = prepareSpcData(model, [], { layout: 'individuals', valueColumn: '压入力', subgroupColumn: null });
    expect(prepared.model?.indiv).toEqual([970, 940, 980]);
    expect(prepared.note).toContain('其他数值列未进入 I-MR 计算');
  });
});
