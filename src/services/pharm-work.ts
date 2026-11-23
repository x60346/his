// 藥師審核的內部工具（index 不匯出）：新醫囑送審、系統替藥師列出的問題（過敏、交互作用與重複、劑量、腎功能、
// 管制性抗生素狀態）、待辦數、醫囑停止或修改時把疑義結案。住院醫囑、住院藥局、護理站、首頁共用。規則在 pharm-rules
import type { IpdOrder, PharmReview } from '@/types'
import { db } from '@/mock/db'
import { checkAllergies } from './allergy'
import { checkRxAlerts, RX_ALERT_KIND_LABEL } from './interaction-rules'
import { drugRefs, ipdInUse } from './rx-alert-work'
import { doseLevel, doseNote } from './dose-rules'
import { renalAlertOf, renalOf } from './renal-work'
import { openPharmQuery } from './pharm-rules'
import { find } from './views'

export const newPharm = (t: string): PharmReview => ({ status: 'pending', at: t })

export interface PharmIssue {
  level: 'severe' | 'caution'
  /** 過敏、交互作用、成分重複、同類重複、同藥重複、劑量、腎功能、管制性抗生素 */
  kind: string
  text: string
}

/** 系統替藥師列出這筆醫囑的問題（嚴重的在前）；醫師開立時已確認過的交互作用也照列，附醫師的理由 */
export function pharmIssuesOf(o: IpdOrder): PharmIssue[] {
  const d = find.drug(o.drugId ?? '')
  const a = find.admission(o.admissionId)
  if (!d || !a) return []
  const out: PharmIssue[] = []
  const p = find.patient(a.patientId)
  for (const w of checkAllergies(p?.allergies ?? [], [d])) out.push({ level: 'severe', kind: '過敏', text: `病人對「${w.allergen}」過敏，${d.name} 可能有交叉過敏${o.allergyOverride?.includes(w.allergen) ? '（醫師開立時已確認評估過）' : ''}` })
  const confirmed = new Map((o.rxAlerts ?? []).map((r) => [r.key, r]))
  for (const r of checkRxAlerts(drugRefs([d.id]), ipdInUse(a.id, d.id, o.id))) {
    const c = confirmed.get(r.key)
    out.push({ level: r.level === 'severe' ? 'severe' : 'caution', kind: RX_ALERT_KIND_LABEL[r.kind], text: `${r.title}：${r.text}${c?.reason ? `（醫師開立時確認：${c.reason}）` : c ? '（醫師開立時已確認）' : ''}` })
  }
  const same = db.ipdOrders.filter((x) => x.id !== o.id && x.admissionId === a.id && x.drugId === d.id && x.status === 'active')
  if (same.length) out.push({ level: 'caution', kind: '同藥重複', text: `另有 ${same.length} 筆執行中的 ${d.name}` })
  const lv = o.dose ? doseLevel(d, o.dose) : 'ok'
  if (lv === 'high' || lv === 'absurd') out.push({ level: lv === 'absurd' ? 'severe' : 'caution', kind: '劑量', text: doseNote(d, o.dose!) })
  const r = renalAlertOf(o)
  if (r) out.push({ level: r.includes('停用') ? 'severe' : 'caution', kind: '腎功能', text: r })
  // 要依腎功能調整的藥、但算不出 CrCl：不能說「腎功能沒問題」，列出來請藥師確認（例：建議抽肌酸酐）
  else if (d.renal?.length && o.category === 'medication') {
    const ri = renalOf(o.admissionId)
    if (ri.crcl === null && ri.text) out.push({ level: 'caution', kind: '腎功能', text: `要依腎功能調整劑量，但 ${ri.text}（請確認，或建議抽血）` })
  }
  if (o.abx?.status === 'rejected') out.push({ level: 'caution', kind: '管制性抗生素', text: '感染科審核未通過' })
  else if (o.abx?.status === 'pending') out.push({ level: 'caution', kind: '管制性抗生素', text: '待感染科審核（先用後審）' })
  return out.sort((x, y) => Number(x.level === 'caution') - Number(y.level === 'caution'))
}

/** 還要審的：執行中的，或已執行完的臨時醫囑（先給後審：給完醫囑就完成了，仍要補審） */
const reviewableNow = (o: IpdOrder) => o.status === 'active' || (o.type === 'stat' && o.status === 'done')
const admittedOrder = (o: IpdOrder) => reviewableNow(o) && o.category === 'medication' && find.admission(o.admissionId)?.status === 'admitted'

/** 藥師待審（不含疑義等醫師回覆的） */
export const pharmPending = () => db.ipdOrders.filter((o) => admittedOrder(o) && o.pharm?.status === 'pending')
/** 疑義等醫師回覆：給 doctorId 就只算他的病人 */
export const pharmQueried = (doctorId?: string) =>
  db.ipdOrders.filter((o) => admittedOrder(o) && o.pharm?.status === 'query' && (!doctorId || find.admission(o.admissionId)?.doctorId === doctorId))

/** 醫囑停止或修改：還沒回覆的藥師疑義結案（修改的新醫囑會重新送審） */
export function settlePharmOnChange(o: IpdOrder, how: 'stopped' | 'modified', by: string, t: string): void {
  const q = openPharmQuery(o.pharm)
  if (q) Object.assign(q, { replyBy: by, replyAt: t, reply: how === 'stopped' ? '已停止此醫囑' : '已修改醫囑（新醫囑重新送審）', resolution: how })
}
