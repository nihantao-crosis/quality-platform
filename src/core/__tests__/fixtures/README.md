# 独立黄金夹具

## AQL 正式表

本目录保存 `GB/T 2828.1-2012 / ISO 2859-1:1999` 一次抽样方案的人工转录黄金数据，专供回归测试使用，不由 `src/core/aql.ts` 或测试运行时生成。

来源文件：仓库上级目录 `AQL表2-C问题证据/GBT2828.1-2012_国标原文.pdf`。固定 SHA-256：

`7a336944db23d14cf23fe007b0cfe2dffa5d5bef434767d2b1300ffaa35e5a37`

页码映射：

- PDF 物理第 21 页 / 印刷第 15 页：表 2-A，正常检验一次抽样方案。
- PDF 物理第 22 页 / 印刷第 16 页：表 2-B，加严检验一次抽样方案。
- PDF 物理第 23 页 / 印刷第 17 页：表 2-C，放宽检验一次抽样方案。

`gbt2828-1-2012-tables-2abc.tsv` 的每格格式为 `最终执行字码/样本量/Ac/Re`，48 个初始字码行 × 6 个常用 AQL，共 288 格。`gbt2828-1-2012-table-2a-aql-0.40.tsv` 另含表 2-A 的 AQL 0.40 列 16 格，用于验证转移得分的“严一档 AQL”。Re 被逐格显式保存，测试不会通过 `Ac + 1` 生成期望值。

维护要求：先核对固定哈希的 PDF 页面，再手工修改夹具；禁止从生产表导出或复制运行结果来更新夹具。测试会检查哈希声明、页码、行数、总格数以及每格四个字段。

### 2026-07-15 独立原文复核

两名只读复核者严格先查看固定哈希 PDF 并锁定人工抄录，之后才打开夹具逐字段比较；不是拿生产源码或夹具反推期望值。

- 表 2-A：主表 96 格 + AQL 0.40 列 16 格，共 112/112 格、448/448 个 `final_code/n/Ac/Re` 字段一致。
- 表 2-B：96/96 格、384/384 个字段一致。
- 表 2-C：96/96 格、384/384 个字段一致。
- 合计：304/304 格、1216/1216 个字段一致；差异 0，不确定读数 0。

## SPC 控制图常数

`spc-control-constant-bases.tsv` 保存 n=2…10 的独立 d2/d3/c4 基础值。测试侧按 ASTM E2587、[Minitab 对 d2/d3 的定义](https://support.minitab.com/en-us/minitab/help-and-how-to/quality-and-process-improvement/control-charts/how-to/variables-charts-for-subgroups/xbar-r-chart/methods-and-formulas/unbiasing-constants-d2-d3-and-d4/)以及 [NIST 控制限公式](https://www.itl.nist.gov/div898/handbook/pmc/section3/pmc321.htm)，推导 A2、A3、D3、D4、B3、B4，并连同 d2/c4 对 `CONTROL_CONSTANTS` 的 72 个字段逐项核对。夹具只保存基础常数，不从生产 `spc.ts` 生成。

## gbt2828-1-2012-tables-2abc-full16.tsv(v1.36 起)
- 49 行(2-A 16 + 2-B 17 含 S 行 + 2-C 16)× 16 AQL 列(0.010–10),cell=final_code/n/Ac/Re,`-`=国标留白。
- 血统:工厂修订版 xlsx 转录 + 国标扫描件核对;含勘误#2(2-C Q/0.025 ↓→长↑→N/200/0/1)。

## gbt2828-1-2012-tables-2abc-aql15-1000.tsv(v1.38 起,批次716-R3 K2)
- 49 行 × 10 AQL 列(15–1000,每百单位不合格数体系),cell 格式同上;留白仅 2-B S 行(勘误#3:工厂 xlsx 该 10 格误填 ↑,国标扫描件像素级确认箭杆止于 R 行)。
- 血统:国标扫描件(物理页21–23,300dpi)每表 2 名独立转录员双盲转录(490 格零分歧)+ 与工厂 xlsx 三方机器 diff + 仲裁员像素复核;头部注释含 pdf_sha256 与方法说明。
- 维护:任何修改必须重走「独立转录 + 机器 diff」流程,禁止按规律或记忆改格。
