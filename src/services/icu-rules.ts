// 加護病房（純函式）：重症流程表每小時一筆、漏記判斷、平均動脈壓、GCS 與瞳孔的輸入檢查、預約住院不能直接排加護病房。
// 流程表、床邊看板、本班待辦、服務層、測試都用這一份
import type { PupilLight, VitalRecord } from '@/types'
import { addMinutes } from '@/utils/date'

/** 加護病房護病比上限預設（三班同一個）：一位護理師照顧 2 床 */
export const ICU_RATIO_DEFAULT = 2
/** 每小時記一筆；超過 75 分鐘沒記就列進本班待辦（只提醒不擋） */
export const HOURLY_LATE_MIN = 75
/** 平均動脈壓低於 65 mmHg：器官灌流不足（升壓劑的目標通常就是 MAP ≥65） */
export const MAP_LOW = 65

/** 平均動脈壓 MAP ≈（收縮壓＋2×舒張壓）÷3，四捨五入 */
export const mapOf = (sbp?: number, dbp?: number): number | undefined =>
  sbp === undefined || dbp === undefined || sbp === null || dbp === null ? undefined : Math.round((sbp + 2 * dbp) / 3)
export const mapLow = (map?: number) => map !== undefined && map < MAP_LOW

/** GCS：睜眼 E 1–4、言語 V 1–5、運動 M 1–6，總分 3–15 */
export const GCS_MAX = { e: 4, v: 5, m: 6 } as const
export const GCS_LABEL = { e: '睜眼 E', v: '言語 V', m: '運動 M' } as const
export const gcsTotal = (g?: VitalRecord['gcs']) => (g ? g.e + g.v + g.m : undefined)
/** GCS ≤8：昏迷（通常要保護呼吸道） */
export const gcsLow = (g?: VitalRecord['gcs']) => (gcsTotal(g) ?? 15) <= 8

export const PUPIL_LIGHT_LABEL: Record<PupilLight, string> = { brisk: '靈敏', sluggish: '遲鈍', none: '無反應' }
export const PUPIL_LIGHT_SHORT: Record<PupilLight, string> = { brisk: '+', sluggish: '±', none: '−' }
/** 瞳孔大小 1–9 mm；兩側差 1 mm 以上（不等大）要注意 */
export const PUPIL_RANGE: [number, number] = [1, 9]
export const pupilUnequal = (p?: VitalRecord['pupils']) => !!p && Math.abs(p.l - p.r) >= 1

/**
 * GCS、瞳孔的輸入檢查（欄位名 gcsE、gcsV、gcsM、pupilL、pupilR、lightL、lightR）：
 * GCS 三項要一起記（只記一項算不出總分）；瞳孔兩側大小與光反射要一起記
 */
export function checkNeuro(x: { gcs?: Partial<Record<'e' | 'v' | 'm', number>>; pupils?: Partial<{ l: number; r: number; lightL: string; lightR: string }> }): Record<string, string> {
  const e: Record<string, string> = {}
  const g = x.gcs
  if (g && (['e', 'v', 'm'] as const).some((k) => g[k] !== undefined && g[k] !== null)) {
    for (const k of ['e', 'v', 'm'] as const) {
      const v = g[k]
      const key = `gcs${k.toUpperCase()}`
      if (v === undefined || v === null || Number.isNaN(v)) e[key] = 'GCS 三項要一起記'
      else if (!Number.isInteger(v) || v < 1 || v > GCS_MAX[k]) e[key] = `1–${GCS_MAX[k]}`
    }
  }
  const p = x.pupils
  if (p && (p.l !== undefined || p.r !== undefined || p.lightL || p.lightR)) {
    for (const k of ['l', 'r'] as const) {
      const v = p[k]
      const key = k === 'l' ? 'pupilL' : 'pupilR'
      if (v === undefined || v === null || Number.isNaN(v)) e[key] = '兩側瞳孔要一起記'
      else if (v < PUPIL_RANGE[0] || v > PUPIL_RANGE[1] || Math.round(v * 2) !== v * 2) e[key] = `${PUPIL_RANGE[0]}–${PUPIL_RANGE[1]} mm（以 0.5 為單位）`
    }
    for (const k of ['lightL', 'lightR'] as const) if (!p[k] || !(p[k]! in PUPIL_LIGHT_LABEL)) e[k] = '請選光反射'
  }
  return e
}

/**
 * 流程表多久沒記：從最後一筆（還沒記過就從轉進加護病房的時間）算起，超過 75 分鐘＝漏記。
 * dueAt 是「應該記」的期限（最後一筆＋75 分鐘）
 */
export function hourlyState(lastAt: string | undefined, since: string, t: string): { from: string; minutes: number; late: boolean; dueAt: string } {
  const from = lastAt && lastAt > since ? lastAt : since
  const minutes = Math.max(0, Math.round((Date.parse(t.replace(' ', 'T')) - Date.parse(from.replace(' ', 'T'))) / 60000))
  return { from, minutes, late: minutes > HOURLY_LATE_MIN, dueAt: addMinutes(from, HOURLY_LATE_MIN) }
}

/** 流程表一天 24 欄（00–23 時）；三班：大夜 00–07、白班 08–15、小夜 16–23 */
export const FLOW_HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'))
export const FLOW_SHIFTS = [
  { shift: '大夜', from: 0, to: 8 },
  { shift: '白班', from: 8, to: 16 },
  { shift: '小夜', from: 16, to: 24 },
] as const

/** 住院中心報到能不能排加護病房：預約住院不行（住進一般病房後由主治申請轉入）；急診收住院可以 */
export const icuCheckInProblem = (fromEr: boolean): string | undefined =>
  fromEr ? undefined : '加護病房不收預約住院：請先住一般病房，需要時再轉入加護病房（急診收住院可以直接住加護病房）'
