import { LEGACY_ECO_ROWS, SEED_EIA_VERSIONS } from '@/data/eco-legacy'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'
import {
  ECO_FLOW_RULES,
  findVersion,
  judgeMeasured,
  normalizeObserveTime,
  nowText,
  resolveVersion,
  transitionWarning,
  type EiaVersion,
  type WarningAction,
  type WarningStatus,
} from '@/domain/eco-flow'

/**
 * 生态流量监管服务：台账、预警、报送批次、批复版本都集中在这里。
 * 水情调度、泄洪操作、闸门启闭、机组检修各入口读到的判定结果与待办条数，
 * 全部来自本服务的同一份数据，不各自算一遍。
 */

const LEDGER_KEY = 'ecoflow'
const WARNING_KEY = 'ecoflow_warning'
const META_KEY = 'hydropower-plant-om:ecoflow-meta'

export const LEDGER_COLUMNS = [
  '记录编号',
  '观测时间',
  '环评批复文号',
  '最小下泄指标',
  '实测下泄流量',
  '达标判定',
  '报送批次',
  '预警编号',
  '数据来源',
  '备注',
] as const

export const WARNING_COLUMNS = [
  '预警编号',
  '记录编号',
  '观测时间',
  '环评批复文号',
  '最小下泄指标',
  '实测下泄流量',
  '触发时间',
  '处置人',
  '处置结论',
  '办结时间',
  '备注',
] as const

type EcoMeta = {
  versions: EiaVersion[]
  batches: string[] // 已入库的报送批次：以最先入库的一稿为准
  backfilled: boolean
  backfillNote: string
  recordSeq: number
  warningSeq: number
}

function seedMeta(): EcoMeta {
  return {
    versions: SEED_EIA_VERSIONS.map((item) => ({ ...item })),
    batches: [],
    backfilled: false,
    backfillNote: '',
    recordSeq: 0,
    warningSeq: 0,
  }
}

function loadMeta(): EcoMeta {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedMeta()
  }
  const raw = window.localStorage.getItem(META_KEY)
  if (!raw) {
    const meta = seedMeta()
    window.localStorage.setItem(META_KEY, JSON.stringify(meta))
    return meta
  }
  try {
    return { ...seedMeta(), ...(JSON.parse(raw) as EcoMeta) }
  } catch {
    const meta = seedMeta()
    window.localStorage.setItem(META_KEY, JSON.stringify(meta))
    return meta
  }
}

function saveMeta(meta: EcoMeta): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(META_KEY, JSON.stringify(meta))
  }
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function padSeq(value: number): string {
  return String(value).padStart(4, '0')
}

// ---------- 读取：各入口共用的同一份结果 ----------

export function listLedger(): EntryRow[] {
  ensureBackfilled()
  return [...listRows(LEDGER_KEY)].sort((a, b) =>
    String(a.观测时间).localeCompare(String(b.观测时间)),
  )
}

export function listWarnings(): EntryRow[] {
  ensureBackfilled()
  return listRows(WARNING_KEY)
}

export function listVersions(): EiaVersion[] {
  return [...loadMeta().versions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))
}

export function backfillState(): { done: boolean; note: string } {
  const meta = loadMeta()
  return { done: meta.backfilled, note: meta.backfillNote }
}

/** 未收尾的预警（待处置 + 处置中）：泄洪值班在另一个入口看到的就是这一份。 */
export function openWarnings(): EntryRow[] {
  return listWarnings().filter((row) => row.pending)
}

/** 联动到闸门启闭值班待办里的生态预警条数（与闸门入口读到的对应）。 */
export function gateLinkedTodoCount(): number {
  ensureBackfilled()
  return listRows('gate').filter(
    (row) => String(row.闸门编号 ?? '').startsWith('WARN-') && row.pending,
  ).length
}

/** 回写到机组检修待办里的预警处置结论条数（与检修入口读到的对应）。 */
export function overhaulLinkedTodoCount(): number {
  ensureBackfilled()
  return listRows('overhaul').filter(
    (row) => String(row.工作票号 ?? '').startsWith('ECO-WARN-') && row.pending,
  ).length
}

