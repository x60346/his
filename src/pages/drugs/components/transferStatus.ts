// 撥補單狀態的顯示（清單、明細共用）
import type { TransferOrder, TransferStatus } from '@/types'

type Tone = 'gray' | 'yellow' | 'blue' | 'green'
export const TRANSFER_STATUS: Record<TransferStatus, { label: string; tone: Tone }> = {
  requested: { label: '請領中', tone: 'yellow' },
  approved: { label: '已核准待送出', tone: 'yellow' },
  issued: { label: '運送中', tone: 'blue' },
  received: { label: '已簽收', tone: 'green' },
  cancelled: { label: '已取消', tone: 'gray' },
}

/** 退回藥庫的「申請中」是等藥庫審核，不是請領 */
export const transferStatusOf = (t: Pick<TransferOrder, 'status' | 'kind'>): { label: string; tone: Tone } =>
  t.kind === 'return' && t.status === 'requested' ? { label: '待藥庫審核', tone: 'yellow' } : TRANSFER_STATUS[t.status]
