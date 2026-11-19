// 麻醉（純函式）：麻醉前評估的分級、呼吸道判斷、欄位檢查。服務層（anesthesia.ts）、手術室畫面、首頁都用這一份
import type { AnesDrugKey, AnesEntry, AnesEventKind, AnesFluidKind, AnesHistoryKey, AnesOutputKind, AnesRecord, AnesthesiaType, AsaClass, NpoStatus, PacuRecord, PacuScore, PreAnesthesia } from '@/types'
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

// ---------- 術中麻醉紀錄 ----------
/** 麻醉用藥（展示用常用藥；不連庫存） */
export const ANES_DRUGS: Record<AnesDrugKey, { label: string; unit: string; max: number }> = {
  propofol: { label: 'Propofol', unit: 'mg', max: 500 },
  fentanyl: { label: 'Fentanyl', unit: 'mcg', max: 500 },
  rocuronium: { label: 'Rocuronium', unit: 'mg', max: 200 },
  ephedrine: { label: 'Ephedrine', unit: 'mg', max: 50 },
  phenylephrine: { label: 'Phenylephrine', unit: 'mcg', max: 1000 },
  atropine: { label: 'Atropine', unit: 'mg', max: 3 },
  ondansetron: { label: 'Ondansetron', unit: 'mg', max: 8 },
  sugammadex: { label: 'Sugammadex', unit: 'mg', max: 1600 },
}
export const FLUID_LABEL: Record<AnesFluidKind, string> = { crystalloid: '晶體液', colloid: '膠體液', blood: '血品' }
export const OUTPUT_LABEL: Record<AnesOutputKind, string> = { blood: '失血', urine: '尿量' }
export const ANES_EVENT_LABEL: Record<AnesEventKind, string> = { induction: '誘導', intubation: '插管', extubation: '拔管', position: '擺位', other: '其他' }
/** 生命徵象多久沒記要標示（分鐘） */
export const ANES_VITAL_GAP = 15
/** 術中低血壓（收縮壓）、低血氧（SpO2）門檻 */
export const HYPOTENSION_SBP = 90
export const HYPOXEMIA_SPO2 = 90

const mins = (a: string, b: string) => Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 60000)

export interface AnesEntryInput {
  type?: string
  at?: string
  sbp?: number
  dbp?: number
  hr?: number
  spo2?: number
  etco2?: number
  drug?: string
  dose?: number
  fluid?: string
  output?: string
  ml?: number
  event?: string
  note?: string
}

/** 一筆紀錄的欄位檢查：時間在麻醉開始到現在（結束了就到結束）之間；生命徵象至少一項、範圍合理；用藥劑量不超過上限 */
export function checkAnesEntry(x: AnesEntryInput, ctx: { startAt: string; endAt?: string; now: string }): Record<string, string> {
  const e: Record<string, string> = {}
  const range = (k: keyof AnesEntryInput, lo: number, hi: number, label: string) => {
    const v = x[k]
    if (v === undefined || v === null || (v as unknown) === '') return false
    if (!Number.isFinite(Number(v)) || Number(v) < lo || Number(v) > hi) e[k] = `${label}要在 ${lo}–${hi}`
    return true
  }
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.at ?? '')) e.at = '請填時間'
  else if (x.at! < ctx.startAt) e.at = '不能早於麻醉開始'
  else if (x.at! > (ctx.endAt ?? ctx.now)) e.at = ctx.endAt ? '不能晚於麻醉結束' : '不能在未來'
  if (x.type === 'vital') {
    const any = [range('sbp', 30, 260, '收縮壓'), range('dbp', 10, 160, '舒張壓'), range('hr', 20, 220, '心跳'), range('spo2', 50, 100, '血氧'), range('etco2', 5, 100, '呼氣末二氧化碳')].some(Boolean)
    if (!any) e.sbp = '至少記一項'
    if (!e.sbp && !e.dbp && x.sbp !== undefined && x.dbp !== undefined && Number(x.dbp) >= Number(x.sbp)) e.dbp = '舒張壓要小於收縮壓'
  } else if (x.type === 'drug') {
    const d = ANES_DRUGS[x.drug as AnesDrugKey]
    if (!d) e.drug = '請選藥品'
    else if (!(Number(x.dose) > 0)) e.dose = '請填劑量'
    else if (Number(x.dose) > d.max) e.dose = `${d.label} 一次最多 ${d.max} ${d.unit}`
  } else if (x.type === 'fluid' || x.type === 'output') {
    if (x.type === 'fluid' && !(x.fluid! in FLUID_LABEL)) e.fluid = '請選種類'
    if (x.type === 'output' && !(x.output! in OUTPUT_LABEL)) e.output = '請選種類'
    if (!(Number(x.ml) > 0) || Number(x.ml) > 5000) e.ml = '請填 1–5000 mL'
  } else if (x.type === 'event') {
    if (!(x.event! in ANES_EVENT_LABEL)) e.event = '請選事件'
    else if (x.event === 'other' && !x.note?.trim()) e.note = '其他事件要寫內容'
  } else e.type = '請選紀錄類別'
  return e
}

