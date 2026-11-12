// 住院中心：預約、報到配床、轉床、出院、病床狀態。
// 狀態：reserved →（報到）admitted →（出院）discharged；預約可取消為 cancelled。
// 病床：empty → occupied（報到）→ cleaning（出院或轉出）→ empty（清潔完成）。
import type { Admission, AdmissionStatus, Bed, BedStatus, DeptTransfer } from '@/types'
import { db, nextCounter, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, fieldErrors, must, mutate, query, requireUser } from './http'
import { admissionView, deptTransferView, find, nameOf, openDeptTransfer, patientBrief, type AdmissionView, type DeptTransferView, type PatientBrief } from './views'
import { needsAck } from './nursing-rules'
import { orderView, type OrderView } from './ipd'
import { stopOrderRecord } from './order-ops'

export function listAdmissions(q: { status?: AdmissionStatus[]; ward?: string; patientId?: string } = {}): Promise<AdmissionView[]> {
  return query(() =>
    db.admissions
      .filter(
        (a) =>
          (!q.status || q.status.includes(a.status)) &&
          (!q.patientId || a.patientId === q.patientId) &&
          (!q.ward || (a.bedId && find.bed(a.bedId)?.ward === q.ward)),
      )
      .sort((a, b) => (b.admittedAt ?? b.reservedAt).localeCompare(a.admittedAt ?? a.reservedAt))
      .map(admissionView),
  )
}

export const getAdmission = (id: string): Promise<AdmissionView> => query(() => admissionView(must(find.admission(id), '住院紀錄')))

export interface BedView extends Bed {
  patient?: PatientBrief
  admission?: Admission
  /** 保留給誰（姓名）：床位圖上顯示「保留：楊佩珊」 */
  reservedForName?: string
}

export function listBeds(ward?: string): Promise<BedView[]> {
  return query(() =>
    db.beds
      .filter((b) => !ward || b.ward === ward)
      .map((b) => {
        const adm = b.admissionId ? find.admission(b.admissionId) : undefined
        const forAdm = b.status === 'reserved' && b.reservedFor ? find.admission(b.reservedFor) : undefined
        return { ...b, admission: adm, patient: adm ? patientBrief(adm.patientId) : undefined, reservedForName: forAdm ? nameOf.patient(forAdm.patientId) : undefined }
      }),
  )
}

export type ReserveInput = Pick<Admission, 'patientId' | 'deptId' | 'doctorId' | 'preferBedClass' | 'reason' | 'diagnosis' | 'expectedDate' | 'fromVisitId'>

export function reserve(input: ReserveInput): Promise<Admission> {
  return mutate(() => {
    requireUser('clerk', 'doctor', 'nurse')
    const p = must(find.patient(input.patientId), '病患')
    must(find.doctor(input.doctorId), '主治醫師')
    if (!input.diagnosis.trim()) fail('請輸入入院診斷')
    if (input.expectedDate < today()) fail('預計入院日不可早於今天')
    if (db.admissions.some((a) => a.patientId === p.id && (a.status === 'reserved' || a.status === 'admitted'))) {
      fail(`${p.name} 已有住院預約或正在住院中`, 'CONFLICT')
    }
    const a: Admission = { ...input, id: newId('A'), admitNo: '', status: 'reserved', reservedAt: now() }
    db.admissions.push(a)
    audit('住院預約', `${p.name} ${input.diagnosis}`)
    return a
  })
}

export function cancelReservation(id: string): Promise<Admission> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const a = must(find.admission(id), '住院紀錄')
    if (a.status !== 'reserved') fail('只有預約中的住院可以取消', 'CONFLICT')
    a.status = 'cancelled'
    releaseReservedBeds(a.id)
    audit('取消住院預約', find.patient(a.patientId)?.name ?? '')
    return a
  })
}

