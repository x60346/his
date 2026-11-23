// 放射師排班：放射科組長（權限 radiology.roster）排一般攝影、電腦斷層、磁振造影每天上午、下午由誰負責。
// 排程不擋（緊急檢查還是要做）；沒排人的時段，已排的檢查標「沒有放射師」、組長首頁提醒。規則在 rad-roster-rules
import type { RadShift } from '@/types'
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
}

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
