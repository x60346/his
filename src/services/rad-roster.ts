// 放射師排班：放射科組長（權限 radiology.roster）排一般攝影、電腦斷層、磁振造影每天上午、下午由誰負責。
// 排程不擋（緊急檢查還是要做）；沒排人的時段，已排的檢查標「沒有放射師」、組長首頁提醒。規則在 rad-roster-rules
import type { RadShift, RadShiftRequest } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, mutate, permissionsOf, query, requirePermission, requireUser, sessionRole } from './http'
import { nameOf } from './views'
import { examDayOf, examRoomName } from './exam-rules'
import { RAD_BLOCKS, RAD_ROOMS, radBlockLabel } from './rad-roster-rules'
import { radUnstaffedExams } from './rad-roster-work'

export interface RadRoster {
  from: string
  /** closed：這段不開（休診、週末、只開上午），不用排 */
  days: { date: string; rooms: { room: RadShift['room']; name: string; blocks: { block: RadShift['block']; label: string; userId?: string; name?: string; exams: number; closed?: string }[] }[] }[]
  radtechs: { id: string; name: string }[]
  canEdit: boolean
  /** 未來 14 天已排、還沒報到、時段沒有放射師的檢查 */
  unstaffed: { id: string; patientName: string; roomName: string; start: string; missing: string }[]
  /** 放射師：自己今天起 14 天的班（可以申請請假、換班） */
  myShifts: { id: string; date: string; roomName: string; blockLabel: string; pending?: string }[]
  /** 請假、換班申請：組長看全部待核准，放射師看自己的（最近 14 天內的） */
  requests: RadRequestView[]
}
export interface RadRequestView extends RadShiftRequest {
  requesterName: string
  toName?: string
  roomName: string
  blockLabel: string
  decidedByName?: string
}
const reqView = (r: RadShiftRequest): RadRequestView => ({
  ...r, requesterName: nameOf.user(r.requesterId), ...(r.toUserId ? { toName: nameOf.user(r.toUserId) } : {}), roomName: examRoomName(r.room), blockLabel: radBlockLabel(r.block),
  ...(r.decided ? { decidedByName: nameOf.user(r.decided.by) } : {}),
})

/** 排班表（from 起 days 天）：放射師、醫師、櫃台、管理員都能看 */
export function radRoster(from: string = today(), days = 7): Promise<RadRoster> {
  return query(() => {
    const u = requireUser('radtech', 'doctor', 'clerk', 'admin')
    const live = db.imagingExams.filter((e) => !e.cancelled)
    return {
      from,
      days: Array.from({ length: days }, (_, i) => addDays(from, i)).map((date) => ({
        date,
        rooms: RAD_ROOMS.map((room) => ({
          room, name: examRoomName(room),
          blocks: RAD_BLOCKS.map((b) => {
            const s = db.radShifts.find((x) => x.date === date && x.room === room && x.block === b.key)
            const day = examDayOf(db.examHours, db.examClosures, room, date)
            const closed = 'closed' in day ? day.closed : day.start >= b.end || day.end <= b.start ? `${b.label}不開` : undefined
            const exams = live.filter((e) => e.room === room && e.start.slice(0, 10) === date && e.start.slice(11, 16) >= b.start && e.start.slice(11, 16) < b.end).length
            return { block: b.key, label: b.label, ...(s ? { userId: s.userId, name: nameOf.user(s.userId) } : {}), exams, ...(closed && !s ? { closed } : {}) }
          }),
        })),
      })),
      radtechs: db.users.filter((x) => x.active && (x.roles ?? []).includes('radtech')).map((x) => ({ id: x.id, name: x.name })),
      canEdit: permissionsOf({ ...u, role: sessionRole()! }).includes('radiology.roster'),
      unstaffed: radUnstaffedExams(now()),
      myShifts: (u.roles ?? []).includes('radtech') ? db.radShifts.filter((s) => s.userId === u.id && s.date >= today() && s.date <= addDays(today(), 14)).sort((a, b) => a.date.localeCompare(b.date) || a.block.localeCompare(b.block))
        .map((s) => ({ id: s.id, date: s.date, roomName: examRoomName(s.room), blockLabel: radBlockLabel(s.block), ...((p) => (p ? { pending: p.kind === 'leave' ? '請假申請中' : `換班給${nameOf.user(p.toUserId!)}申請中` } : {}))(db.radShiftRequests.find((r) => r.shiftId === s.id && r.status === 'pending')) })) : [],
      requests: db.radShiftRequests.filter((r) => (permissionsOf({ ...u, role: sessionRole()! }).includes('radiology.roster') ? r.status === 'pending' : r.requesterId === u.id && r.date >= addDays(today(), -14)))
        .sort((a, b) => a.date.localeCompare(b.date)).map(reqView),
    }
  })
}

