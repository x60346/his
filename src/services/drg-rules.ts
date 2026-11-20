// DRG 診斷關聯群（純函式，示範用的簡化分組器）：分組表、分組（主手術 → 主診斷 → 有無合併症或 65 歲以上）、
// 不適用 DRG 的情況、給付（下限以下照實際、上下限之間定額、上限以上定額＋超出 80%）、住院中預估提示。
// 服務層（drg.ts、claim-work 住院申報）、種子、畫面、測試都用這一份。點數、權重是展示用近似值（配合這套展示的點數水準，不是實際支付標準）
export interface DrgGroup {
  code: string
  name: string
  /** 相對權重（展示：定額 ÷ 20000） */
  weight: number
  /** 定額點數 */
  points: number
  lower: number
  upper: number
}
type Rule = { surgical?: string[]; dx?: string[]; cc?: [DrgGroup, DrgGroup]; group?: DrgGroup }
const g = (code: string, name: string, points: number): DrgGroup => ({ code, name, weight: Math.round((points / 20000) * 100) / 100, points, lower: Math.round(points * 0.5), upper: Math.round(points * 1.6) })

/** 分組表：手術的先比（主手術），沒有手術才看主診斷；有兩組的依有無合併症（或 65 歲以上）分 */
const RULES: Rule[] = [
  { surgical: ['P037'], cc: [g('D225A', '前臂骨折開放性復位（有合併症或 65 歲以上）', 45000), g('D225B', '前臂骨折開放性復位（無合併症）', 36000)] },
  { surgical: ['P038'], cc: [g('D167A', '闌尾切除（有合併症或 65 歲以上）', 40000), g('D167B', '闌尾切除（無合併症）', 30000)] },
  { surgical: ['P039'], group: g('D162', '腹股溝疝氣修補', 18000) },
  { surgical: ['P040'], group: g('D263', '皮膚與皮下組織清創', 14000) },
  { dx: ['J12', 'J13', 'J14', 'J15', 'J16', 'J17', 'J18'], cc: [g('D089A', '肺炎（有合併症或 65 歲以上）', 20000), g('D089B', '肺炎（無合併症）', 15000)] },
  { dx: ['N39', 'N10', 'N30'], cc: [g('D320A', '腎臟與泌尿道感染（有合併症或 65 歲以上）', 16000), g('D320B', '腎臟與泌尿道感染（無合併症）', 12000)] },
  { dx: ['I63', 'I64'], group: g('D014', '腦梗塞', 30000) },
  { dx: ['A40', 'A41'], group: g('D416', '敗血症', 40000) },
]
export const DRG_OTHER_SURGICAL = g('D999S', '其他外科', 30000)
export const DRG_OTHER_MEDICAL = g('D999M', '其他內科', 15000)
/** 全部的組（主檔畫面、測試） */
export const DRG_TABLE: DrgGroup[] = [...RULES.flatMap((r) => (r.cc ? r.cc : [r.group!])), DRG_OTHER_SURGICAL, DRG_OTHER_MEDICAL]

/** 算合併症的次診斷（代碼前綴）：糖尿病、慢性腎臟病、心衰竭、慢性阻塞性肺病、癌症 */
export const DRG_CC: { prefix: string; label: string }[] = [
  { prefix: 'E11', label: '糖尿病' }, { prefix: 'E10', label: '糖尿病' }, { prefix: 'N18', label: '慢性腎臟病' }, { prefix: 'I50', label: '心衰竭' }, { prefix: 'J44', label: '慢性阻塞性肺病' }, { prefix: 'C', label: '癌症' },
]
/** 診斷文字的代碼（「J18.9 肺炎」→ J18.9） */
export const dxCode = (text: string): string => (text.trim().match(/^[A-Z][0-9][0-9A-Z.]*/)?.[0] ?? '').toUpperCase()

export interface DrgResult extends DrgGroup {
  /** 怎麼分的（給人看） */
  basis: string
  /** 算進來的合併症 */
  cc: string[]
}
/**
 * 分組：主手術（做完的手術，第一個在分組表的）→ 主診斷 → 其他外科／其他內科。
 * 合併症：主診斷以外，病人曾有的診斷碼裡有 DRG_CC 的（同一類只算一次）；65 歲以上視同有合併症
 */
