import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  buildReviewPreview,
  formatRatio,
  handleRule,
  loadQualityState,
  runBatchReview,
  SAMPLE_BIAS_THRESHOLD,
  type ReviewPreviewRow,
} from '@/api/quality-service'
import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import type { AuditConclusion, BatchResultItem, EntryRow, QualityState } from '@/data/types'

const meta = moduleMeta('auditcheck')
const columns = [
  "规则编号",
  "审计对象",
  "校验字段",
  "异常条件",
  "告警级别",
  "审计频率",
  "修复建议",
  "规则状态"
]
const actions = ["提交规则评审", "生效规则", "关闭规则"]
const statuses = ["草稿", "规则评审中", "已生效", "已关闭"]
const operator = '值班管理员'

function conclusionClass(conclusion: AuditConclusion | '—'): string {
  if (conclusion === '通过') return 'tag tag-pass'
  if (conclusion === '异常') return 'tag tag-bad'
  if (conclusion === '无法判定') return 'tag tag-unknown'
  if (conclusion === '待复核') return 'tag tag-pending'
  return 'tag'
}

export default function AuditcheckView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [quality, setQuality] = useState<QualityState | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [lastResults, setLastResults] = useState<BatchResultItem[] | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setQuality(loadQualityState())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '数据审计列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  const preview: ReviewPreviewRow[] = useMemo(() => {
    if (!quality || selected.size === 0) {
      return []
    }
    // 勾选可能跨越筛选条件，预览按全部规则计算，保证每条勾选项都有去处。
    return buildReviewPreview(listEntries(meta.key).items, selected)
  }, [quality, selected])

  const reuseCount = preview.filter((item) => item.willReuse).length
  const recheckCount = preview.length - reuseCount

  function toggle(rowNo: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(rowNo)) {
        next.delete(rowNo)
      } else {
        next.add(rowNo)
      }
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === rows.length && rows.length > 0) {
        return new Set()
      }
      return new Set(rows.map((row) => String(row['规则编号'])))
    })
  }

  function submitBatch() {
    setErrorMessage('')
    setNotice('')
    if (selected.size === 0) {
      setErrorMessage('请先勾选要复核的审计规则')
      return
    }
    // 整组一次提交，每条规则单独返回结果；不受当前筛选条件影响。
    const outcome = runBatchReview(listEntries(meta.key).items, selected, operator)
    setQuality(outcome.state)
    setLastResults(outcome.results)
    const failed = outcome.results.filter((item) => !item.ok).length
    setNotice(`本次提交 ${outcome.results.length} 条，逐条出结果：通过 ${outcome.results.length - failed} 条，未通过 ${failed} 条`)
    setSelected(new Set())
    reload()
  }

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  function handOff(ruleNo: string) {
    setErrorMessage('')
    const result = handleRule(ruleNo, operator)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    setQuality(result.state)
  }

  const failedCount = Object.values(quality?.rules ?? {}).filter(
    (rule) => rule.conclusion !== '通过' && !rule.operatorHandled,
  ).length
  const stats = [
    { label: '审计规则总数', value: rows.length },
    { label: '已生效规则', value: rows.filter((row) => String(row.status) === '已生效').length },
    { label: '本次重新判定', value: preview.length - reuseCount },
    { label: '未通过待操作人处理', value: failedCount },
    { label: '采样偏差阈值', value: `±${SAMPLE_BIAS_THRESHOLD} 个百分点` },
  ]

  return (
    <section className="page" data-module="auditcheck">
      <header className="page-head">
        <div>
          <h2>数据审计管理</h2>
          <p className="page-desc">
            变更影响范围只看事件版本、上报参数与采样比例：采样偏差阈值 ±{SAMPLE_BIAS_THRESHOLD} 个百分点、复核周期 7 天。
            样本不足记「无法判定」，事件改版后旧修复清单只留档；未引用变更事件的规则继续复用原复核结论。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出数据审计清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <div className="batch-bar">
        <div className="batch-info">
          <span>
            已勾选 <strong>{selected.size}</strong> / {rows.length} 条
          </span>
          {selected.size > 0 && (
            <span className="batch-hint">
              本次重新判定 {recheckCount} 条，复用原结论 {reuseCount} 条
            </span>
          )}
        </div>
        <div className="batch-actions">
          <button className="btn ghost" type="button" onClick={() => setSelected(new Set(rows.map((row) => String(row['规则编号']))))} disabled={rows.length === 0}>
            全选本页
          </button>
          <button className="btn ghost" type="button" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            清空勾选
          </button>
          <button className="btn primary" type="button" onClick={submitBatch} disabled={selected.size === 0}>
            提交整组复核
          </button>
        </div>
      </div>

      {preview.length > 0 && (
        <table className="data-table preview-table">
          <thead>
            <tr>
              <th>复核预览</th>
              <th>事件版本</th>
              <th>采样比例</th>
              <th>事件负责人</th>
              <th>样本/最小样本</th>
              <th>本次处理</th>
              <th>原结论</th>
              <th>预演结论</th>
            </tr>
          </thead>
          <tbody>
            {preview.map((item) => (
              <tr key={item.ruleNo} className={item.willReuse ? 'preview-reuse' : 'preview-recheck'}>
                <td>{item.ruleNo} · {item.ruleName}</td>
                <td>{item.eventVersion}</td>
                <td>{formatRatio(item.ratio)}</td>
                <td>{item.owner}</td>
                <td>{item.sample} / {item.minSample}</td>
                <td>{item.reason}</td>
                <td><span className={conclusionClass(item.currentConclusion)}>{item.currentConclusion}</span></td>
                <td><span className={conclusionClass(item.expectedConclusion)}>{item.expectedConclusion}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <table className="data-table">
        <thead>
          <tr>
            <th className="check-col">
              <input
                type="checkbox"
                aria-label="全选审计规则"
                checked={rows.length > 0 && selected.size === rows.length}
                onChange={toggleAll}
              />
            </th>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>质量结论</th>
            <th>最近复核</th>
            <th>修复清单</th>
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const ruleNo = String(row['规则编号'])
            const rule = quality?.rules[ruleNo]
            return (
              <tr key={ruleNo}>
                <td className="check-col">
                  <input
                    type="checkbox"
                    aria-label={`勾选${ruleNo}`}
                    checked={selected.has(ruleNo)}
                    onChange={() => toggle(ruleNo)}
                  />
                </td>
                {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                <td>
                  <span className={conclusionClass(rule?.conclusion ?? '—')}>{rule?.conclusion ?? '—'}</span>
                  <p className="rule-detail">{rule?.detail ?? '尚未产生质量结论'}</p>
                  {rule && rule.lastPendingVersions.length > 0 && (
                    <p className="rule-detail muted">并行生效版本 {rule.lastPendingVersions.join('、')} 待复核</p>
                  )}
                </td>
                <td>{rule?.lastReviewedAt ?? '—'}</td>
                <td className="checklist-cell">
                  {rule && rule.checklist.length > 0 && (
                    <ul className="checklist">
                      {rule.checklist.map((item) => <li key={item}>{item}</li>)}
                    </ul>
                  )}
                  {rule?.historicalChecklist && (
                    <details className="history-box">
                      <summary>{rule.historicalChecklist.version} 历史清单（仅留档）</summary>
                      <ul className="checklist muted">
                        {rule.historicalChecklist.items.map((item) => <li key={item}>{item}</li>)}
                      </ul>
                    </details>
                  )}
                  {(!rule || rule.checklist.length === 0) && !rule?.historicalChecklist && '—'}
                  {rule && (
                    <div className="rule-meta">
                      样本 {rule.lastSample} / 最小 {rule.minSample} · 周期 {rule.reviewCycleDays} 天 · 下次复核 {rule.nextReviewAt}
                    </div>
                  )}
                  {rule?.operatorHandled && (
                    <div className="rule-meta">已由 {rule.handledBy} 于 {rule.handledAt} 接手</div>
                  )}
                  {rule && rule.conclusion !== '通过' && !rule.operatorHandled && (
                    <button className="link" type="button" onClick={() => handOff(ruleNo)}>
                      交由操作人处理
                    </button>
                  )}
                </td>
                <td>{row.status}</td>
                <td className="row-actions">
                  {actions.map((action) => (
                    <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                      {action}
                    </button>
                  ))}
                </td>
              </tr>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 6}>暂无数据审计数据，可先登记审计规则</td>
            </tr>
          )}
        </tbody>
      </table>

      {lastResults && (
        <section className="result-panel">
          <h3>本次整组提交结果（逐条返回）</h3>
          <ul className="result-list">
            {lastResults.map((item) => (
              <li key={item.ruleNo} className={item.ok ? 'result-ok' : 'result-bad'}>
                <span className={conclusionClass(item.conclusion)}>{item.conclusion}</span>
                <strong>{item.ruleNo}</strong>
                <span>{item.ruleName}</span>
                <span className="result-message">{item.message}</span>
                {item.needsOperator && <span className="tag tag-pending">待操作人处理</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="page-foot">
        <span>共 {total} 条数据审计记录；质量结论单独保存，批量复核逐条返回结果</span>
        {notice && <span className="notice-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
