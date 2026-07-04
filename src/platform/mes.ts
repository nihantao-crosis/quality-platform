/**
 * MES 模拟采集流 — PlatformAdapter.connectMes 的模拟实现（交接文档 §4.4）。
 * 生产版本：桌面端换 Rust 串口/OPC-UA 事件流,本模块接口不变。
 */
import { useData } from '../store/dataStore';
import { sessionLog } from '../store/sessionLog';

let timer: ReturnType<typeof setInterval> | null = null;

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
  if (timer) return;
  const store = useData.getState();
  store.startMesDataset(N);
  store.setMesRunning(true);
  sessionLog('MES 模拟采集启动 · n=5,周期 0.8s');
  let shiftLeft = 0; // 漂移剩余子组数
  timer = setInterval(() => {
    const s = useData.getState();
    if (!s.mesRunning) {
      mesStop();
      return;
    }
    if (shiftLeft === 0 && Math.random() < 0.06) shiftLeft = 3 + Math.floor(Math.random() * 3);
    const shift = shiftLeft > 0 ? 0.05 : 0;
    if (shiftLeft > 0) shiftLeft--;
    const vals = Array.from({ length: N }, () => TGT + shift + randn() * SIGMA);
    s.appendSubgroup(vals);
    if (useData.getState().model.k >= 200) mesStop();
  }, 800);
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
