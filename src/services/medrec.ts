// 入院用藥整合：護理師或藥師建「居家用藥」清單（自動帶入最近 90 天院內門診處方，可刪、可加院外的藥）；
// 主治逐項決定——續用（先開住院醫囑，系統連到同一個藥的執行中醫囑）、暫停（寫原因）、改藥（寫改成什麼），全部決定才算完成。
// 入院 24 小時內要完成（主治首頁逾時標紅）；出院病摘列出入院時暫停的居家藥提醒。規則在 medrec-rules
import type { HomeMed } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser, sessionRole } from './http'
import { checkHomeMedDecision, HOME_MED_DECISION_LABEL, homeMedsFromOpd, medRecState, type MedRecState } from './medrec-rules'
import { doseUnitOf } from './billing'
import { checkRxAlerts, type RxAlert } from './interaction-rules'
import { drugRefs } from './rx-alert-work'
import { timingText } from './drug-rules'
import { requireCare } from './care-team'
import { find, nameOf } from './views'

export interface HomeMedView extends HomeMed {
  drugName: string
  /** 「每次 1 TAB BID PO」 */
  doseText: string
  decisionLabel?: string
  decidedByName?: string
  /** 同一個藥這次住院有執行中的醫囑（續用時連它） */
  activeOrderId?: string
  activeOrderText?: string
}

export interface MedRecView {
  admissionId: string
  state: MedRecState
  dueAt: string
  overdue: boolean
  left: number
  builtByName?: string
  builtAt?: string
  completedAt?: string
  completedByName?: string
  items: HomeMedView[]
  /** 還沒建清單：系統從門診處方帶出的建議（護理師、藥師勾選後建立） */
  draft: HomeMedView[]
  canBuild: boolean
  canDecide: boolean
}

function itemView(admissionId: string, x: HomeMed): HomeMedView {
  const d = x.drugId ? find.drug(x.drugId) : undefined
  const active = x.drugId ? db.ipdOrders.find((o) => o.admissionId === admissionId && o.drugId === x.drugId && o.status === 'active' && o.category === 'medication') : undefined
  return {
    ...x, drugName: d?.name ?? x.name,
    doseText: x.dose ? `每次 ${x.dose} ${d ? doseUnitOf(d) : ''} ${x.freq ?? ''} ${x.route ?? ''}`.replace(/\s+/g, ' ').trim() : x.freq ?? '',
    ...(x.decision ? { decisionLabel: HOME_MED_DECISION_LABEL[x.decision], decidedByName: nameOf.user(x.decidedBy) } : {}),
    ...(active ? { activeOrderId: active.id, activeOrderText: `${active.content} 每次 ${active.dose} ${active.freq}` } : {}),
  }
}

/** 門診處方帶出的建議（還沒建清單時） */
function draftOf(admissionId: string): HomeMedView[] {
  const a = must(find.admission(admissionId), '住院紀錄')
  return homeMedsFromOpd(db.encounters.filter((e) => e.patientId === a.patientId), a.admittedAt ?? now()).map((m, i) =>
    itemView(a.id, { id: `draft-${i}`, drugId: m.drugId, name: find.drug(m.drugId)?.name ?? m.drugId, dose: m.dose, freq: m.freq, route: m.route, source: 'opd', lastDate: m.lastDate }),
  )
}

export function getMedRec(admissionId: string): Promise<MedRecView> {
  return query(() => {
    requireUser('doctor', 'nurse', 'pharmacist')
    const a = must(find.admission(admissionId), '住院紀錄')
    const m = a.medRec
    const st = medRecState(m, a.admittedAt ?? now(), now())
    const role = sessionRole()
    return {
      admissionId: a.id, ...st,
      ...(m ? { builtByName: nameOf.user(m.builtBy), builtAt: m.builtAt, ...(m.completedAt ? { completedAt: m.completedAt, completedByName: nameOf.user(m.completedBy) } : {}) } : {}),
      items: (m?.items ?? []).map((x) => itemView(a.id, x)),
      draft: m ? [] : draftOf(a.id),
      canBuild: !m && a.status === 'admitted' && (role === 'nurse' || role === 'pharmacist'),
      canDecide: !!m && !m.completedAt && a.status === 'admitted' && role === 'doctor',
    }
  })
}

export interface HomeMedInput {
  drugId?: string
  name?: string
  dose?: number
  freq?: string
  route?: string
  source: 'opd' | 'outside'
  lastDate?: string
}

