// 健保申報：選月份 → 門診（含急診）或住院（含日間手術）每一筆的點數與送件前檢核 → 有問題的先改資料或註記排除 → 送出（月份要結束了）
// → 鎖定、匯出 CSV。送出後才改的（補收、作廢）不動原申報，差額列在下一個還沒送的月份「補報」。
// 點數直接用收據與住院帳單上已算好的健保點數（申請點數＝健保點數 − 部分負擔）；權限「健保申報」。規則在 claim-rules
import type { ClaimItem, ClaimKind, ClaimSubmission } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, mutate, query, requirePermission } from './http'
import { canSubmitMonth, claimCsv, claimDeadlineOf, claimXml, daysUntil, deadlineText, CLAIM_KIND_LABEL, CLAIM_REJECT_CODES, monthOf, parseRejectFile, rejectLabel } from './claim-rules'
import { claimMonthsOf, openMonthRows, submissionOf, type ClaimRow } from './claim-work'
import { caseTypes } from '@/mock/codes'
import { DRG_TABLE } from './drg-rules'
import { cmiOf } from './management-rules'
import { find, nameOf } from './views'

const KIND = (k: string): ClaimKind => (k === 'opd' || k === 'ipd' ? k : fail('申報類別不對', 'BAD_REQUEST'))
const MONTH = (m: string) => (/^\d{4}-\d{2}$/.test(m ?? '') ? m : fail('月份不對', 'BAD_REQUEST'))
const caseLabel = (c: string) => (c === 'IPD' ? '住院' : c === 'DAY' ? '日間手術' : `${c} ${caseTypes.find((x) => x.code === c)?.name ?? ''}`.trim())

export interface ClaimBoardRow extends ClaimRow {
  patientName: string
  chartNo: string
  doctorName: string
  deptName: string
  caseLabel: string
  excluded?: { reason: string; byName: string }
  /** 送出後被健保署退件 */
  rejected?: { code: string; label: string; note: string; byName: string; at: string }
  /** 還能記退件／取消退件（之後的月份還沒把這筆送出去） */
  canReject?: boolean
}
export interface ClaimBoard {
  kind: ClaimKind
  month: string
  months: { month: string; submitted: boolean }[]
  submitted?: { at: string; byName: string }
  canSubmit: boolean
  /** 不能送的原因（月份還沒結束、已送、有問題沒處理） */
  whyNot?: string
  /** 送件期限（月份結束、還沒送的才有）：下個月 20 日 */
  deadline?: { due: string; text: string; overdue: boolean; soon: boolean }
  rows: ClaimBoardRow[]
  totals: { count: number; points: number; copay: number; claim: number; problems: number; excluded: number; supplement: number; /** 住院期中申報幾筆 */ interim: number; /** 送出後被退件幾筆、幾點 */ rejected: number; rejectedClaim: number; byCase: { caseType: string; label: string; count: number; claim: number }[]; /** 住院 DRG：適用幾筆、盈虧合計（給付 − 實際）、不適用幾筆、病例組合指數 */ drg?: { count: number; diff: number; exempt: number; cmi: number | null } }
}

const r2 = (n: number) => Math.round(n * 100) / 100
function decorate(r: ClaimRow, excluded?: { reason: string; by: string }): ClaimBoardRow {
  return {
    ...r, patientName: nameOf.patient(r.patientId), chartNo: find.patient(r.patientId)?.chartNo ?? '', doctorName: nameOf.doctor(r.doctorId), deptName: db.departments.find((d) => d.id === r.deptId)?.name ?? '',
    caseLabel: caseLabel(r.caseType), ...(excluded ? { excluded: { reason: excluded.reason, byName: nameOf.user(excluded.by) } } : {}),
  }
}

