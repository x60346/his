// 病人重要標記（純函式）：隔離（類別、能不能同房、多久要檢討）與 DNR／預立醫療決定（文件、不施行項目、怎麼顯示）。
// 排床（服務層把關）、床位圖與選床畫面（標出不能排的床）、護理站待辦、病人資訊列都用這一份
import type { DnrDoc, DnrItem, IsolationKind } from '@/types'
import { addMinutes } from '@/utils/date'

export const ISOLATION_KIND_LABEL: Record<IsolationKind, string> = { contact: '接觸隔離', droplet: '飛沫隔離', airborne: '空氣隔離' }
/** 常見的原因或菌種（畫面上點一下帶入；也可以自己寫） */
export const ISOLATION_PRESETS: Record<IsolationKind, string[]> = {
  contact: ['MRSA', 'VRE', 'CRE', '困難梭狀桿菌', '疥瘡'],
  droplet: ['流感', '百日咳', '腮腺炎', '德國麻疹'],
  airborne: ['開放性肺結核', '疑似肺結核（待痰液抗酸菌報告）', '水痘', '麻疹'],
}
/** 隔離開了（或上次檢討後）幾天要再檢討一次是否解除 */
export const ISOLATION_REVIEW_DAYS = 14

export interface IsoTag {
  kind: IsolationKind
  organism: string
}
/** 同一種隔離＝同類別、同原因（大小寫、空白不計） */
export const normalizeOrganism = (s: string) => s.trim().replace(/\s+/g, '').toUpperCase()
const isoKey = (i: IsoTag) => `${i.kind}:${normalizeOrganism(i.organism)}`
const signature = (list: IsoTag[]) => [...new Set(list.map(isoKey))].sort().join('|')
export const isoText = (list: IsoTag[]) => list.map((i) => `${ISOLATION_KIND_LABEL[i.kind]}（${i.organism}）`).join('、')

export interface PlacementInput {
  /** 要排進來的病人目前的隔離 */
  isolations: IsoTag[]
  bedClass: string
  /** 同房其他床的病人（住著的、保留給他的） */
  roommates: { bedNo: string; name: string; isolations: IsoTag[] }[]
  /** 負壓隔離室；加護病房的床（加護病房只有負壓床能收空氣隔離） */
  negative?: boolean
  icu?: boolean
}

/**
 * 這張床能不能排（不能的回原因）：
 *   - 空氣隔離排負壓隔離室；沒有負壓床時可排單人房（加護病房只能排負壓床）
 *   - 同房的人要「隔離完全一樣」才能住一起：都沒隔離、或同類同原因（集中照護）；
 *     沒隔離的病人不能排進有隔離病人的房間，反過來也一樣
 */
export function placementProblem(p: PlacementInput): string | undefined {
  const air = p.isolations.find((i) => i.kind === 'airborne')
  if (air && !p.negative && p.icu) return `空氣隔離（${air.organism}）：加護病房只有負壓隔離床能收`
  if (air && !p.negative && p.bedClass !== '單人房') return `空氣隔離（${air.organism}）要排負壓隔離室（沒有負壓床時可排單人房）`
  const mine = signature(p.isolations)
  for (const r of p.roommates) {
    if (signature(r.isolations) === mine) continue
    if (!p.isolations.length) return `同房 ${r.bedNo} ${r.name} 是${isoText(r.isolations)}，沒有隔離的病人不能同房`
    if (!r.isolations.length) return `${isoText(p.isolations)}只能住單人房，或和同類、同原因的隔離病人同房（同房 ${r.bedNo} ${r.name} 沒有隔離）`
    return `${isoText(p.isolations)}和同房 ${r.bedNo} ${r.name}（${isoText(r.isolations)}）不同，不能同房`
  }
  return undefined
}

export type IsolationReview = 'carried' | 'long'
export const ISOLATION_REVIEW_TEXT: Record<IsolationReview, string> = {
  carried: '前次就醫開的隔離，這次住院請確認是否延續',
  long: `隔離滿 ${ISOLATION_REVIEW_DAYS} 天沒有檢討，請評估是否解除`,
}

/**
 * 隔離要不要檢討：
 *   - 這次入院前開的（或上次檢討在入院前）：帶菌者再住院，要確認是否延續
 *   - 開了（或上次檢討後）滿 14 天
 */
export function isolationReviewDue(iso: { startedAt: string; reviewedAt?: string }, admittedAt: string | undefined, now: string): IsolationReview | undefined {
  const last = iso.reviewedAt && iso.reviewedAt > iso.startedAt ? iso.reviewedAt : iso.startedAt
  if (admittedAt && last < admittedAt) return 'carried'
  if (now >= addMinutes(last, ISOLATION_REVIEW_DAYS * 24 * 60)) return 'long'
  return undefined
}

