// 點滴（純函式）：醫囑範圍、一瓶滴多久、依流速（含調整）算已滴入多少、什麼時候滴完（換瓶）、某段時間的輸入量。
// 醫囑畫面、護理站、服務層、輸入輸出量、測試都用這一份
import type { InfusionRun } from '@/types'
import { addMinutes } from '@/utils/date'

export const INFUSION_RATE_REASONS = ['病人心衰竭／水腫，減慢', '血壓偏低，加快補液', '留置針部位腫脹，暫時減慢', '依醫師口頭指示（之後補醫囑）', '其他']
/** 換瓶前幾分鐘列「現在」 */
export const INFUSION_DUE_MIN = 30

const toMin = (s: string) => Date.parse(s.replace(' ', 'T')) / 60000
const fromMin = (base: string, m: number) => addMinutes(base, Math.round(m - toMin(base)))

export function checkInfusionInput(x: { volumeMl?: number; rateMlH?: number; additives?: { drugId?: string; dose?: number }[] }): Record<string, string> {
  const e: Record<string, string> = {}
  if (!(Number.isInteger(x.volumeMl) && x.volumeMl! >= 50 && x.volumeMl! <= 1000)) e.volumeMl = '每瓶容量 50–1000 ml'
  if (!(typeof x.rateMlH === 'number' && x.rateMlH >= 5 && x.rateMlH <= 500)) e.rateMlH = '流速 5–500 ml/小時'
  if ((x.additives ?? []).some((a) => !a.drugId || !(typeof a.dose === 'number' && a.dose > 0))) e.additives = '加藥要選藥品、填劑量'
  return e
}
/** 一瓶在固定流速下滴幾小時 */
export const hoursPerBag = (volumeMl: number, rateMlH: number) => Math.round((volumeMl / rateMlH) * 10) / 10

/** 流速分段：[開始分鐘, 流速]（接上那一刻，加上每一次調整） */
function segments(run: Pick<InfusionRun, 'startAt' | 'rateMlH' | 'rateChanges'>): [number, number][] {
  const segs: [number, number][] = [[toMin(run.startAt), run.rateChanges[0]?.from ?? run.rateMlH]]
  for (const c of run.rateChanges) segs.push([toMin(c.at), c.to])
  return segs
}

/** 從接上到 t（分鐘）滴入多少 ml（不超過一瓶） */
function infusedUntil(run: Pick<InfusionRun, 'startAt' | 'rateMlH' | 'rateChanges'>, tMin: number, volumeMl: number): number {
  const segs = segments(run)
  let ml = 0
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i][0]
    const e = Math.min(i + 1 < segs.length ? segs[i + 1][0] : tMin, tMin)
    if (e > s) ml += ((e - s) / 60) * segs[i][1]
  }
  return Math.min(volumeMl, Math.max(0, Math.round(ml)))
}

/** 已滴入（現在，或結束時；結束時有實際量就用實際量） */
export function infusedMl(run: Pick<InfusionRun, 'startAt' | 'rateMlH' | 'rateChanges' | 'endAt' | 'infusedMl'>, volumeMl: number, now: string): number {
  if (run.endAt && run.infusedMl !== undefined) return run.infusedMl
  return infusedUntil(run, toMin(run.endAt ?? now), volumeMl)
}

/** 預計滴完（換瓶）的時間：依目前流速算剩下的 */
export function expectedEnd(run: Pick<InfusionRun, 'startAt' | 'rateMlH' | 'rateChanges'>, volumeMl: number): string {
  const segs = segments(run)
  let left = volumeMl
  for (let i = 0; i < segs.length; i++) {
    const [s, rate] = segs[i]
    const next = i + 1 < segs.length ? segs[i + 1][0] : Infinity
    const can = ((next - s) / 60) * rate
    if (can >= left) return fromMin(run.startAt, s + (left / rate) * 60)
    left -= can
  }
  return run.startAt
}

/** 換瓶狀態：預計滴完前 30 分鐘起 due，滴完了還沒換 overdue */
export function changeState(endAt: string, now: string): 'ok' | 'due' | 'overdue' {
  return now > endAt ? 'overdue' : now >= addMinutes(endAt, -INFUSION_DUE_MIN) ? 'due' : 'ok'
}

/** 某一段時間 [from, to) 內滴入的 ml（今日輸入量用；結束時有修正的實際量，依比例分配） */
export function infusedBetween(run: Pick<InfusionRun, 'startAt' | 'rateMlH' | 'rateChanges' | 'endAt' | 'infusedMl'>, volumeMl: number, from: string, to: string, now: string): number {
  const end = toMin(run.endAt ?? now)
  const a = Math.max(toMin(from), toMin(run.startAt))
  const b = Math.min(toMin(to), end)
  if (b <= a) return 0
  const calc = infusedUntil(run, b, volumeMl) - infusedUntil(run, a, volumeMl)
  if (run.endAt && run.infusedMl !== undefined) {
    const total = infusedUntil(run, end, volumeMl)
    return total ? Math.round((calc * run.infusedMl) / total) : 0
  }
  return calc
}
