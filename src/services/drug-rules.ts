// 藥品主檔的同名判斷（純函式）：主檔頁面送出前的確認與服務層共用。
//
// 真實醫院裡同名藥是正常的：同成分不同廠牌、換供應商的新舊並存期。參照的 jian-HIS 以院內代碼識別藥品，
// 藥名可以重複。但這個展示系統沒有廠牌、中文名欄位，醫師開藥時只看得到藥名——同名兩筆就分不出來。
// 所以不直接擋，而是「提醒並要求確認」（和劑量偏高、重複開立同一種藥的確認方式一致）。
import type { Drug, DrugTiming, PriceChange } from '@/types'

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
  if (route !== 'PO' || FREQ_SAYS_WHEN.includes(freq)) return ''
  return (short ? TIMING_SHORT : TIMING_LABEL)[timing ?? 'ANY']
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
// 價格看「看診日」：調價日之前看診、之後才來批價的，收的是看診那天的價格（健保申報也依就醫日）。
// 已批價的收據存著當時的明細，不受之後調價影響。

type Priced = Pick<Drug, 'nhiPrice' | 'selfPrice' | 'priceChanges'>

/** 某一天的價格：生效日 ≤ 那天的最後一筆調價；都還沒生效就是原價 */
export function drugPriceOn(d: Priced, date: string): { nhiPrice: number; selfPrice: number } {
  const c = (d.priceChanges ?? []).filter((x) => x.from <= date).sort((a, b) => a.from.localeCompare(b.from)).pop()
  return c ? { nhiPrice: c.nhiPrice, selfPrice: c.selfPrice } : { nhiPrice: d.nhiPrice, selfPrice: d.selfPrice }
}

/** 已排定、還沒生效的下一筆調價（主檔清單提示「12/01 起 2.5 點」） */
export function nextPriceChange(d: Priced, today: string): PriceChange | undefined {
  return (d.priceChanges ?? []).filter((x) => x.from > today).sort((a, b) => a.from.localeCompare(b.from))[0]
}

/**
 * 設定「from 這天起」的價格，回傳新的調價紀錄（不改傳入的資料）：
 *   - 同一天已有調價就取代
 *   - 和前一個價格相同就不記（等於取消那天的調價；改個藥名不會多出一筆「調價」）
 * 之後已排定的調價保留（例：先排 12/01，再補一筆 11/20）。
 */
export function applyPriceChange(d: Priced, change: PriceChange): PriceChange[] {
  const all = [...(d.priceChanges ?? []).filter((x) => x.from !== change.from), change].sort((a, b) => a.from.localeCompare(b.from))
  // 整串重新整理：和前一個價格相同的都拿掉——不只新加的那筆，後面已排定的也可能因此變成「沒有變」
  // （例：明天已排 4.2，今天也改成 4.2，明天那筆就多餘了；之後改回原價時才不會留下一筆「3.2 → 3.2」）
  const out: PriceChange[] = []
  let prev = { nhiPrice: d.nhiPrice, selfPrice: d.selfPrice }
  for (const c of all) {
    if (c.nhiPrice === prev.nhiPrice && c.selfPrice === prev.selfPrice) continue
    out.push(c)
    prev = c
  }
  return out
}
