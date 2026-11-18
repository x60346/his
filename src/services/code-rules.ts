// 急救（Code Blue，純函式）：事件種類、DNR 擋哪些事、電擊與藥物的檢查、腎上腺素 3–5 分鐘提示、品質指標。
// 急救頁、服務層、測試都用這一份
import type { CodeBlue, CodeEvent, CodeEventKind, CodeRhythm, DnrItem } from '@/types'
import { addMinutes } from '@/utils/date'

export const CODE_RHYTHMS: { key: CodeRhythm; label: string; shockable: boolean }[] = [
  { key: 'vf', label: '心室顫動 VF', shockable: true },
  { key: 'pvt', label: '無脈性心室頻脈 pVT', shockable: true },
  { key: 'pea', label: '無脈性電氣活動 PEA', shockable: false },
  { key: 'asystole', label: '心搏停止 Asystole', shockable: false },
]
export const rhythmLabel = (r?: CodeRhythm) => CODE_RHYTHMS.find((x) => x.key === r)?.label ?? ''
export const isShockable = (r?: CodeRhythm) => !!CODE_RHYTHMS.find((x) => x.key === r)?.shockable

export const CODE_EVENT_LABEL: Record<CodeEventKind, string> = {
  cpr: '開始 CPR（胸外按壓）',
  rhythm: '心律判讀',
  shock: '電擊',
  epi: '腎上腺素 Epinephrine 1 mg IV',
  amio: 'Amiodarone IV',
  intubate: '氣管內插管',
  bvm: '甦醒球人工呼吸',
  note: '備註',
}
/** 每種事件被 DNR 哪一項擋（備註、心律判讀不擋） */
export const CODE_DNR_ITEM: Partial<Record<CodeEventKind, DnrItem>> = { cpr: 'compress', shock: 'defib', epi: 'drugs', amio: 'drugs', intubate: 'intubation', bvm: 'ventilation' }
/** 要醫師帶領才能記（口頭醫囑：藥、電擊、插管） */
export const CODE_NEEDS_LEADER: CodeEventKind[] = ['shock', 'epi', 'amio', 'intubate']
/** 腎上腺素 3–5 分鐘一次：上一劑滿 3 分鐘可以給、超過 5 分鐘提示 */
export const EPI_MIN = 3
export const EPI_MAX = 5
/** 電擊能量（雙相）120–360 J */
export const JOULES_RANGE: [number, number] = [120, 360]
/** Amiodarone：第一劑 300 mg、第二劑 150 mg，最多兩劑 */
export const AMIO_DOSES = [300, 150]

export const dnrBlockText = (kind: CodeEventKind, withhold: DnrItem[] | undefined): string | undefined => {
  const item = CODE_DNR_ITEM[kind]
  if (!item || !withhold?.includes(item)) return undefined
  const what: Record<DnrItem, string> = { compress: '不施行胸外按壓', defib: '不施行電擊', drugs: '不施行急救藥物', intubation: '不施行氣管內插管', ventilation: '不施行人工呼吸', pacing: '不施行心臟人工調頻', feeding: '不施行人工營養' }
  return `病人 DNR：${what[item]}，不能記「${CODE_EVENT_LABEL[kind]}」`
}

/** 最近一次心律判讀 */
export const lastRhythm = (c: Pick<CodeBlue, 'events'>) => [...c.events].reverse().find((e) => e.kind === 'rhythm')?.rhythm
export const cprStarted = (c: Pick<CodeBlue, 'events'>) => c.events.some((e) => e.kind === 'cpr')

/**
 * 記一筆事件前的檢查（欄位 rhythm、joules；其他是整筆的錯）：
 *   - 心律判讀要選心律；電擊要 120–360 J，而且最近的心律要可電擊（VF、pVT）
 *   - CPR 只開始一次；Amiodarone 最多兩劑（300 → 150），要在可電擊心律下給
 */