/** 生命徵象空窗：麻醉開始到結束（還沒結束算到現在），相鄰兩筆（含開始）超過 15 分鐘 */
export function vitalGaps(r: AnesRecord, now: string): { from: string; to: string; minutes: number; open: boolean }[] {
  if (!r.startAt) return []
  const end = r.endAt ?? now
  const ts = [r.startAt, ...r.entries.filter((x) => x.type === 'vital').map((x) => x.at).sort(), end]
  const out: { from: string; to: string; minutes: number; open: boolean }[] = []
  for (let i = 1; i < ts.length; i++) {
    const m = mins(ts[i - 1], ts[i])
    if (m > ANES_VITAL_GAP) out.push({ from: ts[i - 1], to: ts[i], minutes: m, open: i === ts.length - 1 && !r.endAt })
  }
  return out
}

/** 術中異常（自動列出，交班與恢復室看）：收縮壓 < 90、SpO2 < 90；連續的算一次，記最低值與之後 15 分鐘內的處置用藥 */
export function intraopAlerts(r: AnesRecord): { at: string; kind: 'hypotension' | 'hypoxemia'; text: string }[] {
  const vs = r.entries.filter((x) => x.type === 'vital').sort((a, b) => a.at.localeCompare(b.at))
  const out: { at: string; kind: 'hypotension' | 'hypoxemia'; text: string }[] = []
  for (const kind of ['hypotension', 'hypoxemia'] as const) {
    const bad = (v: AnesEntry) => (kind === 'hypotension' ? v.sbp !== undefined && v.sbp < HYPOTENSION_SBP : v.spo2 !== undefined && v.spo2 < HYPOXEMIA_SPO2)
    let run: AnesEntry[] = []
    const flush = () => {
      if (!run.length) return
      const at = run[0].at
      const low = kind === 'hypotension' ? Math.min(...run.map((v) => v.sbp!)) : Math.min(...run.map((v) => v.spo2!))
      const tx = r.entries.filter((x) => x.type === 'drug' && x.at >= at && mins(at, x.at) <= 15).map((x) => `${ANES_DRUGS[x.drug!].label} ${x.dose} ${ANES_DRUGS[x.drug!].unit}`)
      out.push({ at, kind, text: `${at.slice(11)} ${kind === 'hypotension' ? `低血壓（收縮壓最低 ${low}）` : `低血氧（SpO2 最低 ${low}%）`}${tx.length ? `，給 ${tx.join('、')}` : ''}` })
      run = []
    }
    for (const v of vs) {
      if (v.sbp === undefined && kind === 'hypotension') continue
      if (v.spo2 === undefined && kind === 'hypoxemia') continue
      if (bad(v)) run.push(v)
      else flush()
    }
    flush()
  }
  return out.sort((a, b) => a.at.localeCompare(b.at))
}

/** 輸入輸出合計（mL） */
export function anesTotals(r: AnesRecord): { fluid: number; blood: number; bloodLoss: number; urine: number } {
  const sum = (f: (x: AnesEntry) => boolean) => r.entries.filter(f).reduce((n, x) => n + (x.ml ?? 0), 0)
  return {
    fluid: sum((x) => x.type === 'fluid' && x.fluid !== 'blood'), blood: sum((x) => x.type === 'fluid' && x.fluid === 'blood'),
    bloodLoss: sum((x) => x.type === 'output' && x.output === 'blood'), urine: sum((x) => x.type === 'output' && x.output === 'urine'),
  }
}

