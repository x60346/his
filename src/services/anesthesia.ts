// 麻醉：麻醉前評估（有「麻醉」權限的醫師）。沒有評估不能做麻醉前查核（surgery.recordCheck 擋）。
// 規則在 anesthesia-rules（純函式）；手術的畫面資料在 surgery-work
import type { AnesDrugKey, AnesEntry, AnesEntryType, AnesEventKind, AnesFluidKind, AnesHistoryKey, AnesOutputKind, AnesRecord, AnesthesiaType, AsaClass, NpoStatus, PreAnesthesia, Surgery } from '@/types'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser, type Actor } from './http'
import { anesEntryText, anesTotals, asaText, checkAnesEntry, checkPreAnes, difficultAirway, intraopAlerts, vitalGaps, type AnesEntryInput, type PreAnesInput } from './anesthesia-rules'
import { ANESTHESIA_LABEL, SIDE_LABEL } from './surgery-rules'
import { surgeryOf, surgeryView, type SurgeryView } from './surgery-work'
import { find, nameOf } from './views'

/** 存麻醉前評估（可以重存：精簡版事後補成完整版、病人狀況改變） */
export function savePreAnes(surgeryId: string, input: PreAnesInput): Promise<SurgeryView> {
  return mutate(() => {
    requireUser('doctor')
    const u = requirePermission('anesthesia')
    const s = must(surgeryOf(surgeryId), '手術')
    if (s.status === 'cancelled') fail('手術已取消', 'CONFLICT')
    if (s.status === 'in-progress' || s.status === 'done') fail('手術已經開始，麻醉前評估不能再改', 'CONFLICT')
    const t = now()
    const requested = s.preAnes?.changedFrom ?? s.anesthesia
    failFields(checkPreAnes(input, { urgent: !!s.urgency, requested, at: t }))
    const airway = { mallampati: Number(input.airway!.mallampati) as 1 | 2 | 3 | 4, mouth: input.airway!.mouth as 'ok' | 'limited', neck: input.airway!.neck as 'ok' | 'limited', ...(input.airway!.note?.trim() ? { note: input.airway!.note.trim() } : {}) }
    const plan = input.brief ? undefined : (input.plan as AnesthesiaType)
    const p: PreAnesthesia = {
      asa: Number(input.asa) as AsaClass, emergency: !!s.urgency, airway, difficult: difficultAirway(airway),
      npo: { status: input.npo!.status as NpoStatus, ...(input.npo!.status !== 'unknown' ? { lastIntake: input.npo!.lastIntake } : {}) },
      ...(input.brief ? { brief: true } : { history: { items: [...new Set(input.history!.items as AnesHistoryKey[])], ...(input.history!.note?.trim() ? { note: input.history!.note.trim() } : {}) }, plan }),
      ...(plan && plan !== requested ? { planReason: input.planReason!.trim(), changedFrom: requested } : {}),
      by: u.id, at: t,
    }
    const again = !!s.preAnes
    s.preAnes = p
    // 計畫的麻醉方式就是這台手術的麻醉方式（麻醉費照這個）；改回申請的就還原
    if (plan) s.anesthesia = plan
    audit(again ? '修改麻醉前評估' : '麻醉前評估', `${s.no} ${nameOf.patient(s.patientId)} ${find.procedure(s.procId)?.name ?? ''}（${SIDE_LABEL[s.side]}）：${asaText(p)}${p.difficult ? '、困難插管' : ''}${p.brief ? '、精簡版' : ''}${plan ? `、${ANESTHESIA_LABEL[plan]}${p.changedFrom ? `（原申請${ANESTHESIA_LABEL[p.changedFrom]}：${p.planReason}）` : ''}` : ''}`)
    return surgeryView(s)
  })
}

// ---------- 術中麻醉紀錄 ----------
const editable = (s: Surgery) => {
  if (s.status === 'done') fail('手術已完成，麻醉紀錄不能再改', 'CONFLICT')
  if (s.status !== 'sent' && s.status !== 'in-progress') fail('病人送到手術室後才能記麻醉紀錄', 'CONFLICT')
}
const atOf = (at: string | undefined, t: string) => (at?.trim() ? at.trim() : t.slice(0, 16))
const recText = (s: Surgery) => `${s.no} ${nameOf.patient(s.patientId)}`

/** 麻醉開始（誘導）：麻醉前查核（Sign In）之後；時間可以補記（不早於送手術室、不在未來） */
export function startAnes(surgeryId: string, input: { at?: string } = {}): Promise<SurgeryView> {
  return mutate(() => {
    requireUser('doctor')
    const u = requirePermission('anesthesia')
    const s = must(surgeryOf(surgeryId), '手術')
    editable(s)
    if (s.anes?.startAt) fail('麻醉已經開始了', 'CONFLICT')
    if (!s.checks.signIn) fail('請先完成麻醉前查核（Sign In）', 'CONFLICT')
    const t = now()
    const at = atOf(input.at, t)
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at)) failField('at', '請填時間')
    if (at > t) failField('at', '不能在未來')
    if (at < s.checks.signIn.at.slice(0, 16)) failField('at', `不能早於麻醉前查核（${s.checks.signIn.at.slice(11)}）`)
    s.anes = { ...(s.anes ?? { entries: [] }), startAt: at }
    audit('麻醉開始', `${recText(s)}：${at}（${u.name}）`)
    return surgeryView(s)
  })
}

