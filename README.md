# 质量分析平台（Quality Analytics Platform）

类 Minitab 的工厂质量部门统计分析工具 — 依据 `../design_handoff_quality_platform/` 交接文档,
从设计原型 `质量分析平台.dc.html` 重新实现为 **React 18 + TypeScript + Vite** 应用。

## 运行

```bash
npm install
npm run dev            # Web 端 http://localhost:5188
npm test               # vitest 统计引擎对拍测试（23 项）
npm run build          # Web 生产构建
npm run tauri dev      # 桌面端开发（需 Rust 工具链）
npm run tauri build    # 桌面端打包（macOS 产 .app/.dmg，Windows 产 .msi/.exe）
```

## Windows 桌面端打包

桌面壳为 **Tauri 2**（`src-tauri/`），Web 与桌面共用同一份 UI 与统计引擎。
Windows 安装包需在 Windows 上构建（或走 CI 交叉产出）：

- **CI（推荐）**：仓库已带 `.github/workflows/build-windows.yml`，推 `v*` tag 或手动
  触发 workflow_dispatch，在 windows-latest 上产出 `.msi`（WiX，中文）与 `.exe`
  （NSIS，简中、perMachine），从 Actions Artifacts 下载。
- **Windows 本机**：装 Rust（MSVC 工具链）+ Node 后 `npm ci && npx tauri build`。
- macOS 本机 `npm run tauri build --bundles app,dmg` 可出 mac 版用于开发验证。

平台差异全部收敛在 `src/platform/adapter.ts`（PlatformAdapter，交接文档 §4.2）：

| 能力 | Web | 桌面 (Tauri) |
|---|---|---|
| 导出报表 | Blob 下载 | 原生保存对话框 + Rust `save_text_file` 落盘 |
| 导入数据 | `<input type=file>` | 原生打开对话框 + Rust `read_text_file` |
| 导出载荷 | Excel→工作表 CSV;其余→中文文本分析报告（SPC/能力/GageRR/ANOVA 实时计算结果） | 同左 |

## 结构

```
src/
  core/          纯 TS 统计引擎（零 UI 依赖，可单元测试，两端共享）
    basicMath.ts   erf / phi / invNorm (Acklam) / binomCdf / mean / stdev / median / quantile
    spc.ts         控制图常数 (n=5) + Nelson 判异准则引擎 (准则 1–4)
    capability.ts  Cp/Cpk/Pp/Ppk/CPU/CPL/Z.bench/西格玛水平/PPM
    doe.ts         2³ 全因子效应 + Lenth 检验 + 主效应/交互均值
    aql.ts         GB/T 2828.1 单次抽样（字码/n/Ac/Re、OC 曲线、RQL、α/β）
    calculator.ts  计算器按键逻辑
    sampleData.ts  确定性演示数据（LCG 种子 20260601 等，与原型逐位一致）
    __tests__/     对拍测试（关键校验值来自交接文档）
  store/appStore.ts  zustand 全局 UI 状态（交接文档 §6）
  platform/          PlatformAdapter 双端适配（导入/导出）+ 报表生成
src-tauri/           Tauri 2 桌面壳（Rust：文件读写命令 + dialog 插件）
  ui/
    tokens.ts      图表三主题（经典/现代/高对比，§7）
    charts/        手写 SVG 图表（控制图/直方图/帕累托/箱线/DOE 四图/OC 曲线）
    shell/         菜单栏/工具栏/左导航/状态栏/弹窗/Toast（§5.0/5.10/5.11）
    pages/         九个模块页面（§5.1–5.9）
```

## 关键校验值（npm test 全部覆盖，39 项）

