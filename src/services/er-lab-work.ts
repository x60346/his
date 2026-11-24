// 急診檢驗的內部工具（index 不匯出）：醫師存病歷時替急診的檢驗與影像蓋「送出時間」、刪掉已採檢（已排檢查）的擋下、看板的檢驗進度
import type { Encounter, ProcedureOrder, Visit } from '@/types'
import { db } from '@/mock/db'
import { now } from '@/utils/date'
import { fail } from './http'
import { find } from './views'
import { opdSpecimenOf } from './specimen-work'

const isLab = (procId: string) => !!find.procedure(procId)?.labItems?.length
const isImaging = (procId: string) => !!find.procedure(procId)?.imaging

/**
 * 急診病歷存檔（暫存或完成）：檢驗、影像醫令沿用之前的送出時間，新加的蓋現在＝送出（急診不等批價，送出就能採檢、排檢查）；
 * 已經採檢或發報告的檢驗不能刪（要改請請檢驗科退件、或另開）；已排檢查或發報告的影像不能刪（要取消請影像檢查室取消排程）
 */
export function stampErLabs(e: Encounter, v: Visit, prev: ProcedureOrder[]) {
  if (!v.er) return
  const t = now()
  for (const p of e.procedures) {
    if (!isLab(p.procId) && !isImaging(p.procId)) continue
    const old = prev.find((x) => x.procId === p.procId)
    p.orderedAt = old?.orderedAt ?? t
  }
  for (const old of prev.filter((x) => x.orderedAt && !e.procedures.some((p) => p.procId === x.procId))) {
    const key = `E:${e.id}:${old.procId}`
    if (isImaging(old.procId)) {
      if (db.imagingReports.some((r) => r.encounterId === e.id && r.procId === old.procId)) fail(`${find.procedure(old.procId)?.name} 已經發報告了，不能從醫令刪掉`, 'CONFLICT')
      if (db.imagingExams.some((x) => x.key === key && !x.cancelled)) fail(`${find.procedure(old.procId)?.name} 已經排檢查了，不能從醫令刪掉（要取消請影像檢查室取消排程）`, 'CONFLICT')
      continue
    }
    if (db.labReports.some((r) => r.encounterId === e.id && r.procId === old.procId)) fail(`${find.procedure(old.procId)?.name} 已經發報告了，不能從醫令刪掉`, 'CONFLICT')
    if (opdSpecimenOf(key)?.collectedAt) fail(`${find.procedure(old.procId)?.name} 已經採檢了，不能從醫令刪掉（要取消請檢驗科退件）`, 'CONFLICT')
  }
}

/** 看板用：這次急診的檢驗進度（待採檢、已採檢待收件、檢驗中、已出報告、醫師還沒看的新報告） */
export function erLabCounts(v: Visit): { toCollect: number; toReceive: number; inLab: number; reported: number; fresh: number } | undefined {
  const e = find.encounterOfVisit(v.id)
  const labs = (e?.procedures ?? []).filter((p) => isLab(p.procId) && p.orderedAt && !p.notDone)
  if (!e || !labs.length) return undefined
  const out = { toCollect: 0, toReceive: 0, inLab: 0, reported: 0, fresh: 0 }
  for (const p of labs) {
    const r = db.labReports.find((x) => x.encounterId === e.id && x.procId === p.procId)
    if (r) {
      out.reported++
      if (!v.er?.labsSeenAt || r.reportedAt > v.er.labsSeenAt) out.fresh++
      continue
    }
    const sp = opdSpecimenOf(`E:${e.id}:${p.procId}`)
    if (!sp?.collectedAt) out.toCollect++
    else if (!sp.receivedAt) out.toReceive++
    else out.inLab++
  }
  return out
}
