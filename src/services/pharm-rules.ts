// 藥師住院醫囑審核（純函式）：狀態顯示、還沒回覆的疑義、哪些醫囑還沒審就不能每日調劑。
// 開醫囑、住院藥局審核與調劑、護理站給藥、首頁待辦、測試都用這一份
import type { IpdOrder, PharmReview } from '@/types'

export const PHARM_STATUS_LABEL: Record<PharmReview['status'], string> = { pending: '待藥師審核', approved: '藥師已審核', query: '藥師疑義待回覆' }

/** 還沒回覆的那一筆疑義（最後一筆沒有 replyAt） */
export const openPharmQuery = (p: PharmReview | undefined) => {
  const q = p?.queries?.at(-1)
  return q && !q.replyAt ? q : undefined
}

/**
 * 每日調劑要先審核：長期、排程給藥（不是需要時）的醫囑，藥師還沒通過就不能調。
 * 臨時（STAT）與需要時（PRN）用病房常備、先給後審，不擋；沒有 pharm 欄位的是功能上線前的醫囑
 */
export const pharmBlocksUd = (o: Pick<IpdOrder, 'pharm' | 'type' | 'freq'>) => !!o.pharm && o.pharm.status !== 'approved' && o.type === 'long' && o.freq !== 'PRN'

/** 審核：疑義要寫內容；醫師回覆維持原醫囑要寫理由 */
export const checkPharmText = (text: string | undefined, what: 'query' | 'reply'): Record<string, string> =>
  text?.trim() ? {} : { [what === 'query' ? 'text' : 'reply']: what === 'query' ? '請寫疑義內容（例：病人 CrCl 25，Metformin 建議停用）' : '請寫維持原醫囑的理由（例：已評估，短期使用並監測腎功能）' }
