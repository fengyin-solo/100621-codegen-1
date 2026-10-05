<template>
  <section class="page" data-module="ecoflow">
    <header class="page-head">
      <div>
        <h2>生态流量下泄监管</h2>
        <p class="page-desc">
          坝下河段生态流量台账：每条记录带环评批复文号、最小下泄指标与实测下泄流量，
          达标判定全站只认一套规则，低于最小下泄自动挂下泄预警。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn" type="button" :disabled="backfill.done" @click="doBackfill">
          {{ backfill.done ? '存量已回填' : '存量整体回填' }}
        </button>
        <button class="btn" type="button" @click="exportLedgerCsv">导出台账明细</button>
        <button class="btn" type="button" @click="exportWarningCsv">导出预警明细</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span class="legend-item">
        现行批复：{{ summary.activeVersion ? `${summary.activeVersion.docNo}（最小下泄 ${summary.activeVersion.minFlow} 立方米每秒）` : '未登记' }}
      </span>
      <span class="legend-item">取值范围：{{ rules.minMeasured }}~{{ rules.maxMeasured }} 立方米每秒，超出按超范围处理</span>
      <span class="legend-item">闸门联动待办：{{ summary.gateLinked }} 条</span>
      <span class="legend-item">检修回写待办：{{ summary.overhaulLinked }} 条</span>
    </p>
    <p v-if="backfill.note" class="page-desc">回填说明：{{ backfill.note }}</p>

    <form class="filter-bar" @submit.prevent="doSubmit">
      <label class="filter-item">
        <span>报送批次</span>
        <input v-model="form.batch" placeholder="同一批次重复提交整套退回" />
      </label>
      <label class="filter-item">
        <span>观测时间</span>
        <input v-model="form.time" type="datetime-local" step="3600" />
      </label>
      <label class="filter-item">
        <span>实测下泄流量（立方米每秒）</span>
        <input v-model="form.measured" placeholder="留空按缺测补录" />
      </label>
      <label class="filter-item">
        <span>环评批复文号（可空）</span>
        <input v-model="form.docNo" placeholder="留空按观测时间匹配版本" />
      </label>
      <button class="btn primary" type="submit">报送入库</button>
    </form>

    <form class="filter-bar" @submit.prevent="doRegisterVersion">
      <label class="filter-item">
        <span>新批复文号</span>
        <input v-model="versionForm.docNo" placeholder="换版登记，只影响新记录" />
      </label>
      <label class="filter-item">
        <span>最小下泄指标</span>
        <input v-model="versionForm.minFlow" placeholder="立方米每秒" />
      </label>
      <label class="filter-item">
        <span>生效日期</span>
        <input v-model="versionForm.effectiveFrom" type="date" />
      </label>
      <button class="btn" type="submit">登记换版批复</button>
    </form>

    <h3 class="section-title">批复版本库</h3>
    <table class="data-table">
      <thead>
        <tr><th>批复文号</th><th>最小下泄指标</th><th>生效日期</th><th>说明</th></tr>
      </thead>
      <tbody>
        <tr v-for="item in versions" :key="item.docNo">
          <td>{{ item.docNo }}</td>
          <td>{{ item.minFlow }}</td>
          <td>{{ item.effectiveFrom }}</td>
          <td>{{ item.note }}</td>
        </tr>
      </tbody>
    </table>

    <h3 class="section-title">下泄预警（待处置 → 处置中 → 已办结，只能按顺序推进）</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in warningColumns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in warnings" :key="String(row.预警编号)">
          <td v-for="column in warningColumns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="act(row, '受理预警')">受理预警</button>
            <button class="link" type="button" @click="openClose(row)">办结预警</button>
          </td>
        </tr>
        <tr v-if="!warnings.length">
          <td :colspan="warningColumns.length + 2" class="empty-state">暂无下泄预警</td>
        </tr>
      </tbody>
    </table>
    <form v-if="closingNo" class="filter-bar" @submit.prevent="confirmClose">
      <label class="filter-item">
        <span>处置结论（回写闸门启闭与机组检修待办）</span>
        <input v-model="closingConclusion" :placeholder="`办结 ${closingNo} 的处置结论`" />
      </label>
      <button class="btn primary" type="submit">确认办结</button>
      <button class="btn ghost" type="button" @click="closingNo = ''">取消</button>
    </form>

    <h3 class="section-title">生态流量台账</h3>
    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in ledgerColumns" :key="column">{{ column }}</th>
          <th>当前状态</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in ledger" :key="String(row.记录编号)">
          <td v-for="column in ledgerColumns" :key="column">{{ row[column] || '—' }}</td>
          <td>{{ row.status }}</td>
        </tr>
        <tr v-if="!ledger.length">
          <td :colspan="ledgerColumns.length + 1" class="empty-state">暂无台账记录，可先报送或做存量回填</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ ledger.length }} 条台账记录 · {{ warnings.length }} 条预警</span>
      <span v-if="message" :class="messageOk ? '' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  LEDGER_COLUMNS,
  WARNING_COLUMNS,
  actOnWarning,
  backfillState,
  downloadCsv,
  ecoFlowSummary,
  exportLedger,
  exportWarnings,
  listLedger,
  listVersions,
  listWarnings,
  registerEiaVersion,
  runBackfill,
  submitBatch,
  type EcoSummary,
} from '@/api/eco-flow-service'
import type { EntryRow } from '@/data/types'
import { ECO_FLOW_RULES, nowText, type EiaVersion, type WarningAction } from '@/domain/eco-flow'

