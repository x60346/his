// 門診表：每週範本（WeeklySlot）→ 每日診次（ClinicSession）。
// 診次採「用到才產生」：查詢任一天時，缺少的診次會依範本補齊，所以永遠有未來的門診可掛。
//
// 兩層調整：
//   每週範本——長期的排班（每週三上午林醫師 101 診）。改範本只影響「還沒有人掛號」的未來診次。
//   單日診次——某一天的例外：停診（病人退掛並通知）、代診（病人轉給同科另一位醫師）。
// 原則：已經有病人掛號的診次，任何調整都不能讓掛號默默消失或默默換醫師。
import type { ClinicSession, Period, Visit, WeeklySlot } from '@/types'
import { commitIfPossible, db, newId } from '@/mock/db'
import { now, parseDate, periodLabel, today } from '@/utils/date'
import { audit, fail, failField, fieldErrors, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'

const sessionId = (date: string, slotId: string) => `S${date.replace(/-/g, '')}${slotId}`
/** 診次是否由此範本產生：用完整 id 比對。不可用 endsWith——WS2 會誤中 WS12 */
const isFromSlot = (s: ClinicSession, slotId: string) => s.id === sessionId(s.date, slotId)

/** 補齊某日缺少的診次，回傳是否有新增（服務層內部使用） */
export function ensureSessions(date: string): boolean {
  const wd = parseDate(date).getDay()
  let added = false
  for (const slot of db.weeklySlots.filter((s) => s.weekday === wd)) {
    const id = sessionId(date, slot.id)
    if (db.sessions.some((s) => s.id === id)) continue
    const doc = find.doctor(slot.doctorId)
    if (!doc?.active) continue
    db.sessions.push({ id, date, period: slot.period, deptId: doc.deptId, doctorId: doc.id, roomNo: slot.roomNo, limit: slot.limit })
    added = true
  }
  return added
}

/** 各診別的掛號截止時間（展示用設定） */
export const periodCloseTime: Record<Period, string> = { AM: '12:00', PM: '17:30', NIGHT: '21:30' }


/** 診次是否已結束（過去日期，或今天但已過截止時間） */
export function isSessionClosed(s: Pick<ClinicSession, 'date' | 'period'>, at = now()): boolean {
  return `${s.date} ${periodCloseTime[s.period]}` <= at
}

export interface SessionView extends ClinicSession {
  doctorName: string
  deptName: string
  /** 有效掛號數（不含退掛） */
  booked: number
  /** 尚在候診 */
  waiting: number
  /** 已看完（含已批價、已領藥） */
  done: number
  full: boolean
  /** 已過掛號截止時間 */
  closed: boolean
  /** 代診時的原排班醫師 */
  originalDoctorName?: string
  /** 可否掛號：未額滿、未截止、未停診——「能不能掛」是規則，由服務層算好，頁面不要自己組條件 */
  bookable: boolean
}

function sessionView(s: ClinicSession): SessionView {
  const vs = db.visits.filter((v) => v.sessionId === s.id && v.status !== 'cancelled')
  const booked = vs.length
  return {
    ...s,
    doctorName: nameOf.doctor(s.doctorId),
    deptName: nameOf.dept(s.deptId),
    booked,
    waiting: vs.filter((v) => v.status === 'registered' || v.status === 'in-consult').length,
    done: vs.filter((v) => ['consulted', 'charged', 'dispensed'].includes(v.status)).length,
    full: booked >= s.limit,
    closed: isSessionClosed(s),
    originalDoctorName: s.originalDoctorId ? nameOf.doctor(s.originalDoctorId) : undefined,
    bookable: booked < s.limit && !isSessionClosed(s) && !s.suspended,
  }
}

const periodOrder: Record<Period, number> = { AM: 0, PM: 1, NIGHT: 2 }

export function listSessions(q: { date: string; deptId?: string; doctorId?: string; period?: Period }): Promise<SessionView[]> {
  return query(() => {
    // 讀取時補產生診次屬於「隱性寫入」，需要自行 commit 才會保存
    if (ensureSessions(q.date)) commitIfPossible()
    return db.sessions
      .filter((s) => s.date === q.date && (!q.deptId || s.deptId === q.deptId) && (!q.doctorId || s.doctorId === q.doctorId) && (!q.period || s.period === q.period))
      .sort((a, b) => periodOrder[a.period] - periodOrder[b.period] || a.roomNo.localeCompare(b.roomNo))
      .map(sessionView)
  })
}

export const getSession = (id: string): Promise<SessionView> => query(() => sessionView(must(find.session(id), '診次')))

// ---------- 每週範本維護 ----------
export interface WeeklySlotView extends WeeklySlot {
  doctorName: string
  deptId: string
  deptName: string
  doctorActive: boolean
}

export function listWeeklySlots(q: { doctorId?: string; deptId?: string } = {}): Promise<WeeklySlotView[]> {
  return query(() =>
    db.weeklySlots
      .map((s) => {
        const doc = find.doctor(s.doctorId)
        return { ...s, doctorName: doc?.name ?? s.doctorId, deptId: doc?.deptId ?? '', deptName: nameOf.dept(doc?.deptId), doctorActive: !!doc?.active }
      })
      .filter((s) => (!q.doctorId || s.doctorId === q.doctorId) && (!q.deptId || s.deptId === q.deptId))
      .sort((a, b) => a.weekday - b.weekday || periodOrder[a.period] - periodOrder[b.period] || a.roomNo.localeCompare(b.roomNo)),
  )
}

/**
 * 範本變更後，移除「未來、尚無掛號、未做過單日調整」的舊診次，讓它們依新範本重新產生。
 * 已有掛號的保留原安排（病人掛的是那位醫師、那個時段），回傳保留數量讓管理員知道。
 */
function dropFutureEmptySessions(slotId: string): number {
  const t = today()
  let kept = 0
  db.sessions = db.sessions.filter((s) => {
    if (!isFromSlot(s, slotId) || s.date <= t) return true
    const hasVisits = db.visits.some((v) => v.sessionId === s.id)
    if (hasVisits || s.suspended || s.originalDoctorId) {
      kept++
      return true
    }
    return false
  })
  return kept
}

export interface SlotResult {
  slot?: WeeklySlot
  /** 已有掛號、維持原安排的未來診次數 */
  keptSessions: number
}

export function saveWeeklySlot(input: Omit<WeeklySlot, 'id'> & { id?: string }): Promise<SlotResult> {
  return mutate(() => {
    requireUser('admin')
    const doc = find.doctor(input.doctorId)
    const roomNo = input.roomNo.trim()
    const v = fieldErrors()
    if (!doc) v.add('doctorId', '請選擇醫師')
    if (!Number.isInteger(input.weekday) || input.weekday < 0 || input.weekday > 6) v.add('weekday', '請選擇星期')
    if (!periodOrder.hasOwnProperty(input.period)) v.add('period', '請選擇時段')
    if (!roomNo) v.add('roomNo', '請輸入診間')
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200) v.add('limit', '人數上限需為 1–200')
    v.done()
    if (!doc!.active) failField('doctorId', `${doc!.name} 已停用，不能排班`)
    const clash = db.weeklySlots.find((s) => s.id !== input.id && s.weekday === input.weekday && s.period === input.period && (s.doctorId === input.doctorId || s.roomNo === roomNo))
    if (clash) {
      if (clash.doctorId === input.doctorId) failField('period', `${doc!.name} 週${'日一二三四五六'[input.weekday]}${periodLabel[input.period]}已有門診（${clash.roomNo} 診）`, 'CONFLICT')
      failField('roomNo', `診間 ${roomNo} 此時段已由${nameOf.doctor(clash.doctorId)}使用`, 'CONFLICT')
    }
    if (input.id) must(db.weeklySlots.find((s) => s.id === input.id), '門診範本')
    const saved: WeeklySlot = { id: input.id ?? newId('WS'), doctorId: doc!.id, weekday: input.weekday, period: input.period, roomNo, limit: input.limit }
    const i = db.weeklySlots.findIndex((s) => s.id === saved.id)
    if (i >= 0) db.weeklySlots[i] = saved
    else db.weeklySlots.push(saved)
    const keptSessions = dropFutureEmptySessions(saved.id)
    audit(input.id ? '修改門診表' : '新增門診表', `${doc!.name} 週${'日一二三四五六'[saved.weekday]}${periodLabel[saved.period]} ${roomNo} 診`)
    return { slot: saved, keptSessions }
  })
}

