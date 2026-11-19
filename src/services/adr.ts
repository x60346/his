// 藥物不良反應通報（ADR）：醫師、護理師在病人分頁「不良反應」通報（懷疑的藥要是這次住院給過的）；
// 藥師在「住院藥局 > 不良反應」用 Naranjo 量表評估因果，很可能以上可勾選加入病人過敏紀錄（之後開藥的過敏檢查會擋）。
// 嚴重型（過敏性休克、SJS）24 小時內要評估。規則在 adr-rules（純函式）
import type { AdrReport } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { ADR_SERIOUS, ADR_SEVERITY_LABEL, adrDueAt, CAUSALITY_LABEL, canAddAllergy, causalityOf, checkAdrInput, NARANJO, naranjoScore, type NaranjoAnswer } from './adr-rules'
import { allergenOfDrug } from './allergy'
import { find, nameOf } from './views'

export interface AdrView extends AdrReport {
  drugName: string
  patientName: string
  bedNo: string
  admitNo: string
  severityLabel: string
  seriousLabel?: string
  reportedByName: string
  /** 嚴重型的評估期限與是否逾時（還沒評估才有意義） */
  dueAt?: string
  overdue: boolean
  causalityLabel?: string
  assessedByName?: string
  /** 評估時建議加入的過敏原（例：Ceftriaxone → Cephalosporin） */
  allergen: string
  allergies: string[]
}

function view(r: AdrReport, t: string = now()): AdrView {
  const a = r.admissionId ? find.admission(r.admissionId) : undefined
  const d = r.drugId ? find.drug(r.drugId) : undefined
  const due = adrDueAt(r)
  const p = find.patient(r.patientId)
  return {
    ...r, drugName: d?.name ?? r.agent ?? r.drugId, patientName: p?.name ?? '', bedNo: find.bed(a?.bedId ?? '')?.bedNo ?? '', admitNo: a?.admitNo ?? '',
    severityLabel: ADR_SEVERITY_LABEL[r.severity], ...(r.serious ? { seriousLabel: ADR_SERIOUS.find((x) => x.key === r.serious)?.label } : {}),
    reportedByName: nameOf.user(r.reportedBy), ...(due ? { dueAt: due } : {}), overdue: !r.assessment && !!due && t > due,
    ...(r.assessment ? { causalityLabel: CAUSALITY_LABEL[r.assessment.causality], assessedByName: nameOf.user(r.assessment.by) } : {}),
    allergen: d ? allergenOfDrug(d) : r.agent ?? r.drugId, allergies: p?.allergies ?? [],
  }
}

/** 這次住院給過的藥（給藥紀錄「已給」）：通報時只能選這些 */
function givenDrugs(admissionId: string): { drugId: string; name: string; lastGivenAt: string }[] {
  const out = new Map<string, { drugId: string; name: string; lastGivenAt: string }>()
  for (const m of db.mar.filter((x) => x.admissionId === admissionId && x.status === 'given' && x.executedAt)) {
    const o = db.ipdOrders.find((x) => x.id === m.orderId)
    if (!o?.drugId) continue
    const cur = out.get(o.drugId)
    if (!cur || m.executedAt! > cur.lastGivenAt) out.set(o.drugId, { drugId: o.drugId, name: find.drug(o.drugId)?.name ?? o.drugId, lastGivenAt: m.executedAt! })
  }
  return [...out.values()].sort((a, b) => b.lastGivenAt.localeCompare(a.lastGivenAt))
}

/** 病人分頁：這次住院的通報＋可以選的藥 */
export function patientAdrs(admissionId: string): Promise<{ admissionId: string; reports: AdrView[]; drugs: ReturnType<typeof givenDrugs> }> {
  return query(() => {
    requireUser('doctor', 'nurse', 'pharmacist')
    must(find.admission(admissionId), '住院紀錄')
    return { admissionId, reports: db.adrReports.filter((r) => r.admissionId === admissionId).sort((a, b) => b.reportedAt.localeCompare(a.reportedAt)).map((r) => view(r)), drugs: givenDrugs(admissionId) }
  })
}

export interface AdrInput {
  admissionId: string
  drugId: string
  onsetAt: string
  symptoms: string
  severity: AdrReport['severity']
  serious?: AdrReport['serious']
  action: string
}

