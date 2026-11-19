// 發檢驗報告的內部共用（index 不匯出，不會被包成 API）：人工登打（lab.reportLab）、儀器自動審核與醫檢師審核（analyzer.ts）共用同一條路——
// 這筆待檢驗是誰的、能不能發（採檢、收件、批價）、品管、欄位檢查、單號、稽核
import type { LabReport } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failFields, must } from './http'
import { find } from './views'
import { buildLabValues } from './lab-rules'
import { awaitingReceipt } from './specimen'
import { qcBlockers } from './qc-rules'
import { opdSpecimenOf, specimenOfOrder } from './specimen-work'
import { procItems, reportedIpd, reportedOpd } from './lab-work'

export function nextLabNo(at: string): string {
  const day = at.slice(0, 10).replace(/-/g, '')
  const key = `lab:${day}`
  db.counters[key] = (db.counters[key] ?? 0) + 1
  return `L${day}${String(db.counters[key]).padStart(4, '0')}`
}

/** 這筆待檢驗是誰的（門診看診的醫令、住院的臨時醫囑）：檢查能不能發報告。發報告、發培養報告共用 */
export function labTarget(key: string): Pick<LabReport, 'patientId' | 'procId' | 'doctorId' | 'orderedAt' | 'encounterId' | 'orderId' | 'admissionId'> {
    const [kind, a, b] = (key ?? '').split(':')
    let base: Pick<LabReport, 'patientId' | 'procId' | 'doctorId' | 'orderedAt' | 'encounterId' | 'orderId' | 'admissionId'>
    if (kind === 'E') {
      const e = must(db.encounters.find((x) => x.id === a), '病歷')
      const x = e.procedures.find((p) => p.procId === b)
      if (!x) fail('這次看診沒有這項檢驗，請重新整理', 'CONFLICT')
      if (x!.notDone) fail('櫃台已標「未執行」（病人沒做），不能發報告', 'CONFLICT')
      const v = find.visit(e.visitId)
      // 急診：醫師送出就能做（床邊採檢、離院結帳），不用先批價
      if (v?.er) {
        if (v.status === 'cancelled') fail('急診已退掛，不能發報告', 'CONFLICT')
        if (!x!.orderedAt && e.status !== 'completed') fail('醫師還沒送出這項檢驗', 'CONFLICT')
      } else if (v?.status !== 'charged' && v?.status !== 'dispensed') fail('病人還沒批價，請先到批價櫃台', 'CONFLICT')
      if (reportedOpd(e.id, b)) fail('這項已經發過報告了；要改請用「更正」', 'CONFLICT')
      if (x!.addon?.selfPay && !x!.addon.chargeId) fail('門診加做（自費）還沒到批價補繳，繳完才能發報告', 'CONFLICT')
      const sp = opdSpecimenOf(key)
      if (!sp?.collectedAt) fail(v?.er ? '急診護理師還沒床邊採檢，不能發報告' : '病人還沒在抽血櫃台採檢（或還沒交回檢體），不能發報告', 'CONFLICT')
      if (!sp!.receivedAt) fail(`檢體還沒收件（條碼 ${sp!.barcode}），請先在「待收件」掃條碼收件`, 'CONFLICT')
      base = { patientId: e.patientId, procId: b, doctorId: e.doctorId, orderedAt: x!.orderedAt ?? e.completedAt ?? e.date, encounterId: e.id }
    } else if (kind === 'O') {
      const o = must(db.ipdOrders.find((x) => x.id === a), '醫囑')
      if (o.category !== 'procedure' || !o.procId) fail('這不是檢驗醫囑')
      if (o.status === 'active') fail('護理師還沒採檢（臨時醫囑還沒執行），不能發報告', 'CONFLICT')
      if (o.status === 'stopped') fail('醫囑已停止，不能發報告', 'CONFLICT')
      const waitSp = awaitingReceipt(o.id)
      if (waitSp) fail(`檢體還沒收件（條碼 ${waitSp.barcode}），請先在「待收件」掃條碼收件`, 'CONFLICT')
      if (reportedIpd(o.id)) fail('這項已經發過報告了；要改請用「更正」', 'CONFLICT')
      base = { patientId: must(find.admission(o.admissionId), '住院').patientId, procId: o.procId!, doctorId: o.doctorId, orderedAt: o.createdAt, orderId: o.id, admissionId: o.admissionId }
    } else {
      fail('找不到這筆檢驗，請重新整理')
    }
    return base!
}


/** 發一份數值報告。auto＝儀器自動審核直接發；analyzer＝醫檢師審核儀器結果後發（不受「儀器待審核」擋） */
export function issueLabReport(key: string, values0: Record<string, string>, u: { id: string }, opts: { auto?: boolean; analyzer?: boolean; qualityNote?: string } = {}): LabReport {
    const base = labTarget(key)
    if (!opts.analyzer && db.analyzerResults.some((x) => x.key === key && x.status === 'held')) fail('這項的儀器結果待審核，請到「儀器」審核後發出（或重測）', 'CONFLICT')
    if (base.procId === 'P059') fail('細菌培養請用培養報告登打（檢體、菌種、藥敏）', 'CONFLICT')
    const defs = procItems(base!.procId)
    if (!defs.length) fail('這個醫令沒有設定檢驗項目')
    // 品管：這份檢驗裡的品管項目今天都要通過（沒做、被拒絕都不能發）
    const qc = qcBlockers(defs.map((d) => d.code), db.qcRuns, now().slice(0, 10))
    if (qc.length) fail(`${qc.join('；')}，不能發報告（到「品管」登打）`, 'CONFLICT', 'qc')
    const p = must(find.patient(base!.patientId), '病患')
    const { values, errors } = buildLabValues(defs, values0, p.gender)
    failFields(errors)
    const t = now()
    // 要空腹的檢驗、採檢時沒空腹：報告附註「非空腹採檢」（和檢體品質附註合在一起）
    const sp = base!.orderId ? specimenOfOrder(base!.orderId) : opdSpecimenOf(key)
    const fastNote = find.procedure(base!.procId)?.fasting && sp?.fasting?.ok === false ? `非空腹採檢${sp.fasting.note ? `（${sp.fasting.note}）` : ''}` : ''
    const note = [opts.qualityNote, fastNote].filter(Boolean).join('；')
    const r: LabReport = { id: newId('LR'), no: nextLabNo(t), ...base!, values, reportedBy: u.id, reportedAt: t, ...(opts.auto ? { autoVerified: true } : {}), ...(note ? { qualityNote: note } : {}) }
    db.labReports.push(r)
    const crit = values.filter((x) => x.critical)
    audit(`${crit.length ? '發檢驗報告（危急值）' : '發檢驗報告'}${opts.auto ? '（自動審核）' : opts.analyzer ? '（儀器審核）' : ''}`, `${r.no} ${p.name} ${find.procedure(r.procId)?.name}${crit.length ? `：${crit.map((x) => `${x.name} ${x.value}`).join('、')}` : ''}`)
    return r
}