/** 這筆送出之後，有沒有更後面的月份又送過（重送或補報）：有就不能再改退件 */
const sentLater = (s: ClaimSubmission, refId: string) => db.claimSubmissions.some((x) => x.kind === s.kind && x.month > s.month && x.items.some((i) => i.refId === refId))
function withReject(s: ClaimSubmission, r: ClaimBoardRow): ClaimBoardRow {
  const j = s.rejects?.find((x) => x.refId === r.refId)
  return { ...r, ...(j ? { rejected: { code: j.code, label: rejectLabel(j.code), note: j.note, byName: nameOf.user(j.by), at: j.at } } : {}), canReject: !sentLater(s, r.refId) }
}

function boardOf(kind: ClaimKind, month: string): ClaimBoard {
  const t = today()
  const cur = monthOf(t)
  const sub = submissionOf(kind, month)
  const rows: ClaimBoardRow[] = sub
    ? [...sub.items.map((x) => withReject(sub, decorate({ ...x, problems: [] }))), ...sub.excluded.map((e) => decorate({ refId: e.refId, patientId: e.patientId, doctorId: '', deptId: '', date: e.date, caseType: '', diagnosis: '', points: 0, copay: 0, claim: 0, problems: [] }, e))]
    : openMonthRows(kind, month, cur).map((r) => decorate(r, db.claimExclusions.find((x) => x.kind === kind && x.month === month && x.refId === r.refId)))
  const live = rows.filter((r) => !r.excluded)
  const problems = live.filter((r) => r.problems.length).length
  const cases = [...new Set(live.map((r) => r.caseType))].sort()
  const whyNot = sub ? '已經送出' : !canSubmitMonth(month, t) ? '月份還沒結束，下個月才能送' : problems ? `還有 ${problems} 筆檢核有問題：請先改資料，或註記排除` : !live.length ? '這個月沒有要申報的' : undefined
  return {
    kind, month,
    months: claimMonthsOf(kind, cur).map((m) => ({ month: m, submitted: !!submissionOf(kind, m) })),
    ...(sub ? { submitted: { at: sub.submittedAt, byName: nameOf.user(sub.submittedBy) } } : {}),
    canSubmit: !whyNot, ...(whyNot ? { whyNot } : {}),
    ...(!sub && canSubmitMonth(month, t) ? ((due) => ({ deadline: { due, text: deadlineText(due, t), overdue: daysUntil(due, t) < 0, soon: daysUntil(due, t) <= 5 } }))(claimDeadlineOf(month)) : {}),
    rows,
    totals: {
      count: live.length, points: r2(live.reduce((n, r) => n + r.points, 0)), copay: r2(live.reduce((n, r) => n + r.copay, 0)), claim: live.reduce((n, r) => n + r.claim, 0),
      problems, excluded: rows.length - live.length, supplement: live.filter((r) => r.supplementOf).length, interim: live.filter((r) => r.interim).length, rejected: live.filter((r) => r.rejected).length, rejectedClaim: live.filter((r) => r.rejected).reduce((n, r) => n + r.claim, 0),
      byCase: cases.map((c) => ({ caseType: c, label: caseLabel(c), count: live.filter((r) => r.caseType === c).length, claim: live.filter((r) => r.caseType === c).reduce((n, r) => n + r.claim, 0) })),
      ...(kind === 'ipd' ? { drg: { count: live.filter((r) => r.drg && !r.supplementOf).length, diff: live.filter((r) => !r.supplementOf).reduce((n, r) => n + (r.drg?.diff ?? 0), 0), exempt: live.filter((r) => r.drgExempt).length, cmi: cmiOf(live.filter((r) => r.drg && !r.supplementOf).map((r) => DRG_TABLE.find((g) => g.code === r.drg!.code)?.weight ?? 0)) } } : {}),
    },
  }
}

/** 申報頁：這個月（沒給＝最近一個還沒送、已經結束的月份；都送了就是這個月） */
export function claimBoard(kind: string, month?: string): Promise<ClaimBoard> {
  return query(() => {
    requirePermission('nhi.claim')
    const k = KIND(kind)
    const cur = monthOf(today())
    const m = month ? MONTH(month) : (claimMonthsOf(k, cur).filter((x) => x < cur && !submissionOf(k, x))[0] ?? cur)
    return boardOf(k, m)
  })
}

