// 麻醉：麻醉前評估（有「麻醉」權限的醫師）。沒有評估不能做麻醉前查核（surgery.recordCheck 擋）。
// 規則在 anesthesia-rules（純函式）；手術的畫面資料在 surgery-work
import type { AnesDrugKey, AnesEntry, AnesEntryType, AnesEventKind, AnesFluidKind, AnesHistoryKey, AnesOutputKind, AnesRecord, AnesthesiaType, AsaClass, NpoStatus, PacuScore, PreAnesthesia, Surgery } from '@/types'
import { now, parseDate } from '@/utils/date'
import { db } from '@/mock/db'
import { audit, fail, failField, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser, type Actor } from './http'
import { aldreteOf, checkPacuScore, PACU_LONG_MINUTES, PACU_SCORE_EVERY, pacuStage, pacuUnmet, anesEntryText, anesTotals, asaText, checkAnesEntry, checkPreAnes, difficultAirway, intraopAlerts, vitalGaps, type AnesEntryInput, type PreAnesInput } from './anesthesia-rules'
import { ANESTHESIA_LABEL, SIDE_LABEL, teamNow } from './surgery-rules'
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
/** 麻醉紀錄只有這台的麻醉醫師（手術團隊現在的那位，含交班接手的）能寫；局部麻醉沒指定的話，有權限的都可以 */
const isAnesthetist = (s: Surgery, u: Actor) => ((id) => (id ? id === u.id : s.anesthesia === 'local'))(teamNow(s, 'anesthetist'))
function requireAnesthetist(s: Surgery, u: Actor) {
  if (isAnesthetist(s, u)) return
  const id = teamNow(s, 'anesthetist')
  fail(id ? `這台的麻醉醫師是 ${nameOf.user(id)}，麻醉紀錄由這位醫師寫（換人請手術室護理師在「手術團隊」記交班）` : '這台還沒指定麻醉醫師（在「手術團隊」指定）', 'FORBIDDEN')
}
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
    requireAnesthetist(s, u)
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
    const u = requirePermission('anesthesia')
    const s = must(surgeryOf(surgeryId), '手術')
    editable(s)
    requireAnesthetist(s, u)
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
    requireAnesthetist(s, u)
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
    requireAnesthetist(s, u)
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
  /** 這台現在的麻醉醫師 */
  anesthetistName?: string
}
function chartOf(s: Surgery, u: Actor): AnesChart {
  const r = s.anes ?? { entries: [] }
  return {
    surgeryId: s.id, required: s.anesthesia !== 'local', ...(r.startAt ? { startAt: r.startAt } : {}), ...(r.endAt ? { endAt: r.endAt } : {}),
    entries: [...r.entries].sort((a, b) => a.at.localeCompare(b.at)).map((x) => ({ ...x, text: anesEntryText(x), byName: nameOf.user(x.by) })),
    gaps: vitalGaps(r, now().slice(0, 16)), alerts: intraopAlerts(r), totals: anesTotals(r),
    canEdit: u.role === 'doctor' && permissionsOf(u).includes('anesthesia') && isAnesthetist(s, u) && (s.status === 'sent' || s.status === 'in-progress'),
    ...((id) => (id ? { anesthetistName: nameOf.user(id) } : {}))(teamNow(s, 'anesthetist')),
  }
}

/** 麻醉紀錄（手術室看；交班、恢復室也用） */
export function anesChart(surgeryId: string): Promise<AnesChart> {
  return query(() => {
    const u = requireUser("nurse", "doctor", "admin")
    return chartOf(must(surgeryOf(surgeryId), "手術"), u)
  })
}