/** 排一格（userId 空＝清掉）：不能排過去的日子；同一人同一段不能排兩間 */
export function setRadShift(input: { date: string; room: RadShift['room']; block: RadShift['block']; userId?: string }): Promise<{ ok: true }> {
  return mutate(() => {
    const u = requirePermission('radiology.roster')
    if (!RAD_ROOMS.includes(input.room)) failField('room', '這間不用排放射師')
    if (!RAD_BLOCKS.some((b) => b.key === input.block)) failField('block', '請選上午或下午')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) failField('date', '請選日期')
    if (input.date < today()) fail('不能改過去的班', 'CONFLICT')
    const cur = db.radShifts.find((x) => x.date === input.date && x.room === input.room && x.block === input.block)
    const label = `${input.date} ${examRoomName(input.room)} ${radBlockLabel(input.block)}`
    if (!input.userId) {
      if (cur) {
        db.radShifts = db.radShifts.filter((x) => x !== cur)
        audit('放射師排班', `${label}：清掉 ${nameOf.user(cur.userId)}`)
      }
      return { ok: true as const }
    }
    const tech = db.users.find((x) => x.id === input.userId && x.active && (x.roles ?? []).includes('radtech'))
    if (!tech) failField('userId', '請選放射師')
    const busy = db.radShifts.find((x) => x.date === input.date && x.block === input.block && x.userId === input.userId && x.room !== input.room)
    if (busy) fail(`${tech!.name}這段已經排在${examRoomName(busy.room)}`, 'CONFLICT', 'userId')
    if (cur) Object.assign(cur, { userId: tech!.id, by: u.id, at: now() })
    else db.radShifts.push({ id: newId('RS'), date: input.date, room: input.room, block: input.block, userId: tech!.id, by: u.id, at: now() })
    audit('放射師排班', `${label}：${tech!.name}`)
    return { ok: true as const }
  })
}

/** 我今天的班（放射師）：哪幾間、哪幾段 */
export function myRadShifts(): Promise<{ room: string; block: string }[]> {
  return query(() => {
    const u = requireUser('radtech')
    return db.radShifts.filter((x) => x.userId === u.id && x.date === today()).map((x) => ({ room: examRoomName(x.room), block: radBlockLabel(x.block) }))
  })
}

/** 申請請假或換班（放射師，自己的班、今天以後）：換班要選接手的人（同一段沒排在別間）；同一格只能有一張待核准 */
export function requestRadChange(input: { shiftId: string; kind: RadShiftRequest['kind']; toUserId?: string; reason: string }): Promise<RadRequestView> {
  return mutate(() => {
    const u = requireUser('radtech')
    const s = db.radShifts.find((x) => x.id === input.shiftId)
    if (!s || s.userId !== u.id) fail('只能申請自己的班', 'FORBIDDEN')
    if (s!.date < today()) fail('過去的班不能申請', 'CONFLICT')
    if (db.radShiftRequests.some((r) => r.shiftId === s!.id && r.status === 'pending')) fail('這一班已經有申請在等核准', 'CONFLICT')
    if (input.kind !== 'leave' && input.kind !== 'swap') failField('kind', '請選請假或換班')
    if (!input.reason?.trim()) failField('reason', '請寫原因')
    let to: string | undefined
    if (input.kind === 'swap') {
      const t = db.users.find((x) => x.id === input.toUserId && x.active && (x.roles ?? []).includes('radtech'))
      if (!t || t.id === u.id) failField('toUserId', '請選接手的放射師')
      if (db.radShifts.some((x) => x.date === s!.date && x.block === s!.block && x.userId === t!.id)) failField('toUserId', `${t!.name}這段已經有班`)
      to = t!.id
    }
    const r: RadShiftRequest = { id: newId('RQ'), shiftId: s!.id, date: s!.date, room: s!.room, block: s!.block, requesterId: u.id, kind: input.kind, ...(to ? { toUserId: to } : {}), reason: input.reason.trim(), at: now(), status: 'pending' }
    db.radShiftRequests.push(r)
    audit('放射師班別申請', `${s!.date} ${examRoomName(s!.room)} ${radBlockLabel(s!.block)}：${input.kind === 'leave' ? '請假' : `換給 ${nameOf.user(to!)}`}（${r.reason}）`)
    return reqView(r)
  })
}

/** 核准或退回（組長）：請假核准＝清掉那一格；換班核准＝改成接手的人（接手的人這段又排了別間就不能核准）；退回要寫原因 */
export function decideRadChange(id: string, approve: boolean, note = ''): Promise<RadRequestView> {
  return mutate(() => {
    const u = requirePermission('radiology.roster')
    const r = db.radShiftRequests.find((x) => x.id === id)
    if (!r) fail('找不到申請', 'NOT_FOUND')
    if (r!.status !== 'pending') fail('這張申請已經處理過了', 'CONFLICT')
    if (!approve && !note.trim()) failField('note', '退回請寫原因')
    const s = db.radShifts.find((x) => x.id === r!.shiftId)
    if (approve) {
      if (!s || s.userId !== r!.requesterId) fail('這一格已經改過了，請重新整理', 'CONFLICT')
      if (r!.kind === 'swap') {
        if (db.radShifts.some((x) => x !== s && x.date === s!.date && x.block === s!.block && x.userId === r!.toUserId)) fail(`${nameOf.user(r!.toUserId!)}這段已經排在別間，不能核准`, 'CONFLICT')
        Object.assign(s!, { userId: r!.toUserId!, by: u.id, at: now() })
      } else db.radShifts = db.radShifts.filter((x) => x !== s)
    }
    r!.status = approve ? 'approved' : 'rejected'
    r!.decided = { at: now(), by: u.id, ...(note.trim() ? { note: note.trim() } : {}) }
    audit(approve ? '放射師班別核准' : '放射師班別退回', `${r!.date} ${examRoomName(r!.room)} ${radBlockLabel(r!.block)}：${nameOf.user(r!.requesterId)} ${r!.kind === 'leave' ? '請假' : `換給 ${nameOf.user(r!.toUserId!)}`}${note.trim() ? `（${note.trim()}）` : ''}`)
    return reqView(r!)
  })
}
