// 掛號：建立 Visit（狀態機的起點）、退掛、候診清單。
import type { Visit, VisitStatus } from '@/types'
import { db, nextCounter, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, fieldErrors, must, mutate, query, requireUser } from './http'
import { ensureSessions, isSessionClosed, periodCloseTime } from './schedule'
import { find, visitView, type VisitView } from './views'
import { checkEligibility } from './prevent-rules'

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
}

export function register(input: RegisterInput): Promise<VisitView> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const patient = must(find.patient(input.patientId), '病患')
    const date = input.sessionId.slice(1, 9).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')
    ensureSessions(date)
    const session = must(find.session(input.sessionId), '診次')
    must(find.identity(input.identityCode), '就醫身分')

    if (session.date < today()) fail('不可掛過去日期的門診')
    if (isSessionClosed(session)) fail(`此診次已於 ${periodCloseTime[session.period]} 截止掛號`, 'CONFLICT')
    if (session.suspended) fail(`此診次停診（${session.suspended.reason}），請改掛其他診次`, 'CONFLICT')
    const active = db.visits.filter((v) => v.sessionId === session.id && v.status !== 'cancelled')
    if (active.length >= session.limit) fail('此診已額滿', 'CONFLICT')
    if (active.some((v) => v.patientId === patient.id)) fail(`${patient.name} 已掛過此診`, 'CONFLICT')

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
      caseType: preventItems.length && input.caseType === '01' ? 'A3' : input.caseType,
      cardSeq: String(nextCounter(`cardseq:${patient.id}`)).padStart(4, '0'),
      status: 'registered',
      firstVisit: !db.visits.some((x) => x.patientId === patient.id && x.status !== 'cancelled'),
      preventItems,
      createdAt: now(),
    }
    db.visits.push(v)
    audit('掛號', `${patient.chartNo} ${patient.name} → ${session.date} ${session.period} ${session.roomNo} 診 #${v.seqNo}`)
    return visitView(v)
  })
}

/**
 * 病人上一次就醫（今天以前、未退掛）的案件分類。掛號頁只用來「提示」，不自動帶入：
 * 慢性病人回診多半還是 04，提示省得櫃台去查；自動帶入則可能把一般就醫掛成慢性病。
 */
export function lastCaseType(patientId: string): Promise<{ caseType: string; date: string } | null> {
  return query(() => {
    const t = today()
    const last = db.visits
      .filter((v) => v.patientId === patientId && v.date <= t && v.status !== 'cancelled' && v.status !== 'registered')
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
    if (v.status !== 'registered') fail('只有尚未看診的掛號可以退掛', 'CONFLICT')
    v.status = 'cancelled'
    audit('退掛', `${find.patient(v.patientId)?.name} ${v.date} #${v.seqNo}`)
    return visitView(v)
  })
}
