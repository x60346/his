// 出院準備（純函式）：篩選條件與收案門檻、系統能自動判斷的條件、篩選與追蹤期限、需求與轉介種類。
// 畫面即時算、服務層把關、護理站待辦、首頁、測試都用這一份
import type { DischargeReferralKind } from '@/types'
import { addMinutes } from '@/utils/date'

export const PLAN_CRITERIA: { key: string; label: string; auto?: boolean }[] = [
  { key: 'age65', label: '65 歲以上', auto: true },
  { key: 'alone', label: '獨居或沒有主要照顧者' },
  { key: 'lines', label: '可能帶管路出院（鼻胃管、導尿管、胃造口）', auto: true },
  { key: 'adl', label: '日常生活需要協助（Barthel 量表 <60）' },
  { key: 'readmit', label: '出院 30 天內再住院', auto: true },
  { key: 'chronic', label: '多重慢性病，或新診斷的重大疾病（中風、癌症）' },
]
/** 符合幾項收案 */
export const PLAN_ENROLL_FROM = 2
export const criterionLabel = (k: string) => PLAN_CRITERIA.find((c) => c.key === k)?.label ?? k

export const PLAN_NEEDS: { key: string; label: string }[] = [
  { key: 'ltc', label: '長期照顧（長照 2.0）' },
  { key: 'homecare', label: '居家護理（換管路、傷口）' },
  { key: 'respiratory', label: '呼吸照護' },
  { key: 'aids', label: '輔具（輪椅、氣墊床、便盆椅）' },
  { key: 'respite', label: '喘息服務' },
  { key: 'teach', label: '照顧技巧指導（管灌、翻身、移位）' },
  { key: 'nursinghome', label: '轉介機構安置' },
]
export const REFERRAL_KINDS: { kind: DischargeReferralKind; label: string; agencies: string[] }[] = [
  { kind: 'ltc', label: '長照 2.0（照管中心）', agencies: ['市長期照顧管理中心'] },
  { kind: 'homecare', label: '居家護理', agencies: ['本院居家護理所', '康寧居家護理所'] },
  { kind: 'respiratory', label: '呼吸照護', agencies: ['區域呼吸照護中心'] },
  { kind: 'aids', label: '輔具', agencies: ['市輔具資源中心'] },
  { kind: 'respite', label: '喘息服務', agencies: ['市長期照顧管理中心'] },
]
export const referralKindLabel = (k: DischargeReferralKind) => REFERRAL_KINDS.find((x) => x.kind === k)?.label ?? k
export const needLabel = (k: string) => PLAN_NEEDS.find((x) => x.key === k)?.label ?? k

/** 入院後幾小時內篩選；出院後幾天內電話追蹤 */
export const PLAN_SCREEN_HOURS = 72
export const PLAN_FOLLOW_DAYS = 7

/** 篩選期限：做過 done；最後 12 小時 due；過了 overdue */
export function planScreenDue(admittedAt: string, screened: boolean, now: string): { status: 'done' | 'todo' | 'due' | 'overdue'; dueAt: string } {
  const dueAt = addMinutes(admittedAt, PLAN_SCREEN_HOURS * 60)
  if (screened) return { status: 'done', dueAt }
  if (now > dueAt) return { status: 'overdue', dueAt }
  return { status: now >= addMinutes(dueAt, -12 * 60) ? 'due' : 'todo', dueAt }
}

/** 出院後追蹤：出院到 7 天內 due，超過 overdue；追蹤過 done */
export function followUpDue(dischargedAt: string, done: boolean, now: string): { status: 'done' | 'due' | 'overdue'; dueAt: string } {
  const dueAt = addMinutes(dischargedAt, PLAN_FOLLOW_DAYS * 24 * 60)
  return { status: done ? 'done' : now > dueAt ? 'overdue' : 'due', dueAt }
}

/** 收案了、有需求，卻還沒有任何送出的轉介（醫師簽准出院時提醒） */
export const planUnreferred = (p: { enrolled: boolean; needs: string[]; referrals: { sentAt?: string }[] } | undefined) =>
  !!p && p.enrolled && p.needs.some((n) => n !== 'teach') && !p.referrals.some((r) => r.sentAt)