/** 麻醉結束：不早於最後一筆紀錄 */
export function endAnes(surgeryId: string, input: { at?: string } = {}): Promise<SurgeryView> {
  return mutate(() => {
    requireUser('doctor')
    requirePermission('anesthesia')
    const s = must(surgeryOf(surgeryId), '手術')
    editable(s)
    if (!s.anes?.startAt) fail('麻醉還沒開始', 'CONFLICT')
    if (s.anes.endAt) fail('麻醉已經結束了', 'CONFLICT')
    const t = now()
    const at = atOf(input.at, t)
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at)) failField('at', '請填時間')
    if (at > t) failField('at', '不能在未來')
    const last = [s.anes.startAt, ...s.anes.entries.map((x) => x.at)].sort().at(-1)!
    if (at < last) failField('at', `不能早於最後一筆紀錄（${last.slice(11)}）`)
    s.anes.endAt = at
    audit('麻醉結束', `${recText(s)}：${s.anes.startAt.slice(11)}–${at.slice(11)}（${anesTotalsText(s.anes)}）`)
    return surgeryView(s)
  })
}
const anesTotalsText = (r: AnesRecord) => ((x) => `輸液 ${x.fluid} mL、血品 ${x.blood} mL、失血 ${x.bloodLoss} mL、尿量 ${x.urine} mL`)(anesTotals(r))

/** 加一筆紀錄（生命徵象、用藥、輸液、輸出、事件）：麻醉開始之後；時間可補記（不早於開始、不晚於結束或現在） */
export function addAnesEntry(surgeryId: string, input: AnesEntryInput): Promise<AnesChart> {
  return mutate(() => {
    requireUser('doctor')
    const u = requirePermission('anesthesia')
    const s = must(surgeryOf(surgeryId), '手術')
    editable(s)
    if (!s.anes?.startAt) fail('請先按「麻醉開始」', 'CONFLICT')
    const t = now()
    const x = { ...input, at: atOf(input.at, t) }
    failFields(checkAnesEntry(x, { startAt: s.anes.startAt, endAt: s.anes.endAt, now: t.slice(0, 16) }))
    const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v))
    const base = { id: `AE${s.anes.entries.length + 1}-${Math.random().toString(36).slice(2, 6)}`, type: x.type as AnesEntryType, at: x.at, by: u.id }
    const e: AnesEntry =
      x.type === 'vital' ? { ...base, ...Object.fromEntries((['sbp', 'dbp', 'hr', 'spo2', 'etco2'] as const).map((k) => [k, num(x[k])]).filter(([, v]) => v !== undefined)) }
      : x.type === 'drug' ? { ...base, drug: x.drug as AnesDrugKey, dose: Number(x.dose) }
      : x.type === 'fluid' ? { ...base, fluid: x.fluid as AnesFluidKind, ml: Number(x.ml) }
      : x.type === 'output' ? { ...base, output: x.output as AnesOutputKind, ml: Number(x.ml) }
      : { ...base, event: x.event as AnesEventKind, ...(x.note?.trim() ? { note: x.note.trim() } : {}) }
    s.anes.entries.push(e)
    // 生命徵象很頻繁，不逐筆寫稽核；用藥、輸血、事件寫
    if (e.type !== 'vital') audit('麻醉紀錄', `${recText(s)}：${e.at.slice(11)} ${anesEntryText(e)}`)
    return chartOf(s, u)
  })
}

/** 刪一筆記錯的紀錄（手術完成前；寫稽核） */
export function removeAnesEntry(surgeryId: string, entryId: string): Promise<AnesChart> {
  return mutate(() => {
    requireUser('doctor')
    const u = requirePermission('anesthesia')
    const s = must(surgeryOf(surgeryId), '手術')
    editable(s)
    const e = must(s.anes?.entries.find((x) => x.id === entryId), '紀錄')
    s.anes!.entries = s.anes!.entries.filter((x) => x !== e)
    audit('刪除麻醉紀錄', `${recText(s)}：${e.at.slice(11)} ${anesEntryText(e)}`)
    return chartOf(s, u)
  })
}

export interface AnesChart {
  surgeryId: string
  /** 局部麻醉不用麻醉紀錄 */
  required: boolean
  startAt?: string
  endAt?: string
  entries: (AnesEntry & { text: string; byName: string })[]
  /** 生命徵象空窗（超過 15 分鐘沒記；open＝到現在還沒記） */
  gaps: { from: string; to: string; minutes: number; open: boolean }[]
  /** 術中低血壓、低血氧（自動列出） */
  alerts: { at: string; kind: 'hypotension' | 'hypoxemia'; text: string }[]
  totals: { fluid: number; blood: number; bloodLoss: number; urine: number }
  canEdit: boolean
}
function chartOf(s: Surgery, u: Actor): AnesChart {
  const r = s.anes ?? { entries: [] }
  return {
    surgeryId: s.id, required: s.anesthesia !== 'local', ...(r.startAt ? { startAt: r.startAt } : {}), ...(r.endAt ? { endAt: r.endAt } : {}),
    entries: [...r.entries].sort((a, b) => a.at.localeCompare(b.at)).map((x) => ({ ...x, text: anesEntryText(x), byName: nameOf.user(x.by) })),
    gaps: vitalGaps(r, now().slice(0, 16)), alerts: intraopAlerts(r), totals: anesTotals(r),
    canEdit: u.role === 'doctor' && permissionsOf(u).includes('anesthesia') && (s.status === 'sent' || s.status === 'in-progress'),
  }
}

/** 麻醉紀錄（手術室看；交班、恢復室也用） */
export function anesChart(surgeryId: string): Promise<AnesChart> {
  return query(() => {
    const u = requireUser("nurse", "doctor", "admin")
    return chartOf(must(surgeryOf(surgeryId), "手術"), u)
  })
}