/** 護理師或藥師建立清單（只能建一次）：院內的要是主檔有的藥；院外的要寫名稱。沒有居家用藥就送空清單＝直接完成 */
export function buildMedRec(admissionId: string, items: HomeMedInput[]): Promise<MedRecView> {
  return mutate(() => {
    const u = requireUser('nurse', 'pharmacist')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人不在住院中', 'CONFLICT')
    if (a.medRec) fail('居家用藥清單已經建立了', 'CONFLICT')
    const errors: Record<string, string> = {}
    const list: HomeMed[] = (items ?? []).map((x, i) => {
      const d = x.drugId ? find.drug(x.drugId) : undefined
      if (x.drugId && !d) errors[`item${i}`] = '找不到這個藥'
      if (!x.drugId && !x.name?.trim()) errors[`item${i}`] = '院外的藥要寫名稱'
      return {
        id: newId('HM'), ...(d ? { drugId: d.id } : {}), name: d?.name ?? x.name!.trim(), ...(x.dose ? { dose: Number(x.dose) } : {}), ...(x.freq ? { freq: x.freq } : {}), ...(x.route ? { route: x.route } : {}),
        source: d && x.source === 'opd' ? 'opd' : 'outside', ...(x.lastDate ? { lastDate: x.lastDate } : {}),
      }
    })
    failFields(errors)
    const t = now()
    a.medRec = { items: list, builtBy: u.id, builtAt: t, ...(list.length ? {} : { completedAt: t, completedBy: u.id }) }
    audit('居家用藥清單', `${a.admitNo} ${nameOf.patient(a.patientId)}：${list.length ? list.map((x) => x.name).join('、') : '無居家用藥'}`)
    return getMedRecSync(a.id)
  })
}

const getMedRecSync = (admissionId: string): MedRecView => {
  const a = find.admission(admissionId)!
  return { admissionId, ...medRecState(a.medRec, a.admittedAt ?? now(), now()), items: (a.medRec?.items ?? []).map((x) => itemView(a.id, x)), draft: [], canBuild: false, canDecide: !a.medRec?.completedAt }
}

/**
 * 主治（照護團隊）決定一項：續用（院內的藥要先有同一個藥的執行中住院醫囑，系統連上）、暫停（原因）、改藥（改成什麼）。
 * 全部決定完＝整合完成（寫稽核）
 */
export function decideHomeMed(admissionId: string, itemId: string, input: { decision: HomeMed['decision']; reason?: string }): Promise<MedRecView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const a = must(find.admission(admissionId), '住院紀錄')
    requireCare(u.doctorId, a, '整合居家用藥', { consult: false })
    const m = a.medRec
    if (!m) fail('護理師或藥師還沒建居家用藥清單', 'CONFLICT')
    if (m!.completedAt) fail('用藥整合已經完成', 'CONFLICT')
    const x = must(m!.items.find((i) => i.id === itemId), '居家用藥')
    failFields(checkHomeMedDecision(x, input))
    let orderId: string | undefined
    if (input.decision === 'continue' && x.drugId) {
      orderId = db.ipdOrders.find((o) => o.admissionId === a.id && o.drugId === x.drugId && o.status === 'active' && o.category === 'medication')?.id
      if (!orderId) failField('decision', `續用請先開立 ${x.name} 的住院醫囑（按「續用」會帶入開醫囑對話框）`)
    }
    const t = now()
    Object.assign(x, { decision: input.decision, decidedBy: u.id, decidedAt: t, ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}), ...(orderId ? { orderId } : {}) })
    if (m!.items.every((i) => i.decision)) Object.assign(m!, { completedAt: t, completedBy: u.id })
    audit('用藥整合', `${a.admitNo} ${x.name}：${HOME_MED_DECISION_LABEL[input.decision!]}${input.reason?.trim() ? `（${input.reason.trim()}）` : ''}${m!.completedAt === t ? '；整合完成' : ''}`)
    return getMedRecSync(a.id)
  })
}

// ---------- 出院用藥整合 ----------

export interface DischargeRecon {
  admissionId: string
  /** 居家用藥（入院時怎麼決定的），出院要逐項決定恢復或停用 */
  home: (HomeMedView & { admitText: string })[]
  /** 住院中在用、沒有帶回家的（不是居家用藥、也不在出院帶藥）：只提醒 */
  inpatientOnly: { drugId: string; text: string }[]
  /** 出院帶藥和恢復的居家藥之間：成分重複、同類重複、交互作用 */
  alerts: RxAlert[]
}

