// 麻醉（純函式）：麻醉前評估的分級、呼吸道判斷、欄位檢查。服務層（anesthesia.ts）、手術室畫面、首頁都用這一份
import type { AnesHistoryKey, AnesthesiaType, AsaClass, NpoStatus, PreAnesthesia } from '@/types'
import { parseDate } from '@/utils/date'

export const ASA_LABEL: Record<AsaClass, string> = { 1: '健康', 2: '輕度全身疾病', 3: '重度全身疾病', 4: '持續威脅生命的重度疾病', 5: '不手術難以存活' }
export const NPO_LABEL: Record<NpoStatus, string> = { ok: '已禁食', not: '未禁食', unknown: '不清楚' }
export const HISTORY_LABEL: Record<AnesHistoryKey, string> = { cardiac: '心臟', pulmonary: '肺', renal: '腎', hepatic: '肝', endocrine: '內分泌（糖尿病、甲狀腺）', neuro: '神經（中風、癲癇）' }
export const AIRWAY_LABEL = { ok: '正常', limited: '受限' } as const
/** 擇期手術禁食時數（固體） */
export const NPO_HOURS = 8

export const asaText = (p: Pick<PreAnesthesia, 'asa' | 'emergency'>) => `ASA ${p.asa}${p.emergency ? 'E' : ''}`
/** 困難插管：Mallampati III–IV、張口受限、頸部活動受限任一 */
export const difficultAirway = (a: PreAnesthesia['airway']) => a.mallampati >= 3 || a.mouth === 'limited' || a.neck === 'limited'
export const npoHours = (lastIntake: string | undefined, at: string) =>
  lastIntake ? Math.floor((parseDate(at).getTime() - parseDate(lastIntake).getTime()) / 3600000) : undefined

export interface PreAnesInput {
  asa?: number
  airway?: { mallampati?: number; mouth?: string; neck?: string; note?: string }
  npo?: { status?: string; lastIntake?: string }
  brief?: boolean
  history?: { items?: string[]; note?: string }
  plan?: string
  planReason?: string
}

/** 欄位檢查（一次標出）：精簡版只有急刀可以；完整版要病史、計畫，和申請不同要原因；未禁食要寫最後進食時間 */
export function checkPreAnes(x: PreAnesInput, ctx: { urgent: boolean; requested: AnesthesiaType; at: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (![1, 2, 3, 4, 5].includes(Number(x.asa))) e.asa = '請選 ASA 分級'
  if (![1, 2, 3, 4].includes(Number(x.airway?.mallampati))) e.mallampati = '請選 Mallampati 分級'
  if (!['ok', 'limited'].includes(x.airway?.mouth ?? '')) e.mouth = '請評估張口度'
  if (!['ok', 'limited'].includes(x.airway?.neck ?? '')) e.neck = '請評估頸部活動'
  if (!['ok', 'not', 'unknown'].includes(x.npo?.status ?? '')) e.npo = '請選禁食狀態'
  else if (x.npo!.status !== 'unknown') {
    const li = x.npo!.lastIntake ?? ''
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(li)) e.lastIntake = '請填最後進食時間'
    else if (li > ctx.at) e.lastIntake = '最後進食時間不能在未來'
  }
  if (x.brief && !ctx.urgent) e.brief = '只有急刀可以先做精簡版，擇期手術請完整評估'
  if (!x.brief) {
    if (!x.history || !Array.isArray(x.history.items) || x.history.items.some((k) => !(k in HISTORY_LABEL))) e.history = '請勾選重大病史（沒有就勾「無」）'
    if (!x.plan || !['general', 'spinal', 'regional', 'local'].includes(x.plan)) e.plan = '請選計畫的麻醉方式'
    else if (x.plan !== ctx.requested && !x.planReason?.trim()) e.planReason = '和申請的麻醉方式不同，請寫原因'
  }
  return e
}

/** 一行摘要：「ASA 2・Mallampati II・困難插管・已禁食 9 小時・全身麻醉」 */
export function preAnesSummary(p: PreAnesthesia, planLabel?: string): string {
  const h = npoHours(p.npo.lastIntake, p.at)
  return [
    asaText(p), `Mallampati ${['I', 'II', 'III', 'IV'][p.airway.mallampati - 1]}`, p.difficult && '困難插管',
    `${NPO_LABEL[p.npo.status]}${h !== undefined ? `（最後進食 ${h} 小時前）` : ''}`,
    p.history && (p.history.items.length ? `病史：${p.history.items.map((k) => HISTORY_LABEL[k]).join('、')}` : '無重大病史'),
    planLabel, p.brief && '精簡版（病史與計畫待補）',
  ].filter(Boolean).join('・')
}
