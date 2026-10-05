/** 生态流量监管状态：单一事实源，localStorage 持久化，变更后广播给所有入口页面。 */
import { reactive, readonly } from 'vue'

import { createInitialState } from './engine'
import { buildSeedState } from './seed'
import type { EcoFlowState } from './types'

const STORAGE_KEY = 'hydropower-plant-om:ecoflow'
export const ECOFLOW_CHANGED = 'ecoflow:changed'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isValidState(value: unknown): value is EcoFlowState {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    Array.isArray(candidate.records) &&
    Array.isArray(candidate.warnings) &&
    Array.isArray(candidate.supplements) &&
    Array.isArray(candidate.todos) &&
    Array.isArray(candidate.batches) &&
    Array.isArray(candidate.logs) &&
    typeof candidate.backfilled === 'boolean' &&
    typeof candidate.seq === 'object'
  )
}

function load(): EcoFlowState {
  const fallback = buildSeedState()
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw)
    if (!isValidState(parsed)) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
      return fallback
    }
    return parsed
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

const state = reactive<EcoFlowState>(load())

function persist(): void {
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    window.dispatchEvent(new CustomEvent(ECOFLOW_CHANGED))
  }
}

/** 所有领域写操作经此提交：保证台账、预警、待办、导出明细在同一次更新里同时生效。 */
export function commit(next: EcoFlowState): void {
  const snapshot = clone(next)
  state.records = snapshot.records
  state.warnings = snapshot.warnings
  state.supplements = snapshot.supplements
  state.todos = snapshot.todos
  state.batches = snapshot.batches
  state.logs = snapshot.logs
  state.backfilled = snapshot.backfilled
  state.seq = snapshot.seq
  persist()
}

export function useEcoFlowStore() {
  return {
    state: readonly(state) as typeof state,
    commit,
    reset(): void {
      const fresh = buildSeedState()
      commit(fresh)
    },
    clearAll(): void {
      commit(createInitialState())
    },
  }
}
