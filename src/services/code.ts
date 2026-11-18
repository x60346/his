// 急救（Code Blue）：
//   - 啟動：任何護理師、醫師（病人住院中、這位病人沒有進行中的急救）；全院畫面上方紅色橫幅一直顯示到結束
//   - 帶領：醫師按「帶領」（醫師啟動的就是他）；急救藥、電擊、插管是口頭醫囑，要有帶領醫師才記得下去
//   - 時間軸：開始 CPR、心律、電擊（焦耳）、腎上腺素（3–5 分鐘一次，超過 5 分鐘提示）、Amiodarone（300 → 150）、插管、甦醒球、備註
//   - DNR 硬擋：不按壓 → 不能開始 CPR（只能記「依 DNR 不施行急救」）、不電擊、不給急救藥物、不插管、不施行人工呼吸
//   - 藥自動開臨時醫囑（已執行，記在帶領醫師名下）並扣病房常備（不足由住院藥局直送）；有 CPR 的急救結束時帶入 CPR 處置費
//   - 結束：恢復自主循環（ROSC）、宣告死亡（醫師）、依 DNR 不施行；ROSC 後醫師一鍵申請轉加護病房（類別「其他」，原因帶急救摘要）
// 規則在 code-rules
import type { CodeBlue, CodeEvent, CodeEventKind, DnrItem, IcuRequest, IpdOrder } from '@/types'
import { db, newId } from '@/mock/db'
import { addMinutes, now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, query, requireUser, sessionRole } from './http'
import { find, nameOf } from './views'
import { activeDnr } from './flag-work'
import { dnrText } from './flag-rules'
import { inIcu } from './icu-work'
import { openRequest } from './icu-move-work'
import { wardStockOut } from './stock-ledger'
import { minutesBetween } from './news-work'
import { checkCodeEnd, checkCodeEvent, CODE_NEEDS_LEADER, CODE_OUTCOME_LABEL, codeEventText, codeStats, dnrBlockText, epiState, lastRhythm, nextAmioDose, type CodeOutcome } from './code-rules'

