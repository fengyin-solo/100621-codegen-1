<template>
  <section class="eco-todo-panel" :class="`variant-${variant}`">
    <header class="eco-todo-head">
      <strong>{{ title }}</strong>
      <template v-if="variant === 'overhaul'">
        <span class="eco-todo-count">共 {{ view.todos.length }} 条（与台账对应）</span>
        <span class="eco-todo-count" :class="{ alert: view.openCount > 0 }">{{ view.openCount }} 条未收尾</span>
      </template>
      <span v-else class="eco-todo-count" :class="{ alert: view.openCount > 0 }">{{ view.openCount }} 条未收尾</span>
      <RouterLink class="eco-todo-link" to="/ecoflow">前往生态流量台账处理 →</RouterLink>
    </header>
    <p class="eco-todo-hint">{{ hint }}</p>
    <table v-if="view.todos.length" class="data-table eco-todo-table">
      <thead>
        <tr>
          <th>观测时段</th>
          <th>批复文号</th>
          <th>指标/实测(m³/s)</th>
          <th>判定结果</th>
          <th v-if="showWarning">预警环节</th>
          <th v-if="showWarning">处置结论</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="todo in view.todos" :key="todo.id" :class="{ dim: !todo.open }">
          <td>{{ todo.slot }}</td>
          <td>{{ warningMap.get(todo.slot)?.approvalCode ?? '—' }}</td>
          <td>
            {{ warningMap.get(todo.slot)?.minFlow ?? '—' }} /
            {{ warningMap.get(todo.slot)?.measuredFlow ?? recordFlow(todo.slot) }}
          </td>
          <td>
            <span class="tag" :class="verdictClass(todo.verdict)">{{ todo.verdict }}</span>
          </td>
          <td v-if="showWarning">{{ todo.stage ?? '—' }}</td>
          <td v-if="showWarning" class="todo-conclusion">{{ todo.conclusion || '（尚未填写）' }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="empty-state eco-todo-empty">暂无生态流量相关待办</p>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { ECOFLOW_CHANGED, useEcoFlowStore } from '@/domain/ecoflow/store'
import {
  floodTodos,
  gateDutyTodos,
  hydrologyTodos,
  overhaulTodos,
  type LinkedTodoView,
} from '@/domain/ecoflow/selectors'
import type { Verdict } from '@/domain/ecoflow/policy'

const props = withDefaults(
  defineProps<{
    variant: 'hydrology' | 'flood' | 'gate' | 'overhaul'
  }>(),
  {},
)

const store = useEcoFlowStore()
const tick = ref(0)

const titleMap = {
  hydrology: '生态流量达标判定（水情待办）',
  flood: '生态流量达标判定与下泄预警（泄洪值班待办）',
  gate: '下泄预警回写（闸门启闭值班待办）',
  overhaul: '预警处置结论待办（机组检修）',
} as const

const hintMap = {
  hydrology: '判定结果取自生态流量台账的统一口径，本入口不再重算。',
  flood: '与水情记录读同一判定结果；未收尾预警在此同步可见，处置入口在生态流量台账。',
  gate: '下泄预警的处置结论回写于此；销号前始终算作未收尾。',
  overhaul: '已填写处置结论的预警进入后续检修待办，条数与生态流量台账对应。',
} as const

const title = computed(() => titleMap[props.variant])
const hint = computed(() => hintMap[props.variant])
const showWarning = computed(() => props.variant !== 'hydrology')

const view = computed<LinkedTodoView>(() => {
  void tick.value
  const state = store.state
  switch (props.variant) {
    case 'hydrology':
      return hydrologyTodos(state)
    case 'flood':
      return floodTodos(state)
    case 'gate':
      return gateDutyTodos(state)
    case 'overhaul':
      return overhaulTodos(state)
  }
})

const warningMap = computed(() => new Map(store.state.warnings.map((w) => [w.slot, w])))
const recordMap = computed(() => new Map(store.state.records.map((r) => [r.slot, r])))
function recordFlow(slot: string): string {
  const rec = recordMap.value.get(slot)
  return rec ? (rec.measuredFlow === null ? '缺测' : String(rec.measuredFlow)) : '—'
}

function verdictClass(verdict: Verdict): string {
  if (verdict === '未达标') return 'tag-danger'
  if (verdict === '缺测') return 'tag-muted'
  return 'tag-ok'
}

function refresh(): void {
  tick.value += 1
}
onMounted(() => window.addEventListener(ECOFLOW_CHANGED, refresh))
onBeforeUnmount(() => window.removeEventListener(ECOFLOW_CHANGED, refresh))
</script>
