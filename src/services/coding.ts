// 疾病分類編碼審查（病歷管理師，權限「疾病分類」）：出院後看病摘與手術紀錄，確認或修改主診斷與次診斷 →
// 改了要寫理由，修改前後的 DRG 一起看；主治首頁「編碼已修改」，已讀時可寫意見。住院申報要審查過才能送（claim-work 檢核）
import type { Admission } from '@/types'
import { db } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, must, mutate, permissionsOf, query, requirePermission, requireUser } from './http'
import { checkSecondary } from './ipd'
import { drgExemptOf, drgOfAdmission } from './drg-work'
import { dxCode, mainDiagnosisFrom, type DrgResult } from './drg-rules'
import { find, nameOf } from './views'
import { CODING_DAYS } from './coding-work'
import { claimedState, ipdItemOf } from './claim-work'
import { monthOf } from './claim-rules'


export interface CodingItem {
  admissionId: string
  admitNo: string
  patientName: string
  chartNo: string
  doctorName: string
  deptName: string
  admittedAt: string
  dischargedAt: string
  dischargeType: string
  day: boolean
  /** 病摘（醫師寫的） */
  summaryDiagnosis: string
  summarySecondary: { icd: string; name: string }[]
  /** 舊病摘沒有次診斷欄位 */
  noSecondaryField: boolean
  course: string
  surgeries: string[]
  /** 現在（編碼後以編碼為準）的主診斷、次診斷、DRG */
  mainDiagnosis: string
  secondary: { icd: string; name: string }[]
  drg: DrgResult
  /** 不適用 DRG（日間手術、死亡、轉院、自動出院、超過 30 天）：照實申報，編碼仍要審查 */
  drgExempt?: string
  coded?: { at: string; byName: string; changed: boolean; reason?: string; beforeText?: string; ack?: string; /** 更正過幾次（舊到新的說明） */ revisions: string[] }
  /** 已經申報（那個月送出了）：改碼後的差額列在補報；delta＝現在算的和送過的差多少 */
  claimed?: { month: string; delta: number; supplementMonth?: string }
  overdue: boolean
}

function item(a: Admission): CodingItem {
  const day = !!a.day && !a.day.converted
  const sum = a.dischargeSummary
  const secondary = a.coding?.secondary ?? sum?.secondaryDiagnoses ?? []
  return {
    admissionId: a.id, admitNo: a.admitNo, patientName: nameOf.patient(a.patientId), chartNo: find.patient(a.patientId)?.chartNo ?? '', doctorName: nameOf.doctor(a.doctorId), deptName: find.dept(a.deptId)?.name ?? '',
    admittedAt: a.admittedAt ?? '', dischargedAt: a.dischargedAt ?? '', dischargeType: a.dischargeType ?? sum?.dischargeType ?? '', day,
    summaryDiagnosis: (day ? a.diagnosis : sum?.diagnosis) ?? '', summarySecondary: sum?.secondaryDiagnoses ?? [], noSecondaryField: !day && !!sum && !sum.secondaryDiagnoses, course: sum?.course ?? '',
    surgeries: db.surgeries.filter((s) => s.admissionId === a.id && s.status === 'done').map((s) => `${s.no} ${find.procedure(s.procId)?.name ?? ''}${s.record ? `：${s.record.performed}` : ''}`),
    mainDiagnosis: mainDiagnosisFrom(a), secondary, drg: drgOfAdmission(a), ...((x) => (x ? { drgExempt: x } : {}))(drgExemptOf(a, now())),
    ...(a.coding ? { coded: { at: a.coding.at, byName: nameOf.user(a.coding.by), changed: a.coding.changed, ...(a.coding.reason ? { reason: a.coding.reason } : {}), ...(a.coding.before ? { beforeText: `${a.coding.before.main}${a.coding.before.secondary.length ? `；次：${a.coding.before.secondary.map((x) => x.icd).join('、')}` : ''}` } : {}), ...(a.coding.ack ? { ack: `${nameOf.user(a.coding.ack.by)} ${a.coding.ack.at.slice(5)}${a.coding.ack.note ? `：${a.coding.ack.note}` : ''}` } : {}), revisions: (a.coding.revisions ?? []).map((r) => `${r.at.slice(5)} ${nameOf.user(r.by)}：${r.mainDiagnosis}${r.secondary.length ? `；次：${r.secondary.map((x) => x.icd).join('、')}` : ''}`) } } : {}),
    ...((c) => (c ? { claimed: c } : {}))(a.coding && a.dischargedAt ? claimedState('ipd', a.id, monthOf(a.dischargedAt), ipdItemOf(a), monthOf(today())) : undefined),
    overdue: !a.coding && !!a.dischargedAt && a.dischargedAt.slice(0, 10) < addDays(today(), -CODING_DAYS),
  }
}

