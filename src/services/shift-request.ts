// 換班與請假：
//   請假：護理師對自己已排的一班申請（假別、原因）→ 護理長（權限「護理排班」）核准 → 從班表拿掉（那班少人照樣標紅）
//   換班：我的一班 ↔ 別人的一班 → 對方同意 → 護理長核准 → 交換。換完違反「同一天一人一班」擋；兩班之間休息不到 8 小時只提醒
// 只能申請今天以後的班；核准時再檢查一次（期間班表可能被改過）
import type { NurseShift, ShiftRequest } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, addMinutes, now, today } from '@/utils/date'
import { audit, fail, failField, must, mutate, permissionsOf, query, requirePermission, requireUser } from './http'
import { nameOf } from './views'
import { LEAVE_TYPES, restProblems } from './staffing-rules'

const shiftOf = (id: string) => db.nurseShifts.find((x) => x.id === id)
const label = (s: Pick<NurseShift, 'ward' | 'date' | 'shift'>) => `${s.ward.split(' ')[0]} ${s.date.slice(5)} ${s.shift}`

/** 換完以後兩人的班：檢查同一天一人一班（擋）、休息不到 8 小時（提醒） */
function swapCheck(a: NurseShift, b: NurseShift): { block?: string; warnings: string[] } {
  const after = (nurseId: string, give: NurseShift, take: NurseShift) => [...db.nurseShifts.filter((x) => x.nurseId === nurseId && x.id !== give.id), { ...take, nurseId }]
  const aAfter = after(a.nurseId, a, b)
  const bAfter = after(b.nurseId, b, a)
  for (const [id, list] of [[a.nurseId, aAfter], [b.nurseId, bAfter]] as const) {
    const days = list.map((x) => x.date)
    const dup = days.find((d, i) => days.indexOf(d) !== i)
    if (dup) return { block: `${nameOf.user(id)} 換完後 ${dup.slice(5)} 會有兩班（同一天只能上一班）`, warnings: [] }
  }
  const near = (list: NurseShift[], d: string) => list.filter((x) => x.date >= addDays(d, -1) && x.date <= addDays(d, 1))
  const warnings = [...restProblems(near(aAfter, b.date)).map((w) => `${nameOf.user(a.nurseId)}：${w}`), ...restProblems(near(bAfter, a.date)).map((w) => `${nameOf.user(b.nurseId)}：${w}`)]
  return { warnings }
}

export interface ShiftRequestView extends ShiftRequest {
  requesterName: string
  targetName?: string
  decidedByName?: string
  text: string
  /** 換班：換完休息不到 8 小時的提醒；或現在已經不能換的原因 */
  warnings: string[]
  block?: string
}

function view(r: ShiftRequest): ShiftRequestView {
  const a = shiftOf(r.shiftId)
  const b = r.targetShiftId ? shiftOf(r.targetShiftId) : undefined
  const chk = r.kind === 'swap' && a && b && ['pending-peer', 'pending'].includes(r.status) ? swapCheck(a, b) : { warnings: [] as string[] }
  return {
    ...r, requesterName: nameOf.user(r.requesterId), ...(r.targetId ? { targetName: nameOf.user(r.targetId) } : {}), ...(r.decidedBy ? { decidedByName: nameOf.user(r.decidedBy) } : {}),
    text: r.kind === 'leave' ? `請假 ${label(r)}（${r.leaveType}）` : `換班 ${label(r)} ↔ ${nameOf.user(r.targetId)} ${r.target ? label(r.target) : ''}`,
    warnings: chk.warnings, ...(chk.block ? { block: chk.block } : {}),
  }
}

const open = (r: ShiftRequest) => r.status === 'pending-peer' || r.status === 'pending'
const assertMine = (shiftId: string, userId: string) => {
  const s = must(shiftOf(shiftId), '班')
  if (s.nurseId !== userId) fail('只能申請自己的班', 'FORBIDDEN')
  if (s.date < today()) fail('過去的班不能申請', 'CONFLICT')
  if (db.shiftRequests.some((r) => open(r) && (r.shiftId === shiftId || r.targetShiftId === shiftId))) fail('這一班已經有申請中的換班或請假', 'CONFLICT')
  return s
}

