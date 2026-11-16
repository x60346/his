// 跌倒、壓傷風險評估（護理師）：評估（服務層重算分數與等級）、高風險要勾預防措施、可一併寫護理紀錄、當班作廢、切點設定。
// 量表與規則在 risk-rules（純函式）；該不該評在 risk-work（護理站清單、待辦共用）
import type { NursingNote, RiskAssessment, RiskLevel, RiskReason, RiskScale, RiskSettings } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { checkRiskSettings, RISK_ITEMS, RISK_LEVEL_LABEL, RISK_MEASURES, RISK_NOTE_FOCUS, RISK_SCALE_LABEL, RISK_SCALE_NAME, riskFactors, riskLevel, riskScore, type RiskDue } from './risk-rules'
import { riskSettingsOf, riskStateOf } from './risk-work'
import { shiftRange } from './nursing-rules'
import { find, nameOf } from './views'

export interface RiskAssessmentView extends RiskAssessment {
  nurseName: string
  voidedByName?: string
  /** 現在能不能作廢（本人、當班、沒作廢過）：不能的原因 */
  cantVoid?: string
}

export interface RiskOverview {
  admissionId: string
  scales: Record<RiskScale, { latest?: RiskAssessmentView; due: RiskDue; history: RiskAssessmentView[] }>
  settings: RiskSettings
}

function viewOf(r: RiskAssessment, userId: string | undefined, t: string): RiskAssessmentView {
  const cantVoid = r.voided ? '已作廢' : r.nurseId !== userId ? '只有評估的護理師本人可以作廢' : r.at < shiftRange(t).start ? '不是這一班評的，不能作廢（請再評一次）' : undefined
  return { ...r, nurseName: nameOf.user(r.nurseId), ...(r.voided ? { voidedByName: nameOf.user(r.voided.by) } : {}), ...(cantVoid ? { cantVoid } : {}) }
}

/** 一位住院病人的兩份評估：最新一次、下次該評、歷次（新的在前，含作廢的） */
export function getRiskOverview(admissionId: string): Promise<RiskOverview> {
  return query(() => {
    const u = requireUser()
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const st = riskStateOf(a, t)
    const one = (scale: RiskScale) => ({
      ...(st[scale].latest ? { latest: viewOf(st[scale].latest!, u.id, t) } : {}),
      due: st[scale].due,
      history: db.riskAssessments.filter((r) => r.admissionId === a.id && r.scale === scale).sort((x, y) => y.at.localeCompare(x.at)).map((r) => viewOf(r, u.id, t)),
    })
    return { admissionId: a.id, scales: { fall: one('fall'), pressure: one('pressure') }, settings: riskSettingsOf() }
  })
}

export interface RiskInput {
  admissionId: string
  scale: RiskScale
  answers: Record<string, number>
  /** 病情變化加評（不填就依到期原因：入院、例行、轉床轉科後） */
  change?: boolean
  measures?: string[]
  /** 同時寫一筆護理紀錄（Focus DAR） */
  writeNote?: boolean
}

/**
 * 存一次評估：分數與等級由這裡重算（依現在的切點）。高風險要勾已採取的預防措施（至少一項）；
 * writeNote 時一併寫護理紀錄（焦點、分數與高風險因子、措施）
 */
export function saveRiskAssessment(input: RiskInput): Promise<RiskAssessmentView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = must(find.admission(input.admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    if (!RISK_ITEMS[input.scale]) fail('量表不正確')
    const { score, missing } = riskScore(input.scale, input.answers)
    if (missing.length) failField('answers', `還有 ${missing.length} 題沒選：${missing.join('、')}`)
    const level: RiskLevel = riskLevel(input.scale, score, riskSettingsOf())
    const valid = new Set(RISK_MEASURES[input.scale].map((m) => m.key))
    const measures = [...new Set(input.measures ?? [])].filter((m) => valid.has(m))
    if ((input.measures ?? []).some((m) => !valid.has(m))) failField('measures', '預防措施不正確')
    if (level === 'high' && !measures.length) failField('measures', `${RISK_SCALE_LABEL[input.scale]}高風險：請勾選已採取的預防措施（至少一項）`)
    const t = now()
    const reason: RiskReason = input.change ? 'change' : riskStateOf(a, t)[input.scale].due.reason
    const r: RiskAssessment = { id: newId('RA'), admissionId: a.id, scale: input.scale, at: t, nurseId: u.id, answers: { ...input.answers }, score, level, reason, ...(measures.length ? { measures } : {}) }
    if (input.writeNote) {
      const factors = riskFactors(input.scale, input.answers)
      const labels = measures.map((k) => RISK_MEASURES[input.scale].find((m) => m.key === k)!.label)
      const note: NursingNote = {
        id: newId('NN'), admissionId: a.id, at: t, nurseId: u.id,
        focus: level === 'high' ? RISK_NOTE_FOCUS[input.scale] : `${RISK_SCALE_LABEL[input.scale]}風險評估`,
        data: `${RISK_SCALE_NAME[input.scale]} ${score} 分（${RISK_LEVEL_LABEL[level]}）${factors.length ? `：${factors.join('、')}` : ''}。`,
        action: labels.length ? `${labels.join('、')}。` : '持續觀察，依時程重評。',
        response: '',
      }
      db.nursingNotes.push(note)
      r.noteId = note.id
    }
    db.riskAssessments.push(r)
    audit('風險評估', `${a.admitNo} ${nameOf.patient(a.patientId)} ${RISK_SCALE_NAME[input.scale]} ${score} 分（${RISK_LEVEL_LABEL[level]}）${r.noteId ? '，並寫護理紀錄' : ''}`)
    return viewOf(r, u.id, t)
  })
}

/** 作廢（填錯）：評估的護理師本人、這一班的、要寫原因；紀錄留著。一起寫的護理紀錄不動（要改請另寫） */
export function voidRiskAssessment(id: string, reason: string): Promise<RiskAssessmentView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const r = must(db.riskAssessments.find((x) => x.id === id), '風險評估')
    const why = reason?.trim()
    if (!why) failField('reason', '請寫作廢原因')
    const t = now()
    const cant = viewOf(r, u.id, t).cantVoid
    if (cant) fail(`不能作廢：${cant}`, 'CONFLICT')
    r.voided = { at: t, by: u.id, reason: why! }
    audit('作廢風險評估', `${find.admission(r.admissionId)?.admitNo} ${RISK_SCALE_NAME[r.scale]} ${r.score} 分（${r.at}）：${why}`)
    return viewOf(r, u.id, t)
  })
}

export const getRiskSettings = (): Promise<RiskSettings> => query(() => (requireUser(), riskSettingsOf()))

/** 切點設定（管理員）：之後的評估用新切點，舊紀錄的等級不變 */
export function saveRiskSettings(input: RiskSettings): Promise<RiskSettings> {
  return mutate(() => {
    requireUser('admin')
    const s: RiskSettings = { fallHigh: Number(input.fallHigh), fallModerate: Number(input.fallModerate), pressureHigh: Number(input.pressureHigh), pressureModerate: Number(input.pressureModerate) }
    failFields(checkRiskSettings(s))
    const old = riskSettingsOf()
    db.riskSettings = s
    audit('修改安全設定', `風險評估切點：Morse 高 ≥${old.fallHigh}、中 ≥${old.fallModerate} → 高 ≥${s.fallHigh}、中 ≥${s.fallModerate}；Braden 高 ≤${old.pressureHigh}、中 ≤${old.pressureModerate} → 高 ≤${s.pressureHigh}、中 ≤${s.pressureModerate}`)
    return s
  })
}
