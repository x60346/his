// 死亡病例審查（純函式）：哪些死亡要審（非預期的觸發條件）、審查結論與欄位、APACHE II 預估死亡率（診斷類別係數）、
// 品質指標（院內死亡率、SMR）。死亡審查頁、加護病房分頁、服務層、測試都用這一份
import { addMinutes } from '@/utils/date'

/** 要審查的觸發條件 */
export type MortalityTrigger = 'noDnr' | 'early' | 'postop' | 'afterCode' | 'icuOut'
export const TRIGGER_LABEL: Record<MortalityTrigger, string> = {
  noDnr: '沒有 DNR、沒有安寧收案（非預期）',
  early: '入院 48 小時內死亡',
  postop: '手術後 30 天內死亡',
  afterCode: '急救後死亡',
  icuOut: '從加護病房轉出 48 小時內死亡',
}
/**
 * 觸發條件：沒有 DNR／安寧（非預期）、入院 48 小時內、手術後 30 天內、急救後、加護病房轉出 48 小時內。
 * 有任一條就要審（有 DNR 但入院 48 小時內也要審：評鑑看的是過程，不只看有沒有簽 DNR）
 */
export function mortalityTriggers(x: { expected: boolean; admittedAt?: string; declaredAt: string; lastSurgeryAt?: string; codeBlue: boolean; lastIcuOutAt?: string }): MortalityTrigger[] {
  const t: MortalityTrigger[] = []
  if (!x.expected) t.push('noDnr')
  if (x.admittedAt && x.declaredAt <= addMinutes(x.admittedAt, 48 * 60)) t.push('early')
  if (x.lastSurgeryAt && x.lastSurgeryAt <= x.declaredAt && x.declaredAt <= addMinutes(x.lastSurgeryAt, 30 * 24 * 60)) t.push('postop')
  if (x.codeBlue) t.push('afterCode')
  if (x.lastIcuOutAt && x.lastIcuOutAt <= x.declaredAt && x.declaredAt <= addMinutes(x.lastIcuOutAt, 48 * 60)) t.push('icuOut')
  return t
}

export type ReviewGrade = 'unavoidable' | 'possibly' | 'avoidable' | 'discuss'
export const REVIEW_GRADES: { key: ReviewGrade; label: string }[] = [
  { key: 'unavoidable', label: '無可避免' },
  { key: 'possibly', label: '可能可避免' },
  { key: 'avoidable', label: '可避免' },
  { key: 'discuss', label: '需提病例討論' },
]
export const reviewGradeLabel = (g?: ReviewGrade) => REVIEW_GRADES.find((x) => x.key === g)?.label ?? ''
/** 審查：結論、檢討要寫；不是「無可避免」要寫改善事項；需提病例討論要排日期（今天以後）與報告人 */
export function checkMortalityReview(x: { grade?: string; findings?: string; improvement?: string; conferenceDate?: string; presenter?: string }, today: string): Record<string, string> {
  const e: Record<string, string> = {}
  if (!REVIEW_GRADES.some((g) => g.key === x.grade)) e.grade = '請選審查結論'
  if (!x.findings?.trim()) e.findings = '請寫檢討（過程中的問題、做得好的地方）'
  if (x.grade && x.grade !== 'unavoidable' && !x.improvement?.trim()) e.improvement = '請寫改善事項'
  if (x.grade === 'discuss') {
    if (!x.conferenceDate || !/^\d{4}-\d{2}-\d{2}$/.test(x.conferenceDate)) e.conferenceDate = '請排病例討論的日期'
    else if (x.conferenceDate < today) e.conferenceDate = '病例討論的日期不能是過去'
    if (!x.presenter?.trim()) e.presenter = '請寫報告人'
  }
  return e
}

/**
 * APACHE II 預估死亡率（Knaus 1985）：ln(R/(1−R)) = −3.517 + 0.146 × APACHE II ＋ 診斷類別係數（＋0.603 急診手術後）。
 * 類別只放常見的（係數照原文，但本系統的 APACHE II 是簡化版，預估值只供參考）
 */
export const APACHE_CATEGORIES: { key: string; label: string; weight: number; postop?: boolean }[] = [
  { key: 'sepsis', label: '敗血症', weight: 0.113 },
  { key: 'septicShock', label: '敗血性休克', weight: 0.113 },
  { key: 'resp-infection', label: '呼吸衰竭：感染（肺炎）', weight: 0 },
  { key: 'resp-copd', label: '呼吸衰竭：慢性阻塞性肺病', weight: -0.367 },
  { key: 'resp-aspiration', label: '呼吸衰竭：吸入、中毒', weight: -0.142 },
  { key: 'resp-neoplasm', label: '呼吸衰竭：肺部腫瘤', weight: 0.891 },
  { key: 'cv-chf', label: '心衰竭', weight: -0.424 },
  { key: 'cv-arrest', label: '心跳停止後', weight: 0.393 },
  { key: 'cv-cardiogenic', label: '心因性休克', weight: -0.259 },
  { key: 'cv-hemorrhagic', label: '出血性休克', weight: 0.493 },
  { key: 'gi-bleed', label: '腸胃道出血', weight: 0.334 },
  { key: 'neuro-ich', label: '腦出血（顱內、蜘蛛網膜下腔）', weight: 0.723 },
  { key: 'neuro-seizure', label: '癲癇', weight: -0.584 },
  { key: 'dka', label: '糖尿病酮酸中毒', weight: -1.507 },
  { key: 'overdose', label: '藥物過量', weight: -3.353 },
  { key: 'postop-gi', label: '手術後：腸胃道穿孔或阻塞', weight: 0.06, postop: true },
  { key: 'postop-other', label: '手術後：其他', weight: -0.613, postop: true },
  { key: 'other', label: '其他（以 0 計）', weight: 0 },
]
export const apacheCategoryLabel = (k?: string) => APACHE_CATEGORIES.find((c) => c.key === k)?.label ?? ''
export function apacheMortality(score: number, category: string | undefined, emergencySurgery: boolean): number {
  const w = APACHE_CATEGORIES.find((c) => c.key === category)?.weight ?? 0
  const logit = -3.517 + 0.146 * score + w + (emergencySurgery ? 0.603 : 0)
  return Math.round((1 / (1 + Math.exp(-logit))) * 1000) / 10
}

/** 院內死亡率（%，一位小數）；SMR＝實際死亡 ÷ 預估死亡（預估加總 0 時沒有） */
export const ratePct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null)
export const smrOf = (observed: number, expected: number) => (expected > 0 ? Math.round((observed / expected) * 100) / 100 : null)
