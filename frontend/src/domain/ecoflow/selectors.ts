/**
 * 跨入口待办的统一投影：所有页面只能用这里的选择器，
 * 保证“水情记录待办”和“泄洪操作待办”读到的判定结果逐条一致，不各自再算一遍。
 */
import type { CrossTodo, EcoFlowState } from './types'

export interface LinkedTodoView {
  todos: CrossTodo[]
  /** 未收尾条数：闸门启闭入口据此显示还没收尾的预警 */
  openCount: number
}

/** 水情调度入口：读到的是台账判定结果投影。 */
export function hydrologyTodos(state: EcoFlowState): LinkedTodoView {
  const todos = state.todos
    .filter((todo) => todo.target === 'hydrology')
    .sort((a, b) => (a.slot < b.slot ? 1 : a.slot > b.slot ? -1 : 0))
  return { todos, openCount: todos.filter((t) => t.open).length }
}

/**
 * 泄洪操作入口：与水情入口读同一批同源判定（逐条相等），
 * 同时承载尚未收尾的下泄预警，供泄洪值班在另一个入口处理。
 */
export function floodTodos(state: EcoFlowState): LinkedTodoView {
  const todos = state.todos
    .filter((todo) => todo.target === 'flood')
    .sort((a, b) => (a.slot < b.slot ? 1 : a.slot > b.slot ? -1 : 0))
  return { todos, openCount: todos.filter((t) => t.open).length }
}

/** 闸门启闭值班待办：预警处置结论回写到此，只看还没销号收尾的。 */
export function gateDutyTodos(state: EcoFlowState): LinkedTodoView {
  const todos = state.todos
    .filter((todo) => todo.target === 'gate' && todo.open)
    .sort((a, b) => (a.slot < b.slot ? 1 : a.slot > b.slot ? -1 : 0))
  return { todos, openCount: todos.length }
}

/**
 * 后续检修待办：已填写处置结论（处置中/已处置/已销号）的预警都在此列，
 * 供检修入口安排后续检修与复核；条数与生态流量主台账的“已产出结论工单”一一对应。
 * openCount 只统计尚未销号的，便于检修值班优先处理。
 */
export function overhaulTodos(state: EcoFlowState): LinkedTodoView {
  const todos = state.todos
    .filter((todo) => todo.target === 'overhaul')
    .sort((a, b) => (a.slot < b.slot ? 1 : a.slot > b.slot ? -1 : 0))
  return { todos, openCount: todos.filter((t) => t.open).length }
}
