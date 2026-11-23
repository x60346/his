// 護理站呼叫醫師：護理師記打給誰（預設下班時間找那一科的值班醫師、上班時間找主治）、為什麼、緊急或一般；
// 醫師回覆（電話醫囑或到床邊）由護理師或被呼叫的醫師記。緊急呼叫 15 分鐘沒回覆提醒再找（找主治或上一級）。
// 值班醫師被呼叫、回覆了但沒有幫那位病人寫值班紀錄：首頁提醒（值班結束前補）
import type { DoctorCall, RrtCall } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, must, mutate, query, requireUser, sessionRole } from './http'
import { find, nameOf } from './views'
import { dutyDateOf, isOffHours, onCallFor } from './duty-rules'
import { inIcu } from './icu-work'
import { openRrt, pushManualRrt } from './news-work'
import { callsWithoutNote, CALL_URGENT_MINUTES, dutyNoteAfter, minutesBetween, shiftDateOf } from './doctor-call-work'


export interface DoctorCallView extends DoctorCall {
  toName: string
  calledByName: string
  roleLabel: string
  /** 緊急、超過 15 分鐘沒回覆 */
  overdue: boolean
  /** 等了幾分鐘才回覆（回覆了才有） */
  waitMinutes?: number
  /** 回覆了、還沒寫護理紀錄：帶入護理紀錄（Focus DAR）的草稿；反應（R）要護理師之後觀察再補 */
  noteDraft?: { callId: string; focus: string; data: string; action: string }
  /** 緊急沒回覆可以一鍵改找主治（還沒升級過、找的不是主治本人） */
  canEscalate: boolean
  escalatedToName?: string
  /** 找的是主治也沒回覆：可以改呼叫快速反應小組 */
  canRrt: boolean
  rrtStatus?: RrtCall['status']
}
const view = (c: DoctorCall, t: string): DoctorCallView => ({
  ...c, toName: nameOf.user(c.toUserId), calledByName: nameOf.user(c.calledBy), roleLabel: { oncall: '值班醫師', attending: '主治', other: '醫師' }[c.toRole],
  overdue: c.urgency === 'urgent' && !c.response && !c.escalatedTo && !c.rrtId && minutesBetween(c.calledAt, t) >= CALL_URGENT_MINUTES,
  ...(c.response ? { waitMinutes: minutesBetween(c.calledAt, c.response.at), ...(c.noteId ? {} : { noteDraft: callNoteDraft(c) }) } : {}),
  canEscalate: c.urgency === 'urgent' && !c.response && !c.escalatedTo && !c.rrtId && c.toRole !== 'attending' && minutesBetween(c.calledAt, t) >= CALL_URGENT_MINUTES,
  canRrt: c.urgency === 'urgent' && !c.response && !c.escalatedTo && !c.rrtId && c.toRole === 'attending' && minutesBetween(c.calledAt, t) >= CALL_URGENT_MINUTES,
  ...(c.rrtId ? { rrtStatus: db.rrtCalls.find((r) => r.id === c.rrtId)?.status } : {}),
  ...(c.escalatedTo ? { escalatedToName: nameOf.user(db.doctorCalls.find((x) => x.id === c.escalatedTo)?.toUserId) } : {}),
})
/** 呼叫紀錄 → 護理紀錄草稿：D＝呼叫時間與原因；A＝通知誰、怎麼回覆、醫師處理 */
function callNoteDraft(c: DoctorCall): { callId: string; focus: string; data: string; action: string } {
  const r = c.response!
  const role = { oncall: '值班醫師', attending: '主治', other: '醫師' }[c.toRole]
  return {
    callId: c.id,
    focus: '通知醫師',
    data: `${c.calledAt.slice(11)} ${c.reason}`,
    action: `${c.calledAt.slice(11)} ${c.urgency === 'urgent' ? '緊急' : ''}通知${role} ${nameOf.user(c.toUserId)}；${r.at.slice(11)} ${r.how === 'phone' ? '電話回覆' : '到床邊'}${r.note ? `：${r.note}` : ''}`,
  }
}
const attendingUser = (doctorId: string) => db.users.find((u) => u.doctorId === doctorId && u.active)

