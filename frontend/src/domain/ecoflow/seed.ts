/** 生态流量监管首次播种数据与存量交接本待回填数据。 */
import { createInitialState, submitFlow, advanceWarning } from './engine'
import type { EcoFlowState } from './types'

export function buildSeedState(): EcoFlowState {
  let state = createInitialState()
  // 值班员最近两天的在线实测报送（2026 现行口径：环审〔2024〕12号，10.0 m³/s）
  const readings: Array<[string, number | null, string]> = [
    ['2026-10-04 08:00', 11.2, '王建国'],
    ['2026-10-04 09:00', 9.4, '王建国'],
    ['2026-10-04 10:00', 9.8, '王建国'],
    ['2026-10-04 11:00', 10.6, '李海峰'],
    ['2026-10-04 12:00', 10.0, '李海峰'],
    ['2026-10-05 08:00', 10.8, '李海峰'],
  ]
  for (const [observedAt, measuredFlow, operator] of readings) {
    const result = submitFlow(state, { observedAt, measuredFlow, operator }, '在线报送')
    state = result.data?.state ?? state
  }
  // 10 时那条已进入处置环节并填了处置结论：会同时回写到闸门启闭与检修待办
  const warning = state.warnings.find((item) => item.slot === '2026-10-04 10:00')
  if (warning) {
    state = advanceWarning(
      state,
      warning.id,
      '处置中',
      '王建国',
      '已调整1号表孔开度至0.3m，增开生态机组一台，加密下游断面观测。',
    ).data?.state ?? state
  }
  return state
}

/**
 * 存量交接本数据：按观测时间整体回填一次。
 * 缺批复文号的占多数，由系统按观测时点生效版本裁决补齐并写入备注；
 * 缺实测流量的单独进补录队列，不臆造数值。
 */
export interface BackfillItem {
  observedAt: string
  measuredFlow: number | null
  operator: string
  approvalCode?: string
}

export const BACKFILL_PAYLOAD: BackfillItem[] = [
  // 早于首版批复生效日：裁决按首版补齐，备注注明兜底口径
  { observedAt: '2009-03-12 09:00', measuredFlow: 7.0, operator: '交接本（待回填）' },
  // 2018 版口径期间：8.5 m³/s，9.2 达标、8.1 未达标
  { observedAt: '2023-08-10 08:00', measuredFlow: 9.2, operator: '交接本（待回填）' },
  { observedAt: '2023-08-10 09:00', measuredFlow: 8.1, operator: '交接本（待回填）' },
  // 缺实测流量：单独补录
  { observedAt: '2023-08-10 10:00', measuredFlow: null, operator: '交接本（待回填）' },
  { observedAt: '2023-08-10 11:00', measuredFlow: 12.5, operator: '交接本（待回填）' },
  // 2024 换版后：同一笔 9.6 在旧版达标、在新版未达标，证明存量与新增口径分离
  { observedAt: '2024-06-02 14:00', measuredFlow: 9.6, operator: '交接本（待回填）' },
  { observedAt: '2024-06-02 15:00', measuredFlow: 12.3, operator: '交接本（待回填）' },
]
