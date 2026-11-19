// 門診抽血櫃台（醫檢師）：批價後的門診病人來報到取號 → 列出已批價、還沒採檢的檢驗 → 印條碼（同管合併；尿液、痰液是發容器給病人自行收集）
// → 採檢（容器是病人交回）→ 檢驗科「待收件」收件後才能登打。被退件的回到待重新採檢（櫃台請病人回來）。規則在 specimen-rules。
// 叫號：報到後等候，櫃台「叫下一位」叫到號才能印條碼採檢；叫了沒來可重叫（最多 3 次）或過號，過號回來插在目前叫號的下兩位之後。規則在 lab-queue-rules
import type { LabCheckin, Specimen } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, must, mutate, query, requireUser } from './http'
import { fastingText, groupByTube, SELF_COLLECT_TUBES, specimenStage, SPECIMEN_STAGE_LABEL, TUBE_LABEL } from './specimen-rules'
import { chunksByVolume, needsFasting, nextBarcode, opdSpecimenOf, recordFasting } from './specimen-work'
import { pendingLabWork } from './lab-work'
import { find, nameOf } from './views'
import { ageOf } from '@/utils/date'
import { callOrder, maskName, pickNext, priorityOf, QUEUE_PRIORITY_AGE, QUEUE_PRIORITY_LABEL } from './lab-queue-rules'
import { avgWait, callsSinceReturn, queueOrder, queueStage, returnOrder, waitingList, QUEUE_MAX_CALLS, QUEUE_STAGE_LABEL, type QueueStage } from './lab-queue-rules'

/** 這位病人還沒採檢的門診檢驗（沒有檢體、或檢體被退件的） */
const toCollect = (patientId: string) => pendingLabWork().filter((w) => w.source === 'opd' && !w.er && w.patientId === patientId && !opdSpecimenOf(w.key))
const tubeOf = (procId: string) => find.procedure(procId)?.tube ?? 'red'
const todayOf = () => now().slice(0, 10)

export interface DeskSpecimen {
  id: string
  barcode: string
  tube: string
  tubeLabel: string
  tests: string[]
  selfCollect: boolean
  stage: string
  stageLabel: string
  rejectedReason?: string
  needsFasting: boolean
  fastingLabel?: string
}
const spView = (s: Specimen): DeskSpecimen => {
  const st = specimenStage(s)
  return {
    id: s.id, barcode: s.barcode, tube: s.tube, tubeLabel: TUBE_LABEL[s.tube], tests: (s.opdKeys ?? []).map((k) => find.procedure(k.split(':')[2])?.name ?? k), selfCollect: !!s.selfCollect, stage: st,
    stageLabel: s.selfCollect && st === 'printed' ? '容器已發、待交回' : s.selfCollect && st === 'collected' ? '已交回、待收件' : SPECIMEN_STAGE_LABEL[st], ...(s.rejected ? { rejectedReason: s.rejected.reason } : {}),
    needsFasting: needsFasting(s), ...(s.fasting ? { fastingLabel: fastingText(s.fasting) } : {}),
  }
}

export interface DeskPatient {
  patientId: string
  patientName: string
  chartNo: string
  checkin?: LabCheckin
  /** 還沒印條碼的檢驗（依容器合併） */
  toPrint: { tube: string; tubeLabel: string; selfCollect: boolean; tests: string[] }[]
  /** 今天這位病人的門診檢體 */
  specimens: DeskSpecimen[]
  /** 有被退件、要請病人回來重新採檢 */
  recollect: boolean
  /** 叫號到哪一步（沒報到的沒有） */
  queue?: QueueStage
  queueLabel?: string
  /** 報到時會自動優先（75 歲以上） */
  autoPriority: boolean
  priorityLabel?: string
}

/** 叫號看板：目前叫到的號、等候中（依順序）、過號的、今天平均等候分鐘 */
export interface DeskQueue {
  current?: { no: number; patientId: string; patientName: string; calls: number; calledAt: string }
  /** 依接下來的叫號順序（優先排在一般前面，但連續兩位優先後輪一位一般） */
  waiting: { no: number; patientId: string; patientName: string; at: string; returned: boolean; priorityLabel?: string }[]
  /** 目前連續叫了幾位優先 */
  streak: number
  skipped: { no: number; patientId: string; patientName: string; skippedAt: string }[]
  avgWait?: number
  maxCalls: number
}