/** 我接下來 30 天的班（申請請假、換班用） */
export function myUpcomingShifts(): Promise<(NurseShift & { text: string })[]> {
  return query(() => {
    const u = requireUser('nurse')
    const t = today()
    return db.nurseShifts.filter((x) => x.nurseId === u.id && x.date >= t && x.date <= addDays(t, 30)).sort((a, b) => a.date.localeCompare(b.date)).map((x) => ({ ...x, text: label(x) }))
  })
}

/** 某一天別人的班（換班的對象） */
export function swapCandidates(myShiftId: string, date: string): Promise<(NurseShift & { text: string; nurseName: string; block?: string; warnings: string[] })[]> {
  return query(() => {
    const u = requireUser('nurse')
    const mine = must(shiftOf(myShiftId), '班')
    if (mine.nurseId !== u.id) fail('只能用自己的班換', 'FORBIDDEN')
    return db.nurseShifts
      .filter((x) => x.date === date && x.nurseId !== u.id && x.date >= today())
      .map((x) => {
        const c = swapCheck(mine, x)
        return { ...x, text: label(x), nurseName: nameOf.user(x.nurseId), ...(c.block ? { block: c.block } : {}), warnings: c.warnings }
      })
      .sort((a, b) => a.ward.localeCompare(b.ward) || a.shift.localeCompare(b.shift))
  })
}

export function requestLeave(input: { shiftId: string; leaveType: string; reason: string }): Promise<ShiftRequestView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = assertMine(input.shiftId, u.id)
    if (!LEAVE_TYPES.includes(input.leaveType)) failField('leaveType', '請選假別')
    if (!input.reason?.trim()) failField('reason', '請寫原因')
    const r: ShiftRequest = { id: newId('SRQ'), kind: 'leave', requesterId: u.id, shiftId: s.id, ward: s.ward, date: s.date, shift: s.shift, leaveType: input.leaveType, reason: input.reason.trim(), status: 'pending', createdAt: now() }
    db.shiftRequests.push(r)
    audit('請假申請', `${u.name} ${label(s)}（${input.leaveType}）`)
    return view(r)
  })
}

export function requestSwap(input: { shiftId: string; targetShiftId: string; reason: string }): Promise<ShiftRequestView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = assertMine(input.shiftId, u.id)
    const b = must(shiftOf(input.targetShiftId), '對方的班')
    if (b.nurseId === u.id) failField('targetShiftId', '請選別人的班')
    if (b.date < today()) fail('對方的班已經過了', 'CONFLICT')
    if (db.shiftRequests.some((r) => open(r) && (r.shiftId === b.id || r.targetShiftId === b.id))) fail('對方這一班已經有申請中的換班或請假', 'CONFLICT')
    const c = swapCheck(a, b)
    if (c.block) failField('targetShiftId', c.block)
    if (!input.reason?.trim()) failField('reason', '請寫原因')
    const r: ShiftRequest = {
      id: newId('SRQ'), kind: 'swap', requesterId: u.id, shiftId: a.id, ward: a.ward, date: a.date, shift: a.shift, reason: input.reason.trim(),
      targetId: b.nurseId, targetShiftId: b.id, target: { ward: b.ward, date: b.date, shift: b.shift }, status: 'pending-peer', createdAt: now(),
    }
    db.shiftRequests.push(r)
    audit('換班申請', `${u.name} ${label(a)} ↔ ${nameOf.user(b.nurseId)} ${label(b)}`)
    return view(r)
  })
}

