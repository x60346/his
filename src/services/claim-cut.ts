// 核減與申復：申報組輸入健保署的核減（送出過的月份、哪一筆、哪一項、幾點、理由代碼）→ 主治醫師首頁「核減待回覆」，
// 決定申復（寫理由）或接受 → 申復結果回來，申報組記補付（幾點）或維持核減 → 每月申報、核減、補付點數與核減率。規則在 claim-rules
import type { ClaimCut, ClaimKind, ClaimSubmission } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser } from './http'
import { checkCut, CLAIM_KIND_LABEL, CUT_REASONS, cutReplyDue, parseCutFile, CUT_STATUS_LABEL, cutRate, cutStatus, disputeCheck, disputeLeft, type CutStatus } from './claim-rules'
import { today } from '@/utils/date'
import { find, nameOf } from './views'

export interface CutItem extends ClaimCut {
  status: CutStatus
  statusLabel: string
  patientName: string
  chartNo: string
  doctorName: string
  date: string
  diagnosis: string
  codeLabel: string
  replyText?: string
  resultText?: string
  /** 爭議審議：能不能申請（不能的原因）、期限、還沒補回的點數、申請與結果 */
  dispute?: ClaimCut['dispute']
  canDispute: boolean
  disputeWhy?: string
  disputeDeadline?: string
  disputeLeft: number
  disputeText?: string
  disputeResultText?: string
  /** 主治回覆期限（核減後 14 天）、還沒回覆而且過了 */
  replyDue: string
  replyOverdue: boolean
}
export interface CutMonth {
  kind: ClaimKind
  month: string
  claimed: number
  cut: number
  paid: number
  /** 淨核減＝核減 − 補付；核減率＝淨核減 ÷ 申報 */
  net: number
  rate: number
  pending: number
}
export interface CutBoard {
  canManage: boolean
  cuts: CutItem[]
  months: CutMonth[]
  /** 可以輸入核減的：送出過的月份與每一筆 */
  submissions: { id: string; kind: ClaimKind; month: string; label: string; items: { refId: string; label: string; claim: number; left: number }[] }[]
}

const subOf = (id: string) => db.claimSubmissions.find((s) => s.id === id)
const cutPoints = (submissionId: string, refId: string) => db.claimCuts.filter((c) => c.submissionId === submissionId && c.refId === refId).reduce((n, c) => n + c.points, 0)

function cutItem(c: ClaimCut): CutItem {
  const it = subOf(c.submissionId)?.items.find((x) => x.refId === c.refId)
  const st = cutStatus(c)
  return {
    ...c, status: st, statusLabel: CUT_STATUS_LABEL[st], patientName: nameOf.patient(c.patientId), chartNo: find.patient(c.patientId)?.chartNo ?? '', doctorName: nameOf.doctor(c.doctorId),
    date: it?.date ?? '', diagnosis: it?.diagnosis ?? '', codeLabel: `${c.code} ${CUT_REASONS.find((r) => r.code === c.code)?.label ?? ''}`,
    ...(c.reply ? { replyText: `${c.reply.action === 'appeal' ? '申復' : '接受'}・${nameOf.user(c.reply.by)} ${c.reply.at.slice(5)}${c.reply.text ? `：${c.reply.text}` : ''}` } : {}),
    ...(c.result ? { resultText: `${c.result.outcome === 'paid' ? `補付 ${c.result.points} 點` : '維持核減'}・${nameOf.user(c.result.by)} ${c.result.at.slice(5)}` } : {}),
    ...((d) => ({ canDispute: d.ok, ...(d.why ? { disputeWhy: d.why } : {}), ...(d.deadline ? { disputeDeadline: d.deadline } : {}) }))(disputeCheck(c, today())),
    disputeLeft: disputeLeft(c),
    replyDue: cutReplyDue(c), replyOverdue: !c.reply && today() > cutReplyDue(c),
    ...(c.dispute ? { disputeText: `申請 ${c.dispute.points} 點・${nameOf.user(c.dispute.by)} ${c.dispute.at.slice(5)}：${c.dispute.reason}` } : {}),
    ...(c.dispute?.result ? { disputeResultText: `${c.dispute.result.outcome === 'paid' ? `補付 ${c.dispute.result.points} 點` : '駁回'}・${nameOf.user(c.dispute.result.by)} ${c.dispute.result.at.slice(5)}${c.dispute.result.note ? `：${c.dispute.result.note}` : ''}` } : {}),
  }
}