function deskPatient(patientId: string, d: string): DeskPatient {
  const p = find.patient(patientId)
  const items = toCollect(patientId)
  const specimens = db.specimens.filter((s) => !s.admissionId && s.patientId === patientId && s.createdAt.slice(0, 10) === d)
  return {
    patientId, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', ...((c) => (c ? { checkin: c } : {}))(db.labCheckins.find((c) => c.patientId === patientId && c.date === d)),
    toPrint: groupByTube(items.map((w) => ({ tube: tubeOf(w.procId), w }))).map((g) => ({ tube: g.tube, tubeLabel: TUBE_LABEL[g.tube], selfCollect: SELF_COLLECT_TUBES.includes(g.tube), tests: g.items.map((x) => x.w.procName) })),
    specimens: specimens.map(spView),
    recollect: specimens.some((s) => s.rejected) && items.length > 0,
    ...((c) => (c ? { queue: queueStage(c), queueLabel: QUEUE_STAGE_LABEL[queueStage(c)], ...(c.priority ? { priorityLabel: QUEUE_PRIORITY_LABEL[c.priority] } : {}) } : {}))(db.labCheckins.find((c) => c.patientId === patientId && c.date === d)),
    autoPriority: !!p && ageOf(p.birthDate, d) >= QUEUE_PRIORITY_AGE,
  }
}

const todays = () => db.labCheckins.filter((c) => c.date === todayOf())
/** 今天目前連續叫了幾位優先（叫一般就歸零） */
const streakKey = () => `labqueue-streak:${todayOf()}`
const streakNow = () => db.counters[streakKey()] ?? 0
function deskQueue(): DeskQueue {
  const cs = todays()
  const cur = cs.filter((c) => queueStage(c) === 'called').sort((a, b) => a.calls!.at(-1)!.localeCompare(b.calls!.at(-1)!)).at(-1)
  return {
    ...(cur ? { current: { no: cur.no, patientId: cur.patientId, patientName: nameOf.patient(cur.patientId), calls: callsSinceReturn(cur), calledAt: cur.calls!.at(-1)! } } : {}),
    waiting: callOrder(waitingList(cs), streakNow()).map((c) => ({ no: c.no, patientId: c.patientId, patientName: nameOf.patient(c.patientId), at: c.returnedAt ?? c.at, returned: !!c.returnedAt, ...(c.priority ? { priorityLabel: QUEUE_PRIORITY_LABEL[c.priority] } : {}) })),
    streak: streakNow(),
    skipped: cs.filter((c) => queueStage(c) === 'skipped').sort((a, b) => a.no - b.no).map((c) => ({ no: c.no, patientId: c.patientId, patientName: nameOf.patient(c.patientId), skippedAt: c.skippedAt! })),
    ...((m) => (m !== undefined ? { avgWait: m } : {}))(avgWait(cs)),
    maxCalls: QUEUE_MAX_CALLS,
  }
}
const checkinOf = (patientId: string) => must(todays().find((c) => c.patientId === patientId), '今天的報到（請先報到取號）')

/** 抽血櫃台：今天報到的（依號碼）＋已批價還沒報到的＋叫號看板 */
export function labDesk(): Promise<{ date: string; checkedIn: DeskPatient[]; notCheckedIn: DeskPatient[]; queue: DeskQueue }> {
  return query(() => {
    requireUser('lab')
    const d = todayOf()
    const checkedIn = db.labCheckins.filter((c) => c.date === d).sort((a, b) => a.no - b.no).map((c) => deskPatient(c.patientId, d))
    const waitingIds = [...new Set(pendingLabWork().filter((w) => w.source === 'opd' && !w.er && !opdSpecimenOf(w.key)).map((w) => w.patientId))].filter((id) => !checkedIn.some((x) => x.patientId === id))
    return { date: d, checkedIn, notCheckedIn: waitingIds.map((id) => deskPatient(id, d)), queue: deskQueue() }
  })
}

/** 叫下一位：目前叫到的還沒處理（開始採檢或過號）不能叫下一位；等候中依順序叫第一位 */
export function callNextLab(): Promise<LabCheckin> {
  return mutate(() => {
    requireUser('lab')
    const cs = todays()
    const cur = cs.find((c) => queueStage(c) === 'called')
    if (cur) fail(`目前叫到的 ${cur.no} 號（${nameOf.patient(cur.patientId)}）還沒處理：開始採檢、重叫或過號`, 'CONFLICT')
    const next = pickNext(waitingList(cs), streakNow())
    if (!next) fail('沒有等候中的病人', 'CONFLICT')
    ;(next!.calls ??= []).push(now())
    db.counters[streakKey()] = next!.priority ? streakNow() + 1 : 0
    audit('抽血叫號', `${next!.no} 號 ${nameOf.patient(next!.patientId)}${next!.priority ? `（優先：${QUEUE_PRIORITY_LABEL[next!.priority]}）` : ''}`)
    return next!
  })
}