/** 从最新一条记录往前数，连续未达标的整点小时数。 */
export function consecutiveShortHours(): number {
  const rows = listLedger()
    .filter((row) => row.达标判定 !== '缺测')
    .sort((a, b) => String(b.观测时间).localeCompare(String(a.观测时间)))
  let hours = 0
  let expect: number | null = null
  for (const row of rows) {
    if (row.达标判定 !== '未达标') {
      break
    }
    const time = new Date(String(row.观测时间).replace(' ', 'T') + ':00').getTime()
    if (expect !== null && time !== expect) {
      break
    }
    hours += 1
    expect = time - 3600_000
  }
  return hours
}

export type EcoSummary = {
  total: number
  compliant: number
  short: number
  outOfRange: number
  missing: number
  pendingWarnings: number
  handlingWarnings: number
  closedWarnings: number
  openWarningTotal: number
  shortHours: number
  gateLinked: number
  overhaulLinked: number
  activeVersion: EiaVersion | null
}

/** 水情记录与泄洪操作两边的待办都读这里：同一个判定结果，同一组条数。 */
export function ecoFlowSummary(): EcoSummary {
  const ledger = listLedger()
  const warnings = listWarnings()
  const pending = warnings.filter((row) => row.status === '待处置').length
  const handling = warnings.filter((row) => row.status === '处置中').length
  return {
    total: ledger.length,
    compliant: ledger.filter((row) => row.达标判定 === '达标').length,
    short: ledger.filter((row) => row.达标判定 === '未达标').length,
    outOfRange: ledger.filter((row) => row.达标判定 === '超范围').length,
    missing: ledger.filter((row) => row.达标判定 === '缺测').length,
    pendingWarnings: pending,
    handlingWarnings: handling,
    closedWarnings: warnings.filter((row) => row.status === '已办结').length,
    openWarningTotal: pending + handling,
    shortHours: consecutiveShortHours(),
    gateLinked: gateLinkedTodoCount(),
    overhaulLinked: overhaulLinkedTodoCount(),
    activeVersion: resolveVersion(loadMeta().versions, nowText()),
  }
}

// ---------- 写入：报送、回填、预警流转 ----------

export type SubmitRow = {
  观测时间: string
  实测下泄流量: string
  环评批复文号?: string
}

/**
 * 整批报送：以最先入库的一稿为准，后到的整套退回，重复提交只留一条。
 * 同一时段的实测流量只认最后一次，后来的一笔直接盖掉前一笔，不做累加。
 */
export function submitBatch(batchNo: string, rows: SubmitRow[]): ActionResult {
  ensureBackfilled()
  const meta = loadMeta()
  const batch = batchNo.trim()
  if (!batch) {
    return { ok: false, message: '报送批次号不能为空' }
  }
  if (meta.batches.includes(batch)) {
    return {
      ok: false,
      message: `批次 ${batch} 已入库：以最先入库的一稿为准，后到的整套退回，重复提交只留一条`,
    }
  }
  if (rows.length === 0) {
    return { ok: false, message: '报送内容为空，整批退回' }
  }
  const parsed: { time: string; measured: number | null; docNo: string }[] = []
  for (const row of rows) {
    const time = normalizeObserveTime(row.观测时间)
    if (!time) {
      return { ok: false, message: `观测时间「${row.观测时间}」格式不对，整批退回` }
    }
    const text = row.实测下泄流量.trim()
    const measured = text === '' ? null : Number(text)
    if (measured !== null && Number.isNaN(measured)) {
      return { ok: false, message: `实测下泄流量「${row.实测下泄流量}」不是数字，整批退回` }
    }
    parsed.push({ time, measured, docNo: (row.环评批复文号 ?? '').trim() })
  }
  meta.batches.push(batch)
  const ledger = listRows(LEDGER_KEY)
  const warnings = listRows(WARNING_KEY)
  const notes: string[] = []
  for (const item of parsed) {
    const note = upsertRecord(ledger, warnings, meta, {
      time: item.time,
      measured: item.measured,
      docNo: item.docNo,
      batch,
      source: '实时报送',
    })
    notes.push(note)
  }
  saveRows(LEDGER_KEY, ledger)
  saveRows(WARNING_KEY, warnings)
  saveMeta(meta)
  return { ok: true, message: `批次 ${batch} 已入库：${notes.join('；')}` }
}

type UpsertInput = {
  time: string
  measured: number | null
  docNo: string
  batch: string
  source: string
}

