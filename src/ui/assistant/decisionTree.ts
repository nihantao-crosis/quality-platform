/**
 * 助手决策树（对标 Minitab Assistant）——纯数据 + 遍历，无 store 依赖，便于单测。
 *
 * 结构：一张 id → 节点 的表。节点要么是「问题」(kind:'q', 含若干选项，每项指向下一节点)，
 * 要么是「推荐」(kind:'rec', 叶子：目标模块 + 进入前要套用的参数 + 三句话解释)。
 * Assistant 页面从 ROOT 出发逐层下钻；到达 rec 时套用 setup 并 goTo(page)。
 */
import type { Page, SpcType, HypoTab } from '../../store/appStore';

export interface RecSetup {
  spcType?: SpcType;
  hypoTab?: HypoTab;
}

export interface Recommendation {
  kind: 'rec';
  id: string;
  /** 推荐模块的展示名 */
  module: string;
  /** 目标页面 */
  page: Page;
  /** 进入前套用的参数（控制图类型 / 假设检验标签） */
  setup?: RecSetup;
  /** 这个分析做什么 */
  what: string;
  /** 需要什么数据 */
  needs: string;
  /** 为什么推荐它 */
  why: string;
}

export interface Choice {
  label: string;
  hint?: string;
  /** 指向下一节点的 id */
  to: string;
}

export interface Question {
  kind: 'q';
  id: string;
  prompt: string;
  choices: Choice[];
}

export type TreeNode = Question | Recommendation;

export const ROOT = 'root';

