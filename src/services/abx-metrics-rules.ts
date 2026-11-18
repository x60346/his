// 抗生素用量與抗藥性指標（純函式）：一劑是幾個 DDD、DDD 與 DOT（每千住院人日）、院內藥敏統計（每病人每菌只算第一株、
// 株數不足 30 標示）、抗生素管理介入的建議數與接受率。抗生素審核頁「指標」、經營月報、測試都用這一份
import type { AbxAdviceKind, AbxIntervention, CultureIsolate, Drug, SirResult } from '@/types'
import { ABX_ADVICE_KINDS, ABX_ADVICE_LABEL } from './abx-steward-rules'
import { astName, ORGANISMS, organismName } from './culture-rules'

/** 院內藥敏統計：一種菌一年少於 30 株，敏感率不穩定（CLSI M39 的建議），標「株數不足」 */
export const AST_MIN_ISOLATES = 30
/** 指標的期間：用量、建議看最近 30 天；藥敏統計看最近一年 */
export const ABX_METRIC_DAYS = 30
export const AST_STAT_DAYS = 365

/** 這一劑是幾個 DDD：劑量（給藥單位數）× 每單位克數 ÷ WHO DDD；主檔沒設 DDD 的回 0 */
export const dddOfDose = (drug: Pick<Drug, 'ddd' | 'dddUnitG'> | undefined, dose: number | undefined) =>
  drug?.ddd && drug.dddUnitG && dose ? (dose * drug.dddUnitG) / drug.ddd : 0

/** 每千住院人日，一位小數；分母 0 回 null */
export const perThousand = (n: number, patientDays: number) => (patientDays ? Math.round((n / patientDays) * 10000) / 10 : null)

/** 一劑已給的抗生素（依給藥紀錄，不是醫囑：開了沒給不算） */
export interface GivenDose {
  admissionId: string
  drugId: string
  /** 實際給藥時間 */
  at: string
  ddd: number
}
export interface AbxUsage {
  /** DDD 合計（兩位小數） */
  ddd: number
  /** DOT：每位病人每支抗生素「有給過藥的天數」加總（同一天給幾劑都算 1 天） */
  dot: number
  patientDays: number
  dddRate: number | null
  dotRate: number | null
}
export function usageOf(doses: GivenDose[], patientDays: number): AbxUsage {
  const ddd = Math.round(doses.reduce((n, d) => n + d.ddd, 0) * 100) / 100
  const dot = new Set(doses.map((d) => `${d.admissionId}|${d.drugId}|${d.at.slice(0, 10)}`)).size
  return { ddd, dot, patientDays, dddRate: perThousand(ddd, patientDays), dotRate: perThousand(dot, patientDays) }
}

export interface CultureRow {
  patientId: string
  reportedAt: string
  isolates: Pick<CultureIsolate, 'organism' | 'ast'>[]
}
/** 每位病人每種菌只算第一株（最早報告的那份）：反覆培養同一位病人會把抗藥率灌高 */
export function firstIsolates(rows: CultureRow[]): (Pick<CultureIsolate, 'organism' | 'ast'> & { patientId: string; reportedAt: string })[] {
  const seen = new Set<string>()
  return [...rows]
    .sort((a, b) => a.reportedAt.localeCompare(b.reportedAt))
    .flatMap((r) => r.isolates.map((iso) => ({ ...iso, patientId: r.patientId, reportedAt: r.reportedAt })))
    .filter((x) => {
      const k = `${x.patientId}|${x.organism}`
      return !seen.has(k) && !!seen.add(k)
    })
}

export interface AntibiogramRow {
  organism: string
  name: string
  /** 第一株的株數 */
  isolates: number
  /** 少於 30 株 */
  insufficient: boolean
  /** 每支抗生素（依那種菌的藥敏組合）：測了幾株、敏感幾株、敏感率 %（I 不算敏感） */
  drugs: { key: string; name: string; tested: number; susceptible: number; pct: number | null }[]
}
/** 院內藥敏統計（antibiogram）：每種菌對每支抗生素的敏感率；株數多的在前，念珠菌（不做細菌藥敏）不列 */
export function antibiogram(firsts: Pick<CultureIsolate, 'organism' | 'ast'>[]): AntibiogramRow[] {
  return ORGANISMS.filter((o) => o.panel.length)
    .map((o) => {
      const xs = firsts.filter((x) => x.organism === o.id)
      return {
        organism: o.id, name: organismName(o.id), isolates: xs.length, insufficient: xs.length < AST_MIN_ISOLATES,
        drugs: o.panel.map((k) => {
          const tested = xs.filter((x) => (['S', 'I', 'R'] as (SirResult | undefined)[]).includes(x.ast[k]))
          const s = tested.filter((x) => x.ast[k] === 'S').length
          return { key: k, name: astName(k), tested: tested.length, susceptible: s, pct: tested.length ? Math.round((s / tested.length) * 1000) / 10 : null }
        }),
      }
    })
    .filter((r) => r.isolates > 0)
    .sort((a, b) => b.isolates - a.isolates)
}

export interface AdviceStat {
  kind: AbxAdviceKind | 'total'
  label: string
  /** 發出的建議（待回覆＋接受＋不接受；「不用介入」不算建議） */
  sent: number
  accepted: number
  declined: number
  pending: number
  /** 審視後標「不用介入」 */
  dismissed: number
  /** 接受率 %＝接受 ÷（接受＋不接受）；還沒回覆的不算進分母 */
  rate: number | null
}
/** 抗生素管理介入的成效：依建議類型＋合計 */
export function adviceStats(list: Pick<AbxIntervention, 'kind' | 'status'>[]): AdviceStat[] {
  const of = (kind: AdviceStat['kind'], xs: Pick<AbxIntervention, 'kind' | 'status'>[]): AdviceStat => {
    const n = (s: AbxIntervention['status']) => xs.filter((x) => x.status === s).length
    const accepted = n('accepted')
    const declined = n('declined')
    return { kind, label: kind === 'total' ? '合計' : ABX_ADVICE_LABEL[kind], sent: accepted + declined + n('sent'), accepted, declined, pending: n('sent'), dismissed: n('dismissed'), rate: accepted + declined ? Math.round((accepted / (accepted + declined)) * 1000) / 10 : null }
  }
  return [...ABX_ADVICE_KINDS.map((k) => of(k, list.filter((x) => x.kind === k))), of('total', list)]
}
