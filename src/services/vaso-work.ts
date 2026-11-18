// 升壓劑的內部工具（index 不匯出、不會被包成 API）：病人的升壓劑醫囑、目前流速與劑量、某段時間的最高劑量（SOFA 心血管）。
// 規則在 vaso-rules
import type { IpdOrder } from '@/types'
import { db } from '@/mock/db'
import { find } from './views'
import { runningRun } from './infusion-work'
import { vasoDose, type VasoMax } from './vaso-rules'

export const isVasoOrder = (o: Pick<IpdOrder, 'infusion'>) => !!o.infusion?.vaso
/** 執行中的升壓劑醫囑 */
export const activeVasoOrders = (admissionId: string) => db.ipdOrders.filter((o) => o.admissionId === admissionId && o.status === 'active' && isVasoOrder(o))

/** 目前正在滴的流速與換算劑量（沒在滴＝undefined） */
export function currentVaso(o: IpdOrder): { rateMlH: number; dose: number } | undefined {
  const r = runningRun(o.id)
  const v = find.drug(o.drugId ?? '')?.vaso
  if (!r || !v || !o.infusion?.vaso) return undefined
  return { rateMlH: r.rateMlH, dose: vasoDose(v, r.rateMlH, o.infusion.vaso.weightKg) }
}

/** [from, to) 期間各升壓劑的最高劑量（依每瓶的流速分段；Norepinephrine、Dopamine 看劑量，Vasopressin 有用就算） */
export function vasoMaxIn(admissionId: string, from: string, to: string): VasoMax | undefined {
  const out: VasoMax = {}
  let any = false
  for (const o of db.ipdOrders.filter((x) => x.admissionId === admissionId && isVasoOrder(x))) {
    const drug = find.drug(o.drugId ?? '')
    const v = drug?.vaso
    if (!v) continue
    for (const r of db.infusions.filter((x) => x.orderId === o.id)) {
      const segs: [string, number][] = [[r.startAt, r.rateChanges[0]?.from ?? r.rateMlH], ...r.rateChanges.map((c): [string, number] => [c.at, c.to])]
      const end = r.endAt ?? to
      segs.forEach(([s, rate], i) => {
        const e = i + 1 < segs.length ? segs[i + 1][0] : end
        if (e <= from || s >= to || e <= s) return
        const d = vasoDose(v, rate, o.infusion!.vaso!.weightKg)
        any = true
        if (drug!.generic === 'Norepinephrine') out.ne = Math.max(out.ne ?? 0, d)
        else if (drug!.generic === 'Dopamine') out.dopa = Math.max(out.dopa ?? 0, d)
        else out.vasopressin = true
      })
    }
  }
  return any ? out : undefined
}
