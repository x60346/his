// 手術病理檢體（純函式）：容器、固定液、標籤、送出到收件的時限、報告要主刀確認的條件、階段。
// 服務層（pathology.ts）、手術室與病理頁、首頁待辦、種子、測試都用這一份
import type { PathContainer, PathFixative, PathologyRecord, SurgicalSpecimen } from '@/types'

export const CONTAINER_LABEL: Record<PathContainer, string> = { jar: '檢體罐', bag: '檢體袋', cassette: '包埋盒', tube: '試管' }
export const FIXATIVE_LABEL: Record<PathFixative, string> = { formalin: '福馬林', saline: '生理食鹽水', none: '不加（新鮮）' }
/** 送出後多久還沒收件算逾時（小時） */
export const PATH_RECEIVE_HOURS = 4

/** 下一個標籤：A、B、C…（刪掉的不補號，避免和已經貼好的標籤搞混） */
export const nextSpecimenLabel = (list: Pick<SurgicalSpecimen, 'label'>[]): string => {
  const used = list.map((x) => x.label.charCodeAt(0) - 65).filter((n) => n >= 0)
  return String.fromCharCode(65 + (used.length ? Math.max(...used) + 1 : 0))
}

export const specimenText = (x: Pick<SurgicalSpecimen, 'label' | 'site' | 'container' | 'fixative'>): string => `${x.label} ${x.site}（${CONTAINER_LABEL[x.container]}・${FIXATIVE_LABEL[x.fixative]}）`

export function checkSpecimen(input: { site?: string; container?: string; fixative?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!input.site?.trim()) e.site = '請寫檢體部位（例：疝囊、闌尾）'
  if (!input.container || !(input.container in CONTAINER_LABEL)) e.container = '請選容器'
  if (!input.fixative || !(input.fixative in FIXATIVE_LABEL)) e.fixative = '請選固定液'
  return e
}

/** 報告要主刀確認：惡性，或和術前診斷不符 */
export const pathCritical = (r?: PathologyRecord['report']): boolean => !!r && (r.malignant || !r.consistent)

export type PathStage = 'sent' | 'received' | 'reported' | 'acked'
export const PATH_STAGE_LABEL: Record<PathStage, string> = { sent: '待病理收件', received: '病理處理中', reported: '已發報告', acked: '主刀已確認' }
export const pathStage = (p?: PathologyRecord): PathStage | undefined => (!p ? undefined : p.ack ? 'acked' : p.report ? 'reported' : p.received ? 'received' : 'sent')

/** 送出超過時限還沒收件 */
export const pathOverdue = (p: PathologyRecord | undefined, now: string, minutesBetween: (a: string, b: string) => number): boolean =>
  !!p && !p.received && minutesBetween(p.sentAt, now) > PATH_RECEIVE_HOURS * 60

export function checkPathReport(input: { diagnosis?: string; malignant?: unknown; consistent?: unknown }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!input.diagnosis?.trim()) e.diagnosis = '請寫病理診斷'
  if (typeof input.malignant !== 'boolean') e.malignant = '請選良性或惡性'
  if (typeof input.consistent !== 'boolean') e.consistent = '請選是否和術前診斷相符'
  return e
}