/** 重叫（病人還沒來）：同一號最多叫 3 次，之後請過號 */
export function recallLab(patientId: string): Promise<LabCheckin> {
  return mutate(() => {
    requireUser('lab')
    const c = checkinOf(patientId)
    if (queueStage(c) !== 'called') fail('這位病人現在沒有在叫號', 'CONFLICT')
    const n = callsSinceReturn(c)
    if (n >= QUEUE_MAX_CALLS) fail(`已經叫了 ${QUEUE_MAX_CALLS} 次，請過號`, 'CONFLICT')
    c.calls!.push(now())
    audit('抽血叫號', `${c.no} 號 ${nameOf.patient(c.patientId)}（第 ${n + 1} 次）`)
    return c
  })
}

/** 過號：叫了沒來（叫號中的才能過號）；病人回來再按「回來了」重新排隊 */
export function skipLab(patientId: string): Promise<LabCheckin> {
  return mutate(() => {
    requireUser('lab')
    const c = checkinOf(patientId)
    if (queueStage(c) !== 'called') fail('叫號中的病人才能過號', 'CONFLICT')
    c.skippedAt = now()
    delete c.returnedAt
    delete c.callsAtReturn
    audit('抽血過號', `${c.no} 號 ${nameOf.patient(c.patientId)}（叫了 ${c.calls!.length} 次沒來）`)
    return c
  })
}

/** 過號的病人回來了：插在目前叫號的下兩位之後（等候不到兩位就排最後） */
export function returnLab(patientId: string): Promise<LabCheckin> {
  return mutate(() => {
    requireUser('lab')
    const c = checkinOf(patientId)
    if (queueStage(c) !== 'skipped') fail('這位病人沒有過號', 'CONFLICT')
    const cs = todays()
    c.order = returnOrder(waitingList(cs), cs)
    c.returnedAt = now()
    c.callsAtReturn = c.calls?.length ?? 0
    const ahead = waitingList(cs).filter((x) => queueOrder(x) < c.order!).length
    audit('抽血過號回來', `${c.no} 號 ${nameOf.patient(c.patientId)}：前面還有 ${ahead} 位`)
    return c
  })
}

/** 報到取號（今天已報到的回傳原本的號碼）：要有已批價、還沒採檢的檢驗。75 歲以上自動優先；身心障礙、行動不便由櫃台勾 */
export function checkInLab(patientId: string, opts: { priority?: 'disabled' | 'mobility' } = {}): Promise<LabCheckin> {
  return mutate(() => {
    const u = requireUser('lab')
    const d = todayOf()
    const old = db.labCheckins.find((c) => c.patientId === patientId && c.date === d)
    if (old) return old
    if (!toCollect(patientId).length) fail('這位病人沒有已批價、待採檢的門診檢驗（還沒批價請先到批價櫃台）', 'CONFLICT')
    const no = (db.counters[`labdesk:${d}`] = (db.counters[`labdesk:${d}`] ?? 0) + 1)
    const p = must(find.patient(patientId), '病患')
    const pr = priorityOf(ageOf(p.birthDate, d), opts.priority)
    const c: LabCheckin = { id: newId('LC'), no, patientId, date: d, at: now(), by: u.id, ...(pr ? { priority: pr } : {}) }
    db.labCheckins.push(c)
    audit('抽血櫃台報到', `${nameOf.patient(patientId)}：${no} 號${pr ? `（優先：${QUEUE_PRIORITY_LABEL[pr]}）` : ''}`)
    return c
  })
}

/** 報到後改優先（例：櫃台看到病人坐輪椅）：開始採檢前都能改；75 歲以上的不能取消 */
export function setLabPriority(patientId: string, priority: 'disabled' | 'mobility' | null): Promise<LabCheckin> {
  return mutate(() => {
    requireUser('lab')
    const c = checkinOf(patientId)
    if (queueStage(c) === 'served') fail('已經開始採檢了', 'CONFLICT')
    if (c.priority === 'elderly') fail(`${QUEUE_PRIORITY_AGE} 歲以上自動優先，不能取消`, 'CONFLICT')
    if (priority !== null && priority !== 'disabled' && priority !== 'mobility') fail('優先只有身心障礙、行動不便', 'BAD_REQUEST')
    if (priority) c.priority = priority
    else delete c.priority
    audit('抽血櫃台優先', `${c.no} 號 ${nameOf.patient(c.patientId)}：${priority ? QUEUE_PRIORITY_LABEL[priority] : '取消優先'}`)
    return c
  })
}

