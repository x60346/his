// 撥補單狀態的顯示（清單、明細共用）
import type { TransferStatus } from '@/types'

export const TRANSFER_STATUS: Record<TransferStatus, { label: string; tone: 'gray' | 'yellow' | 'blue' | 'green' }> = {
  requested: { label: '請領中', tone: 'yellow' },
  issued: { label: '運送中', tone: 'blue' },
  received: { label: '已簽收', tone: 'green' },
  cancelled: { label: '已取消', tone: 'gray' },
}
