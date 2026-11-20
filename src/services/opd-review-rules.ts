// 門診病歷品質抽審（純函式）：審查項目、分數、每位醫師抽幾份、怎麼抽（固定的方式，同一個月重抽結果一樣）。
// 服務層（opd-review.ts）、畫面、測試共用
export const OPD_REVIEW_ITEMS: { key: string; label: string }[] = [
  { key: 'subjective', label: '主訴與病史（S）記載完整' },
  { key: 'objective', label: '理學檢查、生命徵象（O）有記載' },
  { key: 'assessment', label: '評估（A）與診斷相符' },
  { key: 'plan', label: '處置計畫（P）有記載' },
  { key: 'rx', label: '用藥、檢查與診斷相符' },
  { key: 'icd', label: '診斷碼正確、完整' },
]
/** 每位醫師每月抽幾份 */
export const OPD_REVIEW_PER_DOCTOR = 2

/** 分數（%）：符合的項目 ÷ 全部 */
export const opdReviewScore = (items: Record<string, boolean>) => Math.round((OPD_REVIEW_ITEMS.filter((i) => items[i.key]).length / OPD_REVIEW_ITEMS.length) * 100)
/** 不符合的項目 */
export const opdReviewFails = (items: Record<string, boolean>) => OPD_REVIEW_ITEMS.filter((i) => items[i.key] === false).map((i) => i.label)

/** 抽樣：每位醫師依病歷 id 的雜湊排序取前 n 份（不用亂數：同一個月重看結果一樣，也不偏向早看的病人） */
export function sampleEncounters<T extends { id: string; doctorId: string }>(xs: T[], n: number): T[] {
  const h = (s: string) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)
  const byDoc = new Map<string, T[]>()
  for (const x of xs) byDoc.set(x.doctorId, [...(byDoc.get(x.doctorId) ?? []), x])
  return [...byDoc.values()].flatMap((g) => g.sort((a, b) => h(a.id) - h(b.id) || a.id.localeCompare(b.id)).slice(0, n))
}

/** 審查輸入：每一項都要選 */
export function checkOpdReview(items: Record<string, unknown>): string | undefined {
  const miss = OPD_REVIEW_ITEMS.filter((i) => typeof items[i.key] !== 'boolean')
  return miss.length ? `還有 ${miss.length} 項沒選：${miss.map((i) => i.label).join('、')}` : undefined
}