// ---------- 恢復室（PACU） ----------
export interface PacuItem {
  surgeryId: string
  no: string
  patientName: string
  bedNo: string
  ward: string
  procName: string
  stage: 'in' | 'out' | 'back'
  inAt: string
  /** 在恢復室幾分鐘（轉出了算到轉出） */
  minutes: number
  long: boolean
  latest?: PacuScore & { aldrete: number; byName: string }
  scores: (PacuScore & { aldrete: number; byName: string })[]
  /** 轉出條件沒達到的（空＝可以轉出） */
  unmet: string[]
  /** 該評分了（還沒評、或上次評分超過 15 分鐘） */
  scoreDue: boolean
  outText?: string
  receivedText?: string
  /** 交班：麻醉方式、ASA、困難插管、術中異常、輸入輸出、PCA */
  handover: string[]
  canScore: boolean
  canDischarge: boolean
  canOverride: boolean
  canReceive: boolean
}
function pacuItem(s: Surgery, u: Actor, t: string): PacuItem {
  const p = s.pacu!
  const a = find.admission(s.admissionId)
  const bed = find.bed(a?.bedId ?? '')
  const stage = pacuStage(p)!
  const scores = [...p.scores].sort((x, y) => x.at.localeCompare(y.at)).map((x) => ({ ...x, aldrete: aldreteOf(x), byName: nameOf.user(x.by) }))
  const latest = scores.at(-1)
  const minutes = Math.round((parseDate(p.out?.at ?? t).getTime() - parseDate(p.inAt).getTime()) / 60000)
  const r = s.anes
  const tot = r ? anesTotals(r) : undefined
  const pca = db.pcas.find((o) => o.admissionId === s.admissionId && (o.status === 'running' || o.status === 'ordered'))
  const nurse = u.role === 'nurse'
  const anes = u.role === 'doctor' && permissionsOf(u).includes('anesthesia')
  return {
    surgeryId: s.id, no: s.no, patientName: nameOf.patient(s.patientId), bedNo: bed?.bedNo ?? '', ward: bed?.ward ?? '', procName: find.procedure(s.procId)?.name ?? '',
    stage, inAt: p.inAt, minutes, long: stage === 'in' && minutes > PACU_LONG_MINUTES,
    ...(latest ? { latest } : {}), scores, unmet: pacuUnmet(latest),
    scoreDue: stage === 'in' && (!latest ? minutes >= PACU_SCORE_EVERY : Math.round((parseDate(t).getTime() - parseDate(latest.at).getTime()) / 60000) > PACU_SCORE_EVERY),
    ...(p.out ? { outText: `${p.out.at.slice(5)} 轉出（Aldrete ${p.out.aldrete}、疼痛 ${p.out.pain}${p.out.ponv ? '、噁心嘔吐' : ''}）・${nameOf.user(p.out.by)}${p.out.override ? `・放行原因：${p.out.override}` : ''}` } : {}),
    ...(p.received ? { receivedText: `${p.received.at.slice(5)} 病房接回・${nameOf.user(p.received.by)}` } : {}),
    handover: [
      `${ANESTHESIA_LABEL[s.anesthesia]}${s.preAnes ? `・${asaText(s.preAnes)}${s.preAnes.difficult ? '・困難插管' : ''}` : ''}`,
      ...(r ? intraopAlerts(r).map((x) => `術中${x.text}`) : []),
      ...(tot ? [`輸液 ${tot.fluid} mL・血品 ${tot.blood} mL・失血 ${tot.bloodLoss} mL・尿量 ${tot.urine} mL`] : []),
      ...(pca ? ['使用 PCA（病人自控止痛）'] : []),
    ],
    canScore: nurse && stage === 'in',
    canDischarge: (nurse || anes) && stage === 'in',
    canOverride: anes && stage === 'in',
    canReceive: nurse && stage === 'out',
  }
}

/** 恢復室看板：在恢復室的、已轉出待接回的（今天轉出的已接回也列，方便查） */
export function pacuBoard(): Promise<PacuItem[]> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'admin')
    const t = now()
    const d = t.slice(0, 10)
    return db.surgeries.filter((s) => s.pacu && (!s.pacu.received || s.pacu.received.at.slice(0, 10) === d))
      .map((s) => pacuItem(s, u, t)).sort((a, b) => ({ in: 0, out: 1, back: 2 })[a.stage] - ({ in: 0, out: 1, back: 2 })[b.stage] || a.inAt.localeCompare(b.inAt))
  })
}

/** 一台手術的恢復室（手術室、病人「手術」分頁看） */
export function pacuOf(surgeryId: string): Promise<PacuItem | null> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'admin')
    const s = must(surgeryOf(surgeryId), '手術')
    return s.pacu ? pacuItem(s, u, now()) : null
  })
}

