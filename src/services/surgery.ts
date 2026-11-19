// 手術排程與術前核對：主治申請 → 手術室排程（權限「手術排程」，同房不能撞）→ 病房術前準備（同意書、禁食、部位標記、備血、預防性抗生素）
// → 送手術室（準備沒完成擋）→ 麻醉前查核 → 劃刀前暫停確認 → 開始（沒暫停確認擋）→ 離開前查核＋紗布器械計數 → 完成（不符要原因、主刀看得到）
// → 主刀寫手術紀錄。做完的手術與麻醉費列入住院帳單（surgery-work.surgeryFeeItems）。規則在 surgery-rules
import type { AnesthesiaType, Surgery, SurgeryCheckStage, SurgeryPrepKey, SurgerySide, SurgeryUrgency, TeamRole, User } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { addDays, addMinutes, now, today } from '@/utils/date'
import { audit, fail, failField, failFields, fieldErrors, must, mutate, permissionsOf, query, requirePermission, requireUser } from './http'
import { ANESTHESIA_LABEL, CHECK_ITEMS, checkSurgeryInput, countsProblem, emergencyRate, OR_DAY, OR_ROOMS, overlaps, PREP_ITEMS, prepMissing, SIDE_LABEL, TEAM_LABEL, TEAM_ORDER, teamMissing, teamNow, URGENCY_LABEL, URGENCY_MINUTES, URGENCY_ORDER } from './surgery-rules'
import { dietOf } from './nutrition-rules'
import { bumpedByEmergency, surgeryOf, surgeryView, teamClash, type SurgeryView } from './surgery-work'
import { cancelStats, firstCaseStats, lateFirstCases, turnoverStats, utilization } from './or-metrics-rules'
import { careRoleOf, requireCare } from './care-team'
import { isAntibiotic } from './abx-work'
import { preIncisionOf } from './prophylaxis-work'
import { find, nameOf } from './views'
import { requestStatus } from './blood-rules'
import { specimenText } from './pathology-rules'

const audText = (s: Surgery) => `${s.no} ${nameOf.patient(s.patientId)} ${find.procedure(s.procId)?.name ?? ''}（${SIDE_LABEL[s.side]}）`

/** 可以申請的術式（主檔 Procedure.surgery、啟用中） */
export function surgeryOptions(): Promise<{ procs: { id: string; name: string; minutes: number }[]; rooms: string[] }> {
  return query(() => {
    requireUser()
    return { procs: db.procedures.filter((p) => p.surgery && p.active).map((p) => ({ id: p.id, name: p.name, minutes: p.surgery!.minutes })), rooms: OR_ROOMS }
  })
}

export interface PatientSurgeries {
  admissionId: string
  patientName: string
  /** 醫師：可以申請（本科醫師，會診醫師不行） */
  canRequest: boolean
  list: SurgeryView[]
  /** 術前準備可以連的：這次住院的備血單、抗生素醫囑 */
  bloodOptions: { id: string; text: string }[]
  abxOptions: { id: string; text: string }[]
  /** 術前禁食可以連到這次住院有效的禁食醫囑（選填） */
  npoOptions: { id: string; text: string }[]
}

