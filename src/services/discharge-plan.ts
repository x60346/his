// 出院準備服務（權限「出院準備」，預設所有護理師，可指定個管師）：
//   入院 72 小時內篩選（系統自動勾年齡、管路、30 天內再住院；符合兩項以上收案）→ 需求評估 → 轉介（長照、居家護理、呼吸照護、輔具、喘息；
//   列印送出、記對方回覆）→ 出院後 7 天內電話追蹤。醫師簽准出院時收案未轉介只提醒（不擋）。規則在 discharge-plan-rules
import type { DischargePlan, DischargeReferral, DischargeReferralKind } from '@/types'
import { db, newId } from '@/mock/db'
import { ageOf, now } from '@/utils/date'
import { audit, fail, failField, must, mutate, permissionsOf, query, requirePermission, requireUser } from './http'
import { find, nameOf } from './views'
import { criterionLabel, followUpDue, needLabel, PLAN_CRITERIA, PLAN_ENROLL_FROM, PLAN_NEEDS, planUnreferred, REFERRAL_KINDS, referralKindLabel } from './discharge-plan-rules'
import { autoCriteria, followUpsDue, planOf, plannable, planScreenStateOf } from './discharge-plan-work'

export interface PlanView extends DischargePlan {
  screenedByName: string
  criteriaText: string[]
  needsText: string[]
  referralViews: (DischargeReferral & { kindLabel: string; sentByName?: string; replyByName?: string })[]
  followUpByName?: string
  unreferred: boolean
}

const planView = (p: DischargePlan): PlanView => ({
  ...p, screenedByName: nameOf.user(p.screenedBy), criteriaText: p.criteria.map(criterionLabel), needsText: p.needs.map(needLabel),
  referralViews: p.referrals.map((r) => ({ ...r, kindLabel: referralKindLabel(r.kind), ...(r.sentBy ? { sentByName: nameOf.user(r.sentBy) } : {}), ...(r.reply ? { replyByName: nameOf.user(r.reply.by) } : {}) })),
  ...(p.followUp ? { followUpByName: nameOf.user(p.followUp.by) } : {}), unreferred: planUnreferred(p),
})

const canPlan = () => {
  const u = requireUser()
  return permissionsOf(u).includes('discharge.plan')
}

export interface PatientPlan {
  admissionId: string
  /** 轉介單上印的病人資料 */
  patient: { name: string; chartNo: string; gender: string; age: number; admitNo: string; diagnosis: string; bed: string; phone: string }
  plan?: PlanView
  /** 系統自動判斷的條件（篩選時一定勾上） */
  auto: string[]
  screen: { status: 'done' | 'todo' | 'due' | 'overdue'; dueAt: string }
  /** 已出院：追蹤期限 */
  followUp?: { status: 'done' | 'due' | 'overdue'; dueAt: string }
  canEdit: boolean
  plannable: boolean
}