function takeBed(bedId: string, admissionId: string): Bed {
  const bed = must(find.bed(bedId), '病床')
  // 保留給這位病人的床可以直接用（保留就是為了這一刻）；保留給別人的不行
  const mine = bed.status === 'reserved' && bed.reservedFor === admissionId
  if (bed.status === 'reserved' && !mine) {
    const forAdm = bed.reservedFor ? find.admission(bed.reservedFor) : undefined
    fail(`${bed.bedNo} 已保留給${forAdm ? ` ${nameOf.patient(forAdm.patientId)}` : '其他病人'}`, 'CONFLICT')
  }
  if (bed.status !== 'empty' && !mine) fail(`${bed.bedNo} 目前無法使用（${bedStatusLabel[bed.status]}）`, 'CONFLICT')
  bed.status = 'occupied'
  bed.admissionId = admissionId
  delete bed.reservedFor
  return bed
}

/** 這筆住院不再需要保留床（預約取消、或報到在別床）：保留的床放回空床，免得一直佔著沒人用 */
function releaseReservedBeds(admissionId: string): void {
  for (const b of db.beds.filter((x) => x.status === 'reserved' && x.reservedFor === admissionId)) {
    b.status = 'empty'
    delete b.reservedFor
    audit('取消保留床位', `${b.bedNo}（${nameOf.patient(find.admission(admissionId)?.patientId)}）`)
  }
}

function releaseBed(bedId?: string): void {
  if (!bedId) return
  const bed = find.bed(bedId)
  if (!bed) return
  bed.status = 'cleaning'
  bed.admissionId = undefined
}

export const bedStatusLabel: Record<BedStatus, string> = { empty: '空床', occupied: '使用中', reserved: '保留', cleaning: '清潔中' }

/** 報到：配床、產生住院號 */
export function checkIn(admissionId: string, bedId: string): Promise<AdmissionView> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'reserved') fail('此住院紀錄不是預約狀態', 'CONFLICT')
    const bed = takeBed(bedId, a.id)
    releaseReservedBeds(a.id) // 有保留床卻報到在別床：保留的那床放回空床
    const t = now()
    a.status = 'admitted'
    a.bedId = bed.id
    a.admittedAt = t
    a.admitNo = `I${t.slice(2, 10).replace(/-/g, '')}${String(nextCounter('admitNo')).padStart(3, '0')}`
    audit('住院報到', `${a.admitNo} ${find.patient(a.patientId)?.name} → ${bed.bedNo}`)
    return admissionView(a)
  })
}

export function transferBed(admissionId: string, bedId: string): Promise<AdmissionView> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('只有住院中的病人可以轉床')
    if (a.bedId === bedId) fail('與目前床位相同')
    const from = find.bed(a.bedId ?? '')?.bedNo
    releaseBed(a.bedId)
    const bed = takeBed(bedId, a.id)
    a.bedId = bed.id
    audit('轉床', `${a.admitNo} ${from} → ${bed.bedNo}`)
    return admissionView(a)
  })
}

/**
 * 跨科不是「變更主治」，是轉科：要說清楚去哪裡辦（以前寫「跨科請辦理轉科」卻沒有轉科功能，使用者會到處找按鈕）。
 * 對話框提示與服務層錯誤共用這一句。
 */
export const NO_TRANSFER_NOTE = '跨科請由主治醫師在「住院醫囑」申請轉科，新科醫師接受後生效'

/** 可以接手的主治醫師：同一科、在職、不是目前的主治（跨科是「轉科」，牽涉科別與床位，不在此處理） */
function attendingCandidates(a: Admission) {
  return db.doctors.filter((d) => d.active && d.deptId === a.deptId && d.id !== a.doctorId)
}

export function listAttendingCandidates(admissionId: string): Promise<{ id: string; name: string; title: string }[]> {
  return query(() => attendingCandidates(must(find.admission(admissionId), '住院紀錄')).map((d) => ({ id: d.id, name: d.name, title: d.title })))
}

/**
 * 變更主治醫師：住院中或預約住院的病人改由同科另一位醫師負責（醫師離職、休假、交班）。
 * 由住院中心（掛號批價、護理師）或醫師執行；管理員不執行臨床操作——停用醫師前，請住院中心先變更。
 * 變更紀錄只增不改（attendingHistory）；已開立的醫囑、病程紀錄不改，它們記的是當時的開立者。
 */
