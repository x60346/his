// 藥物交互作用與重複用藥（純函式）：門診處方表、住院開醫囑、服務層完成看診／開立醫囑、測試都呼叫這一份。
// 對照表是展示用的（只涵蓋主檔裡的藥），真實系統會接藥物交互作用資料庫與健保雲端藥歷。
//
// 三種提醒：
//   - interaction 交互作用：依對照表分「嚴重」（要寫原因才能開）與「注意」（確認即可）
//   - same 成分重複：這張處方裡、或病人還在吃的藥（別科、前幾天開的）有相同成分——一律「注意」
//   - class 同類重複：同一類藥開了兩種（例：兩種 NSAIDs）——一律「注意」
// 「嚴重」不直接擋：臨床上有刻意併用的情況，由醫師寫原因負責，藥師看得到原因。

import type { RxAlertLevel, RxAlertRecord } from '@/types'

export type { RxAlertLevel, RxAlertRecord }
export type RxAlertKind = 'interaction' | 'same' | 'class'

/** 比對用的藥（只要這幾個欄位） */
export interface RxDrugRef {
  id: string
  name: string
  generic: string
}

/** 病人還在吃的藥（別次看診開的、住院中執行中的醫囑） */
export interface InUseMed {
  drug: RxDrugRef
  /** 哪裡開的，例：「內科 11/10 陳柏宇」「執行中醫囑」 */
  source: string
  /** 藥吃到哪天（含）；住院執行中的醫囑沒有 */
  until?: string
  /** 從今天算還有幾天（含今天） */
  remainDays?: number
}

export interface RxAlert {
  /** 同一組藥、同一種提醒的識別（醫師的確認與原因以它對應） */
  key: string
  kind: RxAlertKind
  level: RxAlertLevel
  /** 這次開的、牽涉到的藥 */
  drugIds: string[]
  /** 例：「Warfarin 5mg ＋ Ibuprofen 400mg」 */
  title: string
  /** 會怎樣、怎麼辦 */
  text: string
  /** 另一個藥是病人還在吃的：哪裡開的、還有幾天 */
  other?: string
}

export const RX_ALERT_LEVEL_LABEL: Record<RxAlertLevel, string> = { severe: '嚴重', caution: '注意' }
export const RX_ALERT_KIND_LABEL: Record<RxAlertKind, string> = { interaction: '交互作用', same: '成分重複', class: '同類重複' }

/** 成分：學名小寫，複方以「/」分開，每個成分取第一個字（Morphine sulfate＝morphine、Acetylsalicylic acid＝acetylsalicylic） */
export function ingredientsOf(generic: string): string[] {
  return generic
    .toLowerCase()
    .split('/')
    .map((s) => s.trim().split(/\s+/)[0])
    .filter(Boolean)
}

interface InteractionRule {
  a: string[]
  b: string[]
  level: RxAlertLevel
  text: string
}

/** 交互作用對照表（成分；a、b 兩組各取一個就算） */
export const DRUG_INTERACTIONS: InteractionRule[] = [
  { a: ['warfarin'], b: ['acetylsalicylic', 'ibuprofen', 'celecoxib', 'diclofenac'], level: 'severe', text: '出血風險大增（抗凝血劑併用抗血小板或 NSAIDs）；必要時密切追蹤 INR 與出血徵象' },
  { a: ['morphine', 'tramadol'], b: ['alprazolam', 'zolpidem'], level: 'severe', text: '中樞神經與呼吸抑制加成，可能致命；如需併用請用最低劑量並監測呼吸、意識' },
  { a: ['warfarin'], b: ['azithromycin'], level: 'caution', text: 'INR 可能上升；用藥期間追蹤凝血功能' },
  { a: ['clopidogrel'], b: ['omeprazole'], level: 'caution', text: 'Omeprazole 降低 Clopidogrel 的抗血小板效果；需要護胃可改用 Famotidine' },
  { a: ['acetylsalicylic'], b: ['clopidogrel'], level: 'caution', text: '雙重抗血小板，出血風險增加（心導管術後常刻意併用）' },
  { a: ['acetylsalicylic'], b: ['ibuprofen', 'celecoxib', 'diclofenac'], level: 'caution', text: '腸胃出血風險增加；Ibuprofen 也可能降低低劑量 Aspirin 的心血管保護' },
  { a: ['levothyroxine'], b: ['magnesium'], level: 'caution', text: '制酸劑降低甲狀腺素吸收；兩者間隔 4 小時服用' },
  { a: ['losartan'], b: ['potassium'], level: 'caution', text: '高血鉀風險；追蹤血鉀' },
]

