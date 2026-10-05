<template>
  <section class="page ecoflow-page" data-module="ecoflow">
    <header class="page-head">
      <div>
        <h2>生态流量下泄监管台账</h2>
        <p class="page-desc">
          环评批复文号、最小下泄指标、实测下泄流量逐条留痕；达标判定全站只认
          <strong>policy.ts 一套口径</strong>，水情、泄洪、闸门、检修入口读到的均为同一判定结果。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="exportRows">导出台账明细(CSV)</button>
        <button class="btn ghost" type="button" @click="resetAll">重置演示数据</button>
      </div>
    </header>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">台账记录条数（=导出行数）</span>
        <strong class="stat-value">{{ records.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">未收尾下泄预警</span>
        <strong class="stat-value" :class="{ 'text-danger': openWarnings.length }">{{ openWarnings.length }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">最新连续未达标小时</span>
        <strong class="stat-value" :class="{ 'text-danger': stats.consecutive }">{{ stats.consecutive }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">缺项待补录</span>
        <strong class="stat-value">{{ pendingSupplements.length }}</strong>
      </article>
    </div>

    <!-- 全站唯一口径公示 -->
    <section class="policy-card">
      <h3>全站唯一口径（阈值 / 判定规则 / 取值上限只此一套）</h3>
      <div class="policy-grid">
        <table class="data-table">
          <thead>
            <tr><th>环评批复文号</th><th>生效区间</th><th>最小下泄指标</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr v-for="v in versions" :key="v.code">
              <td>{{ v.code }}</td>
              <td>{{ v.effectiveFrom }} ～ {{ v.effectiveTo ?? '至今' }}</td>
              <td>{{ v.minFlow }} m³/s</td>
              <td>{{ v.note }}</td>
            </tr>
          </tbody>
        </table>
        <ul class="policy-rules">
          <li>判定规则：实测 &lt; 最小下泄指标 → <span class="tag tag-danger">未达标</span>；≥ 指标（含相等）→ <span class="tag tag-ok">达标</span>；无实测 → <span class="tag tag-muted">缺测</span></li>
          <li>取值上限：实测允许范围 [{{ range.min }}, {{ range.max }}] {{ range.unit }}，超范围<strong>一律拒收</strong>，不截断、不挂预警。</li>
          <li>版本规则：换版只影响新记录；既有记录固化观测当时的文号与指标快照，不重判。</li>
          <li>重复报送：同一时段（整点）后到的一笔直接盖掉前一笔，不累加、不多挂预警。</li>
          <li>预警环节：{{ stages.join(' → ') }}，只能逐级推进，跳级直接拦下。</li>
        </ul>
      </div>
    </section>

    <div class="eco-cols">
      <!-- 在线报送 -->
      <section class="form-card">
        <h3>实测流量在线报送</h3>
        <form class="eco-form" @submit.prevent="submit">
          <label class="filter-item">
            <span>观测时间</span>
            <input v-model="form.observedAt" type="datetime-local" step="3600" />
          </label>
          <label class="filter-item">
            <span>实测下泄流量 (m³/s，留空=缺测)</span>
            <input v-model="form.measuredFlow" type="number" :min="range.min" :max="range.max" step="0.1" placeholder="如 8.5" />
          </label>
          <label class="filter-item">
            <span>值班员</span>
            <input v-model="form.operator" />
          </label>
          <div class="eco-form-actions">
            <button class="btn primary" type="submit">提交报送</button>
          </div>
          <p class="form-hint">同一时段重复提交只认最后一次；低于指标自动挂下泄预警。</p>
        </form>
      </section>

      <!-- 批量报送 -->
      <section class="form-card">
        <h3>批量报送（整套提交）</h3>
        <form class="eco-form" @submit.prevent="submitBatch">
          <label class="filter-item">
            <span>批次号（以最先入库一稿为准）</span>
            <input v-model="batchForm.ref" placeholder="如 B-20261005-01" />
          </label>
          <label class="filter-item">
            <span>报送内容（每行：观测时间,实测流量）</span>
            <textarea v-model="batchForm.text" rows="4" placeholder="2026-10-05 13:00,9.6&#10;2026-10-05 14:00,10.4"></textarea>
          </label>
          <div class="eco-form-actions">
            <button class="btn primary" type="submit">整套提交</button>
          </div>
          <p class="form-hint">任一行不合法整套退回；重复批次号整套退回；批内同时段重复行只留最后一行。</p>
        </form>
      </section>

      <!-- 存量回填 -->
      <section class="form-card">
        <h3>存量交接本整体回填</h3>
        <p class="backfill-desc">
          按观测时间升序一次性回填 {{ backfillSize }} 条交接本记录。缺批复文号的，由系统按
          <strong>观测时点生效版本</strong>裁决补齐并写入备注；缺实测流量的不臆造，单独进补录队列。
        </p>
        <div class="eco-form-actions">
          <button v-if="!state.backfilled" class="btn primary" type="button" @click="doBackfill">
            执行存量回填（仅一次）
          </button>
          <span v-else class="tag tag-ok">存量数据已完成整体回填</span>
        </div>
        <p class="form-hint">历史未达标只固化判定，不自动挂新预警；重复回填会被拦下。</p>
      </section>
    </div>

    <p v-if="message" class="eco-message" :class="messageKind">{{ message }}</p>

    <!-- 台账明细 -->
    <h3 class="section-title">下泄台账明细</h3>
    <table class="data-table ledger-table">
      <thead>
        <tr>
          <th>台账编号</th>
          <th>观测时段</th>
          <th>环评批复文号</th>
          <th>最小下泄指标</th>
          <th>实测下泄流量</th>
          <th>判定结果</th>
          <th>来源/版次</th>
          <th>值班员</th>
          <th>备注</th>
          <th>更新时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in recordsDesc" :key="row.id" :class="verdictRowClass(row.verdict)">
          <td>{{ row.code }}</td>
          <td>{{ row.slot }}</td>
          <td>{{ row.approvalCode }}</td>
          <td>{{ row.minFlow }}</td>
          <td>{{ row.measuredFlow === null ? '缺测' : row.measuredFlow }}</td>
          <td><span class="tag" :class="verdictClass(row.verdict)">{{ row.verdict }}</span></td>
          <td>{{ row.source }} / 第{{ row.revision }}版</td>
          <td>{{ row.operator }}</td>
          <td class="remark-cell">{{ row.remark || '—' }}</td>
          <td>{{ row.updatedAt }}</td>
        </tr>
        <tr v-if="!records.length">
          <td colspan="10" class="empty-state">暂无台账记录</td>
        </tr>
      </tbody>
    </table>

    <!-- 下泄预警工单 -->
    <h3 class="section-title">下泄预警工单（同一时段至多一条，处置结论回写闸门启闭与检修待办）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>观测时段</th>
          <th>批复文号/指标</th>
          <th>实测流量</th>
          <th>当前环节</th>
          <th>处置结论（回写待办）</th>
          <th>处置轨迹</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="w in warningsDesc" :key="w.id">
          <td>{{ w.slot }}</td>
          <td>{{ w.approvalCode }} / {{ w.minFlow }}</td>
          <td>{{ w.measuredFlow }}</td>
          <td>
            <span class="tag" :class="w.stage === '已销号' ? 'tag-muted' : 'tag-danger'">{{ w.stage }}</span>
          </td>
          <td class="conclusion-cell">
            <input
              v-if="w.stage !== '已销号'"
              v-model="notes[w.id]"
              class="note-input"
              :placeholder="w.stage === '处置中' ? '提交已处置时必须填写结论' : '可选填写处置说明'"
            />
            <span v-else>{{ w.conclusion || '（恢复达标自动销号）' }}</span>
          </td>
          <td class="trace-cell">
            <span v-for="(a, i) in w.actions" :key="i" class="trace-item">
              {{ a.at }} {{ a.from }}→{{ a.to }}<template v-if="a.note">：{{ a.note }}</template>
            </span>
            <span v-if="!w.actions.length" class="empty-state">—</span>
          </td>
          <td class="row-actions">
            <button v-if="w.stage === '待处置'" class="link" type="button" @click="advance(w.id, '处置中')">
              接单处置
            </button>
            <button v-if="w.stage === '处置中'" class="link" type="button" @click="advance(w.id, '已处置')">
              提交处置结论
            </button>
            <button v-if="w.stage === '已处置'" class="link" type="button" @click="advance(w.id, '已销号')">
              复核销号
            </button>
            <span v-if="w.stage === '已销号'" class="tag tag-muted">已闭环</span>
          </td>
        </tr>
        <tr v-if="!state.warnings.length">
          <td colspan="7" class="empty-state">暂无预警工单；实测低于最小下泄指标时自动挂载</td>
        </tr>
      </tbody>
    </table>

    <!-- 缺项补录队列 -->
    <h3 class="section-title">缺项补录队列（存量回填的缺实测项单独补录）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th>观测时段</th>
          <th>裁决批复文号/指标</th>
          <th>缺项补齐方式（已写入备注）</th>
          <th>状态</th>
          <th>补录实测 (m³/s)</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="s in state.supplements" :key="s.id">
          <td>{{ s.slot }}</td>
          <td>{{ s.approvalCode }} / {{ s.minFlow }}</td>
          <td class="remark-cell">{{ s.remark }}</td>
          <td>
            <span class="tag" :class="s.status === '已补录' ? 'tag-ok' : 'tag-muted'">{{ s.status }}</span>
          </td>
          <td>
            <input v-if="s.status === '待补录'" v-model="fills[s.id]" type="number" class="note-input" step="0.1" />
            <span v-else>已补录到 {{ s.filledRecordCode }}（{{ s.filledAt }}）</span>
          </td>
          <td>
            <button v-if="s.status === '待补录'" class="link" type="button" @click="fill(s.id)">
              确认补录
            </button>
          </td>
        </tr>
        <tr v-if="!state.supplements.length">
          <td colspan="6" class="empty-state">暂无缺项记录</td>
        </tr>
      </tbody>
    </table>

    <!-- 审计日志 -->
    <h3 class="section-title">可追溯操作日志</h3>
    <table class="data-table log-table">
      <thead><tr><th>时间</th><th>动作</th><th>详情</th><th>操作人</th></tr></thead>
      <tbody>
        <tr v-for="log in state.logs" :key="log.id">
          <td>{{ log.at }}</td>
          <td>{{ log.action }}</td>
          <td>{{ log.detail }}</td>
          <td>{{ log.operator }}</td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

import {
  advanceWarning,
  consecutiveFailureHours,
  exportLedger,
  fillSupplement,
  importBatch,
  runBackfill,
  submitFlow,
} from '@/domain/ecoflow/engine'
import { normalizeSlot } from '@/domain/ecoflow/slot'
import { APPROVAL_VERSIONS, FLOW_RANGE, WARNING_STAGES, type Verdict, type WarningStage } from '@/domain/ecoflow/policy'
import { BACKFILL_PAYLOAD } from '@/domain/ecoflow/seed'
import { ECOFLOW_CHANGED, useEcoFlowStore } from '@/domain/ecoflow/store'

const store = useEcoFlowStore()
const state = store.state
const versions = APPROVAL_VERSIONS
const range = FLOW_RANGE
const stages = WARNING_STAGES
const backfillSize = BACKFILL_PAYLOAD.length

const tick = ref(0)
function refresh(): void {
  tick.value += 1
}
onMounted(() => window.addEventListener(ECOFLOW_CHANGED, refresh))
onBeforeUnmount(() => window.removeEventListener(ECOFLOW_CHANGED, refresh))

const form = reactive({ observedAt: '2026-10-05T08:00', measuredFlow: '', operator: '值班管理员' })
const batchForm = reactive({ ref: 'B-20261005-01', text: '' })
const notes = reactive<Record<number, string>>({})
const fills = reactive<Record<number, string>>({})

const message = ref('')
const messageKind = ref('ok')
function notify(text: string, kind: 'ok' | 'err' = 'ok'): void {
  message.value = text
  messageKind.value = kind
}

const records = computed(() => {
  void tick.value
  return [...state.records].sort((a, b) => (a.slot < b.slot ? 1 : a.slot > b.slot ? -1 : 0))
})
const recordsDesc = records
const warningsDesc = computed(() => {
  void tick.value
  return [...state.warnings].sort((a, b) => (a.slot < b.slot ? 1 : a.slot > b.slot ? -1 : 0))
})
const openWarnings = computed(() => state.warnings.filter((w) => w.stage !== '已销号'))
const pendingSupplements = computed(() => state.supplements.filter((s) => s.status === '待补录'))
const stats = computed(() => {
  void tick.value
  return { consecutive: consecutiveFailureHours(state) }
})

function verdictClass(verdict: Verdict): string {
  if (verdict === '未达标') return 'tag-danger'
  if (verdict === '缺测') return 'tag-muted'
  return 'tag-ok'
}
function verdictRowClass(verdict: Verdict): string {
  return verdict === '未达标' ? 'row-danger' : ''
}

function submit(): void {
  const slot = normalizeSlot(form.observedAt)
  if (!slot) {
    notify('观测时间格式不正确', 'err')
    return
  }
  const raw = String(form.measuredFlow).trim()
  const measuredFlow = raw === '' ? null : Number(raw)
  if (measuredFlow !== null && Number.isNaN(measuredFlow)) {
    notify('实测流量不是有效数字；缺测请将输入框留空', 'err')
    return
  }
  const result = submitFlow(state, {
    observedAt: form.observedAt,
    measuredFlow,
    operator: form.operator || '值班管理员',
  })
  if (!result.ok || !result.data) {
    notify(result.message, 'err')
    return
  }
  store.commit(result.data.state)
  notify(result.message)
}

function submitBatch(): void {
  const readings = []
  for (const line of batchForm.text.split('\n')) {
    const text = line.trim()
    if (!text) continue
    const parts = text.split(/[,，]/).map((p) => p.trim())
    if (parts.length < 2) {
      notify(`整行无法解析（应为：观测时间,实测流量）：${text}`, 'err')
      return
    }
    const value = Number(parts[1])
    if (Number.isNaN(value)) {
      notify(`整套未提交：实测流量「${parts[1]}」不是数字`, 'err')
      return
    }
    readings.push({ observedAt: parts[0], measuredFlow: value, operator: form.operator || '值班管理员' })
  }
  const result = importBatch(state, batchForm.ref, readings)
  if (!result.ok || !result.data) {
    notify(result.message, 'err')
    return
  }
  store.commit(result.data.state)
  notify(result.message)
  batchForm.text = ''
}

function doBackfill(): void {
  const result = runBackfill(state, BACKFILL_PAYLOAD, form.operator || '值班管理员')
  if (!result.ok || !result.data) {
    notify(result.message, 'err')
    return
  }
  store.commit(result.data.state)
  notify(result.message)
}

function advance(id: number, to: WarningStage): void {
  const result = advanceWarning(state, id, to, form.operator || '值班管理员', notes[id] ?? '')
  if (!result.ok || !result.data) {
    notify(result.message, 'err')
    return
  }
  store.commit(result.data.state)
  notes[id] = ''
  notify(result.message)
}

function fill(id: number): void {
  const value = Number(fills[id])
  if (Number.isNaN(value)) {
    notify('请填写有效的补录实测流量', 'err')
    return
  }
  const result = fillSupplement(state, id, value, form.operator || '值班管理员')
  if (!result.ok || !result.data) {
    notify(result.message, 'err')
    return
  }
  store.commit(result.data.state)
  notify(result.message)
}

function exportRows(): void {
  const content = exportLedger(state)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = '生态流量下泄监管台账.csv'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
  notify(`台账明细已导出，共 ${state.records.length} 行，与页面记录条数一致`)
}

function resetAll(): void {
  store.reset()
  refresh()
  notify('已重置为演示数据')
}
</script>
