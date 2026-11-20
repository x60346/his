// 知情同意書：醫師說明後記錄簽署（紙本簽名；系統記誰簽、關係、說明重點）→ 病人可以撤回。
// 手術：手術同意書＋（非局部麻醉）麻醉同意書都有效，術前準備的「同意書」才能勾（surgery.markPrep 檢查）；撤回會把術前準備的勾取消。
// 規則在 consent-rules
import type { Consent } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { checkConsentInput, CONSENT_KIND_LABEL, CONSENT_LINE_KINDS, examConsentOk, transfusionConsentOk, unusedLineConsent } from './consent-rules'
import { lineKind } from './line-rules'
import type { LineKind } from '@/types'
import { imagingOf } from './imaging-work'
import { find, nameOf } from './views'
import { surgeryOf } from './surgery-work'

export interface ConsentView extends Consent {
  kindLabel: string
  patientName: string
  explainedByName: string
  surgeryNo?: string
  /** 侵入性處置同意書已經用來放置管路（不能撤回） */
  lineUsed?: boolean
}
const view = (c: Consent): ConsentView => ({
  ...c, kindLabel: CONSENT_KIND_LABEL[c.kind], patientName: nameOf.patient(c.patientId), explainedByName: nameOf.user(c.explainedBy),
  ...((s) => (s ? { surgeryNo: s.no } : {}))(c.surgeryId ? surgeryOf(c.surgeryId) : undefined),
  ...(c.lineKind && db.lines.some((l) => l.consentId === c.id) ? { lineUsed: true } : {}),
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
export function recordConsent(input: { patientId: string; kind: Consent['kind']; title: string; explanation: string; signerName: string; relation: string; reason?: string; surgeryId?: string; admissionId?: string; examId?: string; lineKind?: LineKind }): Promise<ConsentView> {
  return mutate(() => {
    const u = requireUser('doctor')
    must(find.patient(input.patientId), '病患')
    failFields(checkConsentInput(input))
    let surgeryId: string | undefined
    let surgerySide: Consent['side']
    let admissionId = input.admissionId
    if (input.kind === 'surgery' || input.kind === 'anesthesia') {
      const s = input.surgeryId ? surgeryOf(input.surgeryId) : undefined
      if (!s || s.patientId !== input.patientId) failField('surgeryId', '手術、麻醉同意書要選這位病人的一台手術')
      if (s!.status === 'done' || s!.status === 'cancelled') failField('surgeryId', '這台手術已完成或取消')
      if (input.kind === 'anesthesia' && s!.anesthesia === 'local') failField('kind', '局部麻醉不用麻醉同意書')
      if (db.consents.some((c) => c.surgeryId === s!.id && c.kind === input.kind && !c.revoked && (input.kind !== 'surgery' || !c.side || c.side === s!.side))) fail(`這台已經有有效的${CONSENT_KIND_LABEL[input.kind]}`, 'CONFLICT')
      // 側別不符的舊同意書（手術側別更正過）：重簽時自動撤回
      for (const old of db.consents.filter((c) => c.surgeryId === s!.id && c.kind === 'surgery' && !c.revoked && c.side && c.side !== s!.side && input.kind === 'surgery')) old.revoked = { at: now(), by: u.id, reason: '手術側別更正，重簽' }
      surgerySide = s!.side
      surgeryId = s!.id
      admissionId = s!.admissionId
    }
    // 輸血：綁這位病人住院中的那次住院（一次住院一張有效的）
    if (input.kind === 'transfusion') {
      const a = db.admissions.find((x) => x.id === input.admissionId && x.patientId === input.patientId && x.status === 'admitted')
      if (!a) failField('admissionId', '輸血同意書要選這位病人住院中的那次住院')
      if (db.consents.some((c) => c.kind === 'transfusion' && c.admissionId === a!.id && !c.revoked)) fail('這次住院已經有有效的輸血同意書', 'CONFLICT')
      admissionId = a!.id
    }
    // 侵入性處置（中心靜脈導管、胃造口）：綁住院中的那次住院；同一種還沒用掉的只能一張
    let line: LineKind | undefined
    if (input.kind === 'procedure' && input.lineKind) {
      if (!CONSENT_LINE_KINDS.includes(input.lineKind)) failField('lineKind', '這種管路不用同意書')
      const a = db.admissions.find((x) => x.patientId === input.patientId && x.status === 'admitted')
      if (!a) failField('lineKind', '侵入性處置同意書要病人住院中')
      if (unusedLineConsent(db.consents, db.lines, a!.id, input.lineKind)) fail(`已經有一張還沒用的${lineKind(input.lineKind).label}同意書`, 'CONFLICT')
      line = input.lineKind
      admissionId = a!.id
    }
    // 檢查：綁一筆還沒做完的影像檢查排程
    let examId: string | undefined
    if (input.kind === 'procedure' && input.examId && !line) {
      const e = db.imagingExams.find((x) => x.id === input.examId && x.patientId === input.patientId)
      if (!e || e.cancelled || e.doneAt) failField('examId', '要選這位病人還沒做的檢查')
      if (db.consents.some((c) => c.examId === e!.id && !c.revoked)) fail('這筆檢查已經有有效的同意書', 'CONFLICT')
      examId = e!.id
      admissionId = e!.admissionId
    }
    const t = now()
    const d = t.slice(0, 10).replace(/-/g, '')
    const c: Consent = {
      id: newId('CN'), no: `CN${d}${String(nextCounter(`consent:${d}`)).padStart(3, '0')}`, kind: input.kind, patientId: input.patientId, ...(admissionId ? { admissionId } : {}), ...(surgeryId ? { surgeryId } : {}), ...(examId ? { examId } : {}), ...(line ? { lineKind: line } : {}), ...(input.kind === 'surgery' && surgerySide ? { side: surgerySide } : {}),
      title: input.title.trim(), explainedBy: u.id, explanation: input.explanation.trim(),
      signer: { name: input.signerName.trim(), relation: input.relation, ...(input.relation !== '本人' ? { reason: input.reason!.trim() } : {}) }, signedAt: t, recordedBy: u.id,
    }
    db.consents.push(c)
    audit('同意書簽署', `${c.no} ${CONSENT_KIND_LABEL[c.kind]}：${nameOf.patient(c.patientId)} ${c.title}（簽署 ${c.signer.name}・${c.signer.relation}；說明 ${u.name}）`)
    return view(c)
  })
}

/** 可以記錄同意書的對象：住院中那次住院（有沒有輸血同意書）、還沒做完、要同意書的影像檢查（有沒有） */
export function consentTargets(patientId: string): Promise<{ admission?: { id: string; admitNo: string; transfusion: boolean; lines: { kind: LineKind; label: string; has: boolean }[] }; exams: { id: string; name: string; start: string; has: boolean }[] }> {
  return query(() => {
    requireUser('doctor', 'nurse')
    const a = db.admissions.find((x) => x.patientId === patientId && x.status === 'admitted')
    const exams = db.imagingExams.filter((e) => e.patientId === patientId && !e.cancelled && !e.doneAt && (imagingOf(e.procId)?.prep ?? []).some((p) => p.id === 'consent'))
    return {
      ...(a ? { admission: { id: a.id, admitNo: a.admitNo, transfusion: transfusionConsentOk(db.consents, a.id), lines: CONSENT_LINE_KINDS.map((k) => ({ kind: k, label: lineKind(k).label, has: !!unusedLineConsent(db.consents, db.lines, a.id, k) })) } } : {}),
      exams: exams.map((e) => ({ id: e.id, name: find.procedure(e.procId)?.name ?? e.procId, start: e.start, has: examConsentOk(db.consents, e.id) })),
    }
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
    if (db.lines.some((l) => l.consentId === c.id)) fail('已經依這張同意書放置管路了，不能撤回', 'CONFLICT')
    c.revoked = { at: now(), by: u.id, reason: reason.trim() }
    if (s && s.prep.consent && (s.status === 'requested' || s.status === 'scheduled')) delete s.prep.consent
    audit('同意書撤回', `${c.no} ${CONSENT_KIND_LABEL[c.kind]}：${nameOf.patient(c.patientId)}（${reason.trim()}）${s ? `；${s.no} 術前準備同意書取消` : ''}`)
    return view(c)
  })
}

