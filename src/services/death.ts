// 死亡出院：
//   - 宣告（醫師：本科照護團隊，或帶領那次急救的醫師）：死亡時間（急救後＝急救結束的時間）、死因四層、死亡方式、住院經過。
//     宣告後醫囑全部停止、出院病摘自動帶入（出院類別「死亡」、已簽署）；急救進行中不能宣告（請在急救紀錄結束）
//   - 遺體護理（護理師）：五項檢核＋貴重物品點交
//   - 死亡證明書（醫師）：不收費、開了就能印；非自然死（意外、自殺、他殺、未確定）要報請檢察官相驗，醫院不開
//   - 送太平間（護理師、住院中心）：遺體護理、死亡證明書都完成才可以 → 出院（床位釋放、管路記移除）。
//     帳單不用先結：之後由家屬在櫃台結（住院結帳清單標「死亡出院」）
// 規則在 death-rules
import type { Admission, DeathRecord } from '@/types'
import { db, nextCounter } from '@/mock/db'
import { ageOf, now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, query, requireUser, sessionRole } from './http'
import { find, nameOf } from './views'
import { careRoleOf } from './care-team'
import { activeDnr } from './flag-work'
import { closeOrders, releaseBed } from './bed-work'
import { closeLines } from './line-work'
import { closeRestraints } from './delirium-work'
import { closeInfusions } from './infusion-work'
import { openPca } from './pca-work'
import { releaseAll, transfusionOpen } from './blood-work'
import { BODY_CARE_ITEMS, CAUSE_LABELS, checkBodyCare, checkDeathInput, deathMannerLabel, isExpectedDeath, morgueProblem, needsProsecutor } from './death-rules'

