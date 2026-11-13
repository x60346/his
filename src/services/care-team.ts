// 誰能寫這位住院病人（醫囑、病程紀錄、出院病摘）——服務層內部模組，不經 index 匯出成 API。
// 以前只靠住院頁「只列我是主治的病人」：任何醫師直接呼叫 API 都能替任何病人開醫囑、寫出院病摘。
//
//   - 本科（team）：病人目前科別的醫師——主治，或同科醫師（值班、代理：主治下班後也要有人能開醫囑）
//   - 會診醫師（consult）：被會診的那一科（有指定醫師時只有他），會診單待回覆期間到回覆後 CONSULT_ORDER_HOURS 小時內；
//     可以開新醫囑、寫病程紀錄，只能修改或停止自己開的醫囑，不能寫出院病摘、准予出院
//   - 其他醫師：不能寫
import type { Admission, Consult } from '@/types'
import { db } from '@/mock/db'
import { now } from '@/utils/date'
import { fail } from './http'
import { find, nameOf } from './views'

/** 會診回覆後，會診醫師還能開醫囑的時間（小時） */
export const CONSULT_ORDER_HOURS = 72

export type CareRole = { kind: 'team' } | { kind: 'consult'; consult: Consult }

const hoursBetween = (from: string, to: string) => (Date.parse(to.replace(' ', 'T')) - Date.parse(from.replace(' ', 'T'))) / 3_600_000

/** 這張會診單現在讓這位醫師能不能寫（範圍內） */
export function consultOpenFor(c: Consult, doctorId: string, at = now()): boolean {
  const d = find.doctor(doctorId)
  if (!d || c.toDeptId !== d.deptId) return false
  if (c.status === 'pending') return !c.toDoctorId || c.toDoctorId === d.id
  return c.status === 'answered' && c.answeredBy === d.id && !!c.answeredAt && hoursBetween(c.answeredAt, at) <= CONSULT_ORDER_HOURS
}

/** 這位醫師對這位病人的身分；都不是＝null */
export function careRoleOf(doctorId: string | undefined, a: Admission, at = now()): CareRole | null {
  const d = doctorId ? find.doctor(doctorId) : undefined
  if (!d) return null
  if (a.doctorId === d.id || a.deptId === d.deptId) return { kind: 'team' }
  const c = db.consults.filter((x) => x.admissionId === a.id && consultOpenFor(x, d.id, at)).sort((p, q) => q.requestedAt.localeCompare(p.requestedAt))[0]
  return c ? { kind: 'consult', consult: c } : null
}

/**
 * 寫之前檢查。what：「開醫囑」「寫病程紀錄」…（錯誤訊息用）；consult：會診醫師可不可以做這件事
 */
export function requireCare(doctorId: string | undefined, a: Admission, what: string, opts: { consult: boolean }): CareRole {
  const role = careRoleOf(doctorId, a)
  if (!role) fail(`只有${nameOf.dept(a.deptId)}的醫師（主治、值班代理）或會診醫師可以${what}`, 'FORBIDDEN')
  if (role!.kind === 'consult' && !opts.consult) fail(`會診醫師不能${what}，請由${nameOf.dept(a.deptId)}的醫師處理`, 'FORBIDDEN')
  return role!
}