export function patientSurgeries(admissionId: string): Promise<PatientSurgeries> {
  return query(() => {
    const u = requireUser('doctor', 'nurse', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    return {
      admissionId: a.id, patientName: nameOf.patient(a.patientId),
      canRequest: u.role === 'doctor' && a.status === 'admitted' && careRoleOf(u.doctorId, a)?.kind === 'team',
      list: db.surgeries.filter((s) => s.admissionId === a.id).sort((x, y) => y.createdAt.localeCompare(x.createdAt)).map(surgeryView),
      bloodOptions: db.bloodRequests.filter((r) => r.admissionId === a.id && !r.cancelled).map((r) => ({ id: r.id, text: `${r.no}（${requestStatus(r) === 'done' ? '已輸完' : '有效'}）` })),
      npoOptions: db.ipdOrders.filter((o) => o.admissionId === a.id && o.category === 'diet' && o.status === 'active' && dietOf(o).kind === 'npo').map((o) => ({ id: o.id, text: `${o.content}（${o.startAt.slice(5)} 起）` })),
      abxOptions: db.ipdOrders.filter((o) => o.admissionId === a.id && o.category === 'medication' && o.status !== 'stopped' && isAntibiotic(find.drug(o.drugId ?? ''))).map((o) => ({ id: o.id, text: `${o.content} ${o.dose ?? ''} ${o.freq ?? ''}`.trim() })),
    }
  })
}

// ---------- 醫師：申請、取消、手術紀錄 ----------

export interface SurgeryInput {
  admissionId: string
  procId: string
  side: SurgerySide
  anesthesia: AnesthesiaType
  requestedDate: string
  estMinutes: number
  diagnosis: string
  note?: string
  /** 急刀等級（沒有＝擇期）；急刀的預計日期一律是今天 */
  urgency?: SurgeryUrgency
}

export function requestSurgery(input: SurgeryInput): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = must(find.admission(input.admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('只有住院中的病人可以申請手術', 'CONFLICT')
    requireCare(u.doctorId, a, '申請手術', { consult: false })
    const t = now()
    const est = Number(input.estMinutes)
    if (input.urgency && !(input.urgency in URGENCY_LABEL)) failField('urgency', '急刀等級不對')
    if (input.urgency) input = { ...input, requestedDate: t.slice(0, 10) }
    const e = checkSurgeryInput({ ...input, estMinutes: est }, t.slice(0, 10))
    const proc = input.procId ? find.procedure(input.procId) : undefined
    if (input.procId && (!proc?.surgery || !proc.active)) e.procId = '這不是可以申請的術式'
    failFields(e)
    const d = t.slice(0, 10)
    const s: Surgery = {
      id: newId('SG'), no: `OR${d.replace(/-/g, '')}${String(nextCounter(`surgery:${d}`)).padStart(3, '0')}`,
      admissionId: a.id, patientId: a.patientId, doctorId: u.doctorId!, procId: proc!.id, side: input.side, anesthesia: input.anesthesia,
      diagnosis: input.diagnosis.trim(), requestedDate: input.requestedDate, estMinutes: est, ...(input.note?.trim() ? { note: input.note.trim() } : {}), ...(input.urgency ? { urgency: input.urgency } : {}),
      status: 'requested', createdAt: t, prep: {}, checks: {},
    }
    db.surgeries.push(s)
    audit(s.urgency ? '申請急刀' : '申請手術', `${audText(s)}，${ANESTHESIA_LABEL[s.anesthesia]}，${s.urgency ? `${URGENCY_LABEL[s.urgency]}（${URGENCY_MINUTES[s.urgency] / 60} 小時內入刀房）` : `預計 ${s.requestedDate}`}`)
    return surgeryView(s)
  })
}

/** 取消：進手術室前（待排程、已排程）；本科醫師、要原因 */
export function cancelSurgery(id: string, reason: string): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const s = must(surgeryOf(id), '手術')
    requireCare(u.doctorId, must(find.admission(s.admissionId), '住院紀錄'), '取消手術', { consult: false })
    if (s.status !== 'requested' && s.status !== 'scheduled') fail(`${s.status === 'cancelled' ? '已經取消了' : '病人已經送手術室，不能取消'}`, 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫取消原因')
    s.status = 'cancelled'
    s.cancelled = { by: u.id, at: now(), reason: reason.trim() }
    audit('取消手術', `${audText(s)}：${reason.trim()}`)
    return surgeryView(s)
  })
}

export interface OpRecordInput {
  performed: string
  findings: string
  bloodLoss: number
  complications: string
  specimen: string
}