export function patientPlan(admissionId: string): Promise<PatientPlan> {
  return query(() => {
    requireUser('nurse', 'doctor', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const p = planOf(a.id)
    const pt = find.patient(a.patientId)
    return {
      admissionId: a.id, ...(p ? { plan: planView(p) } : {}), auto: autoCriteria(a, t),
      patient: { name: pt?.name ?? '', chartNo: pt?.chartNo ?? '', gender: pt?.gender === 'M' ? '男' : '女', age: pt ? ageOf(pt.birthDate, t.slice(0, 10)) : 0, admitNo: a.admitNo, diagnosis: a.diagnosis, bed: find.bed(a.bedId ?? '')?.bedNo ?? '', phone: pt?.phone ?? '' },
      screen: a.admittedAt ? planScreenStateOf(a, t) : { status: 'todo', dueAt: '' },
      ...(p?.enrolled && a.status === 'discharged' && a.dischargedAt ? { followUp: followUpDue(a.dischargedAt, !!p.followUp, t) } : {}),
      canEdit: canPlan(), plannable: plannable(a),
    }
  })
}

/** 篩選（可以重篩：條件改了重算收案；已經有轉介的不能改成不收案） */
export function screenPlan(admissionId: string, criteria: string[]): Promise<PlanView> {
  return mutate(() => {
    const u = requirePermission('discharge.plan')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (!plannable(a)) fail(a.obs && !a.obs.endAt ? '急診留觀不做出院準備（收住院後再篩）' : '病人目前不在住院中', 'CONFLICT')
    const t = now()
    const auto = autoCriteria(a, t)
    const keys = [...new Set([...criteria.filter((k) => PLAN_CRITERIA.some((c) => c.key === k && !c.auto)), ...auto])]
    const enrolled = keys.length >= PLAN_ENROLL_FROM
    const old = planOf(a.id)
    if (old && !enrolled && old.referrals.length) fail('已經有轉介單，不能改成不收案（要結案請記錄轉介回覆）', 'CONFLICT')
    const p: DischargePlan = old ?? { id: newId('DPL'), admissionId: a.id, screenedAt: t, screenedBy: u.id, criteria: [], auto: [], enrolled: false, needs: [], referrals: [] }
    Object.assign(p, { screenedAt: t, screenedBy: u.id, criteria: keys, auto, enrolled })
    if (!old) db.dischargePlans.push(p)
    audit('出院準備篩選', `${a.admitNo} ${nameOf.patient(a.patientId)}：${keys.length} 項${enrolled ? '，收案' : '，不收案'}`)
    return planView(p)
  })
}

/** 需求評估（收案後） */
export function saveNeeds(admissionId: string, input: { needs: string[]; assessment: string }): Promise<PlanView> {
  return mutate(() => {
    requirePermission('discharge.plan')
    const p = must(planOf(admissionId), '出院準備（請先篩選）')
    if (!p.enrolled) fail('沒有收案，不用評估需求', 'CONFLICT')
    const needs = input.needs.filter((k) => PLAN_NEEDS.some((n) => n.key === k))
    if (!needs.length) failField('needs', '請勾至少一項需求（沒有需求也勾「照顧技巧指導」）')
    if (!input.assessment?.trim()) failField('assessment', '請寫評估（主要照顧者、居家環境、出院後安排）')
    Object.assign(p, { needs, assessment: input.assessment.trim() })
    audit('出院準備評估', `${nameOf.patient(find.admission(admissionId)?.patientId)}：${needs.map(needLabel).join('、')}`)
    return planView(p)
  })
}

/** 開轉介單（同一種轉介同時只有一張還沒回覆的） */
export function addPlanReferral(admissionId: string, input: { kind: DischargeReferralKind; agency: string; note?: string }): Promise<PlanView> {
  return mutate(() => {
    const u = requirePermission('discharge.plan')
    const p = must(planOf(admissionId), '出院準備（請先篩選）')
    if (!p.enrolled) fail('沒有收案，不能轉介', 'CONFLICT')
    if (!p.needs.length) fail('請先做需求評估', 'CONFLICT')
    if (!REFERRAL_KINDS.some((k) => k.kind === input.kind)) failField('kind', '請選轉介種類')
    if (!input.agency?.trim()) failField('agency', '請寫轉介單位')
    if (p.referrals.some((r) => r.kind === input.kind && !r.reply)) fail(`已經有一張${referralKindLabel(input.kind)}轉介還沒回覆`, 'CONFLICT')
    const r: DischargeReferral = { id: newId('DRF'), kind: input.kind, agency: input.agency.trim(), ...(input.note?.trim() ? { note: input.note.trim() } : {}), createdAt: now(), createdBy: u.id }
    p.referrals.push(r)
    audit('出院準備轉介', `${nameOf.patient(find.admission(admissionId)?.patientId)}：${referralKindLabel(r.kind)} → ${r.agency}`)
    return planView(p)
  })
}

/** 送出（列印傳真給對方）：記第一次送出的時間 */
export function sendPlanReferral(admissionId: string, referralId: string): Promise<PlanView> {
  return mutate(() => {
    const u = requirePermission('discharge.plan')
    const p = must(planOf(admissionId), '出院準備')
    const r = must(p.referrals.find((x) => x.id === referralId), '轉介單')
    if (!r.sentAt) Object.assign(r, { sentAt: now(), sentBy: u.id })
    return planView(p)
  })
}

/** 對方回覆：核定或未核定（未核定要寫原因） */
export function replyPlanReferral(admissionId: string, referralId: string, input: { status: 'approved' | 'denied'; note?: string }): Promise<PlanView> {
  return mutate(() => {
    const u = requirePermission('discharge.plan')
    const p = must(planOf(admissionId), '出院準備')
    const r = must(p.referrals.find((x) => x.id === referralId), '轉介單')
    if (!r.sentAt) fail('還沒送出', 'CONFLICT')
    if (r.reply) fail('已經記過回覆了', 'CONFLICT')
    if (!['approved', 'denied'].includes(input.status)) failField('status', '請選核定或未核定')
    if (input.status === 'denied' && !input.note?.trim()) failField('note', '未核定：請寫原因')
    r.reply = { status: input.status, ...(input.note?.trim() ? { note: input.note.trim() } : {}), at: now(), by: u.id }
    audit('出院準備轉介回覆', `${referralKindLabel(r.kind)}：${input.status === 'approved' ? '核定' : '未核定'}`)
    return planView(p)
  })
}

/** 出院後電話追蹤（出院後才能記） */
export function recordFollowUp(admissionId: string, input: { reached: boolean; result: string }): Promise<PlanView> {
  return mutate(() => {
    const u = requirePermission('discharge.plan')
    const a = must(find.admission(admissionId), '住院紀錄')
    const p = must(planOf(a.id), '出院準備')
    if (!p.enrolled) fail('沒有收案，不用追蹤', 'CONFLICT')
    if (a.status !== 'discharged') fail('還沒出院', 'CONFLICT')
    if (p.followUp) fail('已經追蹤過了', 'CONFLICT')
    if (!input.result?.trim()) failField('result', input.reached ? '請寫追蹤結果（服務是否到位、照顧狀況）' : '請寫聯絡不到的情形（打了幾次、改寄信）')
    p.followUp = { at: now(), by: u.id, reached: !!input.reached, result: input.result.trim() }
    audit('出院準備追蹤', `${nameOf.patient(a.patientId)}：${input.reached ? '聯絡到' : '聯絡不到'}`)
    return planView(p)
  })
}

export interface PlanWorkItem {
  admissionId: string
  patientName: string
  chartNo: string
  age: number
  ward: string
  bedNo: string
  diagnosis: string
  /** screen 待篩選、needs 收案待評估、refer 有需求待轉介或待回覆、follow 出院後待追蹤 */
  stage: 'screen' | 'needs' | 'refer' | 'follow'
  text: string
  overdue: boolean
  dischargeReady: boolean
}

/** 出院準備工作清單（個管師）：待篩選（快到期、逾時）、待評估、待轉介／待回覆、出院後待追蹤 */
export function listPlanWork(): Promise<PlanWorkItem[]> {
  return query(() => {
    requirePermission('discharge.plan')
    const t = now()
    const base = (aId: string) => {
      const a = find.admission(aId)!
      const p = find.patient(a.patientId)
      const bed = find.bed(a.bedId ?? '')
      return { admissionId: a.id, patientName: p?.name ?? '', chartNo: p?.chartNo ?? '', age: p ? ageOf(p.birthDate, t.slice(0, 10)) : 0, ward: bed?.ward ?? '', bedNo: bed?.bedNo ?? '', diagnosis: a.diagnosis, dischargeReady: a.status === 'admitted' && !!a.dischargeSummary?.signedAt }
    }
    const out: PlanWorkItem[] = []
    for (const a of db.admissions.filter(plannable)) {
      const p = planOf(a.id)
      if (!p) {
        const s = planScreenStateOf(a, t)
        out.push({ ...base(a.id), stage: 'screen', text: `入院 72 小時內篩選（${s.dueAt.slice(5)} 前）`, overdue: s.status === 'overdue' })
      } else if (p.enrolled && !p.needs.length) out.push({ ...base(a.id), stage: 'needs', text: `已收案（${p.criteria.map(criterionLabel).join('、')}）：待需求評估`, overdue: false })
      else if (p.enrolled) {
        const waiting = p.referrals.filter((r) => !r.reply)
        if (planUnreferred(p)) out.push({ ...base(a.id), stage: 'refer', text: `需求：${p.needs.map(needLabel).join('、')}；還沒轉介`, overdue: !!a.dischargeSummary?.signedAt })
        else if (waiting.length) out.push({ ...base(a.id), stage: 'refer', text: `待回覆：${waiting.map((r) => `${referralKindLabel(r.kind)}${r.sentAt ? '' : '（未送出）'}`).join('、')}`, overdue: false })
      }
    }
    for (const x of followUpsDue(t)) out.push({ ...base(x.admission.id), stage: 'follow', text: `出院 ${x.admission.dischargedAt!.slice(5, 10)}：${x.due.dueAt.slice(5, 10)} 前電話追蹤`, overdue: x.due.status === 'overdue' })
    const rank = { follow: 0, screen: 1, refer: 2, needs: 3 }
    return out.sort((x, y) => Number(y.overdue) - Number(x.overdue) || rank[x.stage] - rank[y.stage] || x.bedNo.localeCompare(y.bedNo))
  })
}
