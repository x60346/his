// 急診檢驗（急診護理師、醫師）：醫師在急診看診存病歷就送出檢驗 → 急診護理師在看板「檢驗」床邊印條碼（同管合併）、採檢 →
// 檢驗科「待收件」收件後登打或上機。不經抽血櫃台、不用先批價（離院時照門診批價一起算）。
// 報告出來看板標「新報告」，醫師點開看過就清掉。內部計算在 er-lab-work
import type { Specimen } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { groupByTube, specimenStage, SPECIMEN_STAGE_LABEL, TUBE_LABEL } from './specimen-rules'
import { nextBarcode, opdSpecimenOf } from './specimen-work'
import { pendingLabWork } from './lab-work'
import { erLabCounts } from './er-lab-work'
import { isErDoctor } from './er-work'

const tubeOf = (procId: string) => find.procedure(procId)?.tube ?? 'red'
const erVisit = (visitId: string) => {
  const v = must(find.visit(visitId), '急診就醫')
  if (!v.er) fail('這不是急診就醫', 'BAD_REQUEST')
  return v
}
/** 這次急診還沒採檢的檢驗（醫師已送出、沒有檢體或檢體被退件的） */
const toCollect = (encounterId: string | undefined) => (encounterId ? pendingLabWork().filter((w) => w.er && w.key.startsWith(`E:${encounterId}:`) && !opdSpecimenOf(w.key)) : [])

export interface ErSpecimenView {
  id: string
  barcode: string
  tube: string
  tubeLabel: string
  tests: string[]
  stage: string
  stageLabel: string
  collectedAt?: string
  rejectedReason?: string
}
const spView = (s: Specimen): ErSpecimenView => ({
  id: s.id, barcode: s.barcode, tube: s.tube, tubeLabel: TUBE_LABEL[s.tube], tests: (s.opdKeys ?? []).map((k) => find.procedure(k.split(':')[2])?.name ?? k),
  stage: specimenStage(s), stageLabel: SPECIMEN_STAGE_LABEL[specimenStage(s)], ...(s.collectedAt ? { collectedAt: s.collectedAt } : {}), ...(s.rejected ? { rejectedReason: s.rejected.reason } : {}),
})

export interface ErLabs {
  visitId: string
  patientName: string
  chartNo: string
  /** 還沒印條碼的（依管別合併） */
  toPrint: { tube: string; tubeLabel: string; tests: string[] }[]
  specimens: ErSpecimenView[]
  /** 已出的報告（新的在前）；fresh＝醫師還沒看過 */
  reports: { id: string; no: string; procName: string; reportedAt: string; text: string; abnormal: boolean; critical: boolean; fresh: boolean }[]
  counts?: ReturnType<typeof erLabCounts>
  /** 急診護理師：印條碼、採檢 */
  canCollect: boolean
  /** 急診醫師：看過報告 */
  canSee: boolean
}

/** 看板「檢驗」：這次急診的檢驗、檢體、報告 */
export function erLabs(visitId: string): Promise<ErLabs> {
  return query(() => {
    const u = requireUser('nurse', 'doctor')
    const v = erVisit(visitId)
    const e = find.encounterOfVisit(v.id)
    const p = find.patient(v.patientId)
    const reports = e ? db.labReports.filter((r) => r.encounterId === e.id).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt)) : []
    return {
      visitId: v.id, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '',
      toPrint: groupByTube(toCollect(e?.id).map((w) => ({ tube: tubeOf(w.procId), w }))).map((g) => ({ tube: g.tube, tubeLabel: TUBE_LABEL[g.tube], tests: g.items.map((x) => x.w.procName) })),
      specimens: db.specimens.filter((s) => s.er && e && (s.opdKeys ?? []).some((k) => k.startsWith(`E:${e.id}:`))).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(spView),
      reports: reports.map((r) => ({
        id: r.id, no: r.no, procName: find.procedure(r.procId)?.name ?? r.procId, reportedAt: r.reportedAt,
        text: r.values.map((x) => `${x.name} ${x.value}${x.unit ? ` ${x.unit}` : ''}${x.flag ? ` ${x.flag}` : ''}`).join('、'),
        abnormal: r.values.some((x) => x.flag), critical: r.values.some((x) => x.critical), fresh: !v.er!.labsSeenAt || r.reportedAt > v.er!.labsSeenAt,
      })),
      counts: erLabCounts(v),
      canCollect: u.role === 'nurse',
      canSee: u.role === 'doctor' && isErDoctor(u.doctorId),
    }
  })
}

/** 印條碼（急診護理師）：醫師送出、還沒採檢的檢驗依管別合併成檢體（一支一個條碼） */
export function printErLabels(visitId: string): Promise<ErSpecimenView[]> {
  return mutate(() => {
    const u = requireUser('nurse')
    const v = erVisit(visitId)
    if (v.status === 'cancelled') fail('已退掛', 'CONFLICT')
    const e = find.encounterOfVisit(v.id)
    const items = toCollect(e?.id)
    if (!items.length) fail('沒有要採檢的檢驗（醫師還沒送出，或都印過了）', 'CONFLICT')
    const t = now()
    const out: Specimen[] = groupByTube(items.map((w) => ({ tube: tubeOf(w.procId), w }))).map((g) => ({
      id: newId('SP'), barcode: nextBarcode(t), patientId: v.patientId, tube: g.tube, orderIds: [], opdKeys: g.items.map((x) => x.w.key), er: true, createdAt: t, printedAt: t, printedBy: u.id,
    }))
    db.specimens.push(...out)
    audit('急診檢體條碼', `${nameOf.patient(v.patientId)}：${out.map((s) => `${TUBE_LABEL[s.tube]}（${(s.opdKeys ?? []).map((k) => find.procedure(k.split(':')[2])?.name).join('、')}）`).join('；')}`)
    return out.map(spView)
  })
}

/** 床邊採檢（急診護理師，掃條碼或按採檢）：送檢驗科收件 */
export function collectErSpecimen(barcode: string): Promise<ErSpecimenView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(db.specimens.find((x) => x.barcode === barcode?.trim() && !x.partOf), '檢體（條碼）')
    if (!s.er) fail(s.admissionId ? '住院檢體請在病房採檢' : '門診檢體在抽血櫃台採檢', 'CONFLICT')
    const st = specimenStage(s)
    if (st !== 'printed') fail(`這支檢體${SPECIMEN_STAGE_LABEL[st]}`, 'CONFLICT')
    Object.assign(s, { collectedAt: now(), collectedBy: u.id })
    audit('急診床邊採檢', `${s.barcode} ${nameOf.patient(s.patientId)}`)
    return spView(s)
  })
}

/** 醫師看過檢驗報告（急診醫師）：看板的「新報告」清掉 */
export function markErLabsSeen(visitId: string): Promise<{ at: string }> {
  return mutate(() => {
    const u = requireUser('doctor')
    if (!isErDoctor(u.doctorId)) fail('急診醫師才能確認', 'FORBIDDEN')
    const v = erVisit(visitId)
    const t = now()
    v.er!.labsSeenAt = t
    return { at: t }
  })
}