/** 手術紀錄：做完之後，主刀或本科醫師寫（只寫一次） */
export function writeOpRecord(id: string, input: OpRecordInput): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const s = must(surgeryOf(id), '手術')
    if (s.doctorId !== u.doctorId) requireCare(u.doctorId, must(find.admission(s.admissionId), '住院紀錄'), '寫手術紀錄', { consult: false })
    if (s.status !== 'done') fail('手術完成後才能寫手術紀錄', 'CONFLICT')
    if (s.record) fail('手術紀錄已經寫過了', 'CONFLICT')
    const f = fieldErrors()
    if (!input.performed?.trim()) f.add('performed', '請寫實際執行的術式')
    if (!input.findings?.trim()) f.add('findings', '請寫術中發現')
    const bl = Number(input.bloodLoss)
    if (!Number.isInteger(bl) || bl < 0 || bl > 20000) f.add('bloodLoss', '失血量是 0–20000 ml 的整數')
    f.done()
    // 逐件登記的手術：檢體照登記的寫（不用另打）；以前的手術才用文字
    const specimen = s.specimens || s.noSpecimen ? (s.specimens?.length ? s.specimens.map(specimenText).join('；') : '無') : input.specimen?.trim() || '無'
    s.record = { performed: input.performed.trim(), findings: input.findings.trim(), bloodLoss: bl, complications: input.complications?.trim() || '無', specimen, by: u.id, at: now() }
    audit('手術紀錄', `${audText(s)}：失血 ${bl} ml、併發症 ${s.record.complications}`)
    return surgeryView(s)
  })
}

// ---------- 手術室排程 ----------

export interface OrBoard {
  date: string
  rooms: string[]
  /** 目前的人可以排程（權限「手術排程」） */
  canSchedule: boolean
  /** 目前的人可以做麻醉評估與紀錄（權限「麻醉」、醫師） */
  canAnesthesia: boolean
  /** 這天排在各房的（取消的不列） */
  cases: SurgeryView[]
  /** 待排程（不分日期；急刀在前，依等級、申請時間） */
  requested: SurgeryView[]
  /** 近 30 天急刀時效達成率；擇期被急刀佔用要改期的筆數 */
  emergencyStats: { total: number; ontime: number; pct: number }
  needsReschedule: number
  /** 這天的首台：排程開始過了 15 分鐘還沒做麻醉前查核（只有看今天才有） */
  lateFirst: { id: string; room: string; start: string; minutes: number; patientName: string; no: string }[]
}

export function orBoard(date: string): Promise<OrBoard> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'admin')
    const d = /^\d{4}-\d{2}-\d{2}$/.test(date ?? '') ? date : today()
    const liveAdm = (s: Surgery) => find.admission(s.admissionId)?.status === 'admitted' || s.status === 'done'
    return {
      date: d, rooms: OR_ROOMS, canSchedule: permissionsOf(u).includes('surgery.schedule'), canAnesthesia: u.role === 'doctor' && permissionsOf(u).includes('anesthesia'),
      cases: db.surgeries.filter((s) => s.schedule?.start.startsWith(d) && s.status !== 'cancelled' && liveAdm(s)).sort((x, y) => x.schedule!.start.localeCompare(y.schedule!.start)).map(surgeryView),
      requested: db.surgeries.filter((s) => s.status === 'requested' && find.admission(s.admissionId)?.status === 'admitted')
        .sort((x, y) => (x.urgency ? URGENCY_ORDER[x.urgency] : 9) - (y.urgency ? URGENCY_ORDER[y.urgency] : 9) || (x.urgency ? x.createdAt.localeCompare(y.createdAt) : x.requestedDate.localeCompare(y.requestedDate))).map(surgeryView),
      emergencyStats: emergencyRate(db.surgeries.filter((s) => s.createdAt >= `${addDays(today(), -30)} 00:00`), now()),
      needsReschedule: db.surgeries.filter((s) => bumpedByEmergency(s)).length,
      lateFirst: d === today() ? lateFirstCases(db.surgeries.filter(liveAdm), d, now()).map((x) => ((s) => ({ ...x, patientName: nameOf.patient(s.patientId), no: s.no }))(surgeryOf(x.id)!)) : [],
    }
  })
}

