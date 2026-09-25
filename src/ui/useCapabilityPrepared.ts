/**
 * 能力口径解析的共用订阅 + 记忆化入口(fix2609i G14)。
 *
 * resolveCapabilityMeasurementData 从 store 内部(getState)读取能力子组口径与 SPC 数据角色,
 * 调用方的 useMemo 依赖必须手工列全,否则角色变化(如「选项 → 重置界面偏好」、项目载入等
 * 不经过 SPC 页的写入)后页面沿用陈旧的 prepared,与壳层状态栏不再同源。
 * 壳层(App)、总览(Dashboard)与能力页统一经本 hook 取 prepared,依赖清单只此一份。
 *
 * 只按字段订阅(useShallow):toast/openMenu/varOpen 等纯 UI 字段变化不会触发重算。
 */
import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useApp } from '../store/appStore';
import { useData, resolveCapabilityMeasurementData } from '../store/dataStore';

type AppSnapshot = ReturnType<typeof useApp.getState>;

/**
 * resolveCapabilityMeasurementData 会读取的 app store 字段(含其内部 resolveActiveMeasurementData)。
 * 新增 resolver 读取的字段时必须同步加到这里——这是全部调用方唯一的失效依据。
 */
export const CAPABILITY_ROLE_FIELDS = [
  'capSubgroupMode', 'capSubgroupSize', 'capValueCol', 'capSubgroupIdCol',
  'spcDataLayout', 'spcValueCol', 'spcSubgroupCol',
] as const satisfies ReadonlyArray<keyof AppSnapshot>;

export type CapabilityRoleInputs = Pick<AppSnapshot, typeof CAPABILITY_ROLE_FIELDS[number]>;

export function selectCapabilityRoleInputs(s: AppSnapshot): CapabilityRoleInputs {
  return {
    capSubgroupMode: s.capSubgroupMode,
    capSubgroupSize: s.capSubgroupSize,
    capValueCol: s.capValueCol,
    capSubgroupIdCol: s.capSubgroupIdCol,
    spcDataLayout: s.spcDataLayout,
    spcValueCol: s.spcValueCol,
    spcSubgroupCol: s.spcSubgroupCol,
  };
}

export function useCapabilityPrepared() {
  const roles = useApp(useShallow(selectCapabilityRoleInputs));
  const { model, textCols, pendingCells } = useData(useShallow((s) => ({
    model: s.model, textCols: s.textCols, pendingCells: s.pendingCells,
  })));
  const prepared = useMemo(
    () => resolveCapabilityMeasurementData(model, textCols),
    // resolver 从 store 内部读取 roles 与 pendingCells,依赖需显式列出以便口径变化时失效
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, textCols, pendingCells, roles.capSubgroupMode, roles.capSubgroupSize, roles.capValueCol,
      roles.capSubgroupIdCol, roles.spcDataLayout, roles.spcValueCol, roles.spcSubgroupCol],
  );
  return { prepared, model, textCols, pendingCells, roles };
}