const admittedOf = (id: string) => {
  const a = must(find.admission(id), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}
const activeCodeOf = (admissionId: string) => db.codeBlues.find((c) => c.admissionId === admissionId && c.status === 'active')
const mustActive = (id: string) => {
  const c = must(db.codeBlues.find((x) => x.id === id), '急救紀錄')
  if (c.status !== 'active') fail('這次急救已經結束了', 'CONFLICT')
  return c
}

export interface CodeView extends CodeBlue {
  patientName: string
  bedNo: string
  ward: string
  startedByName: string
  leaderName?: string
  endedByName?: string
  /** 進行了幾分鐘（進行中）、總共幾分鐘（結束） */
  minutes: number
  events: (CodeEvent & { byName: string; text: string; minute: number })[]
  epi?: ReturnType<typeof epiState>
  rhythm?: CodeEvent['rhythm']
  nextAmioMg?: number
  icuRequestStatus?: IcuRequest['status']
}
function view(c: CodeBlue, t: string): CodeView {
  const a = find.admission(c.admissionId)
  const bed = find.bed(a?.bedId ?? '')
  const req = c.icuRequestId ? db.icuRequests.find((r) => r.id === c.icuRequestId) : undefined
  return {
    ...c,
    patientName: nameOf.patient(a?.patientId), bedNo: bed?.bedNo ?? '', ward: bed?.ward ?? '',
    startedByName: nameOf.user(c.startedBy),
    ...(c.leaderId ? { leaderName: nameOf.user(c.leaderId) } : {}),
    ...(c.endedBy ? { endedByName: nameOf.user(c.endedBy) } : {}),
    minutes: minutesBetween(c.startedAt, c.endedAt ?? t),
    events: c.events.map((e) => ({ ...e, byName: nameOf.user(e.by), text: codeEventText(e), minute: minutesBetween(c.startedAt, e.at) })),
    ...(c.status === 'active' ? { epi: epiState(c, t), nextAmioMg: nextAmioDose(c) } : {}),
    ...(lastRhythm(c) ? { rhythm: lastRhythm(c) } : {}),
    ...(req ? { icuRequestStatus: req.status } : {}),
  }
}

/** 全院進行中的急救（畫面上方紅色橫幅） */
export function activeCodes(): Promise<CodeView[]> {
  return query(() => {
    requireUser()
    const t = now()
    return db.codeBlues.filter((c) => c.status === 'active').sort((x, y) => x.startedAt.localeCompare(y.startedAt)).map((c) => view(c, t))
  })
}

export interface PatientCode {
  admissionId: string
  active?: CodeView
  history: CodeView[]
  /** 病人的 DNR（不施行哪些） */
  dnr?: { items: DnrItem[]; label: string }
  withhold: DnrItem[]
  canStart: boolean
  /** 醫師：可以帶領；ROSC 後可以申請轉加護病房的那一次 */
  canLead: boolean
  icuAfter?: string
}
/** 病人的急救（進行中、以前的）、DNR、能做什麼 */
export function patientCode(admissionId: string): Promise<PatientCode> {
  return query(() => {
    requireUser()
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const dnr = activeDnr(a.patientId)
    const act = activeCodeOf(a.id)
    const role = sessionRole()
    const clinical = role === 'nurse' || role === 'doctor'
    const lastRosc = db.codeBlues.filter((c) => c.admissionId === a.id && c.outcome === 'rosc').sort((x, y) => (x.endedAt ?? '').localeCompare(y.endedAt ?? '')).pop()
    const canIcu = role === 'doctor' && !!lastRosc && !lastRosc.icuRequestId && a.status === 'admitted' && !inIcu(a) && !openRequest(a.id)
    return {
      admissionId: a.id,
      ...(act ? { active: view(act, t) } : {}),
      history: db.codeBlues.filter((c) => c.admissionId === a.id && c.status === 'ended').sort((x, y) => y.startedAt.localeCompare(x.startedAt)).map((c) => view(c, t)),
      ...(dnr ? { dnr: { items: dnr.withhold, label: dnrText(dnr.withhold).label } } : {}),
      withhold: dnr?.withhold ?? [],
      canStart: clinical && a.status === 'admitted' && !act,
      canLead: role === 'doctor',
      ...(canIcu ? { icuAfter: lastRosc!.id } : {}),
    }
  })
}

export function startCode(admissionId: string): Promise<CodeView> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const a = admittedOf(admissionId)
    if (activeCodeOf(a.id)) fail('這位病人的急救已經在進行中', 'CONFLICT')
    const t = now()
    const c: CodeBlue = { id: newId('CB'), admissionId: a.id, startedAt: t, startedBy: u.id, events: [], status: 'active', ...(u.role === 'doctor' ? { leaderId: u.id } : {}) }
    db.codeBlues.push(c)
    audit('啟動急救', `${a.admitNo} ${nameOf.patient(a.patientId)}（${find.bed(a.bedId ?? '')?.bedNo ?? ''}）`)
    return view(c, t)
  })
}

/** 醫師帶領（接手）：之後的口頭醫囑記在他名下 */
export function leadCode(id: string): Promise<CodeView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const c = mustActive(id)
    c.leaderId = u.id
    audit('帶領急救', nameOf.patient(find.admission(c.admissionId)?.patientId))
    return view(c, now())
  })
}

/** 自動開的臨時醫囑（已執行）：護理師不用再核對；醫囑的 doctorId 是醫師代碼（不是帳號） */
function codeOrder(c: CodeBlue, admissionId: string, by: string, t: string, x: Pick<IpdOrder, 'category' | 'content'> & Partial<IpdOrder>): IpdOrder {
  const o: IpdOrder = { id: newId('IO'), admissionId, type: 'stat', startAt: t, stopAt: t, status: 'done', doctorId: find.user(c.leaderId!)?.doctorId ?? '', createdAt: t, ackAt: t, ackBy: by, codeBlueId: c.id, ...x }
  db.ipdOrders.push(o)
  return o
}

