// 藥事照護紀錄（純函式）：建議類型、輸入檢查、依類型的建議數與接受率。住院藥局「藥事照護」、病人分頁、首頁、測試都用這一份
import type { PharmCareKind, PharmCareNote } from '@/types'

export const PHARMCARE_KIND_LABEL: Record<PharmCareKind, string> = {
  dose: '劑量調整',
  monitor: '建議監測',
  interaction: '交互作用處理',
  deprescribe: '停用不必要的藥',
  other: '其他',
}
export const PHARMCARE_KINDS = Object.keys(PHARMCARE_KIND_LABEL) as PharmCareKind[]
export const PHARMCARE_STATUS_LABEL: Record<PharmCareNote['status'], string> = { sent: '待主治回覆', accepted: '已接受', declined: '不接受' }

export function checkPharmCareInput(x: { kind?: string; text?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.kind || !(x.kind in PHARMCARE_KIND_LABEL)) e.kind = '請選建議類型'
  if (!x.text?.trim()) e.text = '請寫建議內容（例：CrCl 30，建議 Meropenem 改每 12 小時）'
  return e
}

export interface PharmCareStat {
  kind: PharmCareKind | 'total'
  label: string
  sent: number
  accepted: number
  declined: number
  pending: number
  /** 接受率 %＝接受 ÷（接受＋不接受） */
  rate: number | null
}
export function pharmCareStats(list: Pick<PharmCareNote, 'kind' | 'status'>[]): PharmCareStat[] {
  const of = (kind: PharmCareStat['kind'], xs: Pick<PharmCareNote, 'kind' | 'status'>[]): PharmCareStat => {
    const accepted = xs.filter((x) => x.status === 'accepted').length
    const declined = xs.filter((x) => x.status === 'declined').length
    return { kind, label: kind === 'total' ? '合計' : PHARMCARE_KIND_LABEL[kind], sent: xs.length, accepted, declined, pending: xs.length - accepted - declined, rate: accepted + declined ? Math.round((accepted / (accepted + declined)) * 1000) / 10 : null }
  }
  return [...PHARMCARE_KINDS.map((k) => of(k, list.filter((x) => x.kind === k))), of('total', list)]
}