function months(): CutMonth[] {
  return db.claimSubmissions
    .map((s) => {
      const cs = db.claimCuts.filter((c) => c.submissionId === s.id)
      // 退件的不算申報（之後重送的算在重送那個月）
      const claimed = s.items.filter((x) => !s.rejects?.some((r) => r.refId === x.refId)).reduce((n, x) => n + x.claim, 0)
      const cut = cs.reduce((n, c) => n + c.points, 0)
      // 補付＝申復補付＋爭議審議補付
      const paid = cs.reduce((n, c) => n + (c.result?.outcome === 'paid' ? c.result.points : 0) + (c.dispute?.result?.outcome === 'paid' ? c.dispute.result.points : 0), 0)
      return { kind: s.kind, month: s.month, claimed, cut, paid, net: cut - paid, rate: cutRate(cut - paid, claimed), pending: cs.filter((c) => ['reply', 'appealed', 'disputed'].includes(cutStatus(c))).length }
    })
    .sort((a, b) => b.month.localeCompare(a.month) || a.kind.localeCompare(b.kind))
}

/** 申報組：所有核減（待處理的在前）、每月統計、可以輸入核減的申報 */
export function cutBoard(): Promise<CutBoard> {
  return query(() => {
    const u = requirePermission('nhi.claim')
    const rank: Record<CutStatus, number> = { appealed: 0, disputed: 1, reply: 2, upheld: 3, paid: 4, accepted: 5, disputePaid: 6, disputeRejected: 7 }
    return {
      canManage: permissionsOf(u).includes('nhi.claim'),
      cuts: db.claimCuts.map(cutItem).sort((a, b) => rank[a.status] - rank[b.status] || b.at.localeCompare(a.at)),
      months: months(),
      submissions: db.claimSubmissions.slice().sort((a, b) => b.month.localeCompare(a.month)).map((s) => ({
        id: s.id, kind: s.kind, month: s.month, label: `${s.month} ${CLAIM_KIND_LABEL[s.kind]}`,
        items: s.items.filter((x) => !x.supplementOf && !s.rejects?.some((r) => r.refId === x.refId)).map((x) => ({ refId: x.refId, label: `${x.date} ${nameOf.patient(x.patientId)}・${x.diagnosis || '—'}・${x.claim} 點`, claim: x.claim, left: x.claim - cutPoints(s.id, x.refId) })),
      })),
    }
  })
}

/** 輸入核減（申報組）：送出過的申報裡的一筆 */
export function addCut(input: { submissionId: string; refId: string; item: string; points: number; code: string; reason?: string }): Promise<CutItem> {
  return mutate(() => {
    const u = requirePermission('nhi.claim')
    const s = must(subOf(input.submissionId), '送出的申報')
    const it = s.items.find((x) => x.refId === input.refId && !x.supplementOf && !s.rejects?.some((r) => r.refId === x.refId))
    if (!it) failField('refId', '請選這個月申報的一筆')
    failFields(checkCut(input, it!.claim - cutPoints(s.id, it!.refId)))
    const c: ClaimCut = {
      id: newId('CC'), submissionId: s.id, kind: s.kind, month: s.month, refId: it!.refId, patientId: it!.patientId, doctorId: it!.doctorId,
      item: input.item.trim(), points: Number(input.points), code: input.code, reason: input.reason?.trim() ?? '', at: now(), by: u.id,
    }
    db.claimCuts.push(c)
    audit('健保核減', `${s.month} ${CLAIM_KIND_LABEL[s.kind]}：${nameOf.patient(c.patientId)} ${it!.date} ${c.item} 核減 ${c.points} 點（${c.code}）`)
    return cutItem(c)
  })
}

/** 主治醫師：我的病人被核減的（待回覆在前） */
export function myCuts(): Promise<CutItem[]> {
  return query(() => {
    const u = requireUser('doctor')
    // 待回覆在前（逾期的最前），再依時間
    return db.claimCuts.filter((c) => c.doctorId === u.doctorId).map(cutItem).sort((a, b) => Number(a.status !== 'reply') - Number(b.status !== 'reply') || Number(b.replyOverdue) - Number(a.replyOverdue) || b.at.localeCompare(a.at))
  })
}