/** 恢復室評分（護理師）：Aldrete 五項＋疼痛＋噁心嘔吐 */
export function recordPacuScore(surgeryId: string, input: { activity?: number; respiration?: number; circulation?: number; consciousness?: number; spo2?: number; pain?: number; ponv?: boolean }): Promise<PacuItem> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(surgeryOf(surgeryId), '手術')
    if (pacuStage(s.pacu) !== 'in') fail(s.pacu ? '病人已經轉出恢復室' : '這台手術沒有進恢復室', 'CONFLICT')
    failFields(checkPacuScore(input))
    const t = now().slice(0, 16)
    const sc: PacuScore = {
      id: `PS${s.pacu!.scores.length + 1}-${Math.random().toString(36).slice(2, 6)}`, at: t,
      activity: Number(input.activity) as 0 | 1 | 2, respiration: Number(input.respiration) as 0 | 1 | 2, circulation: Number(input.circulation) as 0 | 1 | 2,
      consciousness: Number(input.consciousness) as 0 | 1 | 2, spo2: Number(input.spo2) as 0 | 1 | 2, pain: Number(input.pain), ponv: !!input.ponv, by: u.id,
    }
    s.pacu!.scores.push(sc)
    return pacuItem(s, u, now())
  })
}

/**
 * 轉出恢復室：最後一次評分要在 15 分鐘內；Aldrete ≥ 9、疼痛 ≤ 4、沒有噁心嘔吐 → 護理師或麻醉醫師可以轉；
 * 不符合 → 只有麻醉醫師寫原因放行
 */
export function dischargePacu(surgeryId: string, input: { override?: string } = {}): Promise<PacuItem> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const s = must(surgeryOf(surgeryId), '手術')
    if (pacuStage(s.pacu) !== 'in') fail(s.pacu ? '病人已經轉出恢復室' : '這台手術沒有進恢復室', 'CONFLICT')
    const anes = u.role === 'doctor' && permissionsOf(u).includes('anesthesia')
    if (u.role === 'doctor' && !anes) requirePermission('anesthesia')
    const t = now()
    const latest = [...s.pacu!.scores].sort((a, b) => a.at.localeCompare(b.at)).at(-1)
    if (!latest) fail('還沒評分，不能轉出', 'CONFLICT')
    const ago = Math.round((parseDate(t).getTime() - parseDate(latest.at).getTime()) / 60000)
    if (ago > PACU_SCORE_EVERY) fail(`最後一次評分是 ${ago} 分鐘前，請重新評分再轉出`, 'CONFLICT')
    const unmet = pacuUnmet(latest)
    if (unmet.length && !anes) fail(`轉出條件未達：${unmet.join('、')}。要由麻醉醫師寫原因放行`, 'CONFLICT')
    if (unmet.length && !input.override?.trim()) failField('override', `轉出條件未達（${unmet.join('、')}），請寫放行原因`)
    s.pacu!.out = { at: t.slice(0, 16), by: u.id, aldrete: aldreteOf(latest), pain: latest.pain, ponv: latest.ponv, ...(unmet.length ? { override: input.override!.trim() } : {}) }
    audit('轉出恢復室', `${s.no} ${nameOf.patient(s.patientId)}：Aldrete ${aldreteOf(latest)}、疼痛 ${latest.pain}${latest.ponv ? '、噁心嘔吐' : ''}${unmet.length ? `；條件未達放行：${input.override!.trim()}` : ''}`)
    return pacuItem(s, u, t)
  })
}

/** 病房接回（護理師） */
export function receivePacu(surgeryId: string): Promise<PacuItem> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(surgeryOf(surgeryId), '手術')
    if (pacuStage(s.pacu) !== 'out') fail(s.pacu?.received ? '已經接回了' : '還沒轉出恢復室', 'CONFLICT')
    const t = now()
    s.pacu!.received = { at: t.slice(0, 16), by: u.id }
    audit('病房接回術後病人', `${s.no} ${nameOf.patient(s.patientId)}（恢復室 ${s.pacu!.inAt.slice(11)}–${s.pacu!.out!.at.slice(11)}）`)
    return pacuItem(s, u, t)
  })
}