/** 排程（或改期）：還沒送手術室；同一間房時段不能重疊；在手術房開放時段內、不能排在過去 */
export function scheduleSurgery(id: string, input: { room: string; start: string }): Promise<SurgeryView> {
  return mutate(() => {
    const u = requirePermission('surgery.schedule')
    const s = must(surgeryOf(id), '手術')
    if (s.status !== 'requested' && s.status !== 'scheduled') fail('已經送手術室或取消，不能再排程', 'CONFLICT')
    const f = fieldErrors()
    if (!OR_ROOMS.includes(input.room)) f.add('room', '請選擇手術房')
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(input.start ?? '')) f.add('start', '請選擇日期與時間')
    f.done()
    const t = now()
    if (input.start < t) failField('start', '不能排在過去的時間')
    const hm = input.start.slice(11)
    const end = addMinutes(input.start, s.estMinutes)
    // 急刀可以排在開放時段外（夜間、假日）
    if (!s.urgency && (hm < OR_DAY.start || end.slice(11) > OR_DAY.end || end.slice(0, 10) !== input.start.slice(0, 10))) failField('start', `手術房開放 ${OR_DAY.start}–${OR_DAY.end}（預估 ${s.estMinutes} 分鐘，會超過）`)
    // 急刀只和急刀比（撞到的擇期列「需改期」，不自動移）；擇期和所有的比
    const clash = db.surgeries.find((x) => x.id !== s.id && x.schedule?.room === input.room && x.status !== 'cancelled' && x.status !== 'done' && (!s.urgency || x.urgency) && overlaps(x.schedule.start, x.estMinutes, input.start, s.estMinutes))
    if (clash) failField('start', `${input.room} 這段時間已排 ${clash.no} ${nameOf.patient(clash.patientId)}（${clash.schedule!.start.slice(11)} 起 ${clash.estMinutes} 分鐘）`, 'CONFLICT')
    const old = s.schedule
    s.schedule = { room: input.room, start: input.start, by: u.id, at: t }
    s.status = 'scheduled'
    audit(old ? '手術改期' : '手術排程', `${audText(s)}：${old ? `${old.room} ${old.start} → ` : ''}${input.room} ${input.start}`)
    return surgeryView(s)
  })
}

// ---------- 病房：術前準備、送手術室 ----------

/**
 * 勾術前準備：完成，或「不需要」（寫原因；同意書不能不需要）。
 * 備血要連這次住院的備血單、抗生素要連這次住院的抗生素醫囑（或寫不需要）
 */
export function markPrep(id: string, key: SurgeryPrepKey, input: { notNeeded?: string; refId?: string } = {}): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(surgeryOf(id), '手術')
    if (s.status !== 'requested' && s.status !== 'scheduled') fail('已經送手術室，術前準備不能再改', 'CONFLICT')
    const def = PREP_ITEMS.find((x) => x.key === key)
    if (!def) fail('沒有這個項目')
    const notNeeded = input.notNeeded?.trim()
    if (input.notNeeded !== undefined && !notNeeded) failField('notNeeded', '請寫不需要的原因')
    if (notNeeded && !def!.optional) fail(`${def!.label}一定要有`)
    if (!notNeeded && (key === 'blood' || key === 'abx')) {
      if (!input.refId) failField('refId', key === 'blood' ? '請選這次住院的備血單（不需要備血請寫原因）' : '請選這次住院的抗生素醫囑（不需要請寫原因）')
      if (key === 'blood' && !db.bloodRequests.some((r) => r.id === input.refId && r.admissionId === s.admissionId && !r.cancelled)) failField('refId', '備血單不是這次住院的（或已取消）')
      if (key === 'abx' && !db.ipdOrders.some((o) => o.id === input.refId && o.admissionId === s.admissionId && o.status !== 'stopped' && isAntibiotic(find.drug(o.drugId ?? '')))) failField('refId', '這不是這次住院有效的抗生素醫囑')
    }
    // 禁食可以連禁食醫囑（選填）：連了就要是這次住院有效的禁食醫囑
    if (!notNeeded && key === 'npo' && input.refId && !db.ipdOrders.some((o) => o.id === input.refId && o.admissionId === s.admissionId && o.category === 'diet' && o.status === 'active' && dietOf(o).kind === 'npo')) failField('refId', '這不是這次住院有效的禁食醫囑')
    s.prep[key] = { by: u.id, at: now(), ...(notNeeded ? { notNeeded } : {}), ...(!notNeeded && input.refId ? { refId: input.refId } : {}) }
    audit('術前準備', `${audText(s)}：${def!.label}${notNeeded ? `不需要（${notNeeded}）` : '完成'}`)
    return surgeryView(s)
  })
}

