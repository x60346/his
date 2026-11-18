// 住院檢體與條碼（純函式）：容器名稱與顏色、同管別合併、檢體走到哪一步、收件逾時、退件原因。
// 護理站印條碼與採檢、檢驗科收件與退件、首頁待辦、測試都用這一份
import type { Specimen, TubeKind } from '@/types'
import { addMinutes } from '@/utils/date'

export const TUBE_LABEL: Record<TubeKind, string> = { purple: '紫頭（EDTA）', red: '紅頭（生化）', gas: '動脈血氣體', urine: '尿杯', swab: '拭子', sputum: '痰盒', culture: '培養容器' }
/** 標籤上的顏色（Tailwind class） */
export const TUBE_COLOR: Record<TubeKind, string> = { purple: 'bg-purple-500', red: 'bg-red-500', gas: 'bg-sky-500', urine: 'bg-yellow-400', swab: 'bg-slate-400', sputum: 'bg-emerald-500', culture: 'bg-orange-500' }
export const SPECIMEN_REJECT_REASONS = ['溶血', '檢體量不足', '凝固', '標籤錯誤', '容器錯誤']
/** 採檢後多久沒收件算逾時（首頁標紅）：住院檢驗都是臨時醫囑，視同急件 */
export const SPECIMEN_LATE_MIN = 60

export type SpecimenStage = 'printed' | 'collected' | 'received' | 'rejected'
export const SPECIMEN_STAGE_LABEL: Record<SpecimenStage, string> = { printed: '已印條碼、待採檢', collected: '已採檢、待收件', received: '檢驗科已收件', rejected: '退件' }
export const specimenStage = (s: Pick<Specimen, 'collectedAt' | 'receivedAt' | 'rejected'>): SpecimenStage => (s.rejected ? 'rejected' : s.receivedAt ? 'received' : s.collectedAt ? 'collected' : 'printed')

/** 採檢後超過 60 分鐘還沒收件 */
export const specimenLate = (s: Pick<Specimen, 'collectedAt' | 'receivedAt' | 'rejected'>, t: string) => specimenStage(s) === 'collected' && t > addMinutes(s.collectedAt!, SPECIMEN_LATE_MIN)

/** 同管別合併：檢驗醫囑依容器分組（容器順序固定，標籤印出來的順序一樣） */
export function groupByTube<T extends { tube: TubeKind }>(xs: T[]): { tube: TubeKind; items: T[] }[] {
  return (Object.keys(TUBE_LABEL) as TubeKind[]).map((tube) => ({ tube, items: xs.filter((x) => x.tube === tube) })).filter((g) => g.items.length)
}

/** 退件原因要選或寫 */
export const checkRejectReason = (reason: string | undefined): Record<string, string> => (reason?.trim() ? {} : { reason: '請寫退件原因（例：溶血、檢體量不足）' })
