// 病人辨識腕帶與給藥條碼核對：腕帶列印與重印、逐步掃描核對（不符記下來）、設定、示範用模擬掃描、病房掃描統計。
// 給藥時的最後核對在 nursing.executeMar／givePrn（scan-work.settleScan），規則在 scan-rules（純函式）
import type { Admission, MarRecord, ScanMismatch, ScanSkipReason } from '@/types'
import { db, newId } from '@/mock/db'
import { now, today } from '@/utils/date'
import { audit, fail, failField, must, mutate, query, requirePermission, requireUser } from './http'
import { checkDrugScan, checkPatientScan, SCAN_SKIP_LABEL, type ScanResult } from './scan-rules'
import { allScanAdmissions, orderDrug, scanAdmission, scanDemoAssist, scanRequired } from './scan-work'
import { admissionView, find, nameOf } from './views'


// ---------- 設定 ----------

export interface ScanPolicy {
  /** 給藥要掃描腕帶與藥品條碼 */
  requireScan: boolean
  /** 顯示示範用「模擬掃描」選單 */
  demoAssist: boolean
}
export const scanPolicy = (): Promise<ScanPolicy> => query(() => (requireUser(), { requireScan: scanRequired(), demoAssist: scanDemoAssist() }))

export function saveScanPolicy(input: ScanPolicy): Promise<ScanPolicy> {
  return mutate(() => {
    requireUser('admin')
    const old = { requireScan: scanRequired(), demoAssist: scanDemoAssist() }
    db.securitySettings = { ...db.securitySettings, requireScan: !!input.requireScan, scanDemoAssist: !!input.demoAssist }
    const on = (b: boolean) => (b ? '開' : '關')
    audit('修改安全設定', `給藥需掃描條碼 ${on(old.requireScan)} → ${on(!!input.requireScan)}；示範模擬掃描 ${on(old.demoAssist)} → ${on(!!input.demoAssist)}`)
    return { requireScan: !!input.requireScan, demoAssist: !!input.demoAssist }
  })
}

// ---------- 腕帶 ----------

export interface WristbandView {
  admissionId: string
  admitNo: string
  patientName: string
  gender: string
  birthDate: string
  chartNo: string
  allergies: string[]
  deptName: string
  admittedAt: string
  /** 已印過幾條（第一條＋重印次數）；0＝還沒印 */
  printed: number
  reprints: { at: string; byName: string; reason: string }[]
}

function wristbandView(a: Admission): WristbandView {
  const v = admissionView(a)
  return {
    admissionId: a.id, admitNo: a.admitNo, patientName: v.patientName, gender: v.gender, birthDate: v.birthDate, chartNo: v.chartNo, allergies: v.allergies,
    deptName: v.deptName, admittedAt: a.admittedAt ?? '',
    printed: a.wristband ? 1 + a.wristband.reprints.length : 0,
    reprints: (a.wristband?.reprints ?? []).map((r) => ({ at: r.at, byName: nameOf.user(r.by), reason: r.reason })),
  }
}

export function getWristband(admissionId: string): Promise<WristbandView> {
  return query(() => {
    requireUser('clerk', 'nurse', 'admin')
    return wristbandView(must(find.admission(admissionId), '住院紀錄'))
  })
}

/** 印腕帶：住院中才印。第一條（報到時）不用原因；之後是重印（遺失、弄濕、資料更正）要寫原因、留稽核 */
export function printWristband(admissionId: string, reason?: string): Promise<WristbandView> {
  return mutate(() => {
    const u = requireUser('clerk', 'nurse')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('只有住院中的病人可以印腕帶', 'CONFLICT')
    const t = now()
    if (!a.wristband) {
      a.wristband = { printedAt: t, printedBy: u.id, reprints: [] }
      audit('列印腕帶', `${a.admitNo} ${nameOf.patient(a.patientId)}`)
    } else {
      const why = reason?.trim()
      if (!why) failField('reason', '重印腕帶要寫原因（例：腕帶弄濕無法掃描）')
      a.wristband.reprints.push({ at: t, by: u.id, reason: why! })
      audit('重印腕帶', `${a.admitNo} ${nameOf.patient(a.patientId)}：${why}`)
    }
    return wristbandView(a)
  })
}

// ---------- 逐步掃描 ----------

/**
 * 給藥前逐步掃描（先腕帶、再藥品）：回傳對或不對，不丟錯——不符時要把這次「差點給錯」記下來（丟錯的話交易會回滾、記不下來）。
 * 真正給藥時服務層會再核對一次
 */
export function scanCheck(input: { admissionId: string; orderId: string; kind: 'patient' | 'drug'; code: string }): Promise<ScanResult> {
  return mutate(() => {
    const nurse = requirePermission('mar.give')
    const a = must(find.admission(input.admissionId), '住院紀錄')
    const o = must(db.ipdOrders.find((x) => x.id === input.orderId && x.admissionId === a.id), '醫囑')
    let r: ScanResult
    if (input.kind === 'patient') r = checkPatientScan(input.code, scanAdmission(a), allScanAdmissions())
    else {
      const d = orderDrug(o)
      if (!d) fail('這筆醫囑不是給藥，不用掃藥品')
      r = checkDrugScan(input.code, d!, db.drugs)
    }
    const code = (input.code ?? '').trim()
    if (!r.ok && code) {
      const ev: ScanMismatch = { id: newId('SM'), at: now(), nurseId: nurse.id, admissionId: a.id, orderId: o.id, kind: input.kind, code, message: r.message }
      db.scanMismatches.push(ev)
      audit('掃描不符', `${a.admitNo} ${nameOf.patient(a.patientId)} ${o.content}：${r.message}`)
    }
    return r
  })
}

