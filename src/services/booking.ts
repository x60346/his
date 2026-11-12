// 掛號：建立 Visit（狀態機的起點）、退掛、候診清單。
import type { ChargeLine, Encounter, Visit, VisitStatus } from '@/types'
import { db, nextCounter, newId } from '@/mock/db'
import { addDays, now, periodLabel, today } from '@/utils/date'
import { clonePlain } from '@/utils/clone'
import { audit, fail, failField, fieldErrors, must, mutate, query, requireUser } from './http'
import { ensureSessions, isSessionClosed, periodCloseTime } from './schedule'
import { billingLookup, find, nameOf, visitView, type VisitView } from './views'
import { checkEligibility } from './prevent-rules'
import { fixedCharges } from './billing'
import { checkInProblem } from './queue-rules'
import { refillState, supersededBy, supplyDays, type RefillFill, type RefillState } from './refill-rules'

export interface VisitQuery {
  date?: string
  sessionId?: string
  doctorId?: string
  deptId?: string
  patientId?: string
  status?: VisitStatus[]
  /** 只查今天以後（預約） */
  upcoming?: boolean
}

export function listVisits(q: VisitQuery = {}): Promise<VisitView[]> {
  return query(() => {
    const t = today()
    return db.visits
      .filter(
        (v) =>
          (!q.date || v.date === q.date) &&
          (!q.sessionId || v.sessionId === q.sessionId) &&
          (!q.doctorId || v.doctorId === q.doctorId) &&
          (!q.deptId || v.deptId === q.deptId) &&
          (!q.patientId || v.patientId === q.patientId) &&
          (!q.status || q.status.includes(v.status)) &&
          (!q.upcoming || v.date >= t),
      )
      .sort((a, b) => a.date.localeCompare(b.date) || a.sessionId.localeCompare(b.sessionId) || a.seqNo - b.seqNo)
      .map(visitView)
  })
}

export const getVisit = (id: string): Promise<VisitView> => query(() => visitView(must(find.visit(id), '掛號紀錄')))

export interface RegisterInput {
  patientId: string
  sessionId: string
  identityCode: string
  caseType: string
  preventItems?: string[]
  /** 病人已在櫃台（現場掛號）：掛號同時報到。只能用在今天的診次 */
  checkIn?: boolean
}

/**
 * 建立掛號（交易內呼叫）：診次可掛、不重複、預防保健資格——掛號與改期共用，改期不能繞過任何一條。
 */
function createVisit(input: RegisterInput): Visit {
  const patient = must(find.patient(input.patientId), '病患')
  const date = input.sessionId.slice(1, 9).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')
  ensureSessions(date)
  const session = must(find.session(input.sessionId), '診次')
  must(find.identity(input.identityCode), '就醫身分')

  // 08 慢箋調劑不看診：走「登記領藥」（registerRefill），不能掛進醫師的診
  if (input.caseType === '08') fail('慢性病連續處方調劑不需看診，請在病人的「慢箋」按「登記領藥」')
  if (session.date < today()) fail('不可掛過去日期的門診')
  if (isSessionClosed(session)) fail(`此診次已於 ${periodCloseTime[session.period]} 截止掛號`, 'CONFLICT')
  if (session.suspended) fail(`此診次停診（${session.suspended.reason}），請改掛其他診次`, 'CONFLICT')
  const active = db.visits.filter((v) => v.sessionId === session.id && v.status !== 'cancelled')
  if (active.length >= session.limit) fail('此診已額滿', 'CONFLICT')
  if (active.some((v) => v.patientId === patient.id)) fail(`${patient.name} 已掛過此診`, 'CONFLICT')

  // 報到是「人到了」：預約下週的掛號不可能今天就報到
  if (input.checkIn && session.date !== today()) failField('checkIn', '只有今天的門診可以同時報到')

  // 預防保健項目：掛號頁只列出「可做」的讓人勾，但那是畫面的事；服務層一樣要判斷，
  // 否則直接呼叫 API 就能掛一個不符資格的項目，還會因此以 A3 案件申報
  const preventItems = [...new Set(input.preventItems ?? [])]
  for (const code of preventItems) {
    const item = must(db.preventItems.find((i) => i.code === code), '預防保健項目')
    if (item.active === false) fail(`「${item.name}」已停止提供`)
    const el = checkEligibility(patient, item, db.preventRecords, session.date)
    if (!el.eligible) fail(`${patient.name} 不符合「${item.name}」資格：${el.reason}`, 'CONFLICT')
  }
  const v: Visit = {
    id: newId('V'),
    date: session.date,
    sessionId: session.id,
    deptId: session.deptId,
    doctorId: session.doctorId,
    patientId: patient.id,
    seqNo: nextCounter(`seq:${session.id}`),
    identityCode: input.identityCode,
    // 只做預防保健時以 A3 申報（免基本部分負擔）
    caseType: effectiveCaseType(input.caseType, preventItems.length > 0),
    cardSeq: String(nextCounter(`cardseq:${patient.id}`)).padStart(4, '0'),
    status: 'registered',
    firstVisit: !db.visits.some((x) => x.patientId === patient.id && x.status !== 'cancelled'),
    preventItems,
    createdAt: now(),
    ...(input.checkIn ? { checkedInAt: now() } : {}),
  }
  db.visits.push(v)
  return v
}