export function unmarkPrep(id: string, key: SurgeryPrepKey): Promise<SurgeryView> {
  return mutate(() => {
    requireUser('nurse')
    const s = must(surgeryOf(id), '手術')
    if (s.status !== 'requested' && s.status !== 'scheduled') fail('已經送手術室，術前準備不能再改', 'CONFLICT')
    delete s.prep[key]
    audit('術前準備取消勾選', `${audText(s)}：${PREP_ITEMS.find((x) => x.key === key)?.label ?? key}`)
    return surgeryView(s)
  })
}

/** 送手術室：已排程、術前準備全部完成（沒完成的列出來） */
export function sendToOr(id: string): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(surgeryOf(id), '手術')
    if (s.status !== 'scheduled') fail(s.status === 'requested' ? '手術室還沒排程' : '這台不是「已排程」，不能送', 'CONFLICT')
    const miss = prepMissing(s)
    if (miss.length) fail(`術前準備還沒完成：${miss.map((k) => PREP_ITEMS.find((x) => x.key === k)!.label).join('、')}`, 'CONFLICT')
    const t = now()
    Object.assign(s, { status: 'sent', sentAt: t, sentBy: u.id })
    audit('送手術室', audText(s))
    return surgeryView(s)
  })
}

// ---------- 手術室：三段查核、開始、完成 ----------

/** 麻醉前、劃刀前暫停確認：項目要全部勾（送來的要和規定的一樣） */
export function recordCheck(id: string, stage: Exclude<SurgeryCheckStage, 'signOut'>, items: string[]): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(surgeryOf(id), '手術')
    if (stage === 'signIn' && s.status !== 'sent') fail('病人送到手術室後才能做麻醉前查核', 'CONFLICT')
    if (stage === 'signIn' && !s.preAnes) fail('麻醉前評估還沒做：要由有「麻醉」權限的醫師評估後才能做麻醉前查核', 'CONFLICT')
    if (stage === 'timeOut' && (!s.checks.signIn || s.status !== 'sent')) fail(s.checks.signIn ? '已經開始手術了' : '請先完成麻醉前查核', 'CONFLICT')
    const lack = s.status === 'sent' ? teamMissing(s, stage) : []
    if (lack.length) fail(`手術團隊還沒到齊：${lack.map((r) => TEAM_LABEL[r]).join('、')}（在「手術團隊」指定）`, 'CONFLICT', 'team')
    if (s.checks[stage]) fail('這段已經查核過了', 'CONFLICT')
    const need = CHECK_ITEMS[stage].items
    const miss = need.filter((x) => !(items ?? []).includes(x))
    if (miss.length) failField('items', `還有 ${miss.length} 項沒確認：${miss.join('、')}`)
    s.checks[stage] = { by: u.id, at: now() }
    audit(stage === 'signIn' ? '麻醉前查核' : '劃刀前暫停確認', audText(s))
    return surgeryView(s)
  })
}

/**
 * 開始手術（劃刀）：劃刀前暫停確認沒做完擋。
 * 術前準備連了抗生素醫囑：劃刀前 60 分鐘內（Vancomycin 120）要有已給的紀錄（看給藥紀錄的實際時間）；
 * 不符不擋，但要寫原因（例：手術室已追加給藥、麻醉科另給）——記在手術上，指標算不符合
 */
export function startSurgery(id: string, input: { abxReason?: string } = {}): Promise<SurgeryView> {
  return mutate(() => {
    requireUser('nurse')
    const s = must(surgeryOf(id), '手術')
    if (s.status !== 'sent') fail('這台不是「已送手術室」', 'CONFLICT')
    if (!s.checks.timeOut) fail('劃刀前暫停確認（Time Out）還沒完成，不能開始手術', 'CONFLICT', 'timeOut')
    const t = now()
    const pre = preIncisionOf(s, t)
    const reason = input.abxReason?.trim()
    if (pre && !pre.ok && !reason) failField('abxReason', `預防性抗生素：${pre.text}。請寫原因（例：手術室已追加給藥）`)
    Object.assign(s, { status: 'in-progress', startAt: t, ...(pre ? { abxTiming: { ok: pre.ok, ...(pre.givenAt ? { givenAt: pre.givenAt, minutes: pre.minutes } : {}), ...(!pre.ok ? { reason } : {}) } } : {}) })
    audit('開始手術', `${audText(s)}${pre ? `；預防性抗生素：${pre.text}${!pre.ok ? `（${reason}）` : ''}` : ''}`)
    return surgeryView(s)
  })
}

