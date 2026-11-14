import { listRows, saveRows } from '@/data/local-store'
import { readQuality, saveQuality } from '@/data/quality-store'
import type {
  ArchivedChecklist,
  AuditConclusion,
  BatchResultItem,
  BatchRunRecord,
  EventArbitration,
  EventSpec,
  EventSpecSnapshot,
  QualityChangeRecord,
  QualityState,
  RuleQualityState,
} from '@/data/types'

/**
 * 变更影响范围只由「事件版本 + 上报参数 + 采样比例」三要素决定：
 * - 三要素都没变的事件，引用它的审计规则继续复用上次复核结论；
 * - 任一项变化时，才让引用该事件的规则重新判定；
 * - 采样偏差阈值与复核周期在这里统一收口，页面不各自写一份。
 */
export const SAMPLE_BIAS_THRESHOLD = 5
export const DEFAULT_REVIEW_CYCLE_DAYS = 7
const SIMULATION_SALT = 209
const RATIO_RULE = '采样比例'
const PARAM_RULE = '上报参数'

type RowLike = { [field: string]: string | number | boolean }

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function nowText(): string {
  const date = new Date()
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function addDays(text: string, days: number): string {
  const date = new Date(text.replace(/-/g, '/'))
  if (Number.isNaN(date.getTime())) {
    return text
  }
  date.setDate(date.getDate() + days)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function hash(text: string): number {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619) >>> 0
  }
  return value
}

/** 同一条规则、同一份事件规格算出的偏差是稳定的，复核结论因此可复现。 */
function simulatedBias(field: string, spec: EventSpec): number {
  const key = `${field === RATIO_RULE ? 'r' : 'p'}|${spec.version}|${field === RATIO_RULE ? spec.ratio.toFixed(2) : spec.params}`
  return (hash(`${key}#${SIMULATION_SALT}`) % 1201) / 100 - 6
}

function simulatedMissingRate(field: string, spec: EventSpec): number {
  const key = `${field === RATIO_RULE ? 'r' : 'p'}|${spec.version}|${field === RATIO_RULE ? spec.ratio.toFixed(2) : spec.params}`
  return (hash(`${key}#${SIMULATION_SALT}|missing`) % 300) / 100
}

export function parseRatio(value: unknown): number {
  const matched = String(value ?? '').replace(/%/g, '').trim()
  const parsed = Number(matched)
  return Number.isFinite(parsed) ? parsed : 0
}

export function formatRatio(value: number): string {
  return `${Number(value.toFixed(2))}%`
}

