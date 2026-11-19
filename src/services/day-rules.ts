// 日間手術（純函式）：PADSS 出院評分、可以出院的條件、ASA 上限、階段、隔天電話追蹤。
// 服務層（day.ts）、手術室「日間手術」分頁、首頁待辦、種子、測試都用這一份
import type { Admission, PadssScore, Surgery } from '@/types'

/** 麻醉前評估 ASA 超過這個不能做日間手術（要改住院） */
export const DAY_ASA_MAX = 3
/** PADSS 幾分以上可以回家 */
export const PADSS_MIN = 9
/** 最後一次 PADSS 要在幾分鐘內才能出院 */
export const PADSS_FRESH = 30

export type PadssKey = 'vitals' | 'activity' | 'ponv' | 'pain' | 'bleeding'
export const PADSS_ITEMS: { key: PadssKey; label: string; options: [string, string, string] }[] = [
  { key: 'vitals', label: '生命徵象', options: ['和術前差 > 40%', '和術前差 20–40%', '和術前差 < 20%'] },
  { key: 'activity', label: '活動', options: ['不能走', '要人扶', '步態穩、不頭暈'] },
  { key: 'ponv', label: '噁心嘔吐', options: ['嚴重（治療後仍持續）', '中度（打針後緩解）', '輕微（口服藥可控制）'] },
  { key: 'pain', label: '疼痛', options: ['口服止痛藥控制不了', '要打針止痛', '口服止痛藥可以控制'] },
  { key: 'bleeding', label: '傷口出血', options: ['嚴重（換藥 3 次以上）', '中度（換藥 2–3 次）', '輕微（不用換或換 1 次）'] },
]
export const padssOf = (x: Pick<PadssScore, PadssKey>): number => PADSS_ITEMS.reduce((n, it) => n + Number(x[it.key]), 0)

export function checkPadss(input: Partial<Record<PadssKey, unknown>>): Record<string, string> {
  const e: Record<string, string> = {}
  for (const it of PADSS_ITEMS) {
    const v = input[it.key]
    if (v === undefined || v === null || v === '' || ![0, 1, 2].includes(Number(v))) e[it.key] = `請評「${it.label}」`
  }
  return e
}

/** 出院還差什麼：PADSS 未達、太久沒評、陪同、衛教（一次列出） */
export function dayDischargeUnmet(latest: Pick<PadssScore, PadssKey | 'at'> | undefined, minutesAgo: number | undefined, input: { escort?: string; teaching?: boolean }): string[] {
  const out: string[] = []
  if (!latest) out.push('還沒評 PADSS')
  else {
    const n = padssOf(latest)
    if (n < PADSS_MIN) out.push(`PADSS ${n} 分（要 ≥ ${PADSS_MIN}）`)
    if ((minutesAgo ?? 0) > PADSS_FRESH) out.push(`最後一次 PADSS 是 ${minutesAgo} 分鐘前（要 ${PADSS_FRESH} 分鐘內，請重評）`)
  }
  if (!input.escort?.trim()) out.push('要有成人陪同回家（寫姓名與關係）')
  if (input.teaching !== true) out.push('要完成出院衛教')
  return out
}

export type DayStage = 'reserved' | 'checkedIn' | 'inOr' | 'pacu' | 'phase2' | 'out' | 'converted' | 'cancelled'
export const DAY_STAGE_LABEL: Record<DayStage, string> = {
  reserved: '待報到', checkedIn: '已報到', inOr: '手術室', pacu: '恢復室（第一期）', phase2: '待出院評估（第二期）', out: '已回家', converted: '轉住院', cancelled: '取消',
}
/** 階段：報到前、報到、手術室（已送到手術中）、恢復室第一期、第二期（局部麻醉做完直接到這）、回家、轉住院 */
export function dayStage(a: Pick<Admission, 'status' | 'day'>, s: Pick<Surgery, 'status' | 'pacu'> | undefined): DayStage {
  if (a.day?.converted) return 'converted'
  if (a.day?.out) return 'out'
  if (a.status === 'cancelled' || s?.status === 'cancelled') return 'cancelled'
  if (a.status === 'reserved') return 'reserved'
  if (!s || s.status === 'requested' || s.status === 'scheduled') return 'checkedIn'
  if (s.status === 'sent' || s.status === 'in-progress') return 'inOr'
  if (s.pacu && !s.pacu.out) return 'pacu'
  return 'phase2'
}

/** 回家後要電話追蹤：回家那天之後（隔天起）還沒打 */
export const dayFollowUpDue = (a: Pick<Admission, 'day'>, today: string): boolean => !!a.day?.out && !a.day.followUp && a.day.out.at.slice(0, 10) < today