/** 出院病摘的對照表：畫面上正在編的出院帶藥、選了恢復的居家藥（還沒存檔也要即時比） */
export function dischargeReconOf(admissionId: string, x: { dischargeDrugIds: string[]; resumeHomeIds: string[] }): Promise<DischargeRecon> {
  return query(() => {
    requireUser('doctor', 'nurse', 'pharmacist')
    const a = must(find.admission(admissionId), '住院紀錄')
    const items = a.medRec?.items ?? []
    const homeDrugs = new Set(items.map((i) => i.drugId).filter(Boolean))
    const dis = new Set(x.dischargeDrugIds ?? [])
    const inpatientOnly = db.ipdOrders
      .filter((o) => o.admissionId === a.id && o.status === 'active' && o.category === 'medication' && o.type === 'long' && o.freq !== 'PRN' && o.drugId && !homeDrugs.has(o.drugId) && !dis.has(o.drugId))
      .map((o) => ({ drugId: o.drugId!, text: `${o.content} 每次 ${o.dose} ${o.freq} ${o.route}` }))
    const resumed = items.filter((i) => i.drugId && (x.resumeHomeIds ?? []).includes(i.id)).map((i) => find.drug(i.drugId!)).filter((d): d is NonNullable<typeof d> => !!d)
    // 同一個藥（恢復＋出院又開一份）是補藥，不算重複；不同藥才比
    // 規則把沒有用藥期限的「病人在用的藥」標成「執行中」（住院醫囑的說法）：這裡是居家藥，改成看得懂的字
    const alerts = checkRxAlerts(drugRefs([...dis]), resumed.filter((d) => !dis.has(d.id)).map((d) => ({ drug: { id: d.id, name: d.name, generic: d.generic }, source: '居家用藥' })))
      .map((x) => ({ ...x, title: x.title.replace('（執行中）', '（居家用藥，出院後恢復）'), ...(x.other ? { other: x.other.replace('居家用藥 開的', '居家用藥（恢復）') } : {}) }))
    return {
      admissionId: a.id,
      home: items.map((i) => ({ ...itemView(a.id, i), admitText: i.decision ? `入院時${HOME_MED_DECISION_LABEL[i.decision]}${i.reason ? `（${i.reason}）` : ''}` : '入院時未決定' })),
      inpatientOnly, alerts,
    }
  })
}

export interface DischargeMedList {
  patientName: string
  chartNo: string
  admitNo: string
  allergies: string[]
  dischargedOn: string
  doctorName: string
  /** 出院帶藥：藥名、怎麼吃、幾天 */
  meds: { name: string; nameZh: string; how: string; days: number }[]
  /** 恢復吃的居家藥（家裡的藥照原本吃） */
  resume: { name: string; how: string }[]
  /** 停用：不要再吃 */
  stop: { name: string; reason: string }[]
}

/** 給病人的「出院用藥清單」（列印）：出院帶藥、繼續吃家裡的藥、停用的藥 */
export function dischargeMedList(admissionId: string): Promise<DischargeMedList> {
  return query(() => {
    requireUser('doctor', 'nurse', 'pharmacist')
    const a = must(find.admission(admissionId), '住院紀錄')
    const ds = a.dischargeSummary
    if (!ds) fail('還沒有出院病摘', 'CONFLICT')
    const p = find.patient(a.patientId)
    const how = (dose?: number, freq?: string, drugId?: string) => {
      const d = drugId ? find.drug(drugId) : undefined
      return [dose ? `每次 ${dose} ${d ? doseUnitOf(d) : ''}` : '', freq ? find.freq(freq)?.label ?? freq : ''].filter(Boolean).join('，')
    }
    const plan = ds!.homeMedPlan ?? {}
    const items = a.medRec?.items ?? []
    return {
      patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', admitNo: a.admitNo, allergies: p?.allergies ?? [], dischargedOn: (a.dischargedAt ?? ds!.signedAt ?? ds!.writtenAt).slice(0, 10), doctorName: nameOf.doctor(ds!.doctorId),
      meds: (ds!.meds ?? []).map((m) => {
        const d = find.drug(m.drugId)
        const tm = d ? timingText(m.timing ?? d.timing, m.freq, m.route) : ''
        return { name: d?.name ?? m.drugId, nameZh: d?.nameZh ?? '', how: [how(m.dose, m.freq, m.drugId), tm].filter(Boolean).join('，'), days: m.days }
      }),
      resume: items.filter((i) => plan[i.id]?.resume).map((i) => ({ name: i.drugId ? find.drug(i.drugId)?.name ?? i.name : i.name, how: how(i.dose, i.freq, i.drugId) })),
      stop: items.filter((i) => plan[i.id] && !plan[i.id].resume).map((i) => ({ name: i.drugId ? find.drug(i.drugId)?.name ?? i.name : i.name, reason: plan[i.id].reason ?? '' })),
    }
  })
}
