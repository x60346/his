// 藥品主檔的同名判斷（純函式）：主檔頁面送出前的確認與服務層共用。
//
// 真實醫院裡同名藥是正常的：同成分不同廠牌、換供應商的新舊並存期。參照的 jian-HIS 以院內代碼識別藥品，
// 藥名可以重複。但這個展示系統沒有廠牌、中文名欄位，醫師開藥時只看得到藥名——同名兩筆就分不出來。
// 所以不直接擋，而是「提醒並要求確認」（和劑量偏高、重複開立同一種藥的確認方式一致）。
import type { Drug } from '@/types'

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
