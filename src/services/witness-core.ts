// 第二人確認（見證）的共用核心——內部模組，不經 index 匯出成 API。
// 用在：優免主管核准（charge.approveDiscount）、管制藥點班見證（witness.approveWitness wardCount）、報廢覆核（scrap）。
//
// 規則（三種用途都一樣）：
// - 第二人當場輸入**自己的**帳號密碼；不能是自己、帳號要啟用中、要符合該用途的資格（由呼叫端給 qualifies）
// - 確認是**一次性的**，綁定「用途 + 對象（refId）+ 發起的人」，有效 WITNESS_MIN 分鐘，正式作業成功時用掉
// - 存在記憶體（不進資料庫）：重新整理頁面就要重新確認，一張確認不會被拿去別處用
// - 失敗**回傳** { ok:false }（不丟錯）：mutate 丟錯會回滾整筆，連「確認失敗」的稽核也不見
import type { User } from '@/types'
import { db, newId } from '@/mock/db'
import { audit, fieldErrors } from './http'

export type WitnessPurpose = 'discount' | 'wardCount' | 'scrap'
export const WITNESS_MIN = 10

export interface WitnessGrant {
  purpose: WitnessPurpose
  refId: string
  actorId: string
  witnessId: string
  witnessName: string
  at: number
}
const grants = new Map<string, WitnessGrant>()

export type WitnessResult = { ok: true; token: string; witnessName: string } | { ok: false; field: 'username' | 'password'; message: string }

/**
 * 第二人確認（需在 mutate 裡呼叫）。
 * @param who 畫面上怎麼稱呼第二人（主管、見證護理師、覆核藥師）——用在「請輸入○○帳號」
 * @param qualifies 資格檢查：回傳錯誤訊息（不符）或 null（符合）
 * @param auditAction 成功的稽核動作名稱；失敗的是「○○失敗」
 * @param what 稽核內容：確認的是什麼
 */
export function grantWitness(opts: {
  purpose: WitnessPurpose
  refId: string
  actor: { id: string; name: string }
  username: string
  password: string
  who: string
  selfMessage: string
  qualifies: (u: User) => string | null
  auditAction: string
  /** 稽核的動詞：核准、見證、覆核 */
  verb: string
  what: string
}): WitnessResult {
  const username = (opts.username ?? '').trim().toLowerCase()
  const f = fieldErrors()
  if (!username) f.add('username', `請輸入${opts.who}帳號`)
  if (!opts.password) f.add('password', '請輸入密碼')
  f.done()
  const no = (field: 'username' | 'password', message: string): WitnessResult => {
    audit(`${opts.auditAction}失敗`, `${username}：${message}；${opts.what}`)
    return { ok: false, field, message }
  }
  const u = db.users.find((x) => x.username === username)
  if (!u || u.password !== opts.password) return no('password', '帳號或密碼錯誤')
  if (!u.active) return no('username', '此帳號已停用')
  if (u.id === opts.actor.id) return no('username', opts.selfMessage)
  const why = opts.qualifies(u)
  if (why) return no('username', why)
  const token = newId('WIT')
  grants.set(token, { purpose: opts.purpose, refId: opts.refId, actorId: opts.actor.id, witnessId: u.id, witnessName: u.name, at: Date.now() })
  audit(opts.auditAction, `${u.name} ${opts.verb} ${opts.what}`)
  return { ok: true, token, witnessName: u.name }
}

/** 正式作業時檢查確認：同用途、同對象、同一位發起人、還沒過期。沒有／不符 → null；過期 → 'expired' */
export function witnessFor(token: string | undefined, purpose: WitnessPurpose, refId: string, actorId: string): WitnessGrant | null | 'expired' {
  const g = token ? grants.get(token) : undefined
  if (!g || g.purpose !== purpose || g.refId !== refId || g.actorId !== actorId) return null
  if (Date.now() - g.at > WITNESS_MIN * 60_000) return 'expired'
  return g
}

/** 一次性：正式作業成功時用掉（呼叫端在 mutate 的最後呼叫，失敗回滾時確認還留著可重送） */
export function consumeWitness(token: string | undefined): void {
  if (token) grants.delete(token)
}

/** 報廢確認綁定的對象：某藥在某地點的過期批號；待報廢區的一個批號 */
export const expiredScrapRef = (drugId: string, locationId: string) => `E|${drugId}|${locationId}`
export const quarantineScrapRef = (lotId: string) => `Q|${lotId}`

/** 資格：帳號任一角色符合（第二人用的是帳號，不是某個分頁的作業角色） */
export const hasRole = (u: User, roles: User['roles'][number][]) => u.roles.some((r) => roles.includes(r))
