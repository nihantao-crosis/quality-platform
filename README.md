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
