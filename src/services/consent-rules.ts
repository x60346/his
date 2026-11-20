// 知情同意書（純函式）：種類、簽署人關係、欄位檢查、手術需要哪幾張。服務層（consent.ts、surgery 術前準備）、畫面、種子、測試共用
import type { Consent } from '@/types'

export const CONSENT_KIND_LABEL: Record<Consent['kind'], string> = { surgery: '手術同意書', anesthesia: '麻醉同意書', transfusion: '輸血同意書', procedure: '侵入性檢查／處置同意書' }
/** 簽署人和病人的關係（不是本人要寫原因：病人意識不清、未成年…） */
export const CONSENT_RELATIONS = ['本人', '配偶', '父母', '子女', '兄弟姊妹', '法定代理人', '其他親屬']

export function checkConsentInput(x: { kind?: string; title?: string; explanation?: string; signerName?: string; relation?: string; reason?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!x.kind || !(x.kind in CONSENT_KIND_LABEL)) e.kind = '請選同意書種類'
  if (!x.title?.trim()) e.title = '請寫同意的項目（例：腹腔鏡闌尾切除術）'
  if (!x.explanation?.trim()) e.explanation = '請寫說明重點（風險、替代方案、不做的後果）'
  if (!x.signerName?.trim()) e.signerName = '請寫簽署人姓名'
  if (!x.relation || !CONSENT_RELATIONS.includes(x.relation)) e.relation = '請選和病人的關係'
  else if (x.relation !== '本人' && !x.reason?.trim()) e.reason = '不是本人簽要寫原因（例：病人意識不清、未成年）'
  return e
}

/** 有效：沒撤回 */
export const consentValid = (c: Pick<Consent, 'revoked'>) => !c.revoked

/** 這台手術要哪幾張：手術同意書；不是局部麻醉再加麻醉同意書 */
export const consentsForSurgery = (anesthesia: string): Consent['kind'][] => (anesthesia === 'local' ? ['surgery'] : ['surgery', 'anesthesia'])

/** 這台手術還缺哪幾張（有效的、綁這台的） */
export const consentMissing = (anesthesia: string, have: Pick<Consent, 'kind' | 'revoked'>[]): Consent['kind'][] =>
  consentsForSurgery(anesthesia).filter((k) => !have.some((c) => c.kind === k && consentValid(c)))