// ---------- 示範用模擬掃描 ----------

export interface ScanDemoCodes {
  options: { label: string; kind: 'patient' | 'drug'; code: string; right: boolean }[]
}

/** 模擬掃描選單：這位病人的腕帶、別床病人的腕帶、舊腕帶（有的話）、對的藥、同成分別的規格或別的藥。設定關閉時不提供 */
export function scanDemoCodes(admissionId: string, orderId: string): Promise<ScanDemoCodes> {
  return query(() => {
    requirePermission('mar.give')
    if (!scanDemoAssist()) fail('示範用模擬掃描已關閉', 'FORBIDDEN')
    const a = must(find.admission(admissionId), '住院紀錄')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    const bedOf = (x: Admission) => find.bed(x.bedId ?? '')?.bedNo ?? ''
    const options: ScanDemoCodes['options'] = [{ label: `本人腕帶（${bedOf(a)} ${nameOf.patient(a.patientId)}）`, kind: 'patient', code: a.admitNo, right: true }]
    const other = db.admissions.find((x) => x.status === 'admitted' && x.id !== a.id && find.bed(x.bedId ?? '')?.ward === find.bed(a.bedId ?? '')?.ward)
      ?? db.admissions.find((x) => x.status === 'admitted' && x.id !== a.id)
    if (other) options.push({ label: `別床病人的腕帶（${bedOf(other)} ${nameOf.patient(other.patientId)}）`, kind: 'patient', code: other.admitNo, right: false })
    const old = db.admissions.find((x) => x.patientId === a.patientId && x.id !== a.id && x.status === 'discharged')
    if (old) options.push({ label: `本人上次住院的舊腕帶（${old.admitNo}）`, kind: 'patient', code: old.admitNo, right: false })
    const d = orderDrug(o)
    if (d) {
      options.push({ label: `正確的藥（${d.name}）`, kind: 'drug', code: d.nhiCode, right: true })
      const wrong = db.drugs.find((x) => x.id !== d.id && x.active && x.generic === d.generic) ?? db.drugs.find((x) => x.id !== d.id && x.active && x.category === d.category)
      if (wrong) options.push({ label: `拿錯的藥（${wrong.name}）`, kind: 'drug', code: wrong.nhiCode, right: false })
    }
    return { options }
  })
}

// ---------- 病房掃描統計 ----------

export interface ScanStats {
  date: string
  ward: string
  /** 當天已給藥的筆數（排程、PRN、STAT） */
  given: number
  scanned: number
  skipped: number
  /** 沒有掃描紀錄（設定關閉時給的） */
  notRequired: number
  skips: { at: string; bedNo: string; patientName: string; content: string; nurseName: string; reason: string; note?: string }[]
  mismatches: { at: string; bedNo: string; patientName: string; content: string; nurseName: string; kind: 'patient' | 'drug'; message: string }[]
}

/** 某病房某一天的給藥掃描統計：病人以「現在住哪個病房」算（轉床的跟著走） */
export function scanStats(ward: string, date: string = today()): Promise<ScanStats> {
  return query(() => {
    requireUser('nurse', 'admin')
    const inWard = (admissionId: string) => {
      const a = find.admission(admissionId)
      return !!a && find.bed(a.bedId ?? '')?.ward === ward
    }
    const label = (admissionId: string) => {
      const a = find.admission(admissionId)!
      return { bedNo: find.bed(a.bedId ?? '')?.bedNo ?? '', patientName: nameOf.patient(a.patientId) }
    }
    const content = (orderId: string) => db.ipdOrders.find((o) => o.id === orderId)?.content ?? ''
    const given = db.mar.filter((m) => m.status === 'given' && m.executedAt?.startsWith(date) && inWard(m.admissionId))
    const skipped = given.filter((m): m is MarRecord & { scan: { mode: 'skipped'; reason: ScanSkipReason; note?: string } } => m.scan?.mode === 'skipped')
    return {
      date, ward,
      given: given.length,
      scanned: given.filter((m) => m.scan?.mode === 'scanned').length,
      skipped: skipped.length,
      notRequired: given.filter((m) => !m.scan).length,
      skips: skipped
        .map((m) => ({ at: m.executedAt!, ...label(m.admissionId), content: content(m.orderId), nurseName: nameOf.user(m.nurseId), reason: SCAN_SKIP_LABEL[m.scan.reason], ...(m.scan.note ? { note: m.scan.note } : {}) }))
        .sort((x, y) => y.at.localeCompare(x.at)),
      mismatches: db.scanMismatches
        .filter((e) => e.at.startsWith(date) && inWard(e.admissionId))
        .map((e) => ({ at: e.at, ...label(e.admissionId), content: content(e.orderId), nurseName: nameOf.user(e.nurseId), kind: e.kind, message: e.message }))
        .sort((x, y) => y.at.localeCompare(x.at)),
    }
  })
}