/** 单条入库：缺项补齐方式由台账裁决并写进备注；低于最小下泄自动挂预警。 */
function upsertRecord(
  ledger: EntryRow[],
  warnings: EntryRow[],
  meta: EcoMeta,
  input: UpsertInput,
): string {
  const remarks: string[] = []
  let docNo = input.docNo
  let version = docNo ? findVersion(meta.versions, docNo) : null
  if (docNo && !version) {
    remarks.push(`所报文号「${docNo}」未登记，按观测时间匹配版本补齐`)
    docNo = ''
  }
  if (!docNo) {
    const resolved = resolveVersion(meta.versions, input.time)
    if (!resolved) {
      remarks.push('批复版本库为空，无法匹配文号')
    } else {
      version = resolved
      docNo = resolved.docNo
      remarks.push(`缺批复文号，按观测时间落入「${resolved.docNo}」生效区间补齐（裁决口径）`)
    }
  }
  const minFlow = version ? version.minFlow : NaN
  const judge = version ? judgeMeasured(input.measured, minFlow) : '缺测'
  if (judge === '超范围') {
    remarks.push(
      `实测值超出取值范围 ${ECO_FLOW_RULES.minMeasured}~${ECO_FLOW_RULES.maxMeasured} 立方米每秒，按超范围处理`,
    )
  }
  if (judge === '缺测') {
    remarks.push('缺实测流量，按缺测处理：不估算、不挂预警，待补测后按同一时段重新报送覆盖')
  }

  const existing = ledger.find((row) => row.观测时间 === input.time)
  if (existing) {
    // 同一时段重复提交：后来的一笔直接盖掉前一笔，不做累加。
    existing.实测下泄流量 = input.measured === null ? '缺测' : input.measured
    existing.环评批复文号 = docNo
    existing.最小下泄指标 = version ? minFlow : '未定'
    existing.达标判定 = judge
    existing.报送批次 = input.batch
    existing.备注 = [...remarks, `同一时段重复报送，本笔覆盖前一笔（批次 ${input.batch}），不累加`].join('；')
    applyJudgeToRecord(existing, judge)
    reconcileWarning(existing, warnings, judge, meta)
    return `${input.time} 覆盖入库（同时段只认最后一次）`
  }

  meta.recordSeq += 1
  const record: EntryRow = {
    id: nextId(ledger),
    status: '正常',
    pending: false,
    abnormal: false,
    记录编号: `ECO-${padSeq(meta.recordSeq)}`,
    观测时间: input.time,
    环评批复文号: docNo,
    最小下泄指标: version ? minFlow : '未定',
    实测下泄流量: input.measured === null ? '缺测' : input.measured,
    达标判定: judge,
    报送批次: input.batch,
    预警编号: '',
    数据来源: input.source,
    备注: remarks.join('；'),
  }
  applyJudgeToRecord(record, judge)
  ledger.push(record)
  if (judge === '未达标') {
    createWarning(record, warnings, meta)
  }
  return `${input.time} 新入库`
}

function applyJudgeToRecord(record: EntryRow, judge: string): void {
  if (judge === '达标') {
    record.status = '正常'
    record.pending = false
    record.abnormal = false
  } else if (judge === '未达标') {
    record.status = '预警中'
    record.pending = true
    record.abnormal = true
  } else if (judge === '超范围') {
    record.status = '超范围'
    record.pending = true
    record.abnormal = true
  } else {
    record.status = '缺测待补'
    record.pending = true
    record.abnormal = true
  }
}

/** 低于最小下泄自动挂预警；重复报送只更新已有预警，不再多挂一条。 */
function reconcileWarning(record: EntryRow, warnings: EntryRow[], judge: string, meta: EcoMeta): void {
  const open = warnings.find(
    (row) => row.记录编号 === record.记录编号 && (row.status === '待处置' || row.status === '处置中'),
  )
  if (judge === '未达标') {
    if (open) {
      open.实测下泄流量 = record.实测下泄流量
      open.备注 = '同一时段重复报送已覆盖实测值，未新增预警'
      record.预警编号 = open.预警编号
    } else {
      createWarning(record, warnings, meta)
    }
    return
  }
  if (open) {
    // 覆盖后不再低于最小下泄：原预警核销，闸门联动待办同步收尾。
    open.status = '已核销'
    open.pending = false
    open.abnormal = false
    open.办结时间 = nowText()
    open.备注 = `数据更正为「${judge}」，预警核销`
    record.预警编号 = ''
    closeGateTodo(String(open.预警编号), '已核销', `数据更正为「${judge}」，预警核销`)
  }
}

