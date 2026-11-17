// 輸血備血（純函式）：血品、ABO／Rh 相容、輸血門檻、血袋效期、備血單狀態、發血後的時限、輸血中的生命徵象、輸血反應。
// 開立（醫師）、配血發血（血庫）、床邊輸血（護理師）、首頁待辦、住院帳單都用這一份
import type { Abo, BloodIssue, BloodProduct, BloodRequest, BloodUnit, Rh } from '@/types'
import { addMinutes } from '@/utils/date'

export const BLOOD_PRODUCT_LABEL: Record<BloodProduct, string> = { rbc: '紅血球濃厚液', ffp: '新鮮冷凍血漿', plt: '血小板（分離術）' }
export const BLOOD_PRODUCT_SHORT: Record<BloodProduct, string> = { rbc: 'RBC', ffp: 'FFP', plt: 'PLT' }
export const BLOOD_PRODUCTS = Object.keys(BLOOD_PRODUCT_LABEL) as BloodProduct[]
export const ABO_TYPES: Abo[] = ['O', 'A', 'B', 'AB']
/** 一袋的量（ml）與效期（天）：入庫時的預設值 */
export const BLOOD_DEFAULTS: Record<BloodProduct, { volume: number; days: number }> = { rbc: { volume: 250, days: 35 }, ffp: { volume: 200, days: 365 }, plt: { volume: 250, days: 5 } }
/** 一張備血單最多幾單位 */
export const BLOOD_MAX_UNITS: Record<BloodProduct, number> = { rbc: 4, ffp: 8, plt: 2 }

/**
 * 輸血門檻：檢驗值高於門檻（或 72 小時內沒有這項檢驗）時要寫理由才能開——只提醒、不擋。
 * 新鮮冷凍血漿要看凝血功能，展示系統沒有這項檢驗，只寫適應症
 */
export const BLOOD_THRESHOLD: Partial<Record<BloodProduct, { code: string; name: string; max: number; unit: string }>> = {
  rbc: { code: 'Hb', name: '血色素', max: 8, unit: 'g/dL' },
  plt: { code: 'PLT', name: '血小板', max: 50, unit: '10³/µL' },
}
export const BLOOD_LAB_FRESH_HOURS = 72
export const BLOOD_INDICATIONS: Record<BloodProduct, string[]> = {
  rbc: ['貧血，Hb < 8 g/dL', '急性出血', '手術中失血', '心肺疾病病人 Hb < 10 g/dL'],
  ffp: ['凝血功能異常且有出血', '大量輸血', '侵入性處置前矯正凝血功能'],
  plt: ['血小板 < 10，預防出血', '血小板 < 50 且有出血', '侵入性處置前（血小板 < 50）'],
}

export const bloodTypeText = (x: { abo: Abo; rh: Rh }) => `${x.abo}${x.rh === '+' ? ' Rh+' : ' Rh−'}`

/**
 * 相容：
 * - 紅血球（看病人的抗體）：O 給所有人、A 給 A／AB、B 給 B／AB、AB 只給 AB；Rh− 的病人只能輸 Rh− 的紅血球
 * - 血漿、血小板（看血袋裡的抗體）：反過來，AB 給所有人、A 給 A／O、B 給 B／O、O 只給 O；Rh 不限（展示簡化）
 */
export function bloodCompatible(product: BloodProduct, patient: { abo: Abo; rh: Rh }, unit: { abo: Abo; rh: Rh }): { ok: boolean; message?: string } {
  const has = (t: Abo, ag: 'A' | 'B') => t.includes(ag)
  const cells = product === 'rbc'
  // 紅血球：血袋的抗原，病人都要有；血漿：病人的抗原，血袋都要有（血袋裡才不會有對應的抗體）
  const [donorAg, recipAg] = cells ? [unit.abo, patient.abo] : [patient.abo, unit.abo]
  const okAbo = (['A', 'B'] as const).every((ag) => !has(donorAg, ag) || has(recipAg, ag))
  if (!okAbo) return { ok: false, message: `ABO 不相容：病人 ${patient.abo} 型不能輸 ${unit.abo} 型的${BLOOD_PRODUCT_LABEL[product]}` }
  if (cells && patient.rh === '-' && unit.rh === '+') return { ok: false, message: '病人是 Rh 陰性，不能輸 Rh 陽性的紅血球' }
  return { ok: true }
}

/** 血袋過期（效期當天還能用） */
export const unitExpired = (u: Pick<BloodUnit, 'expiresOn'>, today: string) => u.expiresOn < today

/** 開立時的門檻判斷：回傳要寫理由的原因（空字串＝不用寫） */
export function thresholdProblem(product: BloodProduct, lab: { value: string; at: string } | undefined, now: string): string {
  const th = BLOOD_THRESHOLD[product]
  if (!th) return ''
  if (!lab || lab.at < addMinutes(now, -BLOOD_LAB_FRESH_HOURS * 60)) return `${BLOOD_LAB_FRESH_HOURS} 小時內沒有${th.name}（${th.code}）的檢驗結果`
  const v = Number(lab.value)
  if (Number.isFinite(v) && v > th.max) return `${th.name} ${lab.value} ${th.unit}，高於輸血門檻 ${th.max}`
  return ''
}