/** 主治回覆：申復（寫理由）或接受；只回覆一次 */
export function replyCut(id: string, input: { action: 'appeal' | 'accept'; text?: string }): Promise<CutItem> {
  return mutate(() => {
    const u = requireUser('doctor')
    const c = must(db.claimCuts.find((x) => x.id === id), '核減')
    if (c.doctorId !== u.doctorId) fail('只有這一筆的主治醫師能回覆', 'FORBIDDEN')
    if (c.reply) fail('已經回覆過了', 'CONFLICT')
    if (input.action !== 'appeal' && input.action !== 'accept') failField('action', '請選申復或接受')
    if (input.action === 'appeal' && !input.text?.trim()) failField('text', '申復要寫理由（病情需要、病歷佐證）')
    c.reply = { action: input.action, text: input.text?.trim() ?? '', by: u.id, at: now() }
    audit(input.action === 'appeal' ? '核減申復' : '核減接受', `${c.month} ${nameOf.patient(c.patientId)} ${c.item} ${c.points} 點${input.text?.trim() ? `：${input.text.trim()}` : ''}`)
    return cutItem(c)
  })
}

/** 申復結果（申報組）：補付幾點（不超過核減的），或維持核減 */
export function recordCutResult(id: string, input: { outcome: 'paid' | 'upheld'; points?: number }): Promise<CutItem> {
  return mutate(() => {
    const u = requirePermission('nhi.claim')
    const c = must(db.claimCuts.find((x) => x.id === id), '核減')
    if (cutStatus(c) !== 'appealed') fail(c.result ? '已經記過結果了' : '醫師還沒申復', 'CONFLICT')
    if (input.outcome !== 'paid' && input.outcome !== 'upheld') failField('outcome', '請選補付或維持')
    const n = input.outcome === 'paid' ? Number(input.points) : 0
    if (input.outcome === 'paid' && (!Number.isFinite(n) || n <= 0 || n > c.points)) failField('points', `補付點數是 1–${c.points}`)
    c.result = { outcome: input.outcome, points: n, by: u.id, at: now() }
    audit('申復結果', `${c.month} ${nameOf.patient(c.patientId)} ${c.item}：${input.outcome === 'paid' ? `補付 ${n} 點` : '維持核減'}`)
    return cutItem(c)
  })
}

/**
 * 申請爭議審議（申報組）：申復維持核減、或只補付一部分，申復結果後 60 天內；點數是還沒補回的（全部），要寫理由
 * （通常引用主治的申復理由、補充病歷佐證）。一筆核減只能申請一次
 */
export function fileDispute(id: string, input: { reason: string }): Promise<CutItem> {
  return mutate(() => {
    const u = requirePermission('nhi.claim')
    const c = must(db.claimCuts.find((x) => x.id === id), '核減')
    const d = disputeCheck(c, today())
    if (!d.ok) fail(`不能申請爭議審議：${d.why}`, 'CONFLICT')
    if (!input.reason?.trim()) failField('reason', '請寫爭議理由（病情需要、病歷佐證、為什麼申復結果不合理）')
    c.dispute = { at: now(), by: u.id, reason: input.reason.trim(), points: disputeLeft(c) }
    audit('爭議審議申請', `${c.month} ${nameOf.patient(c.patientId)} ${c.item} ${c.dispute.points} 點：${c.dispute.reason}`)
    return cutItem(c)
  })
}

/** 爭議審議結果（申報組）：補付幾點（不超過申請的）或駁回（寫理由）；結果是最終的，不能再改 */
export function recordDisputeResult(id: string, input: { outcome: 'paid' | 'rejected'; points?: number; note?: string }): Promise<CutItem> {
  return mutate(() => {
    const u = requirePermission('nhi.claim')
    const c = must(db.claimCuts.find((x) => x.id === id), '核減')
    if (!c.dispute) fail('還沒申請爭議審議', 'CONFLICT')
    if (c.dispute!.result) fail('已經記過爭議審議結果了', 'CONFLICT')
    if (input.outcome !== 'paid' && input.outcome !== 'rejected') failField('outcome', '請選補付或駁回')
    const n = input.outcome === 'paid' ? Number(input.points) : 0
    if (input.outcome === 'paid' && (!Number.isFinite(n) || n <= 0 || n > c.dispute!.points)) failField('points', `補付點數是 1–${c.dispute!.points}`)
    if (input.outcome === 'rejected' && !input.note?.trim()) failField('note', '請寫駁回理由（審定書上的）')
    c.dispute!.result = { outcome: input.outcome, points: n, note: input.note?.trim() ?? '', by: u.id, at: now() }
    audit('爭議審議結果', `${c.month} ${nameOf.patient(c.patientId)} ${c.item}：${input.outcome === 'paid' ? `補付 ${n} 點` : `駁回（${input.note!.trim()}）`}`)
    return cutItem(c)
  })
}