function createWarning(record: EntryRow, warnings: EntryRow[], meta: EcoMeta): void {
  meta.warningSeq += 1
  const warnNo = `WARN-${padSeq(meta.warningSeq)}`
  const warning: EntryRow = {
    id: nextId(warnings),
    status: '待处置',
    pending: true,
    abnormal: true,
    预警编号: warnNo,
    记录编号: record.记录编号,
    观测时间: record.观测时间,
    环评批复文号: record.环评批复文号,
    最小下泄指标: record.最小下泄指标,
    实测下泄流量: record.实测下泄流量,
    触发时间: nowText(),
    处置人: '',
    处置结论: '',
    办结时间: '',
    备注: `实测低于最小下泄 ${String(record.最小下泄指标)} 立方米每秒，自动挂预警`,
  }
  warnings.push(warning)
  record.预警编号 = warnNo
  openGateTodo(warning)
}

/** 预警一挂出就联动到闸门启闭的值班待办清单，泄洪值班在另一个入口能看到。 */
function openGateTodo(warning: EntryRow): void {
  const gates = listRows('gate')
  gates.push({
    id: nextId(gates),
    status: '待操作',
    pending: true,
    abnormal: true,
    闸门编号: String(warning.预警编号),
    闸门类型: '生态下泄预警联动',
    孔口尺寸: '—',
    当前开度: '—',
    启闭机型号: '—',
    操作人员: '系统联动',
    操作时间: String(warning.触发时间),
    闸门状态: '待处置',
    联动备注: `生态流量预警 ${String(warning.预警编号)}：${String(warning.观测时间)} 实测 ${String(
      warning.实测下泄流量,
    )} 立方米每秒，低于最小下泄 ${String(warning.最小下泄指标)} 立方米每秒（${String(
      warning.环评批复文号,
    )}）`,
  })
  saveRows('gate', gates)
}

function closeGateTodo(warnNo: string, stage: string, note: string): void {
  const gates = listRows('gate')
  const index = gates.findIndex((row) => row.闸门编号 === warnNo)
  if (index < 0) {
    return
  }
  gates[index] = {
    ...gates[index],
    status: '已关闭',
    pending: false,
    abnormal: false,
    闸门状态: stage,
    联动备注: `${String(gates[index].联动备注 ?? '')}；${note}`,
  }
  saveRows('gate', gates)
}

/** 办结时把处置结论回写到机组检修的待办清单，另一个入口读到的条数与这里对应。 */
function writeOverhaulTodo(warning: EntryRow): void {
  const rows = listRows('overhaul')
  rows.push({
    id: nextId(rows),
    status: '待审批',
    pending: true,
    abnormal: false,
    工作票号: `ECO-${String(warning.预警编号)}`,
    检修机组: '坝下生态泄放设施',
    检修级别: '预警处置跟进',
    计划工期: '待定',
    实际工期: '—',
    工作负责人: '待指派',
    验收人员: '—',
    检修状态: '待审批',
    处置结论: String(warning.处置结论),
  })
  saveRows('overhaul', rows)
}

