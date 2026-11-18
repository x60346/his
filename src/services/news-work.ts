// 早期預警與快速反應的內部工具（index 不匯出、不會被包成 API）：病人最近的 NEWS2、再量到期、自動呼叫快速反應小組、
// 醫師首頁的警示數。規則在 news-rules
//
// 只看一般病房：加護病房的病人每小時有重症流程表、有 SOFA，NEWS2 的「通知、再量」在那裡沒有意義
import type { Admission, RrtCall, VitalRecord } from '@/types'
import { db, newId } from '@/mock/db'
import { addMinutes, parseDate } from '@/utils/date'
import { inIcu } from './icu-work'
import { careRoleOf } from './care-team'
import { openRequest } from './icu-move-work'
import { isNews, newsRecheckDue, newsScore, type NewsResult } from './news-rules'

/** 兩個時間差幾分鐘 */
export const minutesBetween = (from: string, to: string) => Math.round((parseDate(to).getTime() - parseDate(from).getTime()) / 60000)

export type ScoredVital = { v: VitalRecord; news: NewsResult }
/** 這筆住院算得出 NEWS2 的生命徵象（時間順序；同一分鐘的照寫入順序） */
export function scoredVitals(admissionId: string): ScoredVital[] {
  return db.vitals
    .map((v, i) => ({ v, i }))
    .filter((x) => x.v.admissionId === admissionId && !x.v.hourly)
    .sort((x, y) => x.v.at.localeCompare(y.v.at) || x.i - y.i)
    .map(({ v }) => ({ v, news: newsScore(v) }))
    .filter((x): x is ScoredVital => isNews(x.news))
}

export interface NewsState {
  last: ScoredVital
  /** 中、高：1 小時內再量（下一筆算得出分數的才算再量） */
  recheck?: { dueAt: string; status: 'upcoming' | 'overdue' }
}
/** 一般病房病人目前的 NEWS2（加護病房的不算；沒有算得出分數的紀錄＝undefined） */
export function newsStateOf(a: Admission, t: string): NewsState | undefined {
  if (a.status !== 'admitted' || inIcu(a)) return undefined
  const last = scoredVitals(a.id).pop()
  if (!last) return undefined
  const due = newsRecheckDue(last.v.at, last.news.level)
  return { last, ...(due ? { recheck: { dueAt: due, status: t > due ? 'overdue' : 'upcoming' } } : {}) }
}

/** 還沒評估的呼叫 */
export const openRrt = (admissionId: string) => db.rrtCalls.find((c) => c.admissionId === admissionId && c.status === 'pending')

/**
 * 記完一筆生命徵象：NEWS2 ≥7 自動呼叫快速反應小組。
 * 已經有一筆在等（同一件事不重複叫），或已經有轉入加護病房的申請在走（加護病房團隊已經知道）就不叫
 */
export function autoCallRrt(a: Admission, v: VitalRecord, t: string): RrtCall | undefined {
  if (inIcu(a)) return undefined
  const s = newsScore(v)
  if (!isNews(s) || s.level !== 'high') return undefined
  if (openRrt(a.id) || openRequest(a.id)) return undefined
  const c: RrtCall = { id: newId('RRT'), admissionId: a.id, trigger: 'auto', vitalId: v.id, score: s.total, calledBy: v.nurseId, calledAt: t, status: 'pending' }
  db.rrtCalls.push(c)
  return c
}

/** 主治首頁：自己照顧（主治、照護團隊；會診不算）的一般病房病人，最近一次 NEWS2 中或高 */
export function newsAlertCount(doctorId: string, t: string): number {
  return db.admissions.filter((a) => a.status === 'admitted' && (careRoleOf(doctorId, a)?.kind ?? 'consult') !== 'consult').filter((a) => {
    const s = newsStateOf(a, t)
    return !!s && s.last.news.level !== 'low'
  }).length
}

/** 快速反應小組的品質指標：最近 days 天的呼叫次數、平均幾分鐘到場評估、轉加護病房的比例 */
export function rrtStats(t: string, days = 30) {
  const from = addMinutes(t, -days * 24 * 60)
  const cs = db.rrtCalls.filter((c) => c.calledAt >= from && c.calledAt <= t)
  const done = cs.filter((c) => c.status === 'done' && c.assessedAt)
  const mins = done.map((c) => minutesBetween(c.calledAt, c.assessedAt!))
  return {
    days,
    calls: cs.length,
    auto: cs.filter((c) => c.trigger === 'auto').length,
    avgResponseMin: mins.length ? Math.round(mins.reduce((n, x) => n + x, 0) / mins.length) : null,
    toIcu: done.filter((c) => c.disposition === 'icu').length,
    done: done.length,
  }
}
