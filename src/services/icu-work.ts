// 加護病房的內部工具（index 不匯出、不會被包成 API）：病人是不是住在加護病房、從什麼時候、流程表最後一筆、
// 漏記待辦、某段時間的輸入輸出量。規則在 icu-rules
import type { Admission, VitalRecord } from '@/types'
import { db } from '@/mock/db'
import { find } from './views'
import { isIcuBed } from './bed-work'
import { hourlyState } from './icu-rules'
import { infusedIn } from './infusion-work'

/** 住院中、目前的床在加護病房 */
export const inIcu = (a: Pick<Admission, 'status' | 'bedId'>) => a.status === 'admitted' && isIcuBed(find.bed(a.bedId ?? ''))

/** 這次住進加護病房的時間：床位紀錄從最後往前，連續住在加護病房的最早那段（加護病房內換床不算重新轉入） */
export function icuSince(a: Admission): string | undefined {
  if (!inIcu(a)) return undefined
  const hist = a.bedHistory ?? []
  if (!hist.length) return a.admittedAt
  let since: string | undefined
  for (let i = hist.length - 1; i >= 0 && isIcuBed(find.bed(hist[i].bedId)); i--) since = hist[i].from
  return since ?? a.admittedAt
}

/** 流程表（每小時）的紀錄，依時間排好 */
export const hourlyOf = (admissionId: string): VitalRecord[] => db.vitals.filter((v) => v.admissionId === admissionId && v.hourly).sort((x, y) => x.at.localeCompare(y.at))

/** 加護病房病人流程表多久沒記（不在加護病房回 undefined） */
export function icuHourly(a: Admission, t: string) {
  const since = icuSince(a)
  if (!since) return undefined
  const last = hourlyOf(a.id).filter((v) => v.at >= since).pop()
  return { since, last, ...hourlyState(last?.at, since, t) }
}

export interface IcuTodo { admissionId: string; at: string; minutes: number; text: string }
export function icuTodosOf(a: Admission, t: string): IcuTodo[] {
  const h = icuHourly(a, t)
  return h?.late ? [{ admissionId: a.id, at: h.dueAt, minutes: h.minutes, text: `重症流程表 ${h.minutes} 分鐘沒記（每小時一筆）` }] : []
}

/** 加護病房流程表漏記的病人數（護理師首頁） */
export const icuLateCount = (t: string) => db.admissions.filter((a) => a.status === 'admitted').filter((a) => !!icuHourly(a, t)?.late).length

/**
 * 某段時間 [from, to) 的輸入輸出：護理師記的輸入量、點滴（依流速自動算）、管灌、輸出量。
 * 點滴不用護理師再記一次（記了會重複算）
 */
export function ioBetween(admissionId: string, from: string, to: string, t: string) {
  const vs = db.vitals.filter((v) => v.admissionId === admissionId && v.at >= from && v.at < to)
  const manual = vs.reduce((n, v) => n + (v.intake ?? 0), 0)
  const iv = Math.round(infusedIn(admissionId, from, to, t))
  const tube = db.tubeFeeds.filter((r) => r.admissionId === admissionId && r.at >= from && r.at < to).reduce((n, r) => n + r.givenMl, 0)
  const output = vs.reduce((n, v) => n + (v.output ?? 0), 0)
  const intake = manual + iv + tube
  return { manual, iv, tube, intake, output, balance: intake - output }
}
