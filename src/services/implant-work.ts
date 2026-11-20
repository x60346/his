// 植入物的內部工具（index 不匯出、不會被包成 API）：用了幾個、手術畫面的列、住院帳單、首頁待辦。API 在 implant.ts、規則在 implant-rules
import type { ImplantLot, Procedure, Surgery } from '@/types'
import { db } from '@/mock/db'
import { find } from './views'

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
export function implantFeeItems(s: Surgery): { proc: Procedure; qty: number; date: string }[] {
  const out: { proc: Procedure; qty: number; date: string }[] = []
  for (const u of s.implants ?? []) {
    const p = find.procedure(lotOf(u.lotId)?.procId ?? '')
    if (p) out.push({ proc: p, qty: u.qty, date: s.endAt ?? u.at })
  }
  return out
}

/** 首頁（供應中心）：召回批用過、還沒通知的手術台數 */
export function implantRecallOpen(): number {
  return db.implantLots.filter((l): l is ImplantLot & { recall: NonNullable<ImplantLot['recall']> } => !!l.recall).reduce((n, l) => n + lotSurgeries(l.id).filter((s) => !l.recall.notified.some((x) => x.surgeryId === s.id)).length, 0)
}