export function changeAttending(admissionId: string, doctorId: string, reason: string): Promise<AdmissionView> {
  return mutate(() => {
    const u = requireUser('clerk', 'nurse', 'doctor')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted' && a.status !== 'reserved') fail('只有住院中或預約住院的病人可以變更主治醫師', 'CONFLICT')
    if (openDeptTransfer(a)) fail(`轉科申請中（轉${nameOf.dept(openDeptTransfer(a)!.toDeptId)}），新科接受後由新科醫師擔任主治；要改由原科其他醫師負責請先撤回申請`, 'CONFLICT')
    const to = find.doctor(doctorId)
    const v = fieldErrors()
    if (!to) v.add('doctorId', '請選擇新的主治醫師')
    if (!reason?.trim()) v.add('reason', '請填寫變更原因')
    v.done()
    if (to!.id === a.doctorId) failField('doctorId', '與目前的主治醫師相同')
    if (!to!.active) failField('doctorId', `${to!.name} 已停用`)
    if (to!.deptId !== a.deptId) failField('doctorId', `${to!.name} 不是${find.dept(a.deptId)?.name ?? '同一科'}的醫師；${NO_TRANSFER_NOTE}`)
    const from = a.doctorId
    a.attendingHistory = [...(a.attendingHistory ?? []), { from, to: to!.id, at: now(), by: u.id, reason: reason.trim() }]
    a.doctorId = to!.id
    audit('變更主治醫師', `${a.admitNo || '（預約）'} ${find.patient(a.patientId)?.name}：${find.doctor(from)?.name} → ${to!.name}（${reason.trim()}）`)
    return admissionView(a)
  })
}

/** 出院：停止所有醫囑、刪除未執行的給藥排程、病床改為清潔中 */
/**
 * 出院前檢查：還有哪些沒做完。出院對話框先列出來，辦理的人知道自己在結束什麼。
 * 以前只有一句「醫囑停止、排程刪除」，逾時沒給的藥也一起刪掉，紀錄上就像從來沒排過。
 */
export interface DischargeCheck {
  /** 已過預定時間、還沒給的藥（出院時標為「暫停：出院時未給藥」，不刪除） */
  overdueMar: { scheduledAt: string; content: string }[]
  /** 還沒執行的臨時醫囑（檢驗、處置） */
  pendingStat: { content: string; startAt: string }[]
  /** 醫囑異動還沒有護理師核對 */
  unacked: number
  /** 執行中的長期醫囑（出院時停止） */
  activeLong: number
  /** 還沒到時間的給藥排程（出院時取消） */
  laterMar: number
}

function dischargeCheckOf(a: Admission, t: string): DischargeCheck {
  const orders = db.ipdOrders.filter((o) => o.admissionId === a.id)
  const pending = db.mar.filter((m) => m.admissionId === a.id && m.status === 'pending')
  const content = (orderId: string) => orders.find((o) => o.id === orderId)?.content ?? ''
  return {
    overdueMar: pending.filter((m) => m.scheduledAt < t).sort((x, y) => x.scheduledAt.localeCompare(y.scheduledAt)).map((m) => ({ scheduledAt: m.scheduledAt, content: content(m.orderId) })),
    pendingStat: orders.filter((o) => o.type === 'stat' && o.status === 'active' && o.category !== 'medication').map((o) => ({ content: o.content, startAt: o.startAt })),
    unacked: orders.filter(needsAck).length,
    activeLong: orders.filter((o) => o.type === 'long' && o.status === 'active').length,
    laterMar: pending.filter((m) => m.scheduledAt >= t).length,
  }
}

export function dischargeCheck(admissionId: string): Promise<DischargeCheck> {
  return query(() => {
    const a = must(find.admission(admissionId), '住院紀錄')
    return dischargeCheckOf(a, now())
  })
}

/**
 * 辦理出院。有逾時沒給的藥、沒執行的臨時醫囑時，必須確認（confirmUnfinished）才能出院——直接呼叫 API 也一樣。
 * 逾時沒給的藥改為「暫停：出院時未給藥」保留在紀錄上；還沒到時間的排程才刪除（那只是排程，不是紀錄）。
 */