/** 同類藥（同一類開兩種＝同類重複） */
export const DRUG_CLASSES: { name: string; members: string[] }[] = [
  { name: '非類固醇止痛消炎藥（NSAIDs）', members: ['ibuprofen', 'celecoxib', 'diclofenac'] },
  { name: '抗組織胺', members: ['cetirizine', 'loratadine'] },
  { name: '制酸劑（PPI／H2）', members: ['omeprazole', 'famotidine'] },
  { name: '鴉片類止痛', members: ['morphine', 'tramadol'] },
  { name: '安眠鎮靜', members: ['zolpidem', 'alprazolam'] },
]

const hasAny = (ing: string[], list: string[]) => ing.some((i) => list.includes(i))

/** 兩個藥之間的提醒（沒有回傳 undefined）：成分重複 > 交互作用 > 同類重複，一組藥只報一種 */
function pairAlert(x: RxDrugRef, y: RxDrugRef): Pick<RxAlert, 'kind' | 'level' | 'text'> | undefined {
  const ix = ingredientsOf(x.generic)
  const iy = ingredientsOf(y.generic)
  const shared = ix.filter((i) => iy.includes(i))
  if (shared.length) return { kind: 'same', level: 'caution', text: `成分相同（${shared.join('、')}），小心重複服用、劑量加倍` }
  const rules = DRUG_INTERACTIONS.filter((r) => (hasAny(ix, r.a) && hasAny(iy, r.b)) || (hasAny(ix, r.b) && hasAny(iy, r.a)))
  const rule = rules.find((r) => r.level === 'severe') ?? rules[0]
  if (rule) return { kind: 'interaction', level: rule.level, text: rule.text }
  const cls = DRUG_CLASSES.find((c) => hasAny(ix, c.members) && hasAny(iy, c.members))
  if (cls) return { kind: 'class', level: 'caution', text: `同屬${cls.name}，通常只需要一種` }
  return undefined
}

const remainText = (m: InUseMed) => (m.until ? `，藥還有 ${m.remainDays} 天（用到 ${m.until.slice(5).replace('-', '/')}）` : '')

/**
 * 這次要開的藥（newDrugs）彼此之間、以及和病人還在吃的藥（inUse）之間的提醒。嚴重的排前面。
 * 同一個藥在這次處方出現兩次不報（那是處方表自己的事）；同一組提醒只報一次。
 */
export function checkRxAlerts(newDrugs: RxDrugRef[], inUse: InUseMed[] = []): RxAlert[] {
  const out: RxAlert[] = []
  const seen = new Set<string>()
  const push = (a: RxAlert) => {
    if (seen.has(a.key)) return
    seen.add(a.key)
    out.push(a)
  }
  const uniq = newDrugs.filter((d, i) => newDrugs.findIndex((x) => x.id === d.id) === i)
  for (let i = 0; i < uniq.length; i++) {
    for (let j = i + 1; j < uniq.length; j++) {
      const p = pairAlert(uniq[i], uniq[j])
      if (p) push({ ...p, key: `${p.kind}:${[uniq[i].id, uniq[j].id].sort().join('+')}`, drugIds: [uniq[i].id, uniq[j].id], title: `${uniq[i].name} ＋ ${uniq[j].name}` })
    }
    for (const m of inUse) {
      const p = pairAlert(uniq[i], m.drug)
      if (p) push({ ...p, key: `${p.kind}:${uniq[i].id}~${m.drug.id}`, drugIds: [uniq[i].id], title: `${uniq[i].name} ＋ ${m.drug.name}（${m.until ? '還在用' : '執行中'}）`, other: `${m.source} 開的 ${m.drug.name}${remainText(m)}` })
    }
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'severe' ? -1 : 1))
}

/**
 * 醫師對提醒的回應是否足夠（服務層用）：每一則都要確認（reasons 有這個 key），嚴重的原因不能空白。
 * 回傳問題（沒有＝可以開）：missing＝還沒確認過的提醒；needReason＝嚴重但沒寫原因的
 */
export function rxAlertProblems(alerts: RxAlert[], reasons: Record<string, string> | undefined): { missing: RxAlert[]; needReason: RxAlert[] } {
  const r = reasons ?? {}
  return {
    missing: alerts.filter((a) => !(a.key in r)),
    needReason: alerts.filter((a) => a.key in r && a.level === 'severe' && !r[a.key]?.trim()),
  }
}

/** 存進病歷／醫囑的紀錄 */
export const rxAlertRecords = (alerts: RxAlert[], reasons: Record<string, string> = {}): RxAlertRecord[] =>
  alerts.map((a) => ({ key: a.key, level: a.level, title: a.title, text: a.text, ...(a.other ? { other: a.other } : {}), reason: (reasons[a.key] ?? '').trim() }))