/** 预警处置：环节只能按顺序推进，跳级的直接拦下并说明缺哪一步。 */
export function actOnWarning(warnNo: string, action: WarningAction, conclusion = ''): ActionResult {
  const warnings = listRows(WARNING_KEY)
  const index = warnings.findIndex((row) => row.预警编号 === warnNo)
  if (index < 0) {
    return { ok: false, message: `没有找到预警 ${warnNo}` }
  }
  const warning = warnings[index]
  const result = transitionWarning(warning.status as WarningStatus, action)
  if (!result.ok) {
    return { ok: false, message: `${warnNo}：${result.message}` }
  }
  if (action === '办结预警' && !conclusion.trim()) {
    return { ok: false, message: '办结预警必须填写处置结论，结论要回写到闸门与检修的待办清单' }
  }
  warning.status = result.target
  warning.pending = result.target !== '已办结'
  warning.abnormal = result.target !== '已办结'
  warning.处置人 = '值班管理员'
  if (action === '办结预警') {
    warning.处置结论 = conclusion.trim()
    warning.办结时间 = nowText()
    warnings[index] = warning
    saveRows(WARNING_KEY, warnings)
    // 处置结论同步回写：闸门联动待办收尾、检修待办新增一条跟进。
    closeGateTodo(warnNo, '已办结', `处置结论：${warning.处置结论}`)
    writeOverhaulTodo(warning)
    const ledger = listRows(LEDGER_KEY)
    const record = ledger.find((row) => row.记录编号 === warning.记录编号)
    if (record) {
      record.status = '已办结'
      record.pending = false
      record.abnormal = false
      saveRows(LEDGER_KEY, ledger)
    }
    return { ok: true, message: `${warnNo} 已办结，结论已回写闸门启闭与机组检修待办` }
  }
  warnings[index] = warning
  saveRows(WARNING_KEY, warnings)
  return { ok: true, message: `${warnNo} 已受理，当前状态「处置中」` }
}

/** 登记换版批复：只影响新记录，既有记录仍按当时口径取值。 */
export function registerEiaVersion(input: EiaVersion): ActionResult {
  const meta = loadMeta()
  const docNo = input.docNo.trim()
  if (!docNo || !input.effectiveFrom || !(input.minFlow > 0)) {
    return { ok: false, message: '批复文号、生效日期、最小下泄指标都要填，且指标必须大于 0' }
  }
  if (meta.versions.some((item) => item.docNo === docNo)) {
    return { ok: false, message: `文号 ${docNo} 已登记，换版请使用新文号` }
  }
  meta.versions.push({ ...input, docNo })
  saveMeta(meta)
  return { ok: true, message: `批复 ${docNo} 已登记：只影响新记录，既有记录仍按当时口径取值` }
}

/** 存量数据按观测时间整体回填一次；缺项记录单独补录。 */
export function ensureBackfilled(): void {
  if (!loadMeta().backfilled) {
    runBackfill()
  }
}

export function runBackfill(): ActionResult {
  const meta = loadMeta()
  if (meta.backfilled) {
    return { ok: false, message: '存量数据已整体回填过一次，不重复回填' }
  }
  const sorted = [...LEGACY_ECO_ROWS]
    .filter((row) => row.观测时间)
    .sort((a, b) => a.观测时间.localeCompare(b.观测时间))
  const skipped = LEGACY_ECO_ROWS.length - sorted.length
  const ledger = listRows(LEDGER_KEY)
  const warnings = listRows(WARNING_KEY)
  meta.batches.push('BACKFILL-2026')
  let supplementary = 0
  for (const row of sorted) {
    const time = normalizeObserveTime(row.观测时间)
    if (!time) {
      continue
    }
    const source = row.实测下泄流量 === null ? '缺项补录' : '存量回填'
    if (row.实测下泄流量 === null) {
      supplementary += 1
    }
    upsertRecord(ledger, warnings, meta, {
      time,
      measured: row.实测下泄流量,
      docNo: (row.环评批复文号 ?? '').trim(),
      batch: 'BACKFILL-2026',
      source,
    })
  }
  meta.backfilled = true
  meta.backfillNote = `按观测时间顺序回填 ${sorted.length} 条（含缺项补录 ${supplementary} 条）${
    skipped > 0 ? `，${skipped} 条缺观测时间无法定位时段，未入库` : ''
  }`
  saveRows(LEDGER_KEY, ledger)
  saveRows(WARNING_KEY, warnings)
  saveMeta(meta)
  return { ok: true, message: meta.backfillNote }
}

// ---------- 导出：台账与导出的明细同时更新（同一份数据，随点随取） ----------

function toCsv(columns: readonly string[], rows: EntryRow[]): string {
  const lines = [columns.join(',')]
  for (const row of rows) {
    lines.push(columns.map((column) => String(row[column] ?? '')).join(','))
  }
  return `\uFEFF${lines.join('\n')}`
}

export function exportLedger(): { filename: string; content: string } {
  return { filename: '生态流量台账-明细.csv', content: toCsv(LEDGER_COLUMNS, listLedger()) }
}

export function exportWarnings(): { filename: string; content: string } {
  return { filename: '生态下泄预警-明细.csv', content: toCsv(WARNING_COLUMNS, listWarnings()) }
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
