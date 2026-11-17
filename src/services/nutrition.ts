// 飲食與營養：護理師入院 48 小時內營養篩檢（簡化 NRS-2002）→ ≥3 分列營養師待評估 → 營養師寫評估與建議（不開醫囑）→ 主治已閱；
// 每餐依病房的送餐清單（以那一餐時間有效的飲食醫囑為準，可列印）。規則在 nutrition-rules
import type { DietKind, NutritionAssessment, NutritionScreen, TubeFeedPlan } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, ageOf, now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requireUser } from './http'
import { find, nameOf } from './views'
import { careRoleOf } from './care-team'
import { bmiOf, checkNutritionScreen, checkTubePlan, tubePlanText, dietAt, dietLabel, MEALS, NUTRITION_RISK_FROM, nutritionScore, type MealKey } from './nutrition-rules'
import { currentDiet, latestScreen, needsDietitian, screenable, screenStateOf } from './nutrition-work'

export interface NutritionScreenView extends NutritionScreen {
  byName: string
  bmi?: number
  risk: boolean
}
export interface NutritionAssessmentView extends NutritionAssessment {
  byName: string
  tubeText?: string
  seenByName?: string
}

const screenView = (s: NutritionScreen): NutritionScreenView => ({ ...s, byName: nameOf.user(s.by), ...(bmiOf(s.heightCm, s.weightKg) ? { bmi: bmiOf(s.heightCm, s.weightKg) } : {}), risk: s.score >= NUTRITION_RISK_FROM })
const assessView = (x: NutritionAssessment): NutritionAssessmentView => ({ ...x, byName: nameOf.user(x.by), ...(x.tube ? { tubeText: tubePlanText(x.tube, find.tubeFormula(x.tube.formulaId)) } : {}), ...(x.seenBy ? { seenByName: nameOf.user(x.seenBy) } : {}) })

export interface PatientNutrition {
  admissionId: string
  age: number
  /** 目前的飲食醫囑 */
  diet?: { kind: DietKind; label: string; content: string }
  screens: NutritionScreenView[]
  due: { status: 'done' | 'todo' | 'due' | 'overdue'; dueAt: string }
  /** 留觀中不篩 */
  screenable: boolean
  needsDietitian: boolean
  assessments: NutritionAssessmentView[]
  canScreen: boolean
  canAssess: boolean
  canAck: boolean
}

export function patientNutrition(admissionId: string): Promise<PatientNutrition> {
  return query(() => {
    const u = requireUser('nurse', 'doctor', 'diet', 'admin')
    const a = must(find.admission(admissionId), '住院紀錄')
    const t = now()
    const d = currentDiet(a.id, t)
    const p = find.patient(a.patientId)
    return {
      admissionId: a.id, age: p ? ageOf(p.birthDate, t.slice(0, 10)) : 0,
      ...(d ? { diet: { kind: d.kind, label: dietLabel(d.kind), content: d.content } } : {}),
      screens: db.nutritionScreens.filter((s) => s.admissionId === a.id).sort((x, y) => y.at.localeCompare(x.at)).map(screenView),
      due: screenStateOf(a, t).due, screenable: screenable(a), needsDietitian: needsDietitian(a),
      assessments: db.nutritionAssessments.filter((x) => x.admissionId === a.id).sort((x, y) => y.at.localeCompare(x.at)).map(assessView),
      canScreen: u.role === 'nurse' && screenable(a), canAssess: u.role === 'diet' && a.status === 'admitted', canAck: u.role === 'doctor' && !!careRoleOf(u.doctorId, a) && careRoleOf(u.doctorId, a)!.kind !== 'consult',
    }
  })
}

export interface ScreenInput {
  impaired: 0 | 1 | 2 | 3
  severity: 0 | 1 | 2 | 3
  heightCm?: number
  weightKg?: number
}

