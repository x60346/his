// 死亡病例審查的內部工具（index 不匯出、不會被包成 API）：一位死亡病人的審查觸發條件、要不要審、加護病房預估死亡率。
// 規則在 mortality-rules
import type { Admission } from '@/types'
import { db } from '@/mock/db'
import { apacheInputOf, staysOf } from './icu-move-work'
import { apacheScore } from './icu-score-rules'
import { apacheMortality, mortalityTriggers } from './mortality-rules'

/** 審查觸發條件（手術看結束時間、加護病房看最後一次轉出、急救看宣告是不是急救後或有以死亡結束的急救） */
export function triggersOf(a: Admission) {
  const d = a.death!
  const lastSurgeryAt = db.surgeries.filter((s) => s.admissionId === a.id && (s.endAt || s.startAt)).map((s) => s.endAt ?? s.startAt!).sort().pop()
  const lastIcuOutAt = staysOf(a).filter((s) => s.to && s.to < d.declaredAt).map((s) => s.to!).sort().pop()
  const codeBlue = !!d.codeBlueId || db.codeBlues.some((c) => c.admissionId === a.id && c.outcome === 'death')
  return mortalityTriggers({ expected: d.expected, admittedAt: a.admittedAt, declaredAt: d.declaredAt, lastSurgeryAt, codeBlue, lastIcuOutAt })
}
export const needsMortalityReview = (a: Admission) => !!a.death && triggersOf(a).length > 0

/** 這次住院第一次轉入加護病房時的 APACHE II 預估死亡率（沒住過＝undefined） */
export function icuPredictedOf(a: Admission): number | undefined {
  const first = staysOf(a)[0]
  if (!first) return undefined
  const sc = apacheScore(apacheInputOf(a, first.from))
  return apacheMortality(sc.total, a.apache?.category, a.apache?.surgery === 'emergency')
}