/** 這位病人的呼叫紀錄（新到舊）、現在建議找誰 */
export function listDoctorCalls(admissionId: string): Promise<{ calls: DoctorCallView[]; suggest?: { userId: string; name: string; role: DoctorCall['toRole'] }; doctors: { id: string; name: string }[] }> {
  return query(() => {
    requireUser('nurse', 'doctor')
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const oc = onCallFor(db.dutyShifts, a.deptId, t)
    const att = attendingUser(a.doctorId)
    // 值班醫師就是主治本人時算主治（自己的病人不必寫值班紀錄）
    const suggest = oc && oc.userId !== att?.id ? { userId: oc.userId, name: nameOf.user(oc.userId), role: 'oncall' as const } : att ? { userId: att.id, name: att.name, role: 'attending' as const } : undefined
    return {
      calls: db.doctorCalls.filter((c) => c.admissionId === a.id).sort((x, y) => y.calledAt.localeCompare(x.calledAt)).map((c) => view(c, t)),
      ...(suggest ? { suggest } : {}),
      doctors: db.users.filter((u) => u.active && u.doctorId).map((u) => ({ id: u.id, name: `${u.name}（${nameOf.dept(find.doctor(u.doctorId!)?.deptId ?? '')}）` })),
    }
  })
}

/** 記一筆呼叫（護理師）：病人住院中；理由必填 */
export function callDoctor(input: { admissionId: string; toUserId: string; urgency: DoctorCall['urgency']; reason: string }): Promise<DoctorCallView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = must(find.admission(input.admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    const to = db.users.find((x) => x.id === input.toUserId && x.active && x.doctorId)
    if (!to) failField('toUserId', '請選醫師')
    if (input.urgency !== 'urgent' && input.urgency !== 'routine') failField('urgency', '請選緊急或一般')
    if (!input.reason?.trim()) failField('reason', '請寫為什麼找醫師（例：血壓 82/50、意識變差）')
    const t = now()
    const oc = onCallFor(db.dutyShifts, a.deptId, t)
    const toRole: DoctorCall['toRole'] = to!.doctorId === a.doctorId ? 'attending' : oc?.userId === to!.id ? 'oncall' : 'other'
    const c: DoctorCall = { id: newId('DC'), admissionId: a.id, calledAt: t, calledBy: u.id, toUserId: to!.id, toRole, urgency: input.urgency, reason: input.reason.trim() }
    db.doctorCalls.push(c)
    audit('呼叫醫師', `${a.admitNo} ${nameOf.patient(a.patientId)}：${input.urgency === 'urgent' ? '緊急' : '一般'}找 ${to!.name}（${input.reason.trim().slice(0, 30)}）`)
    return view(c, t)
  })
}

/** 醫師回覆（護理師或被呼叫的醫師記）：電話醫囑或到床邊 */
export function respondCall(id: string, input: { how: 'phone' | 'bedside'; note?: string }): Promise<DoctorCallView> {
  return mutate(() => {
    const u = requireUser('nurse', 'doctor')
    const c = must(db.doctorCalls.find((x) => x.id === id), '呼叫紀錄')
    if (c.response) fail('已經記過回覆了', 'CONFLICT')
    if (sessionRole() === 'doctor' && c.toUserId !== u.id) fail('只有被呼叫的醫師（或護理師）能記回覆', 'FORBIDDEN')
    if (input.how !== 'phone' && input.how !== 'bedside') failField('how', '請選電話或到床邊')
    const t = now()
    c.response = { at: t, by: u.id, how: input.how, ...(input.note?.trim() ? { note: input.note.trim() } : {}) }
    audit('醫師回覆呼叫', `${nameOf.patient(find.admission(c.admissionId)?.patientId)}：${nameOf.user(c.toUserId)} ${input.how === 'phone' ? '電話' : '到床邊'}（等 ${minutesBetween(c.calledAt, t)} 分）`)
    return view(c, t)
  })
}

/** 緊急呼叫超過 15 分鐘沒回覆：一鍵改找主治（護理師）。舊的那筆標「已改找」、不再提醒；新的那筆緊急、原因註明升級 */
export function escalateCall(id: string): Promise<DoctorCallView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const c = must(db.doctorCalls.find((x) => x.id === id), '呼叫紀錄')
    const t = now()
    if (c.response) fail('醫師已經回覆了', 'CONFLICT')
    if (c.escalatedTo) fail('已經改找過了', 'CONFLICT')
    if (c.urgency !== 'urgent') fail('一般呼叫不用升級（要緊急請重新記一筆緊急呼叫）', 'CONFLICT')
    const wait = minutesBetween(c.calledAt, t)
    if (wait < CALL_URGENT_MINUTES) fail(`才等 ${wait} 分鐘：緊急呼叫 ${CALL_URGENT_MINUTES} 分鐘沒回覆再改找主治`, 'CONFLICT')
    const a = must(find.admission(c.admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    const att = attendingUser(a.doctorId)
    if (!att) fail('找不到主治的帳號，請直接聯絡科主任', 'CONFLICT')
    if (c.toUserId === att!.id) fail('找的已經是主治：請改呼叫快速反應小組（或聯絡科主任）', 'CONFLICT')
    const n: DoctorCall = { id: newId('DC'), admissionId: a.id, calledAt: t, calledBy: u.id, toUserId: att!.id, toRole: 'attending', urgency: 'urgent', reason: `（升級：${nameOf.user(c.toUserId)} ${wait} 分鐘沒回覆）${c.reason}`, escalatedFrom: c.id }
    db.doctorCalls.push(n)
    c.escalatedTo = n.id
    audit('呼叫醫師升級', `${a.admitNo} ${nameOf.patient(a.patientId)}：${nameOf.user(c.toUserId)} ${wait} 分鐘沒回覆，改找主治 ${att!.name}`)
    return view(n, t)
  })
}

