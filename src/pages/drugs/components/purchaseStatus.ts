// 採購單狀態的顯示（清單、明細共用）
import type { PurchaseStatus } from '@/types'

export const PURCHASE_STATUS: Record<PurchaseStatus, { label: string; tone: 'gray' | 'yellow' | 'blue' | 'green' | 'red' }> = {
  draft: { label: '草稿', tone: 'gray' },
  pending: { label: '待核准', tone: 'yellow' },
  ordered: { label: '已訂購', tone: 'blue' },
  received: { label: '已到齊', tone: 'green' },
  closed: { label: '短交結案', tone: 'gray' },
  cancelled: { label: '已取消', tone: 'gray' },
}
