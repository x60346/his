// 危急值通報（純函式）：報告有危急值，醫檢師要在發出後 30 分鐘內打電話通報（住院：病房護理師或主治；門診：開立醫師），
// 記下受話者姓名、職稱、對方已複誦。逾時標紅；指標「通報時效達成率」。檢驗頁、首頁、種子、測試共用
import type { LabLimits, LabReport } from '@/types'
import { addMinutes } from '@/utils/date'

/** 發出後幾分鐘內要通報 */
export const CALLOUT_MINUTES = 30
export const CALLOUT_ROLE_LABEL = { nurse: '護理師', doctor: '醫師' } as const

type R = Pick<LabReport, 'values' | 'reportedAt' | 'corrections' | 'callout'>

/** 沒聯絡上幾次要升級（改通報下一層） */
export const CALLOUT_ESCALATE_AFTER = 2
/** 沒聯絡上的常見原因 */
export const CALLOUT_FAIL_REASONS = ['電話沒人接', '忙線中', '不在單位', '開刀中']
/** 要升級了沒：沒聯絡上的次數到門檻 */
export const calloutEscalated = (r: Pick<LabReport, 'calloutAttempts'>) => (r.calloutAttempts?.length ?? 0) >= CALLOUT_ESCALATE_AFTER
/** 這次要通報誰（畫面提示）：住院—病房護理師或主治，升級後只能主治；門診—開立醫師，升級後同科其他醫師 */
export function calloutTarget(source: 'opd' | 'ipd', escalated: boolean, x: { attendingName?: string; doctorName: string; onCallName?: string }): string {
  // 下班時間住院：主治不在，找這一科的值班醫師
  if (source === 'ipd' && x.onCallName) return escalated ? `已 ${CALLOUT_ESCALATE_AFTER} 次沒聯絡上：改通報值班醫師 ${x.onCallName}` : `住院（下班時間）：通報病房護理師或值班醫師 ${x.onCallName}${x.attendingName ? `（主治 ${x.attendingName}）` : ''}`
  if (source === 'ipd') return escalated ? `已 ${CALLOUT_ESCALATE_AFTER} 次沒聯絡上：改通報主治醫師${x.attendingName ? ` ${x.attendingName}` : ''}` : `住院：通報病房護理師或主治醫師${x.attendingName ? ` ${x.attendingName}` : ''}`
  return escalated ? `開立醫師 ${x.doctorName} 已 ${CALLOUT_ESCALATE_AFTER} 次沒聯絡上：改通報同科其他醫師` : `門診：通報開立醫師 ${x.doctorName}`
}
/** 沒聯絡上的欄位：打給誰（姓名、職稱）；門診只能打給醫師 */
export function checkCalloutAttempt(x: { to?: string; toRole?: string }, source: 'opd' | 'ipd'): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.to?.trim()) e.to = '請寫打給誰'
  if (x.toRole !== 'nurse' && x.toRole !== 'doctor') e.toRole = '請選職稱'
  else if (source === 'opd' && x.toRole !== 'doctor') e.toRole = '門診危急值要通報醫師'
  return e
}
/** 危急值從什麼時候開始要通報：第一版就有危急值＝發出時間；更正後才變危急值＝那次更正的時間 */
export function criticalSince(r: R): string | undefined {
  if (!r.values.some((v) => v.critical)) return undefined
  const versions = [...(r.corrections ?? []).map((c) => ({ at: c.at, before: c.before }))]
  // 第一版的值：有更正的話是第一次更正前的值
  const first = versions.length ? versions[0].before : r.values
  if (first.some((v) => v.critical)) return r.reportedAt
  // 找出最早讓目前變成危急值的那次更正（之後各版都是危急值）
  let since = r.reportedAt
  for (let i = 0; i < versions.length; i++) {
    const after = i + 1 < versions.length ? versions[i + 1].before : r.values
    const before = versions[i].before
    if (after.some((v) => v.critical) && !before.some((v) => v.critical)) since = versions[i].at
  }
  return since
}

/** 通報狀態：none 沒有危急值；done 已通報（ontime 是否在時限內）；late 逾時還沒通報；pending 時限內還沒通報 */
/** 這個檢驗醫令的通報時限：主檔有設（檢驗時限設定）就用主檔，沒有用預設 30 分鐘 */
export const calloutLimitOf = (lim: LabLimits | undefined) => lim?.callout ?? CALLOUT_MINUTES

export function calloutStatus(r: R, now: string, minutes: number = CALLOUT_MINUTES): { status: 'none' | 'done' | 'late' | 'pending'; due?: string; ontime?: boolean } {
  const since = criticalSince(r)
  if (!since) return { status: 'none' }
  const due = addMinutes(since, minutes)
  if (r.callout) return { status: 'done', due, ontime: r.callout.at <= due }
  return { status: now > due ? 'late' : 'pending', due }
}

/** 通報時效達成率：已到期（或已通報）的危急值報告裡，在時限內通報的比例 */
export function calloutRate<T extends R>(rs: T[], now: string, minutesOf: (r: T) => number = () => CALLOUT_MINUTES): { total: number; ontime: number; pct: number } {
  const xs = rs.map((r) => calloutStatus(r, now, minutesOf(r))).filter((x) => x.status === 'done' || x.status === 'late')
  const ontime = xs.filter((x) => x.ontime).length
  return { total: xs.length, ontime, pct: xs.length ? Math.round((ontime / xs.length) * 100) : 100 }
}

/**
 * 通報欄位檢查：受話者姓名、職稱、複誦（住院可選護理師或醫師；門診只有醫師）。
 * 升級後（連續兩次沒聯絡上）：住院只能通報醫師（主治）；門診不能再是開立醫師（同科其他醫師）
 */
export function checkCallout(x: { to?: string; toRole?: string; readBack?: boolean }, source: 'opd' | 'ipd', esc?: { escalated: boolean; orderingDoctor?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.to?.trim()) e.to = '請寫受話者姓名'
  else if (esc?.escalated && source === 'opd' && esc.orderingDoctor && x.to.trim() === esc.orderingDoctor) e.to = `開立醫師已 ${CALLOUT_ESCALATE_AFTER} 次沒聯絡上，請改通報同科其他醫師`
  if (x.toRole !== 'nurse' && x.toRole !== 'doctor') e.toRole = '請選受話者職稱'
  else if (source === 'opd' && x.toRole !== 'doctor') e.toRole = '門診危急值要通報開立醫師'
  else if (esc?.escalated && x.toRole !== 'doctor') e.toRole = `已 ${CALLOUT_ESCALATE_AFTER} 次沒聯絡上，要改通報主治醫師`
  if (!x.readBack) e.readBack = '要請對方複誦病人姓名、項目與數值，並確認無誤'
  return e
}