export function addCodeEvent(id: string, input: { kind: CodeEventKind; rhythm?: CodeEvent['rhythm']; joules?: number; note?: string }): Promise<CodeView> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const c = mustActive(id)
    const a = admittedOf(c.admissionId)
    const block = dnrBlockText(input.kind, activeDnr(a.patientId)?.withhold)
    if (block) fail(block, 'CONFLICT')
    if (CODE_NEEDS_LEADER.includes(input.kind) && !c.leaderId) fail('急救藥、電擊、插管是口頭醫囑：要先有醫師「帶領」', 'CONFLICT')
    failFields(checkCodeEvent(c, input))
    const t = now()
    const e: CodeEvent = { id: newId('CE'), at: t, kind: input.kind, by: u.id }
    if (input.kind === 'rhythm') e.rhythm = input.rhythm
    if (input.kind === 'shock') e.joules = input.joules
    if (input.kind === 'note') e.note = input.note!.trim()
    if (input.kind === 'epi' || input.kind === 'amio') {
      const drug = must(find.drug(input.kind === 'epi' ? 'M046' : 'M047'), '急救藥')
      const mg = input.kind === 'epi' ? 1 : nextAmioDose(c)
      const amps = input.kind === 'epi' ? 1 : mg / 150
      const o = codeOrder(c, a.id, u.id, t, { category: 'medication', drugId: drug.id, content: `${drug.name} ${mg} mg IV（急救）`, dose: amps, freq: 'STAT', route: 'IV' })
      wardStockOut(o, a.admitNo, u.id)
      Object.assign(e, { doseMg: mg, orderId: o.id })
    }
    c.events.push(e)
    return view(c, t)
  })
}

export function endCode(id: string, input: { outcome: CodeOutcome }): Promise<CodeView> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const c = mustActive(id)
    const a = admittedOf(c.admissionId)
    const p = checkCodeEnd(c, input.outcome, activeDnr(a.patientId)?.withhold)
    if (p) fail(p, 'CONFLICT')
    if (input.outcome === 'death' && u.role !== 'doctor') fail('宣告死亡要由醫師', 'FORBIDDEN')
    if (input.outcome !== 'dnr' && !c.leaderId) fail('要先有醫師「帶領」才能結束急救', 'CONFLICT')
    const t = now()
    Object.assign(c, { status: 'ended', endedAt: t, endedBy: u.id, outcome: input.outcome })
    // 有做 CPR：帶入一次心肺復甦術處置費（記在帶領醫師名下）
    if (c.events.some((e) => e.kind === 'cpr')) codeOrder(c, a.id, u.id, t, { category: 'procedure', procId: 'P054', content: '心肺復甦術 CPR（急救）' })
    audit('結束急救', `${nameOf.patient(a.patientId)}：${CODE_OUTCOME_LABEL[input.outcome]}（${minutesBetween(c.startedAt, t)} 分鐘）`)
    return view(c, t)
  })
}

/** ROSC 後一鍵申請轉加護病房：類別「其他」，原因帶急救摘要（醫師可以補充） */
export function requestIcuAfterCode(id: string, input: { note?: string } = {}): Promise<CodeView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const c = must(db.codeBlues.find((x) => x.id === id), '急救紀錄')
    if (c.outcome !== 'rosc') fail('恢復自主循環（ROSC）的急救才能申請', 'CONFLICT')
    if (c.icuRequestId) fail('這次急救已經申請過了', 'CONFLICT')
    const a = admittedOf(c.admissionId)
    if (inIcu(a)) fail('病人已經在加護病房', 'CONFLICT')
    if (openRequest(a.id)) fail('已經有一筆轉入申請（待同意或候床中）', 'CONFLICT')
    const t = now()
    const shocks = c.events.filter((e) => e.kind === 'shock').length
    const epis = c.events.filter((e) => e.kind === 'epi').length
    const first = c.events.find((e) => e.kind === 'rhythm')?.rhythm
    const summary = `急救後（ROSC）：${c.startedAt.slice(11)} 心跳停止${first ? `（${first.toUpperCase()}）` : ''}，CPR ${minutesBetween(c.startedAt, c.endedAt!)} 分鐘${shocks ? `、電擊 ${shocks} 次` : ''}${epis ? `、腎上腺素 ${epis} 劑` : ''}恢復自主循環`
    const r: IcuRequest = { id: newId('ICR'), admissionId: a.id, category: 'other', reason: input.note?.trim() ? `${summary}；${input.note.trim()}` : summary, requestedBy: u.id, requestedAt: t, status: 'pending', codeBlueId: c.id }
    db.icuRequests.push(r)
    c.icuRequestId = r.id
    audit('申請轉入加護病房', `${a.admitNo} ${nameOf.patient(a.patientId)}：${r.reason}`)
    return view(c, t)
  })
}

/** 品質指標：最近 days 天 */
export function codeQuality(days = 30): Promise<ReturnType<typeof codeStats> & { days: number }> {
  return query(() => {
    requireUser()
    const from = addMinutes(now(), -days * 24 * 60)
    return { days, ...codeStats(db.codeBlues.filter((c) => c.startedAt >= from)) }
  })
}