| 场景 | 期望 | 状态 |
|---|---|---|
| 过程能力 Cpk（规格 24.90/25.10） | ≈ 1.36 | ✅ |
| AQL：N=120, 水平 II, AQL=1.0 | 字码 F, n=20, Ac=1, Re=2 | ✅ |
| DOE Lenth | A 温度、C 时间显著；交互项不显著 | ✅ |
| 计算器 | 144 ÷ 12 = 12 | ✅ |
| SPC 判异 | 子组 16–18、22 失控（准则 1） | ✅ |
| 单因子 ANOVA（实算） | P ≈ 0.012 显著,设备 B 均值最高 | ✅ |
| Gage R&R（交叉 ANOVA 法实算） | 合计 GRR < 10% 可接受 | ✅ |
| F 分布 CDF | F(2,6)=3 → p=0.125（教科书值） | ✅ |
| 控制图常数 | n=2..10 全表 | ✅ |

## 数据导入（真实闭环）

「导入 CSV/Excel」或剪贴板粘贴即可替换活动数据集：自动识别分隔符/表头/数值列,
每行一个子组（n=1..10,n=1 自动切换 I-MR）,SPC/能力/仪表盘/工作表/导出报告全部
实时重算,规格限按 μ±4σ 自动建议。菜单「数据 → 恢复演示数据集」可随时回到内置演示。

## 图表主题

三套主题（经典/现代/高对比）+ 网格开关：菜单「工具」内切换,或点击状态栏
「图表风格」标签循环切换。字体已本地打包（@fontsource),桌面端离线可用。

## 功能全景（v1.4）

- **数据**：CSV/剪贴板/**真 .xlsx 工作簿**导入（变量矩阵 n=2..10 / P 图不良数 /
  C 图缺陷数），文本列保留为分组列；**手工录入**（双击单元格编辑、添加子组、悬停
  行号删行,编辑演示集自动转「副本」）；localStorage 持久化 + 最近数据集 +
  **规格限随数据集记忆**；MES 模拟采集流（实时追加子组,SPC 滚动更新）。
- **SPC**：X̄-R / X̄-S / I-MR / **EWMA**（时变限）/ **CUSUM**（双侧累积和）/ P / C,
  Nelson 准则 1–4（Shewhart 图）,点选明细。
- **能力**：Cp/Cpk/Pp/Ppk/CPU/CPL/**Cpm**/Z.bench/σ 水平/PPM;**Anderson-Darling
  正态性检验 + 正态概率图**;非正态时 **Box-Cox** λ 寻优与变换后能力。
- **假设检验**：单因子 ANOVA + **单样本/双样本 t 检验**（Welch,含 95% CI）+
  **相关与回归**（散点图 + 最小二乘 + r/R²/斜率显著性）;引擎实算（F/t 分布 CDF
  经不完全贝塔）;导入数据含分组列时按所选 响应×分组 / 测量×部件×操作员 列实算,
  否则回落演示研究。
- **帕累托 / 鱼骨图**：帕累托图 + **6M 因果图**（三上三下鱼骨,问题与原因可编辑,
  localStorage 持久化）——交接文档模块清单至此全部落地。
- **AQL**：方案实时重算 + OC 曲线 + **正常/加严/放宽转移规则模拟**（简化模型）。
- **导出（四格式全真）**：Excel **.xlsx**（数据/统计摘要/失控点三 sheet）;PDF 为
  **图文 HTML 报告**（打开后打印即 PDF）;Word **.docx** 与 PowerPoint **.pptx**
  真渲染（docx/pptxgenjs,内嵌 X̄图/直方图/概率图位图 + 统计表）;
  「图形 → 下载本页图表 PNG」批量导出当前页图表;Ctrl/Cmd+S/O/P/N 快捷键。
- **工程**：ESLint + UI 冒烟测试(95 项测试);`ci.yml` 每次 push 质量门;
  `release.yml` 推 v* tag 自动发 GitHub Release(含更新器签名 latest.json);
  桌面端「帮助 → 检查更新」经 tauri-plugin-updater 对接 Releases。

## 项目工作台（分析记录对象化）

