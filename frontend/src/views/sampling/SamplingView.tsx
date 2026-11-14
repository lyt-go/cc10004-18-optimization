import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  applyEventSpecChange,
  buildChangePreview,
  formatRatio,
  loadEventSpecs,
  loadQualityState,
  SAMPLE_BIAS_THRESHOLD,
  type ChangePreview,
} from '@/api/quality-service'
import { listEntries } from '@/api/local-service'
import type { EntryRow, QualityChangeRecord, QualityState } from '@/data/types'

const operator = '值班管理员'

type RuleRow = {
  ruleNo: string
  checkField: string
  frequency: string
  eventNo: string
  action: string
  tone: 'recheck' | 'reuse' | 'none'
}

export default function SamplingView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [quality, setQuality] = useState<QualityState | null>(null)
  const [eventNo, setEventNo] = useState('EVEN-0002')
  // EVEN-0002 的采样比例由 10% 调到 50%，草案先摆在这里，提交后写回事件定义。
  const [ratio, setRatio] = useState('50')
  const [version, setVersion] = useState('')
  const [params, setParams] = useState('')
  const [preview, setPreview] = useState<ChangePreview | null>(null)
  const [notice, setNotice] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

  const load = useCallback(() => {
    setRows(listEntries('auditcheck').items)
    setQuality(loadQualityState())
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const arbitrations = useMemo(() => {
    // 依赖 rows/quality：事件规格或质量结论变化后重新计算展示。
    void rows
    void quality
    return loadEventSpecs()
  }, [rows, quality])

  const arbitration = arbitrations.get(eventNo)
  const current = arbitration?.winner ?? null
  const eventOptions = useMemo(() => [...arbitrations.values()], [arbitrations])

  const draftFor = useRef<string>('')
  useEffect(() => {
    // 切换事件时带入该事件当前规格；同事件刷新时保留操作人正在填的比例草案。
    if (draftFor.current === eventNo) {
      return
    }
    draftFor.current = eventNo
    const winner = arbitrations.get(eventNo)?.winner
    if (winner) {
      setVersion(winner.version)
      setParams(winner.params)
      setRatio(eventNo === 'EVEN-0002' ? '50' : String(winner.ratio))
    } else {
      setVersion('')
      setParams('')
      setRatio('')
    }
  }, [arbitrations, eventNo])

  const latestChange: QualityChangeRecord | null = useMemo(() => {
    const matches = [...(quality?.changes ?? [])].reverse()
    return matches.find((item) => item.eventNo === eventNo) ?? null
  }, [quality, eventNo])

  const livePreview = useMemo(() => {
    if (!eventNo) {
      return null
    }
    return buildChangePreview({ eventNo, version, params, ratio })
  }, [eventNo, version, params, ratio])

  const rulesForEvent = rows.filter((row) => String(row['审计对象']) === eventNo)
  const otherRules = rows.filter((row) => String(row['审计对象']) !== eventNo)

  // 展示口径：有变更记录时用「变更前 → 变更后」；操作人正在改草案时，右侧展示草案值。
  const draftRatio = Number(ratio)
  const draftDiffers = Number.isFinite(draftRatio) && current !== null && draftRatio !== current.ratio
  const originalRatio = latestChange ? latestChange.from.ratio : current?.ratio ?? 0
  const newRatio = draftDiffers ? draftRatio : latestChange ? latestChange.to.ratio : current?.ratio ?? 0
  const originalOwner = latestChange ? latestChange.from.owner : current?.owner ?? '—'
  const originalParams = latestChange ? latestChange.from.params : current?.params ?? '—'
  const newParams = draftDiffers ? params || '—' : latestChange ? latestChange.to.params : params || '—'

  const changedRuleIds = new Set(latestChange?.affectedRuleIds ?? [])
  const reusedRuleIds = new Set(latestChange?.reusedRuleIds ?? [])

  function ruleAction(ruleNo: string): RuleRow['action'] {
    if (changedRuleIds.has(ruleNo)) return '本次重新判定'
    if (reusedRuleIds.has(ruleNo)) return '继续复用原结论'
    return '—'
  }

  function submit() {
    setErrorMessage('')
    setNotice('')
    const result = applyEventSpecChange({ eventNo, version, params, ratio })
    setPreview(result.preview)
    if (!result.ok) {
      setErrorMessage(result.message)
      load()
      return
    }
    setNotice(result.message)
    load()
  }

  const history = quality?.changes ?? []

  return (
    <section className="page" data-module="sampling">
      <header className="page-head">
        <div>
          <h2>采样影响页</h2>
          <p className="page-desc">
            采样比例变化只影响引用该事件的审计规则；采样偏差阈值 ±{SAMPLE_BIAS_THRESHOLD} 个百分点、复核周期 7 天。
            其余规则不改校验字段与审计频率，继续复用原复核结果。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={load}>刷新</button>
        </div>
      </header>

      <div className="impact-grid">
        <article className="impact-card">
          <span className="stat-label">当前事件</span>
          <strong className="impact-value">{current ? `${current.eventName}（${current.eventNo}）` : eventNo}</strong>
          <p className="rule-detail">
            负责人 {current?.owner ?? '—'} · 所属产品 {current?.product ?? '—'} · 生效版本 {current?.version ?? '—'}
          </p>
          <p className="rule-detail">上报参数字段：{current?.params ?? '—'}</p>
          <p className="rule-detail">日均上报量 {current?.baseVolume ?? 0}</p>
        </article>
        <article className="impact-card impact-from">
          <span className="stat-label">{latestChange ? '原采样比例' : '当前采样比例'}</span>
          <strong className="impact-value">{formatRatio(originalRatio)}</strong>
          <p className="rule-detail">事件负责人 {originalOwner}</p>
          <p className="rule-detail">上报参数字段 {originalParams}</p>
          <p className="rule-detail">变更前版本 {latestChange?.from.version ?? current?.version ?? '—'}</p>
          <p className="rule-detail">审计规则 {eventNo} 引用 {rulesForEvent.length} 条</p>
        </article>
        <article className="impact-card impact-to">
          <span className="stat-label">{latestChange ? '新采样比例' : '拟调整为'}</span>
          <strong className="impact-value">{formatRatio(newRatio)}</strong>
          <p className="rule-detail">事件负责人 {latestChange?.to.owner ?? current?.owner ?? '—'}</p>
          <p className="rule-detail">上报参数字段 {newParams}</p>
          <p className="rule-detail">变更后版本 {latestChange?.to.version ?? current?.version ?? '—'}</p>
          <p className="rule-detail">
            预计样本 {Math.round(((latestChange?.to.productVolume ?? current?.baseVolume ?? 0) * newRatio) / 100) * 7} 条 / 7 天
          </p>
        </article>
      </div>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); submit() }}>
        <label className="filter-item">
          <span>埋点事件</span>
          <select value={eventNo} onChange={(event) => setEventNo(event.target.value)}>
            {eventOptions.map((item) => (
              <option key={item.eventNo} value={item.eventNo}>
                {item.eventNo} {item.winner?.eventName ?? ''}
              </option>
            ))}
          </select>
        </label>
        <label className="filter-item">
          <span>事件版本</span>
          <input value={version} onChange={(event) => setVersion(event.target.value)} />
        </label>
        <label className="filter-item">
          <span>上报参数</span>
          <input value={params} onChange={(event) => setParams(event.target.value)} />
        </label>
        <label className="filter-item">
          <span>采样比例（%）</span>
          <input value={ratio} onChange={(event) => setRatio(event.target.value)} />
        </label>
        <button className="btn primary" type="submit">应用采样变更</button>
        <span className="batch-hint">操作人：{operator}</span>
      </form>

      {arbitration && arbitration.pendingRows.length > 0 && (
        <p className="warn-banner">
          {arbitration.note}
          <span>（两个版本同时生效时，完整落库且生效时间更晚的版本为准，另一侧进入待复核）</span>
        </p>
      )}

      {livePreview && (
        <section className="timeline">
          {livePreview.timeline.map((item) => (
            <div key={item.stage} className={`timeline-item tone-${item.tone}`}>
              <span className="timeline-stage">{item.stage}</span>
              <span className="timeline-text">{item.text}</span>
            </div>
          ))}
        </section>
      )}

      <section className="result-panel">
        <h3>引用 {eventNo} 的审计规则</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>规则编号</th>
              <th>校验字段</th>
              <th>审计频率</th>
              <th>本次处理</th>
              <th>质量结论</th>
              <th>最近复核</th>
            </tr>
          </thead>
          <tbody>
            {rulesForEvent.map((row) => {
              const ruleNo = String(row['规则编号'])
              const state = quality?.rules[ruleNo]
              const action = ruleAction(ruleNo)
              return (
                <tr key={ruleNo} className={action === '本次重新判定' ? 'preview-recheck' : 'preview-reuse'}>
                  <td>{ruleNo}</td>
                  <td>{String(row['校验字段'])}</td>
                  <td>{String(row['审计频率'])}</td>
                  <td>{action}</td>
                  <td>{state?.conclusion ?? '—'}</td>
                  <td>{state?.lastReviewedAt ?? '—'}</td>
                </tr>
              )
            })}
            {rulesForEvent.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={6}>没有规则引用 {eventNo}</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="result-panel">
        <h3>未引用 {eventNo} 的审计规则（保持原复核结果）</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>规则编号</th>
              <th>审计对象</th>
              <th>校验字段</th>
              <th>审计频率</th>
              <th>处理方式</th>
              <th>质量结论</th>
            </tr>
          </thead>
          <tbody>
            {otherRules.map((row) => {
              const ruleNo = String(row['规则编号'])
              const state = quality?.rules[ruleNo]
              return (
                <tr key={ruleNo} className="preview-reuse">
                  <td>{ruleNo}</td>
                  <td>{String(row['审计对象'])}</td>
                  <td>{String(row['校验字段'])}</td>
                  <td>{String(row['审计频率'])}</td>
                  <td>继续复用原复核结果</td>
                  <td>{state?.conclusion ?? '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      {preview && (
        <section className="result-panel">
          <h3>最近一次提交结果</h3>
          <p className="rule-detail">
            {preview.record.eventNo}：采样比例 {formatRatio(preview.record.from.ratio)} → {formatRatio(preview.record.to.ratio)}
            ，负责人 {preview.record.owner}，上报参数 {preview.record.params || '—'}，变更人 {preview.record.operator}
          </p>
          <ul className="result-list">
            {preview.impactRows
              .filter((item) => item.eventNo === preview.record.eventNo)
              .map((item) => (
                <li key={item.ruleNo} className={item.willReuse ? 'result-ok' : 'result-bad'}>
                  <strong>{item.ruleNo}</strong>
                  <span>
                    {item.willReuse
                      ? '复用原复核结论'
                      : `重新判定：${item.expectedConclusion}（样本 ${item.sample}/${item.minSample}）`}
                  </span>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="result-panel">
        <h3>采样变更记录</h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>变更编号</th>
              <th>事件</th>
              <th>原采样比例</th>
              <th>新采样比例</th>
              <th>事件负责人</th>
              <th>上报参数</th>
              <th>本次重新判定</th>
              <th>继续复用</th>
              <th>变更时间</th>
            </tr>
          </thead>
          <tbody>
            {history.map((item) => (
              <tr key={item.id}>
                <td>{item.id}</td>
                <td>{item.eventNo}</td>
                <td>{formatRatio(item.from.ratio)}</td>
                <td>{formatRatio(item.to.ratio)}</td>
                <td>{item.owner}</td>
                <td>{item.params}</td>
                <td>{item.affectedRuleIds.join('、') || '—'}</td>
                <td>{item.reusedRuleIds.join('、') || '—'}</td>
                <td>{item.createdAt}</td>
              </tr>
            ))}
            {history.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={9}>还没有采样变更记录</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <footer className="page-foot">
        <span>
          当前规则 {quality ? Object.keys(quality.rules).length : 0} 条；两个版本同时生效时以完整落库且时间更晚的版本为准
        </span>
        {notice && <span className="notice-text">{notice}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
