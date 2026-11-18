// 抗生素用量與抗藥性指標（抗生素審核頁「指標」分頁；醫師都能看）：
//   - 用量：最近 30 天每千住院人日的 DDD 與 DOT（依給藥紀錄，開了沒給不算），全院、依病房、依藥品（管制性抗生素標出）
//   - 院內藥敏統計：最近一年的培養，每病人每菌只算第一株，每菌對每支抗生素的敏感率（少於 30 株標「株數不足」）
//   - 抗生素管理介入：最近 30 天的建議數、接受、不接受、待回覆、不用介入與接受率（依建議類型）
// 規則在 abx-metrics-rules（純函式）
import { db } from '@/mock/db'
import { addDays, today } from '@/utils/date'
import { icuWard, wards } from '@/mock/codes'
import { query, requireUser } from './http'
import { ABX_METRIC_DAYS, AST_STAT_DAYS, adviceStats, antibiogram, firstIsolates, usageOf, type AbxUsage, type AdviceStat, type AntibiogramRow } from './abx-metrics-rules'
import { givenAbxDoses, patientDaysOf, realAdmissions, wardOfAdmission } from './abx-metrics-work'
import { find } from './views'
import { prophylaxisStats, type ProphylaxisStats } from './prophylaxis-rules'
import { prophylaxisRows } from './prophylaxis-work'

export interface AbxMetrics {
  from: string
  to: string
  total: AbxUsage
  byWard: (AbxUsage & { ward: string })[]
  byDrug: (AbxUsage & { drugId: string; name: string; restricted: boolean })[]
  antibiogram: { from: string; to: string; rows: AntibiogramRow[] }
  advice: AdviceStat[]
  /** 手術預防性抗生素：最近 30 天完成的手術 */
  prophylaxis: ProphylaxisStats
}

export function abxMetrics(): Promise<AbxMetrics> {
  return query(() => {
    requireUser('doctor')
    const to = today()
    const from = addDays(to, -(ABX_METRIC_DAYS - 1))
    const adms = realAdmissions()
    const doses = givenAbxDoses(from, to)
    const pd = patientDaysOf(adms, from, to)
    const byWard = [...wards, icuWard].map((ward) => {
      const ids = new Set(adms.filter((a) => wardOfAdmission(a) === ward).map((a) => a.id))
      return { ward, ...usageOf(doses.filter((d) => ids.has(d.admissionId)), patientDaysOf(adms.filter((a) => ids.has(a.id)), from, to)) }
    })
    const byDrug = [...new Set(doses.map((d) => d.drugId))]
      .map((drugId) => {
        const drug = find.drug(drugId)
        return { drugId, name: drug?.name ?? drugId, restricted: !!drug?.restrictedAbx, ...usageOf(doses.filter((d) => d.drugId === drugId), pd) }
      })
      .sort((a, b) => b.ddd - a.ddd)
    const astFrom = addDays(to, -(AST_STAT_DAYS - 1))
    const cultures = db.labReports
      .filter((r) => r.culture && r.reportedAt.slice(0, 10) >= astFrom && r.reportedAt.slice(0, 10) <= to)
      .map((r) => ({ patientId: r.patientId, reportedAt: r.reportedAt, isolates: r.culture!.isolates }))
    return {
      from, to, total: usageOf(doses, pd), byWard, byDrug,
      antibiogram: { from: astFrom, to, rows: antibiogram(firstIsolates(cultures)) },
      prophylaxis: prophylaxisStats(prophylaxisRows(from, to)),
      advice: adviceStats(db.abxInterventions.filter((x) => x.at.slice(0, 10) >= from)),
    }
  })
}