export function discharge(admissionId: string, input: { confirmUnfinished?: boolean } = {}): Promise<AdmissionView> {
  return mutate(() => {
    // 醫師決定能不能出院（簽署出院病摘）；住院中心、護理師辦理手續
    const u = requireUser('nurse', 'clerk')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('只有住院中的病人可以辦理出院', 'CONFLICT')
    const ds = a.dischargeSummary
    if (!ds?.signedAt) fail('醫師尚未准予出院：出院病摘需由醫師簽署後才能辦理', 'CONFLICT')
    if (openDeptTransfer(a)) fail('轉科申請中，不能辦理出院（請醫師先撤回轉科申請）', 'CONFLICT')
    const t = now()
    const check = dischargeCheckOf(a, t)
    const unfinished = check.overdueMar.length + check.pendingStat.length
    if (unfinished && !input.confirmUnfinished) {
      fail(`還有 ${check.overdueMar.length} 筆逾時未給藥、${check.pendingStat.length} 筆未執行的臨時醫囑，請確認後再辦理出院`, 'CONFLICT', 'confirmUnfinished')
    }
    for (const o of db.ipdOrders.filter((o) => o.admissionId === a.id && o.status === 'active')) {
      o.status = 'stopped'
      o.stopAt = t
    }
    // 逾時沒給的：保留紀錄，標為暫停並寫明原因；還沒到時間的：只是排程，取消即可
    for (const m of db.mar.filter((m) => m.admissionId === a.id && m.status === 'pending' && m.scheduledAt < t)) {
      Object.assign(m, { status: 'held', note: '出院時未給藥', executedAt: t, nurseId: u.id })
    }
    db.mar = db.mar.filter((m) => !(m.admissionId === a.id && m.status === 'pending'))
    releaseBed(a.bedId)
    Object.assign(a, { status: 'discharged', dischargedAt: t, dischargeType: ds!.dischargeType })
    audit('出院', `${a.admitNo} ${find.patient(a.patientId)?.name}（${ds!.dischargeType}）${unfinished ? `；未執行：逾時給藥 ${check.overdueMar.length}、臨時醫囑 ${check.pendingStat.length}` : ''}`)
    return admissionView(a)
  })
}

/**
 * 變更病床狀態（清潔完成、保留、取消保留）。
 * 保留一定要指定給哪一筆住院預約（reservedFor）——沒指定對象的保留沒有意義，報到時也不知道該給誰用。
 */
export function setBedStatus(bedId: string, status: Exclude<BedStatus, 'occupied'>, reservedFor?: string): Promise<Bed> {
  return mutate(() => {
    requireUser('clerk', 'nurse')
    const bed = must(find.bed(bedId), '病床')
    if (bed.status === 'occupied') fail('使用中的病床不可直接變更狀態', 'CONFLICT')
    if (status === 'reserved') {
      if (bed.status !== 'empty') fail(`只有空床可以保留（${bed.bedNo} 目前${bedStatusLabel[bed.status]}）`, 'CONFLICT')
      if (!reservedFor) failField('reservedFor', '請選擇要保留給哪一位待報到的病人')
      const a = must(find.admission(reservedFor!), '住院預約')
      if (a.status !== 'reserved') fail('只能保留給待報到的病人', 'CONFLICT')
      bed.reservedFor = a.id
      audit('保留床位', `${bed.bedNo} → ${nameOf.patient(a.patientId)}`)
    } else {
      if (bed.status === 'reserved') audit('取消保留床位', bed.bedNo)
      delete bed.reservedFor
    }
    bed.status = status
    return bed
  })
}

// ---------- 轉科 ----------
// 原科主治申請 → 新科醫師接受（成為主治，逐筆決定醫囑延續或停止，可一併轉床）或婉拒；原科可撤回。
// 申請期間病人仍歸原科（醫囑照常由原科開、停），所以接受時要對「接受那一刻畫面上看到的醫囑」做決定。

function admittedForTransfer(admissionId: string): Admission {
  const a = must(find.admission(admissionId), '住院紀錄')
  if (a.status !== 'admitted') fail('只有住院中的病人可以轉科', 'CONFLICT')
  return a
}

/** 原科（主治或同科醫師）才能申請、撤回 */
function requireFromDept(a: Admission) {
  const u = requireUser('doctor')
  const me = find.doctor(u.doctorId ?? '')
  if (!me || me.deptId !== a.deptId) fail(`只有${nameOf.dept(a.deptId)}的醫師可以申請或撤回這位病人的轉科`, 'FORBIDDEN')
  return { u, me: me! }
}