/** 醫師、護理師通報（住院中）：懷疑的藥要是這次住院給過的 */
export function reportAdr(input: AdrInput): Promise<AdrView> {
  return mutate(() => {
    const u = requireUser('doctor', 'nurse')
    const a = must(find.admission(input.admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人不在住院中', 'CONFLICT')
    const t = now()
    failFields(checkAdrInput(input, t))
    if (!givenDrugs(a.id).some((d) => d.drugId === input.drugId)) failField('drugId', '這次住院沒有給過這個藥（請選給藥紀錄裡有的）')
    if (input.serious && !ADR_SERIOUS.some((x) => x.key === input.serious)) failField('serious', '嚴重型只有過敏性休克、SJS／TEN')
    const r: AdrReport = {
      id: newId('ADR'), admissionId: a.id, patientId: a.patientId, drugId: input.drugId, onsetAt: input.onsetAt, symptoms: input.symptoms.trim(),
      severity: input.severity, ...(input.serious ? { serious: input.serious } : {}), action: input.action.trim(), reportedBy: u.id, reportedAt: t,
    }
    db.adrReports.push(r)
    audit('藥物不良反應通報', `${a.admitNo} ${nameOf.patient(a.patientId)}：${find.drug(r.drugId)?.name} ${r.symptoms}（${ADR_SEVERITY_LABEL[r.severity]}${r.serious ? `・${ADR_SERIOUS.find((x) => x.key === r.serious)?.label}` : ''}）`)
    return view(r, t)
  })
}

export interface AdrStats {
  from: string
  total: number
  bySeverity: { key: AdrReport['severity']; label: string; count: number }[]
  serious: number
  byCausality: { label: string; count: number }[]
  pending: number
}

/** 藥師：待評估（嚴重型、逾時的在前）、最近 30 天評估過的、30 天統計 */
export function listAdrReview(): Promise<{ pending: AdrView[]; done: AdrView[]; stats: AdrStats }> {
  return query(() => {
    requireUser('pharmacist')
    const t = now()
    const from = addDays(t.slice(0, 10), -29)
    const pending = db.adrReports
      .filter((r) => !r.assessment)
      .map((r) => view(r, t))
      .sort((x, y) => Number(y.overdue) - Number(x.overdue) || Number(!!y.serious) - Number(!!x.serious) || x.reportedAt.localeCompare(y.reportedAt))
    const recent = db.adrReports.filter((r) => r.reportedAt.slice(0, 10) >= from)
    const done = db.adrReports.filter((r) => r.assessment && r.assessment.at.slice(0, 10) >= from).sort((a, b) => b.assessment!.at.localeCompare(a.assessment!.at)).map((r) => view(r, t))
    return {
      pending, done,
      stats: {
        from, total: recent.length, serious: recent.filter((r) => r.serious).length, pending: pending.length,
        bySeverity: (Object.keys(ADR_SEVERITY_LABEL) as AdrReport['severity'][]).map((k) => ({ key: k, label: ADR_SEVERITY_LABEL[k], count: recent.filter((r) => r.severity === k).length })),
        byCausality: Object.entries(CAUSALITY_LABEL).map(([k, label]) => ({ label, count: recent.filter((r) => r.assessment?.causality === k).length })),
      },
    }
  })
}

/** 藥師評估：10 題都要答（不知道也要選）；很可能以上可勾選加入過敏（存疑、可能的不能加） */
export function assessAdr(id: string, input: { answers: NaranjoAnswer[]; note?: string; addAllergy?: boolean }): Promise<AdrView> {
  return mutate(() => {
    const u = requireUser('pharmacist')
    const r = must(db.adrReports.find((x) => x.id === id), '不良反應通報')
    if (r.assessment) fail('這筆已經評估過了', 'CONFLICT')
    const answers = input.answers ?? []
    if (answers.length !== NARANJO.length || answers.some((x) => !['yes', 'no', 'unknown'].includes(x))) failField('answers', `Naranjo 量表 ${NARANJO.length} 題都要回答（不確定選「不知道」）`)
    const score = naranjoScore(answers)
    const causality = causalityOf(score)
    if (input.addAllergy && !canAddAllergy(causality)) failField('addAllergy', `判定「${CAUSALITY_LABEL[causality]}」（${score} 分）：很可能以上才能加入過敏`)
    const p = must(find.patient(r.patientId), '病患')
    const d = r.drugId ? find.drug(r.drugId) : undefined
    const allergen = d ? allergenOfDrug(d) : r.agent ?? r.drugId
    const added = input.addAllergy && !p.allergies.includes(allergen) ? allergen : undefined
    if (added) p.allergies.push(added)
    r.assessment = { by: u.id, at: now(), answers, score, causality, note: input.note?.trim() ?? '', ...(input.addAllergy ? { allergyAdded: allergen } : {}) }
    audit('藥物不良反應評估', `${nameOf.patient(r.patientId)} ${d?.name ?? r.agent}：Naranjo ${score} 分（${CAUSALITY_LABEL[causality]}）${input.addAllergy ? `；加入過敏 ${allergen}${added ? '' : '（已有紀錄）'}` : ''}`)
    return view(r)
  })
}