/** 編碼審查清單：還沒審查的（逾時在前）、審查過的（最近 30 天審查、或近 90 天出院——已申報月份的也找得到，可以更正） */
export function codingQueue(): Promise<{ todo: CodingItem[]; done: CodingItem[]; canCode: boolean }> {
  return query(() => {
    const u = requirePermission('coding')
    const xs = db.admissions.filter((a) => a.status === 'discharged' && a.dischargedAt)
    const from = addDays(today(), -30)
    const dFrom = addDays(today(), -90)
    return {
      canCode: permissionsOf(u).includes('coding'),
      todo: xs.filter((a) => !a.coding).map(item).sort((a, b) => Number(b.overdue) - Number(a.overdue) || a.dischargedAt.localeCompare(b.dischargedAt)),
      done: xs.filter((a) => a.coding && (a.coding.at.slice(0, 10) >= from || a.dischargedAt!.slice(0, 10) >= dFrom)).map(item).sort((a, b) => b.coded!.at.localeCompare(a.coded!.at)),
    }
  })
}

/** 審查（確認或修改）：主診斷（ICD 主檔的碼）、次診斷；和現在的不同要寫理由。回傳修改前後的 DRG */
export function confirmCoding(admissionId: string, input: { mainIcd: string; secondary: { icd: string; name: string }[]; reason?: string }): Promise<{ item: CodingItem; drgBefore: DrgResult; drgAfter: DrgResult }> {
  return mutate(() => {
    const u = requirePermission('coding')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'discharged') fail('出院後才審查編碼', 'CONFLICT')
    if (a.coding) fail('已經審查過了', 'CONFLICT')
    const c = db.icdCodes.find((k) => k.code === input.mainIcd)
    if (!c || c.active === false) failField('mainIcd', input.mainIcd ? `主診斷 ${input.mainIcd} 不是 ICD 主檔裡可用的碼：請重新選` : '請選主診斷（ICD 主檔）')
    const main = `${c!.code} ${c!.name}`
    const secondary = checkSecondary(main, input.secondary)
    const drgBefore = drgOfAdmission(a)
    const curMain = mainDiagnosisFrom(a)
    const curSec = a.dischargeSummary?.secondaryDiagnoses ?? []
    const changed = dxCode(curMain) !== c!.code || [...secondary.map((x) => x.icd)].sort().join() !== [...curSec.map((x) => x.icd)].sort().join()
    if (changed && !input.reason?.trim()) failField('reason', '改了編碼要寫理由（例：病摘寫肺炎，痰培養與影像支持吸入性肺炎）')
    a.coding = { at: now(), by: u.id, mainDiagnosis: main, secondary, changed, ...(changed ? { reason: input.reason!.trim(), before: { main: curMain, secondary: curSec } } : {}) }
    const drgAfter = drgOfAdmission(a)
    audit(changed ? '編碼修改' : '編碼確認', `${a.admitNo} ${nameOf.patient(a.patientId)}：${main}${secondary.length ? `；次：${secondary.map((x) => x.icd).join('、')}` : ''}${changed ? `（原 ${curMain}；${input.reason!.trim()}）；DRG ${drgBefore.code} → ${drgAfter.code}` : ''}`)
    return { item: item(a), drgBefore, drgAfter }
  })
}

/**
 * 編碼更正（審查過後又發現要改，例如申報後病歷室複審、核減後改碼）：要寫理由、要和現在的不同；
 * 舊版本留在 revisions，主治要重新讀。那個月已經申報的，差額（DRG 改組）自動列在下一個還沒送的月份補報
 */