/** 新科醫師（有指定接手醫師時只有他）才能接受、婉拒 */
function requireReceiver(x: DeptTransfer) {
  const u = requireUser('doctor')
  const me = find.doctor(u.doctorId ?? '')
  if (!me || me.deptId !== x.toDeptId) fail(`只有${nameOf.dept(x.toDeptId)}的醫師可以接受或婉拒這筆轉科`, 'FORBIDDEN')
  if (x.toDoctorId && x.toDoctorId !== me!.id) fail(`這筆轉科指定由 ${nameOf.doctor(x.toDoctorId)} 接手`, 'FORBIDDEN')
  return { u, me: me! }
}

/** 申請轉科：目標科別、可指定接手醫師、原因 */
export function requestDeptTransfer(admissionId: string, input: { toDeptId: string; toDoctorId?: string; reason: string }): Promise<AdmissionView> {
  return mutate(() => {
    const a = admittedForTransfer(admissionId)
    const { u } = requireFromDept(a)
    if (openDeptTransfer(a)) fail('已有一筆轉科申請還沒處理', 'CONFLICT')
    if (a.dischargeSummary?.signedAt) fail('已准予出院，不能申請轉科（要轉科請先取消准予出院）', 'CONFLICT')
    const v = fieldErrors()
    const dept = find.dept(input.toDeptId ?? '')
    if (!dept || !dept.active) v.add('toDeptId', '請選擇要轉入的科別')
    else if (dept.id === a.deptId) v.add('toDeptId', '與目前科別相同；同科換醫師請用「變更主治醫師」')
    else if (!db.doctors.some((d) => d.active && d.deptId === dept.id)) v.add('toDeptId', `${dept.name}目前沒有在職醫師可以接手`)
    if (input.toDoctorId) {
      const d = find.doctor(input.toDoctorId)
      if (!d || !d.active || d.deptId !== input.toDeptId) v.add('toDoctorId', '指定的醫師不是該科在職醫師')
    }
    if (!input.reason?.trim()) v.add('reason', '請填寫轉科原因')
    v.done()
    const x: DeptTransfer = {
      id: newId('DT'), fromDeptId: a.deptId, fromDoctorId: a.doctorId, toDeptId: dept!.id,
      ...(input.toDoctorId ? { toDoctorId: input.toDoctorId } : {}),
      reason: input.reason.trim(), requestedBy: u.id, requestedAt: now(), status: 'pending',
    }
    a.deptTransfers = [...(a.deptTransfers ?? []), x]
    audit('申請轉科', `${a.admitNo} ${nameOf.patient(a.patientId)}：${nameOf.dept(a.deptId)} → ${dept!.name}${x.toDoctorId ? `（指定 ${nameOf.doctor(x.toDoctorId)}）` : ''}：${x.reason}`)
    return admissionView(a)
  })
}

/** 撤回轉科申請（原科） */
export function cancelDeptTransfer(admissionId: string, note = ''): Promise<AdmissionView> {
  return mutate(() => {
    const a = admittedForTransfer(admissionId)
    const { u } = requireFromDept(a)
    const x = openDeptTransfer(a)
    if (!x) fail('沒有申請中的轉科', 'CONFLICT')
    Object.assign(x!, { status: 'cancelled', decidedBy: u.id, decidedAt: now(), ...(note.trim() ? { decisionNote: note.trim() } : {}) })
    audit('撤回轉科', `${a.admitNo} ${nameOf.patient(a.patientId)}：轉${nameOf.dept(x!.toDeptId)}`)
    return admissionView(a)
  })
}

/** 婉拒轉科（新科，要寫原因）：病人留在原科，原科醫師在病人清單看得到 */
export function declineDeptTransfer(admissionId: string, reason: string): Promise<AdmissionView> {
  return mutate(() => {
    const a = admittedForTransfer(admissionId)
    const x = openDeptTransfer(a)
    if (!x) fail('沒有申請中的轉科', 'CONFLICT')
    const { u } = requireReceiver(x!)
    if (!reason?.trim()) failField('reason', '請填寫婉拒原因（原科醫師會看到）')
    Object.assign(x!, { status: 'declined', decidedBy: u.id, decidedAt: now(), decisionNote: reason.trim() })
    audit('婉拒轉科', `${a.admitNo} ${nameOf.patient(a.patientId)}：${reason.trim()}`)
    return admissionView(a)
  })
}