export function parseParams(value: unknown): string[] {
  return String(value ?? '')
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function specFingerprint(version: string, params: string, ratio: number): string {
  return `${version}|${params}|${Number(ratio).toFixed(2)}`
}

/** 规则真正关心的那部分事件规格：采样比例规则只看比例，参数规则只看参数。 */
function ruleScopedFingerprint(field: string, version: string, params: string, ratio: number): string {
  return field === PARAM_RULE ? `${version}|${params}` : `${version}|${Number(ratio).toFixed(2)}`
}

/** 把事件定义表按事件编号聚合，并判定同一事件多个版本谁生效。 */
export function loadEventSpecs(): Map<string, EventArbitration> {
  const rows = listRows('eventdef')
  const grouped = new Map<string, EventSpec[]>()
  for (const row of rows) {
    const eventNo = String(row['事件编号'] ?? '')
    if (!eventNo) {
      continue
    }
    const stored = String(row['落库状态'] ?? '已落库')
    const status = String(row.status ?? '')
    // 已下线、草稿、未落库的版本不参与「同时生效」的仲裁。
    if (status === '已下线' || status === '草稿' || stored === '未落库') {
      continue
    }
    const spec: EventSpec = {
      rowId: Number(row.id),
      eventNo,
      eventName: String(row['事件名称'] ?? ''),
      version: String(row['事件版本'] ?? ''),
      params: String(row['上报参数'] ?? ''),
      ratio: parseRatio(row['采样比例']),
      owner: String(row['事件负责人'] ?? ''),
      product: String(row['所属产品'] ?? ''),
      baseVolume: Number(row['日均上报量'] ?? 0),
      status,
      stored,
      effectiveAt: String(row['生效时间'] ?? ''),
      fullyStored: stored === '已落库',
    }
    const list = grouped.get(eventNo) ?? []
    list.push(spec)
    grouped.set(eventNo, list)
  }

  const result = new Map<string, EventArbitration>()
  for (const [eventNo, list] of grouped) {
    // 两个事件版本同时生效时：先看完整落库，再比生效时间，晚者为准，另一侧进入待复核。
    const sorted = [...list].sort((left, right) => {
      if (left.fullyStored !== right.fullyStored) {
        return left.fullyStored ? -1 : 1
      }
      return right.effectiveAt.localeCompare(left.effectiveAt)
    })
    const winner = sorted[0] ?? null
    const pendingRows = sorted.slice(1)
    let note = `${eventNo} 只有一个生效版本，按 ${winner?.version ?? '—'} 判定`
    if (pendingRows.length > 0) {
      const pendingVersions = pendingRows.map((item) => `${item.version}${item.fullyStored ? '' : '(部分落库)'}`)
      note = `${eventNo} 同时存在 ${list.length} 个版本：完整落库且生效时间更晚的 ${winner?.version ?? '—'} 为准，${pendingVersions.join('、')} 进入待复核`
    }
    result.set(eventNo, { eventNo, winner, pendingRows, note })
  }
  return result
}

export function loadQualityState(): QualityState {
  return readQuality()
}

export function saveQualityState(next: QualityState): QualityState {
  const payload = { ...next, updatedAt: nowText() }
  saveQuality(payload)
  return payload
}

export function reviewSampleSize(spec: EventSpec, reviewCycleDays: number): number {
  // 日均上报量是未采样的原始量，采样比例决定真正进审计的样本条数。
  const daily = Math.round((spec.baseVolume * spec.ratio) / 100)
  return Math.max(0, daily) * reviewCycleDays
}

function buildChecklist(rule: RowLike, spec: EventSpec, bias: number, reviewCycleDays: number): string[] {
  const field = String(rule['校验字段'])
  if (field === RATIO_RULE) {
    return [
      `把 ${spec.eventNo} 的采样开关校准到申报值 ${formatRatio(spec.ratio)}，当前偏差 ${bias.toFixed(1)} 个百分点`,
      '核对客户端与服务端采样配置是否指向同一版本',
      `按 ${reviewCycleDays} 天复核周期回归抽样，偏差收敛到 ±${SAMPLE_BIAS_THRESHOLD} 个百分点内`,
    ]
  }
  if (field === PARAM_RULE) {
    return [
      `补齐 ${spec.eventNo} ${spec.version} 的上报参数字段并加必填校验`,
      '比对上报 schema 与事件申报参数，修正 SDK 拼装逻辑',
      `按 ${reviewCycleDays} 天复核周期回归，确认缺失率低于 1%`,
    ]
  }
  return [`按规则 ${String(rule['规则编号'])} 的异常条件复核 ${spec.eventNo} ${spec.version}`]
}

function baseRuleState(rule: RowLike, checkedAt: string): RuleQualityState {
  const field = String(rule['校验字段'])
  return {
    ruleNo: String(rule['规则编号']),
    eventNo: String(rule['审计对象']),
    conclusion: '通过',
    detail: '',
    checklist: [],
    historicalChecklist: null,
    lastCheckedAt: checkedAt,
    lastReviewedAt: checkedAt,
    nextReviewAt: addDays(checkedAt, DEFAULT_REVIEW_CYCLE_DAYS),
    reviewCycleDays: DEFAULT_REVIEW_CYCLE_DAYS,
    minSample: field === RATIO_RULE ? 2000 : 500,
    lastSample: 0,
    lastVersion: '',
    lastParams: '',
    lastRatio: 0,
    lastPendingVersions: [],
    lastFingerprint: '',
    operatorHandled: false,
    handledBy: '',
    handledAt: '',
  }
}

export type EvaluateOutcome = {
  state: RuleQualityState
  reused: boolean
  conclusion: AuditConclusion
  message: string
  needsOperator: boolean
  sample: number
  spec: EventSpec | null
}

/** 判定单条审计规则；是否复用由三要素指纹 + 样本量共同决定。 */
export function evaluateRule(
  quality: QualityState,
  rule: RowLike,
  arbitration: EventArbitration | undefined,
  options: { operator: string; checkedAt?: string },
): EvaluateOutcome {
  const ruleNo = String(rule['规则编号'])
  const field = String(rule['校验字段'])
  const previous = quality.rules[ruleNo]
  const checkedAt = options.checkedAt ?? nowText()
  const base = previous ?? baseRuleState(rule, checkedAt)
  const spec = arbitration?.winner ?? null

  if (!spec) {
    const pending: RuleQualityState = {
      ...base,
      conclusion: '待复核',
      detail: `未找到 ${String(rule['审计对象'])} 的生效事件规格，规则进入待复核`,
      checklist: [],
      lastCheckedAt: checkedAt,
      lastReviewedAt: checkedAt,
      nextReviewAt: addDays(checkedAt, base.reviewCycleDays),
      lastPendingVersions: arbitration?.pendingRows.map((item) => item.version) ?? [],
      operatorHandled: false,
      handledBy: '',
      handledAt: '',
    }
    return {
      state: pending,
      reused: false,
      conclusion: '待复核',
      message: '未找到生效事件规格，规则进入待复核',
      needsOperator: true,
      sample: 0,
      spec: null,
    }
  }

  const sample = reviewSampleSize(spec, base.reviewCycleDays)
  const currentFingerprint = ruleScopedFingerprint(field, spec.version, spec.params, spec.ratio)
  const previousFingerprint =
    previous === undefined
      ? ''
      : ruleScopedFingerprint(field, previous.lastVersion, previous.lastParams, previous.lastRatio)
  const hasPendingVersion = (arbitration?.pendingRows.length ?? 0) > 0

  // 样本不足时不允许复用：本次只能记「无法判定」，不能把上次结论顺延下来。
  const reusable =
    previous !== undefined &&
    previous.conclusion !== '待复核' &&
    previous.conclusion !== '无法判定' &&
    previousFingerprint === currentFingerprint &&
    !hasPendingVersion &&
    sample >= base.minSample

  if (reusable && previous) {
    const reusedState: RuleQualityState = {
      ...previous,
      lastParams: spec.params,
      lastRatio: spec.ratio,
      lastVersion: spec.version,
      lastPendingVersions: [],
      lastFingerprint: specFingerprint(spec.version, spec.params, spec.ratio),
      detail: `${spec.eventNo} 的事件版本、上报参数与采样比例均未变化，复用 ${previous.lastReviewedAt} 的复核结论「${previous.conclusion}」`,
    }
    return {
      state: reusedState,
      reused: true,
      conclusion: previous.conclusion,
      message: `事件规格未变化，复用 ${previous.lastReviewedAt} 的复核结论「${previous.conclusion}」`,
      // 复用「异常」结论时修复清单仍然有效，仍由操作人处理。
      needsOperator: previous.conclusion !== '通过',
      sample,
      spec,
    }
  }

  const bias = simulatedBias(field, spec)
  const missingRate = simulatedMissingRate(field, spec)
  let conclusion: AuditConclusion
  let detail: string
  let needsOperator: boolean

  if (sample < base.minSample) {
    conclusion = '无法判定'
    detail = `本轮样本量 ${sample} 条（日均 ${spec.baseVolume} × 采样 ${formatRatio(spec.ratio)} × ${base.reviewCycleDays} 天），低于最小样本 ${base.minSample} 条；本次无法判定，未沿用上次结论`
    needsOperator = true
  } else if (hasPendingVersion) {
    conclusion = '待复核'
    detail = arbitration?.note ?? '事件存在多个生效版本，待人工复核'
    needsOperator = true
  } else if (field === RATIO_RULE) {
    const passed = Math.abs(bias) <= SAMPLE_BIAS_THRESHOLD
    conclusion = passed ? '通过' : '异常'
    detail = `采样比例申报 ${formatRatio(spec.ratio)}，实测 ${formatRatio(spec.ratio + bias)}，偏差 ${bias.toFixed(1)} 个百分点，${passed ? '在' : '超过'} ±${SAMPLE_BIAS_THRESHOLD} 个百分点阈值`
    needsOperator = !passed
  } else if (field === PARAM_RULE) {
    const passed = missingRate <= 1
    conclusion = passed ? '通过' : '异常'
    detail = `上报参数字段 ${parseParams(spec.params).length} 个，缺失率 ${missingRate.toFixed(1)}%，${passed ? '未超过' : '超过'} 1% 阈值`
    needsOperator = !passed
  } else {
    conclusion = '通过'
    detail = `按 ${spec.version} 规格复核，未发现异常`
    needsOperator = false
  }

  // 事件改版后旧修复清单只留档，不再作为当前建议。
  const archivedChecklist = previous && previous.checklist.length > 0
    ? { version: previous.lastVersion, items: previous.checklist, archivedAt: checkedAt }
    : null
  const versionChanged = previous !== undefined && previous.lastVersion !== spec.version
  const historicalChecklist: ArchivedChecklist | null = archivedChecklist
    ? archivedChecklist
    : versionChanged
      ? null
      : base.historicalChecklist
  const checklist = conclusion === '异常' ? buildChecklist(rule, spec, bias, base.reviewCycleDays) : []

  const next: RuleQualityState = {
    ...base,
    conclusion,
    detail,
    checklist,
    historicalChecklist,
    lastCheckedAt: checkedAt,
    lastReviewedAt: checkedAt,
    nextReviewAt: addDays(checkedAt, base.reviewCycleDays),
    lastParams: spec.params,
    lastRatio: spec.ratio,
    lastVersion: spec.version,
    lastPendingVersions: arbitration?.pendingRows.map((item) => item.version) ?? [],
    lastFingerprint: specFingerprint(spec.version, spec.params, spec.ratio),
    lastSample: sample,
    operatorHandled: false,
    handledBy: '',
    handledAt: '',
  }

  return {
    state: next,
    reused: false,
    conclusion,
    message: `重新判定：${detail}`,
    needsOperator,
    sample,
    spec,
  }
}

export type ReviewPreviewRow = {
  ruleNo: string
  ruleName: string
  eventNo: string
  checkField: string
  eventVersion: string
  ratio: number
  owner: string
  product: string
  sample: number
  minSample: number
  willReuse: boolean
  currentConclusion: AuditConclusion | '—'
  expectedConclusion: AuditConclusion | '—'
  reason: string
}

function previewRows(
  ruleRows: RowLike[],
  selected: Set<string>,
  quality: QualityState,
  arbitrations: Map<string, EventArbitration>,
  override?: Map<string, { spec: EventSpec; pendingRows: EventSpec[] }>,
): ReviewPreviewRow[] {
  const checkedAt = nowText()
  return ruleRows
    .filter((row) => selected.has(String(row['规则编号'])))
    .map((row) => {
      const ruleNo = String(row['规则编号'])
      const eventNo = String(row['审计对象'])
      const field = String(row['校验字段'])
      const replaced = override?.get(eventNo)
      const arbitration: EventArbitration | undefined = replaced
        ? {
            eventNo,
            winner: replaced.spec,
            pendingRows: replaced.pendingRows,
            note: arbitrations.get(eventNo)?.note ?? '',
          }
        : arbitrations.get(eventNo)
      const spec = arbitration?.winner ?? null
      const previous = quality.rules[ruleNo]
      const cycle = previous?.reviewCycleDays ?? DEFAULT_REVIEW_CYCLE_DAYS
      const sample = spec ? reviewSampleSize(spec, cycle) : 0
      const minSample = previous?.minSample ?? (field === RATIO_RULE ? 2000 : 500)
      const outcome = evaluateRule(quality, row, arbitration, { operator: '预览', checkedAt })
      const willReuse = outcome.reused
      let reason = '三要素变化，需要重新判定'
      if (spec === null) {
        reason = '未找到生效事件规格，进入待复核'
      } else if (outcome.conclusion === '无法判定') {
        reason = `样本 ${sample} 条低于最小样本 ${minSample} 条，本次无法判定`
      } else if (outcome.conclusion === '待复核' && !willReuse) {
        reason = '存在并行生效版本，进入待复核'
      } else if (willReuse) {
        reason = '三要素未变化且样本充足，复用原复核结论'
      }
      return {
        ruleNo,
        ruleName: `${spec?.eventName ?? eventNo}·${field}`,
        eventNo,
        checkField: field,
        eventVersion: spec?.version ?? '—',
        ratio: spec?.ratio ?? 0,
        owner: spec?.owner ?? '—',
        product: spec?.product ?? '—',
        sample,
        minSample,
        willReuse,
        currentConclusion: previous?.conclusion ?? '—',
        expectedConclusion: outcome.conclusion,
        reason,
      }
    })
}

export function buildReviewPreview(ruleRows: RowLike[], selected: Set<string>): ReviewPreviewRow[] {
  return previewRows(ruleRows, selected, readQuality(), loadEventSpecs())
}

export function runBatchReview(
  ruleRows: RowLike[],
  selected: Set<string>,
  operator: string,
): { results: BatchResultItem[]; state: QualityState; record: BatchRunRecord } {
  const quality = readQuality()
  const arbitrations = loadEventSpecs()
  const checkedAt = nowText()
  const nextRules = { ...quality.rules }
  const results: BatchResultItem[] = []

  for (const row of ruleRows) {
    const ruleNo = String(row['规则编号'])
    if (!selected.has(ruleNo)) {
      continue
    }
    const eventNo = String(row['审计对象'])
    const outcome = evaluateRule(quality, row, arbitrations.get(eventNo), { operator, checkedAt })
    nextRules[ruleNo] = outcome.state
    results.push({
      ruleNo,
      eventNo,
      ruleName: `${outcome.spec?.eventName ?? eventNo}·${String(row['校验字段'])}`,
      ok: outcome.conclusion === '通过',
      reused: outcome.reused,
      conclusion: outcome.conclusion,
      message: outcome.message,
      needsOperator: outcome.needsOperator,
    })
  }

  const record: BatchRunRecord = {
    id: `BATCH-${checkedAt.replace(/[-: ]/g, '').slice(0, 8)}-${pad(quality.batchRuns.length + 1)}`,
    operator,
    createdAt: checkedAt,
    results,
  }
  const nextState = saveQualityState({ ...quality, rules: nextRules, batchRuns: [...quality.batchRuns, record] })
  return { results, state: nextState, record }
}

export function handleRule(ruleNo: string, operator: string): { ok: boolean; message: string; state: QualityState } {
  const quality = readQuality()
  const current = quality.rules[ruleNo]
  if (!current) {
    return { ok: false, message: `没有找到规则 ${ruleNo} 的质量结论`, state: quality }
  }
  if (!current.checklist.length && current.conclusion !== '无法判定' && current.conclusion !== '待复核') {
    return { ok: false, message: `规则 ${ruleNo} 当前不需要操作人处理`, state: quality }
  }
  const handledAt = nowText()
  const nextRules = {
    ...quality.rules,
    [ruleNo]: {
      ...current,
      operatorHandled: true,
      handledBy: operator,
      handledAt,
      detail:
        current.conclusion === '异常'
          ? `${current.detail}；修复清单已由 ${operator} 于 ${handledAt} 接手处理`
          : `${current.detail}；${operator} 已于 ${handledAt} 确认并转人工跟进`,
    },
  }
  return {
    ok: true,
    message: `规则 ${ruleNo} 已交操作人 ${operator} 处理，其余条目结论不受影响`,
    state: saveQualityState({ ...quality, rules: nextRules }),
  }
}

export type EventSpecChangeInput = {
  eventNo: string
  version: string
  params: string
  ratio: string
  effectiveAt?: string
}

export type ChangePreview = {
  record: QualityChangeRecord
  timeline: { stage: string; text: string; tone: 'done' | 'active' | 'muted' }[]
  impactRows: ReviewPreviewRow[]
  changedFields: string[]
}

export function buildChangePreview(input: EventSpecChangeInput): ChangePreview {
  const quality = readQuality()
  const arbitrations = loadEventSpecs()
  const ruleRows = listRows('auditcheck')
  const arbitration = arbitrations.get(input.eventNo)
  const current = arbitration?.winner ?? null
  const ratio = parseRatio(input.ratio)
  const version = input.version.trim() || current?.version || 'v1'
  const params = input.params.trim() || current?.params || ''
  const to: EventSpecSnapshot = {
    version,
    params,
    ratio,
    effectiveAt: input.effectiveAt ?? nowText(),
    owner: current?.owner ?? '—',
    product: current?.product ?? '—',
    productVolume: current?.baseVolume ?? 0,
  }
  const from: EventSpecSnapshot = current
    ? {
        version: current.version,
        params: current.params,
        ratio: current.ratio,
        effectiveAt: current.effectiveAt,
        owner: current.owner,
        product: current.product,
        productVolume: current.baseVolume,
      }
    : { version: '—', params: '—', ratio: 0, effectiveAt: '—', owner: '—', product: '—', productVolume: 0 }

  const toSpec: EventSpec = {
    ...(current ?? {
      rowId: 0,
      eventNo: input.eventNo,
      eventName: input.eventNo,
      version,
      params,
      ratio,
      owner: '—',
      product: '—',
      baseVolume: 0,
      status: '已发布',
      stored: '已落库',
      effectiveAt: to.effectiveAt,
      fullyStored: true,
    }),
    version,
    params,
    ratio,
    effectiveAt: to.effectiveAt,
  }

  // 用「新规格」预演一遍，判断哪些规则复用、哪些必须重新判定。
  const override = new Map<string, { spec: EventSpec; pendingRows: EventSpec[] }>([
    [input.eventNo, { spec: toSpec, pendingRows: arbitration?.pendingRows ?? [] }],
  ])
  const impactRows = previewRows(
    ruleRows,
    new Set(ruleRows.map((row) => String(row['规则编号']))),
    quality,
    arbitrations,
    override,
  )
  for (const item of impactRows) {
    if (item.eventNo !== input.eventNo) {
      // 未引用该事件的规则不受影响，质量结论原样保留。
      item.willReuse = true
      item.reason = '未引用该事件，继续复用原复核结论'
      item.expectedConclusion = item.currentConclusion
    }
  }
  const affectedRuleIds = impactRows
    .filter((item) => item.eventNo === input.eventNo && !item.willReuse)
    .map((item) => item.ruleNo)
  const reusedRuleIds = impactRows.filter((item) => item.willReuse).map((item) => item.ruleNo)

  const record: QualityChangeRecord = {
    id: `CHG-${to.effectiveAt.replace(/[-: ]/g, '').slice(0, 8)}-${pad(quality.changes.length + 1)}`,
    eventNo: input.eventNo,
    eventName: current?.eventName ?? input.eventNo,
    owner: to.owner,
    params: to.params,
    product: to.product,
    from,
    to,
    ratioChanged: from.ratio !== to.ratio,
    versionChanged: from.version !== to.version,
    paramsChanged: from.params !== to.params,
    affectedRuleIds,
    reusedRuleIds,
    arbitrationNote: arbitration?.note ?? `${input.eventNo} 尚未登记生效版本`,
    operator: '值班管理员',
    createdAt: to.effectiveAt,
  }

  const changedFields: string[] = []
  if (record.ratioChanged) changedFields.push('采样比例')
  if (record.versionChanged) changedFields.push('事件版本')
  if (record.paramsChanged) changedFields.push('上报参数')

  const timeline: ChangePreview['timeline'] = [
    {
      stage: '事件原规格',
      text: `事件 ${input.eventNo}（${record.eventName}）原采样比例 ${formatRatio(from.ratio)}，版本 ${from.version}，上报参数 ${from.params}，负责人 ${from.owner}`,
      tone: 'done',
    },
    {
      stage: '本次变更',
      text: changedFields.length > 0 ? `${changedFields.join('、')}调整：采样比例 ${formatRatio(from.ratio)} → ${formatRatio(to.ratio)}，版本 ${from.version} → ${to.version}` : '规格没有变化，不触发重新判定',
      tone: changedFields.length > 0 ? 'active' : 'muted',
    },
    {
      stage: '影响范围',
      text: affectedRuleIds.length > 0 ? `重新判定 ${affectedRuleIds.join('、')}` : '没有规则需要重新判定',
      tone: affectedRuleIds.length > 0 ? 'active' : 'muted',
    },
    {
      stage: '继续复用',
      text: reusedRuleIds.length > 0 ? `复用 ${reusedRuleIds.join('、')} 的原复核结果` : '无需复用',
      tone: 'done',
    },
    {
      stage: '版本仲裁',
      text: record.arbitrationNote,
      tone: 'muted',
    },
  ]

  return { record, timeline, impactRows, changedFields }
}

/** 把新规格写回事件定义，保证后续复核读取到的是同一份事实。 */
function persistEventSpec(input: EventSpecChangeInput, winner: EventSpec | null, effectiveAt: string): void {
  const rows = listRows('eventdef')
  if (!winner) {
    return
  }
  const next = rows.map((row) => {
    if (Number(row.id) !== winner.rowId) {
      return row
    }
    return {
      ...row,
      '事件版本': input.version.trim() || String(row['事件版本'] ?? 'v1'),
      '上报参数': input.params.trim() || String(row['上报参数'] ?? ''),
      '采样比例': formatRatio(parseRatio(input.ratio)),
      '生效时间': effectiveAt,
      '落库状态': '已落库',
      status: '已发布',
      pending: false,
    }
  })
  saveRows('eventdef', next)
}

export function applyEventSpecChange(input: EventSpecChangeInput): {
  ok: boolean
  message: string
  preview: ChangePreview
  state: QualityState
} {
  const before = buildChangePreview(input)
  const arbitrations = loadEventSpecs()
  const winner = arbitrations.get(input.eventNo)?.winner ?? null

  if (before.changedFields.length === 0) {
    return {
      ok: false,
      message: `${input.eventNo} 的事件版本、上报参数与采样比例都没有变化，未触发复核`,
      preview: before,
      state: readQuality(),
    }
  }

  const now = nowText()
  persistEventSpec(input, winner, now)

  const quality = readQuality()
  const refreshed = loadEventSpecs()
  const ruleRows = listRows('auditcheck')
  const nextRules = { ...quality.rules }

  // 只重算受影响的规则，其余规则的质量结论保留原样。
  for (const ruleNo of before.record.affectedRuleIds) {
    const rule = ruleRows.find((row) => String(row['规则编号']) === ruleNo)
    if (!rule) {
      continue
    }
    const outcome = evaluateRule(quality, rule, refreshed.get(String(rule['审计对象'])), {
      operator: '值班管理员',
      checkedAt: now,
    })
    nextRules[ruleNo] = outcome.state
  }

  const record: QualityChangeRecord = { ...before.record, createdAt: now, to: { ...before.record.to, effectiveAt: now } }
  const nextState = saveQualityState({ ...quality, rules: nextRules, changes: [...quality.changes, record] })
  return {
    ok: true,
    message: `已按 ${input.eventNo} 的新规格重算影响范围：重新判定 ${record.affectedRuleIds.join('、') || '无'}，其余 ${record.reusedRuleIds.length} 条规则继续复用原结论`,
    preview: {
      ...before,
      record,
      // 保留提交前的预演结果，作为本次提交的存档：受影响规则显示「重新判定」。
      impactRows: before.impactRows,
    },
    state: nextState,
  }
}