const admittedOf = (id: string) => {
  const a = must(find.admission(id), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}
const deathOf = (a: Admission) => {
  if (!a.death) fail('病人還沒宣告死亡', 'CONFLICT')
  return a.death!
}
/** 安寧收案（第十二輪 ②）：預期死亡也算 */
const palliativeOf = (a: Admission) => !!(db as { palliativeCases?: { admissionId: string; status: string }[] }).palliativeCases?.some((p) => p.admissionId === a.id && p.status === 'enrolled')

export interface DeathView extends DeathRecord {
  declaredByName: string
  mannerLabel: string
  causesText: { label: string; text: string }[]
  careByName?: string
  careItems?: string[]
  morgueByName?: string
  /** 死亡證明書列印用 */
  print: { name: string; gender: string; birthDate: string; age: number; idNo: string; address: string; chartNo: string; deptName: string; doctorName: string; doctorLicenseNo: string; admittedAt: string }
}
function view(a: Admission): DeathView {
  const d = a.death!
  const p = must(find.patient(a.patientId), '病患')
  const doc = find.doctor(find.user(d.declaredBy)?.doctorId ?? '')
  return {
    ...d,
    declaredByName: nameOf.user(d.declaredBy), mannerLabel: deathMannerLabel(d.manner),
    causesText: d.causes.map((text, i) => ({ label: CAUSE_LABELS[i], text })),
    ...(d.care ? { careByName: nameOf.user(d.care.by), careItems: BODY_CARE_ITEMS.filter((i) => d.care!.items.includes(i.key)).map((i) => i.label) } : {}),
    ...(d.morgueBy ? { morgueByName: nameOf.user(d.morgueBy) } : {}),
    print: {
      name: p.name, gender: p.gender === 'M' ? '男' : '女', birthDate: p.birthDate, age: ageOf(p.birthDate, d.declaredAt.slice(0, 10)), idNo: p.idNo, address: p.address, chartNo: p.chartNo,
      deptName: nameOf.dept(a.deptId), doctorName: doc?.name ?? nameOf.user(d.declaredBy), doctorLicenseNo: doc?.licenseNo ?? '', admittedAt: a.admittedAt ?? '',
    },
  }
}

export interface PatientDeath {
  admissionId: string
  death?: DeathView
  /** 急救進行中（要在急救紀錄結束） */
  codeActive: boolean
  /** 急救以「宣告死亡」結束、還沒寫死亡紀錄：帶入那次急救與時間 */
  fromCode?: { id: string; endedAt: string }
  /** 預期死亡（有 DNR 或安寧收案）：宣告時會記下 */
  expected: boolean
  canDeclare: boolean
  canCare: boolean
  canCert: boolean
  canMorgue: boolean
  /** 送太平間還差什麼 */
  morgueBlocked?: string
}
export function patientDeath(admissionId: string): Promise<PatientDeath> {
  return query(() => {
    requireUser()
    const a = must(find.admission(admissionId), '住院紀錄')
    const role = sessionRole()
    const admitted = a.status === 'admitted'
    const d = a.death
    const codeActive = db.codeBlues.some((c) => c.admissionId === a.id && c.status === 'active')
    const lastDeathCode = db.codeBlues.filter((c) => c.admissionId === a.id && c.outcome === 'death').sort((x, y) => (x.endedAt ?? '').localeCompare(y.endedAt ?? '')).pop()
    const blocked = d && admitted ? morgueProblem(d) : undefined
    return {
      admissionId: a.id,
      ...(d ? { death: view(a) } : {}),
      codeActive,
      ...(!d && lastDeathCode ? { fromCode: { id: lastDeathCode.id, endedAt: lastDeathCode.endedAt! } } : {}),
      expected: isExpectedDeath(activeDnr(a.patientId)?.withhold, palliativeOf(a)),
      canDeclare: role === 'doctor' && admitted && !d && !codeActive,
      canCare: role === 'nurse' && admitted && !!d && !d.care,
      canCert: role === 'doctor' && !!d && !d.cert && !needsProsecutor(d.manner),
      canMorgue: (role === 'nurse' || role === 'clerk') && admitted && !!d && !blocked,
      ...(blocked ? { morgueBlocked: blocked } : {}),
    }
  })
}

export function declareDeath(admissionId: string, input: { causes: string[]; other?: string; manner: DeathRecord['manner']; course: string; declaredAt?: string; codeBlueId?: string }): Promise<DeathView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = admittedOf(admissionId)
    if (a.death) fail('已經宣告死亡了', 'CONFLICT')
    if (db.codeBlues.some((c) => c.admissionId === a.id && c.status === 'active')) fail('急救進行中：請在急救紀錄結束（宣告死亡）', 'CONFLICT')
    const code = input.codeBlueId ? must(db.codeBlues.find((c) => c.id === input.codeBlueId && c.admissionId === a.id), '急救紀錄') : undefined
    if (code && code.outcome !== 'death') fail('那次急救不是以「宣告死亡」結束', 'CONFLICT')
    // 本科照護團隊（主治、值班代理），或帶領那次急救的醫師
    const role = careRoleOf(u.doctorId, a)
    if ((!role || role.kind === 'consult') && !(code && code.leaderId === u.id)) fail(`只有${nameOf.dept(a.deptId)}的醫師（主治、值班代理）或帶領急救的醫師可以宣告死亡`, 'FORBIDDEN')
    const t = now()
    const at = code?.endedAt ?? input.declaredAt ?? t
    failFields(checkDeathInput({ ...input, declaredAt: at }, a.admittedAt, t))
    const causes = input.causes.map((s) => s?.trim() ?? '').filter(Boolean)
    const d: DeathRecord = {
      declaredAt: at, declaredBy: u.id, ...(code ? { codeBlueId: code.id } : {}),
      expected: isExpectedDeath(activeDnr(a.patientId)?.withhold, palliativeOf(a)),
      causes, ...(input.other?.trim() ? { other: input.other.trim() } : {}), manner: input.manner, course: input.course.trim(),
    }
    a.death = d
    const pt = find.patient(a.patientId)
    if (pt) pt.deceasedAt = at
    // 醫囑全部停止、給藥排程取消（逾時沒給的標「暫停：病人死亡」）
    closeOrders(a, u.id, t, '病人死亡')
    // 出院病摘：出院類別「死亡」，宣告就算簽署（送太平間＝出院）
    a.dischargeSummary = {
      diagnosis: [causes[0], causes.length > 1 ? `（原始死因：${causes[causes.length - 1]}）` : ''].join(''),
      course: d.course, condition: `${at} 宣告死亡（${deathMannerLabel(d.manner)}）`, followUp: '', dischargeType: '死亡',
      doctorId: u.doctorId ?? a.doctorId, writtenAt: t, signedAt: t,
    }
    audit('宣告死亡', `${a.admitNo} ${nameOf.patient(a.patientId)}：${at}，${causes[0]}${d.expected ? '（預期死亡）' : ''}`)
    return view(a)
  })
}

