// 轉診：服務層內部（index 不匯出）——掛號（booking）與補登（referral）共用的轉診單檢查，首頁待辦共用的「待回覆」判斷
import type { ReferralIn } from '@/types'
import { db } from '@/mock/db'
import { now } from '@/utils/date'
import { failFields } from './http'
import { find } from './views'
import { checkReferralInInput, type ReferralInInput } from './referral-rules'

/** 轉診單內容 → 存在掛號上的資料（欄位錯誤一次標出） */
export function buildReferralIn(input: ReferralInInput, visitDate: string, userId: string): ReferralIn {
  failFields(checkReferralInInput(input, visitDate))
  return {
    fromHospital: input.fromHospital.trim(), issuedOn: input.issuedOn, diagnosis: input.diagnosis.trim(),
    ...(input.purpose?.trim() ? { purpose: input.purpose.trim() } : {}),
    recordedBy: userId, recordedAt: now(),
  }
}

/** 醫師待回覆：我看過（完成看診）、持外院轉診單（不是沿用的回診）、還沒回覆 */
export const pendingReplyVisits = (doctorId: string) =>
  db.visits.filter((v) => v.doctorId === doctorId && v.referralIn && !v.referralIn.inheritedFrom && !v.referralIn.reply && v.status !== 'cancelled' && find.encounterOfVisit(v.id)?.status === 'completed')