export function register(input: RegisterInput): Promise<VisitView> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const v = createVisit(input)
    const p = find.patient(v.patientId)!
    const s = find.session(v.sessionId)!
    audit('掛號', `${p.chartNo} ${p.name} → ${s.date} ${s.period} ${s.roomNo} 診 #${v.seqNo}${v.checkedInAt ? '（已報到）' : ''}`)
    return visitView(v)
  })
}

/**
 * 改期：退掉原本的掛號、掛到新的診次，在同一筆交易裡完成——新診次額滿或截止就整筆回滾，
 * 病人不會「舊的退掉了、新的沒掛上」。新掛號走和掛號完全相同的檢查（createVisit）。
 * 原掛號的退掛原因記下「改期至 …」，查得到這筆是怎麼沒的。
 */
export function rescheduleVisit(visitId: string, input: Omit<RegisterInput, 'patientId'>): Promise<VisitView> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const old = must(find.visit(visitId), '掛號紀錄')
    if (old.status !== 'registered') fail('只有尚未看診的掛號可以改期', 'CONFLICT')
    if (old.sessionId === input.sessionId) fail('新診次與原本的相同', 'CONFLICT')
    // 先退掉舊的，再掛新的：初診判斷才不會把自己算進去
    old.status = 'cancelled'
    // 已經報到的人當場改掛今天別的診（例如換醫師）：人還在，不必再報到一次
    const v = createVisit({ ...input, patientId: old.patientId, checkIn: !!old.checkedInAt && find.session(input.sessionId)?.date === today() })
    const s = find.session(v.sessionId)!
    old.cancelReason = `改期至 ${s.date} ${periodLabel[s.period]} ${nameOf.dept(s.deptId)} ${nameOf.doctor(s.doctorId)} 第 ${v.seqNo} 號`
    audit('改期', `${find.patient(v.patientId)?.name}：${old.date} #${old.seqNo} → ${s.date} ${s.period} ${s.roomNo} 診 #${v.seqNo}`)
    return visitView(v)
  })
}

/**
 * 報到：預約的病人到院了。只能報到今天、還在候診的掛號（慢箋領藥不看診，沒有報到）。
 * 報到後醫師的「下一位」才會叫到他（nextInQueue）。
 */
export function checkIn(visitId: string): Promise<VisitView> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const v = must(find.visit(visitId), '掛號紀錄')
    const problem = checkInProblem(v, today())
    if (problem) fail(`${find.patient(v.patientId)?.name}：${problem.message}`, 'CONFLICT')
    v.checkedInAt = now()
    audit('報到', `${find.patient(v.patientId)?.name} ${v.date} #${v.seqNo}`)
    return visitView(v)
  })
}

/** 實際申報的案件分類：一般案件（01）且有預防保健時，以 A3 申報（免基本部分負擔）。掛號與預估共用 */
export function effectiveCaseType(caseType: string, withPrevent: boolean): string {
  return withPrevent && caseType === '01' ? 'A3' : caseType
}

export interface FeeEstimate {
  /** 掛號當下就確定、病人要付的項目（掛號費、基本部分負擔；自費身分含診察費） */
  lines: ChargeLine[]
  total: number
  /** 為什麼沒有基本部分負擔（免部分負擔身分、預防保健案件、自費身分），讓櫃台說得出原因 */
  copayNote?: string
}

/**
 * 掛號時預估應收：只含掛號當下就確定的項目，藥品部分負擔、自費項目要看診後才知道。
 * 計算與批價共用 billing.fixedCharges，兩邊數字一致。收錢仍在批價（掛號不收費）。
 */
