// 抗生素用量的內部工具（index 不匯出）：期間內「已給」的抗生素劑量（依給藥紀錄）、住院人日、病人算哪個病房。
// 抗生素審核頁「指標」與經營月報共用
import type { Admission } from '@/types'
import { db } from '@/mock/db'
import { lineDays } from './line-rules'
import { dddOfDose, type GivenDose } from './abx-metrics-rules'
import { isAntibiotic } from './abx-work'
import { find } from './views'

/** 期間內（給藥日期在 from–to）已給的抗生素劑量；只算主檔有 DDD 的藥（沒設的 ddd 為 0，但仍算 DOT） */
export function givenAbxDoses(from: string, to: string): GivenDose[] {
  const orders = new Map(db.ipdOrders.filter((o) => o.category === 'medication' && isAntibiotic(find.drug(o.drugId ?? ''))).map((o) => [o.id, o]))
  return db.mar.flatMap((m) => {
    const o = orders.get(m.orderId)
    const day = m.executedAt?.slice(0, 10)
    if (!o || m.status !== 'given' || !day || day < from || day > to) return []
    return [{ admissionId: m.admissionId, drugId: o.drugId!, at: m.executedAt!, ddd: dddOfDose(find.drug(o.drugId!), o.dose) }]
  })
}

/** 有住進來的住院（不含預約、取消） */
export const realAdmissions = () => db.admissions.filter((a) => a.admittedAt && a.status !== 'cancelled' && a.status !== 'reserved')

/** 期間內的住院人日（入院日到出院日，兩頭都算；和感染管制指標同一個算法） */
export const patientDaysOf = (adms: Admission[], from: string, to: string) =>
  adms.reduce((n, a) => n + lineDays({ insertedAt: a.admittedAt!, removedAt: a.dischargedAt }, from, to), 0)

/** 病人算哪個病房：目前（或出院前最後）的床；整段住院都算在那個病房（簡化：轉床不拆） */
export const wardOfAdmission = (a: Admission) => find.bed(a.bedId ?? a.bedHistory?.at(-1)?.bedId ?? '')?.ward