export function recordBodyCare(admissionId: string, input: { items: string[]; valuables: string }): Promise<DeathView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = admittedOf(admissionId)
    const d = deathOf(a)
    if (d.care) fail('遺體護理已經記錄了', 'CONFLICT')
    failFields(checkBodyCare(input))
    d.care = { items: BODY_CARE_ITEMS.map((i) => i.key), valuables: input.valuables.trim(), by: u.id, at: now() }
    audit('遺體護理', `${nameOf.patient(a.patientId)}：點交 ${d.care.valuables}`)
    return view(a)
  })
}

/** 死亡證明書字號：民國年＋流水號（每年重編） */
const certNo = (at: string) => {
  const roc = Number(at.slice(0, 4)) - 1911
  return `${roc} 死字第 ${String(nextCounter(`death:${roc}`)).padStart(6, '0')} 號`
}
export function issueDeathCertificate(admissionId: string, input: { copies: number }): Promise<DeathView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = must(find.admission(admissionId), '住院紀錄')
    const d = deathOf(a)
    if (d.cert) fail('死亡證明書已經開了（要多印請按列印）', 'CONFLICT')
    if (needsProsecutor(d.manner)) fail(`死亡方式「${deathMannerLabel(d.manner)}」：要報請檢察官相驗，由檢察官開相驗屍體證明書，醫院不開死亡證明書`, 'CONFLICT')
    const role = careRoleOf(u.doctorId, a)
    if ((!role || role.kind === 'consult') && d.declaredBy !== u.id) fail('只有宣告的醫師或本科醫師可以開死亡證明書', 'FORBIDDEN')
    if (!Number.isInteger(input.copies) || input.copies < 1 || input.copies > 10) failFields({ copies: '份數 1–10' })
    const t = now()
    d.cert = { no: certNo(t), copies: input.copies, issuedAt: t, by: u.id }
    audit('開立死亡證明書', `${d.cert.no} ${nameOf.patient(a.patientId)}（${input.copies} 份）`)
    return view(a)
  })
}

/** 列印（醫師、護理師、櫃台都可以：家屬來拿的時候） */
export function printDeathCertificate(admissionId: string): Promise<DeathView> {
  return mutate(() => {
    const u = requireUser('doctor', 'nurse', 'clerk')
    const a = must(find.admission(admissionId), '住院紀錄')
    const d = deathOf(a)
    if (!d.cert) fail('死亡證明書還沒開', 'CONFLICT')
    d.cert.printed = [...(d.cert.printed ?? []), { at: now(), by: u.id }]
    return view(a)
  })
}

/** 送太平間＝出院：管路記移除、點滴與約束結束、配好的血釋出、床位釋放；帳單之後由家屬結 */
export function sendToMorgue(admissionId: string): Promise<DeathView> {
  return mutate(() => {
    const u = requireUser('nurse', 'clerk')
    const a = admittedOf(admissionId)
    const d = deathOf(a)
    const p = morgueProblem(d)
    if (p) fail(p, 'CONFLICT')
    if (openPca(a.id)) fail('PCA 還沒結束：請護理師結束 PCA 並雙人銷毀剩餘量', 'CONFLICT')
    if (transfusionOpen(a)) fail('有血袋已發出或輸血中：請血庫退回後再送太平間', 'CONFLICT')
    const t = now()
    closeOrders(a, u.id, t, '病人死亡')
    closeLines(a, u.id, t, '死亡')
    closeRestraints(a, u.id, t, '死亡')
    closeInfusions(a, u.id, t, '死亡')
    for (const r of db.bloodRequests.filter((x) => x.admissionId === a.id && !x.cancelled)) releaseAll(r, u.id, '病人死亡', t)
    for (const sg of db.surgeries.filter((x) => x.admissionId === a.id && (x.status === 'requested' || x.status === 'scheduled'))) Object.assign(sg, { status: 'cancelled', cancelled: { by: u.id, at: t, reason: '病人死亡' } })
    releaseBed(a.bedId)
    Object.assign(a, { status: 'discharged', dischargedAt: t, dischargeType: '死亡' })
    Object.assign(d, { morgueAt: t, morgueBy: u.id })
    audit('送太平間', `${a.admitNo} ${nameOf.patient(a.patientId)}（死亡出院；帳單待家屬結帳）`)
    return view(a)
  })
}