/** 發血後多久內可以退回血庫（超過就不能再發給別人用） */
export const BLOOD_RETURN_MIN = 30
/** 發血後多久要開始輸（超過只提醒） */
export const BLOOD_START_MIN = 30
/** 一袋要在幾小時內輸完 */
export const BLOOD_FINISH_HOURS = 4
/** 開始後第幾分鐘要量生命徵象 */
export const BLOOD_CHECK_MIN = 15

export const REACTION_SYMPTOMS = ['發燒（上升 ≥ 1°C）', '畏寒、發抖', '皮疹、搔癢', '呼吸困難', '低血壓', '胸痛或背痛', '血尿、茶色尿', '其他']

/** 這一袋目前的狀態（最新一次發血） */
export type IssueState = 'issued' | 'transfusing' | 'done' | 'stopped' | 'returned'
export function issueState(i: BloodIssue): IssueState {
  if (i.returned) return 'returned'
  const tr = i.transfusion
  if (!tr) return 'issued'
  if (tr.reaction) return 'stopped'
  return tr.endAt ? 'done' : 'transfusing'
}
export const ISSUE_STATE_LABEL: Record<IssueState | 'reserved', string> = { reserved: '已配血、待發血', issued: '已發血、待輸血', transfusing: '輸血中', done: '已輸完', stopped: '輸血反應、已停止', returned: '已退回血庫' }

/** 一袋最新一次發血（沒有＝還沒發） */
export const latestIssue = (r: Pick<BloodRequest, 'issues'>, unitId: string): BloodIssue | undefined => r.issues.filter((i) => i.unitId === unitId).at(-1)

/**
 * 輸血中要做的事：開始後 15 分鐘量生命徵象（due＝到時間了、overdue＝超過 15 分鐘還沒量）、超過 4 小時還沒結束。
 * 已發血還沒開始的：超過 30 分鐘提醒
 */
export interface IssueTodo {
  check?: 'due' | 'overdue'
  long?: boolean
  lateStart?: boolean
  checkDueAt?: string
}
export function issueTodo(i: BloodIssue, now: string): IssueTodo {
  const s = issueState(i)
  if (s === 'issued') return now > addMinutes(i.issuedAt, BLOOD_START_MIN) ? { lateStart: true } : {}
  if (s !== 'transfusing') return {}
  const tr = i.transfusion!
  const out: IssueTodo = {}
  if (!tr.vitals.some((v) => v.kind === '15min')) {
    const dueAt = addMinutes(tr.startAt, BLOOD_CHECK_MIN)
    out.checkDueAt = dueAt
    if (now >= addMinutes(dueAt, BLOOD_CHECK_MIN)) out.check = 'overdue'
    else if (now >= dueAt) out.check = 'due'
  }
  if (now > addMinutes(tr.startAt, BLOOD_FINISH_HOURS * 60)) out.long = true
  return out
}

/** 備血單狀態（推算）：取消、血庫處理中（還沒驗血型或還沒配滿）、可發血、輸血中、完成 */
export type BloodRequestStatus = 'cancelled' | 'typing' | 'matching' | 'ready' | 'transfusing' | 'done'
export const BLOOD_STATUS_LABEL: Record<BloodRequestStatus, string> = {
  cancelled: '已取消', typing: '待驗血型', matching: '交叉試驗中', ready: '可發血', transfusing: '輸血中', done: '完成',
}
/** 目前配給這張單的血袋（釋出的不算） */
export const activeMatches = (r: Pick<BloodRequest, 'crossmatch'>) => r.crossmatch.filter((c) => !c.released)

export function requestStatus(r: BloodRequest): BloodRequestStatus {
  const live = activeMatches(r)
  const states = live.map((c) => {
    const i = latestIssue(r, c.unitId)
    return i ? issueState(i) : 'reserved'
  })
  if (states.some((s) => s === 'issued' || s === 'transfusing')) return 'transfusing'
  if (r.cancelled) return 'cancelled'
  if (!r.typing) return 'typing'
  if (live.length < r.units) return 'matching'
  if (states.some((s) => s === 'reserved' || s === 'returned')) return 'ready'
  return 'done'
}

/** 開立欄位檢查（欄位 key 對應畫面） */
export function checkBloodInput(x: { product?: string; units?: number; indication?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.product || !(x.product in BLOOD_PRODUCT_LABEL)) e.product = '請選擇血品'
  else {
    const max = BLOOD_MAX_UNITS[x.product as BloodProduct]
    if (!Number.isInteger(x.units) || x.units! < 1 || x.units! > max) e.units = `單位數是 1–${max}`
  }
  if (!x.indication?.trim()) e.indication = '請寫適應症'
  return e
}