/** 一筆紀錄的文字 */
export function anesEntryText(x: AnesEntry): string {
  if (x.type === 'vital') return [x.sbp !== undefined && `BP ${x.sbp}/${x.dbp ?? '—'}`, x.hr !== undefined && `HR ${x.hr}`, x.spo2 !== undefined && `SpO2 ${x.spo2}%`, x.etco2 !== undefined && `EtCO2 ${x.etco2}`].filter(Boolean).join('・')
  if (x.type === 'drug') return `${ANES_DRUGS[x.drug!].label} ${x.dose} ${ANES_DRUGS[x.drug!].unit}`
  if (x.type === 'fluid') return `${FLUID_LABEL[x.fluid!]} ${x.ml} mL`
  if (x.type === 'output') return `${OUTPUT_LABEL[x.output!]} ${x.ml} mL`
  return `${ANES_EVENT_LABEL[x.event!]}${x.note ? `：${x.note}` : ''}`
}

// ---------- 恢復室（PACU） ----------
export const ALDRETE_ITEMS: { key: 'activity' | 'respiration' | 'circulation' | 'consciousness' | 'spo2'; label: string; options: [string, string, string] }[] = [
  { key: 'activity', label: '活動', options: ['不能動', '能動兩肢', '能動四肢'] },
  { key: 'respiration', label: '呼吸', options: ['沒有自發呼吸', '呼吸困難或淺', '能深呼吸、咳嗽'] },
  { key: 'circulation', label: '循環', options: ['血壓和術前差 50% 以上', '差 20–49%', '差 20% 以內'] },
  { key: 'consciousness', label: '意識', options: ['叫不醒', '叫得醒', '完全清醒'] },
  { key: 'spo2', label: '血氧', options: ['給氧仍 < 90%', '要給氧才 > 90%', '室內空氣 > 92%'] },
]
/** 轉出條件 */
export const PACU_ALDRETE_MIN = 9
export const PACU_PAIN_MAX = 4
/** 評分間隔（分鐘）、停留提醒（分鐘） */
export const PACU_SCORE_EVERY = 15
export const PACU_LONG_MINUTES = 120

export const aldreteOf = (s: Pick<PacuScore, 'activity' | 'respiration' | 'circulation' | 'consciousness' | 'spo2'>) => s.activity + s.respiration + s.circulation + s.consciousness + s.spo2

/** 轉出條件沒達到的項目（空＝可以轉出）；還沒評分＝不能 */
export function pacuUnmet(latest: PacuScore | undefined): string[] {
  if (!latest) return ['還沒評分']
  const out: string[] = []
  const a = aldreteOf(latest)
  if (a < PACU_ALDRETE_MIN) out.push(`Aldrete ${a} 分（要 ≥ ${PACU_ALDRETE_MIN}）`)
  if (latest.pain > PACU_PAIN_MAX) out.push(`疼痛 ${latest.pain} 分（要 ≤ ${PACU_PAIN_MAX}）`)
  if (latest.ponv) out.push('噁心嘔吐')
  return out
}

/** 評分欄位檢查 */
export function checkPacuScore(x: Partial<Record<string, unknown>>): Record<string, string> {
  const e: Record<string, string> = {}
  for (const it of ALDRETE_ITEMS) if (![0, 1, 2].includes(Number(x[it.key])) || x[it.key] === '' || x[it.key] === undefined) e[it.key] = `請評${it.label}`
  const p = x.pain
  if (p === undefined || p === '' || !Number.isInteger(Number(p)) || Number(p) < 0 || Number(p) > 10) e.pain = '疼痛 0–10'
  if (typeof x.ponv !== 'boolean') e.ponv = '請選有無噁心嘔吐'
  return e
}

/** 恢復室狀態：in（恢復室中）、out（已轉出、病房待接回）、back（已接回） */
export const pacuStage = (p: PacuRecord | undefined): 'in' | 'out' | 'back' | undefined => (!p ? undefined : p.received ? 'back' : p.out ? 'out' : 'in')
