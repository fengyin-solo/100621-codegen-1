/**
 * 生态流量监管领域引擎：所有状态流转只经这里，保证全站一套口径、单一事实源。
 * 纯函数、不碰浏览器存储，便于测试与后续接后端。
 */
import { normalizeSlot, compareByTime } from './slot'
import {
  APPROVAL_VERSIONS,
  FLOW_RANGE,
  WARNING_STAGES,
  canAdvance,
  inFlowRange,
  judge,
  versionAt,
  type ApprovalVersion,
  type Verdict,
  type WarningStage,
} from './policy'
import type {
  ActionResult,
  CrossTodo,
  EcoFlowBatch,
  EcoFlowRecord,
  EcoFlowState,
  EcoFlowSupplement,
  EcoFlowWarning,
  FlowReading,
} from './types'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nowStamp(clock: () => Date): string {
  const d = clock()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function createInitialState(): EcoFlowState {
  return {
    records: [],
    warnings: [],
    supplements: [],
    todos: [],
    batches: [],
    logs: [],
    backfilled: false,
    seq: { record: 0, warning: 0, supplement: 0, todo: 0, batch: 0, log: 0 },
  }
}

interface CommitContext {
  clock: () => Date
}

function nextId(state: EcoFlowState, key: keyof EcoFlowState['seq']): number {
  return state.seq[key] + 1
}

function pushLog(
  state: EcoFlowState,
  action: string,
  detail: string,
  operator: string,
  clock: () => Date,
): void {
  state.logs.unshift({
    id: state.seq.log + 1,
    at: nowStamp(clock),
    action,
    detail,
    operator,
  })
  state.seq.log += 1
}

function recordCode(id: number): string {
  return `EF-${String(id).padStart(4, '0')}`
}

/** 解析入参：归一化时段、确认批复版本快照与取值范围。 */
function resolveReading(
  input: FlowReading,
): { ok: true; slot: string; version: ApprovalVersion; flow: number | null } | { ok: false; message: string } {
  const slot = normalizeSlot(input.observedAt)
  if (!slot) {
    return { ok: false, message: `观测时间「${input.observedAt}」无法识别，应为 YYYY-MM-DD HH:mm` }
  }
  const version = versionAt(slot)
  const approvalCode = input.approvalCode?.trim() ?? ''
  if (approvalCode !== '') {
    const picked = APPROVAL_VERSIONS.find((item) => item.code === approvalCode)
    if (!picked) {
      return { ok: false, message: `环评批复文号「${approvalCode}」未登记，允许文号：${APPROVAL_VERSIONS.map((v) => v.code).join('、')}` }
    }
    return { ok: true, slot, version: picked, flow: input.measuredFlow }
  }
  return { ok: true, slot, version, flow: input.measuredFlow }
}

/**
 * 预警与回写待办的同步：预警工单是唯一事实源，四个入口的待办只是同一条工单的投影。
 * 同一时段始终至多一条预警（重复报送/补报不会多挂）。
 */
function syncWarningAndTodos(
  state: EcoFlowState,
  record: EcoFlowRecord,
  ctx: CommitContext,
  opts: { suppressCreate: boolean },
): void {
  const warningIndex = state.warnings.findIndex((w) => w.slot === record.slot)
  const existing = warningIndex >= 0 ? state.warnings[warningIndex] : null

  if (record.verdict === '未达标') {
    if (existing) {
      // 同一时段后到的一笔盖掉前一笔：更新实测值，不新增工单。
      existing.measuredFlow = record.measuredFlow as number
      existing.approvalCode = record.approvalCode
      existing.minFlow = record.minFlow
    } else if (!opts.suppressCreate) {
      const id = nextId(state, 'warning')
      const warning: EcoFlowWarning = {
        id,
        slot: record.slot,
        approvalCode: record.approvalCode,
        minFlow: record.minFlow,
        measuredFlow: record.measuredFlow as number,
        stage: '待处置',
        openedAt: nowStamp(ctx.clock),
        actions: [],
        conclusion: '',
        closedAt: null,
      }
      state.seq.warning += 1
      state.warnings.push(warning)
      pushLog(state, '自动挂下泄预警', `${record.slot} 实测 ${warning.measuredFlow} < ${warning.minFlow}（${warning.approvalCode}）`, record.operator, ctx.clock)
    }
  } else if (existing && existing.stage !== '已销号') {
    // 同一时段后来的一笔恢复达标：同一条工单自动销号，结论保留，不新开单。
    existing.measuredFlow = record.measuredFlow as number
    const from = existing.stage
    existing.stage = '已销号'
    existing.closedAt = nowStamp(ctx.clock)
    existing.actions.push({
      from,
      to: '已销号',
      operator: record.operator,
      note: '同一时段最新一笔实测恢复达标，系统自动销号（处置结论仍保留在工单与待办中）',
      at: nowStamp(ctx.clock),
    })
    pushLog(state, '预警自动销号', `${record.slot} 最新实测 ${record.measuredFlow} 已达指标 ${record.minFlow}`, record.operator, ctx.clock)
  }

  const warning = state.warnings.find((w) => w.slot === record.slot) ?? null
  syncTodosFor(state, record, warning, ctx)
}

/** 以预警工单为准，重算某时段在各入口的待办投影。 */
function syncTodosFor(
  state: EcoFlowState,
  record: EcoFlowRecord,
  warning: EcoFlowWarning | null,
  ctx: CommitContext,
): void {
  state.todos = state.todos.filter((todo) => todo.slot !== record.slot)
  const stamp = nowStamp(ctx.clock)
  const make = (target: CrossTodo['target'], kind: CrossTodo['kind']): CrossTodo => ({
    id: 0,
    warningId: warning?.id ?? null,
    recordId: record.id,
    slot: record.slot,
    verdict: record.verdict,
    kind,
    target,
    stage: warning?.stage ?? null,
    conclusion: warning?.conclusion ?? '',
    open: warning ? warning.stage !== '已销号' : false,
    createdAt: stamp,
    updatedAt: stamp,
  })

  const targets: CrossTodo['target'][] = ['hydrology', 'flood']
  for (const target of targets) {
    const todo = make(target, warning ? '下泄预警' : '达标判定待办')
    todo.id = nextId(state, 'todo')
    state.seq.todo += 1
    state.todos.push(todo)
  }
  if (warning) {
    const gate = make('gate', '下泄预警')
    gate.id = nextId(state, 'todo')
    state.seq.todo += 1
    state.todos.push(gate)
    // 处置结论已产生的工单才进入后续检修待办
    if (warning.conclusion.trim() !== '' || warning.stage === '已处置' || warning.stage === '已销号') {
      const overhaul = make('overhaul', '下泄预警')
      overhaul.id = nextId(state, 'todo')
      state.seq.todo += 1
      state.todos.push(overhaul)
    }
  }
}

function upsertRecord(
  prev: EcoFlowState,
  input: FlowReading,
  source: EcoFlowRecord['source'],
  ctx: CommitContext,
  opts: { suppressCreateWarning: boolean; remarkPrefix?: string },
): ActionResult<{ state: EcoFlowState; record: EcoFlowRecord }> {
  const state = clone(prev)
  const resolved = resolveReading(input)
  if (!resolved.ok) {
    return { ok: false, message: resolved.message }
  }
  const { slot, version, flow } = resolved

  // 唯一取值范围：缺测放行（单独进补录），其余超范围一律拒收，不截断不预警。
  if (flow !== null && !inFlowRange(flow)) {
    return {
      ok: false,
      message: `实测下泄流量 ${flow} ${FLOW_RANGE.unit} 超出唯一允许范围 [${FLOW_RANGE.min}, ${FLOW_RANGE.max}]，已按统一标准拒收`,
    }
  }

  const verdict: Verdict = judge(flow, version.minFlow)
  const previous = state.records.find((item) => item.slot === slot)
  const stamp = nowStamp(ctx.clock)
  const remarkParts: string[] = []
  if (opts.remarkPrefix) remarkParts.push(opts.remarkPrefix)
  if (input.remark) remarkParts.push(input.remark)

  let record: EcoFlowRecord
  if (previous) {
    // 同一时段重复提交：只认最后一次，直接盖掉前一笔，不做累加。
    record = {
      ...previous,
      measuredFlow: flow,
      verdict,
      source,
      operator: input.operator,
      revision: previous.revision + 1,
      remark: [...(previous.remark ? [previous.remark] : []), ...remarkParts].join('；'),
      updatedAt: stamp,
    }
    state.records = state.records.map((item) => (item.slot === slot ? record : item))
    pushLog(state, '覆盖同时段记录', `${slot} 第 ${record.revision} 次报送，实测改为 ${flow === null ? '缺测' : flow}，判定「${verdict}」`, input.operator, ctx.clock)
  } else {
    const id = nextId(state, 'record')
    record = {
      id,
      code: recordCode(id),
      slot,
      observedAt: input.observedAt.trim(),
      approvalCode: version.code,
      minFlow: version.minFlow,
      measuredFlow: flow,
      verdict,
      source,
      operator: input.operator,
      revision: 1,
      remark: remarkParts.join('；'),
      createdAt: stamp,
      updatedAt: stamp,
    }
    state.seq.record += 1
    state.records.push(record)
    pushLog(state, '登记实测流量', `${slot} 批复${version.code} 指标 ${version.minFlow} 实测 ${flow === null ? '缺测' : flow} 判定「${verdict}」`, input.operator, ctx.clock)
  }

  syncWarningAndTodos(state, record, ctx, { suppressCreate: opts.suppressCreateWarning })
  return { ok: true, message: `已保存 ${slot}，判定「${verdict}」`, data: { state, record } }
}

/** 在线报送：同一时段后到的一笔盖掉前一笔；未达标自动挂预警（同一条，不重复挂）。 */
export function submitFlow(
  prev: EcoFlowState,
  input: FlowReading,
  source: '在线报送' | '批量报送' = '在线报送',
  clock: () => Date = () => new Date(),
): ActionResult<{ state: EcoFlowState; record: EcoFlowRecord }> {
  return upsertRecord(prev, input, source, { clock }, { suppressCreateWarning: false })
}

/**
 * 批量报送整套：整套先校验，任一不合法整套退回；
 * 同一批次（batchRef）以最先入库的一稿为准，后到的整套退回；
 * 批次内同一时段重复行只认最后一行。
 */
export function importBatch(
  prev: EcoFlowState,
  batchRef: string,
  readings: FlowReading[],
  clock: () => Date = () => new Date(),
): ActionResult<{ state: EcoFlowState }> {
  const ref = batchRef.trim()
  if (!ref) {
    return { ok: false, message: '批次号不能为空' }
  }
  if (!readings.length) {
    return { ok: false, message: '批量报送内容为空，整套未接收' }
  }
  const state0 = clone(prev)
  if (state0.batches.some((b) => b.batchRef === ref)) {
    return { ok: false, message: `批次「${ref}」已入库，以最先入库的一稿为准，整套退回` }
  }
  // 先整稿校验：时段合法、文号合法、取值范围合法；批次内同时段只留最后一行。
  const merged = new Map<string, FlowReading>()
  for (const reading of readings) {
    const resolved = resolveReading(reading)
    if (!resolved.ok) {
      return { ok: false, message: `整套退回：${resolved.message}` }
    }
    if (reading.measuredFlow !== null && !inFlowRange(reading.measuredFlow)) {
      return {
        ok: false,
        message: `整套退回：${resolved.slot} 实测 ${reading.measuredFlow} ${FLOW_RANGE.unit} 超出允许范围 [${FLOW_RANGE.min}, ${FLOW_RANGE.max}]`,
      }
    }
    merged.set(resolved.slot, reading)
  }

  let state = prev
  for (const reading of merged.values()) {
    const result = submitFlow(state, { ...reading, remark: `批量批次 ${ref}` }, '批量报送', clock)
    if (!result.ok || !result.data) {
      return { ok: false, message: `整套退回：${result.message}` }
    }
    state = result.data.state
  }
  const finalState = clone(state)
  const id = nextId(finalState, 'batch')
  const batch: EcoFlowBatch = {
    id,
    batchRef: ref,
    acceptedAt: nowStamp(clock),
    operator: readings[0]?.operator ?? '值班员',
    itemCount: merged.size,
  }
  finalState.seq.batch += 1
  finalState.batches.unshift(batch)
  pushLog(finalState, '接收批量报送', `批次 ${ref} 共 ${merged.size} 条，以最先入库一稿为准`, batch.operator, clock)
  return { ok: true, message: `批次「${ref}」已入库 ${merged.size} 条`, data: { state: finalState } }
}

/**
 * 存量数据按观测时间整体回填（只允许执行一次）：
 *  - 缺批复文号的，按观测时点生效的版本裁决补齐，理由写入备注；
 *  - 缺实测流量的不臆造，单独进补录队列；
 *  - 历史未达标只记录判定，不自动挂新预警工单（由值班长据台账复核处置）；
 *  - 任一时段与既有记录冲突或时间非法，整套不执行。
 */
export function runBackfill(
  prev: EcoFlowState,
  items: Array<{ observedAt: string; measuredFlow: number | null; operator: string; approvalCode?: string }>,
  operator: string,
  clock: () => Date = () => new Date(),
): ActionResult<{ state: EcoFlowState }> {
  const state0 = clone(prev)
  if (state0.backfilled) {
    return { ok: false, message: '存量数据已按观测时间整体回填过一次，重复回填已拦下' }
  }
  if (!items.length) {
    return { ok: false, message: '回填清单为空' }
  }

  const sorted = [...items].sort((a, b) => compareByTime(a.observedAt, b.observedAt))
  for (const item of sorted) {
    const slot = normalizeSlot(item.observedAt)
    if (!slot) {
      return { ok: false, message: `回填中止：观测时间「${item.observedAt}」无法识别` }
    }
    if (state0.records.some((r) => r.slot === slot)) {
      return { ok: false, message: `回填中止：${slot} 已存在台账记录，存量回填不得覆盖既有记录` }
    }
    if (item.approvalCode && !APPROVAL_VERSIONS.some((v) => v.code === item.approvalCode)) {
      return { ok: false, message: `回填中止：${slot} 批复文号「${item.approvalCode}」未登记` }
    }
    if (item.measuredFlow !== null && !inFlowRange(item.measuredFlow)) {
      return { ok: false, message: `回填中止：${slot} 实测 ${item.measuredFlow} 超出允许范围 [${FLOW_RANGE.min}, ${FLOW_RANGE.max}]` }
    }
  }

  let state = prev
  let supplementCount = 0
  for (const item of sorted) {
    const slot = normalizeSlot(item.observedAt) as string
    const version = item.approvalCode
      ? APPROVAL_VERSIONS.find((v) => v.code === item.approvalCode) as ApprovalVersion
      : versionAt(slot)
    const rulingParts: string[] = ['存量回填']
    if (!item.approvalCode) {
      rulingParts.push(`原交接本缺批复文号，按观测时点生效版本裁决补齐为 ${version.code}`)
    }
    if (slot < APPROVAL_VERSIONS[0].effectiveFrom) {
      rulingParts.push('观测时间早于首版批复生效日，按首版口径兜底取值')
    }
    if (item.measuredFlow === null) {
      rulingParts.push('原交接本缺实测流量，不臆造数值，单独进补录队列')
    }

    const result = upsertRecord(
      state,
      {
        observedAt: item.observedAt,
        measuredFlow: item.measuredFlow,
        operator: item.operator,
        approvalCode: version.code,
        remark: rulingParts.join('；'),
      },
      '历史回填',
      { clock },
      { suppressCreateWarning: true },
    )
    if (!result.ok || !result.data) {
      return { ok: false, message: result.message }
    }
    state = result.data.state
    if (item.measuredFlow === null) {
      supplementCount += 1
      const sId = nextId(state, 'supplement')
      const supplement: EcoFlowSupplement = {
        id: sId,
        slot,
        observedAt: item.observedAt.trim(),
        approvalCode: version.code,
        minFlow: version.minFlow,
        source: '历史回填',
        operator,
        remark: '缺项补齐方式：实测流量无法从交接本复原，按“不臆造、待原报底稿/现场复测出数后补录”处理，不做插补；批复文号与指标已按当时生效版本快照补齐',
        status: '待补录',
        createdAt: nowStamp(clock),
        filledRecordCode: state.records.find((r) => r.slot === slot)?.code ?? null,
        filledAt: null,
      }
      state.seq.supplement += 1
      state.supplements.push(supplement)
    }
  }

  const finalState = clone(state)
  finalState.backfilled = true
  pushLog(finalState, '存量整体回填', `按观测时间回填 ${sorted.length} 条，其中缺实测流量转补录 ${supplementCount} 条；历史判定按当时口径，不自动挂预警`, operator, clock)
  return {
    ok: true,
    message: `回填完成：共 ${sorted.length} 条按观测时间入库，缺实测流量 ${supplementCount} 条单独进补录队列`,
    data: { state: finalState },
  }
}

/**
 * 缺项补录：为补录队列中的缺测条目补入实测值。
 * 补录同样不自动挂新预警工单（历史遗留由值班长复核），但判定结果与待办即时更新。
 */
export function fillSupplement(
  prev: EcoFlowState,
  supplementId: number,
  measuredFlow: number,
  operator: string,
  clock: () => Date = () => new Date(),
): ActionResult<{ state: EcoFlowState }> {
  const target = prev.supplements.find((s) => s.id === supplementId)
  if (!target) {
    return { ok: false, message: `补录条目 ${supplementId} 不存在` }
  }
  if (target.status === '已补录') {
    return { ok: false, message: `${target.slot} 缺项已补录，不得重复补录` }
  }
  if (!inFlowRange(measuredFlow)) {
    return { ok: false, message: `实测 ${measuredFlow} ${FLOW_RANGE.unit} 超出允许范围 [${FLOW_RANGE.min}, ${FLOW_RANGE.max}]，按统一标准拒收` }
  }
  const result = upsertRecord(
    prev,
    {
      observedAt: target.observedAt,
      measuredFlow,
      operator,
      approvalCode: target.approvalCode,
      remark: `缺项补录：原交接本缺实测流量，经复测出数补录（${target.remark}）`,
    },
    '缺项补录',
    { clock },
    { suppressCreateWarning: true },
  )
  if (!result.ok || !result.data) {
    return result
  }
  const state = result.data.state
  const supplement = state.supplements.find((s) => s.id === supplementId)
  if (supplement) {
    supplement.status = '已补录'
    supplement.filledAt = nowStamp(clock)
    supplement.filledRecordCode = result.data.record.code
  }
  pushLog(state, '缺项补录', `${target.slot} 补入实测 ${measuredFlow}，判定「${result.data.record.verdict}」`, operator, clock)
  return { ok: true, message: `${target.slot} 已补录为 ${measuredFlow}，判定「${result.data.record.verdict}」`, data: { state } }
}

/**
 * 预警处置：环节只能顺序推进（待处置→处置中→已处置→已销号），跳级直接拦下并说明缺哪一步。
 * 处置结论随环节写回，闸门启闭与检修待办读到的是同一条工单。
 */
export function advanceWarning(
  prev: EcoFlowState,
  warningId: number,
  to: WarningStage,
  operator: string,
  note: string,
  clock: () => Date = () => new Date(),
): ActionResult<{ state: EcoFlowState }> {
  const state = clone(prev)
  const warning = state.warnings.find((w) => w.id === warningId)
  if (!warning) {
    return { ok: false, message: `预警工单 ${warningId} 不存在` }
  }
  if (warning.stage === '已销号') {
    return { ok: false, message: `${warning.slot} 预警已销号，环节已闭环，不能再推进` }
  }
  const guard = canAdvance(warning.stage, to)
  if (!guard.ok) {
    if (guard.missing.length === 0) {
      return { ok: false, message: `「${warning.stage}」不能转到「${to}」，环节只能顺序向前推进` }
    }
    return {
      ok: false,
      message: `跳级操作已拦下：「${warning.stage}」→「${to}」缺少环节 ${guard.missing.join('、')}，请先逐级推进`,
    }
  }
  if (to === '已处置' && note.trim() === '') {
    return { ok: false, message: '推进到「已处置」必须填写处置结论，结论要回写闸门启闭与检修待办' }
  }
  const from = warning.stage
  warning.stage = to
  warning.actions.push({ from, to, operator, note: note.trim(), at: nowStamp(clock) })
  if (to === '处置中' || to === '已处置') {
    warning.conclusion = note.trim() || warning.conclusion
  }
  if (to === '已销号') {
    warning.closedAt = nowStamp(clock)
  }
  pushLog(state, '预警环节推进', `${warning.slot}：${from} → ${to}${note ? `（${note}）` : ''}`, operator, clock)

  const record = state.records.find((r) => r.slot === warning.slot)
  if (record) {
    syncTodosFor(state, record, warning, { clock })
  }
  return { ok: true, message: `预警已从「${from}」推进到「${to}」`, data: { state } }
}

/** 连续未达标小时数：以最新一条向前数连续判定「未达标」的整时段。 */
export function consecutiveFailureHours(state: EcoFlowState): number {
  const sorted = [...state.records].sort((a, b) => (a.slot < b.slot ? 1 : a.slot > b.slot ? -1 : 0))
  let count = 0
  for (const record of sorted) {
    if (record.verdict === '未达标') count += 1
    else if (record.verdict === '达标') break
    // 缺测不打断连续计数，也不计入
  }
  return count
}

/** 台账与导出明细同源：导出永远从当前台账即时生成，不另存副本。 */
export function exportLedger(state: EcoFlowState): string {
  const header = [
    '台账编号', '观测时段', '环评批复文号', '最小下泄指标(m³/s)',
    '实测下泄流量(m³/s)', '判定结果', '数据来源', '报送人', '版次', '备注', '更新时间',
  ]
  const lines = [header.join(',')]
  const esc = (value: string | number | null) => {
    const text = value === null ? '缺测' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  const sorted = [...state.records].sort((a, b) => compareByTime(a.slot, b.slot))
  for (const r of sorted) {
    lines.push([
      r.code, r.slot, r.approvalCode, r.minFlow, r.measuredFlow,
      r.verdict, r.source, r.operator, `第${r.revision}版`, esc(r.remark), r.updatedAt,
    ].map(esc).join(','))
  }
  return `﻿${lines.join('\n')}`
}

/** 导出的明细条数必须与台账一致（同一事实源，台账更新导出同步更新）。 */
export function exportRowCount(state: EcoFlowState): number {
  return exportLedger(state).trim().split('\n').length - 1
}