/** 對方同意或拒絕換班 */
export function respondSwap(id: string, accept: boolean, note = ''): Promise<ShiftRequestView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const r = must(db.shiftRequests.find((x) => x.id === id), '申請')
    if (r.kind !== 'swap' || r.targetId !== u.id) fail('只有被請求換班的人可以回覆', 'FORBIDDEN')
    if (r.status !== 'pending-peer') fail('已經回覆過了', 'CONFLICT')
    if (!accept && !note.trim()) failField('note', '不同意請寫原因')
    Object.assign(r, { peer: { at: now(), accept, ...(note.trim() ? { note: note.trim() } : {}) }, status: accept ? 'pending' : 'declined' })
    audit('換班回覆', `${u.name}：${accept ? '同意' : '不同意'}（${nameOf.user(r.requesterId)} 的申請）`)
    return view(r)
  })
}

/** 護理長核准或退回：核准時再檢查一次（班表可能改過），然後拿掉（請假）或交換（換班） */
export function decideShiftRequest(id: string, approve: boolean, note = ''): Promise<ShiftRequestView> {
  return mutate(() => {
    const u = requirePermission('nursing.schedule')
    const r = must(db.shiftRequests.find((x) => x.id === id), '申請')
    if (r.status !== 'pending') fail(r.status === 'pending-peer' ? '對方還沒同意換班' : '這張申請已經處理過了', 'CONFLICT')
    if (!approve && !note.trim()) failField('note', '退回請寫原因')
    const t = now()
    if (approve) {
      const a = shiftOf(r.shiftId)
      if (!a || a.nurseId !== r.requesterId) fail('班表已經改過（這一班不是申請人的了）：請退回', 'CONFLICT')
      if (r.kind === 'leave') db.nurseShifts = db.nurseShifts.filter((x) => x.id !== a!.id)
      else {
        const b = shiftOf(r.targetShiftId!)
        if (!b || b.nurseId !== r.targetId) fail('班表已經改過（對方那一班不是對方的了）：請退回', 'CONFLICT')
        const c = swapCheck(a!, b!)
        if (c.block) fail(`${c.block}：請退回`, 'CONFLICT')
        const [na, nb] = [a!.nurseId, b!.nurseId]
        a!.nurseId = nb
        b!.nurseId = na
      }
    }
    Object.assign(r, { status: approve ? 'approved' : 'rejected', decidedBy: u.id, decidedAt: t, ...(note.trim() ? { decideNote: note.trim() } : {}) })
    audit(approve ? '核准換班請假' : '退回換班請假', view(r).text)
    return view(r)
  })
}

/** 申請人撤回（處理前） */
export function cancelShiftRequest(id: string): Promise<ShiftRequestView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const r = must(db.shiftRequests.find((x) => x.id === id), '申請')
    if (r.requesterId !== u.id) fail('只能撤回自己的申請', 'FORBIDDEN')
    if (!open(r)) fail('已經處理過了，不能撤回', 'CONFLICT')
    r.status = 'cancelled'
    return view(r)
  })
}

export interface ShiftRequestLists {
  mine: ShiftRequestView[]
  /** 別人請我換班（等我回覆） */
  toRespond: ShiftRequestView[]
  /** 護理長：待核准 */
  toApprove: ShiftRequestView[]
  canApprove: boolean
}

/** 申請清單：我申請的（最近 30 天建立或還沒處理的）、等我回覆的、待核准的（護理長） */
export function listShiftRequests(): Promise<ShiftRequestLists> {
  return query(() => {
    const u = requireUser('nurse', 'admin')
    const canApprove = permissionsOf(u).includes('nursing.schedule')
    const since = addMinutes(now(), -30 * 24 * 60)
    const sort = (xs: ShiftRequest[]) => xs.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(view)
    return {
      mine: sort(db.shiftRequests.filter((r) => r.requesterId === u.id && (open(r) || r.createdAt >= since))),
      toRespond: sort(db.shiftRequests.filter((r) => r.targetId === u.id && r.status === 'pending-peer')),
      toApprove: canApprove ? sort(db.shiftRequests.filter((r) => r.status === 'pending')) : [],
      canApprove,
    }
  })
}
