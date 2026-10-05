/** 生态流量监管域的数据结构。 */
import type { Verdict, WarningStage } from './policy'

/** 台账记录：每条都带环评批复文号、最小下泄指标快照与实测下泄流量。 */
export interface EcoFlowRecord {
  id: number
  /** 台账编号，如 EF-0001 */
  code: string
  /** 观测时段（按小时归一化，YYYY-MM-DD HH:00），同一时段全表唯一 */
  slot: string
  observedAt: string
  /** 观测当时生效的环评批复文号（换版不影响既有记录） */
  approvalCode: string
  /** 最小下泄指标，m³/s（按批复版本固化到本记录的快照） */
  minFlow: number
  /** 实测下泄流量，m³/s；null 表示缺测待补录 */
  measuredFlow: number | null
  /** 全站唯一口径的判定结果，禁止各入口自行重算 */
  verdict: Verdict
  source: '在线报送' | '批量报送' | '历史回填' | '缺项补录'
  operator: string
  /** 第几次写入该时段（同一时段后到的一笔盖掉前一笔，不累加） */
  revision: number
  /** 回填/补录/裁决等需要交代来历时写入 */
  remark: string
  createdAt: string
  updatedAt: string
}

/** 下泄预警：同一时段至多一条，重复报送不会多挂。 */
export interface EcoFlowWarning {
  id: number
  /** 与台账时段一一对应（一对一） */
  slot: string
  approvalCode: string
  minFlow: number
  measuredFlow: number
  stage: WarningStage
  openedAt: string
  /** 各环节的处置结论时间线 */
  actions: WarningAction[]
  /** 预警处置结论（处置中/已处置时填写），会回写到闸门启闭与检修待办 */
  conclusion: string
  closedAt: string | null
}

export interface WarningAction {
  from: WarningStage
  to: WarningStage
  operator: string
  note: string
  at: string
}

/** 回填时缺实测流量的记录，单独挂补录队列，缺项补齐方式记入备注。 */
export interface EcoFlowSupplement {
  id: number
  slot: string
  observedAt: string
  approvalCode: string
  minFlow: number
  source: '历史回填'
  operator: string
  remark: string
  status: '待补录' | '已补录'
  createdAt: string
  /** 补录后回填到的台账编号 */
  filledRecordCode: string | null
  filledAt: string | null
}

/** 回写到既有各业务模块的待办：在别的入口直接看到同源的判定/预警。 */
export interface CrossTodo {
  id: number
  warningId: number | null
  recordId: number | null
  slot: string
  /** 判定结果快照与预警工单同源，水情、泄洪读到的是同一个结果 */
  verdict: Verdict
  kind: '达标判定待办' | '下泄预警'
  /** 回写目标入口 */
  target: 'hydrology' | 'flood' | 'gate' | 'overhaul'
  stage: WarningStage | null
  /** 预警处置结论（从预警工单原样回写） */
  conclusion: string
  open: boolean
  createdAt: string
  updatedAt: string
}

/** 批量报送批次：以最先入库的一稿为准，后到的整套退回。 */
export interface EcoFlowBatch {
  id: number
  batchRef: string
  acceptedAt: string
  operator: string
  itemCount: number
}

export interface EcoFlowAuditLog {
  id: number
  at: string
  action: string
  detail: string
  operator: string
}

export interface EcoFlowState {
  records: EcoFlowRecord[]
  warnings: EcoFlowWarning[]
  supplements: EcoFlowSupplement[]
  todos: CrossTodo[]
  batches: EcoFlowBatch[]
  logs: EcoFlowAuditLog[]
  backfilled: boolean
  seq: { record: number; warning: number; supplement: number; todo: number; batch: number; log: number }
}

/** 在线报送/批量报送/补录入参。 */
export interface FlowReading {
  observedAt: string
  measuredFlow: number | null
  operator: string
  approvalCode?: string
  remark?: string
}

export interface ActionResult<T = void> {
  ok: boolean
  message: string
  data?: T
}
