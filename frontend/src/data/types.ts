/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 埋点质量审计的结论。样本不足时记为「无法判定」，事件改版待人工处理记为「待复核」。 */
export type AuditConclusion = '通过' | '异常' | '无法判定' | '待复核'

export type ArchivedChecklist = {
  version: string
  items: string[]
  archivedAt: string
}

/** 单条审计规则的质量结论与复核状态，按规则编号持久化。 */
export type RuleQualityState = {
  ruleNo: string
  eventNo: string
  conclusion: AuditConclusion
  detail: string
  checklist: string[]
  historicalChecklist: ArchivedChecklist | null
  lastCheckedAt: string
  lastReviewedAt: string
  nextReviewAt: string
  reviewCycleDays: number
  minSample: number
  lastSample: number
  lastVersion: string
  lastParams: string
  lastRatio: number
  lastPendingVersions: string[]
  lastFingerprint: string
  operatorHandled: boolean
  handledBy: string
  handledAt: string
}

export type EventSpecSnapshot = {
  version: string
  params: string
  ratio: number
  effectiveAt: string
  owner: string
  product: string
  productVolume: number
}

/** 一次事件规格变更（版本 / 上报参数 / 采样比例）的影响范围记录。 */
export type QualityChangeRecord = {
  id: string
  eventNo: string
  eventName: string
  owner: string
  params: string
  product: string
  from: EventSpecSnapshot
  to: EventSpecSnapshot
  ratioChanged: boolean
  versionChanged: boolean
  paramsChanged: boolean
  affectedRuleIds: string[]
  reusedRuleIds: string[]
  arbitrationNote: string
  operator: string
  createdAt: string
}

export type BatchResultItem = {
  ruleNo: string
  eventNo: string
  ruleName: string
  ok: boolean
  reused: boolean
  conclusion: AuditConclusion
  message: string
  needsOperator: boolean
}

export type BatchRunRecord = {
  id: string
  operator: string
  createdAt: string
  results: BatchResultItem[]
}

export type QualityState = {
  rules: Record<string, RuleQualityState>
  changes: QualityChangeRecord[]
  batchRuns: BatchRunRecord[]
  updatedAt: string
}

export type EventSpec = {
  rowId: number
  eventNo: string
  eventName: string
  version: string
  params: string
  ratio: number
  owner: string
  product: string
  baseVolume: number
  status: string
  stored: string
  effectiveAt: string
  fullyStored: boolean
}

export type EventArbitration = {
  eventNo: string
  winner: EventSpec | null
  pendingRows: EventSpec[]
  note: string
}
