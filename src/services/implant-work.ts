// 植入物的內部工具（index 不匯出、不會被包成 API）：用了幾個、手術畫面的列、住院帳單、首頁待辦。API 在 implant.ts、規則在 implant-rules
import type { ImplantLot, MriSafety, Procedure, Surgery } from '@/types'
import { db } from '@/mock/db'
import { find } from './views'
import { addDays } from '@/utils/date'
import { MRI_LABEL, udiOf, worstMri } from './implant-rules'
import { implantSelfPay } from './preauth-work'

export const lotOf = (id: string) => db.implantLots.find((l) => l.id === id)
/** 這批已經用掉幾個（所有手術） */
export const usedOf = (lotId: string): number => db.surgeries.reduce((n, s) => n + (s.implants ?? []).filter((u) => u.lotId === lotId).reduce((m, u) => m + u.qty, 0), 0)
/** 用過這批的手術 */
export const lotSurgeries = (lotId: string): Surgery[] => db.surgeries.filter((s) => (s.implants ?? []).some((u) => u.lotId === lotId))
export const isSelfPayImplant = (p: Pick<Procedure, 'points'> | undefined) => !!p && p.points === 0

/** 手術畫面：「鎖定骨板（橈骨遠端）× 1・批號 L23A・右橈骨遠端」；召回的標出來 */
export function implantRows(s: Surgery) {
  return (s.implants ?? []).map((u) => {
    const l = lotOf(u.lotId)
    const p = l ? find.procedure(l.procId) : undefined
    return { id: u.id, text: `${p?.name ?? ''} × ${u.qty}・批號 ${l?.lot ?? ''}・${u.site}`, selfPay: isSelfPayImplant(p), recalled: !!l?.recall }
  })
}

/** 住院帳單：做完的手術用掉的植入物（健保點數或自費），依手術結束那天 */
export function implantFeeItems(s: Surgery): { proc: Procedure; qty: number; date: string; selfPay?: boolean }[] {
  const out: { proc: Procedure; qty: number; date: string; selfPay?: boolean }[] = []
  for (const u of s.implants ?? []) {
    const p = find.procedure(lotOf(u.lotId)?.procId ?? '')
    // 事前審查改自費：照自費算
    if (p) out.push({ proc: p, qty: u.qty, date: s.endAt ?? u.at, ...(implantSelfPay(s.id, p.id) ? { selfPay: true } : {}) })
  }
  return out
}

/** 首頁（供應中心）：召回批用過、還沒通知的手術台數 */
export function implantRecallOpen(): number {
  return db.implantLots.filter((l): l is ImplantLot & { recall: NonNullable<ImplantLot['recall']> } => !!l.recall).reduce((n, l) => n + lotSurgeries(l.id).filter((s) => !l.recall.notified.some((x) => x.surgeryId === s.id)).length, 0)
}

// ---------- 病人植入物紀錄（本院手術登記的＋外院的）、MRI、植入物卡 ----------

export interface PatientImplantRow {
  source: 'here' | 'external'
  name: string
  vendor?: string
  lot?: string
  udi?: string
  date?: string
  site?: string
  surgeryNo?: string
  hospital?: string
  mri?: MriSafety
  recalled: boolean
  qty?: number
}
export function patientImplantRows(patientId: string): PatientImplantRow[] {
  const here = db.surgeries.filter((s) => s.patientId === patientId && s.status === 'done').flatMap((s) =>
    (s.implants ?? []).map((u) => {
      const l = lotOf(u.lotId)
      const p = l ? find.procedure(l.procId) : undefined
      return { source: 'here' as const, name: p?.name ?? '', vendor: p?.implant?.vendor, lot: l?.lot, udi: l ? udiOf(p?.implant?.udiDi, l.lot, l.expiresOn) : '', date: (s.endAt ?? u.at).slice(0, 10), site: u.site, surgeryNo: s.no, mri: p?.implant?.mri, recalled: !!l?.recall, qty: u.qty }
    }),
  )
  const ext = (find.patient(patientId)?.externalImplants ?? []).map((x) => ({ source: 'external' as const, name: x.name, ...(x.implantedOn ? { date: x.implantedOn } : {}), ...(x.hospital ? { hospital: x.hospital } : {}), mri: x.mri, recalled: false }))
  return [...here, ...ext].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
}
/** 排磁振造影時：病人身上最嚴重的 MRI 相容性與那些植入物（安全的不列） */
export function mriRiskOf(patientId: string): { level?: 'conditional' | 'unsafe'; items: string[] } {
  const rows = patientImplantRows(patientId).filter((r) => r.mri === 'conditional' || r.mri === 'unsafe')
  const level = worstMri(rows.map((r) => r.mri)) as 'conditional' | 'unsafe' | undefined
  return { ...(level ? { level } : {}), items: rows.map((r) => `${r.name}（${MRI_LABEL[r.mri!]}${r.hospital ? `，${r.hospital}` : ''}）`) }
}
/** 植入物卡要印：本院登記的植入物，最後一次植入之後還沒印過 */
export function implantCardDue(patientId: string): boolean {
  const last = patientImplantRows(patientId).filter((r) => r.source === 'here').map((r) => r.date ?? '').sort().at(-1)
  if (!last) return false
  return !db.implantCardPrints.some((p) => p.patientId === patientId && p.at.slice(0, 10) >= last)
}
/** 首頁：最近 7 天做完的手術有植入物、還沒印卡的病人 */
export function implantCardDueCount(today: string): number {
  const from = addDays(today, -7)
  const ids = new Set(db.surgeries.filter((s) => s.status === 'done' && s.implants?.length && (s.endAt ?? '').slice(0, 10) >= from).map((s) => s.patientId))
  return [...ids].filter(implantCardDue).length
}
