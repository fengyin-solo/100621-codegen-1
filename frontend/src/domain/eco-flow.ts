/**
 * 生态流量下泄监管：全站唯一的一套规则。
 * 阈值、取值上限、达标判定、批复版本取值、预警环节顺序都只在这里定义，
 * 水情调度、泄洪操作、闸门启闭、机组检修各入口都从这里读，不各自算一遍。
 */

export type EiaVersion = {
  docNo: string // 环评批复文号
  minFlow: number // 最小下泄指标（立方米每秒）
  effectiveFrom: string // 生效日期 YYYY-MM-DD（含当天）
  note: string
}

/** 取值上下限与判定口径：报送、回填、补录都按这一套处理。 */
export const ECO_FLOW_RULES = {
  maxMeasured: 200, // 实测下泄流量取值上限（立方米每秒），超出按超范围处理
  minMeasured: 0, // 实测下泄流量取值下限（立方米每秒）
} as const

export type JudgeResult = '达标' | '未达标' | '超范围' | '缺测'

/** 达标判定：全站只认这一套。缺测、超范围、达标、未达标四种结论。 */
export function judgeMeasured(measured: number | null, minFlow: number): JudgeResult {
  if (measured === null || Number.isNaN(measured)) {
    return '缺测'
  }
  if (measured < ECO_FLOW_RULES.minMeasured || measured > ECO_FLOW_RULES.maxMeasured) {
    return '超范围'
  }
  return measured >= minFlow ? '达标' : '未达标'
}

/**
 * 按观测时间匹配批复版本：观测时间落在哪一版的生效区间就取哪一版。
 * 换版后的批复只影响新记录，既有记录仍按当时口径取值（文号与指标已冻结在记录上）。
 */
export function resolveVersion(versions: EiaVersion[], observeTime: string): EiaVersion | null {
  if (!observeTime) {
    return null
  }
  const day = observeTime.slice(0, 10)
  const sorted = [...versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
  let hit: EiaVersion | null = null
  for (const version of sorted) {
    if (version.effectiveFrom <= day) {
      hit = version
    }
  }
  // 观测时间早于所有版本生效日期时，按最早一版取值（裁决口径，理由会写进备注）。
  return hit ?? sorted[0] ?? null
}

export function findVersion(versions: EiaVersion[], docNo: string): EiaVersion | null {
  return versions.find((item) => item.docNo === docNo) ?? null
}

/** 预警环节：待处置 → 处置中 → 已办结，只能按顺序推进；已核销为数据更正后的终止态。 */
export const WARNING_STAGES = ['待处置', '处置中', '已办结'] as const
export type WarningStage = (typeof WARNING_STAGES)[number]
export type WarningStatus = WarningStage | '已核销'

export type WarningAction = '受理预警' | '办结预警'

/** 推进到每个环节要执行的动作：用于跳级拦截时说明缺哪一步。 */
const STAGE_ACTION: Record<WarningStage, WarningAction> = {
  处置中: '受理预警',
  已办结: '办结预警',
  待处置: '受理预警',
}

export type TransitionResult =
  | { ok: true; target: WarningStage }
  | { ok: false; message: string }

/** 环节只能按顺序推进，跳级的直接拦下并说明缺哪一步。 */
export function transitionWarning(current: WarningStatus, action: WarningAction): TransitionResult {
  if (current === '已核销') {
    return { ok: false, message: '该预警已因数据更正核销，不需要再处置' }
  }
  const target: WarningStage = action === '受理预警' ? '处置中' : '已办结'
  const currentIndex = WARNING_STAGES.indexOf(current as WarningStage)
  const targetIndex = WARNING_STAGES.indexOf(target)
  if (currentIndex === targetIndex) {
    return { ok: false, message: `预警已处于「${target}」，不用重复操作` }
  }
  if (targetIndex !== currentIndex + 1) {
    const missing = WARNING_STAGES.slice(currentIndex + 1, targetIndex)
      .map((stage) => STAGE_ACTION[stage])
      .join('→')
    return {
      ok: false,
      message: `环节只能按顺序推进：当前「${current}」，缺少「${missing}」环节，请先完成再${action}`,
    }
  }
  return { ok: true, target }
}

/** 观测时间统一按小时整点归集：同一时段的重复报送只认最后一次。 */
export function normalizeObserveTime(raw: string): string | null {
  const text = raw.trim().replace('T', ' ')
  const match = /^(\d{4})-(\d{2})-(\d{2})[ ](\d{2})/.exec(text)
  if (!match) {
    return null
  }
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:00`
}

export function nowText(): string {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`
}