/**
 * 主治也沒回覆（緊急、15 分鐘）：改呼叫快速反應小組（護理師）。原因註明呼叫醫師沒回覆；
 * 已經有一筆在等就接上那一筆（不重複叫）。加護病房的病人不用（找加護病房主治）
 */
export function callRrtFromCall(id: string): Promise<DoctorCallView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const c = must(db.doctorCalls.find((x) => x.id === id), '呼叫紀錄')
    const t = now()
    if (c.response) fail('醫師已經回覆了', 'CONFLICT')
    if (c.escalatedTo || c.rrtId) fail('這筆已經升級過了', 'CONFLICT')
    if (c.urgency !== 'urgent') fail('一般呼叫不用升級', 'CONFLICT')
    if (c.toRole !== 'attending') fail('先改找主治；主治也沒回覆再呼叫快速反應小組', 'CONFLICT')
    const wait = minutesBetween(c.calledAt, t)
    if (wait < CALL_URGENT_MINUTES) fail(`才等 ${wait} 分鐘：主治 ${CALL_URGENT_MINUTES} 分鐘沒回覆再呼叫快速反應小組`, 'CONFLICT')
    const a = must(find.admission(c.admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    if (inIcu(a)) fail('病人在加護病房：直接找加護病房主治', 'CONFLICT')
    const open = openRrt(a.id)
    // 原因用最早那一筆（升級過的那筆原因前面有「升級：…」），一路上找過誰都寫出來
    const chain: DoctorCall[] = [c]
    while (chain[0].escalatedFrom) { const p = db.doctorCalls.find((x) => x.id === chain[0].escalatedFrom); if (!p) break; chain.unshift(p) }
    const who = chain.map((x) => `${nameOf.user(x.toUserId)} ${minutesBetween(x.calledAt, x === c ? t : db.doctorCalls.find((y) => y.id === x.escalatedTo)!.calledAt)} 分`).join('→')
    const r = open ?? pushManualRrt(a.id, `呼叫醫師沒回覆（${who}）：${chain[0].reason}`, u.id, t)
    c.rrtId = r.id
    audit('呼叫醫師升級', `${a.admitNo} ${nameOf.patient(a.patientId)}：主治 ${nameOf.user(c.toUserId)} ${wait} 分鐘沒回覆，${open ? '接上已在等的' : '呼叫'}快速反應小組`)
    return view(c, t)
  })
}

/** 值班醫師：我這一班被呼叫的（病人、床號、回覆了沒、寫值班紀錄了沒）——下班前對一遍 */
export function myShiftCalls(): Promise<{ date: string; calls: (DoctorCallView & { patientName: string; bed: string; noteWritten: boolean })[] }> {
  return query(() => {
    const u = requireUser('doctor')
    const t = now()
    const date = shiftDateOf(t)
    return {
      date,
      calls: db.doctorCalls.filter((c) => c.toUserId === u.id && isOffHours(c.calledAt) && dutyDateOf(c.calledAt) === date).sort((x, y) => x.calledAt.localeCompare(y.calledAt)).map((c) => {
        const a = find.admission(c.admissionId)
        const b = a?.bedId ? find.bed(a.bedId) : undefined
        return { ...view(c, t), patientName: nameOf.patient(a?.patientId), bed: b ? `${b.ward} ${b.bedNo}` : '', noteWritten: dutyNoteAfter(c) }
      }),
    }
  })
}

/** 值班醫師：這一班被呼叫、回覆了，但之後沒有幫那位病人寫值班紀錄的（值班結束前補） */
export function myCallsWithoutNote(): Promise<DoctorCallView[]> {
  return query(() => {
    const u = requireUser('doctor')
    const t = now()
    return callsWithoutNote(u.id, t).map((c) => view(c, t))
  })
}