「保存到项目」把当前分析连同其参数与所属数据集存为一条**记录**:出现在仪表盘
「近期分析记录」与左下「项目管理器」,点击即**回看**——自动切回当时的数据集、
还原分析参数、跳到对应模块。记录可删除,并随 .qproj 项目文件一起备份/迁移。
这让应用从「算完即走的计算器页面」变为以项目为中心、分析可积累可回看的工作台。

**可命名项目**:项目管理器顶部双击即可重命名当前项目,名称随 .qproj 一起持久化,
并作为项目文件与汇总报告的默认文件名。「文件 → 导出项目汇总…」把项目名、分析总数、
涉及数据集数与全部分析记录(标题/类型/数据集/关键指标/状态)渲染成一份自包含 HTML
报告,双击即可查看或打印——一眼看清整个项目的分析全貌。

## 描述性统计 · 图形化摘要（对标 Minitab Graphical Summary）

「统计 → 描述性统计 / 图形化摘要」(或侧栏「描述性统计」)一屏给出:直方图叠正态曲线、
箱线图(Q1–中位–Q3、须及 1.5·IQR、离群点、均值菱形),以及完整统计表——N、均值、
均值标准误、标准差、方差、变异系数、偏度、峰度、最小/Q1/中位/Q3/最大、极差、IQR、总和,
外加 Anderson-Darling 正态检验与均值/中位数/标准差的 95% 置信区间。计算在
`src/core/descriptive.ts`(纯函数,复用已有 invNorm/quantile/tInv/andersonDarling;标准差
CI 用 Wilson–Hilferty χ² 近似,中位数 CI 用次序统计)。可「保存到项目」为一条分析记录。

## 公式计算列（对标 Minitab 计算器）

「计算 → 公式计算列…」用一条表达式从已有列算出一列新值,如 `(C1 + C2) / 2`、
`(C1 - mean(C1)) / std(C1)`、`sqrt(C1)`。列可用 `C1 C2 …` 或引号列名 `'直径 (mm)'`
引用;支持 `+ − × ÷ ^`、括号、一元负号,逐元素函数(abs/sqrt/ln/log10/exp/round/sq)
与聚合函数(mean/std/var/min/max/sum/median/range/n,整列折算成常量再广播)。
弹窗内实时预览计算结果并即时报错;引擎为自建递归下降解析器(`src/core/formula.ts`,
纯函数、零依赖、不用 eval,可单测),新列追加后可 Ctrl+Z 撤销。

「编辑 → 查找 / 替换…」(Ctrl+F)按数值批量替换测量单元格(3 位小数显示容差,
可限定列,实时命中数,替换可 Ctrl+Z 撤销)。「数据 → 子集 / 条件筛选…」复用同一引擎,按条件表达式筛出子集为新数据集。除算术外,
表达式还支持比较(`> < >= <= == <> !=`,单 `=` 视为等于)与逻辑(`and / or / not`)运算,
如 `C1 > 25`、`C1 >= 24.9 and C1 <= 25.1`、`not (C2 = 0)`;逻辑真值判定排除 NaN。弹窗
实时显示命中行数,条件为真的行保留到新数据集「… (子集)」,原数据集不变。

## 助手结论卡（对标 Minitab Assistant Report Card）

每个分析页顶部有一张**红绿灯结论卡**:一句人话结论 + 逐项体检,不懂统计也能直接读懂
"过了没有、该干什么"。覆盖:SPC(稳定性/数据量/子组结构,失控按准则汇总)、过程能力
(Cpk 分级/AD 正态性/样本量/过程稳定性——不稳时诚实提示能力数值无预测意义)、
Gage R&R(AIAG 10%/30% 判据)、单因子 ANOVA、单/双样本 t、回归(R² 分级 + 显著性)。
builder 为纯函数(`src/ui/reportData.ts`,可完整单测),视图 `ReportCard.tsx`。

## 分析助手（对标 Minitab Assistant）

