/**
 * 生态流量下泄监管——全站唯一的一套口径。
 *
 * 环评批复文号版本、最小下泄指标、判定规则、实测取值上限、预警处置环节顺序
 * 只能在本文件登记；台账、水情/泄洪/闸门/检修各入口都从这里取值，不允许各写一套。
 */

/** 环评批复版本：换版只影响换版后的新记录，既有记录永远按观测当时生效的版本取快照值。 */
export interface ApprovalVersion {
  /** 环评批复文号 */
  code: string
  order: number
  /** 生效起始时间（含），格式 YYYY-MM-DD，按字符串可与观测时段直接比较 */
  effectiveFrom: string
  /** 生效结束时间（含），null 表示至今 */
  effectiveTo: string | null
  /** 最小生态下泄流量指标，m³/s */
  minFlow: number
  note: string
}

/**
 * 批复版本账（仅可在此处登记）。
 * 环审〔2018〕27号：原批复最小下泄 8.5 m³/s。
 * 环审〔2024〕12号：换版后调整为 10.0 m³/s，仅适用于 2024-01-01 起的新记录；
 *                   2023 年及以前的存量记录仍按 8.5 m³/s 的当时口径取值。
 */
export const APPROVAL_VERSIONS: ApprovalVersion[] = [
  {
    code: '环审〔2018〕27号',
    order: 1,
    effectiveFrom: '2018-06-01',
    effectiveTo: '2023-12-31 23:59',
    minFlow: 8.5,
    note: '原批复：坝下河段最小生态下泄流量 8.5 m³/s',
  },
  {
    code: '环审〔2024〕12号',
    order: 2,
    effectiveFrom: '2024-01-01',
    effectiveTo: null,
    minFlow: 10.0,
    note: '换版批复：最小生态下泄流量 10.0 m³/s，仅适用于 2024-01-01 起的新记录',
  },
]

/** 实测下泄流量唯一取值范围（闭区间），超范围一律按同一套标准拒收，不做截断、不挂预警。 */
export const FLOW_RANGE = Object.freeze({
  min: 0,
  max: 100,
  unit: 'm³/s',
})

/** 台账判定结果只有这三种，判定逻辑只允许出现在 judge() 一处。 */
export const VERDICTS = ['达标', '未达标', '缺测'] as const
export type Verdict = (typeof VERDICTS)[number]

/** 预警处置环节：只能顺序推进，缺哪一步就拦哪一步。 */
export const WARNING_STAGES = ['待处置', '处置中', '已处置', '已销号'] as const
export type WarningStage = (typeof WARNING_STAGES)[number]

/** 取观测时点生效的最新一版批复（法不溯及既往，指标随记录固化为快照）。 */
export function versionAt(observedAt: string): ApprovalVersion {
  const sorted = [...APPROVAL_VERSIONS].sort((a, b) => a.order - b.order)
  let hit: ApprovalVersion | null = null
  for (const version of sorted) {
    const afterFrom = observedAt >= version.effectiveFrom
    const beforeTo = version.effectiveTo === null || observedAt <= version.effectiveTo
    if (afterFrom && beforeTo) {
      hit = version
    }
  }
  // 兜底：观测时间早于首版生效日，按首版取值（回填时会在备注中注明）。
  return hit ?? sorted[0]
}

/**
 * 全站唯一判定规则：
 * 实测值为空缺测；实测值 < 最小下泄指标判未达标；实测值 >= 指标（含恰好相等）判达标。
 */
export function judge(measuredFlow: number | null, minFlow: number): Verdict {
  if (measuredFlow === null || Number.isNaN(measuredFlow)) {
    return '缺测'
  }
  return measuredFlow < minFlow ? '未达标' : '达标'
}

/** 唯一取值范围校验：所有入口（在线报送、批量报送、缺项补录）共用。 */
export function inFlowRange(value: number): boolean {
  return Number.isFinite(value) && value >= FLOW_RANGE.min && value <= FLOW_RANGE.max
}

/** 顺序环节守卫：只允许推进到当前环节的紧后一环，跳级时返回所缺环节。 */
export function canAdvance(
  from: WarningStage,
  to: WarningStage,
): { ok: boolean; missing: WarningStage[] } {
  const fromIndex = WARNING_STAGES.indexOf(from)
  const toIndex = WARNING_STAGES.indexOf(to)
  if (toIndex <= fromIndex) {
    return { ok: false, missing: [] }
  }
  if (toIndex !== fromIndex + 1) {
    return { ok: false, missing: WARNING_STAGES.slice(fromIndex + 1, toIndex) as WarningStage[] }
  }
  return { ok: true, missing: [] }
}
