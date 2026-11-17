// 病歷影本申請（純函式）：申請人身分核對、用途、代理人關係、可以申請的項目、頁數與費用。
// 服務層把關、櫃台畫面即時檢查共用這一份
import type { CopyItemKind } from '@/types'
import { ID_NO_PATTERN } from './controlled-rules'

export const COPY_KIND_LABEL: Record<CopyItemKind, string> = { opd: '門診病歷', discharge: '出院病摘', lab: '檢驗報告', imaging: '影像報告' }
export const COPY_PURPOSES = ['保險理賠', '轉院、他院就醫', '個人保存', '法律訴訟', '其他']
export const COPY_RELATIONS = ['配偶', '父母', '子女', '兄弟姊妹', '法定代理人', '其他親屬', '受託人（非親屬）']
/** 一次最多幾項（一次看診、一份病摘、一份報告各算一項） */
export const COPY_MAX_ITEMS = 60

/** 頁數：每一項印一頁（展示簡化：真實的病歷依實際張數） */
export const copyPagesOf = (_kind: CopyItemKind) => 1

/** 費用：基本費＋每頁 × 頁數（單價依申請那天，主檔可排生效日） */
export const copyFee = (base: number, perPage: number, pages: number) => base + perPage * pages

export interface CopyApplicantInput {
  kind?: 'self' | 'agent'
  name?: string
  idNo?: string
  relation?: string
  authorizationChecked?: boolean
}

/**
 * 申請人檢查（欄位 key 對應畫面）：
 * - 本人：姓名、身分證號要和病人資料一樣（核對證件）
 * - 代理人：姓名、身分證號格式、和病人的關係、要勾「委託書（或關係證明）已核對」；不能填病人自己的身分證號
 */
export function checkCopyApplicant(x: CopyApplicantInput, patient: { name: string; idNo: string }): Record<string, string> {
  const e: Record<string, string> = {}
  const idNo = (x.idNo ?? '').trim().toUpperCase()
  const name = (x.name ?? '').trim()
  if (x.kind !== 'self' && x.kind !== 'agent') {
    e.kind = '請選擇本人或代理人'
    return e
  }
  if (!name) e.name = '請填申請人姓名'
  if (!idNo) e.idNo = '請填申請人身分證號'
  else if (!ID_NO_PATTERN.test(idNo)) e.idNo = '身分證號格式不正確（1 個英文字母＋9 個數字）'
  if (x.kind === 'self') {
    if (name && name !== patient.name) e.name = `本人申請：姓名要和病人資料一樣（${patient.name}）；不是本人請選「代理人」`
    if (!e.idNo && idNo !== patient.idNo.toUpperCase()) e.idNo = '本人申請：身分證號和病人資料不符，請核對證件'
  } else {
    if (!e.idNo && idNo === patient.idNo.toUpperCase()) e.idNo = '這是病人本人的身分證號：本人申請請選「本人」'
    if (!x.relation?.trim()) e.relation = '請選擇和病人的關係'
    if (!x.authorizationChecked) e.authorizationChecked = '代理人申請：請核對病人的委託書（或關係證明文件）後勾選'
  }
  return e
}
