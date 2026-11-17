// 加護病房：重症流程表（每小時一筆：生命徵象、GCS、瞳孔、輸入輸出量；班別與 24 小時累計平衡）、床邊看板。
// 流程表的數值就是生命徵象（寫進 db.vitals，標 hourly）：一般的生命徵象分頁、趨勢圖、本班未量都看得到，不用記兩次。
// 漏記（超過 75 分鐘）列進本班待辦，只提醒不擋。規則在 icu-rules
import type { PupilLight, VitalRecord } from '@/types'
import { db } from '@/mock/db'
import { addMinutes, now, today } from '@/utils/date'
import { audit, fail, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { checkNeuro, FLOW_HOURS, FLOW_SHIFTS, gcsLow, gcsText, gcsTotal, mapLow, mapOf, pupilUnequal } from './icu-rules'
import { checkRass, checkVentMeasure, PPEAK_HIGH, rassVsTarget, ventText } from './vent-rules'
import { activeVent, intubation, rassStateOf } from './vent-work'
import { hourlyOf, icuHourly, icuSince, inIcu, ioBetween } from './icu-work'
import { buildVital, type VitalInput } from './vital-work'
import { isAbnormal, vitalSpecs, type VitalKey } from './nursing-rules'
import { icuWard } from '@/mock/codes'
import { assignedNurse, shiftNow } from './staffing-work'

/** 一筆紀錄的異常項目（生命徵象超出正常範圍、MAP <65、GCS ≤8、瞳孔不等大、RASS 超出鎮靜目標、尖峰壓 >35） */
function abnormalOf(v: VitalRecord, target?: { min: number; max: number }): string[] {
  const out = (Object.keys(vitalSpecs) as VitalKey[]).filter((k) => isAbnormal(k, v[k])).map((k) => vitalSpecs[k].label)
  if (mapLow(mapOf(v.sbp, v.dbp))) out.push('MAP')
  if (gcsLow(v.gcs)) out.push('GCS')
  if (pupilUnequal(v.pupils)) out.push('瞳孔不等大')
  if (v.rass !== undefined && target && rassVsTarget(v.rass, target) !== 'in') out.push('RASS')
  if (v.vent && v.vent.ppeak > PPEAK_HIGH) out.push('尖峰壓')
  return out
}

export interface FlowCell extends VitalRecord {
  map?: number
  gcsSum?: number
  /** 10T E3VTM6 */
  gcsText?: string
  abnormal: string[]
  nurseName: string
}
export interface FlowHour {
  hour: string
  /** 這一小時最後一筆（同一小時記兩次以後寫的為準；之前的在 more 裡數得到） */
  cell?: FlowCell
  more: number
  /** 這一小時的輸入（手記＋點滴＋管灌）、輸出 */
  io: ReturnType<typeof ioBetween>
  future: boolean
}
export interface Flowsheet {
  admissionId: string
  date: string
  inIcu: boolean
  /** 這次轉進加護病房的時間 */
  since?: string
  hours: FlowHour[]
  shifts: { shift: string; intake: number; output: number; balance: number }[]
  day: { intake: number; output: number; balance: number }
  /** 多久沒記（今天才有） */
  state?: { minutes: number; late: boolean; dueAt: string; lastAt?: string }
  /** 使用中的呼吸器設定（有才可以記呼吸器實測）、插管（GCS 言語可以記 T）、鎮靜目標 */
  vent?: { text: string }
  intubated: boolean
  rassTarget?: { min: number; max: number }
  canRecord: boolean
}

const cellOf = (v: VitalRecord, target?: { min: number; max: number }): FlowCell => ({
  ...v, map: mapOf(v.sbp, v.dbp), gcsSum: gcsTotal(v.gcs), ...(v.gcs ? { gcsText: gcsText(v.gcs) } : {}), abnormal: abnormalOf(v, target), nurseName: nameOf.user(v.nurseId),
})

/** 某一天的流程表（00–23 時，每小時一欄） */
export function getFlowsheet(admissionId: string, date: string = today()): Promise<Flowsheet> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'admin')
    const a = find.admission(admissionId)
    if (!a) fail('找不到住院紀錄', 'NOT_FOUND')
    const t = now()
    const rows = hourlyOf(a.id).filter((v) => v.at.startsWith(date))
    const hours = FLOW_HOURS.map((h): FlowHour => {
      const from = `${date} ${h}:00`
      const to = addMinutes(from, 60)
      const inHour = rows.filter((v) => v.at.slice(11, 13) === h)
      const last = inHour[inHour.length - 1]
      return { hour: h, ...(last ? { cell: cellOf(last, a.rassTarget) } : {}), more: Math.max(0, inHour.length - 1), io: ioBetween(a.id, from, to, t), future: from > t }
    })
    const sum = (hs: FlowHour[]) => {
      const intake = hs.reduce((n, x) => n + x.io.intake, 0)
      const output = hs.reduce((n, x) => n + x.io.output, 0)
      return { intake, output, balance: intake - output }
    }
    const h = date === today() ? icuHourly(a, t) : undefined
    return {
      admissionId: a.id, date, inIcu: inIcu(a), ...(icuSince(a) ? { since: icuSince(a) } : {}), hours,
      shifts: FLOW_SHIFTS.map((s) => ({ shift: s.shift, ...sum(hours.slice(s.from, s.to)) })),
      day: sum(hours),
      ...(h ? { state: { minutes: h.minutes, late: h.late, dueAt: h.dueAt, ...(h.last ? { lastAt: h.last.at } : {}) } } : {}),
      ...(activeVent(a.id) ? { vent: { text: ventText(activeVent(a.id)!.vent) } } : {}),
      intubated: !!intubation(a.id),
      ...(a.rassTarget ? { rassTarget: { min: a.rassTarget.min, max: a.rassTarget.max } } : {}),
      canRecord: u.role === 'nurse' && inIcu(a),
    }
  })
}

