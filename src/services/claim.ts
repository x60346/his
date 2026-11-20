// 健保申報：選月份 → 門診（含急診）或住院（含日間手術）每一筆的點數與送件前檢核 → 有問題的先改資料或註記排除 → 送出（月份要結束了）
// → 鎖定、匯出 CSV。送出後才改的（補收、作廢）不動原申報，差額列在下一個還沒送的月份「補報」。
// 點數直接用收據與住院帳單上已算好的健保點數（申請點數＝健保點數 − 部分負擔）；權限「健保申報」。規則在 claim-rules
import type { ClaimItem, ClaimKind, ClaimSubmission } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, mutate, query, requirePermission } from './http'
import { canSubmitMonth, claimCsv, claimXml, CLAIM_KIND_LABEL, monthOf } from './claim-rules'
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
}
export interface ClaimBoard {
  kind: ClaimKind
  month: string
  months: { month: string; submitted: boolean }[]
  submitted?: { at: string; byName: string }
  canSubmit: boolean
  /** 不能送的原因（月份還沒結束、已送、有問題沒處理） */
  whyNot?: string
  rows: ClaimBoardRow[]
  totals: { count: number; points: number; copay: number; claim: number; problems: number; excluded: number; supplement: number; /** 住院期中申報幾筆 */ interim: number; byCase: { caseType: string; label: string; count: number; claim: number }[]; /** 住院 DRG：適用幾筆、盈虧合計（給付 − 實際）、不適用幾筆、病例組合指數 */ drg?: { count: number; diff: number; exempt: number; cmi: number | null } }
}

const r2 = (n: number) => Math.round(n * 100) / 100
function decorate(r: ClaimRow, excluded?: { reason: string; by: string }): ClaimBoardRow {
  return {
    ...r, patientName: nameOf.patient(r.patientId), chartNo: find.patient(r.patientId)?.chartNo ?? '', doctorName: nameOf.doctor(r.doctorId), deptName: db.departments.find((d) => d.id === r.deptId)?.name ?? '',
    caseLabel: caseLabel(r.caseType), ...(excluded ? { excluded: { reason: excluded.reason, byName: nameOf.user(excluded.by) } } : {}),
  }
}

function boardOf(kind: ClaimKind, month: string): ClaimBoard {
  const t = today()
  const cur = monthOf(t)
  const sub = submissionOf(kind, month)
  const rows: ClaimBoardRow[] = sub
    ? [...sub.items.map((x) => decorate({ ...x, problems: [] })), ...sub.excluded.map((e) => decorate({ refId: e.refId, patientId: e.patientId, doctorId: '', deptId: '', date: e.date, caseType: '', diagnosis: '', points: 0, copay: 0, claim: 0, problems: [] }, e))]
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
    rows,
    totals: {
      count: live.length, points: r2(live.reduce((n, r) => n + r.points, 0)), copay: r2(live.reduce((n, r) => n + r.copay, 0)), claim: live.reduce((n, r) => n + r.claim, 0),
      problems, excluded: rows.length - live.length, supplement: live.filter((r) => r.supplementOf).length, interim: live.filter((r) => r.interim).length,
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
    if (row!.supplementOf) fail('補報的差額不能排除', 'CONFLICT')
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
