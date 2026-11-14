import { QUALITY_SEED } from './quality-seed'
import type { QualityState } from './types'

// 埋点质量结论与事件规格变更记录单独存一份，避免与业务清单互相覆盖。
// v2：结论结构补了三要素指纹、样本量与版本仲裁信息，和旧缓存不兼容。
const STORAGE_KEY = 'data-product-ops:quality:v2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

let cache: QualityState | null = null

export function readQuality(): QualityState {
  if (cache !== null) {
    return cache
  }
  const fallback = clone(QUALITY_SEED)
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = fallback
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    cache = fallback
    return cache
  }
  try {
    const parsed = JSON.parse(raw) as Partial<QualityState>
    cache = {
      ...fallback,
      ...parsed,
      rules: { ...fallback.rules, ...(parsed.rules ?? {}) },
      changes: parsed.changes ?? fallback.changes,
      batchRuns: parsed.batchRuns ?? fallback.batchRuns,
    }
    return cache
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    cache = fallback
    return cache
  }
}

export function saveQuality(next: QualityState): void {
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetQuality(): void {
  const seed = clone(QUALITY_SEED)
  saveQuality(seed)
}

export function qualityStorageKey(): string {
  return STORAGE_KEY
}
