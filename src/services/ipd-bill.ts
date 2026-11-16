// 住院帳單的資料整理（內部模組，index 不匯出、不會被包成 API）：從住院紀錄、床位紀錄、調劑與扣帳、已執行的醫囑
// 組出 calcIpdChargeLines 的輸入。結帳（ipd-charge）、出院前檢查（admission.discharge）共用，兩邊算的一定一樣。
import type { Admission, Charge, ChargeLine, IpdBillMeta } from '@/types'
import { db } from '@/mock/db'
import { diffDays, today } from '@/utils/date'
import { calcIpdChargeLines, IPD_COPAY_DEFAULT, summarize, type IpdBillInput } from './billing'
import { find } from './views'

/** 床位分段：每張床住了幾天（加總＝住院天數）。舊資料沒有床位紀錄，視為整段住目前的床 */
function bedSegments(a: Admission, from: string, to: string, days: number): IpdBillInput['beds'] {
  const hist = a.bedHistory?.length ? a.bedHistory : a.bedId ? [{ bedId: a.bedId, from: a.admittedAt ?? from }] : []
  if (!hist.length) return [{ bedNo: '—', bedClass: '健保床', days, extraFee: 0 }]
  const segs = hist.map((h, i) => {
    const start = (i === 0 ? from : h.from).slice(0, 10)
    const end = (hist[i + 1]?.from ?? to).slice(0, 10)
    const bed = find.bed(h.bedId)
    return { bedNo: bed?.bedNo ?? h.bedId, bedClass: bed?.bedClass ?? '健保床', days: Math.max(0, diffDays(start, end)), extraFee: bed?.extraFee ?? 0 }
  })
  // 當天入院當天出院、或同一天轉床：天數至少 1，算給最後住的那張床
  const counted = segs.reduce((n, s) => n + s.days, 0)
  if (counted < days) segs[segs.length - 1].days += days - counted
  // 同一張床（轉出又轉回）合併
  const merged: IpdBillInput['beds'] = []
  for (const s of segs) {
    const same = merged.find((m) => m.bedNo === s.bedNo)
    if (same) same.days += s.days
    else if (s.days > 0) merged.push({ ...s })
  }
  return merged
}

/**
 * 藥：實際扣帳的量——UD 調劑核對送出的（有扣帳異動的才算），減掉退回點收的；
 * 加上病房常備給藥、藥局直送（異動單號帶住院號）。依扣帳那天的藥價
 */
function drugsOf(a: Admission): IpdBillInput['drugs'] {
  const out: IpdBillInput['drugs'] = []
  for (const d of db.udDispenses) {
    for (const l of d.lines) {
      if (l.admissionId !== a.id || !l.txnId) continue
      const drug = find.drug(l.drugId)
      if (!drug) continue
      const back = (l.returns ?? []).reduce((n, r) => n + r.qty, 0)
      const txn = db.stockTxns.find((t) => t.id === l.txnId)
      out.push({ drug, qty: l.qty - back, date: txn?.at ?? d.dispensedAt })
    }
  }
  for (const t of db.stockTxns) {
    if (t.type !== 'dispense' || !t.ref?.endsWith(` ${a.admitNo}`)) continue
    const drug = find.drug(t.drugId)
    if (drug) out.push({ drug, qty: -t.qty, date: t.at })
  }
  return out
}

/** 已執行的檢驗、處置、影像（臨時醫囑做完的）；住院每日計費項目不算（另外依天數） */
function proceduresOf(a: Admission): IpdBillInput['procedures'] {
  return db.ipdOrders
    .filter((o) => o.admissionId === a.id && o.category === 'procedure' && o.status === 'done' && o.procId)
    .flatMap((o) => {
      const proc = find.procedure(o.procId!)
      return proc && !proc.dailyFee ? [{ proc, qty: 1, date: o.stopAt ?? o.startAt }] : []
    })
}

export interface IpdBill {
  lines: ChargeLine[]
  meta: IpdBillMeta
  nhiPoints: number
  patientTotal: number
  identityCode: string
  identityName: string
}

/** 這次住院到 to（預設今天）為止的帳單 */
export function ipdBillOf(a: Admission, to: string = today()): IpdBill {
  const from = (a.admittedAt ?? a.reservedAt).slice(0, 10)
  const p = find.patient(a.patientId)
  const identity = db.identities.find((x) => x.code === p?.defaultIdentity) ?? db.identities[0]
  const { lines, meta } = calcIpdChargeLines({
    identity, from, to,
    beds: bedSegments(a, from, to, Math.max(1, diffDays(from, to.slice(0, 10)))),
    daily: db.procedures.filter((x) => x.dailyFee && x.active),
    drugs: drugsOf(a),
    procedures: proceduresOf(a),
    copay: db.billingSettings.ipdCopay ?? IPD_COPAY_DEFAULT,
  })
  return { lines, meta, ...summarize(lines), identityCode: identity.code, identityName: identity.name }
}

/** 這次住院目前有效的住院收據（沒作廢、沒退費） */
export const activeIpdChargeOf = (admissionId: string): Charge | undefined => db.charges.find((c) => c.admissionId === admissionId && !c.voided)
