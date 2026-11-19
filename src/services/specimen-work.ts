// 住院檢體的內部工具（index 不匯出）：哪些是檢驗醫囑、某筆檢驗醫囑走到哪一步、建檢體與條碼號、採檢時一起完成醫囑、
// 被退件要重新採檢的。護理站、檢驗科、檢驗清單、首頁共用。規則在 specimen-rules
import type { Admission, IpdOrder, Specimen, TubeKind } from '@/types'
import { db, newId } from '@/mock/db'
import { find } from './views'

/** 住院檢驗醫囑：臨時、處置類、主檔有檢驗項目的 */
export const isLabOrder = (o: IpdOrder) => o.category === 'procedure' && o.type === 'stat' && !!o.procId && !!find.procedure(o.procId)?.labItems?.length
export const tubeOfOrder = (o: IpdOrder): TubeKind => find.procedure(o.procId ?? '')?.tube ?? 'red'

/** 門診這一項檢驗（E:看診:醫令）目前的檢體（沒被退件的最新一支） */
export const opdSpecimenOf = (key: string) => db.specimens.filter((s) => s.opdKeys?.includes(key) && !s.rejected).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)

/** 這筆醫囑目前的檢體（沒被退件的最新一支） */
export const specimenOfOrder = (orderId: string) => db.specimens.filter((s) => s.orderIds.includes(orderId) && !s.rejected).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1)

/**
 * 檢驗醫囑走到哪：toCollect 待印條碼／待採檢、printed 已印條碼還沒採、collected 已採檢等收件、received 可以發報告。
 * 已完成卻沒有檢體的（功能上線前、或舊資料）視同已收件
 */
export function labOrderStage(o: IpdOrder): 'toCollect' | 'printed' | 'collected' | 'received' {
  const s = specimenOfOrder(o.id)
  if (o.status === 'active') return s && !s.collectedAt ? 'printed' : 'toCollect'
  if (!s) return 'received'
  return s.receivedAt ? 'received' : 'collected'
}

/** 條碼號：S＋日期＋當天流水號（Code 39 可印） */
export function nextBarcode(t: string): string {
  const day = t.slice(0, 10).replace(/-/g, '')
  const key = `specimen:${day}`
  db.counters[key] = (db.counters[key] ?? 0) + 1
  return `S${day}${String(db.counters[key]).padStart(4, '0')}`
}

export function newSpecimen(a: Admission, tube: TubeKind, orderIds: string[], by: string, t: string, collected: boolean): Specimen {
  const s: Specimen = { id: newId('SP'), barcode: nextBarcode(t), admissionId: a.id, patientId: a.patientId, tube, orderIds, createdAt: t, printedAt: t, printedBy: by, ...(collected ? { collectedAt: t, collectedBy: by } : {}) }
  db.specimens.push(s)
  return s
}

/** 採檢：檢體記採檢者與時間，裡面還在執行中的檢驗醫囑一起完成（停止的不動） */
export function collectRecord(s: Specimen, by: string, t: string): IpdOrder[] {
  Object.assign(s, { collectedAt: t, collectedBy: by })
  const os = s.orderIds.map((id) => db.ipdOrders.find((o) => o.id === id)).filter((o): o is IpdOrder => !!o && o.status === 'active')
  for (const o of os) Object.assign(o, { status: 'done', stopAt: t })
  return os
}

/** 被退件、要重新採檢的：退件檢體裡的醫囑還在執行中，而且還沒有新的檢體 */
export function toRecollect(admissionId?: string): Specimen[] {
  return db.specimens.filter((s) => {
    if (!s.rejected || (admissionId && s.admissionId !== admissionId)) return false
    if (!s.admissionId || find.admission(s.admissionId)?.status !== 'admitted') return false
    return s.orderIds.some((id) => {
      const o = db.ipdOrders.find((x) => x.id === id)
      return o?.status === 'active' && !specimenOfOrder(id)
    })
  })
}

/** 這位住院病人可以拿來加做這個管別的檢體：最新一支同管別、已收件、沒退件的（時限另外看 addonCheck） */
export const addonSpecimenOf = (admissionId: string, tube: TubeKind) =>
  db.specimens.filter((s) => s.admissionId === admissionId && s.tube === tube && s.receivedAt && !s.rejected).sort((a, b) => (a.collectedAt ?? '').localeCompare(b.collectedAt ?? '')).at(-1)

/** 退件後，裡面已完成的檢驗醫囑回到執行中（待重新採檢）；加做的不再算加做（要重新抽） */
export function reopenLabOrders(orderIds: string[]) {
  for (const id of orderIds) {
    const o = db.ipdOrders.find((x) => x.id === id)
    if (o && o.status === 'done') {
      o.status = 'active'
      delete o.stopAt
      delete o.addonOf
    }
  }
}

/**
 * 部分退件（儀器發現溶血等，只退受影響的那幾項）：這幾項從原本的檢體拆出來，記成一支同條碼的退件檢體（partOf 原本的）；
 * 其他項目留在原本的檢體照常發。全部都退、又還沒發過報告的，直接整支退件
 */
export function rejectPart(s: Specimen, keys: string[], by: string, t: string, reason: string): Specimen {
  const ids = keys.filter((k) => k.startsWith('O:')).map((k) => k.slice(2))
  const opd = keys.filter((k) => k.startsWith('E:'))
  const rejected = { at: t, by, reason }
  const restIds = s.orderIds.filter((id) => !ids.includes(id))
  const restOpd = (s.opdKeys ?? []).filter((k) => !opd.includes(k))
  let out: Specimen
  if (!restIds.length && !restOpd.length) {
    s.rejected = rejected
    out = s
  } else {
    out = { ...s, id: newId('SP'), orderIds: ids, ...(s.opdKeys ? { opdKeys: opd } : {}), rejected, partOf: s.id }
    s.orderIds = restIds
    if (s.opdKeys) s.opdKeys = restOpd
    db.specimens.push(out)
  }
  reopenLabOrders(ids)
  return out
}
