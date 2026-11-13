// 藥品主檔的同名判斷（純函式）：主檔頁面送出前的確認與服務層共用。
//
// 真實醫院裡同名藥是正常的：同成分不同廠牌、換供應商的新舊並存期。參照的 jian-HIS 以院內代碼識別藥品，
// 藥名可以重複。但這個展示系統沒有廠牌、中文名欄位，醫師開藥時只看得到藥名——同名兩筆就分不出來。
// 所以不直接擋，而是「提醒並要求確認」（和劑量偏高、重複開立同一種藥的確認方式一致）。
import type { Drug, DrugTiming, PriceChange } from '@/types'
import { applyChange, nextChange, valueOn } from './dated-rules'

/** 比對用的藥名：去頭尾空白、連續空白視為一個、不分大小寫（「acetaminophen  500MG」與「Acetaminophen 500mg」同名） */
export function normalizeDrugName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 與 name 同名的其他藥品（含已停用的；selfId 是正在修改的那一筆，排除自己） */
export function sameNameDrugs<T extends Pick<Drug, 'id' | 'name'>>(drugs: readonly T[], name: string, selfId?: string): T[] {
  const key = normalizeDrugName(name)
  if (!key) return []
  return drugs.filter((d) => d.id !== selfId && normalizeDrugName(d.name) === key)
}

/**
 * 這次儲存需不需要同名確認：只有「新增」或「改了藥名」才需要。
 * 已經同名的舊資料（例如確認過的同成分不同廠牌），之後改其他欄位、停用，都不必每次再確認一次。
 */
export function needsSameNameCheck(oldName: string | undefined, newName: string): boolean {
  return oldName === undefined || normalizeDrugName(oldName) !== normalizeDrugName(newName)
}

/** 給人看的清單，例：「M001（使用中）、M041（停用中）」 */
export function describeDrugs(drugs: readonly Pick<Drug, 'id' | 'active'>[]): string {
  return drugs.map((d) => `${d.id}（${d.active === false ? '停用中' : '使用中'}）`).join('、')
}

// ---------- 服用時機 ----------
// 以前藥袋一律印「飯後服用」（寫在藥袋元件裡的簡化規則）：Omeprazole 要飯前、Levothyroxine 要空腹，印成飯後藥效打折。
// 現在是藥品主檔的欄位，文字由這裡統一產生，藥袋與藥局處方表共用。

export const TIMING_LABEL: Record<DrugTiming, string> = {
  AC: '飯前 30 分鐘服用',
  PC: '飯後服用',
  WITH: '隨餐服用',
  EMPTY: '早餐前 30–60 分鐘空腹服用',
  ANY: '飯前飯後皆可',
}
/** 藥局處方表用的短字 */
export const TIMING_SHORT: Record<DrugTiming, string> = { AC: '飯前', PC: '飯後', WITH: '隨餐', EMPTY: '空腹', ANY: '飯前飯後皆可' }
export const DRUG_TIMINGS = Object.keys(TIMING_LABEL) as DrugTiming[]

/** 頻率本身已經說明時機，不再加註（避免「睡前・飯後服用」這種矛盾） */
const FREQ_SAYS_WHEN = ['HS', 'PRN', 'STAT']

/**
 * 這一筆處方要印的服用時機；不必印回傳空字串。
 * 只有口服才有飯前飯後之分；頻率是睡前、需要時、立即的不印。
 * 「飯前飯後皆可」也印：以前全部印「飯後」，突然不印病人反而會問。
 */
export function timingText(timing: DrugTiming | undefined, freq: string, route: string, short = false): string {
  if (!timingApplies(freq, route)) return ''
  return (short ? TIMING_SHORT : TIMING_LABEL)[timing ?? 'ANY']
}

/** 這個頻率與途徑有沒有「飯前飯後」可言：口服、而且頻率本身沒說明時機。醫師開藥列的時機選單也看這條 */
export function timingApplies(freq: string | undefined, route: string | undefined): boolean {
  return route === 'PO' && !!freq && !FREQ_SAYS_WHEN.includes(freq)
}

// ---------- 單一處方改服用時機 ----------
// 醫師可以為這一筆處方指定時機（例：這位病人的 Metformin 改飯後，因為飯前吃胃不舒服）。
// 門診處方只存「指定」（沒存＝照主檔）：組套、同前次會複製處方，若連主檔值一起存，主檔之後改了，複製出去的還是舊值。

/** 這筆處方實際的服用時機：醫師指定優先，否則照主檔 */
export function effectiveTiming(drugTiming: DrugTiming | undefined, rxTiming: DrugTiming | undefined): DrugTiming {
  return rxTiming ?? drugTiming ?? 'ANY'
}

/**
 * 存檔前整理醫師指定的時機：不適用（非口服、睡前／需要時／立即）或和主檔一樣的就不存——
 * 存了也印不出來、或只是把主檔值凍結住。回傳要存的值（undefined＝不存）；不認得的值回傳 'invalid'
 */
export function normalizeRxTiming(drugTiming: DrugTiming | undefined, rx: { timing?: DrugTiming | ''; freq: string; route: string }): DrugTiming | undefined | 'invalid' {
  if (!rx.timing) return undefined
  if (!DRUG_TIMINGS.includes(rx.timing)) return 'invalid'
  if (!timingApplies(rx.freq, rx.route) || rx.timing === (drugTiming ?? 'ANY')) return undefined
  return rx.timing
}

// ---------- 住院給藥時間 ----------
// 以前一律照頻率的固定時間（TID＝09:00、13:00、17:00），飯前藥排在 09:00，病人早就吃完早餐了。
// 現在「一天幾次」的頻率（QD／BID／TID／QID）對齊病房的用餐時間；間隔型（Q6H、Q8H、Q12H）是為了血中濃度，照固定間隔；
// 睡前、需要時、立即本身就說明了時機。非口服不分飯前飯後。

