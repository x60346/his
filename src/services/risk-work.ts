// 風險評估的內部工具（index 不匯出）：切點、最新一次評估、轉床轉科時間、該不該評。
// 護理站病人清單、本班待辦、首頁待辦、評估畫面共用，判斷都是 risk-rules.riskDue
import type { Admission, RiskAssessment, RiskScale, RiskSettings } from '@/types'
import { db } from '@/mock/db'
import { RISK_DEFAULT, riskDue, type RiskDue } from './risk-rules'

export const riskSettingsOf = (): RiskSettings => db.riskSettings ?? RISK_DEFAULT

/** 這位病人這份量表最新一次（沒作廢的）評估 */
export const latestRisk = (admissionId: string, scale: RiskScale): RiskAssessment | undefined =>
  db.riskAssessments.filter((r) => r.admissionId === admissionId && r.scale === scale && !r.voided).reduce<RiskAssessment | undefined>((b, r) => (!b || r.at >= b.at ? r : b), undefined)

/** 最近一次轉床或轉科（接受）的時間：之後要重評 */
export function movedAtOf(a: Admission): string | undefined {
  // 報到那一筆不算（時間就是入院時間）；舊資料沒有床位紀錄，轉床後只有一筆，也要算
  const beds = (a.bedHistory ?? []).map((h) => h.from).filter((f) => !a.admittedAt || f > a.admittedAt)
  const depts = (a.deptTransfers ?? []).filter((t) => t.status === 'accepted' && t.decidedAt).map((t) => t.decidedAt!)
  return [...beds, ...depts].sort().at(-1)
}

export interface RiskState {
  latest?: RiskAssessment
  due: RiskDue
}

export function riskStateOf(a: Admission, now: string): Record<RiskScale, RiskState> {
  const one = (scale: RiskScale): RiskState => {
    const latest = latestRisk(a.id, scale)
    return { ...(latest ? { latest } : {}), due: riskDue({ admittedAt: a.admittedAt ?? a.reservedAt, lastAt: latest?.at, lastLevel: latest?.level, movedAt: movedAtOf(a) }, now) }
  }
  return { fall: one('fall'), pressure: one('pressure') }
}