export function groupDrg(input: { mainDiagnosis: string; doneProcs: { id: string; name: string }[]; history: string[]; age: number }): DrgResult {
  const main = dxCode(input.mainDiagnosis)
  const cc = [...new Set(input.history.map(dxCode).filter((c) => c && c !== main).flatMap((c) => DRG_CC.filter((x) => c.startsWith(x.prefix) && !main.startsWith(x.prefix)).map((x) => x.label)))]
  const heavy = cc.length > 0 || input.age >= 65
  const pick = (r: Rule) => (r.cc ? r.cc[heavy ? 0 : 1] : r.group!)
  const why = (k: string) => `${k}${cc.length ? `；合併症：${cc.join('、')}` : ''}${input.age >= 65 ? `；${input.age} 歲` : ''}`
  const sp = input.doneProcs.find((p) => RULES.some((r) => r.surgical?.includes(p.id)))
  if (sp) return { ...pick(RULES.find((r) => r.surgical?.includes(sp.id))!), basis: why(`主手術 ${sp.name}`), cc }
  if (input.doneProcs.length) return { ...DRG_OTHER_SURGICAL, basis: why(`主手術 ${input.doneProcs[0].name}（不在分組表）`), cc }
  const dx = RULES.find((r) => r.dx?.some((p) => main.startsWith(p)))
  if (dx) return { ...pick(dx), basis: why(`主診斷 ${main}`), cc }
  return { ...DRG_OTHER_MEDICAL, basis: why(main ? `主診斷 ${main} 不在分組表` : '沒有主診斷'), cc }
}

/** 不適用 DRG（照實申報）：日間手術、住院超過 30 天、死亡、轉院、自動出院 */
export function drgExempt(input: { day: boolean; days: number; dischargeType?: string }): string | undefined {
  if (input.day) return '日間手術'
  if (input.days > 30) return `住院 ${input.days} 天（超過 30 天）`
  const t = input.dischargeType ?? ''
  if (/死亡/.test(t)) return '死亡出院'
  if (/轉院/.test(t)) return '轉院'
  if (/自動出院/.test(t)) return '自動出院'
  return undefined
}

export type DrgPayRule = 'lower' | 'fixed' | 'outlier'
export const DRG_PAY_RULE_LABEL: Record<DrgPayRule, string> = { lower: '低於下限，照實際', fixed: '定額', outlier: '超過上限，定額＋超出 80%' }
/** 給付：實際點數 < 下限 → 實際；≤ 上限 → 定額；> 上限 → 定額＋(實際 − 上限) × 80% */
export function drgPay(actual: number, g: Pick<DrgGroup, 'points' | 'lower' | 'upper'>): { pay: number; rule: DrgPayRule; diff: number } {
  const a = Math.round(actual)
  const pay = a < g.lower ? a : a <= g.upper ? g.points : g.points + Math.round((a - g.upper) * 0.8)
  return { pay, rule: a < g.lower ? 'lower' : a <= g.upper ? 'fixed' : 'outlier', diff: pay - a }
}

/** 住院中提示：目前點數佔上限幾 %；80% 以上 near、超過 over */
export function drgAlert(actual: number, g: Pick<DrgGroup, 'upper'>): { pct: number; level: 'ok' | 'near' | 'over' } {
  const pct = Math.round((actual / g.upper) * 100)
  return { pct, level: actual > g.upper ? 'over' : pct >= 80 ? 'near' : 'ok' }
}

// ---------- 分組輸入（純函式：服務層用 db、種子用建立中的陣列，算法一樣） ----------

type Enc = { patientId: string; diagnoses: { icd: string }[] }
type Adm = { id: string; patientId: string; status: string; diagnosis: string; dischargeSummary?: { diagnosis?: string } }
type Sg = { admissionId: string; status: string; procId: string; endAt?: string }
/** 主診斷：出院病摘（寫了的話）；否則入院診斷 */
export const mainDiagnosisFrom = (a: Pick<Adm, 'diagnosis' | 'dischargeSummary'>) => (a.dischargeSummary?.diagnosis?.trim() || a.diagnosis || '').trim()
/** 病人曾有的診斷（門診病歷的診斷、其他住院的主診斷）：算合併症用 */
export const historyFrom = (encs: Enc[], adms: Adm[], patientId: string, exceptAdmissionId: string): string[] => [
  ...encs.filter((e) => e.patientId === patientId).flatMap((e) => e.diagnoses.map((d) => d.icd)),
  ...adms.filter((a) => a.patientId === patientId && a.id !== exceptAdmissionId && a.status !== 'cancelled').map(mainDiagnosisFrom),
]
/** 這次住院做完的手術（依結束時間）；planned＝住院中預估，排了還沒做的也算（取消的不算） */
export const doneProcsFrom = (sgs: Sg[], admissionId: string, nameOf: (procId: string) => string, planned = false) =>
  sgs.filter((s) => s.admissionId === admissionId && (planned ? s.status !== 'cancelled' : s.status === 'done')).sort((x, y) => (x.endAt ?? '').localeCompare(y.endAt ?? '')).map((s) => ({ id: s.procId, name: nameOf(s.procId) }))
