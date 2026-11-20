// 健保申報（純函式）：月份、申請點數、補報差額、送件前檢核、核減率、CSV。
// 服務層（claim.ts）、申報頁、種子、測試都用這一份
import type { ChargeLine, ClaimCategory, ClaimItem, ClaimKind, Procedure } from '@/types'

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
/** 月份要結束了才能送（這個月以前） */
export const canSubmitMonth = (month: string, today: string) => month < monthOf(today)

/** 申請點數＝健保點數 − 部分負擔（不會小於 0） */
export const claimOf = (points: number, copay: number) => Math.max(0, Math.round(points - copay))

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
export function ipdClaimProblems(x: { day: boolean; diagnosis?: string; signed: boolean; implantMissing: string[]; daysBill?: number; daysActual: number; points: number }): string[] {
  const out: string[] = []
  if (!x.diagnosis) out.push(x.day ? '沒有診斷' : '沒有出院主診斷（出院病摘）')
  else if (!x.day && !x.signed) out.push('出院病摘還沒有醫師簽署')
  if (x.implantMissing.length) out.push(`用了植入物但沒有登記批號：${x.implantMissing.join('、')}`)
  if (x.daysBill !== undefined && x.daysBill !== x.daysActual) out.push(`住院天數不符（帳單 ${x.daysBill} 天、實際 ${x.daysActual} 天）`)
  if (x.points <= 0) out.push('健保點數是 0')
  return out
}

/** 核減率（%，一位小數）：核減點數 ÷ 申報點數 */
export const cutRate = (cut: number, claimed: number) => (claimed > 0 ? Math.round((cut / claimed) * 1000) / 10 : 0)

/** 匯出 CSV（每筆一列）：住院多各費用類別欄 */
export function claimCsv(kind: ClaimKind, rows: (ClaimItem & { patientName: string; chartNo: string; doctorName: string })[]): string {
  const cats = kind === 'ipd' ? CLAIM_CATEGORIES : []
  const head = ['就醫日', '案件', '病歷號', '病人', '醫師', '主診斷', ...(kind === 'ipd' ? ['天數'] : []), ...cats.map((c) => CLAIM_CATEGORY_LABEL[c]), '健保點數', '部分負擔', '申請點數', '補報']
  const esc = (v: unknown) => ((s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s))(String(v ?? ''))
  const lines = rows.map((r) => [r.date, r.caseType, r.chartNo, r.patientName, r.doctorName, r.diagnosis, ...(kind === 'ipd' ? [r.days ?? ''] : []), ...cats.map((c) => r.categories?.[c] ?? 0), r.points, r.copay, r.claim, r.supplementOf ?? ''].map(esc).join(','))
  return [head.join(','), ...lines].join('\n')
}

// ---------- 核減與申復 ----------

/** 核減理由代碼（示範用，簡化） */
export const CUT_REASONS: { code: string; label: string }[] = [
  { code: '0101', label: '診斷與處置不符' },
  { code: '0213', label: '檢查（驗）與病情不符、非必要' },
  { code: '0302', label: '用藥不符適應症或劑量' },
  { code: '0501', label: '病歷記載不完整，無法支持申報' },
  { code: '0601', label: '住院日數過長' },
]
export type CutStatus = 'reply' | 'appealed' | 'accepted' | 'paid' | 'upheld'
export const CUT_STATUS_LABEL: Record<CutStatus, string> = { reply: '待醫師回覆', appealed: '申復中', accepted: '接受核減', paid: '申復補付', upheld: '維持核減' }
export function cutStatus(c: { reply?: { action: 'appeal' | 'accept' }; result?: { outcome: 'paid' | 'upheld' } }): CutStatus {
  if (!c.reply) return 'reply'
  if (c.reply.action === 'accept') return 'accepted'
  if (!c.result) return 'appealed'
  return c.result.outcome
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