/** 完成：離開前查核（項目全勾）＋紗布器械計數；不符要寫原因（主刀的待辦會看到） */
export function finishSurgery(id: string, input: { items: string[]; spongeBefore: number; spongeAfter: number; instrumentBefore: number; instrumentAfter: number; mismatchReason?: string; noSpecimen?: boolean }): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(surgeryOf(id), '手術')
    if (s.status !== 'in-progress') fail('手術還沒開始（或已經完成）', 'CONFLICT')
    // 麻醉紀錄（局部麻醉不用）：要有麻醉開始與結束
    if (s.anesthesia !== 'local' && (!s.anes?.startAt || !s.anes.endAt)) fail(`麻醉紀錄還沒有麻醉${s.anes?.startAt ? '結束' : '開始與結束'}時間（由麻醉醫師在麻醉紀錄記），不能完成手術`, 'CONFLICT')
    const miss = CHECK_ITEMS.signOut.items.filter((x) => !(input.items ?? []).includes(x))
    const c = { spongeBefore: Number(input.spongeBefore), spongeAfter: Number(input.spongeAfter), instrumentBefore: Number(input.instrumentBefore), instrumentAfter: Number(input.instrumentAfter) }
    const { fields, mismatch } = countsProblem(c)
    if (miss.length) fields.items = `還有 ${miss.length} 項沒確認：${miss.join('、')}`
    const reason = input.mismatchReason?.trim()
    // 檢體：有登記的手術完成時一起送病理；沒有要確認「本台無檢體」
    const specs = s.specimens ?? []
    if (!specs.length && !input.noSpecimen) fields.noSpecimen = '沒有登記檢體：請確認「本台無檢體」，有檢體請先逐件登記'
    if (specs.length && input.noSpecimen) fields.noSpecimen = `已登記 ${specs.length} 件檢體，不能勾「本台無檢體」`
    if (mismatch.length && !reason) fields.mismatchReason = `計數不符（${mismatch.join('；')}）：請寫原因與處理（例：已照 X 光確認無遺留），並告知主刀`
    failFields(fields)
    const t = now()
    s.checks.signOut = { by: u.id, at: t }
    s.counts = { ...c, ...(mismatch.length ? { mismatchReason: `${mismatch.join('；')}：${reason}` } : {}) }
    Object.assign(s, { status: 'done', endAt: t })
    if (specs.length) s.path = { sentAt: t.slice(0, 16), sentBy: u.id }
    else s.noSpecimen = true
    // 局部麻醉以外：離開手術室就進恢復室（轉出、病房接回在 anesthesia.ts）
    if (s.anesthesia !== 'local') s.pacu = { inAt: t.slice(0, 16), scores: [] }
    audit('手術完成', `${audText(s)}${mismatch.length ? `；計數不符：${mismatch.join('；')}，${reason}` : ''}${s.pacu ? '，進恢復室' : ''}${specs.length ? `，送病理 ${specs.length} 件` : '，本台無檢體'}`)
    return surgeryView(s)
  })
}

// ---------- 手術團隊 ----------

const clashText = (userId: string, x: Surgery, urgent: boolean) =>
  `${nameOf.user(userId)} 同時段在 ${x.schedule!.room} ${x.no} ${nameOf.patient(x.patientId)}（${x.schedule!.start.slice(5)} 起）${urgent ? '：急刀可以寫原因放行' : '，不能重複排'}`

/** 這個人能不能擔任這個角色（醫師：助手；有「麻醉」權限的醫師：麻醉醫師；護理師：刷手、流動） */
function fitsRole(u: User, role: TeamRole): boolean {
  if (!u.active) return false
  if (role === 'scrub' || role === 'circulating') return u.roles.includes('nurse')
  if (!u.roles.includes('doctor') || !u.doctorId) return false
  return role === 'assistant' || permissionsOf({ role: 'doctor', grants: u.grants ?? [] }).includes('anesthesia')
}
const surgeonUser = (s: Surgery) => db.users.find((u) => u.doctorId === s.doctorId)?.id

