// 生效日（純函式）：藥價、醫令點數、掛號費、部分負擔共用同一套「某天起的值」。
//
// 價格看「看診日」：調價日之前看診、之後才來批價的，收的是看診那天的價格（健保申報也依就醫日）。
// 已批價的收據存著當時的明細，不受之後調價影響。
// 資料形狀：主檔上的欄位是「最早的值」，之後的變動是一串 { from, ...新值 }。某天的值一律用 valueOn 查。

import type { DatedChange } from '@/types'

/** 只取出 keys 這幾個欄位 */
const pick = <V extends object>(src: V, keys: readonly (keyof V)[]): V => Object.fromEntries(keys.map((k) => [k, src[k]])) as V

/** 某一天的值：生效日 ≤ 那天的最後一筆變動；都還沒生效就是原值 */
export function valueOn<V extends object>(base: V, changes: readonly (V & DatedChange)[] | undefined, date: string, keys: readonly (keyof V)[]): V {
  const c = (changes ?? []).filter((x) => x.from <= date).sort((a, b) => a.from.localeCompare(b.from)).pop()
  return pick(c ?? base, keys)
}

/** 已排定、還沒生效的下一筆變動（清單提示「12/01 起 2.5 點」） */
export function nextChange<C extends DatedChange>(changes: readonly C[] | undefined, today: string): C | undefined {
  return (changes ?? []).filter((x) => x.from > today).sort((a, b) => a.from.localeCompare(b.from))[0]
}

/**
 * 設定「from 這天起」的值，回傳新的變動紀錄（不改傳入的資料）：
 *   - 同一天已有變動就取代
 *   - 和前一個值相同就不記（等於取消那天的變動；改個名稱不會多出一筆「調價」）
 * 之後已排定的變動保留（例：先排 12/01，再補一筆 11/20）。
 * 整串重新整理：和前一個值相同的都拿掉——不只新加的那筆，後面已排定的也可能因此變成「沒有變」
 * （例：明天已排 4.2，今天也改成 4.2，明天那筆就多餘了；之後改回原價時才不會留下一筆「3.2 → 3.2」）
 */
export function applyChange<V extends object>(base: V, changes: readonly (V & DatedChange)[] | undefined, change: V & DatedChange, keys: readonly (keyof V)[]): (V & DatedChange)[] {
  const all = [...(changes ?? []).filter((x) => x.from !== change.from), change].sort((a, b) => a.from.localeCompare(b.from))
  const out: (V & DatedChange)[] = []
  let prev: V = base
  for (const c of all) {
    if (keys.every((k) => c[k] === prev[k])) continue
    out.push(c)
    prev = c
  }
  return out
}

/**
 * 生效日檢查（主檔表單與服務層共用）：格式正確、不能早於今天——
 * 早於今天的話，已看診、還沒批價的病人會被改價（那天看診時明明不是這個價）
 */
export function checkFrom(from: string, today: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) return '請選擇生效日'
  if (from < today) return '生效日不能早於今天（已看診、還沒批價的病人會被改價）'
  return null
}
