// 知情同意書（純函式）：種類、簽署人關係、欄位檢查、手術需要哪幾張。服務層（consent.ts、surgery 術前準備）、畫面、種子、測試共用
import type { Consent, LineDevice, LineKind } from '@/types'

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

/** 這筆檢查有沒有有效的檢查同意書 */
export const examConsentOk = (cs: Pick<Consent, 'kind' | 'examId' | 'revoked'>[], examId: string) => cs.some((c) => c.kind === 'procedure' && c.examId === examId && consentValid(c))

/** 放置前要侵入性處置同意書的管路（中心靜脈導管、胃造口）；導尿管、留置針、鼻胃管是一般護理處置，氣管內管多半是急救 */
export const CONSENT_LINE_KINDS: LineKind[] = ['cvc', 'peg']
/** 沒有同意書也能登錄的原因 */
export const LINE_CONSENT_WAIVERS = ['緊急狀況，來不及事先取得同意（醫療法第 63 條但書，事後補說明）', '外院已放置（補登）']
/** 這次住院、這種管路還沒用掉的有效同意書（一張同意書放一次；放過的就算用掉了） */
export const unusedLineConsent = <C extends Pick<Consent, 'id' | 'kind' | 'admissionId' | 'lineKind' | 'revoked'>>(cs: C[], lines: Pick<LineDevice, 'consentId'>[], admissionId: string, kind: LineKind) =>
  cs.find((c) => c.kind === 'procedure' && c.admissionId === admissionId && c.lineKind === kind && consentValid(c) && !lines.some((l) => l.consentId === c.id))

/** 這次住院有沒有有效的輸血同意書（一次住院簽一次即可） */
export const transfusionConsentOk = (cs: Pick<Consent, 'kind' | 'admissionId' | 'revoked'>[], admissionId: string) => cs.some((c) => c.kind === 'transfusion' && c.admissionId === admissionId && consentValid(c))

/** 這台手術要哪幾張：手術同意書；不是局部麻醉再加麻醉同意書 */
export const consentsForSurgery = (anesthesia: string): Consent['kind'][] => (anesthesia === 'local' ? ['surgery'] : ['surgery', 'anesthesia'])

/** 這台手術還缺哪幾張（有效的、綁這台的；手術同意書的側別要和手術一致） */
export const consentMissing = (anesthesia: string, have: Pick<Consent, 'kind' | 'revoked' | 'side'>[], side?: string): Consent['kind'][] =>
  consentsForSurgery(anesthesia).filter((k) => !have.some((c) => c.kind === k && consentValid(c) && (k !== 'surgery' || !side || !c.side || c.side === side)))
/** 有效但側別和手術不符的手術同意書（手術側別被更正過） */
export const consentSideMismatch = (have: Pick<Consent, 'kind' | 'revoked' | 'side'>[], side: string) => have.find((c) => c.kind === 'surgery' && consentValid(c) && c.side && c.side !== side)

// ── 紙本掃描：簽好的紙本同意書拍照或掃描附檔（JPEG／PNG，瀏覽器先縮圖），一張同意書最多 3 頁 ──
export const CONSENT_SCAN_MAX_PAGES = 3
/** 每頁 data URL 最多幾個字元（縮圖後的 JPEG 約 100–300 KB） */
export const CONSENT_SCAN_MAX_CHARS = 600_000
export function checkScanPages(pages: string[]): string | undefined {
  if (!pages.length) return '請選掃描檔'
  if (pages.length > CONSENT_SCAN_MAX_PAGES) return `最多 ${CONSENT_SCAN_MAX_PAGES} 頁`
  if (pages.some((p) => !/^data:image\/(jpeg|png);base64,/.test(p))) return '只收 JPEG 或 PNG 影像'
  if (pages.some((p) => p.length > CONSENT_SCAN_MAX_CHARS)) return '影像太大：請重新拍或掃描（每頁縮圖後要小於約 450 KB）'
  return undefined
}
/** 還沒掃描紙本的有效同意書（撤回的也要掃，撤回的那張紙也要留；這裡只要有效的） */
export const consentUnscanned = (c: Pick<Consent, 'scan' | 'revoked'>) => !c.scan && !c.revoked