export function deleteWeeklySlot(id: string): Promise<SlotResult> {
  return mutate(() => {
    requireUser('admin')
    const slot = must(db.weeklySlots.find((s) => s.id === id), '門診範本')
    db.weeklySlots = db.weeklySlots.filter((s) => s.id !== id)
    const keptSessions = dropFutureEmptySessions(id)
    audit('刪除門診表', `${nameOf.doctor(slot.doctorId)} 週${'日一二三四五六'[slot.weekday]}${periodLabel[slot.period]}`)
    return { keptSessions }
  })
}

// ---------- 單日調整：停診、代診 ----------
export interface AffectedVisit {
  visitId: string
  seqNo: number
  patientName: string
  phone: string
  status: Visit['status']
}

export interface SessionImpact {
  session: SessionView
  /** 尚未看診、會受影響的掛號 */
  visits: AffectedVisit[]
  /** 不能調整的原因（已結束、已開始看診、已停診）；可以調整時為 null */
  blocked: string | null
  /** 可代診的醫師：同科、在職、同一時段沒有其他門診 */
  candidates: { id: string; name: string }[]
}

function affected(s: ClinicSession): AffectedVisit[] {
  return db.visits
    .filter((v) => v.sessionId === s.id && v.status === 'registered')
    .sort((a, b) => a.seqNo - b.seqNo)
    .map((v) => {
      const p = find.patient(v.patientId)
      return { visitId: v.id, seqNo: v.seqNo, patientName: p?.name ?? '', phone: p?.phone ?? '', status: v.status }
    })
}

