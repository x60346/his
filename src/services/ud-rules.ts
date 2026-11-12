// 住院調劑（UD）的純規則：每劑發幾個調劑單位、沒給的劑量怎麼稱呼。服務層與頁面共用，不碰資料庫。
import type { Drug } from '@/types'

/**
 * 每劑幾個調劑單位。可換算＝給藥單位就是調劑單位（顆、支、包）且劑量是整數：
 * 「每次 1 顆、TID」明天就是 3 顆。給藥單位不同（胰島素每次 10 U、調劑 1 支筆；眼藥水 1 滴、調劑 1 瓶）
 * 或半顆這種劑量，無法逐劑換算——回傳 undefined，由藥師填數量，沒給的也不退（整支、整瓶還在病房）。
 */
export function udPerDose(drug: Pick<Drug, 'unit' | 'doseUnit'>, dose: number | undefined): number | undefined {
  if ((drug.doseUnit ?? drug.unit) !== drug.unit) return undefined
  return dose && Number.isInteger(dose) && dose > 0 ? dose : undefined
}

/** 發出去、不會給的劑量為什麼要退（退藥點收清單上顯示） */
export type UdReturnCause = 'held' | 'refused' | 'stopped' | 'discharged' | 'cancelled'
export const UD_RETURN_CAUSE: Record<UdReturnCause, string> = {
  held: '暫停給藥',
  refused: '病人拒絕',
  stopped: '醫囑停止',
  discharged: '出院',
  cancelled: '排程取消',
}

/**
 * 核對能不能由這位藥師做：管理員開啟「調劑雙人核對」時（門診、住院共用同一個設定），調劑的人不能自己核對。
 * 回傳擋下的原因；可以核對回 undefined
 */
export function udVerifyBlocker(preparedBy: string, userId: string, twoPerson: boolean): string | undefined {
  return twoPerson && preparedBy === userId ? '本院規定調劑與核對須由不同藥師：請由另一位藥師核對' : undefined
}