// ---------- 核定通知整批匯入 ----------

export interface CutFilePreview {
  lines: { line: number; chartNo: string; date: string; item: string; points: number; codeLabel: string; reason: string; refId?: string; patientName?: string; left?: number; error?: string }[]
  ok: number
  bad: number
  points: number
}
/** 每一行對到送出申報的哪一筆（病歷號＋日期），檢查點數（同一筆多行時累計：不超過還能核減的） */
function resolveCutFile(s: ClaimSubmission, text: string): CutFilePreview {
  const used = new Map<string, number>()
  const lines = parseCutFile(text).map((x): CutFilePreview['lines'][number] => {
    const base = { line: x.line, chartNo: x.chartNo, date: x.date, item: x.item, points: x.points, codeLabel: x.error ? '' : `${x.code} ${CUT_REASONS.find((r) => r.code === x.code)?.label ?? ''}`, reason: x.reason }
    if (x.error) return { ...base, error: x.error }
    const hits = s.items.filter((i) => i.date === x.date && !i.supplementOf && find.patient(i.patientId)?.chartNo === x.chartNo)
    if (!hits.length) return { ...base, error: `這個月送出的申報裡找不到 ${x.chartNo} ${x.date}` }
    if (hits.length > 1) return { ...base, error: '同一天有兩筆以上，請到畫面上逐筆輸入' }
    const it = hits[0]
    if (s.rejects?.some((r) => r.refId === it.refId)) return { ...base, refId: it.refId, patientName: nameOf.patient(it.patientId), error: '這筆被退件了，不能核減' }
    const left = it.claim - cutPoints(s.id, it.refId) - (used.get(it.refId) ?? 0)
    const e = checkCut({ item: x.item, points: x.points, code: x.code }, left)
    const more = { refId: it.refId, patientName: nameOf.patient(it.patientId), left }
    if (Object.keys(e).length) return { ...base, ...more, error: Object.values(e)[0] }
    used.set(it.refId, (used.get(it.refId) ?? 0) + x.points)
    return { ...base, ...more }
  })
  const ok = lines.filter((l) => !l.error)
  return { lines, ok: ok.length, bad: lines.length - ok.length, points: ok.reduce((n, l) => n + l.points, 0) }
}

/** 預覽核定通知（不存） */
export function previewCutFile(submissionId: string, text: string): Promise<CutFilePreview> {
  return query(() => {
    requirePermission('nhi.claim')
    return resolveCutFile(must(subOf(submissionId), '送出的申報'), text)
  })
}

/** 匯入核定通知：沒問題的行各建一筆核減（主治首頁待回覆），有問題的略過；一行都不能建就擋 */
export function importCutFile(submissionId: string, text: string): Promise<{ created: number; skipped: number; points: number }> {
  return mutate(() => {
    const u = requirePermission('nhi.claim')
    const s = must(subOf(submissionId), '送出的申報')
    const pv = resolveCutFile(s, text)
    if (!pv.ok) fail(pv.lines.length ? '沒有可以輸入的核減（每一行都有問題，請看預覽）' : '檔案是空的', 'CONFLICT')
    const t = now()
    for (const l of pv.lines.filter((x) => !x.error)) {
      const it = s.items.find((x) => x.refId === l.refId)!
      db.claimCuts.push({ id: newId('CC'), submissionId: s.id, kind: s.kind, month: s.month, refId: it.refId, patientId: it.patientId, doctorId: it.doctorId, item: l.item, points: l.points, code: l.codeLabel.split(' ')[0], reason: l.reason, at: t, by: u.id })
    }
    audit('健保核減匯入', `${s.month} ${CLAIM_KIND_LABEL[s.kind]}：${pv.ok} 筆、${pv.points} 點${pv.bad ? `；略過 ${pv.bad} 行` : ''}`)
    return { created: pv.ok, skipped: pv.bad, points: pv.points }
  })
}