export function checkCodeEvent(c: Pick<CodeBlue, 'events'>, x: { kind: CodeEventKind; rhythm?: string; joules?: number; note?: string }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!(x.kind in CODE_EVENT_LABEL)) return { kind: '事件種類不正確' }
  if (x.kind === 'rhythm' && !CODE_RHYTHMS.some((r) => r.key === x.rhythm)) e.rhythm = '請選心律'
  if (x.kind === 'shock') {
    if (!x.joules || x.joules < JOULES_RANGE[0] || x.joules > JOULES_RANGE[1]) e.joules = `能量請填 ${JOULES_RANGE[0]}–${JOULES_RANGE[1]} J`
    if (!isShockable(lastRhythm(c))) e.kind = lastRhythm(c) ? `目前心律是${rhythmLabel(lastRhythm(c))}：不可電擊（先繼續 CPR、給腎上腺素）` : '請先判讀心律（VF、pVT 才能電擊）'
  }
  if (x.kind === 'cpr' && cprStarted(c)) e.kind = 'CPR 已經開始了'
  if (x.kind === 'amio') {
    if (c.events.filter((ev) => ev.kind === 'amio').length >= AMIO_DOSES.length) e.kind = 'Amiodarone 已經給了兩劑（300 mg、150 mg）'
    else if (!isShockable(lastRhythm(c))) e.kind = 'Amiodarone 用在電擊後仍是 VF、pVT 的時候'
  }
  if (x.kind === 'note' && !x.note?.trim()) e.note = '請寫備註'
  return e
}
/** Amiodarone 這一劑幾 mg */
export const nextAmioDose = (c: Pick<CodeBlue, 'events'>) => AMIO_DOSES[c.events.filter((e) => e.kind === 'amio').length]

/** 腎上腺素提示：還沒給過（CPR 中就該準備）、可以給了（滿 3 分鐘）、超過 5 分鐘 */
export function epiState(c: Pick<CodeBlue, 'events' | 'status'>, t: string): { status: 'none' | 'wait' | 'due' | 'overdue'; last?: string; dueAt?: string } | undefined {
  if (c.status !== 'active' || !cprStarted(c)) return undefined
  const last = [...c.events].reverse().find((e) => e.kind === 'epi')?.at
  if (!last) return { status: 'none' }
  const dueAt = addMinutes(last, EPI_MAX)
  return { status: t > dueAt ? 'overdue' : t >= addMinutes(last, EPI_MIN) ? 'due' : 'wait', last, dueAt }
}

export type CodeOutcome = NonNullable<CodeBlue['outcome']>
export const CODE_OUTCOME_LABEL: Record<CodeOutcome, string> = { rosc: '恢復自主循環 ROSC', death: '宣告死亡', dnr: '依 DNR 不施行急救' }
/**
 * 結束急救的檢查：ROSC 要有開始 CPR（沒按壓就談不上恢復）；依 DNR 不施行要病人真的有「不按壓」，而且沒開始 CPR；
 * 宣告死亡要醫師（呼叫端擋）
 */
export function checkCodeEnd(c: Pick<CodeBlue, 'events'>, outcome: string, withhold: DnrItem[] | undefined): string | undefined {
  if (!(outcome in CODE_OUTCOME_LABEL)) return '請選結果'
  if (outcome === 'rosc' && !cprStarted(c)) return '還沒開始 CPR：不能記恢復自主循環'
  if (outcome === 'dnr' && !withhold?.includes('compress')) return '病人沒有「不施行胸外按壓」的 DNR：要急救'
  if (outcome === 'dnr' && cprStarted(c)) return '已經開始 CPR 了'
  return undefined
}

/** 品質指標：急救次數、恢復自主循環比例（依 DNR 不施行的不算分母） */
export function codeStats(codes: Pick<CodeBlue, 'status' | 'outcome'>[]) {
  const ended = codes.filter((c) => c.status === 'ended' && c.outcome !== 'dnr')
  const rosc = ended.filter((c) => c.outcome === 'rosc').length
  return { codes: codes.length, resus: ended.length, rosc, roscRate: ended.length ? Math.round((rosc / ended.length) * 1000) / 10 : null, dnr: codes.filter((c) => c.outcome === 'dnr').length }
}

/** 時間軸顯示 */
export function codeEventText(e: Pick<CodeEvent, 'kind' | 'rhythm' | 'joules' | 'doseMg' | 'note'>): string {
  if (e.kind === 'rhythm') return `心律：${rhythmLabel(e.rhythm)}`
  if (e.kind === 'shock') return `電擊 ${e.joules} J`
  if (e.kind === 'amio') return `Amiodarone ${e.doseMg} mg IV`
  if (e.kind === 'note') return `備註：${e.note}`
  return CODE_EVENT_LABEL[e.kind]
}