/** date：看診日（掛號頁選的診次日期；空白＝今天）——掛號費、部分負擔有排定調整時，看診那天的價格才對 */
export function estimateFee(identityCode: string, inputCaseType: string, withPrevent = false, date?: string): Promise<FeeEstimate> {
  return query(() => {
    const caseType = effectiveCaseType(inputCaseType, withPrevent)
    const lk = billingLookup(identityCode)
    const lines = fixedCharges(lk.identity, caseType, lk, date || today()).filter((l) => l.patientPay)
    const copayNote = lk.identity.selfPay ? '自費身分' : lk.identity.copayExempt ? `${lk.identity.name}免部分負擔` : caseType === 'A3' ? '預防保健免部分負擔' : undefined
    return { lines, total: lines.reduce((s, l) => s + l.amount, 0), copayNote }
  })
}

/**
 * 病人上一次就醫（今天以前、未退掛）的案件分類。掛號頁只用來「提示」，不自動帶入：
 * 慢性病人回診多半還是 04，提示省得櫃台去查；自動帶入則可能把一般就醫掛成慢性病。
 */
export function lastCaseType(patientId: string): Promise<{ caseType: string; date: string } | null> {
  return query(() => {
    const t = today()
    // 慢箋領藥不算「上次看診」
    const last = db.visits
      .filter((v) => v.patientId === patientId && v.date <= t && v.status !== 'cancelled' && v.status !== 'registered' && !v.refillOf)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))[0]
    return last ? { caseType: last.caseType, date: last.date } : null
  })
}

/**
 * 更正就醫身分：掛號時選錯（例：病人後來出示榮民證、低收入戶證明）。
 * 只能更正「還沒收費」的掛號——已開收據的要先作廢，收據保存的是當時算好的金額，不能事後改。
 * 案件分類不在這裡改：它跟醫師的處方綁在一起（04/08 慢性處方、A3 預防保健），櫃台改了可能讓處方不成立。
 * 以前作廢收據的範例原因是「身分別輸入錯誤」，系統卻沒有任何地方能改身分，重新試算還是同一個身分。
 */
export function correctIdentity(visitId: string, identityCode: string, reason: string): Promise<VisitView> {
  return mutate(() => {
    requireUser('clerk')
    const v = must(find.visit(visitId), '掛號紀錄')
    const v2 = fieldErrors()
    const idt = find.identity(identityCode)
    if (!idt) v2.add('identityCode', '請選擇就醫身分')
    else if (identityCode === v.identityCode) v2.add('identityCode', '與目前的身分相同')
    if (!reason?.trim()) v2.add('reason', '請填寫更正原因（例：出示榮民證）')
    v2.done()
    if (!['registered', 'in-consult', 'consulted'].includes(v.status)) {
      fail(v.status === 'cancelled' ? '此掛號已退掛' : '已開立收據，請先作廢收據再更正身分', 'CONFLICT')
    }
    const before = find.identity(v.identityCode)?.name ?? v.identityCode
    v.identityCode = identityCode
    audit('更正就醫身分', `${find.patient(v.patientId)?.name} ${v.date} #${v.seqNo}：${before} → ${idt!.name}（${reason.trim()}）`)
    return visitView(v)
  })
}

export function cancelVisit(visitId: string): Promise<VisitView> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const v = must(find.visit(visitId), '掛號紀錄')
    if (v.refillOf) {
      // 慢箋領藥登記錯了：批價前可以退，系統代填的病歷一併刪除（它不是醫師寫的，不留在歷史病歷）
      if (v.status !== 'consulted') fail('已批價的慢箋領藥不能退掛，請先由批價作廢', 'CONFLICT')
      db.encounters = db.encounters.filter((e) => e.visitId !== v.id)
      v.status = 'cancelled'
      audit('退掛', `${find.patient(v.patientId)?.name} ${v.date} 慢箋第 ${v.refillSeq} 次`)
      return visitView(v)
    }
    if (v.status !== 'registered') fail('只有尚未看診的掛號可以退掛', 'CONFLICT')
    v.status = 'cancelled'
    audit('退掛', `${find.patient(v.patientId)?.name} ${v.date} #${v.seqNo}`)
    return visitView(v)
  })
}

// ---------- 慢性病連續處方箋（慢箋）領藥 ----------

export interface RefillView extends RefillState {
  /** 原處方的病歷 id */
  encounterId: string
  /** 原處方（看診）日期 */
  date: string
  doctorName: string
  deptName: string
  /** 一次給幾天 */
  days: number
  medicationNames: string[]
  /** 已登記、還沒批價的那次（可退掛） */
  pendingVisitId?: string
}