/** 註記排除（送出前）：這筆這個月不申報，寫原因；補報的不能排除（差額一定要報） */
export function excludeClaim(kind: string, month: string, refId: string, reason: string): Promise<ClaimBoard> {
  return mutate(() => {
    const u = requirePermission('nhi.claim')
    const k = KIND(kind)
    const m = MONTH(month)
    if (submissionOf(k, m)) fail('這個月已經送出，不能再改', 'CONFLICT')
    const row = openMonthRows(k, m, monthOf(today())).find((r) => r.refId === refId)
    if (!row) fail('這筆不在這個月的申報清單', 'NOT_FOUND')
    // 補報的差額一定要報；退件重送的可以排除（放棄申報，例：查證後確實不該報）
    if (row!.supplementOf && !row!.supplementNote?.startsWith('退件重送')) fail('補報的差額不能排除', 'CONFLICT')
    if (db.claimExclusions.some((x) => x.kind === k && x.month === m && x.refId === refId)) fail('已經註記排除了', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫排除原因（例：病人改自費、重複掛號已退費）')
    db.claimExclusions.push({ id: newId('CX'), kind: k, month: m, refId, reason: reason.trim(), by: u.id, at: now() })
    audit('申報註記排除', `${CLAIM_KIND_LABEL[k]} ${m}：${nameOf.patient(row!.patientId)} ${row!.date}（${reason.trim()}）`)
    return boardOf(k, m)
  })
}

export function unexcludeClaim(kind: string, month: string, refId: string): Promise<ClaimBoard> {
  return mutate(() => {
    requirePermission('nhi.claim')
    const k = KIND(kind)
    const m = MONTH(month)
    if (submissionOf(k, m)) fail('這個月已經送出，不能再改', 'CONFLICT')
    const i = db.claimExclusions.findIndex((x) => x.kind === k && x.month === m && x.refId === refId)
    if (i < 0) fail('這筆沒有註記排除', 'CONFLICT')
    db.claimExclusions.splice(i, 1)
    audit('申報取消排除', `${CLAIM_KIND_LABEL[k]} ${m}：${refId}`)
    return boardOf(k, m)
  })
}

/** 送出（月份結束後；檢核有問題的都要先處理或排除）：鎖定這個月 */
export function submitClaim(kind: string, month: string): Promise<ClaimBoard> {
  return mutate(() => {
    const u = requirePermission('nhi.claim')
    const k = KIND(kind)
    const m = MONTH(month)
    const b = boardOf(k, m)
    if (!b.canSubmit) fail(b.whyNot ?? '不能送出', 'CONFLICT')
    const strip = ({ problems: _p, ...x }: ClaimRow): ClaimItem => x
    const live = openMonthRows(k, m, monthOf(today()))
    const ex = db.claimExclusions.filter((x) => x.kind === k && x.month === m)
    const s: ClaimSubmission = {
      id: newId('CS'), kind: k, month: m, submittedAt: now(), submittedBy: u.id,
      items: live.filter((r) => !ex.some((x) => x.refId === r.refId)).map(strip),
      excluded: ex.map((x) => ((r) => ({ refId: x.refId, patientId: r?.patientId ?? '', date: r?.date ?? '', reason: x.reason, by: x.by, at: x.at }))(live.find((r) => r.refId === x.refId))),
    }
    db.claimSubmissions.push(s)
    db.claimExclusions = db.claimExclusions.filter((x) => !(x.kind === k && x.month === m))
    audit('健保申報送出', `${CLAIM_KIND_LABEL[k]} ${m}：${s.items.length} 筆、申請 ${s.items.reduce((n, x) => n + x.claim, 0)} 點${s.excluded.length ? `、排除 ${s.excluded.length} 筆` : ''}`)
    return boardOf(k, m)
  })
}

/**
 * 記健保署檢核退件（送出的月份、那一筆、退件代碼、說明）：退件的不算申報過，資料改好後自動列在下一個還沒送的月份「退件重送」（會重新檢核）。
 * 之後的月份已經把這筆送出去了就不能再改
 */
export function rejectClaimItem(kind: string, month: string, refId: string, input: { code: string; note?: string }): Promise<ClaimBoard> {
  return mutate(() => {
    const u = requirePermission('nhi.claim')
    const k = KIND(kind)
    const m = MONTH(month)
    const s = submissionOf(k, m)
    if (!s) fail('這個月還沒送出：送出後才有檢核結果', 'CONFLICT')
    const it = s!.items.find((x) => x.refId === refId)
    if (!it) fail('這筆不在這個月送出的申報裡', 'NOT_FOUND')
    if (s!.rejects?.some((x) => x.refId === refId)) fail('已經記過退件了', 'CONFLICT')
    if (sentLater(s!, refId)) fail('之後的月份已經重送或補報這筆，不能再記退件', 'CONFLICT')
    if (!CLAIM_REJECT_CODES.some((c) => c.code === input.code)) failField('code', '請選退件代碼')
    if (db.claimCuts.some((c) => c.submissionId === s!.id && c.refId === refId)) fail('這筆已經有核減紀錄：退件和核減不會同時發生，請確認', 'CONFLICT')
    ;(s!.rejects ??= []).push({ refId, code: input.code, note: input.note?.trim() ?? '', by: u.id, at: now() })
    audit('健保申報退件', `${CLAIM_KIND_LABEL[k]} ${m}：${nameOf.patient(it!.patientId)} ${it!.date} ${it!.claim} 點（${rejectLabel(input.code)}${input.note?.trim() ? `，${input.note.trim()}` : ''}）`)
    return boardOf(k, m)
  })
}

export interface RejectFilePreview {
  lines: { line: number; chartNo: string; date: string; code: string; codeLabel: string; note: string; refId?: string; patientName?: string; claim?: number; error?: string }[]
  ok: number
  bad: number
}
/** 檢核結果檔每一行對到送出申報的哪一筆（病歷號＋日期），能不能記退件 */
function resolveRejectFile(s: ClaimSubmission, text: string): RejectFilePreview {
  const seen = new Set<string>()
  const lines = parseRejectFile(text).map((x) => {
    const base = { line: x.line, chartNo: x.chartNo, date: x.date, code: x.code, codeLabel: x.error ? '' : rejectLabel(x.code), note: x.note }
    if (x.error) return { ...base, error: x.error }
    const hits = s.items.filter((i) => i.date === x.date && find.patient(i.patientId)?.chartNo === x.chartNo)
    const it = hits.length > 1 ? hits.filter((i) => !i.supplementOf) : hits
    if (!it.length) return { ...base, error: `這個月送出的申報裡找不到 ${x.chartNo} ${x.date}` }
    if (it.length > 1) return { ...base, error: '同一天有兩筆以上，請到畫面上逐筆記' }
    const r = it[0]
    const more = { refId: r.refId, patientName: nameOf.patient(r.patientId), claim: r.claim }
    const why = seen.has(r.refId) ? '檔案裡重複' : s.rejects?.some((j) => j.refId === r.refId) ? '已經記過退件' : sentLater(s, r.refId) ? '之後的月份已經重送或補報這筆' : db.claimCuts.some((c) => c.submissionId === s.id && c.refId === r.refId) ? '這筆已經有核減紀錄' : undefined
    seen.add(r.refId)
    return { ...base, ...more, ...(why ? { error: why } : {}) }
  })
  return { lines, ok: lines.filter((l) => !l.error).length, bad: lines.filter((l) => l.error).length }
}

/** 預覽檢核結果檔（不存）：每行對到哪一筆、哪些行有問題 */
export function previewRejectFile(kind: string, month: string, text: string): Promise<RejectFilePreview> {
  return query(() => {
    requirePermission('nhi.claim')
    const s = submissionOf(KIND(kind), MONTH(month))
    if (!s) fail('這個月還沒送出：送出後才有檢核結果', 'CONFLICT')
    return resolveRejectFile(s!, text)
  })
}

/** 匯入檢核結果檔：只記沒問題的行（有問題的略過，回傳結果讓畫面列出）；一行都沒有可以記的就擋 */
export function importRejectFile(kind: string, month: string, text: string): Promise<{ board: ClaimBoard; preview: RejectFilePreview }> {
  return mutate(() => {
    const u = requirePermission('nhi.claim')
    const k = KIND(kind)
    const m = MONTH(month)
    const s = submissionOf(k, m)
    if (!s) fail('這個月還沒送出：送出後才有檢核結果', 'CONFLICT')
    const pv = resolveRejectFile(s!, text)
    if (!pv.ok) fail(pv.lines.length ? '沒有可以記的退件（每一行都有問題，請看預覽）' : '檔案是空的', 'CONFLICT')
    const t = now()
    for (const l of pv.lines.filter((x) => !x.error)) (s!.rejects ??= []).push({ refId: l.refId!, code: l.code, note: l.note, by: u.id, at: t })
    audit('健保申報退件匯入', `${CLAIM_KIND_LABEL[k]} ${m}：記 ${pv.ok} 筆${pv.bad ? `、略過 ${pv.bad} 行` : ''}`)
    return { board: boardOf(k, m), preview: pv }
  })
}

/** 取消退件（記錯了）：之後的月份還沒送出這筆才行 */
export function unrejectClaimItem(kind: string, month: string, refId: string): Promise<ClaimBoard> {
  return mutate(() => {
    requirePermission('nhi.claim')
    const k = KIND(kind)
    const m = MONTH(month)
    const s = submissionOf(k, m)
    const i = s?.rejects?.findIndex((x) => x.refId === refId) ?? -1
    if (!s || i < 0) fail('這筆沒有記退件', 'CONFLICT')
    if (sentLater(s!, refId)) fail('之後的月份已經重送這筆，不能取消退件', 'CONFLICT')
    s!.rejects!.splice(i, 1)
    audit('健保申報取消退件', `${CLAIM_KIND_LABEL[k]} ${m}：${refId}`)
    return boardOf(k, m)
  })
}

/** 匯出 XML（示範格式；還沒送的標 draft、排除的不列；帶身分證號，所以留稽核——用 mutate 才存得下稽核） */
export function claimXmlOf(kind: string, month: string): Promise<{ filename: string; xml: string }> {
  return mutate(() => {
    requirePermission('nhi.claim')
    const k = KIND(kind)
    const m = MONTH(month)
    const b = boardOf(k, m)
    const rows = b.rows.filter((r) => !r.excluded).map((r) => ({ ...r, idNo: find.patient(r.patientId)?.idNo ?? '' }))
    const sub = submissionOf(k, m)
    audit('健保申報匯出 XML', `${CLAIM_KIND_LABEL[k]} ${m}：${rows.length} 筆${sub ? '' : '（草稿）'}`)
    return { filename: `健保申報_${k === 'opd' ? '門診' : '住院'}_${m}${sub ? '' : '_草稿'}.xml`, xml: claimXml(k, m, rows, { ...(sub ? { submittedAt: sub.submittedAt } : {}), generatedAt: now() }) }
  })
}

/** 匯出 CSV（送出的月份照送出那份；還沒送的照現在算的，排除的不列） */
export function claimCsvOf(kind: string, month: string): Promise<{ filename: string; csv: string }> {
  return query(() => {
    requirePermission('nhi.claim')
    const k = KIND(kind)
    const m = MONTH(month)
    const rows = boardOf(k, m).rows.filter((r) => !r.excluded)
    return { filename: `健保申報_${k === 'opd' ? '門診' : '住院'}_${m}.csv`, csv: claimCsv(k, rows) }
  })
}