不确定该用哪个分析?左侧「助手 · 选分析」用一棵决策树带你选:回答「你想解决什么问题」
「数据是哪种类型」「比较几组」等几个问题,助手就推荐合适的模块,并用三句话说明
**这个分析做什么 / 需要什么数据 / 为什么推荐它**,点「开始分析」即自动套用正确的
控制图类型或检验方法(如 X̄-R / I-MR / P 图、单样本 / 双样本 t / ANOVA)并跳转进入。
决策树覆盖全部 8 个分析模块(`src/ui/assistant/decisionTree.ts`,纯数据、可单测)。

## 本机数据集库（桌面端 SQLite 后端）

桌面版内置 SQLite(`src-tauri/src/db.rs`,rusqlite bundled,库文件在应用数据目录
`datasets.db`):每次导入或编辑的数据集都自动镜像归档(400ms 防抖),容量不受浏览器
localStorage(约 5MB)限制——十万行级数据集也能保存找回。「数据 → 数据集库(本机)…」
查看全部归档(名称/时间/大小),可加载回工作区或删除;从「最近列表」移除的数据集
仍可在库中找回。Web/便携版不受影响(该菜单显示桌面版提示),原有 localStorage 与
.qproj 通道保持不变——这是**增量**后端,不替换任何现有持久化路径。

**大数据集无忧(阶段 2)**:活动数据集写入 localStorage 超出配额时,桌面端自动改存
SQLite 库并留恢复标记——重启后自动恢复到该数据集;最近列表同步瘦身为轻量条目
(点击时从库回落加载),撤销/重做同样兜底。也就是说,桌面版导入十万行级数据集:
能用、重启不丢、最近列表可点回。**.qproj 全量迁移**:桌面端导出项目文件时把库中
数据集(超大集与被挤出最近列表的历史集)一并嵌入,换机导入自动恢复进对方的库
(Web 端导入时跳过库数据并提示);格式保持 formatVersion 1,新旧版本互相兼容。

**大数据渲染(阶段 3)**:图表渲染降采样——控制图超 600 点时 min-max 分桶保形抽样
(失控点/选中点/段边界必留,图上标注「渲染 M/N 点」),概率图/散点图同样封顶;
**统计与判异始终基于全量数据**,降采样只影响画多少个 SVG 节点。工作表超 400 行
启用行虚拟化(只渲染可视窗口,滚动条由等高占位撑开),两万行滚动依然流畅。
「生成随机数据」子组数上限放宽到 100000,便于体验大数据链路。
(引擎级修复:全代码库消除 `Math.min(...大数组)` 展开调用——V8 约 6.5 万参数即栈溢出,
涉及 CSV 导入、公式聚合、控制图/直方图/散点图/箱线图轴范围与列统计。)

## 本地单机使用（零网络依赖）

- **项目文件 (.qproj)**：「文件 → 保存项目文件… / Ctrl+S」把全部本地数据（数据集、
  最近列表、已保存分析、规格记忆、鱼骨图、偏好）导出为单个文件;在任何机器上「打开…」
  选择该文件即完整恢复——备份与跨机迁移的唯一通道,无需任何服务。
- **单文件便携版**：`npm run build:portable` 产出一个自包含 HTML
  （Release 资产 `quality-platform-portable-x.y.z.html`）,拷贝到任意机器用浏览器
  打开（file://）即可使用,零安装零网络;数据同样可经 .qproj 进出。
- 应用运行时无任何外部网络请求（字体本地打包,PWA 离线,更新检查失败静默降级）。

## 后续

- MES 真实协议接入（串口 modbus / OPC-UA,替换模拟流）
- SQLite 大数据集持久化（当前 localStorage 适合 ≤ 数 MB）
- OS 代码签名（需购买证书;更新器签名已就绪,私钥在 GH Secret
  `TAURI_SIGNING_PRIVATE_KEY`,本地备份 `~/.tauri/quality-platform.key` —— **务必备份,丢失则无法再发更新**）
- GitHub Pages 在线版：`pages.yml` 已就绪,仓库转 Public（或升级付费计划）后手动触发
