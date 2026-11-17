// 飲食與營養（純函式）：飲食種類、從舊的飲食醫囑文字推斷種類、某天吃哪一種（伙食費、送餐清單共用）、
// 營養篩檢（簡化 NRS-2002）算分與期限。畫面即時算、服務層把關、帳單、測試都用這一份
import type { DietKind, IpdOrder } from '@/types'
import { addMinutes } from '@/utils/date'

export const DIET_KINDS: { kind: DietKind; label: string; hint: string }[] = [
  { kind: 'regular', label: '普通飲食', hint: '一般飯菜' },
  { kind: 'soft', label: '軟質飲食', hint: '咀嚼吞嚥較差、術後恢復期' },
  { kind: 'liquid', label: '流質飲食', hint: '清流、全流（術後剛恢復進食）' },
  { kind: 'diabetic', label: '糖尿病飲食', hint: '控制醣類，備註寫熱量（例：1800 kcal）' },
  { kind: 'low-salt', label: '低鹽飲食', hint: '鈉 2–3 g／日（心衰竭、高血壓、腎臟病）' },
  { kind: 'npo', label: '禁食', hint: '術前、檢查前、腸胃道需要休息；不送餐、不收伙食費' },
]
export const dietLabel = (k: DietKind) => DIET_KINDS.find((x) => x.kind === k)?.label ?? k
export const dietText = (d: { kind: DietKind; note?: string }) => `${dietLabel(d.kind)}${d.note?.trim() ? `・${d.note.trim()}` : ''}`

/** 舊的飲食醫囑只有文字：依關鍵字推斷種類（看不出來的當普通飲食） */
export function dietKindOfText(content: string): DietKind {
  if (/禁食|NPO/i.test(content)) return 'npo'
  if (/糖尿病/.test(content)) return 'diabetic'
  if (/低鹽|低鈉/.test(content)) return 'low-salt'
  if (/流質/.test(content)) return 'liquid'
  if (/軟質|軟食|吞嚥/.test(content)) return 'soft'
  return 'regular'
}
export const dietOf = (o: Pick<IpdOrder, 'diet' | 'content'>): { kind: DietKind; note?: string } => o.diet ?? { kind: dietKindOfText(o.content) }

/** 三餐（送餐清單）：餐別與「以這個時間點有效的飲食醫囑」為準 */
export const MEALS: { key: 'breakfast' | 'lunch' | 'dinner'; label: string; at: string }[] = [
  { key: 'breakfast', label: '早餐', at: '07:00' },
  { key: 'lunch', label: '午餐', at: '11:30' },
  { key: 'dinner', label: '晚餐', at: '17:00' },
]
export type MealKey = (typeof MEALS)[number]['key']

/** 在 at 這個時間有效的長期飲食醫囑（開始 ≤ at，沒停或停在 at 之後；有好幾筆取最晚開的） */
export function dietAt(orders: Pick<IpdOrder, 'category' | 'type' | 'startAt' | 'stopAt' | 'status' | 'diet' | 'content'>[], at: string): { kind: DietKind; note?: string } | undefined {
  const o = orders
    .filter((x) => x.category === 'diet' && x.type === 'long' && x.startAt <= at && (!x.stopAt || x.stopAt > at))
    .sort((a, b) => a.startAt.localeCompare(b.startAt))
    .at(-1)
  return o ? dietOf(o) : undefined
}

/** 某一天算哪一種伙食：以午餐時間有效的飲食醫囑為準；那時還沒入院或已出院，看早餐、晚餐 */
export function dietOfDay(orders: Parameters<typeof dietAt>[0], date: string): { kind: DietKind; note?: string } | undefined {
  return dietAt(orders, `${date} 11:30`) ?? dietAt(orders, `${date} 17:00`) ?? dietAt(orders, `${date} 07:00`)
}

// ---------- 營養篩檢（簡化 NRS-2002） ----------
export const NUTRITION_IMPAIRED: { score: 0 | 1 | 2 | 3; text: string }[] = [
  { score: 0, text: '營養狀態正常' },
  { score: 1, text: '3 個月內體重減輕 >5%，或上週進食量為平常的 50–75%' },
  { score: 2, text: '2 個月內體重減輕 >5%，或 BMI 18.5–20.5 且一般狀況差，或上週進食量 25–50%' },
  { score: 3, text: '1 個月內體重減輕 >5%，或 BMI <18.5 且一般狀況差，或上週進食量 0–25%' },
]
export const NUTRITION_SEVERITY: { score: 0 | 1 | 2 | 3; text: string }[] = [
  { score: 0, text: '一般營養需求' },
  { score: 1, text: '慢性病急性發作、髖部骨折、慢性病（肝硬化、慢性阻塞性肺病、透析、糖尿病、癌症）' },
  { score: 2, text: '腹部大手術、中風、重度肺炎、血液惡性腫瘤' },
  { score: 3, text: '頭部外傷、骨髓移植、加護病房（APACHE >10）' },
]
/** 幾分以上有營養風險（營養師要評估） */
export const NUTRITION_RISK_FROM = 3
/** 入院後幾小時內要篩檢 */
export const NUTRITION_SCREEN_HOURS = 48

export function nutritionScore(x: { impaired?: number; severity?: number; age70?: boolean }): number {
  return (x.impaired ?? 0) + (x.severity ?? 0) + (x.age70 ? 1 : 0)
}

/** BMI（身高公分、體重公斤；有缺回 undefined） */
export const bmiOf = (h?: number, w?: number) => (h && w ? Math.round((w / (h / 100) ** 2) * 10) / 10 : undefined)

/** 篩檢期限：入院 48 小時；做過就 done；還沒到期限前 6 小時是 todo、最後 6 小時 due、過了 overdue */
export function screenDue(admittedAt: string, screenedAt: string | undefined, now: string): { status: 'done' | 'todo' | 'due' | 'overdue'; dueAt: string } {
  const dueAt = addMinutes(admittedAt, NUTRITION_SCREEN_HOURS * 60)
  if (screenedAt) return { status: 'done', dueAt }
  if (now > dueAt) return { status: 'overdue', dueAt }
  return { status: now >= addMinutes(dueAt, -6 * 60) ? 'due' : 'todo', dueAt }
}

export function checkNutritionScreen(x: { impaired?: number; severity?: number; heightCm?: number; weightKg?: number }): Record<string, string> {
  const e: Record<string, string> = {}
  if (![0, 1, 2, 3].includes(x.impaired as number)) e.impaired = '請選營養狀態'
  if (![0, 1, 2, 3].includes(x.severity as number)) e.severity = '請選疾病嚴重度'
  if (x.heightCm !== undefined && x.heightCm !== null && !(x.heightCm >= 40 && x.heightCm <= 230)) e.heightCm = '身高 40–230 公分'
  if (x.weightKg !== undefined && x.weightKg !== null && !(x.weightKg >= 2 && x.weightKg <= 300)) e.weightKg = '體重 2–300 公斤'
  return e
}