function blockReason(s: ClinicSession): string | null {
  if (s.suspended) return '此診次已停診'
  if (isSessionClosed(s)) return '此診次已結束'
  if (db.visits.some((v) => v.sessionId === s.id && !['registered', 'cancelled'].includes(v.status))) return '此診次已開始看診，無法停診或代診'
  return null
}

function candidatesFor(s: ClinicSession) {
  ensureSessions(s.date)
  const busy = new Set(db.sessions.filter((x) => x.date === s.date && x.period === s.period && !x.suspended && x.id !== s.id).map((x) => x.doctorId))
  return db.doctors.filter((d) => d.active && d.deptId === s.deptId && d.id !== s.doctorId && !busy.has(d.id)).map((d) => ({ id: d.id, name: d.name }))
}

export function getSessionImpact(id: string): Promise<SessionImpact> {
  return query(() => {
    requireUser('admin')
    const s = must(find.session(id), '診次')
    return { session: sessionView(s), visits: affected(s), blocked: blockReason(s), candidates: candidatesFor(s) }
  })
}

/** 代診：診次改由同科另一位醫師看，已掛號的病人一併轉過去（病人不用重掛） */
export function substituteSession(id: string, doctorId: string, reason: string): Promise<SessionView> {
  return mutate(() => {
    requireUser('admin')
    const s = must(find.session(id), '診次')
    const blocked = blockReason(s)
    if (blocked) fail(blocked, 'CONFLICT')
    const sub = find.doctor(doctorId)
    const v = fieldErrors()
    if (!sub || !sub.active) v.add('doctorId', '請選擇在職的代診醫師')
    if (!reason.trim()) v.add('reason', '請輸入代診原因')
    v.done()
    if (sub!.deptId !== s.deptId) failField('doctorId', '代診醫師需為同一科別（病人掛的是這一科）')
    if (!candidatesFor(s).some((c) => c.id === doctorId)) failField('doctorId', `${sub!.name} 同一時段已有門診`, 'CONFLICT')

    const from = s.doctorId
    s.originalDoctorId = s.originalDoctorId ?? from // 連續代診時，保留「最初」排班的醫師
    s.doctorId = sub!.id
    s.substituteReason = reason.trim()
    // 看診清單依掛號上的醫師顯示：掛號要一起轉給代診醫師，否則病人不會出現在代診醫師的候診清單
    const moved = db.visits.filter((v) => v.sessionId === s.id && v.status !== 'cancelled')
    for (const v of moved) v.doctorId = sub!.id
    audit('代診', `${s.date} ${periodLabel[s.period]} ${s.roomNo} 診：${nameOf.doctor(from)} → ${sub!.name}（${reason.trim()}），轉移掛號 ${moved.length} 筆`)
    return sessionView(s)
  })
}

