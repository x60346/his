// 住院檢體採集與條碼：護理師在病人分頁「檢體」印條碼（同一位病人同管別的檢驗醫囑合併一支）→ 採檢（掃條碼或按採檢）→
// 檢驗科「收件」（掃條碼）後才能發報告；檢體有問題「退件」（溶血、量不足…），那幾筆醫囑回到待採檢、護理站提醒重新採檢。
// 門診的檢驗在檢驗科窗口抽血，不走這裡。規則在 specimen-rules
import type { Specimen } from '@/types'
import { commitIfPossible, db } from '@/mock/db'
import { addMinutes, now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, query, requireUser } from './http'
import { checkRejectReason, groupByTube, specimenLate, specimenStage, SPECIMEN_STAGE_LABEL, TUBE_LABEL, type SpecimenStage } from './specimen-rules'
import { collectRecord, isLabOrder, labOrderStage, newSpecimen, specimenOfOrder, toRecollect, tubeOfOrder } from './specimen-work'
import { ensureLabDraws } from './ipd'
import { find, nameOf } from './views'

export interface SpecimenView extends Specimen {
  stage: SpecimenStage
  stageLabel: string
  tubeLabel: string
  patientName: string
  chartNo: string
  bedNo: string
  ward: string
  /** 檢驗項目（醫囑內容） */
  tests: string[]
  late: boolean
  collectedByName?: string
  receivedByName?: string
  rejectedByName?: string
}
function view(s: Specimen, t: string = now()): SpecimenView {
  const a = find.admission(s.admissionId)
  const p = find.patient(s.patientId)
  const bed = find.bed(a?.bedId ?? '')
  const stage = specimenStage(s)
  return {
    ...s, stage, stageLabel: SPECIMEN_STAGE_LABEL[stage], tubeLabel: TUBE_LABEL[s.tube], patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', bedNo: bed?.bedNo ?? '', ward: bed?.ward ?? '',
    tests: s.orderIds.map((id) => db.ipdOrders.find((o) => o.id === id)?.content ?? id), late: specimenLate(s, t),
    ...(s.collectedBy ? { collectedByName: nameOf.user(s.collectedBy) } : {}), ...(s.receivedBy ? { receivedByName: nameOf.user(s.receivedBy) } : {}), ...(s.rejected ? { rejectedByName: nameOf.user(s.rejected.by) } : {}),
  }
}

const activeLabOrders = (admissionId: string) => db.ipdOrders.filter((o) => o.admissionId === admissionId && o.status === 'active' && isLabOrder(o))

export interface WardSpecimens {
  admissionId: string
  /** 還沒印條碼的檢驗醫囑（依容器分組＝會印成幾支） */
  toPrint: { tube: string; tubeLabel: string; orders: { id: string; content: string; createdAt: string }[] }[]
  /** 已印條碼、待採檢 */
  printed: SpecimenView[]
  /** 已採檢、等檢驗科收件 */
  waiting: SpecimenView[]
  /** 被退件、要重新採檢 */
  recollect: SpecimenView[]
  /** 最近 24 小時收件的 */
  received: SpecimenView[]
}

/** 病人分頁「檢體」（護理師、醫師）：這位病人的檢驗醫囑與檢體 */
export function wardSpecimens(admissionId: string): Promise<WardSpecimens> {
  return query(() => {
    requireUser('nurse', 'doctor')
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    // 長期檢驗今天到期的那一次（還沒產生的補上）
    if (a.status === 'admitted' && ensureLabDraws(a.id, t.slice(0, 10))) commitIfPossible()
    const toPrint = groupByTube(activeLabOrders(a.id).filter((o) => labOrderStage(o) === 'toCollect').map((o) => ({ tube: tubeOfOrder(o), o })))
    const mine = db.specimens.filter((s) => s.admissionId === a.id)
    const since = addMinutes(t, -24 * 60)
    return {
      admissionId: a.id,
      toPrint: toPrint.map((g) => ({ tube: g.tube, tubeLabel: TUBE_LABEL[g.tube], orders: g.items.map((x) => ({ id: x.o.id, content: x.o.content, createdAt: x.o.createdAt })) })),
      printed: mine.filter((s) => specimenStage(s) === 'printed').map((s) => view(s, t)),
      waiting: mine.filter((s) => specimenStage(s) === 'collected').map((s) => view(s, t)),
      recollect: toRecollect(a.id).map((s) => view(s, t)),
      received: mine.filter((s) => specimenStage(s) === 'received' && s.receivedAt! >= since).map((s) => view(s, t)),
    }
  })
}