export function recodeCoding(admissionId: string, input: { mainIcd: string; secondary: { icd: string; name: string }[]; reason?: string }): Promise<{ item: CodingItem; drgBefore: DrgResult; drgAfter: DrgResult }> {
  return mutate(() => {
    const u = requirePermission('coding')
    const a = must(find.admission(admissionId), '住院紀錄')
    const old = a.coding
    if (!old) fail('還沒審查過：請先審查', 'CONFLICT')
    const c = db.icdCodes.find((k) => k.code === input.mainIcd)
    if (!c || c.active === false) failField('mainIcd', input.mainIcd ? `主診斷 ${input.mainIcd} 不是 ICD 主檔裡可用的碼：請重新選` : '請選主診斷（ICD 主檔）')
    const main = `${c!.code} ${c!.name}`
    const secondary = checkSecondary(main, input.secondary)
    const oldSec = old!.secondary ?? []
    if (dxCode(old!.mainDiagnosis) === c!.code && [...secondary.map((x) => x.icd)].sort().join() === [...oldSec.map((x) => x.icd)].sort().join()) fail('和現在的編碼一樣，不用更正', 'CONFLICT')
    if (!input.reason?.trim()) failField('reason', '更正編碼要寫理由（例：複審手術紀錄，實際做的是腹腔鏡手術）')
    const drgBefore = drgOfAdmission(a)
    const revisions = [...(old!.revisions ?? []), { at: old!.at, by: old!.by, mainDiagnosis: old!.mainDiagnosis, secondary: oldSec, ...(old!.reason ? { reason: old!.reason } : {}) }]
    a.coding = { at: now(), by: u.id, mainDiagnosis: main, secondary, changed: true, reason: input.reason!.trim(), before: { main: old!.mainDiagnosis, secondary: oldSec }, revisions }
    const drgAfter = drgOfAdmission(a)
    const it = item(a)
    audit('編碼更正', `${a.admitNo} ${nameOf.patient(a.patientId)}：${old!.mainDiagnosis} → ${main}${secondary.length ? `；次：${secondary.map((x) => x.icd).join('、')}` : ''}（${input.reason!.trim()}）；DRG ${drgBefore.code} → ${drgAfter.code}${it.claimed?.delta ? `；已申報 ${it.claimed.month}，補報 ${it.claimed.delta > 0 ? '+' : ''}${it.claimed.delta} 點` : ''}`)
    return { item: it, drgBefore, drgAfter }
  })
}

/** 主治：我的病人被修改編碼的（還沒讀的在前） */
export function myCodingChanges(): Promise<CodingItem[]> {
  return query(() => {
    const u = requireUser('doctor')
    return db.admissions.filter((a) => a.doctorId === u.doctorId && a.coding?.changed).map(item).sort((x, y) => Number(!!x.coded!.ack) - Number(!!y.coded!.ack) || y.coded!.at.localeCompare(x.coded!.at))
  })
}

/** 主治已讀（可寫意見；病歷管理師看得到） */
export function ackCoding(admissionId: string, note?: string): Promise<CodingItem> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.doctorId !== u.doctorId) fail('只有主治能讀這筆編碼修改', 'FORBIDDEN')
    if (!a.coding?.changed) fail('這筆編碼沒有修改', 'CONFLICT')
    if (a.coding.ack) fail('已經讀過了', 'CONFLICT')
    a.coding.ack = { at: now(), by: u.id, ...(note?.trim() ? { note: note.trim() } : {}) }
    audit('編碼修改已讀', `${a.admitNo} ${nameOf.patient(a.patientId)}${note?.trim() ? `：${note.trim()}` : ''}`)
    return item(a)
  })
}


/** 試算：照這組編碼會分到哪一組 DRG（不存） */
export function previewCoding(admissionId: string, input: { mainIcd: string; secondary: { icd: string }[] }): Promise<DrgResult> {
  return query(() => {
    requirePermission('coding')
    const a = must(find.admission(admissionId), '住院紀錄')
    const c = db.icdCodes.find((k) => k.code === input.mainIcd)
    return drgOfAdmission({ ...a, coding: { at: '', by: '', mainDiagnosis: c ? `${c.code} ${c.name}` : mainDiagnosisFrom(a), secondary: (input.secondary ?? []).map((x) => ({ icd: x.icd, name: '' })), changed: false } })
  })
}
