// 譫妄評估與身體約束（純函式）：CAM 判定、誰要每班評、約束醫囑效期（緊急約束 1 小時內補醫囑、每次最長 24 小時）、
// 每 2 小時查核、約束日數。護理站清單、本班待辦、首頁、畫面、服務層、品質指標都用這一份
import type { Restraint } from '@/types'
import { addMinutes } from '@/utils/date'

// ---------- 譫妄（CAM） ----------
export const CAM_ITEMS: { key: 'acute' | 'inattention' | 'disorganized' | 'consciousness'; label: string; hint: string }[] = [
  { key: 'acute', label: '1. 急性發作或病程波動', hint: '和平常比，精神狀態突然改變，或一天之內時好時壞' },
  { key: 'inattention', label: '2. 注意力不集中', hint: '容易分心、無法專注對話（例：倒數月份做不到）' },
  { key: 'disorganized', label: '3. 思考紊亂', hint: '說話沒有條理、前言不對後語、想法跳來跳去' },
  { key: 'consciousness', label: '4. 意識狀態改變', hint: '過度警覺、嗜睡、昏睡或昏迷（不是清醒）' },
]
/** CAM 陽性：1 和 2 都有，再加上 3 或 4 */
export const camPositive = (x: { acute?: boolean; inattention?: boolean; disorganized?: boolean; consciousness?: boolean }) =>
  !!x.acute && !!x.inattention && (!!x.disorganized || !!x.consciousness)
/** 幾歲以上、術後幾小時內要每班評 */
export const DELIRIUM_AGE = 65
export const DELIRIUM_POSTOP_HOURS = 72
/** 為什麼要每班評（不用評回 undefined） */
export function deliriumTarget(age: number, lastSurgeryEnd: string | undefined, now: string): string | undefined {
  if (age >= DELIRIUM_AGE) return `${DELIRIUM_AGE} 歲以上`
  if (lastSurgeryEnd && now <= addMinutes(lastSurgeryEnd, DELIRIUM_POSTOP_HOURS * 60)) return `術後 ${DELIRIUM_POSTOP_HOURS} 小時內`
  return undefined
}

// ---------- 身體約束 ----------
export const RESTRAINT_REASONS = ['自拔管路風險', '跌倒風險（躁動下床）', '躁動可能傷人或自傷', '譫妄混亂']
export const RESTRAINT_SITES = ['左手', '右手', '左腳', '右腳', '軀幹']
export const RESTRAINT_METHODS = ['約束帶', '約束手套', '約束背心']
export const RESTRAINT_END_REASONS = ['已不需要（意識清楚、配合）', '改用替代措施（家屬陪伴、移除管路）', '醫囑到期未續', '出院', '其他']
/** 每次醫囑最長幾小時；緊急約束幾分鐘內要補醫囑；每幾分鐘查一次 */
export const RESTRAINT_ORDER_HOURS = 24
export const RESTRAINT_EMERGENCY_MIN = 60
export const RESTRAINT_CHECK_MIN = 120

export interface RestraintState {
  active: boolean
  /** 醫囑：ok 有效、pending 緊急約束等補醫囑（1 小時內）、missing 緊急約束超過 1 小時沒補、expired 醫囑到期沒續 */
  order: 'ok' | 'pending' | 'missing' | 'expired'
  orderUntil?: string
  /** 下次查核：時間與狀態（到期前 15 分鐘起 due，過了 overdue） */
  checkDueAt: string
  check: 'ok' | 'due' | 'overdue'
  hours: number
}

export function restraintState(r: Pick<Restraint, 'startedAt' | 'emergency' | 'orders' | 'checks' | 'endedAt'>, now: string): RestraintState {
  const active = !r.endedAt
  const until = r.orders.map((o) => o.until).sort().at(-1)
  const order: RestraintState['order'] = until ? (until >= now ? 'ok' : 'expired') : now <= addMinutes(r.startedAt, RESTRAINT_EMERGENCY_MIN) ? 'pending' : 'missing'
  const last = r.checks.map((c) => c.at).sort().at(-1) ?? r.startedAt
  const checkDueAt = addMinutes(last, RESTRAINT_CHECK_MIN)
  const check: RestraintState['check'] = !active ? 'ok' : now > checkDueAt ? 'overdue' : now >= addMinutes(checkDueAt, -15) ? 'due' : 'ok'
  const hours = Math.floor((Date.parse((r.endedAt ?? now).replace(' ', 'T')) - Date.parse(r.startedAt.replace(' ', 'T'))) / 3600000)
  return { active, order, ...(until ? { orderUntil: until } : {}), checkDueAt, check, hours: Math.max(0, hours) }
}

export function checkRestraintInput(x: { reason?: string; sites?: string[]; method?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.reason?.trim()) e.reason = '請寫約束原因'
  if (!x.sites?.length || x.sites.some((s) => !RESTRAINT_SITES.includes(s))) e.sites = '請選約束部位'
  if (!RESTRAINT_METHODS.includes(x.method ?? '')) e.method = '請選約束方式'
  return e
}