const rules = ECO_FLOW_RULES
const ledgerColumns = LEDGER_COLUMNS
const warningColumns = WARNING_COLUMNS

const ledger = ref<EntryRow[]>([])
const warnings = ref<EntryRow[]>([])
const versions = ref<EiaVersion[]>([])
const backfill = ref<{ done: boolean; note: string }>({ done: false, note: '' })
const summary = ref<EcoSummary>(ecoFlowSummary())
const message = ref('')
const messageOk = ref(true)
const closingNo = ref('')
const closingConclusion = ref('')

const form = ref({ batch: `BF-${nowText().slice(0, 10).replace(/-/g, '')}-01`, time: '', measured: '', docNo: '' })
const versionForm = ref({ docNo: '', minFlow: '', effectiveFrom: '' })

const statCards = computed(() => [
  { label: '台账记录', value: summary.value.total },
  { label: '未达标记录', value: summary.value.short },
  { label: '连续未达标小时', value: summary.value.shortHours },
  { label: '待处置预警', value: summary.value.pendingWarnings },
  { label: '处置中预警', value: summary.value.handlingWarnings },
  { label: '已办结预警', value: summary.value.closedWarnings },
])

function reload() {
  ledger.value = listLedger()
  warnings.value = listWarnings()
  versions.value = listVersions()
  backfill.value = backfillState()
  summary.value = ecoFlowSummary()
}

function tell(ok: boolean, text: string) {
  messageOk.value = ok
  message.value = text
}

function doSubmit() {
  const result = submitBatch(form.value.batch, [
    { 观测时间: form.value.time, 实测下泄流量: form.value.measured, 环评批复文号: form.value.docNo },
  ])
  tell(result.ok, result.message)
  reload()
}

function doBackfill() {
  const result = runBackfill()
  tell(result.ok, result.message)
  reload()
}

function doRegisterVersion() {
  const result = registerEiaVersion({
    docNo: versionForm.value.docNo,
    minFlow: Number(versionForm.value.minFlow),
    effectiveFrom: versionForm.value.effectiveFrom,
    note: '换版登记',
  })
  tell(result.ok, result.message)
  reload()
}

function act(row: EntryRow, action: WarningAction) {
  const result = actOnWarning(String(row.预警编号), action)
  tell(result.ok, result.message)
  reload()
}

function openClose(row: EntryRow) {
  closingNo.value = String(row.预警编号)
  closingConclusion.value = ''
}

function confirmClose() {
  const result = actOnWarning(closingNo.value, '办结预警', closingConclusion.value)
  tell(result.ok, result.message)
  if (result.ok) {
    closingNo.value = ''
    closingConclusion.value = ''
  }
  reload()
}

function exportLedgerCsv() {
  const { filename, content } = exportLedger()
  downloadCsv(filename, content)
}

function exportWarningCsv() {
  const { filename, content } = exportWarnings()
  downloadCsv(filename, content)
}

onMounted(reload)
</script>

<style scoped>
.section-title {
  font-size: 14px;
  margin: 16px 0 8px;
}
</style>
