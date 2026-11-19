// 病安異常事件通報（純函式，畫面、服務層、種子、測試共用）：類別、影響程度、嚴重度（SAC）、欄位檢查、統計
import type { Incident, IncidentCategory, IncidentHarm, IncidentRca, RcaCause } from '@/types'

export const INCIDENT_CATEGORY_LABEL: Record<IncidentCategory, string> = { fall: '跌倒', medication: '給藥', line: '管路', specimen: '檢體', other: '其他' }
export const INCIDENT_HARM_LABEL: Record<IncidentHarm, string> = { 'near-miss': '跡近錯失（沒發生在病人身上）', none: '無傷害', mild: '輕度傷害', moderate: '中度傷害', severe: '重度傷害', death: '死亡' }
export const INCIDENT_STATUS_LABEL: Record<Incident['status'], string> = { reported: '待審查', reviewing: '審查中', closed: '已結案' }
/** 嚴重度評估（SAC）：1 極嚴重、2 嚴重、3 中等、4 輕微 */
export const SAC_LABEL: Record<1 | 2 | 3 | 4, string> = { 1: 'SAC 1 極嚴重', 2: 'SAC 2 嚴重', 3: 'SAC 3 中等', 4: 'SAC 4 輕微' }
/** 依影響程度建議的 SAC（審查的人可以改） */
export const sacSuggest = (h: IncidentHarm): 1 | 2 | 3 | 4 => (h === 'death' || h === 'severe' ? 1 : h === 'moderate' ? 2 : h === 'mild' ? 3 : 4)

/** 通報欄位：類別、發生時間（不能在未來）、地點、經過、影響程度 */
export function checkIncident(x: { category?: string; occurredAt?: string; location?: string; description?: string; harm?: string }, now: string): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.category || !(x.category in INCIDENT_CATEGORY_LABEL)) e.category = '請選事件類別'
  if (!x.occurredAt || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.occurredAt)) e.occurredAt = '請填發生時間'
  else if (x.occurredAt > now) e.occurredAt = '發生時間不能在未來'
  if (!x.location?.trim()) e.location = '請寫發生地點（例：5A 病房 502 床）'
  if (!x.description?.trim() || x.description.trim().length < 10) e.description = '請寫事件經過（至少 10 個字：發生什麼、怎麼發現的）'
  if (!x.harm || !(x.harm in INCIDENT_HARM_LABEL)) e.harm = '請選對病人的影響'
  return e
}
/** 審查欄位：SAC；結案要寫原因分析與改善措施 */
export function checkIncidentReview(x: { sac?: number; cause?: string; actions?: string; close?: boolean }): Record<string, string> {
  const e: Record<string, string> = {}
  if (![1, 2, 3, 4].includes(Number(x.sac))) e.sac = '請評定嚴重度（SAC 1–4）'
  if (x.close && !x.cause?.trim()) e.cause = '結案要寫原因分析'
  if (x.close && !x.actions?.trim()) e.actions = '結案要寫改善措施'
  return e
}

/** 統計：件數、依類別、依影響程度、結案率（since 之後通報的） */
export function incidentStats(xs: Pick<Incident, 'category' | 'harm' | 'status' | 'reportedAt'>[], since: string) {
  const ys = xs.filter((x) => x.reportedAt >= since)
  const closed = ys.filter((x) => x.status === 'closed').length
  return {
    total: ys.length,
    byCategory: (Object.keys(INCIDENT_CATEGORY_LABEL) as IncidentCategory[]).map((k) => ({ key: k, label: INCIDENT_CATEGORY_LABEL[k], count: ys.filter((x) => x.category === k).length })),
    byHarm: (Object.keys(INCIDENT_HARM_LABEL) as IncidentHarm[]).map((k) => ({ key: k, label: INCIDENT_HARM_LABEL[k], count: ys.filter((x) => x.harm === k).length })),
    closed, closeRate: ys.length ? Math.round((closed / ys.length) * 100) : 100,
  }
}

// ---------- 根本原因分析（RCA） ----------

export const RCA_CAUSE_LABEL: Record<RcaCause, string> = { staff: '人員', equipment: '設備', process: '流程', environment: '環境', communication: '溝通', patient: '病人因素' }
/** SAC 1–2 結案前一定要做 RCA */
export const rcaRequired = (sac: number | undefined) => sac === 1 || sac === 2
/** 行動計畫過期：還沒完成、期限已過 */
export const planOverdue = (p: Pick<IncidentRca['plans'][number], 'status' | 'due'>, today: string) => p.status !== 'done' && p.due < today
/** RCA 完成（可以結案）：有時間序列、原因分類、根本原因、至少一項計畫，而且計畫都完成了 */
export const rcaComplete = (r: Pick<IncidentRca, 'timeline' | 'causes' | 'rootCause' | 'plans'> | undefined) =>
  !!r && r.timeline.length > 0 && r.causes.length > 0 && !!r.rootCause.trim() && r.plans.length > 0 && r.plans.every((p) => p.status === 'done')
/** RCA 欄位：時間序列每列要有時間與事件、至少一個原因分類、根本原因、計畫每項要有內容負責人期限 */
export function checkRca(x: { timeline?: { at?: string; event?: string }[]; causes?: string[]; rootCause?: string; plans?: { action?: string; owner?: string; due?: string }[] }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.timeline?.length || x.timeline.some((t) => !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t.at ?? '') || !t.event?.trim())) e.timeline = '時間序列至少一列，每列要有時間與發生的事'
  if (!x.causes?.length || x.causes.some((c) => !(c in RCA_CAUSE_LABEL))) e.causes = '請至少勾一個原因分類'
  if (!x.rootCause?.trim()) e.rootCause = '請寫根本原因（為什麼會發生、不只是誰做錯）'
  if (!x.plans?.length || x.plans.some((p) => !p.action?.trim() || !p.owner?.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(p.due ?? ''))) e.plans = '行動計畫至少一項，每項要有內容、負責人、期限'
  return e
}