export interface TeamOptions {
  /** 每個角色可以選的人 */
  options: Record<TeamRole, { id: string; name: string }[]>
}
export function teamOptions(id: string): Promise<TeamOptions> {
  return query(() => {
    requireUser('nurse', 'doctor', 'admin')
    const s = must(surgeryOf(id), '手術')
    const me = surgeonUser(s)
    return { options: Object.fromEntries(TEAM_ORDER.map((r) => [r, db.users.filter((u) => fitsRole(u, r) && u.id !== me).map((u) => ({ id: u.id, name: u.name }))])) as TeamOptions['options'] }
  })
}

/** 檢查一個角色指定的人：要能擔任、不能是主刀、刷手和流動不能同一人 */
function checkMember(s: Surgery, role: TeamRole, userId: string, others: Partial<Record<TeamRole, string>>): string | undefined {
  const u = db.users.find((x) => x.id === userId)
  if (!u || !fitsRole(u, role)) return role === 'anesthetist' ? '要選有「麻醉」權限的醫師' : role === 'assistant' ? '助手要選醫師' : '要選護理師'
  if (userId === surgeonUser(s)) return '不能是主刀本人'
  const pair: TeamRole | undefined = role === 'scrub' ? 'circulating' : role === 'circulating' ? 'scrub' : undefined
  if (pair && others[pair] === userId) return '刷手和流動不能是同一個人'
  return undefined
}

/**
 * 指定團隊（排程後、麻醉前查核前；權限「手術排程」）：直接換人，不留交班。空字串＝拿掉。
 * 麻醉前查核之後要換人，走 handoverTeam（記交班時間）
 */
export function setTeam(id: string, input: Partial<Record<TeamRole, string>> & { clashReason?: string }): Promise<SurgeryView> {
  return mutate(() => {
    const u = requirePermission('surgery.schedule')
    const s = must(surgeryOf(id), '手術')
    if (s.status !== 'scheduled' && s.status !== 'sent') fail(s.status === 'requested' ? '排程後才能指定團隊' : '手術已經開始或結束，不能再改團隊', 'CONFLICT')
    if (s.checks.signIn) fail('已經做了麻醉前查核：換人請記「交班」', 'CONFLICT')
    const next: Partial<Record<TeamRole, string>> = Object.fromEntries(TEAM_ORDER.map((r) => [r, r in input ? (input[r] ?? '') : (teamNow(s, r) ?? '')]))
    const e: Record<string, string> = {}
    for (const r of TEAM_ORDER) {
      const why = next[r] ? checkMember(s, r, next[r]!, next) : undefined
      if (why) e[r] = why
    }
    failFields(e)
    const t = now()
    const changed = TEAM_ORDER.filter((r) => (next[r] || undefined) !== teamNow(s, r))
    if (!changed.length) fail('團隊沒有變動', 'CONFLICT')
    // 人員衝突（新指定的人）：同時段已在別台 → 擋；急刀（這台或那台）可以寫原因放行
    const clashes = Object.fromEntries(changed.filter((r) => next[r]).map((r) => [r, teamClash(s, next[r]!, t)]).filter(([, x]) => x)) as Partial<Record<TeamRole, Surgery>>
    const reason = input.clashReason?.trim()
    for (const [r, x] of Object.entries(clashes) as [TeamRole, Surgery][]) {
      const urgent = !!(s.urgency || x.urgency)
      if (!urgent || !reason) e[r] = clashText(next[r]!, x, urgent)
    }
    failFields(e)
    s.team = Object.fromEntries(TEAM_ORDER.filter((r) => next[r]).map((r) => [r, teamNow(s, r) === next[r] ? s.team![r]! : [{ userId: next[r]!, by: u.id, at: t, ...(clashes[r] ? { clash: { with: clashes[r]!.no, reason: reason! } } : {}) }]]))
    audit('手術團隊', `${audText(s)}：${changed.map((r) => `${TEAM_LABEL[r]} ${next[r] ? nameOf.user(next[r]!) : '（拿掉）'}${clashes[r] ? `（同時段在 ${clashes[r]!.no}，放行：${reason}）` : ''}`).join('、')}`)
    return surgeryView(s)
  })
}

