// 知情同意書：醫師說明後記錄簽署（紙本簽名；系統記誰簽、關係、說明重點）→ 病人可以撤回。
// 手術：手術同意書＋（非局部麻醉）麻醉同意書都有效，術前準備的「同意書」才能勾（surgery.markPrep 檢查）；撤回會把術前準備的勾取消。
// 規則在 consent-rules
import type { Consent } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { checkConsentInput, CONSENT_KIND_LABEL } from './consent-rules'
import { find, nameOf } from './views'
import { surgeryOf } from './surgery-work'

export interface ConsentView extends Consent {
  kindLabel: string
  patientName: string
  explainedByName: string
  surgeryNo?: string
}
const view = (c: Consent): ConsentView => ({
  ...c, kindLabel: CONSENT_KIND_LABEL[c.kind], patientName: nameOf.patient(c.patientId), explainedByName: nameOf.user(c.explainedBy),
  ...((s) => (s ? { surgeryNo: s.no } : {}))(c.surgeryId ? surgeryOf(c.surgeryId) : undefined),
})

/** 病人的同意書（新到舊）；給 surgeryId 只看那台 */
export function listConsents(patientId: string, surgeryId?: string): Promise<ConsentView[]> {
  return query(() => {
    requireUser('doctor', 'nurse')
    return db.consents.filter((c) => c.patientId === patientId && (!surgeryId || c.surgeryId === surgeryId)).map(view).sort((a, b) => b.signedAt.localeCompare(a.signedAt))
  })
}

/**
 * 記錄簽署（說明的醫師記）：種類、項目、說明重點、簽署人（不是本人寫原因）。
 * 手術、麻醉同意書要綁一台還沒完成的手術（同一台同一種只能有一張有效的）
 */
export function recordConsent(input: { patientId: string; kind: Consent['kind']; title: string; explanation: string; signerName: string; relation: string; reason?: string; surgeryId?: string; admissionId?: string }): Promise<ConsentView> {
  return mutate(() => {
    const u = requireUser('doctor')
    must(find.patient(input.patientId), '病患')
    failFields(checkConsentInput(input))
    let surgeryId: string | undefined
    let admissionId = input.admissionId
    if (input.kind === 'surgery' || input.kind === 'anesthesia') {
      const s = input.surgeryId ? surgeryOf(input.surgeryId) : undefined
      if (!s || s.patientId !== input.patientId) failField('surgeryId', '手術、麻醉同意書要選這位病人的一台手術')
      if (s!.status === 'done' || s!.status === 'cancelled') failField('surgeryId', '這台手術已完成或取消')
      if (input.kind === 'anesthesia' && s!.anesthesia === 'local') failField('kind', '局部麻醉不用麻醉同意書')
      if (db.consents.some((c) => c.surgeryId === s!.id && c.kind === input.kind && !c.revoked)) fail(`這台已經有有效的${CONSENT_KIND_LABEL[input.kind]}`, 'CONFLICT')
      surgeryId = s!.id
      admissionId = s!.admissionId
    }
    const t = now()
    const d = t.slice(0, 10).replace(/-/g, '')
    const c: Consent = {
      id: newId('CN'), no: `CN${d}${String(nextCounter(`consent:${d}`)).padStart(3, '0')}`, kind: input.kind, patientId: input.patientId, ...(admissionId ? { admissionId } : {}), ...(surgeryId ? { surgeryId } : {}),
      title: input.title.trim(), explainedBy: u.id, explanation: input.explanation.trim(),
      signer: { name: input.signerName.trim(), relation: input.relation, ...(input.relation !== '本人' ? { reason: input.reason!.trim() } : {}) }, signedAt: t, recordedBy: u.id,
    }
    db.consents.push(c)
    audit('同意書簽署', `${c.no} ${CONSENT_KIND_LABEL[c.kind]}：${nameOf.patient(c.patientId)} ${c.title}（簽署 ${c.signer.name}・${c.signer.relation}；說明 ${u.name}）`)
    return view(c)
  })
}

/** 撤回（病人或家屬表示不同意了）：寫原因；綁手術的，術前準備「同意書」的勾一起取消（送手術室前要重新簽） */
export function revokeConsent(id: string, reason: string): Promise<ConsentView> {
  return mutate(() => {
    const u = requireUser('doctor', 'nurse')
    const c = must(db.consents.find((x) => x.id === id), '同意書')
    if (c.revoked) fail('已經撤回了', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫撤回原因（例：病人決定先不開刀）')
    const s = c.surgeryId ? surgeryOf(c.surgeryId) : undefined
    if (s && (s.status === 'in-progress' || s.status === 'done')) fail('手術已經開始或完成，不能撤回這張同意書', 'CONFLICT')
    c.revoked = { at: now(), by: u.id, reason: reason.trim() }
    if (s && s.prep.consent && (s.status === 'requested' || s.status === 'scheduled')) delete s.prep.consent
    audit('同意書撤回', `${c.no} ${CONSENT_KIND_LABEL[c.kind]}：${nameOf.patient(c.patientId)}（${reason.trim()}）${s ? `；${s.no} 術前準備同意書取消` : ''}`)
    return view(c)
  })
}

