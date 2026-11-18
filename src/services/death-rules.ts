// 死亡出院（純函式）：死因與死亡方式、宣告的檢查、遺體護理檢核項目、送太平間前要完成的事、預期死亡的判斷。
// 宣告死亡、遺體護理畫面、服務層、測試都用這一份
import type { BodyCareKey, DeathManner, DnrItem } from '@/types'

export const DEATH_MANNERS: { key: DeathManner; label: string }[] = [
  { key: 'natural', label: '病死或自然死' },
  { key: 'accident', label: '意外死' },
  { key: 'suicide', label: '自殺' },
  { key: 'homicide', label: '他殺' },
  { key: 'pending', label: '未確定（待司法相驗）' },
]
export const deathMannerLabel = (k?: DeathManner) => DEATH_MANNERS.find((m) => m.key === k)?.label ?? ''
/** 死因四層：甲（直接引起死亡）→ 丁（原始死因） */
export const CAUSE_LABELS = ['甲 直接引起死亡之疾病或傷害', '乙 甲之原因', '丙 乙之原因', '丁 丙之原因（原始死因）']

export const BODY_CARE_ITEMS: { key: BodyCareKey; label: string }[] = [
  { key: 'lines', label: '拔除管路（點滴、導管、氣管內管），傷口覆蓋' },
  { key: 'clean', label: '清潔遺體、更衣、擺位' },
  { key: 'family', label: '家屬告別（或已通知家屬）' },
  { key: 'valuables', label: '貴重物品、衣物點交家屬' },
  { key: 'tag', label: '遺體識別（腕帶、標籤）' },
]

/** 宣告的檢查：死因甲要寫、乙丙丁不能跳著寫、死亡方式要選、住院經過要寫、時間不能是未來或住院前 */
export function checkDeathInput(x: { causes?: string[]; manner?: string; course?: string; declaredAt?: string }, admittedAt: string | undefined, now: string): Record<string, string> {
  const e: Record<string, string> = {}
  const c = (x.causes ?? []).map((s) => s?.trim() ?? '')
  if (!c[0]) e.cause0 = '請寫直接引起死亡的疾病或傷害（甲）'
  const last = c.map((s, i) => (s ? i : -1)).reduce((m, i) => Math.max(m, i), -1)
  for (let i = 1; i < last; i++) if (!c[i]) e[`cause${i}`] = `${CAUSE_LABELS[i].slice(0, 1)}欄空白：死因要一層接一層寫（不能跳過）`
  if (!DEATH_MANNERS.some((m) => m.key === x.manner)) e.manner = '請選死亡方式'
  if (!x.course?.trim()) e.course = '請簡述住院經過（帶入出院病摘）'
  if (x.declaredAt) {
    if (x.declaredAt > now) e.declaredAt = '死亡時間不能是未來'
    else if (admittedAt && x.declaredAt < admittedAt) e.declaredAt = '死亡時間早於入院時間'
  }
  return e
}
/** 非自然死（意外、自殺、他殺、未確定）：要報請檢察官相驗，醫院不能直接開死亡證明書 */
export const needsProsecutor = (m?: DeathManner) => !!m && m !== 'natural'

/** 遺體護理：五項都要勾、貴重物品寫點交了什麼（沒有寫「無」） */
export function checkBodyCare(x: { items?: string[]; valuables?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  const missing = BODY_CARE_ITEMS.filter((i) => !x.items?.includes(i.key))
  if (missing.length) e.items = `還沒完成：${missing.map((i) => i.label.split('（')[0].split('，')[0]).join('、')}`
  if (!x.valuables?.trim()) e.valuables = '請寫點交的貴重物品（沒有寫「無」）'
  return e
}

/** 預期死亡：有 DNR（不施行心肺復甦術的任何一項）或安寧收案 */
export const isExpectedDeath = (dnr: DnrItem[] | undefined, palliative: boolean) => palliative || !!dnr?.some((i) => i !== 'feeding')

/** 送太平間前：遺體護理完成、死亡證明書開好（非自然死要相驗，不開）；還有沒結束的事（PCA、輸血）另外擋 */
export function morgueProblem(d: { care?: unknown; cert?: unknown; manner: DeathManner }): string | undefined {
  if (!d.care) return '遺體護理還沒完成'
  if (!d.cert && !needsProsecutor(d.manner)) return '死亡證明書還沒開：請醫師先開立（家屬辦後事要用）'
  return undefined
}
