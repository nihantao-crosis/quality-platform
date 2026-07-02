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

## 后续（交接文档 §4 双端方案）

双端已按 §4.2 落地（同一份 UI + core,`PlatformAdapter` 隔离平台能力）,
真实数据导入、ANOVA/GageRR 引擎、主题切换、字体离线均已完成。剩余增强方向：
- MES 串口/OPC-UA 实时采集（`connectMes()`,仅桌面,Rust 侧接 modbus/opcua crate）
- SQLite 项目持久化（`tauri-plugin-sql`）
- PDF/Excel/PPT/Word 真渲染导出（当前导出为 CSV/文本报告）
- 工作表上万行时换 TanStack Table + 虚拟滚动;代码签名与自动更新（tauri-plugin-updater）
