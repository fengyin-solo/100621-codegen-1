/**
 * 生态流量监管领域规则验证（不依赖测试框架，用 node 直接跑）。
 * 运行：node --import ./domain-tests.register.mjs src/domain/ecoflow/domain-tests.ts
 * 或：npm run test:ecoflow（经 esbuild 转译后运行）
 */
import {
  FLOW_RANGE,
  WARNING_STAGES,
  canAdvance,
  judge,
  versionAt,
} from './policy'
import { normalizeSlot } from './slot'
import {
  advanceWarning,
  consecutiveFailureHours,
  createInitialState,
  exportLedger,
  exportRowCount,
  fillSupplement,
  importBatch,
  runBackfill,
  submitFlow,
} from './engine'
import {
  BACKFILL_PAYLOAD,
} from './seed'
import {
  floodTodos,
  gateDutyTodos,
  hydrologyTodos,
  overhaulTodos,
} from './selectors'
import type { EcoFlowRecord, EcoFlowState } from './types'

type AnyResult = {
  ok: boolean
  message: string
  data?: { state: EcoFlowState; record?: EcoFlowRecord }
}

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, condition: boolean, extra = ''): void {
  if (condition) {
    passed += 1
  } else {
    failed += 1
    failures.push(`${name}${extra ? ` — ${extra}` : ''}`)
    console.error(`✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

// 固定时钟，避免时间相关断言抖动
let tick = 0
const clock = () => new Date(2026, 9, 5, 12, 0, tick++)

// ---------- 1. 全站唯一口径 ----------
eq('2018版指标 8.5', versionAt('2023-08-10 09:00').minFlow, 8.5)
eq('2024换版指标 10.0', versionAt('2024-06-02 14:00').minFlow, 10.0)
eq('2018版文号', versionAt('2023-01-01 00:00').code, '环审〔2018〕27号')
eq('2024版文号', versionAt('2026-10-05 08:00').code, '环审〔2024〕12号')
eq('达标判定：等于阈值算达标', judge(8.5, 8.5), '达标')
eq('未达标判定：低于阈值', judge(8.4, 8.5), '未达标')
eq('缺测判定', judge(null, 8.5), '缺测')
eq('时段归一化到整点', normalizeSlot('2026-10-05T09:47:12'), '2026-10-05 09:00')
check('唯一取值上限为 100', FLOW_RANGE.max === 100)

// ---------- 2. 在线报送：同时段后写覆盖、不累加、不重复挂预警 ----------
let s = createInitialState()
let r: AnyResult = submitFlow(s, { observedAt: '2026-10-05 09:00', measuredFlow: 7.0, operator: '甲' }, '在线报送', clock)
check('首次报送成功', r.ok && !!r.data)
s = r.data!.state
r = submitFlow(s, { observedAt: '2026-10-05 09:00', measuredFlow: 6.0, operator: '乙' }, '在线报送', clock)
s = r.data!.state
eq('同一时段只留一条记录', s.records.length, 1)
eq('后到一笔盖掉前一笔', s.records[0].measuredFlow, 6.0)
eq('版次累加到 2', s.records[0].revision, 2)
eq('未达标自动挂预警且不重复', s.warnings.length, 1)
r = submitFlow(s, { observedAt: '2026-10-05 09:00', measuredFlow: 5.0, operator: '丙' }, '在线报送', clock)
s = r.data!.state
eq('第三次报送仍只有一条预警', s.warnings.length, 1)
eq('预警实测值随覆盖更新为 5.0', s.warnings[0].measuredFlow, 5.0)

// ---------- 3. 超范围按统一标准拒收 ----------
r = submitFlow(s, { observedAt: '2026-10-05 10:00', measuredFlow: 120, operator: '甲' }, '在线报送', clock)
check('超上限拒收', !r.ok && r.message.includes('超出唯一允许范围'))
r = submitFlow(s, { observedAt: '2026-10-05 10:00', measuredFlow: -1, operator: '甲' }, '在线报送', clock)
check('负值拒收', !r.ok)
eq('拒收不产生记录', s.records.length, 1)

// ---------- 4. 批复快照固化：既有记录不随换版改变 ----------
r = submitFlow(createInitialState(), { observedAt: '2023-08-10 09:00', measuredFlow: 9.0, operator: '甲' }, '在线报送', clock)
const oldRec = r.data!.state.records[0]
eq('既有记录固化当时文号', oldRec.approvalCode, '环审〔2018〕27号')
eq('既有记录固化当时指标 8.5', oldRec.minFlow, 8.5)
eq('9.0 在旧版口径下达标', oldRec.verdict, '达标')
r = submitFlow(createInitialState(), { observedAt: '2024-06-02 14:00', measuredFlow: 9.0, operator: '甲' }, '在线报送', clock)
const newRec = r.data!.state.records[0]
eq('新记录用换版指标 10.0', newRec.minFlow, 10.0)
eq('9.0 在新版口径下未达标', newRec.verdict, '未达标')

// ---------- 5. 恢复达标自动销号同一工单 ----------
s = createInitialState()
s = submitFlow(s, { observedAt: '2026-10-05 08:00', measuredFlow: 7, operator: '甲' }, '在线报送', clock).data!.state
s = submitFlow(s, { observedAt: '2026-10-05 08:00', measuredFlow: 11, operator: '甲' }, '在线报送', clock).data!.state
eq('预警同一条', s.warnings.length, 1)
eq('恢复达标后自动销号', s.warnings[0].stage, '已销号')
check('销号保留处置轨迹', s.warnings[0].actions.some((a) => a.to === '已销号'))

// ---------- 6. 环节只能顺序推进，跳级拦下并说明缺哪一步 ----------
s = createInitialState()
s = submitFlow(s, { observedAt: '2026-10-05 08:00', measuredFlow: 7, operator: '甲' }, '在线报送', clock).data!.state
const wid = s.warnings[0].id
r = advanceWarning(s, wid, '已处置', '乙', '结论', clock)
check('待处置跳到已处置被拦', !r.ok)
check('拦阻信息说明缺“处置中”', r.message.includes('处置中'))
eq('被拦后环节不变', s.warnings[0].stage, '待处置')
r = advanceWarning(s, wid, '处置中', '乙', '调整开度', clock)
check('待处置→处置中放行', r.ok)
s = r.data!.state
r = advanceWarning(s, wid, '已销号', '乙', '销号', clock)
check('处置中跳到已销号被拦（缺已处置）', !r.ok && r.message.includes('已处置'))
r = advanceWarning(s, wid, '已处置', '乙', '', clock)
check('已处置必须有处置结论', !r.ok)
r = advanceWarning(s, wid, '已处置', '乙', '已恢复 10.8 m³/s', clock)
s = r.data!.state
r = advanceWarning(s, wid, '已销号', '乙', '复核销号', clock)
check('已处置→已销号放行', r.ok)
s = r.data!.state
r = advanceWarning(s, wid, '处置中', '乙', '回退', clock)
check('已销号不能再推进', !r.ok)
eq('环节顺序定义', WARNING_STAGES, ['待处置', '处置中', '已处置', '已销号'])
eq('守卫自身正确', canAdvance('待处置', '已处置').missing, ['处置中'])

// ---------- 7. 处置结论回写闸门启闭待办，另一个入口看到同一条未收尾预警 ----------
s = createInitialState()
s = submitFlow(s, { observedAt: '2026-10-05 08:00', measuredFlow: 7, operator: '甲' }, '在线报送', clock).data!.state
s = submitFlow(s, { observedAt: '2026-10-05 09:00', measuredFlow: 6, operator: '甲' }, '在线报送', clock).data!.state
eq('无处置结论前检修待办为 0', overhaulTodos(s).openCount, 0)
s = advanceWarning(s, s.warnings.find((w) => w.slot === '2026-10-05 09:00')!.id, '处置中', '乙', '闸门加开一孔', clock).data!.state
const gateView = gateDutyTodos(s)
eq('闸门待办看到 2 条未收尾预警', gateView.openCount, 2)
const withConclusion = gateView.todos.find((t) => t.slot === '2026-10-05 09:00')
eq('处置结论原样回写到闸门待办', withConclusion?.conclusion, '闸门加开一孔')
eq('闸门待办预警阶段与工单一致', withConclusion?.stage, '处置中')

// ---------- 8. 水情与泄洪读同一个判定结果 ----------
const hView = hydrologyTodos(s)
const fView = floodTodos(s)
eq('水情与泄洪待办条数一致', hView.todos.length, fView.todos.length)
const paired = hView.todos.every((t) => {
  const other = fView.todos.find((o) => o.slot === t.slot)
  return other && other.verdict === t.verdict && other.warningId === t.warningId && other.open === t.open
})
check('水情、泄洪逐条判定同源', paired)
eq('水情未收尾计数与泄洪相同', hView.openCount, fView.openCount)

// ---------- 9. 结论回写检修待办，条数与主台账对应 ----------
check('处置中已填结论即进入检修待办', overhaulTodos(s).openCount >= 1)
s = advanceWarning(s, s.warnings.find((w) => w.slot === '2026-10-05 09:00')!.id, '已处置', '乙', '闸门加开一孔，流量恢复', clock).data!.state
eq('已处置后检修待办 1 条', overhaulTodos(s).openCount, 1)
eq('检修待办结论与工单一致', overhaulTodos(s).todos[0].conclusion, '闸门加开一孔，流量恢复')
s = advanceWarning(s, s.warnings.find((w) => w.slot === '2026-10-05 09:00')!.id, '已销号', '乙', '复核销号', clock).data!.state
eq('销号后检修待办仍保留（结论可追溯）', overhaulTodos(s).todos.length, 1)
eq('销号后检修未收尾计数清零', overhaulTodos(s).openCount, 0)
eq('闸门待办剩余另一条未收尾', gateDutyTodos(s).openCount, 1)

// ---------- 10. 连续未达标小时 ----------
s = createInitialState()
const seq: Array<[string, number]> = [
  ['2026-10-05 08:00', 7], ['2026-10-05 09:00', 6], ['2026-10-05 10:00', 5],
]
for (const [t, v] of seq) s = submitFlow(s, { observedAt: t, measuredFlow: v, operator: '甲' }, '在线报送', clock).data!.state
eq('连续 3 小时未达标', consecutiveFailureHours(s), 3)
s = submitFlow(s, { observedAt: '2026-10-05 11:00', measuredFlow: 12, operator: '甲' }, '在线报送', clock).data!.state
eq('最新一条达标后连续计数清零', consecutiveFailureHours(s), 0)

// ---------- 11. 批量报送：以最先入库一稿为准，后到整套退回，重复提交只留一条 ----------
s = createInitialState()
r = importBatch(s, 'B-01', [
  { observedAt: '2026-10-05 08:00', measuredFlow: 7, operator: '甲' },
  { observedAt: '2026-10-05 09:00', measuredFlow: 200, operator: '甲' },
], clock)
check('整稿校验：超范围整套退回', !r.ok && r.message.includes('整套退回'))
eq('整套退回不入库', s.records.length, 0)
r = importBatch(s, 'B-01', [
  { observedAt: '2026-10-05 08:00', measuredFlow: 7, operator: '甲' },
  { observedAt: '2026-10-05 09:00', measuredFlow: 8, operator: '甲' },
], clock)
check('合法批次入库', r.ok)
s = r.data!.state
eq('批次入库 2 条', s.records.length, 2)
r = importBatch(s, 'B-01', [
  { observedAt: '2026-10-05 08:00', measuredFlow: 99, operator: '甲' },
], clock)
check('重复批次整套退回', !r.ok && r.message.includes('最先入库'))
eq('退回后数据未被改', s.records.find((x) => x.slot === '2026-10-05 08:00')!.measuredFlow, 7)
r = importBatch(s, 'B-02', [
  { observedAt: '2026-10-05 10:00', measuredFlow: 5, operator: '甲' },
  { observedAt: '2026-10-05 10:00', measuredFlow: 6, operator: '甲' },
], clock)
s = r.data!.state
eq('批次内同时段重复只留最后一行', s.records.filter((x) => x.slot === '2026-10-05 10:00').length, 1)
eq('批次内后写覆盖为 6', s.records.find((x) => x.slot === '2026-10-05 10:00')!.measuredFlow, 6)

// ---------- 12. 存量回填：按时间顺序、缺文号裁决、缺实测单独补录、只回填一次 ----------
s = createInitialState()
r = runBackfill(s, BACKFILL_PAYLOAD, '值班长', clock)
check('回填成功', r.ok && !!r.data)
s = r.data!.state
eq('回填记录数 = 7', s.records.length, 7)
eq('缺实测单独进补录队列 1 条', s.supplements.length, 1)
eq('补录条目为待补录', s.supplements[0].status, '待补录')
const first = s.records.find((x) => x.slot === '2009-03-12 09:00')!
eq('缺文号按观测时点裁决补齐（2009 兜底首版）', first.approvalCode, '环审〔2018〕27号')
check('裁决理由写入备注', first.remark.includes('按观测时点生效版本裁决补齐'))
const old = s.records.find((x) => x.slot === '2023-08-10 09:00')!
eq('2023 记录按旧版 8.5 判未达标', old.verdict, '未达标')
const switched = s.records.find((x) => x.slot === '2024-06-02 14:00')!
eq('2024 记录按新版 10.0 判未达标', switched.minFlow, 10.0)
eq('回填按观测时间升序入库', s.records.map((x) => x.slot), [...s.records.map((x) => x.slot)].sort())
check('历史未达标不自动挂新预警工单', s.warnings.length === 0)
check('历史判定仍在水情/泄洪待办可见', hydrologyTodos(s).todos.length === 7 && floodTodos(s).todos.length === 7)
r = runBackfill(s, BACKFILL_PAYLOAD, '值班长', clock)
check('重复回填被拦下', !r.ok && r.message.includes('已'))
const beforeCount = s.records.length
s = runBackfill(s, BACKFILL_PAYLOAD, '值班长', clock).data?.state ?? s
eq('拦下后记录数不变', s.records.length, beforeCount)

// ---------- 13. 缺项补录 ----------
const supId = s.supplements[0].id
r = fillSupplement(s, supId, 9.0, '复核员', clock)
check('补录成功', r.ok)
s = r.data!.state
eq('补录后条目状态为已补录', s.supplements[0].status, '已补录')
const filledRec = s.records.find((x) => x.slot === s.supplements[0].slot)!
eq('补录值写入台账', filledRec.measuredFlow, 9.0)
eq('补录按当时指标判定', filledRec.minFlow, 8.5)
check('补录来源标记为缺项补录', filledRec.source === '缺项补录' || filledRec.remark.includes('缺项补录'))
check('补录不自动挂预警', s.warnings.length === 0)
r = fillSupplement(s, supId, 8.0, '复核员', clock)
check('已补录不得重复补录', !r.ok)
r = fillSupplement(createInitialState(), 999, 8.0, '复核员', clock)
check('补录不存在条目被拦', !r.ok)

// ---------- 14. 台账与导出明细同时更新、条数一致 ----------
s = createInitialState()
s = submitFlow(s, { observedAt: '2026-10-05 08:00', measuredFlow: 7, operator: '甲' }, '在线报送', clock).data!.state
eq('导出条数=台账条数', exportRowCount(s), s.records.length)
s = submitFlow(s, { observedAt: '2026-10-05 08:00', measuredFlow: 11, operator: '甲' }, '在线报送', clock).data!.state
s = submitFlow(s, { observedAt: '2026-10-05 09:00', measuredFlow: 6, operator: '甲' }, '在线报送', clock).data!.state
eq('覆盖+新增后导出仍与台账同步', exportRowCount(s), s.records.length)
const csv = exportLedger(s)
check('导出含批复文号列', csv.includes('环评批复文号') && csv.includes('环审〔2024〕12号'))
check('导出含判定结果列', csv.includes('达标') && csv.includes('未达标'))
check('导出 BOM 头存在', csv.startsWith('﻿'))

// ---------- 15. 审计留痕 ----------
check('关键动作均有审计日志', s.logs.length >= 3)
check('覆盖动作有留痕', s.logs.some((l) => l.action === '覆盖同时段记录'))
check('自动预警有留痕', s.logs.some((l) => l.action === '自动挂下泄预警'))
check('自动销号有留痕', s.logs.some((l) => l.action === '预警自动销号'))

// ---------- 汇总 ----------
console.log(`\n生态流量领域验证：通过 ${passed} 项，失败 ${failed} 项`)
if (failed > 0) {
  console.error('失败项：\n' + failures.map((f) => `  - ${f}`).join('\n'))
  process.exit(1)
}
console.log('全部通过。')
