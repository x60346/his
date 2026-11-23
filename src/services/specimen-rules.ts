// 住院檢體與條碼（純函式）：容器名稱與顏色、同管別合併、檢體走到哪一步、收件逾時、退件原因。
// 護理站印條碼與採檢、檢驗科收件與退件、首頁待辦、測試都用這一份
import type { Specimen, TubeKind } from '@/types'
import { addMinutes } from '@/utils/date'

export const TUBE_LABEL: Record<TubeKind, string> = { purple: '紫頭（EDTA）', red: '紅頭（生化）', gas: '動脈血氣體', urine: '尿杯', swab: '拭子', sputum: '痰盒', culture: '培養容器', fluid: '無菌體液管' }
/** 標籤上的顏色（Tailwind class） */
export const TUBE_COLOR: Record<TubeKind, string> = { purple: 'bg-purple-500', red: 'bg-red-500', gas: 'bg-sky-500', urine: 'bg-yellow-400', swab: 'bg-slate-400', sputum: 'bg-emerald-500', culture: 'bg-orange-500', fluid: 'bg-amber-700' }
/** 病人自行收集的容器（門診）：發給病人、交回才算採檢 */
export const SELF_COLLECT_TUBES: TubeKind[] = ['urine', 'sputum']
export const SPECIMEN_REJECT_REASONS = ['溶血', '檢體量不足', '凝固', '標籤錯誤', '容器錯誤']
/** 採檢後多久沒收件算逾時（首頁標紅）：住院檢驗都是臨時醫囑，視同急件 */
export const SPECIMEN_LATE_MIN = 60

export type SpecimenStage = 'printed' | 'collected' | 'received' | 'rejected'
export const SPECIMEN_STAGE_LABEL: Record<SpecimenStage, string> = { printed: '已印條碼、待採檢', collected: '已採檢、待收件', received: '檢驗科已收件', rejected: '退件' }
export const specimenStage = (s: Pick<Specimen, 'collectedAt' | 'receivedAt' | 'rejected'>): SpecimenStage => (s.rejected ? 'rejected' : s.receivedAt ? 'received' : s.collectedAt ? 'collected' : 'printed')

/** 採檢後超過 60 分鐘還沒收件 */
export const specimenLate = (s: Pick<Specimen, 'collectedAt' | 'receivedAt' | 'rejected'>, t: string) => specimenStage(s) === 'collected' && t > addMinutes(s.collectedAt!, SPECIMEN_LATE_MIN)

/** 同管別合併：檢驗醫囑依容器分組（容器順序固定，標籤印出來的順序一樣） */
export function groupByTube<T extends { tube: TubeKind }>(xs: T[]): { tube: TubeKind; items: T[] }[] {
  return (Object.keys(TUBE_LABEL) as TubeKind[]).map((tube) => ({ tube, items: xs.filter((x) => x.tube === tube) })).filter((g) => g.items.length)
}

/** 退件原因要選或寫 */
export const checkRejectReason = (reason: string | undefined): Record<string, string> => (reason?.trim() ? {} : { reason: '請寫退件原因（例：溶血、檢體量不足）' })

/** 加做：已收件的檢體在採檢後幾小時內，可以加開同管別的檢驗不用再抽（主檔依管別；沒列的管別不能加做） */
export const ADDON_HOURS: Partial<Record<TubeKind, number>> = { red: 24, purple: 24, urine: 2 }
/**
 * 這支檢體能不能加做這個管別的檢驗：同管別、已收件、沒退件、在時限內。
 * 回傳 until（可加做到幾點）或不行的原因
 */
export function addonCheck(sp: Pick<Specimen, 'tube' | 'collectedAt' | 'receivedAt' | 'rejected'> | undefined, tube: TubeKind, t: string): { ok: true; until: string } | { ok: false; reason: string } {
  const h = ADDON_HOURS[tube]
  if (!h) return { ok: false, reason: `${TUBE_LABEL[tube]}不能加做，要重新採檢` }
  if (!sp || sp.rejected || !sp.receivedAt || !sp.collectedAt) return { ok: false, reason: `這位病人沒有已收件的${TUBE_LABEL[tube]}檢體可以加做` }
  if (sp.tube !== tube) return { ok: false, reason: `管別不符（檢體是${TUBE_LABEL[sp.tube]}，這項要${TUBE_LABEL[tube]}）` }
  const until = addMinutes(sp.collectedAt, h * 60)
  if (t > until) return { ok: false, reason: `超過可加做時限（${TUBE_LABEL[tube]} ${h} 小時，採檢 ${sp.collectedAt.slice(5)}）：要重新採檢` }
  return { ok: true, until }
}

/** 一支管子裝得下多少檢體（mL）：同管別的檢驗合起來超過就拆成兩支條碼 */
export const TUBE_CAPACITY_ML: Record<TubeKind, number> = { purple: 3, red: 5, gas: 1, urine: 10, swab: 5, sputum: 5, culture: 10, fluid: 20 }
/** 依量拆支：照順序裝，裝不下就開新的一支（單項就超過容量的自己一支） */
export function splitByVolume<T>(items: T[], ml: (x: T) => number, capacity: number): T[][] {
  const out: T[][] = []
  let cur: T[] = []
  let used = 0
  for (const x of items) {
    const v = ml(x)
    if (cur.length && used + v > capacity) {
      out.push(cur)
      cur = []
      used = 0
    }
    cur.push(x)
    used += v
  }
  if (cur.length) out.push(cur)
  return out
}
/** 空腹確認的文字（標籤、報告附註） */
export const fastingText = (f: { ok: boolean; note?: string } | undefined) => (!f ? '' : f.ok ? '空腹' : `非空腹${f.note ? `（${f.note}）` : ''}`)