/** 營養篩檢（護理師）：70 歲以上依病人生日自動加 1 分；可以重篩（病情變化），以最新一次為準 */
export function saveNutritionScreen(admissionId: string, input: ScreenInput): Promise<NutritionScreenView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (!screenable(a)) fail(a.obs && !a.obs.endAt ? '急診留觀不做營養篩檢（收住院後再篩）' : '病人目前不在住院中', 'CONFLICT')
    failFields(checkNutritionScreen(input))
    const t = now()
    const p = must(find.patient(a.patientId), '病人')
    const age70 = ageOf(p.birthDate, t.slice(0, 10)) >= 70
    const num = (x?: number) => (x === undefined || x === null || Number.isNaN(x) ? undefined : Number(x))
    const s: NutritionScreen = {
      id: newId('NS'), admissionId: a.id, at: t, by: u.id, impaired: input.impaired, severity: input.severity, age70,
      score: nutritionScore({ impaired: input.impaired, severity: input.severity, age70 }),
      ...(num(input.heightCm) ? { heightCm: num(input.heightCm) } : {}), ...(num(input.weightKg) ? { weightKg: num(input.weightKg) } : {}),
    }
    db.nutritionScreens.push(s)
    audit('營養篩檢', `${a.admitNo} ${p.name}：${s.score} 分${s.score >= NUTRITION_RISK_FROM ? '（有營養風險，營養師待評估）' : ''}`)
    return screenView(s)
  })
}

export interface NutritionWorkItem {
  admissionId: string
  patientName: string
  chartNo: string
  ward: string
  bedNo: string
  deptName: string
  doctorName: string
  diagnosis: string
  diet?: string
  score: number
  screenedAt: string
  /** 之前評估過（重篩又 ≥3） */
  reassess: boolean
}

/** 營養師工作清單：待評估（篩檢 ≥3 分、之後沒評估；篩得早的在前）、最近 7 天寫過的評估 */
export function listNutritionWork(): Promise<{ toAssess: NutritionWorkItem[]; recent: (NutritionAssessmentView & { patientName: string; bedNo: string })[] }> {
  return query(() => {
    requireUser('diet', 'admin')
    const t = now()
    const toAssess = db.admissions.filter((a) => screenable(a) && needsDietitian(a)).map((a): NutritionWorkItem => {
      const s = latestScreen(a.id)!
      const bed = find.bed(a.bedId ?? '')
      return {
        admissionId: a.id, patientName: nameOf.patient(a.patientId), chartNo: find.patient(a.patientId)?.chartNo ?? '', ward: bed?.ward ?? '', bedNo: bed?.bedNo ?? '',
        deptName: nameOf.dept(a.deptId), doctorName: nameOf.doctor(a.doctorId), diagnosis: a.diagnosis, diet: currentDiet(a.id, t)?.content, score: s.score, screenedAt: s.at,
        reassess: db.nutritionAssessments.some((x) => x.admissionId === a.id),
      }
    }).sort((x, y) => x.screenedAt.localeCompare(y.screenedAt))
    const since = addDays(today(), -7)
    const recent = db.nutritionAssessments.filter((x) => x.at.slice(0, 10) >= since).sort((x, y) => y.at.localeCompare(x.at)).slice(0, 30).map((x) => {
      const a = find.admission(x.admissionId)
      return { ...assessView(x), patientName: nameOf.patient(a?.patientId), bedNo: find.bed(a?.bedId ?? '')?.bedNo ?? '' }
    })
    return { toAssess, recent }
  })
}

export interface AssessmentInput {
  kcal?: number
  protein?: number
  /** 管灌建議（選填）：主治可以一鍵帶入成醫囑 */
  tube?: TubeFeedPlan
  assessment: string
  recommendation: string
}

/** 營養評估（營養師）：評估與建議（飲食種類、熱量、補充品），由主治決定要不要開醫囑 */
export function saveNutritionAssessment(admissionId: string, input: AssessmentInput): Promise<NutritionAssessmentView> {
  return mutate(() => {
    const u = requireUser('diet')
    const a = must(find.admission(admissionId), '住院紀錄')
    if (a.status !== 'admitted') fail('病人目前不在住院中', 'CONFLICT')
    const f: Record<string, string> = {}
    if (!input.assessment?.trim()) f.assessment = '請寫評估（飲食攝取、體重變化、生化值）'
    if (!input.recommendation?.trim()) f.recommendation = '請寫建議（飲食種類、熱量、蛋白質、補充品）'
    const num = (x?: number) => (x === undefined || x === null || Number.isNaN(x) || (x as unknown) === '' ? undefined : Number(x))
    if (num(input.kcal) !== undefined && !(num(input.kcal)! >= 500 && num(input.kcal)! <= 4000)) f.kcal = '熱量 500–4000 kcal'
    if (num(input.protein) !== undefined && !(num(input.protein)! >= 10 && num(input.protein)! <= 250)) f.protein = '蛋白質 10–250 g'
    if (input.tube) {
      Object.assign(f, checkTubePlan(input.tube))
      if (input.tube.formulaId && !db.tubeFormulas.some((y) => y.id === input.tube!.formulaId && y.active)) f.formulaId = '找不到這個配方'
    }
    failFields(f)
    const tp = input.tube
    const x: NutritionAssessment = {
      ...(tp ? { tube: { formulaId: tp.formulaId, totalMl: tp.totalMl, mode: tp.mode, ...(tp.mode === 'bolus' ? { feeds: tp.feeds } : { rateMlH: tp.rateMlH }) } } : {}),
      id: newId('NA'), admissionId: a.id, at: now(), by: u.id, assessment: input.assessment.trim(), recommendation: input.recommendation.trim(),
      ...(num(input.kcal) !== undefined ? { kcal: num(input.kcal) } : {}), ...(num(input.protein) !== undefined ? { protein: num(input.protein) } : {}),
    }
    db.nutritionAssessments.push(x)
    audit('營養評估', `${a.admitNo} ${nameOf.patient(a.patientId)}：${x.recommendation}`)
    return assessView(x)
  })
}