export interface IncomingTransfer {
  admission: AdmissionView
  transfer: DeptTransferView
  /** 執行中的長期醫囑：新主治逐筆決定延續或停止 */
  orders: OrderView[]
}

/** 轉入我科、等我接的轉科申請（醫師的「住院醫囑」與首頁待辦）；帶著執行中的長期醫囑，接受時對同一份做決定 */
export function listIncomingTransfers(): Promise<IncomingTransfer[]> {
  return query(() => {
    const u = requireUser('doctor')
    const me = find.doctor(u.doctorId ?? '')
    if (!me) return []
    return db.admissions
      .filter((a) => a.status === 'admitted')
      .map((a) => ({ a, x: openDeptTransfer(a) }))
      .filter(({ x }) => x && x.toDeptId === me.deptId && (!x.toDoctorId || x.toDoctorId === me.id))
      .sort((p, q) => p.x!.requestedAt.localeCompare(q.x!.requestedAt))
      .map(({ a, x }) => ({
        admission: admissionView(a),
        transfer: deptTransferView(x!),
        orders: db.ipdOrders.filter((o) => o.admissionId === a.id && o.type === 'long' && o.status === 'active').map(orderView),
      }))
  })
}

/**
 * 接受轉科：我成為主治、科別改為我科；stopOrderIds 的醫囑停止（其餘延續，仍記原開立者）；bedId 有給就一併轉床。
 * shownOrderIds＝接受畫面上列出的執行中長期醫囑：原科在這之後又開的，新主治沒看過，不能默默延續——要重新整理再接受。
 */
export function acceptDeptTransfer(admissionId: string, input: { shownOrderIds: string[]; stopOrderIds: string[]; bedId?: string }): Promise<AdmissionView> {
  return mutate(() => {
    const a = admittedForTransfer(admissionId)
    const x = openDeptTransfer(a)
    if (!x) fail('沒有申請中的轉科（可能已被撤回）', 'CONFLICT')
    const { u, me } = requireReceiver(x!)
    const active = db.ipdOrders.filter((o) => o.admissionId === a.id && o.type === 'long' && o.status === 'active')
    const shown = new Set(input.shownOrderIds ?? [])
    const unseen = active.filter((o) => !shown.has(o.id))
    if (unseen.length) fail(`原科剛又開了 ${unseen.length} 筆醫囑（${unseen.map((o) => o.content).join('、')}），請重新整理後再決定`, 'CONFLICT')
    const stops = [...new Set(input.stopOrderIds ?? [])].map((id) => {
      const o = active.find((y) => y.id === id)
      if (!o) fail('要停止的醫囑不是這位病人執行中的長期醫囑（可能已被停止）', 'CONFLICT')
      return o!
    })
    const t = now()
    for (const o of stops) stopOrderRecord(o, u.id, t)
    let bedNote = ''
    if (input.bedId && input.bedId !== a.bedId) {
      const fromBed = a.bedId
      const from = find.bed(fromBed ?? '')?.bedNo
      releaseBed(fromBed)
      const bed = takeBed(input.bedId, a.id)
      a.bedId = bed.id
      Object.assign(x!, { fromBedId: fromBed, toBedId: bed.id })
      bedNote = `；轉床 ${from} → ${bed.bedNo}`
    }
    const reason = `轉科：${nameOf.dept(a.deptId)} → ${nameOf.dept(me.deptId)}（${x!.reason}）`
    a.attendingHistory = [...(a.attendingHistory ?? []), { from: a.doctorId, to: me.id, at: t, by: u.id, reason }]
    Object.assign(x!, { status: 'accepted', decidedBy: u.id, decidedAt: t, acceptedDoctorId: me.id, stoppedOrderIds: stops.map((o) => o.id) })
    a.deptId = me.deptId
    a.doctorId = me.id
    audit('接受轉科', `${a.admitNo} ${nameOf.patient(a.patientId)}：${reason}；醫囑延續 ${active.length - stops.length}、停止 ${stops.length}${bedNote}`)
    return admissionView(a)
  })
}