/**
 * 交班（麻醉前查核之後到手術完成；護理師記）：這個角色換人，記交班時間（預設現在，可以補記，不早於前一段開始、不早於麻醉前查核）。
 * 助手中途加入也走這裡
 */
export function handoverTeam(id: string, role: TeamRole, input: { userId: string; at?: string; clashReason?: string }): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(surgeryOf(id), '手術')
    if (!(role in TEAM_LABEL)) fail('沒有這個角色')
    if (!s.checks.signIn || (s.status !== 'sent' && s.status !== 'in-progress')) fail(s.status === 'done' ? '手術已完成，團隊不能再改' : '麻醉前查核之前請直接指定團隊（不用交班）', 'CONFLICT')
    const cur = teamNow(s, role)
    if (!input.userId) failField('userId', '請選接手的人')
    if (input.userId === cur) failField('userId', '和現在的人一樣')
    const others = Object.fromEntries(TEAM_ORDER.map((r) => [r, teamNow(s, r)])) as Partial<Record<TeamRole, string>>
    const why = checkMember(s, role, input.userId, { ...others, [role]: undefined })
    if (why) failField('userId', why)
    const t = now()
    const at = input.at?.trim() ? input.at.trim() : t.slice(0, 16)
    if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(at)) failField('at', '請填時間')
    if (at > t.slice(0, 16)) failField('at', '不能在未來')
    const last = s.team?.[role]?.at(-1)
    const floor = [s.checks.signIn.at.slice(0, 16), last?.from ?? ''].sort().at(-1)!
    if (at < floor) failField('at', `不能早於 ${floor.slice(11)}（${last?.from === floor ? '前一段開始' : '麻醉前查核'}）`)
    const clash = teamClash(s, input.userId, t, at)
    const reason = input.clashReason?.trim()
    if (clash && (!(s.urgency || clash.urgency) || !reason)) failField('userId', clashText(input.userId, clash, !!(s.urgency || clash.urgency)))
    s.team = { ...(s.team ?? {}) }
    if (last && !last.to) last.to = at
    s.team[role] = [...(s.team[role] ?? []), { userId: input.userId, from: at, by: u.id, at: t, ...(clash ? { clash: { with: clash.no, reason: reason! } } : {}) }]
    audit('手術團隊交班', `${audText(s)}：${TEAM_LABEL[role]} ${cur ? `${nameOf.user(cur)} → ` : ''}${nameOf.user(input.userId)}（${at.slice(11)}）${clash ? `；同時段在 ${clash.no}，放行：${reason}` : ''}`)
    return surgeryView(s)
  })
}

// ---------- 手術室效率 ----------

export interface OrMetrics {
  from: string
  to: string
  firstCase: ReturnType<typeof firstCaseStats>
  turnover: ReturnType<typeof turnoverStats>
  utilization: ReturnType<typeof utilization>
  cancel: ReturnType<typeof cancelStats> & { reasons: { no: string; date: string; reason: string; patientName: string }[] }
}
/** 最近 N 天（含今天）的手術室效率：首台準時、換台、使用率、當天取消 */
export function orMetrics(days = 30): Promise<OrMetrics> {
  return query(() => {
    requireUser('nurse', 'doctor', 'admin')
    const n = Math.min(Math.max(Math.round(Number(days)) || 30, 1), 180)
    const to = today()
    const from = addDays(to, -(n - 1))
    const list = db.surgeries
    const c = cancelStats(list, from, to)
    return {
      from, to, firstCase: firstCaseStats(list, from, to, now()), turnover: turnoverStats(list, from, to), utilization: utilization(list, OR_ROOMS, from, to),
      cancel: { ...c, reasons: c.reasons.map((r) => ({ ...r, patientName: nameOf.patient(list.find((x) => x.no === r.no)?.patientId ?? '') })) },
    }
  })
}
