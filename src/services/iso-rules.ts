// 隔離連動（純函式）：開隔離時建議的醫囑（檢驗、護理）、防護用品、解除條件的判斷。
// 隔離分頁、護理站、服務層、測試都用這一份
import type { IsolationKind } from '@/types'

export interface IsoBundleItem {
  key: string
  label: string
  /** 檢驗：醫令與套數；護理：醫囑內容 */
  procId?: string
  count?: number
  nursing?: string
}
/** 開隔離時建議的醫囑（醫師勾選後一次開） */
export const ISO_BUNDLES: Record<IsolationKind, IsoBundleItem[]> = {
  airborne: [
    { key: 'afb', label: '痰液抗酸菌塗片 ×3（每天一套，清晨痰）', procId: 'P057', count: 3 },
    { key: 'n95', label: '護理：N95 口罩、負壓室門保持關閉', nursing: '空氣隔離：進出戴 N95 口罩；負壓室門保持關閉；病人離開病室戴外科口罩' },
  ],
  droplet: [
    { key: 'flu', label: '流感快篩', procId: 'P012', count: 1 },
    { key: 'covid', label: '新冠病毒快篩', procId: 'P058', count: 1 },
    { key: 'mask', label: '護理：外科口罩、保持 1 公尺', nursing: '飛沫隔離：照護時戴外科口罩，與病人保持 1 公尺以上；病人離開病室戴口罩' },
  ],
  contact: [
    { key: 'culture', label: '細菌培養（傷口或尿液）', procId: 'P059', count: 1 },
    { key: 'gown', label: '護理：手套、隔離衣、專用器材', nursing: '接觸隔離：接觸病人與環境戴手套、穿隔離衣；聽診器、血壓計專用；出病室前脫除並洗手' },
  ],
}
/** 防護用品（護理站病人清單、病人資訊列最上方） */
export const ISO_PPE: Record<IsolationKind, string[]> = {
  airborne: ['N95'],
  droplet: ['外科口罩'],
  contact: ['手套', '隔離衣'],
}
export const ppeOf = (kinds: IsolationKind[]) => [...new Set(kinds.flatMap((k) => ISO_PPE[k]))]

/** 多重抗藥性菌（接觸隔離要連續兩套培養陰性才解除） */
export const MDRO = ['MRSA', 'CRE', 'VRE']
export const isMdro = (organism: string) => MDRO.some((m) => organism.toUpperCase().includes(m))

export type LabResult = { at: string; value: string }
/**
 * 解除條件：
 *   - 空氣隔離：抗酸菌塗片（隔離後）最近連續三套陰性
 *   - 飛沫隔離：快篩（流感或新冠，隔離後）陰性，或醫師確認症狀緩解滿 24 小時
 *   - 接觸隔離（MRSA、CRE、VRE）：培養（隔離後）最近連續兩套「無菌生長」；其他原因的接觸隔離沒有檢驗條件
 */
export function releaseCheck(kind: IsolationKind, organism: string, x: { afb: LabResult[]; rapid: LabResult[]; culture: LabResult[]; symptomFree24h?: boolean }): { met: boolean; text: string } {
  const lastN = (xs: LabResult[], n: number) => [...xs].sort((a, b) => a.at.localeCompare(b.at)).slice(-n)
  if (kind === 'airborne') {
    const last = lastN(x.afb, 3)
    const neg = last.filter((r) => r.value === '陰性').length
    const met = last.length === 3 && neg === 3
    return { met, text: met ? '抗酸菌塗片連續三套陰性' : `抗酸菌塗片：最近 ${last.length} 套${last.length ? `（${last.map((r) => r.value).join('、')}）` : ''}，要連續三套陰性` }
  }
  if (kind === 'droplet') {
    if (x.rapid.some((r) => r.value === '陰性')) return { met: true, text: '快篩陰性' }
    if (x.symptomFree24h) return { met: true, text: '醫師確認症狀緩解滿 24 小時' }
    return { met: false, text: '要快篩陰性，或症狀緩解滿 24 小時（醫師確認）' }
  }
  if (!isMdro(organism)) return { met: true, text: '非多重抗藥性菌：沒有檢驗條件' }
  const last = lastN(x.culture, 2)
  const met = last.length === 2 && last.every((r) => r.value === '無菌生長')
  return { met, text: met ? '培養連續兩套無菌生長' : `培養：最近 ${last.length} 套${last.length ? `（${last.map((r) => r.value).join('、')}）` : ''}，要連續兩套無菌生長` }
}
