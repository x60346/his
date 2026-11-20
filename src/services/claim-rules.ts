// 健保申報（純函式）：月份、申請點數、補報差額、送件前檢核、核減率、CSV。
// 服務層（claim.ts）、申報頁、種子、測試都用這一份
import type { ChargeLine, ClaimCategory, ClaimItem, ClaimKind, Procedure } from '@/types'
import { drgPay } from './drg-rules'
import { addDays } from '@/utils/date'

export const CLAIM_KIND_LABEL: Record<ClaimKind, string> = { opd: '門診（含急診）', ipd: '住院（含日間手術）' }
export const CLAIM_CATEGORY_LABEL: Record<ClaimCategory, string> = {
  consult: '診察', ward: '病房', drug: '藥品', procedure: '處置', surgery: '手術麻醉', implant: '特材（植入物）', lab: '檢驗檢查', blood: '輸血', er: '急診', other: '其他',
}
export const CLAIM_CATEGORIES = Object.keys(CLAIM_CATEGORY_LABEL) as ClaimCategory[]

export const monthOf = (date: string) => date.slice(0, 7)
/** 下一個月「YYYY-MM」 */
export function nextMonth(m: string): string {
  const [y, mo] = m.split('-').map(Number)
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`
}
/** 住院期中申報：到月底已住滿幾天、還沒出院的，那個月先報（之後每月報增加的，出院那個月報剩下的差額） */
export const INTERIM_DAYS = 30
/** 這個月最後一天 */
export const monthEnd = (m: string) => {
  const d = new Date(`${nextMonth(m)}-01T00:00:00`)
  d.setDate(d.getDate() - 1)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
/** 到 m 月底住了幾天（入院那天算第 1 天）；月底前已出院、還沒入院的＝undefined */
export function interimDaysOf(a: { admittedAt?: string; dischargedAt?: string }, m: string): number | undefined {
  const end = monthEnd(m)
  if (!a.admittedAt || a.admittedAt.slice(0, 10) > end) return undefined
  if (a.dischargedAt && a.dischargedAt.slice(0, 10) <= end) return undefined
  return Math.round((new Date(`${end}T00:00:00`).getTime() - new Date(`${a.admittedAt.slice(0, 10)}T00:00:00`).getTime()) / 86400000) + 1
}

/** 月份要結束了才能送（這個月以前） */
export const canSubmitMonth = (month: string, today: string) => month < monthOf(today)

/** 申請點數＝健保點數 − 部分負擔（不會小於 0） */
export const claimOf = (points: number, copay: number) => Math.max(0, Math.round(points - copay))

/**
 * 住院申報點數：適用 DRG 的，申請點數＝DRG 給付 − 部分負擔；不適用的照實（健保點數 − 部分負擔）。
 * 服務層與種子都用這一份
 */
export function ipdClaimPoints(lp: { points: number; copay: number; claim: number }, drg: { code: string; name: string; points: number; lower: number; upper: number } | undefined, exempt: string | undefined): Pick<ClaimItem, 'claim' | 'drg' | 'drgExempt'> {
  if (exempt || !drg) return { claim: lp.claim, ...(exempt ? { drgExempt: exempt } : {}) }
  const p = drgPay(lp.points, drg)
  return { claim: claimOf(p.pay, lp.copay), drg: { code: drg.code, name: drg.name, points: drg.points, pay: p.pay, rule: p.rule, diff: p.diff } }
}

/** 一張（或幾張）收據的健保點數（不是病人自付的列）、部分負擔（copay 開頭的列）、申請點數 */
export function linePoints(lines: Pick<ChargeLine, 'kind' | 'amount' | 'patientPay'>[]): { points: number; copay: number; claim: number } {
  const r = (n: number) => Math.round(n * 100) / 100
  const points = r(lines.filter((l) => !l.patientPay).reduce((n, l) => n + l.amount, 0))
  const copay = r(lines.filter((l) => l.kind.startsWith('copay')).reduce((n, l) => n + l.amount, 0))
  return { points, copay, claim: claimOf(points, copay) }
}

/** 住院帳單的一列屬於哪一類（看主檔：檢驗影像、手術麻醉、植入物、輸血；病房費；藥；急診段） */
export function lineCategory(l: Pick<ChargeLine, 'kind' | 'name'>, p: Procedure | undefined): ClaimCategory {
  // 每日計費（病房費、護理費、住院診察費）帳單上都是 ward：診察費另歸診察
  if (l.kind === 'ward') return l.name.includes('診察') ? 'consult' : 'ward'
  if (l.kind === 'drug') return 'drug'
  if (l.kind === 'consult') return 'consult'
  if (!p) return l.name.includes('急診') ? 'er' : 'other'
  if (p.dailyFee) return p.name.includes('診察') ? 'consult' : 'ward'
  if (p.er) return 'er'
  if (p.surgery || p.anesthesiaFee) return 'surgery'
  if (p.implant) return 'implant'
  if (p.blood) return 'blood'
  if (p.category === '檢驗' || p.category === '影像') return 'lab'
  if (p.category === '診察') return 'consult'
  return 'procedure'
}
/** 住院帳單健保點數依類別加總 */
export function ipdCategories(lines: Pick<ChargeLine, 'kind' | 'name' | 'amount' | 'patientPay'>[], procByName: (name: string) => Procedure | undefined): Partial<Record<ClaimCategory, number>> {
  const out: Partial<Record<ClaimCategory, number>> = {}
  for (const l of lines.filter((x) => !x.patientPay)) {
    const c = lineCategory(l, procByName(l.name))
    out[c] = Math.round(((out[c] ?? 0) + l.amount) * 100) / 100
  }
  return out
}

/**
 * 補報：這一筆現在算出來的申請點數，和之前所有送出的（原申報＋補報）合計比，差多少；
 * 現在不能申報了（作廢）＝ current 為 undefined → 負的
 */
export function supplementDelta(current: Pick<ClaimItem, 'claim'> | undefined, submitted: Pick<ClaimItem, 'claim'>[]): number {
  const base = submitted.reduce((n, x) => n + x.claim, 0)
  return (current?.claim ?? 0) - base
}

/** 補報要列在哪個月：原本月份之後、第一個還沒送出的月份（不超過這個月） */
export function supplementMonth(original: string, submitted: (m: string) => boolean, current: string): string | undefined {
  for (let m = nextMonth(original); m <= current; m = nextMonth(m)) if (!submitted(m)) return m
  return undefined
}

/** 門診送件前檢核 */
export function opdClaimProblems(x: { diagnosis?: string; diagnosisActive?: boolean; points: number; duplicateOf?: string }): string[] {
  const out: string[] = []
  if (!x.diagnosis) out.push('沒有主診斷')
  else if (x.diagnosisActive === false) out.push('主診斷碼已停用')
  if (x.points <= 0) out.push('健保點數是 0（全自費的就醫請註記排除）')
  if (x.duplicateOf) out.push(`同一天同一科重複就醫（另一筆 ${x.duplicateOf}）`)
  return out
}

/** 住院送件前檢核 */
export function ipdClaimProblems(x: { coded?: boolean; day: boolean; diagnosis?: string; signed: boolean; implantMissing: string[]; preAuth?: string[]; daysBill?: number; daysActual: number; points: number }): string[] {
  const out: string[] = []
  if (x.coded === false) out.push('疾病分類編碼還沒審查（病歷室）')
  if (!x.diagnosis) out.push(x.day ? '沒有診斷' : '沒有出院主診斷（出院病摘）')
  else if (!x.day && !x.signed) out.push('出院病摘還沒有醫師簽署')
  if (x.implantMissing.length) out.push(`用了植入物但沒有登記批號：${x.implantMissing.join('、')}`)
  if (x.preAuth?.length) out.push(`用了需事前審查的項目、還沒核准：${x.preAuth.join('、')}`)
  if (x.daysBill !== undefined && x.daysBill !== x.daysActual) out.push(`住院天數不符（帳單 ${x.daysBill} 天、實際 ${x.daysActual} 天）`)
  if (x.points <= 0) out.push('健保點數是 0')
  return out
}

/** 核減率（%，一位小數）：核減點數 ÷ 申報點數 */
export const cutRate = (cut: number, claimed: number) => (claimed > 0 ? Math.round((cut / claimed) * 1000) / 10 : 0)

/** 匯出 CSV（每筆一列）：住院多各費用類別欄 */
export function claimCsv(kind: ClaimKind, rows: (ClaimItem & { patientName: string; chartNo: string; doctorName: string })[]): string {
  const cats = kind === 'ipd' ? CLAIM_CATEGORIES : []
  const head = ['就醫日', '案件', '病歷號', '病人', '醫師', '主診斷', ...(kind === 'ipd' ? ['天數'] : []), ...cats.map((c) => CLAIM_CATEGORY_LABEL[c]), '健保點數', '部分負擔', ...(kind === 'ipd' ? ['DRG', 'DRG 定額', 'DRG 給付', '盈虧', '不適用 DRG'] : []), '申請點數', '補報', '補報原因', ...(kind === 'ipd' ? ['期中申報到', '期中已報'] : [])]
  const esc = (v: unknown) => ((s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s))(String(v ?? ''))
  const lines = rows.map((r) => [r.date, r.caseType, r.chartNo, r.patientName, r.doctorName, r.diagnosis, ...(kind === 'ipd' ? [r.days ?? ''] : []), ...cats.map((c) => r.categories?.[c] ?? 0), r.points, r.copay, ...(kind === 'ipd' ? [r.drg?.code ?? '', r.drg?.points ?? '', r.drg?.pay ?? '', r.drg?.diff ?? '', r.drgExempt ?? ''] : []), r.claim, r.supplementOf ?? '', r.supplementNote ?? '', ...(kind === 'ipd' ? [r.interim?.through ?? '', r.interimPrior ?? ''] : [])].map(esc).join(','))
  return [head.join(','), ...lines].join('\n')
}

// ---------- 核減與申復 ----------

/** 健保署檢核退件代碼（示範用，簡化） */
export const CLAIM_REJECT_CODES: { code: string; label: string }[] = [
  { code: 'R01', label: '身分資料不符（身分證號、生日）' },
  { code: 'R02', label: '主診斷碼錯誤或不完整' },
  { code: 'R03', label: '重複申報' },
  { code: 'R04', label: '醫令或點數計算錯誤' },
  { code: 'R05', label: '缺必要欄位' },
]
export const rejectLabel = (code: string) => `${code} ${CLAIM_REJECT_CODES.find((r) => r.code === code)?.label ?? ''}`.trim()

/** 核減理由代碼（示範用，簡化） */
export const CUT_REASONS: { code: string; label: string }[] = [
  { code: '0101', label: '診斷與處置不符' },
  { code: '0213', label: '檢查（驗）與病情不符、非必要' },
  { code: '0302', label: '用藥不符適應症或劑量' },
  { code: '0501', label: '病歷記載不完整，無法支持申報' },
  { code: '0601', label: '住院日數過長' },
]
export type CutStatus = 'reply' | 'appealed' | 'accepted' | 'paid' | 'upheld' | 'disputed' | 'disputePaid' | 'disputeRejected'
export const CUT_STATUS_LABEL: Record<CutStatus, string> = { reply: '待醫師回覆', appealed: '申復中', accepted: '接受核減', paid: '申復補付', upheld: '維持核減', disputed: '爭議審議中', disputePaid: '爭議審議補付', disputeRejected: '爭議審議駁回' }
/** 畫面徽章顏色（申報組、醫師頁共用） */
export const CUT_STATUS_TONE = { reply: 'yellow', appealed: 'purple', accepted: 'gray', paid: 'green', upheld: 'red', disputed: 'purple', disputePaid: 'green', disputeRejected: 'red' } as const satisfies Record<CutStatus, string>
export function cutStatus(c: { reply?: { action: 'appeal' | 'accept' }; result?: { outcome: 'paid' | 'upheld' }; dispute?: { result?: { outcome: 'paid' | 'rejected' } } }): CutStatus {
  if (c.dispute) return !c.dispute.result ? 'disputed' : c.dispute.result.outcome === 'paid' ? 'disputePaid' : 'disputeRejected'
  if (!c.reply) return 'reply'
  if (c.reply.action === 'accept') return 'accepted'
  if (!c.result) return 'appealed'
  return c.result.outcome
}

// ---------- 爭議審議 ----------

/** 申復結果通知後幾天內可以申請爭議審議（全民健康保險爭議事項審議辦法：60 日） */
export const DISPUTE_DAYS = 60

/** 申復後還沒補回的點數（維持＝全部；部分補付＝剩下的） */
export const disputeLeft = (c: { points: number; result?: { outcome: 'paid' | 'upheld'; points: number } }) => (c.result ? c.points - (c.result.outcome === 'paid' ? c.result.points : 0) : 0)

/** 能不能申請爭議審議：申復有結果、還有沒補回的、沒申請過、在期限內（today 是 YYYY-MM-DD；deadline 給畫面看） */
export function disputeCheck(c: { points: number; result?: { outcome: 'paid' | 'upheld'; points: number; at: string }; dispute?: unknown }, today: string): { ok: boolean; why?: string; deadline?: string } {
  if (!c.result) return { ok: false, why: '申復還沒有結果' }
  const deadline = addDays(c.result.at.slice(0, 10), DISPUTE_DAYS)
  if (c.dispute) return { ok: false, why: '已經申請過爭議審議', deadline }
  if (disputeLeft(c) <= 0) return { ok: false, why: '申復已全額補付', deadline }
  if (today > deadline) return { ok: false, why: `超過爭議審議期限（${deadline}）`, deadline }
  return { ok: true, deadline }
}

/** 輸入核減：項目、點數（不超過這一筆還沒被核減的申請點數）、理由代碼 */
export function checkCut(input: { item?: string; points?: unknown; code?: string }, left: number): Record<string, string> {
  const e: Record<string, string> = {}
  if (!input.item?.trim()) e.item = '請寫核減的項目（例：胸部 X 光）'
  const n = Number(input.points)
  if (!Number.isFinite(n) || n <= 0) e.points = '核減點數要大於 0'
  else if (n > left) e.points = `這一筆最多還能核減 ${left} 點`
  if (!CUT_REASONS.some((r) => r.code === input.code)) e.code = '請選核減理由'
  return e
}

// ---------- 申報 XML（示範格式） ----------

/** 示範醫院（醫事機構代號是假的） */
export const CLAIM_HOSPITAL = { code: '0000000000', name: 'HIS 展示醫院' }

const xmlEsc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const attrs = (o: Record<string, unknown>) => Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && v !== null).map(([k, v]) => ` ${k}="${xmlEsc(v)}"`).join('')

/**
 * 申報 XML：表頭（醫院、月份、類別、送出狀態）＋總表＋每一筆（住院多費用類別、DRG、期中、補報）。
 * 示範用的簡化格式：欄位用好讀的英文名，不是健保署正式的 XML 欄位代碼（t1、d1…），也沒有電子簽章
 */
export function claimXml(kind: ClaimKind, month: string, rows: (ClaimItem & { patientName: string; chartNo: string; doctorName: string; idNo?: string })[], status: { submittedAt?: string; generatedAt: string }): string {
  const sum = (k: 'points' | 'copay' | 'claim') => Math.round(rows.reduce((n, r) => n + r[k], 0) * 100) / 100
  const head = `<?xml version="1.0" encoding="UTF-8"?>\n<!-- 示範格式：不是健保署正式申報格式，不能上傳 -->`
  const lines = rows.map((r, i) => {
    const a = attrs({
      seq: i + 1, refId: r.refId, date: r.date, caseType: r.caseType, chartNo: r.chartNo, idNo: r.idNo, name: r.patientName, doctor: r.doctorName, diagnosis: r.diagnosis,
      days: kind === 'ipd' ? r.days : undefined, points: r.points, copay: r.copay, claim: r.claim, supplementOf: r.supplementOf, supplementNote: r.supplementNote, interimThrough: r.interim?.through, interimPrior: r.interimPrior,
    })
    const cats = kind === 'ipd' ? CLAIM_CATEGORIES.filter((c) => r.categories?.[c]).map((c) => `      <category code="${c}" name="${xmlEsc(CLAIM_CATEGORY_LABEL[c])}" points="${r.categories![c]}"/>`) : []
    const drg = r.drg ? [`      <drg${attrs({ code: r.drg.code, name: r.drg.name, fixed: r.drg.points, pay: r.drg.pay, rule: r.drg.rule, diff: r.drg.diff })}/>`] : r.drgExempt ? [`      <drgExempt reason="${xmlEsc(r.drgExempt)}"/>`] : []
    const inner = [...cats, ...drg]
    return inner.length ? `    <case${a}>\n${inner.join('\n')}\n    </case>` : `    <case${a}/>`
  })
  return [
    head,
    `<claim${attrs({ kind, month, hospitalCode: CLAIM_HOSPITAL.code, hospitalName: CLAIM_HOSPITAL.name, status: status.submittedAt ? 'submitted' : 'draft', submittedAt: status.submittedAt, generatedAt: status.generatedAt })}>`,
    `  <summary${attrs({ count: rows.length, points: sum('points'), copay: sum('copay'), claim: sum('claim'), supplement: rows.filter((r) => r.supplementOf).length, interim: rows.filter((r) => r.interim).length })}/>`,
    `  <cases>`,
    ...lines,
    `  </cases>`,
    `</claim>`,
  ].join('\n')
}

// ---------- 檢核結果檔（退件）：每行「病歷號,就醫日（住院是出院日）,退件代碼,說明」；第一行是標題可以有可以沒有 ----------

export interface RejectFileLine {
  line: number
  chartNo: string
  date: string
  code: string
  note: string
  /** 這行格式本身的問題（找不找得到那筆由服務層判斷） */
  error?: string
}
export function parseRejectFile(text: string): RejectFileLine[] {
  const out: RejectFileLine[] = []
  ;(text ?? '').split(/\r?\n/).forEach((raw, i) => {
    const s = raw.trim()
    if (!s || s.startsWith('#') || (i === 0 && s.includes('病歷號'))) return
    // 說明欄可以有逗號：前三欄切開，剩下的原樣保留
    const parts = s.split(/[,\t]/)
    const [chartNo = '', date = '', code = ''] = parts.slice(0, 3).map((x) => x.trim())
    const note = parts.slice(3).join(s.includes('\t') ? '\t' : ',').trim()
    const x: RejectFileLine = { line: i + 1, chartNo, date, code: code.toUpperCase(), note }
    if (!chartNo || !date || !code) x.error = '欄位不足（要：病歷號,日期,代碼,說明）'
    else if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) x.error = `日期格式不對（${date}，要 YYYY-MM-DD）`
    else if (!CLAIM_REJECT_CODES.some((c) => c.code === x.code)) x.error = `退件代碼 ${code} 不認得`
    out.push(x)
  })
  return out
}