/** 病房用餐時間（全院一套） */
export const WARD_MEALS = { breakfast: '07:30', lunch: '12:00', dinner: '17:30' } as const
const BEDTIME = '21:00'
/** 各時機對應早、午、晚三餐的給藥時間 */
const MEAL_SLOTS: Partial<Record<DrugTiming, [string, string, string]>> = {
  AC: ['07:00', '11:30', '17:00'], // 餐前 30 分鐘
  PC: ['08:00', '12:30', '18:00'], // 餐後 30 分鐘
  WITH: [WARD_MEALS.breakfast, WARD_MEALS.lunch, WARD_MEALS.dinner],
  EMPTY: ['06:30', '11:00', '16:30'], // 餐前 1 小時
}
/** 一天幾次的頻率用哪幾餐：BID 早晚、QID 第 4 次在睡前 */
const MEAL_FREQ: Record<string, ('b' | 'l' | 'd' | 'hs')[]> = { QD: ['b'], BID: ['b', 'd'], TID: ['b', 'l', 'd'], QID: ['b', 'l', 'd', 'hs'] }

/**
 * 住院長期給藥醫囑一天的給藥時間（HH:mm）。fixedTimes 是頻率主檔的固定時間（飯前飯後皆可、間隔型、非口服用它）。
 * 開立醫囑產生排程（ipd.ensureMar）與展示資料（seed）都用這一份。
 */
export function marTimes(freq: string, fixedTimes: readonly string[], timing: DrugTiming | undefined, route: string | undefined): string[] {
  const slots = timing ? MEAL_SLOTS[timing] : undefined
  const meals = MEAL_FREQ[freq]
  if (!slots || !meals || !timingApplies(freq, route)) return [...fixedTimes]
  return meals.map((m) => (m === 'hs' ? BEDTIME : slots[{ b: 0, l: 1, d: 2 }[m]]))
}

// ---------- 藥品搜尋 ----------
/**
 * 關鍵字是否符合這種藥：代碼、英文藥名、學名、健保碼、中文名、別名、作用。
 * 醫師開藥、住院醫囑、藥品庫存、主檔清單都用這一份——以前各自比對英文欄位，打「普拿疼」「降血壓」都找不到。
 * 比對「作用」：打「降血壓」列出所有降血壓藥。
 */
export function matchesDrug(d: Pick<Drug, 'id' | 'name' | 'nameZh' | 'generic' | 'nhiCode'> & Partial<Pick<Drug, 'aliases' | 'indication'>>, keyword: string): boolean {
  const kw = keyword.trim().toLowerCase()
  if (!kw) return true
  return [d.id, d.name, d.nameZh, d.generic, d.nhiCode, d.indication, ...(d.aliases ?? [])].some((x) => (x ?? '').toLowerCase().includes(kw))
}

// ---------- 藥價生效日 ----------
// 規則在 dated-rules（醫令點數、掛號費、部分負擔也用同一套）；這裡只是藥品的欄位。

type Priced = Pick<Drug, 'nhiPrice' | 'selfPrice' | 'priceChanges'>
const PRICE_KEYS = ['nhiPrice', 'selfPrice'] as const

/** 某一天的價格：生效日 ≤ 那天的最後一筆調價；都還沒生效就是原價 */
export function drugPriceOn(d: Priced, date: string): { nhiPrice: number; selfPrice: number } {
  return valueOn({ nhiPrice: d.nhiPrice, selfPrice: d.selfPrice }, d.priceChanges, date, PRICE_KEYS)
}

/** 已排定、還沒生效的下一筆調價（主檔清單提示「12/01 起 2.5 點」） */
export function nextPriceChange(d: Priced, today: string): PriceChange | undefined {
  return nextChange(d.priceChanges, today)
}

/** 設定「from 這天起」的價格，回傳新的調價紀錄（規則見 dated-rules.applyChange） */
export function applyPriceChange(d: Priced, change: PriceChange): PriceChange[] {
  return applyChange({ nhiPrice: d.nhiPrice, selfPrice: d.selfPrice }, d.priceChanges, change, PRICE_KEYS)
}

/**
 * 管制藥殘餘量：管制藥、給藥單位就是調劑單位（例：Morphine 以 AMP 開）、劑量不是整數（0.5 AMP）——
 * 給的時候整支扣（take），剩下的（residual）當場銷毀、另一位護理師見證。不是這種情況回傳 undefined
 */
export function residualOf(drug: { controlled?: number; unit: string; doseUnit?: string }, dose: number | undefined): { take: number; residual: number } | undefined {
  if (!drug.controlled || (drug.doseUnit ?? drug.unit) !== drug.unit || !dose || dose <= 0 || Number.isInteger(dose)) return undefined
  const take = Math.ceil(dose)
  return { take, residual: Math.round((take - dose) * 100) / 100 }
}

/**
 * 劑量換算成含量（規格是「10 mg/amp」、給藥單位就是調劑單位時）：0.5 AMP →「5 mg」。換算不了回傳空字串。
 * 管制藥開不是整數的劑量時，醫囑、給藥紀錄都同時看得到 mg，不會只看到「0.5 AMP」
 */
export function doseStrengthText(drug: { spec: string; unit: string; doseUnit?: string }, dose: number | undefined): string {
  if (!dose || (drug.doseUnit ?? drug.unit) !== drug.unit) return ''
  const m = /^([\d.]+)\s*(mg|mcg|g|mL|U)\s*\/\s*\w+$/i.exec(drug.spec.trim())
  if (!m) return ''
  const n = Math.round(Number(m[1]) * dose * 1000) / 1000
  return `${n} ${m[2]}`
}
