// 腎功能與治療藥物監測的內部工具（index 不匯出）：最近的體重與肌酸酐、這位住院病人的 CrCl、
// 醫囑的腎功能提醒、Vancomycin 谷濃度狀態、主治的谷濃度異常待辦。住院醫囑、每日審視、審核頁、首頁共用
import type { IpdOrder } from '@/types'
import { db } from '@/mock/db'
import { addDays, ageOf, now } from '@/utils/date'
import { CRE_VALID_DAYS, crclOf, renalAdjust, tdmState, WEIGHT_VALID_DAYS, type TdmState } from './renal-rules'
import { find } from './views'

/** 頻率代碼 → 每天幾次 */
export const perDayOf = (code: string) => db.frequencies.find((f) => f.code === code)?.timesPerDay

/** 最近的體重（30 天內）：營養篩檢、升壓劑開立時的體重、門診量的體重，取最新的一筆（住院生命徵象沒有體重欄位） */
export function latestWeight(admissionId: string, t: string = now()): { kg: number; at: string; source: string } | undefined {
  const a = find.admission(admissionId)
  if (!a) return undefined
  const since = addDays(t.slice(0, 10), -WEIGHT_VALID_DAYS)
  const xs = [
    ...db.nutritionScreens.filter((s) => s.admissionId === admissionId && s.weightKg).map((s) => ({ kg: s.weightKg!, at: s.at, source: '營養篩檢' })),
    ...db.ipdOrders.filter((o) => o.admissionId === admissionId && o.infusion?.vaso?.weightKg).map((o) => ({ kg: o.infusion!.vaso!.weightKg, at: o.createdAt, source: '升壓劑開立' })),
    ...db.encounters.filter((e) => e.patientId === a.patientId && e.vitals?.weight).map((e) => ({ kg: e.vitals.weight!, at: e.date, source: '門診' })),
  ]
  return xs.filter((x) => x.at.slice(0, 10) >= since && x.at <= t).sort((x, y) => y.at.localeCompare(x.at))[0]
}

/** 最近的肌酸酐（7 天內，門診住院都算） */
export function latestScr(patientId: string, t: string = now()): { value: number; at: string } | undefined {
  const since = addDays(t.slice(0, 10), -CRE_VALID_DAYS)
  return db.labReports
    .filter((r) => r.patientId === patientId && r.reportedAt.slice(0, 10) >= since && r.reportedAt <= t)
    .flatMap((r) => r.values.filter((v) => v.code === 'CRE' && Number(v.value) > 0).map((v) => ({ value: Number(v.value), at: r.reportedAt })))
    .sort((x, y) => y.at.localeCompare(x.at))[0]
}

export interface RenalInfo {
  crcl: number | null
  /** 「CrCl 32 ml/min（肌酸酐 1.8、60 kg、60 歲女性）」或算不出的原因 */
  text: string
}
export function renalOf(admissionId: string, t: string = now()): RenalInfo {
  const a = find.admission(admissionId)
  const p = a && find.patient(a.patientId)
  if (!a || !p) return { crcl: null, text: '' }
  const scr = latestScr(p.id, t)
  const w = latestWeight(admissionId, t)
  const age = ageOf(p.birthDate, t.slice(0, 10))
  const female = p.gender === 'F'
  if (!scr) return { crcl: null, text: `CrCl 算不出：沒有 ${CRE_VALID_DAYS} 天內的肌酸酐` }
  if (!w) return { crcl: null, text: `CrCl 算不出：沒有 ${WEIGHT_VALID_DAYS} 天內的體重（營養篩檢可登打）` }
  const crcl = crclOf({ age, female, weightKg: w.kg, scr: scr.value })
  return { crcl, text: `CrCl ${crcl} ml/min（肌酸酐 ${scr.value}、${w.kg} kg、${age} 歲${female ? '女性' : '男性'}）` }
}

/** 這筆給藥醫囑要不要依腎功能調頻率（執行中、主檔有分級、CrCl 算得出、目前比建議的頻繁） */
export function renalAlertOf(o: IpdOrder, t: string = now()): string | undefined {
  if (o.status !== 'active' || o.category !== 'medication') return undefined
  const bands = find.drug(o.drugId ?? '')?.renal
  if (!bands?.length) return undefined
  return renalAdjust(bands, o.freq, renalOf(o.admissionId, t).crcl, perDayOf)?.text
}

/** 需要監測血中濃度的藥 → 檢驗項目 */
export const TDM_PROC: Record<string, { procId: string; code: string }> = { M042: { procId: 'P060', code: 'VANT' } }

/** 執行中的 Vancomycin 醫囑的谷濃度狀態（只看這筆醫囑開立之後：修改劑量就要重抽） */
export function tdmOf(o: IpdOrder): TdmState | undefined {
  const m = TDM_PROC[o.drugId ?? '']
  if (!m || o.status !== 'active') return undefined
  const given = db.mar.filter((x) => x.orderId === o.id && x.status === 'given').length
  const ordered = db.ipdOrders.some((x) => x.admissionId === o.admissionId && x.procId === m.procId && x.createdAt >= o.createdAt)
  const latest = db.labReports
    .filter((r) => r.admissionId === o.admissionId && r.procId === m.procId && r.reportedAt >= o.createdAt)
    .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))[0]
  const v = latest?.values.find((x) => x.code === m.code)
  return tdmState({ given, ordered, ...(latest && v ? { latest: { value: Number(v.value), at: latest.reportedAt } } : {}) })
}

/** 主治的待辦：我的住院病人谷濃度過高或過低、還沒改劑量（改了就是新醫囑，從頭看） */
export function tdmAlerts(doctorId: string): IpdOrder[] {
  return db.ipdOrders.filter((o) => {
    if (!TDM_PROC[o.drugId ?? ''] || o.status !== 'active') return false
    const a = find.admission(o.admissionId)
    if (a?.status !== 'admitted' || a.doctorId !== doctorId) return false
    const s = tdmOf(o)?.status
    return s === 'high' || s === 'low'
  })
}