export const TREE: Record<string, TreeNode> = {
  root: {
    kind: 'q',
    id: 'root',
    prompt: '你现在想解决什么问题?',
    choices: [
      { label: '监控过程随时间是否稳定', hint: '判断有没有异常波动、是否受控', to: 'spc_type' },
      { label: '评估过程是否满足规格要求', hint: '算合格率、Cp/Cpk/Ppk', to: 'rec_capability' },
      { label: '比较不同组或条件之间有无差异', hint: '两台设备、三条产线的均值是否不同', to: 'hyp_groups' },
      { label: '研究两个变量之间的关系', hint: '温度与强度、转速与粗糙度是否相关', to: 'rec_regression' },
      { label: '评估测量数据本身是否可靠', hint: '量具/操作员带来的测量变异有多大', to: 'rec_gage' },
      { label: '找出占比最大的缺陷或问题来源', hint: '按缺陷类别排序、二八定律', to: 'rec_pareto' },
      { label: '研究多个因子对结果的影响并寻优', hint: '温度/压力/时间怎样组合最好', to: 'rec_doe' },
      { label: '制定进货或出货的抽样验收方案', hint: '一批货抽多少、允收几个不良', to: 'rec_aql' },
    ],
  },

  spc_type: {
    kind: 'q',
    id: 'spc_type',
    prompt: '你要监控的数据是哪种类型?',
    choices: [
      { label: '连续测量值', hint: '尺寸、重量、温度、时间等能读小数的量', to: 'spc_subgroup' },
      { label: '计数数据', hint: '不良品个数、缺陷点数等整数计数', to: 'spc_count' },
    ],
  },
  spc_subgroup: {
    kind: 'q',
    id: 'spc_subgroup',
    prompt: '每个时间点(子组)采集多少个样本?',
    choices: [
      { label: '每次采集多个,子组 2–8 个', hint: '典型抽检:每小时量 5 件', to: 'rec_xbarr' },
      { label: '每次采集多个,子组 ≥9 个', hint: '子组较大时用标准差更稳', to: 'rec_xbars' },
      { label: '每次只有一个测量值', hint: '如每炉一个化验值、按件全检', to: 'rec_imr' },
    ],
  },
  spc_count: {
    kind: 'q',
    id: 'spc_count',
    prompt: '你统计的是哪一种计数?',
    choices: [
      { label: '不合格品的“件数”', hint: '每件判定合格/不合格,数不良品件数', to: 'rec_p' },
      { label: '一个单位上的“缺陷点数”', hint: '一块板可有多处划痕,数缺陷点', to: 'rec_c' },
    ],
  },

  hyp_groups: {
    kind: 'q',
    id: 'hyp_groups',
    prompt: '你要比较多少组?',
    choices: [
      { label: '一组数据与一个目标值比较', hint: '产品均值是否达到标称 25.0', to: 'rec_t1' },
      { label: '两组之间比较', hint: '新旧工艺、两台设备的均值差异', to: 'rec_t2' },
      { label: '三组及以上比较', hint: '多台设备/多条产线一起比', to: 'rec_anova' },
    ],
  },

  rec_capability: {
    kind: 'rec',
    id: 'rec_capability',
    module: '过程能力分析 (Cp/Cpk/Ppk)',
    page: 'capability',
    what: '把过程分布与规格上下限对比,给出合格率与 Cp/Cpk/Ppk/Cpm 等能力指数。',
    needs: '一列连续测量值 + 规格上限/下限(可只填单侧),数据应大致服从正态。',
    why: '你要回答“过程能不能满足规格”,能力分析正是把过程变异折算成 Cpk 的标准方法。',
  },
  rec_regression: {
    kind: 'rec',
    id: 'rec_regression',
    module: '回归与散点图',
    page: 'anova',
    setup: { hypoTab: 'reg' },
    what: '拟合 Y 随 X 变化的直线,给出斜率、R² 与散点图,量化两变量的关系强弱。',
    needs: '两列成对的连续数据(自变量 X 与因变量 Y),长度相同。',
    why: '你关心的是“两个量是否相关、如何相互影响”,回归/散点图直接刻画这种关系。',
  },
  rec_gage: {
    kind: 'rec',
    id: 'rec_gage',
    module: '测量系统分析 (Gage R&R)',
    page: 'gagerr',
    what: '用交叉设计把总变异拆成量具重复性、操作员再现性与部件差异,判断测量系统是否可信。',
    needs: '多名操作员对多个部件各重复测量若干次的数据(操作员×部件×次数)。',
    why: '在相信任何数据之前,先确认“测量本身够不够准”——这是量具 R&R 的职责。',
  },
  rec_pareto: {
    kind: 'rec',
    id: 'rec_pareto',
    module: '帕累托图',
    page: 'pareto',
    what: '按缺陷类别的数量降序排列并叠加累计百分比曲线,凸显“少数关键”的问题来源。',
    needs: '各缺陷类别及其出现次数(计数)。',
    why: '你要“抓主要矛盾”,帕累托图用二八定律帮你锁定最该先解决的少数类别。',
  },
  rec_doe: {
    kind: 'rec',
    id: 'rec_doe',
    module: '实验设计 (DOE)',
    page: 'doe',
    what: '用全因子/析因设计同时评估多个因子及其交互作用对响应的影响,并给出主效应与最优组合。',
    needs: '按设计矩阵取得的各因子水平组合及对应响应值。',
    why: '同时研究多个因子并寻优时,DOE 比逐个试更省次数、还能发现因子间的交互作用。',
  },
  rec_aql: {
    kind: 'rec',
    id: 'rec_aql',
    module: '抽样检验 (AQL 方案)',
    page: 'aql',
    what: '按 GB/T 2828.1 由批量、检验水平与 AQL 查出样本量 n 与允收/拒收数 Ac/Re。',
    needs: '批量大小、检验水平(默认 II)、可接受质量限 AQL。',
    why: '你要“定一批货抽多少、允收几个不良”,AQL 抽样方案给出成文可执行的验收规则。',
  },

  rec_xbarr: {
    kind: 'rec',
    id: 'rec_xbarr',
    module: 'X̄-R 控制图',
    page: 'spc',
    setup: { spcType: 'xbar-r' },
    what: '用均值图监控过程中心、极差图监控组内波动,配合 Nelson 判异规则识别失控点。',
    needs: '按时间顺序、等大小的子组(每组 2–8 个测量值)。',
    why: '子组较小(≤8)时,用极差 R 估计组内变异既简单又稳健,是最常用的连续型控制图。',
  },
  rec_xbars: {
    kind: 'rec',
    id: 'rec_xbars',
    module: 'X̄-S 控制图',
    page: 'spc',
    setup: { spcType: 'xbar-s' },
    what: '用均值图监控中心、标准差图监控组内波动,适合较大子组的过程监控。',
    needs: '按时间顺序的子组,每组样本较多(≥9 个)。',
    why: '子组较大时标准差 S 比极差 R 更能有效利用组内信息,估计更精确。',
  },
  rec_imr: {
    kind: 'rec',
    id: 'rec_imr',
    module: 'I-MR 单值-移动极差图',
    page: 'spc',
    setup: { spcType: 'i-mr' },
    what: '用单值图监控每个观测、移动极差图估计短期变异,适合无法分组的逐点数据。',
    needs: '按时间顺序的单列测量值(每个时间点只有一个数)。',
    why: '当每次只能得到一个测量值(如每炉一次化验)时,I-MR 是标准做法。',
  },
  rec_p: {
    kind: 'rec',
    id: 'rec_p',
    module: 'P 控制图 (不良率)',
    page: 'spc',
    setup: { spcType: 'p' },
    what: '监控各批的不合格品比例,控制限随样本量变化,识别不良率的异常波动。',
    needs: '每批的样本量与其中的不合格品件数。',
    why: '当数据是“每件合格/不合格”的计数、且样本量可变时,P 图是对应的属性控制图。',
  },
  rec_c: {
    kind: 'rec',
    id: 'rec_c',
    module: 'C 控制图 (缺陷数)',
    page: 'spc',
    setup: { spcType: 'c' },
    what: '监控每个检验单位上的缺陷点数,基于泊松分布设定控制限。',
    needs: '等大小检验单位上的缺陷点数计数。',
    why: '当一个单位上可出现多处缺陷、且检验单位大小一致时,C 图是恰当的属性控制图。',
  },

  rec_t1: {
    kind: 'rec',
    id: 'rec_t1',
    module: '单样本 t 检验',
    page: 'anova',
    setup: { hypoTab: 't1' },
    what: '检验一组数据的均值是否等于给定目标值,给出 t 统计量、p 值与置信区间。',
    needs: '一列连续数据 + 一个要比较的目标值。',
    why: '你要判断“一组产品的均值是否达到标称值”,单样本 t 检验正是为此设计。',
  },
  rec_t2: {
    kind: 'rec',
    id: 'rec_t2',
    module: '双样本 t 检验 (Welch)',
    page: 'anova',
    setup: { hypoTab: 't2' },
    what: '比较两组独立数据的均值是否存在显著差异(不假定方差相等的 Welch 法)。',
    needs: '两组各自的连续测量值,两组可长度不同。',
    why: '只比较两组时,双样本 t 检验比 ANOVA 更直接,Welch 法对方差不等也稳健。',
  },
  rec_anova: {
    kind: 'rec',
    id: 'rec_anova',
    module: '单因子方差分析 (ANOVA)',
    page: 'anova',
    setup: { hypoTab: 'anova' },
    what: '一次性检验三组及以上的均值是否全部相等,给出 F 统计量与 p 值。',
    needs: '一个分组因子(≥3 个水平)与对应的连续响应值。',
    why: '比较三组以上若两两做 t 检验会累积误判风险,ANOVA 用一次检验控制总体错误率。',
  },
};

export function getNode(id: string): TreeNode | undefined {
  return TREE[id];
}

export function isRec(n: TreeNode | undefined): n is Recommendation {
  return !!n && n.kind === 'rec';
}
