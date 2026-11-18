// 升壓劑（住院醫囑「加護病房」分頁）：
//   - 開立：限加護病房、要有中心靜脈導管（周邊打升壓劑會組織壞死）、DNR「不施行急救藥物」擋；同一種不重複開。
//     醫師開起始劑量、上限、體重、目標（例：MAP ≥65），系統換算流速（預混袋：每 ml 多少 mcg 或 U）
//   - 護理師在「點滴」接上（升壓劑要接 CVC）、依血壓在上限內調流速（換算的劑量同步顯示；超過上限要醫師改醫囑）
//   - 停止：目前劑量高於「可以直接停」的劑量，要先逐步調降，或寫直接停止的原因（停了護理師再把點滴停掉）
//   - SOFA 心血管依當天最高劑量；還在用升壓劑不能轉出加護病房
// 規則在 vaso-rules，內部工具在 vaso-work
import type { IpdOrder } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requirePermission, requireUser, sessionRole } from './http'
import { find, nameOf } from './views'
import { requireCare } from './care-team'
import { inIcu } from './icu-work'
import { activeLines } from './line-work'
import { activeDnr } from './flag-work'
import { stopOrderRecord } from './order-ops'
import { latestScreen } from './nutrition-work'
import { checkVasoOrder, VASO_TARGET_DEFAULT, vasoRate, vasoStopNeedsReason } from './vaso-rules'
import { activeVasoOrders, currentVaso, isVasoOrder } from './vaso-work'

const admittedOf = (id: string) => {
  const a = must(find.admission(id), '住院紀錄')
  if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
  return a
}

export interface VasoItem {
  order: IpdOrder & { doctorName: string }
  drugName: string
  unit: string
  weanTo: number
  /** 正在滴的流速與換算劑量（還沒接上＝沒有） */
  current?: { rateMlH: number; dose: number }
  /** 目前劑量高於可以直接停的劑量：停的時候要寫原因 */
  stopNeedsReason: boolean
}
export interface PatientVaso {
  admissionId: string
  inIcu: boolean
  hasCvc: boolean
  /** DNR 不施行急救藥物（強心、升壓） */
  dnrBlocked: boolean
  /** 營養篩檢最近記的體重（開立時預先帶入） */
  weightKg?: number
  drugs: { id: string; name: string; unit: string; range: [number, number]; perMl: number }[]
  items: VasoItem[]
  canOrder: boolean
  targetDefault: string
}
const itemOf = (o: IpdOrder): VasoItem => {
  const d = find.drug(o.drugId ?? '')!
  const cur = currentVaso(o)
  return { order: { ...o, doctorName: nameOf.doctor(o.doctorId) }, drugName: d.name, unit: d.vaso!.unit, weanTo: d.vaso!.weanTo, ...(cur ? { current: cur } : {}), stopNeedsReason: vasoStopNeedsReason(d.vaso!, cur?.dose) }
}

export function patientVaso(admissionId: string): Promise<PatientVaso> {
  return query(() => {
    requireUser()
    const a = must(find.admission(admissionId), '住院紀錄')
    const w = latestScreen(a.id)?.weightKg
    return {
      admissionId: a.id, inIcu: inIcu(a), hasCvc: activeLines(a.id).some((l) => l.kind === 'cvc'),
      dnrBlocked: !!activeDnr(a.patientId)?.withhold.includes('drugs'),
      ...(w ? { weightKg: w } : {}),
      drugs: db.drugs.filter((d) => d.vaso && d.active).map((d) => ({ id: d.id, name: d.name, unit: d.vaso!.unit, range: d.vaso!.range, perMl: d.vaso!.perMl })),
      items: activeVasoOrders(a.id).map(itemOf),
      canOrder: sessionRole() === 'doctor' && inIcu(a),
      targetDefault: VASO_TARGET_DEFAULT,
    }
  })
}

export function orderVaso(admissionId: string, input: { drugId: string; dose: number; max: number; weightKg: number; target: string }): Promise<VasoItem> {
  return mutate(() => {
    const u = requirePermission('order.write')
    const a = admittedOf(admissionId)
    requireCare(u.doctorId, a, '開升壓劑', { consult: false })
    const drug = must(find.drug(input.drugId), '藥品')
    if (!drug.vaso || !drug.active) failField('drugId', '請選升壓劑')
    if (!inIcu(a)) fail('升壓劑只能在加護病房使用：請先申請轉入', 'CONFLICT')
    if (!activeLines(a.id).some((l) => l.kind === 'cvc')) fail('病人沒有中心靜脈導管（CVC）：升壓劑要從中心靜脈給（周邊外滲會組織壞死），請先放置並登錄', 'CONFLICT')
    if (activeDnr(a.patientId)?.withhold.includes('drugs')) fail('病人 DNR：不施行急救藥物（強心、升壓），不能開升壓劑', 'CONFLICT')
    if (activeVasoOrders(a.id).some((o) => o.drugId === drug.id)) fail(`已經有執行中的 ${drug.name}：要改劑量範圍請先停止再開`, 'CONFLICT')
    failFields(checkVasoOrder(drug.vaso!, input))
    const v = drug.vaso!
    const t = now()
    const rate = vasoRate(v, input.dose, input.weightKg)
    const o: IpdOrder = {
      id: newId('IO'), admissionId: a.id, type: 'long', category: 'medication', drugId: drug.id,
      content: `${drug.name} ${input.dose} ${v.unit}（上限 ${input.max}，${input.weightKg} kg）@ ${rate} ml/h，目標 ${input.target.trim()}`,
      dose: 1, freq: 'QD', route: 'IV', startAt: t, status: 'active', doctorId: u.doctorId!, createdAt: t,
      infusion: { volumeMl: v.bagMl, rateMlH: rate, vaso: { dose: input.dose, max: input.max, weightKg: input.weightKg, target: input.target.trim() } },
    }
    db.ipdOrders.push(o)
    audit('開立升壓劑', `${a.admitNo} ${nameOf.patient(a.patientId)}：${o.content}`)
    return itemOf(o)
  })
}

/** 停止：劑量還高要寫原因（理想是先逐步調降到可以直接停的劑量） */
export function stopVaso(orderId: string, input: { reason?: string } = {}): Promise<{ ok: true }> {
  return mutate(() => {
    const u = requirePermission('order.write')
    const o = must(db.ipdOrders.find((x) => x.id === orderId), '醫囑')
    if (!isVasoOrder(o)) fail('這不是升壓劑醫囑')
    if (o.status !== 'active') fail('此醫囑已停止', 'CONFLICT')
    const a = admittedOf(o.admissionId)
    requireCare(u.doctorId, a, '停升壓劑', { consult: false })
    const d = find.drug(o.drugId ?? '')!
    const cur = currentVaso(o)
    const reason = input.reason?.trim()
    if (vasoStopNeedsReason(d.vaso!, cur?.dose) && !reason) failField('reason', `目前 ${cur!.dose} ${d.vaso!.unit}，高於可以直接停的 ${d.vaso!.weanTo}：請先逐步調降，或寫直接停止的原因`)
    stopOrderRecord(o, u.id, now())
    if (reason) o.stopReason = reason
    audit('停止升壓劑', `${nameOf.patient(a.patientId)}：${d.name}${cur ? `（停止時 ${cur.dose} ${d.vaso!.unit}）` : ''}${reason ? `：${reason}` : ''}`)
    return { ok: true as const }
  })
}