/** 候診螢幕（不用登入，公開在候診區）：只給號碼與遮過的姓名——目前叫號、接下來五位、等候人數、今天平均等候 */
export interface QueueDisplay {
  date: string
  current?: { no: number; name: string }
  next: { no: number; name: string; priority: boolean }[]
  waitingCount: number
  avgWait?: number
}
export function labQueueDisplay(): Promise<QueueDisplay> {
  return query(() => {
    const cs = todays()
    const cur = cs.filter((c) => queueStage(c) === 'called').sort((a, b) => a.calls!.at(-1)!.localeCompare(b.calls!.at(-1)!)).at(-1)
    const order = callOrder(waitingList(cs), streakNow())
    return {
      date: todayOf(),
      ...(cur ? { current: { no: cur.no, name: maskName(nameOf.patient(cur.patientId)) } } : {}),
      next: order.slice(0, 5).map((c) => ({ no: c.no, name: maskName(nameOf.patient(c.patientId)), priority: !!c.priority })),
      waitingCount: order.length,
      ...((m) => (m !== undefined ? { avgWait: m } : {}))(avgWait(cs)),
    }
  }, { public: true })
}

/** 印條碼：還沒採檢的檢驗依容器合併成檢體（尿液、痰液是發容器）；要先報到 */
export function printDeskLabels(patientId: string): Promise<DeskSpecimen[]> {
  return mutate(() => {
    const u = requireUser('lab')
    const d = todayOf()
    const ck = db.labCheckins.find((c) => c.patientId === patientId && c.date === d)
    if (!ck) fail('請先報到取號', 'CONFLICT')
    const st = queueStage(ck!)
    if (st === 'waiting' || st === 'skipped') fail(st === 'skipped' ? `${ck!.no} 號已過號：病人回來請先按「回來了」重新排隊` : `還沒叫到 ${ck!.no} 號：請依號碼叫號，叫到才能採檢`, 'CONFLICT')
    const items = toCollect(patientId)
    if (!items.length) fail('沒有要採檢的檢驗', 'CONFLICT')
    const t = now()
    // 同管別合併；量超過一支管的容量就拆成兩支
    const out: Specimen[] = groupByTube(items.map((w) => ({ tube: tubeOf(w.procId), w }))).flatMap((g) => chunksByVolume(g.tube, g.items, (x) => x.w.procId).map((c) => ({
      id: newId('SP'), barcode: nextBarcode(t), patientId, tube: g.tube, orderIds: [], opdKeys: c.map((x) => x.w.key), ...(SELF_COLLECT_TUBES.includes(g.tube) ? { selfCollect: true as const } : {}),
      createdAt: t, printedAt: t, printedBy: u.id,
    })))
    db.specimens.push(...out)
    ck!.servedAt ??= t
    audit('門診檢體條碼', `${nameOf.patient(patientId)}：${out.map((s) => `${TUBE_LABEL[s.tube]}（${(s.opdKeys ?? []).map((k) => find.procedure(k.split(':')[2])?.name).join('、')}）${s.selfCollect ? '發容器' : ''}`).join('；')}`)
    return out.map(spView)
  })
}

/** 採檢（抽血）或病人交回容器：檢體記採檢，送檢驗科收件。有要空腹的檢驗要答病人有沒有空腹（沒空腹不擋，記原因） */
export function collectDeskSpecimen(barcode: string, opts: { fasting?: boolean; note?: string } = {}): Promise<DeskSpecimen> {
  return mutate(() => {
    const u = requireUser('lab')
    const s = must(db.specimens.find((x) => x.barcode === barcode?.trim() && !x.partOf), '檢體（條碼）')
    if (s.admissionId) fail('住院檢體由護理站採檢', 'CONFLICT')
    if (s.er) fail('急診檢體由急診護理師床邊採檢', 'CONFLICT')
    const st = specimenStage(s)
    if (st !== 'printed') fail(`這支檢體${SPECIMEN_STAGE_LABEL[st]}`, 'CONFLICT')
    recordFasting(s, opts, u.id, now())
    Object.assign(s, { collectedAt: now(), collectedBy: u.id })
    audit(s.selfCollect ? '門診檢體交回' : '門診採檢', `${s.barcode} ${nameOf.patient(s.patientId)}${s.fasting ? `（${fastingText(s.fasting)}）` : ''}`)
    return spView(s)
  })
}
