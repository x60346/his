// 交互作用、重複用藥：服務層內部（index 不匯出）——「病人還在吃哪些藥」只在這裡算，
// 門診處方表的即時提醒、完成看診、住院開醫囑都用同一份，規則本身在 interaction-rules（純函式）。
//   - 門診：本院各科已完成看診的處方，依處方天數（慢性病連續處方 × 可調劑次數）還沒吃完的；出院帶藥依出院日算
//   - 住院：這次住院執行中的給藥醫囑
import type { Drug, IpdOrder } from '@/types'
import { db } from '@/mock/db'
import { addDays, diffDays } from '@/utils/date'
import { checkRxAlerts, rxAlertProblems, rxAlertRecords, RX_ALERT_LEVEL_LABEL, type InUseMed, type RxAlert, type RxAlertRecord, type RxDrugRef } from './interaction-rules'
import { fail } from './http'
import { find, nameOf } from './views'

const ref = (d: Pick<Drug, 'id' | 'name' | 'generic'>): RxDrugRef => ({ id: d.id, name: d.name, generic: d.generic })
const md = (date: string) => date.slice(5).replace('-', '/')

/** 門診：病人在 date 這天還在吃的本院藥（不含 excludeEncounterId 這次） */
export function opdInUse(patientId: string, date: string, excludeEncounterId?: string): InUseMed[] {
  const out: InUseMed[] = []
  const push = (drugId: string, source: string, until: string) => {
    const d = find.drug(drugId)
    if (d && until >= date) out.push({ drug: ref(d), source, until, remainDays: diffDays(date, until) + 1 })
  }
  for (const e of db.encounters) {
    if (e.patientId !== patientId || e.id === excludeEncounterId || e.status !== 'completed' || e.date > date) continue
    if (find.visit(e.visitId)?.status === 'cancelled') continue
    const source = `${nameOf.dept(e.deptId)} ${md(e.date)} ${nameOf.doctor(e.doctorId)}`
    for (const m of e.medications) push(m.drugId, source, addDays(e.date, m.days * Math.max(1, e.refillTimes) - 1))
  }
  for (const a of db.admissions) {
    if (a.patientId !== patientId || a.status !== 'discharged' || !a.dischargedAt) continue
    const from = a.dischargedAt.slice(0, 10)
    for (const m of a.dischargeSummary?.meds ?? []) push(m.drugId, `出院帶藥 ${md(from)}`, addDays(from, m.days - 1))
  }
  return out
}

/** 住院：這次住院執行中的給藥醫囑（不含同一種藥——同藥重複開立另有確認；不含 excludeOrderId） */
export function ipdInUse(admissionId: string, drugId: string, excludeOrderId?: string): InUseMed[] {
  return db.ipdOrders
    .filter((o: IpdOrder) => o.admissionId === admissionId && o.category === 'medication' && o.status === 'active' && o.drugId && o.drugId !== drugId && o.id !== excludeOrderId)
    .map((o) => ({ o, d: find.drug(o.drugId!) }))
    .filter((x): x is { o: IpdOrder; d: Drug } => !!x.d)
    .map(({ o, d }) => ({ drug: ref(d), source: `${o.type === 'long' ? '長期' : '臨時'}醫囑 ${md(o.startAt)}` }))
}

export const drugRefs = (drugIds: string[]): RxDrugRef[] => drugIds.map((id) => find.drug(id)).filter((d): d is Drug => !!d).map(ref)

/**
 * 服務層把關：還沒確認的提醒 → CONFLICT（field rxAlerts，畫面列出來請醫師確認後帶 reasons 重送）；
 * 嚴重的沒寫原因 → 欄位錯誤。通過就回傳要存的紀錄（沒有提醒回傳 undefined，不存空陣列）
 */
export function settleRxAlerts(newDrugs: RxDrugRef[], inUse: InUseMed[], reasons: Record<string, string> | undefined): RxAlertRecord[] | undefined {
  const alerts: RxAlert[] = checkRxAlerts(newDrugs, inUse)
  if (!alerts.length) return undefined
  const { missing, needReason } = rxAlertProblems(alerts, reasons)
  if (missing.length) fail(`有 ${missing.length} 則用藥提醒要確認：${missing.map((a) => `【${RX_ALERT_LEVEL_LABEL[a.level]}】${a.title}`).join('；')}`, 'CONFLICT', 'rxAlerts')
  if (needReason.length) fail(`嚴重的交互作用要寫原因才能開：${needReason.map((a) => a.title).join('；')}`, 'BAD_REQUEST', 'rxAlerts')
  return rxAlertRecords(alerts, reasons)
}