/** 停診：診次不開，已掛號的病人全部退掛，並列入「停診通知」名單等候電話通知 */
export function suspendSession(id: string, reason: string): Promise<AffectedVisit[]> {
  return mutate(() => {
    const u = requireUser('admin')
    const s = must(find.session(id), '診次')
    const blocked = blockReason(s)
    if (blocked) fail(blocked, 'CONFLICT')
    if (!reason.trim()) failField('reason', '請輸入停診原因')
    const list = affected(s)
    for (const a of list) {
      const v = db.visits.find((x) => x.id === a.visitId)!
      v.status = 'cancelled'
      v.cancelReason = `停診：${reason.trim()}`
    }
    s.suspended = { reason: reason.trim(), at: now(), by: u.id }
    audit('停診', `${s.date} ${periodLabel[s.period]} ${nameOf.doctor(s.doctorId)}（${reason.trim()}），退掛 ${list.length} 筆待通知`)
    return list
  })
}

// ---------- 停診通知 ----------
export interface NoticeRow extends AffectedVisit {
  date: string
  period: Period
  doctorName: string
  reason: string
  notifiedAt?: string
  /** 記錄通知的人（姓名） */
  notifiedByName?: string
}

/** 停診通知名單的範圍：今天以後、因停診而退掛的掛號（含已通知者）。名單與首頁待辦共用 */
export function suspendNoticeVisits(t = today()) {
  return db.visits.filter((v) => v.date >= t && v.status === 'cancelled' && v.cancelReason?.startsWith('停診'))
}

/** 今天以後因停診而退掛的病人（含已通知者，方便核對） */
export function listSuspendNotices(): Promise<NoticeRow[]> {
  return query(() => {
    requireUser('admin', 'clerk') // 打電話通知病人多是櫃台的工作；停診、代診本身仍只限管理員
    return suspendNoticeVisits()
      .map((v) => {
        const s = find.session(v.sessionId)
        const p = find.patient(v.patientId)
        return {
          visitId: v.id, seqNo: v.seqNo, patientName: p?.name ?? '', phone: p?.phone ?? '', status: v.status,
          date: v.date, period: s?.period ?? 'AM', doctorName: nameOf.doctor(s?.originalDoctorId ?? s?.doctorId), reason: v.cancelReason!.slice(3), notifiedAt: v.notifiedAt,
          notifiedByName: v.notifiedBy ? (db.users.find((u) => u.id === v.notifiedBy)?.name ?? v.notifiedBy) : undefined,
        }
      })
      .sort((a, b) => Number(!!a.notifiedAt) - Number(!!b.notifiedAt) || a.date.localeCompare(b.date) || periodOrder[a.period] - periodOrder[b.period] || a.seqNo - b.seqNo)
  })
}

export function markNotified(visitId: string): Promise<void> {
  return mutate(() => {
    const u = requireUser('admin', 'clerk')
    const v = must(db.visits.find((x) => x.id === visitId), '掛號紀錄')
    if (!v.cancelReason?.startsWith('停診')) fail('此掛號不是停診退掛')
    if (v.notifiedAt) fail('已記錄通知', 'CONFLICT')
    v.notifiedAt = now()
    v.notifiedBy = u.id
    audit('停診通知', `${find.patient(v.patientId)?.name} ${v.date}`)
  })
}

/**
 * 撤銷「已通知」：按錯人時用。病人回到待通知名單。
 * 「已通知」按鈕平常要連續按幾十次，所以不在按下前確認，改成可以撤銷——
 * 狀態改回去，但「曾記錄通知、何時被誰撤銷」留在稽核紀錄（原記錄者與時間一併寫入）。
 */
export function unmarkNotified(visitId: string): Promise<void> {
  return mutate(() => {
    requireUser('admin', 'clerk')
    const v = must(db.visits.find((x) => x.id === visitId), '掛號紀錄')
    if (!v.cancelReason?.startsWith('停診')) fail('此掛號不是停診退掛')
    if (!v.notifiedAt) fail('這位病人尚未記錄通知', 'CONFLICT')
    const by = v.notifiedBy ? (db.users.find((x) => x.id === v.notifiedBy)?.name ?? v.notifiedBy) : '未知'
    audit('撤銷停診通知', `${find.patient(v.patientId)?.name} ${v.date}（原記錄：${v.notifiedAt.slice(5)} ${by}）`)
    delete v.notifiedAt
    delete v.notifiedBy
  })
}
