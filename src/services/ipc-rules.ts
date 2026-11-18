// 感染管制統計、群聚、法定傳染病（純函式）：群聚偵測（同病房 14 天內兩例同菌種或同感染部位）、
// 法定傳染病比對與通報時限、逾時判斷。感染管制頁、隔離分頁、服務層、測試都用這一份
import type { InfectionKind } from '@/types'
import { addDays, addMinutes } from '@/utils/date'
import { infectionLabel } from './infection-rules'

/** 群聚：同病房、14 天內（發生日期相差 ≤14 天）、兩例以上 */
export const CLUSTER_DAYS = 14
export const CLUSTER_MIN = 2
/** 從培養結果認得出的菌種（文字裡有就算） */
export const KNOWN_ORGANISMS = ['MRSA', 'CRE', 'VRE', '大腸桿菌', '克雷伯氏菌', '綠膿桿菌', '鮑氏不動桿菌', '念珠菌', '困難梭狀桿菌']
/** 培養報告常寫英文學名：對應到同一個菌種 */
const ORGANISM_ALIASES: Record<string, string> = { 'E. COLI': '大腸桿菌', 'E.COLI': '大腸桿菌', KLEBSIELLA: '克雷伯氏菌', PSEUDOMONAS: '綠膿桿菌', ACINETOBACTER: '鮑氏不動桿菌', CANDIDA: '念珠菌', 'C. DIFF': '困難梭狀桿菌' }
export const organismOf = (culture: string) => {
  const u = culture.toUpperCase()
  return KNOWN_ORGANISMS.find((o) => u.includes(o.toUpperCase())) ?? Object.entries(ORGANISM_ALIASES).find(([k]) => u.includes(k))?.[1]
}

export interface ClusterCase { id: string; ward: string; kind: InfectionKind; culture: string; onsetAt: string }
export interface Cluster {
  /** 識別：病房｜菌種或部位｜最早一例 id（決定紀錄用） */
  key: string
  ward: string
  by: 'organism' | 'site'
  label: string
  caseIds: string[]
  from: string
  to: string
}
/**
 * 找群聚：同病房，依菌種（認得出的）、依感染部位各分一組；組內依發生日期排，相鄰兩例在 14 天內就串在一起；
 * 串起來兩例以上算一群。同一批個案依菌種成群時，不再依部位重複列
 */
export function findClusters(cases: ClusterCase[]): Cluster[] {
  const out: Cluster[] = []
  const covered = new Set<string>()
  const groups = (by: 'organism' | 'site') => {
    const m = new Map<string, ClusterCase[]>()
    for (const c of cases) {
      const k = by === 'organism' ? organismOf(c.culture) : c.kind
      if (!k) continue
      const g = `${c.ward}|${k}`
      m.set(g, [...(m.get(g) ?? []), c])
    }
    return m
  }
  for (const by of ['organism', 'site'] as const) {
    for (const [g, list] of groups(by)) {
      const sorted = [...list].sort((a, b) => a.onsetAt.localeCompare(b.onsetAt) || a.id.localeCompare(b.id))
      let run: ClusterCase[] = []
      const flush = () => {
        if (run.length >= CLUSTER_MIN && !(by === 'site' && run.every((c) => covered.has(c.id)))) {
          const [ward, k] = g.split('|')
          out.push({ key: `${g}|${run[0].id}`, ward, by, label: by === 'organism' ? k : infectionLabel(k as InfectionKind), caseIds: run.map((c) => c.id), from: run[0].onsetAt, to: run[run.length - 1].onsetAt })
          if (by === 'organism') for (const c of run) covered.add(c.id)
        }
        run = []
      }
      for (const c of sorted) {
        if (run.length && c.onsetAt > addDays(run[run.length - 1].onsetAt.slice(0, 10), CLUSTER_DAYS)) flush()
        run.push(c)
      }
      flush()
    }
  }
  return out
}
export const checkClusterDecision = (x: { confirm?: boolean; note?: string }): Record<string, string> =>
  x.note?.trim() ? {} : { note: x.confirm ? '請寫處置（例：加強手部衛生稽核、導尿管照護查核、同病房篩檢）' : '請寫排除原因（例：菌株不同、時間不重疊）' }

/** 法定傳染病（簡化）：比對隔離原因或診斷文字；時限（小時）；icuOnly＝要在加護病房（併發重症）才算 */
export const NOTIFIABLE: { key: string; label: string; match: string[]; hours: number; icuOnly?: boolean }[] = [
  { key: 'tb-open', label: '開放性肺結核', match: ['開放性肺結核'], hours: 24 },
  { key: 'tb', label: '結核病（含疑似）', match: ['肺結核', '結核'], hours: 7 * 24 },
  { key: 'flu-severe', label: '流感併發重症', match: ['流感'], hours: 7 * 24, icuOnly: true },
  { key: 'covid-severe', label: '新冠併發重症', match: ['新冠', 'COVID'], hours: 24, icuOnly: true },
]
/** 第一個符合的（開放性肺結核排在結核病前面） */
export function notifiableOf(text: string, inIcu: boolean) {
  return NOTIFIABLE.find((n) => (!n.icuOnly || inIcu) && n.match.some((m) => text.toUpperCase().includes(m.toUpperCase())))
}
export const notifyDueAt = (from: string, hours: number) => addMinutes(from, hours * 60)
export const notifyState = (dueAt: string, t: string): 'ok' | 'soon' | 'overdue' => (t > dueAt ? 'overdue' : t >= addMinutes(dueAt, -24 * 60) ? 'soon' : 'ok')