// ---------- DNR／預立醫療決定 ----------

export const DNR_DOC_LABEL: Record<DnrDoc, string> = {
  self: '本人：不施行心肺復甦術意願書',
  family: '最近親屬：不施行心肺復甦術同意書',
  ad: '預立醫療決定書（病人自主權利法）',
}
/** 不施行的項目（feeding 只有預立醫療決定書可以選） */
export const DNR_ITEMS: { key: DnrItem; label: string; short: string }[] = [
  { key: 'compress', label: '胸外按壓', short: '不按壓' },
  { key: 'intubation', label: '氣管內插管', short: '不插管' },
  { key: 'defib', label: '心臟電擊', short: '不電擊' },
  { key: 'drugs', label: '急救藥物（強心、升壓）', short: '不給急救藥物' },
  { key: 'pacing', label: '心臟人工調頻', short: '不調頻' },
  { key: 'ventilation', label: '人工呼吸（含呼吸器）', short: '不用呼吸器' },
  { key: 'feeding', label: '人工營養及流體餵養', short: '不管灌餵食' },
]
export const DNR_CPR_ITEMS: DnrItem[] = ['compress', 'intubation', 'defib', 'drugs', 'pacing', 'ventilation']
export const DNR_RELATIONS = ['配偶', '成年子女', '孫子女', '父母', '兄弟姐妹', '祖父母', '曾孫子女', '曾祖父母', '三親等旁系血親', '一親等直系姻親']

/** 顯示：全部不施行 →「DNR」；部分 →「DNR（不插管、不電擊）」，滑過去看得到哪些照常 */
export function dnrText(withhold: DnrItem[]): { label: string; title: string } {
  const set = new Set(withhold)
  const cprAll = DNR_CPR_ITEMS.every((k) => set.has(k))
  const no = DNR_ITEMS.filter((i) => set.has(i.key))
  const yes = DNR_ITEMS.filter((i) => !set.has(i.key) && i.key !== 'feeding')
  const label = cprAll ? `DNR${set.has('feeding') ? '（含不管灌餵食）' : ''}` : `DNR（${no.map((i) => i.short).join('、')}）`
  const title = `不施行：${no.map((i) => i.label).join('、')}${yes.length ? `；照常施行：${yes.map((i) => i.label).join('、')}` : ''}`
  return { label, title }
}

export interface DnrInputLike {
  doc: DnrDoc
  signedAt: string
  signerName?: string
  relation?: string
  witnesses?: string[]
  doctorIds?: string[]
  acpDate?: string
  withhold: DnrItem[]
}

/** 文件要件：本人與預立醫療決定 2 位見證人；家屬要簽署人、關係、兩位醫師確認；預立醫療決定要諮商日期 */
export function checkDnrInput(x: DnrInputLike, today: string): Record<string, string> {
  const e: Record<string, string> = {}
  if (!DNR_DOC_LABEL[x.doc]) e.doc = '請選擇文件種類'
  if (!/^\d{4}-\d{2}-\d{2}$/.test(x.signedAt ?? '')) e.signedAt = '請填簽署日期'
  else if (x.signedAt > today) e.signedAt = '簽署日期不能是未來'
  const items = new Set(x.withhold ?? [])
  if (!items.size) e.withhold = '請勾選不施行的項目（至少一項）'
  else if ([...items].some((k) => !DNR_ITEMS.some((i) => i.key === k))) e.withhold = '項目不正確'
  else if (items.has('feeding') && x.doc !== 'ad') e.withhold = '「人工營養及流體餵養」只有預立醫療決定書可以選'
  if (x.doc === 'family') {
    if (!x.signerName?.trim()) e.signerName = '請填簽署的家屬姓名'
    if (!x.relation?.trim()) e.relation = '請選擇和病人的關係'
    const ds = (x.doctorIds ?? []).filter(Boolean)
    if (ds.length !== 2 || ds[0] === ds[1]) e.doctorIds = '要兩位不同的專科醫師確認為末期病人'
  } else {
    const ws = (x.witnesses ?? []).map((w) => w.trim()).filter(Boolean)
    if (ws.length !== 2 || ws[0] === ws[1]) e.witnesses = '要兩位不同的見證人'
  }
  if (x.doc === 'ad') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(x.acpDate ?? '')) e.acpDate = '請填預立醫療照護諮商日期'
    else if (x.signedAt && x.acpDate! > x.signedAt) e.acpDate = '諮商要在簽署之前'
  }
  return e
}
