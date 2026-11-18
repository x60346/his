// 細菌培養與藥物敏感性（純函式＋靜態主檔）：檢體、菌種與各自要測的抗生素（藥敏組合）、多重抗藥性的判斷、
// 報告的輸入檢查、報告上的「培養結果」值（無菌生長／MRSA／CRE／VRE／其他細菌，解除隔離用）。
// 檢驗登打、病歷檢驗、抗生素管理、隔離提醒、院內藥敏統計、測試都用這一份
import type { CultureIsolate, CultureSpecimen, SirResult } from '@/types'

export const SPECIMENS: { key: CultureSpecimen; label: string }[] = [
  { key: 'urine', label: '尿液' },
  { key: 'blood', label: '血液' },
  { key: 'sputum', label: '痰液' },
  { key: 'wound', label: '傷口' },
]
export const specimenLabel = (k?: CultureSpecimen) => SPECIMENS.find((s) => s.key === k)?.label ?? ''

/** 藥敏測的抗生素（drugIds＝院內主檔對應的藥；沒有的只做藥敏參考） */
export const AST_DRUGS: { key: string; name: string; drugIds: string[] }[] = [
  { key: 'AMP', name: 'Ampicillin／Amoxicillin', drugIds: ['M003'] },
  { key: 'AMC', name: 'Amoxicillin/Clavulanate', drugIds: ['M004'] },
  { key: 'CEX', name: 'Cephalexin（第一代頭孢）', drugIds: ['M005'] },
  { key: 'CRO', name: 'Ceftriaxone', drugIds: ['M036'] },
  { key: 'TZP', name: 'Piperacillin/Tazobactam', drugIds: ['M044'] },
  { key: 'MEM', name: 'Meropenem', drugIds: ['M043'] },
  { key: 'OXA', name: 'Oxacillin', drugIds: [] },
  { key: 'VAN', name: 'Vancomycin', drugIds: ['M042'] },
]
export const astName = (k: string) => AST_DRUGS.find((d) => d.key === k)?.name ?? k
/** 這支院內的藥對應哪一個藥敏項目 */
export const astKeyOfDrug = (drugId: string) => AST_DRUGS.find((d) => d.drugIds.includes(drugId))?.key

const GN = ['AMP', 'AMC', 'CEX', 'CRO', 'TZP', 'MEM']
/** 菌種主檔：panel＝這種菌要測的抗生素（念珠菌不做細菌藥敏） */
export const ORGANISMS: { id: string; name: string; gram: 'neg' | 'pos' | 'fungus'; panel: string[] }[] = [
  { id: 'ECO', name: '大腸桿菌 E. coli', gram: 'neg', panel: GN },
  { id: 'KPN', name: '克雷伯氏菌 K. pneumoniae', gram: 'neg', panel: GN.filter((k) => k !== 'AMP') },
  { id: 'PAE', name: '綠膿桿菌 P. aeruginosa', gram: 'neg', panel: ['TZP', 'MEM'] },
  { id: 'ABA', name: '鮑氏不動桿菌 A. baumannii', gram: 'neg', panel: ['TZP', 'MEM'] },
  { id: 'SAU', name: '金黃色葡萄球菌 S. aureus（MSSA）', gram: 'pos', panel: ['OXA', 'CEX', 'AMC', 'VAN'] },
  { id: 'MRSA', name: '抗藥性金黃色葡萄球菌 MRSA', gram: 'pos', panel: ['OXA', 'CEX', 'AMC', 'VAN'] },
  { id: 'EFA', name: '糞腸球菌 E. faecalis', gram: 'pos', panel: ['AMP', 'VAN'] },
  { id: 'VRE', name: '抗藥性腸球菌 VRE', gram: 'pos', panel: ['AMP', 'VAN'] },
  { id: 'CAN', name: '念珠菌 Candida', gram: 'fungus', panel: [] },
]
export const organismName = (id: string) => ORGANISMS.find((o) => o.id === id)?.name ?? id

/** 多重抗藥性：MRSA、VRE；腸道菌（大腸桿菌、克雷伯氏菌）Meropenem 抗藥＝CRE */
export function mdroOf(x: Pick<CultureIsolate, 'organism' | 'ast'>): 'MRSA' | 'VRE' | 'CRE' | undefined {
  if (x.organism === 'MRSA') return 'MRSA'
  if (x.organism === 'VRE') return 'VRE'
  if ((x.organism === 'ECO' || x.organism === 'KPN') && x.ast.MEM === 'R') return 'CRE'
  return undefined
}
/** 報告上「培養結果」這一欄（解除隔離看這個）：沒長菌＝無菌生長；有多重抗藥菌就寫它；其他＝其他細菌 */
export function cultureValue(isolates: Pick<CultureIsolate, 'organism' | 'ast'>[]): string {
  if (!isolates.length) return '無菌生長'
  return isolates.map(mdroOf).find(Boolean) ?? '其他細菌'
}

/** 輸入檢查：檢體要選；最多 3 株、菌種不重複；每株藥敏組合的抗生素都要填 S／I／R */
export function checkCulture(x: { specimen?: string; isolates?: { organism?: string; ast?: Record<string, string> }[] }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!SPECIMENS.some((s) => s.key === x.specimen)) e.specimen = '請選檢體'
  const iso = x.isolates ?? []
  if (iso.length > 3) e.isolates = '一份培養最多 3 株'
  const seen = new Set<string>()
  iso.forEach((s, i) => {
    const o = ORGANISMS.find((v) => v.id === s.organism)
    if (!o) return void (e[`organism${i}`] = '請選菌種')
    if (seen.has(o.id)) e[`organism${i}`] = '同一份培養菌種重複'
    seen.add(o.id)
    const miss = o.panel.filter((k) => !['S', 'I', 'R'].includes(s.ast?.[k] ?? ''))
    if (miss.length) e[`ast${i}`] = `藥敏還沒填：${miss.map(astName).join('、')}`
  })
  return e
}
export const SIR_LABEL: Record<SirResult, string> = { S: '敏感', I: '中等', R: '抗藥' }