const dispensedDateOf = (visitId: string) => db.dispenses.find((d) => d.visitId === visitId && d.status === 'dispensed')?.dispensedAt?.slice(0, 10)

function refillStateOf(e: Encounter, t: string): RefillState {
  const first = must(find.visit(e.visitId), '掛號紀錄')
  const fills: RefillFill[] = [
    { seq: 1, date: first.date, status: first.status, dispensedDate: dispensedDateOf(first.id) },
    ...db.visits.filter((v) => v.refillOf === e.id).map((v) => ({ seq: v.refillSeq!, date: v.date, status: v.status, dispensedDate: dispensedDateOf(v.id) })),
  ]
  return refillState(e.refillTimes, supplyDays(e.medications), fills, t)
}

/**
 * 病人的慢箋：還能領的、還沒到時間的、剛過期的（過期 30 天內還列著，櫃台才答得出「為什麼不能領」）。
 * 已領完、早就過期、被同科新慢箋取代的不列。
 */
export function listRefills(patientId: string): Promise<RefillView[]> {
  return query(() => {
    const t = today()
    return db.encounters
      .filter((e) => e.patientId === patientId && e.status === 'completed' && e.refillTimes >= 2 && e.medications.length && find.visit(e.visitId)?.status !== 'cancelled')
      .filter((e, _, mine) => !supersededBy(e, mine))
      .map((e) => {
        const st = refillStateOf(e, t)
        const pending = db.visits.find((v) => v.refillOf === e.id && v.status === 'consulted')
        return {
          ...st, encounterId: e.id, date: e.date, doctorName: nameOf.doctor(e.doctorId), deptName: nameOf.dept(e.deptId),
          days: supplyDays(e.medications), medicationNames: e.medications.map((m) => find.drug(m.drugId)?.name ?? m.drugId), pendingVisitId: pending?.id,
        }
      })
      .filter((x) => x.nextSeq !== null && (!x.window || x.window.to >= addDays(t, -30)))
      .sort((a, b) => b.date.localeCompare(a.date))
  })
}

/**
 * 登記慢箋領藥：建立一筆 08 案件的就醫（直接是「已看診」）＋系統代填的病歷（藥照抄原處方）。
 * 之後與一般就醫一樣：批價 → 領藥號 → 藥局調劑、發藥。
 */
export function registerRefill(encounterId: string): Promise<VisitView> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const e = must(db.encounters.find((x) => x.id === encounterId), '原處方')
    if (e.status !== 'completed' || e.refillTimes < 2) fail('這張處方不是慢性病連續處方箋')
    const mine = db.encounters.filter((x) => x.patientId === e.patientId && x.status === 'completed' && x.refillTimes >= 2 && find.visit(x.visitId)?.status !== 'cancelled')
    const newer = supersededBy(e, mine)
    if (newer) fail(`無法登記領藥：已由 ${newer.slice(5).replace('-', '/')} 的新處方取代`, 'CONFLICT')
    const p = must(find.patient(e.patientId), '病患')
    const t = today()
    const st = refillStateOf(e, t)
    if (!st.canRegister) fail(`無法登記領藥：${st.reason}`, 'CONFLICT')
    const first = must(find.visit(e.visitId), '掛號紀錄')
    const v: Visit = {
      id: newId('V'), date: t, sessionId: '', deptId: e.deptId, doctorId: e.doctorId, patientId: p.id, seqNo: 0,
      identityCode: p.defaultIdentity, caseType: '08', cardSeq: String(nextCounter(`cardseq:${p.id}`)).padStart(4, '0'),
      status: 'consulted', firstVisit: false, preventItems: [], createdAt: now(), refillOf: e.id, refillSeq: st.nextSeq!,
    }
    db.visits.push(v)
    const doctor = nameOf.doctor(e.doctorId)
    db.encounters.push({
      id: newId('E'), visitId: v.id, patientId: p.id, doctorId: e.doctorId, deptId: e.deptId, date: t,
      subjective: `慢性病連續處方箋第 ${v.refillSeq} 次調劑（原處方 ${first.date} ${doctor}）`, objective: '', assessment: '', plan: '',
      vitals: {}, diagnoses: clonePlain(e.diagnoses), medications: clonePlain(e.medications), procedures: [],
      refillTimes: 0, admissionRequested: false, status: 'completed', completedAt: now(),
    })
    audit('慢箋領藥登記', `${p.chartNo} ${p.name} 第 ${v.refillSeq}/${e.refillTimes} 次（原處方 ${first.date} ${doctor}）`)
    return visitView(v)
  })
}