/** 主治已閱（本科醫師；會診醫師不行） */
export function ackNutritionAssessment(id: string): Promise<NutritionAssessmentView> {
  return mutate(() => {
    const u = requireUser('doctor')
    const x = must(db.nutritionAssessments.find((y) => y.id === id), '營養評估')
    const a = must(find.admission(x.admissionId), '住院紀錄')
    const role = careRoleOf(u.doctorId, a)
    if (!role || role.kind === 'consult') fail(`營養評估由${nameOf.dept(a.deptId)}的醫師（主治）確認`, 'FORBIDDEN')
    if (x.seenAt) fail('已經確認過了', 'CONFLICT')
    Object.assign(x, { seenBy: u.id, seenAt: now() })
    audit('營養評估已閱', `${a.admitNo} ${nameOf.patient(a.patientId)}`)
    return assessView(x)
  })
}

export interface MealRow {
  bedNo: string
  patientName: string
  chartNo: string
  kind?: DietKind
  /** 飲食醫囑文字（含備註）；沒有飲食醫囑的寫「沒有飲食醫囑」 */
  dietText: string
  npo: boolean
  /** 管灌：不送餐盤，送配方 */
  tube: boolean
  allergies: string[]
}

/** 送餐清單：某病房、某天某一餐（以那一餐時間有效的飲食醫囑為準）；依床號排，禁食的列出但標「不送」 */
export function mealList(ward: string, date: string, meal: MealKey): Promise<{ ward: string; date: string; meal: MealKey; mealLabel: string; rows: MealRow[]; counts: Record<string, number> }> {
  return query(() => {
    requireUser('diet', 'nurse', 'admin')
    const m = MEALS.find((x) => x.key === meal)
    if (!m) failField('meal', '請選餐別')
    if (!db.beds.some((b) => b.ward === ward)) fail(`找不到病房「${ward}」`)
    const at = `${date} ${m!.at}`
    const rows: MealRow[] = db.admissions
      .filter((a) => a.bedId && find.bed(a.bedId)?.ward === ward && a.admittedAt && a.admittedAt <= at && (a.status === 'admitted' ? true : a.status === 'discharged' && !!a.dischargedAt && a.dischargedAt > at))
      .map((a) => {
        const orders = db.ipdOrders.filter((o) => o.admissionId === a.id && o.category === 'diet')
        const d = dietAt(orders, at)
        const o = d ? orders.filter((x) => x.type === 'long' && x.startAt <= at && (!x.stopAt || x.stopAt > at)).sort((x, y) => x.startAt.localeCompare(y.startAt)).at(-1) : undefined
        const p = find.patient(a.patientId)
        return {
          bedNo: find.bed(a.bedId!)?.bedNo ?? '', patientName: p?.name ?? '', chartNo: p?.chartNo ?? '',
          ...(d ? { kind: d.kind } : {}), dietText: o ? o.content : '沒有飲食醫囑', npo: d?.kind === 'npo', tube: d?.kind === 'tube', allergies: p?.allergies ?? [],
        }
      })
      .sort((x, y) => x.bedNo.localeCompare(y.bedNo))
    const counts: Record<string, number> = {}
    for (const r of rows) {
      const k = r.kind ? dietLabel(r.kind) : '沒有飲食醫囑'
      counts[k] = (counts[k] ?? 0) + 1
    }
    return { ward, date, meal, mealLabel: m!.label, rows, counts }
  })
}

