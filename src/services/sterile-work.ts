// 器械包與滅菌的內部工具（index 不匯出、不會被包成 API）：找鍋次、首頁待辦。API 在 sterile.ts、規則在 sterile-rules
import { db } from '@/mock/db'
import { biDueAt, packState } from './sterile-rules'

export const batchOf = (id: string) => db.sterileBatches.find((b) => b.id === id)

/** 首頁（供應中心）：生物指示劑該判讀、召回用過的還沒通知、要收回的（過期＋召回沒用的） */
export function sterileCounts(t: string): { biDue: number; recallOpen: number; toWithdraw: number } {
  const d = t.slice(0, 10)
  return {
    biDue: db.sterileBatches.filter((b) => !b.bi && biDueAt(b) <= t).length,
    recallOpen: db.sterileBatches.filter((b) => b.recall).reduce((n, b) => n + new Set(db.instrumentPacks.filter((p) => p.batchId === b.id && p.used && !b.recall!.notified.some((x) => x.surgeryId === p.used!.surgeryId)).map((p) => p.used!.surgeryId)).size, 0),
    toWithdraw: db.instrumentPacks.filter((p) => ['expired', 'recalled'].includes(packState(p, batchOf(p.batchId), d))).length,
  }
}