/** 印條碼：還沒印的檢驗醫囑依容器合併成檢體（一支一個條碼號），回傳這位病人所有待採檢的標籤（含之前印過的，可重印） */
export function printSpecimenLabels(admissionId: string): Promise<SpecimenView[]> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人不在住院中', 'CONFLICT')
    const t = now()
    const groups = groupByTube(activeLabOrders(a.id).filter((o) => labOrderStage(o) === 'toCollect').map((o) => ({ tube: tubeOfOrder(o), o })))
    for (const g of groups) newSpecimen(a, g.tube, g.items.map((x) => x.o.id), u.id, t, false)
    const labels = db.specimens.filter((s) => s.admissionId === a.id && specimenStage(s) === 'printed')
    if (!labels.length) fail('沒有要採檢的檢驗', 'CONFLICT')
    if (groups.length) audit('印檢體條碼', `${a.admitNo} ${nameOf.patient(a.patientId)}：${groups.map((g) => `${TUBE_LABEL[g.tube]}（${g.items.map((x) => x.o.content).join('、')}）`).join('；')}`)
    return labels.map((s) => view(s, t))
  })
}

/** 採檢（護理師掃條碼或在清單上按）：檢體記採檢、裡面的檢驗醫囑一起完成 */
export function collectSpecimen(barcode: string): Promise<SpecimenView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(db.specimens.find((x) => x.barcode === barcode?.trim()), '檢體（條碼）')
    const st = specimenStage(s)
    if (st !== 'printed') fail(`這支檢體${SPECIMEN_STAGE_LABEL[st]}，不能再採檢`, 'CONFLICT')
    if (find.admission(s.admissionId)?.status !== 'admitted') fail('病人不在住院中', 'CONFLICT')
    const t = now()
    const os = collectRecord(s, u.id, t)
    if (!os.length) fail('這支檢體的醫囑都停止了，不用採檢', 'CONFLICT')
    audit('採檢', `${s.barcode} ${nameOf.patient(s.patientId)}：${os.map((o) => o.content).join('、')}`)
    return view(s, t)
  })
}

/** 檢驗科待收件（逾時的在前）、最近 24 小時退件的 */
export function labSpecimens(): Promise<{ toReceive: SpecimenView[]; rejected: SpecimenView[] }> {
  return query(() => {
    requireUser('lab')
    const t = now()
    const since = addMinutes(t, -24 * 60)
    return {
      toReceive: db.specimens.filter((s) => specimenStage(s) === 'collected').map((s) => view(s, t)).sort((x, y) => Number(y.late) - Number(x.late) || x.collectedAt!.localeCompare(y.collectedAt!)),
      rejected: db.specimens.filter((s) => s.rejected && s.rejected.at >= since).map((s) => view(s, t)),
    }
  })
}

/** 檢驗科收件（掃條碼）：收件後這幾項才能發報告 */
export function receiveSpecimen(barcode: string): Promise<SpecimenView> {
  return mutate(() => {
    const u = requireUser('lab')
    const s = must(db.specimens.find((x) => x.barcode === barcode?.trim()), '檢體（條碼）')
    const st = specimenStage(s)
    if (st !== 'collected') fail(st === 'printed' ? '這支檢體還沒採檢' : `這支檢體${SPECIMEN_STAGE_LABEL[st]}`, 'CONFLICT')
    const t = now()
    Object.assign(s, { receivedAt: t, receivedBy: u.id })
    audit('檢體收件', `${s.barcode} ${nameOf.patient(s.patientId)}`)
    return view(s, t)
  })
}

/** 退件（寫原因）：還沒發報告的檢體才能退；裡面的醫囑回到待採檢，護理站提醒重新採檢 */
export function rejectSpecimen(barcode: string, reason: string): Promise<SpecimenView> {
  return mutate(() => {
    const u = requireUser('lab')
    const s = must(db.specimens.find((x) => x.barcode === barcode?.trim()), '檢體（條碼）')
    const st = specimenStage(s)
    if (st !== 'collected' && st !== 'received') fail(st === 'printed' ? '這支檢體還沒採檢' : '這支檢體已經退件了', 'CONFLICT')
    if (s.orderIds.some((id) => db.labReports.some((r) => r.orderId === id))) fail('已經發了報告，不能退件（有問題請更正報告）', 'CONFLICT')
    failFields(checkRejectReason(reason))
    const t = now()
    s.rejected = { at: t, by: u.id, reason: reason.trim() }
    for (const id of s.orderIds) {
      const o = db.ipdOrders.find((x) => x.id === id)
      if (o && o.status === 'done') {
        o.status = 'active'
        delete o.stopAt
      }
    }
    audit('檢體退件', `${s.barcode} ${nameOf.patient(s.patientId)}：${reason.trim()}`)
    return view(s, t)
  })
}

/** 檢驗清單、登打用：這筆住院檢驗醫囑的檢體還沒收件 */
export const awaitingReceipt = (orderId: string) => {
  const o = db.ipdOrders.find((x) => x.id === orderId)
  return !!o && o.status === 'done' && labOrderStage(o) === 'collected' ? specimenOfOrder(orderId) : undefined
}
