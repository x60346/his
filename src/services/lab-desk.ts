// 門診抽血櫃台（醫檢師）：批價後的門診病人來報到取號 → 列出已批價、還沒採檢的檢驗 → 印條碼（同管合併；尿液、痰液是發容器給病人自行收集）
// → 採檢（容器是病人交回）→ 檢驗科「待收件」收件後才能登打。被退件的回到待重新採檢（櫃台請病人回來）。規則在 specimen-rules
import type { LabCheckin, Specimen } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, must, mutate, query, requireUser } from './http'
import { groupByTube, SELF_COLLECT_TUBES, specimenStage, SPECIMEN_STAGE_LABEL, TUBE_LABEL } from './specimen-rules'
import { nextBarcode, opdSpecimenOf } from './specimen-work'
import { pendingLabWork } from './lab-work'
import { find, nameOf } from './views'

/** 這位病人還沒採檢的門診檢驗（沒有檢體、或檢體被退件的） */
const toCollect = (patientId: string) => pendingLabWork().filter((w) => w.source === 'opd' && w.patientId === patientId && !opdSpecimenOf(w.key))
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
}
const spView = (s: Specimen): DeskSpecimen => {
  const st = specimenStage(s)
  return {
    id: s.id, barcode: s.barcode, tube: s.tube, tubeLabel: TUBE_LABEL[s.tube], tests: (s.opdKeys ?? []).map((k) => find.procedure(k.split(':')[2])?.name ?? k), selfCollect: !!s.selfCollect, stage: st,
    stageLabel: s.selfCollect && st === 'printed' ? '容器已發、待交回' : s.selfCollect && st === 'collected' ? '已交回、待收件' : SPECIMEN_STAGE_LABEL[st], ...(s.rejected ? { rejectedReason: s.rejected.reason } : {}),
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
  }
}

/** 抽血櫃台：今天報到的（依號碼）＋已批價還沒報到的 */
export function labDesk(): Promise<{ date: string; checkedIn: DeskPatient[]; notCheckedIn: DeskPatient[] }> {
  return query(() => {
    requireUser('lab')
    const d = todayOf()
    const checkedIn = db.labCheckins.filter((c) => c.date === d).sort((a, b) => a.no - b.no).map((c) => deskPatient(c.patientId, d))
    const waitingIds = [...new Set(pendingLabWork().filter((w) => w.source === 'opd' && !opdSpecimenOf(w.key)).map((w) => w.patientId))].filter((id) => !checkedIn.some((x) => x.patientId === id))
    return { date: d, checkedIn, notCheckedIn: waitingIds.map((id) => deskPatient(id, d)) }
  })
}

/** 報到取號（今天已報到的回傳原本的號碼）：要有已批價、還沒採檢的檢驗 */
export function checkInLab(patientId: string): Promise<LabCheckin> {
  return mutate(() => {
    const u = requireUser('lab')
    const d = todayOf()
    const old = db.labCheckins.find((c) => c.patientId === patientId && c.date === d)
    if (old) return old
    if (!toCollect(patientId).length) fail('這位病人沒有已批價、待採檢的門診檢驗（還沒批價請先到批價櫃台）', 'CONFLICT')
    const no = (db.counters[`labdesk:${d}`] = (db.counters[`labdesk:${d}`] ?? 0) + 1)
    const c: LabCheckin = { id: newId('LC'), no, patientId, date: d, at: now(), by: u.id }
    db.labCheckins.push(c)
    audit('抽血櫃台報到', `${nameOf.patient(patientId)}：${no} 號`)
    return c
  })
}

/** 印條碼：還沒採檢的檢驗依容器合併成檢體（尿液、痰液是發容器）；要先報到 */
export function printDeskLabels(patientId: string): Promise<DeskSpecimen[]> {
  return mutate(() => {
    const u = requireUser('lab')
    const d = todayOf()
    if (!db.labCheckins.some((c) => c.patientId === patientId && c.date === d)) fail('請先報到取號', 'CONFLICT')
    const items = toCollect(patientId)
    if (!items.length) fail('沒有要採檢的檢驗', 'CONFLICT')
    const t = now()
    const out: Specimen[] = groupByTube(items.map((w) => ({ tube: tubeOf(w.procId), w }))).map((g) => ({
      id: newId('SP'), barcode: nextBarcode(t), patientId, tube: g.tube, orderIds: [], opdKeys: g.items.map((x) => x.w.key), ...(SELF_COLLECT_TUBES.includes(g.tube) ? { selfCollect: true } : {}),
      createdAt: t, printedAt: t, printedBy: u.id,
    }))
    db.specimens.push(...out)
    audit('門診檢體條碼', `${nameOf.patient(patientId)}：${out.map((s) => `${TUBE_LABEL[s.tube]}（${(s.opdKeys ?? []).map((k) => find.procedure(k.split(':')[2])?.name).join('、')}）${s.selfCollect ? '發容器' : ''}`).join('；')}`)
    return out.map(spView)
  })
}

/** 採檢（抽血）或病人交回容器：檢體記採檢，送檢驗科收件 */
export function collectDeskSpecimen(barcode: string): Promise<DeskSpecimen> {
  return mutate(() => {
    const u = requireUser('lab')
    const s = must(db.specimens.find((x) => x.barcode === barcode?.trim()), '檢體（條碼）')
    if (s.admissionId) fail('住院檢體由護理站採檢', 'CONFLICT')
    const st = specimenStage(s)
    if (st !== 'printed') fail(`這支檢體${SPECIMEN_STAGE_LABEL[st]}`, 'CONFLICT')
    Object.assign(s, { collectedAt: now(), collectedBy: u.id })
    audit(s.selfCollect ? '門診檢體交回' : '門診採檢', `${s.barcode} ${nameOf.patient(s.patientId)}`)
    return spView(s)
  })
}
