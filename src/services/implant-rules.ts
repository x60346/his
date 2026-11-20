// 植入物批號（純函式）：哪個術式用哪些植入物、批的狀態（可用、用完、過期、召回）、能不能用在這台、收貨與登記欄位。
// 服務層（implant.ts、surgery.finishSurgery）、手術室「植入物」分頁、手術視窗、種子、測試都用這一份
import type { ImplantLot, MriSafety } from '@/types'

/** 術式會用到的植入物（主檔 id）：骨折開放性復位＝骨板、骨釘（自費骨板）；疝氣修補＝網膜（自費防沾黏網膜） */
export const IMPLANT_FOR: Record<string, string[]> = { P037: ['P062', 'P063', 'P064'], P039: ['P065', 'P066'] }

export type LotState = 'available' | 'empty' | 'expired' | 'recalled'
export const LOT_STATE_LABEL: Record<LotState, string> = { available: '可用', empty: '用完', expired: '過期', recalled: '召回' }

/** 這批還剩幾個 */
export const lotLeft = (lot: Pick<ImplantLot, 'qty'>, used: number): number => Math.max(0, lot.qty - used)

export function lotState(lot: Pick<ImplantLot, 'qty' | 'expiresOn' | 'recall'>, used: number, today: string): LotState {
  if (lot.recall) return 'recalled'
  if (lotLeft(lot, used) <= 0) return 'empty'
  if (lot.expiresOn < today) return 'expired'
  return 'available'
}

/**
 * 能不能用在這台：術式不會用到的、召回、過期、不夠的擋；自費品項病人還沒同意擋。回傳不能用的原因
 */
export function implantUseProblem(input: { surgeryProcId: string; implantProcId: string; selfPay: boolean; consent: boolean; qty: number }, lot: Pick<ImplantLot, 'qty' | 'expiresOn' | 'recall'>, used: number, today: string): string | undefined {
  if (!(IMPLANT_FOR[input.surgeryProcId] ?? []).includes(input.implantProcId)) return '這個術式不會用到這個植入物'
  if (lot.recall) return `這批廠商已召回（${lot.recall.reason}），不能用`
  if (lot.expiresOn < today) return `這批已過效期（${lot.expiresOn}）`
  const left = lotLeft(lot, used)
  if (input.qty > left) return `這批只剩 ${left} 個`
  if (input.selfPay && !input.consent) return '自費植入物：病人（或家屬）還沒同意，請病房先記錄同意'
  return undefined
}

export function checkImplantUse(input: { lotId?: string; qty?: unknown; site?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!input.lotId) e.lotId = '請選植入物與批號'
  const n = Number(input.qty)
  if (!Number.isInteger(n) || n < 1 || n > 20) e.qty = '數量是 1–20'
  if (!input.site?.trim()) e.site = '請寫植入部位（例：右橈骨遠端）'
  return e
}

export function checkLotInput(input: { procId?: string; lot?: string; expiresOn?: string; qty?: unknown }, today: string, isImplant: (id: string) => boolean): Record<string, string> {
  const e: Record<string, string> = {}
  if (!input.procId || !isImplant(input.procId)) e.procId = '請選植入物品項'
  if (!input.lot?.trim()) e.lot = '請填批號'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiresOn ?? '')) e.expiresOn = '請填效期'
  else if (input.expiresOn! < today) e.expiresOn = '已過期的不能收'
  const n = Number(input.qty)
  if (!Number.isInteger(n) || n < 1 || n > 200) e.qty = '數量是 1–200'
  return e
}

// ---------- 病人植入物紀錄、植入物卡、MRI ----------

export const MRI_LABEL: Record<MriSafety, string> = { safe: 'MRI 安全', conditional: 'MRI 有條件', unsafe: 'MRI 不安全' }
const MRI_RANK: Record<MriSafety, number> = { safe: 0, conditional: 1, unsafe: 2 }
/** 最嚴重的那一個（沒有植入物＝undefined） */
export const worstMri = (xs: (MriSafety | undefined)[]): MriSafety | undefined => xs.filter((x): x is MriSafety => !!x).sort((a, b) => MRI_RANK[b] - MRI_RANK[a])[0]
/** UDI（GS1）：(01) 識別碼 (10) 批號 (17) 效期 YYMMDD */
export const udiOf = (di: string | undefined, lot: string, expiresOn: string): string => (di ? `(01)${di}(10)${lot}(17)${expiresOn.slice(2).replace(/-/g, '')}` : '')

export function checkExternalImplant(input: { name?: string; mri?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!input.name?.trim()) e.name = '請寫植入物名稱（例：心律調節器）'
  if (!['safe', 'conditional', 'unsafe'].includes(input.mri ?? '')) e.mri = '請選 MRI 相容性（不確定請選「不安全」）'
  return e
}