export type FlowInput = Omit<VitalInput, 'gcs' | 'pupils' | 'hourly' | 'vent' | 'rass'> & {
  /** vt：插管，言語記 T */
  gcs?: { e?: number; v?: number; m?: number; vt?: boolean }
  pupils?: { l?: number; r?: number; lightL?: PupilLight | ''; lightR?: PupilLight | '' }
  rass?: number
  /** 呼吸器實測（要有使用中的呼吸器醫囑） */
  vent?: { ppeak?: number; vt?: number; rr?: number }
}

/** 記一筆流程表（加護病房的病人）：生命徵象檢查和一般的一樣，另外檢查 GCS、瞳孔 */
export function addFlowsheetEntry(input: FlowInput): Promise<FlowCell> {
  return mutate(() => {
    const nurse = requireUser('nurse')
    const a = find.admission(input.admissionId)
    if (!a || a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    if (!inIcu(a)) fail('重症流程表只給加護病房的病人（一般病房請記生命徵象）', 'CONFLICT')
    const g = input.gcs
    const p = input.pupils
    const has = (x: number | undefined) => x !== undefined && x !== null && !Number.isNaN(x)
    const hasG = !!g && ([g.e, g.v, g.m].some(has) || !!g.vt)
    const hasP = !!p && ([p.l, p.r].some(has) || !!p.lightL || !!p.lightR)
    const vm = input.vent
    const hasV = !!vm && [vm.ppeak, vm.vt, vm.rr].some(has)
    const errs = checkNeuro({ ...(hasG ? { gcs: g } : {}), ...(hasP ? { pupils: { ...p, lightL: p!.lightL || undefined, lightR: p!.lightR || undefined } } : {}) })
    if (hasG && g!.vt && !intubation(a.id)) errs.gcsV = '沒有插管：言語不能記 T'
    const rp = checkRass(input.rass)
    if (rp) errs.rass = rp
    if (hasV) {
      if (!activeVent(a.id)) errs.ventPpeak = '沒有使用中的呼吸器醫囑：不用記呼吸器'
      else Object.assign(errs, checkVentMeasure(vm!))
    }
    const { gcs: _g, pupils: _p, vent: _v, rass: _r, ...vital } = input
    const ok = !Object.keys(errs).length
    const v = buildVital(vital, nurse.id, now(), {
      hourly: true,
      ...(hasG && ok ? { gcs: { e: g!.e!, v: g!.vt ? 1 : g!.v!, m: g!.m!, ...(g!.vt ? { vt: true } : {}) } } : {}),
      ...(hasP && ok ? { pupils: { l: p!.l!, r: p!.r!, lightL: p!.lightL as PupilLight, lightR: p!.lightR as PupilLight } } : {}),
      ...(has(input.rass) && ok ? { rass: input.rass } : {}),
      ...(hasV && ok ? { vent: { ppeak: vm!.ppeak!, vt: vm!.vt!, rr: vm!.rr! } } : {}),
    }, errs)
    db.vitals.push(v)
    audit('重症流程表', `${a.admitNo} ${v.at.slice(11)}`)
    return cellOf(v, a.rassTarget)
  })
}

export interface IcuBedRow {
  bedId: string
  bedNo: string
  status: string
  admissionId?: string
  patientName?: string
  diagnosis?: string
  doctorName?: string
  nurseName?: string
  since?: string
  last?: FlowCell
  minutes?: number
  late?: boolean
  /** 最近一次評的意識與瞳孔（不一定每小時都評：最新一筆沒有時往前找，附時間） */
  neuro?: { gcs?: { sum: number; text: string; e: number; v: number; m: number; vt?: boolean; at: string; low: boolean }; pupils?: VitalRecord['pupils'] & { at: string; unequal: boolean } }
  /** 呼吸器設定、最近一次 RASS 與鎮靜目標（超出目標 out） */
  vent?: string
  rass?: { score?: number; at?: string; target?: { min: number; max: number }; out: boolean; due: boolean }
  /** 今天 00:00 到現在的輸入輸出平衡 */
  balance?: number
}

/** 床邊看板：加護病房每一床最新的數值、異常、多久沒記、今天的平衡 */
export function icuBoard(): Promise<IcuBedRow[]> {
  return query(() => {
    requireUser('nurse', 'doctor', 'admin')
    const t = now()
    return db.beds
      .filter((b) => b.ward === icuWard)
      .sort((x, y) => x.bedNo.localeCompare(y.bedNo, undefined, { numeric: true }))
      .map((b): IcuBedRow => {
        const a = b.admissionId ? find.admission(b.admissionId) : undefined
        if (!a || a.status !== 'admitted') return { bedId: b.id, bedNo: b.bedNo, status: b.status }
        const h = icuHourly(a, t)
        const nid = assignedNurse(a.id, shiftNow(t))
        const rows = h ? hourlyOf(a.id).filter((v) => v.at >= h.since) : []
        const g = rows.filter((v) => v.gcs).pop()
        const p = rows.filter((v) => v.pupils).pop()
        const neuro = {
          ...(g?.gcs ? { gcs: { ...g.gcs, sum: gcsTotal(g.gcs)!, text: gcsText(g.gcs), at: g.at, low: gcsLow(g.gcs) } } : {}),
          ...(p?.pupils ? { pupils: { ...p.pupils, at: p.at, unequal: pupilUnequal(p.pupils) } } : {}),
        }
        return {
          bedId: b.id, bedNo: b.bedNo, status: b.status, admissionId: a.id, patientName: nameOf.patient(a.patientId), diagnosis: a.diagnosis, doctorName: nameOf.doctor(a.doctorId),
          ...(nid ? { nurseName: nameOf.user(nid) } : {}),
          ...(h ? { since: h.since, minutes: h.minutes, late: h.late, ...(h.last ? { last: cellOf(h.last, a.rassTarget) } : {}) } : {}),
          ...(neuro.gcs || neuro.pupils ? { neuro } : {}),
          ...(activeVent(a.id) ? { vent: ventText(activeVent(a.id)!.vent) } : {}),
          ...(() => {
            const r = rassStateOf(a, t)
            return r ? { rass: { ...(r.last ? { score: r.last.rass!, at: r.last.at } : {}), ...(r.target ? { target: { min: r.target.min, max: r.target.max } } : {}), out: !!r.vs && r.vs !== 'in', due: r.status === 'overdue' } } : {}
          })(),
          balance: ioBetween(a.id, `${t.slice(0, 10)} 00:00`, addMinutes(t, 1), t).balance,
        }
      })
  })
}
