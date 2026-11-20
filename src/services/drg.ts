// DRG：分組表、一次住院的分組與預估（主治住院醫囑頁、護理站）。分組與給付規則在 drg-rules；住院申報接在 claim-work
import { db } from '@/mock/db'
import { now } from '@/utils/date'
import { must, query, requireUser } from './http'
import { ccCodesIn, historyFrom, mainDiagnosisFrom, drgAlert, drgPay, DRG_PAY_RULE_LABEL, DRG_TABLE, type DrgGroup, type DrgPayRule, type DrgResult } from './drg-rules'
import { drgExemptOf, drgOfAdmission } from './drg-work'
import { ipdBillOf } from './ipd-bill'
import { linePoints } from './claim-rules'
import { find } from './views'

export function drgTable(): Promise<DrgGroup[]> {
  return query(() => {
    requireUser()
    return DRG_TABLE
  })
}

/** 寫出院病摘時建議加入次診斷的：病人病史裡屬於 DRG 合併症的診斷（醫師勾選才算） */
export function ccSuggestions(admissionId: string): Promise<{ icd: string; name: string }[]> {
  return query(() => {
    requireUser('doctor')
    const a = must(find.admission(admissionId), '住院紀錄')
    return ccCodesIn(historyFrom(db.encounters, db.admissions, a.patientId, a.id), mainDiagnosisFrom(a)).map((c) => ({ icd: c, name: db.icdCodes.find((k) => k.code === c)?.name ?? '' }))
  })
}

export interface DrgEstimate {
  admissionId: string
  group: DrgResult
  /** 不適用 DRG 的原因（照實申報） */
  exempt?: string
  /** 目前（住院中算到今天；出院了算到出院）的健保醫療點數 */
  actual: number
  /** 目前點數佔上限幾 %；接近（80% 以上）、超過 */
  alert: { pct: number; level: 'ok' | 'near' | 'over' }
  /** 照現在的點數，DRG 會給付多少、盈虧（給付 − 實際） */
  pay: number
  payRule: DrgPayRule
  payRuleLabel: string
  diff: number
}

/** 一次住院的 DRG 分組與預估（醫師、護理師、櫃台） */
export function drgEstimate(admissionId: string): Promise<DrgEstimate> {
  return query(() => {
    requireUser('doctor', 'nurse', 'clerk', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const c = db.charges.find((x) => x.admissionId === a.id && !x.voided)
    const actual = Math.round(linePoints(c ? c.lines : ipdBillOf(a).lines).points)
    const group = drgOfAdmission(a)
    const exempt = drgExemptOf(a, now())
    const p = drgPay(actual, group)
    return { admissionId: a.id, group, ...(exempt ? { exempt } : {}), actual, alert: drgAlert(actual, group), pay: p.pay, payRule: p.rule, payRuleLabel: DRG_PAY_RULE_LABEL[p.rule], diff: p.diff }
  })
}
