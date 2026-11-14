/**
 * MES 模拟采集流 — PlatformAdapter.connectMes 的模拟实现（交接文档 §4.4）。
 * 生产版本：桌面端换 Rust 串口/OPC-UA 事件流,本模块接口不变。
 */
import { useData } from '../store/dataStore';
import { errText } from './adapter';
import { useApp } from '../store/appStore';
import { sessionLog } from '../store/sessionLog';
import { registerProjectLifecycleHooks } from './project';

let timer: ReturnType<typeof setInterval> | null = null;
// 模块级:tick 抽成独立函数后需与 mesStart 共享(盲审 P3 的 try/catch 改造)
let shiftLeft = 0;
let mesDatasetName = '';

const N = 5; // 子组大小
const TGT = 25.0;
const SIGMA = 0.026;

function randn(): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function mesIsRunning(): boolean {
  return timer != null;
}

/** 开始模拟采集：新建「MES 实时采集」数据集,每 800ms 追加一个子组（偶发漂移）。 */
export function mesStart(): void {
  // 闭环 P3:数据集替换闸门(beginDatasetReplacement/importPareto)只翻 mesRunning 标志,
  // interval 要等到下一 tick 才自清。在这 ≤800ms 窗口里点「开始采集」会被 `if (timer) return`
  // 静默吞掉、UI 却已显示「已启动」。timer 尚在但标志已关 = 待自清状态,先真停再启动。
  if (timer && !useData.getState().mesRunning) mesStop();
  if (timer) return;
  const store = useData.getState();
  store.startMesDataset(N);
  store.setMesRunning(true);
  sessionLog('MES 模拟采集启动 · n=5,周期 0.8s');
  shiftLeft = 0; // 漂移剩余子组数
  mesDatasetName = useData.getState().model.name;
  timer = setInterval(() => {
    // 盲审 P3:tick 里任何一步抛出都会变成未捕获异常(导出 flush 期间尤其容易命中),
    // 而 UI 仍显示「采集运行中」。出错即自停并如实提示,绝不留下会反复抛的定时器。
    try {
      mesTick();
    } catch (error) {
      mesStop();
      try {
        useApp.getState().showToast(`模拟采集已停止：${errText(error)}`);
      } catch { /* 非浏览器环境忽略 */ }
    }
  }, 800);
}

/** 单次采集节拍;由 setInterval 包在 try/catch 里调用。 */
function mesTick(): void {
  {
    const s = useData.getState();
    // 双审 P1:活动数据集一旦变化(loadRecent/新建/导入等任何入口)立即自停——
    // 否则模拟随机数会静默追加进用户的真实数据集并落盘,分组文本列被写空
    if (!s.mesRunning || s.model.name !== mesDatasetName) {
      mesStop();
      return;
    }
    if (shiftLeft === 0 && Math.random() < 0.06) shiftLeft = 3 + Math.floor(Math.random() * 3);
    const shift = shiftLeft > 0 ? 0.05 : 0;
    if (shiftLeft > 0) shiftLeft--;
    const vals = Array.from({ length: N }, () => TGT + shift + randn() * SIGMA);
    s.appendSubgroup(vals);
    if (useData.getState().model.k >= 200) mesStop();
  }
}

export function mesStop(): void {
  if (!timer) {
    useData.getState().setMesRunning(false);
    return;
  }
  clearInterval(timer);
  timer = null;
  useData.getState().setMesRunning(false);
  sessionLog(`MES 采集停止 · 共 ${useData.getState().model.k} 子组`);
}

// 项目导入/导出必须在静止的数据边界上取快照；否则下一次 800ms tick 会覆盖刚导入的 stores。
registerProjectLifecycleHooks({ beforeMutation: mesStop, beforeExport: mesStop });
