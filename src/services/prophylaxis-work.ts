// 手術預防性抗生素的內部工具（index 不匯出）：術前準備連的抗生素醫囑（沿修改醫囑接到最新那筆）、已給的時間、
// 開始手術前的時機檢查、超過 24 小時還在用的、指標。手術室、每日審視、首頁、指標共用。規則在 prophylaxis-rules
import type { IpdOrder, Surgery } from '@/types'
import { db } from '@/mock/db'
import { addMinutes, now } from '@/utils/date'
import { PROPHYLAXIS_STOP_HOURS, preIncisionCheck, preIncisionWindow, prophylaxisOverdueHours, type PreIncision } from './prophylaxis-rules'
import { find } from './views'

/** 術前準備連的抗生素醫囑：原本那筆＋之後修改的每一筆（ids），final＝最新那筆 */
export function linkedAbx(s: Surgery): { ids: string[]; final: IpdOrder } | undefined {
  const ref = s.prep.abx?.refId
  let o = ref ? db.ipdOrders.find((x) => x.id === ref) : undefined
  if (!o) return undefined
  const ids = [o.id]
  while (o.replacedBy) {
    const n = db.ipdOrders.find((x) => x.id === o!.replacedBy)
    if (!n || ids.includes(n.id)) break
    ids.push(n.id)
    o = n
  }
  return { ids, final: o }
}

const givenAtsOf = (ids: string[]) => db.mar.filter((m) => ids.includes(m.orderId) && m.status === 'given' && m.executedAt).map((m) => m.executedAt!)

/** 劃刀前給藥時機（開始手術時：以現在為劃刀時間；做完的：以 startAt）；沒有連抗生素醫囑（不需要）回 undefined */
export function preIncisionOf(s: Surgery, start: string = s.startAt ?? now()): PreIncision | undefined {
  const l = linkedAbx(s)
  return l ? preIncisionCheck(givenAtsOf(l.ids), start, preIncisionWindow(l.final.drugId)) : undefined
}

/** 做完的手術、連的長期抗生素還在用、手術結束滿 24 小時 */
export function prophylaxisOverdue(t: string = now(), doctorId?: string): { surgery: Surgery; order: IpdOrder; hours: number }[] {
  return db.surgeries.flatMap((s) => {
    if (s.status !== 'done' || !s.endAt) return []
    const a = find.admission(s.admissionId)
    if (a?.status !== 'admitted' || (doctorId && a.doctorId !== doctorId)) return []
    const l = linkedAbx(s)
    if (!l || l.final.status !== 'active' || l.final.type !== 'long') return []
    const hours = prophylaxisOverdueHours(s.endAt, t)
    return hours === undefined ? [] : [{ surgery: s, order: l.final, hours }]
  })
}

/** 每日審視用：這位病人做完的手術連的、還在用的長期抗生素 → 手術結束時間與術式名稱（滿不滿 24 小時由規則判斷） */
export function prophylaxisMapOf(admissionId: string): Record<string, { endAt: string; name: string }> {
  const out: Record<string, { endAt: string; name: string }> = {}
  for (const s of db.surgeries.filter((x) => x.admissionId === admissionId && x.status === 'done' && x.endAt)) {
    const l = linkedAbx(s)
    if (l && l.final.status === 'active' && l.final.type === 'long') out[l.final.id] = { endAt: s.endAt!, name: find.procedure(s.procId)?.name ?? '手術' }
  }
  return out
}

/** 指標：期間內（手術結束日）完成、有連抗生素醫囑的手術：劃刀前時機、24 小時內停藥（還沒滿 24 小時的不判斷） */
export function prophylaxisRows(from: string, to: string, t: string = now()): { timingOk: boolean; stoppedIn24: boolean | null }[] {
  return db.surgeries.flatMap((s) => {
    const day = s.endAt?.slice(0, 10)
    if (s.status !== 'done' || !day || day < from || day > to || !s.startAt) return []
    const l = linkedAbx(s)
    if (!l) return []
    const due = addMinutes(s.endAt!, PROPHYLAXIS_STOP_HOURS * 60)
    const f = l.final
    const stoppedIn24 = f.status !== 'active' ? (f.stopAt ?? f.startAt) <= due : t >= due ? false : null
    return [{ timingOk: !!preIncisionOf(s)?.ok, stoppedIn24 }]
  })
}
