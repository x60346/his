// 預防保健資格判斷（純函式）：輸入病患、項目、過往紀錄、日期，輸出是否符合與原因。
// 不讀資料庫、不看時間，所以同樣的輸入永遠得到同樣的答案，容易驗證。
// 同一個函式用在：掛號勾選、預防保健頁的卡片、登錄與掛號時服務層再檢查、種子資料產生、測試。
//
// 間隔的定義（要寫清楚，邊界才有標準答案）：
//   「每 N 年 1 次」= 上次服務日加 N 年的「同月同日」當天起可再做（2/29 → 3/1）
//   例：上次 2023-05-02、每 3 年 → 2026-05-01 不可，2026-05-02 可
import type { Patient, PreventItem, PreventRecord } from '@/types'
import { addYears, ageOf, toRoc } from '@/utils/date'

export interface Eligibility {
  itemCode: string
  itemName: string
  ruleText: string
  eligible: boolean
  /** 符合或不符合的原因——「不符合」一定要說明為什麼，櫃台才能回答病人 */
  reason: string
  lastDate?: string
  /** 下次可做的日期（因間隔未到而不符合時才有） */
  nextDate?: string
}

/** 回傳 null 表示年齡性別等條件符合，否則回傳不符合的原因 */
function basicRule(p: Patient, code: string, age: number): string | null {
  const female = p.gender === 'F'
  const fam = (x: string) => p.familyHistory.includes(x)
  switch (code) {
    case 'ADULT':
      return age >= 40 ? null : '未滿 40 歲'
    case 'CERVIX':
      if (!female) return '限女性'
      return age >= 30 ? null : '未滿 30 歲'
    case 'BREAST':
      if (!female) return '限女性'
      if (age >= 45 && age <= 69) return null
      if (age >= 40 && age <= 44 && fam('乳癌')) return null
      return '年齡不符（45–69 歲，或 40–44 歲且有乳癌家族史）'
    case 'COLON':
      return age >= 45 && age <= 74 ? null : '年齡不符（45–74 歲）'
    case 'ORAL':
      if (age < 30) return '未滿 30 歲'
      return p.smoking || p.betelNut ? null : '無吸菸或嚼檳榔習慣'
    case 'LUNG': {
      const [min, max] = female ? [45, 74] : [50, 74]
      if (age < min || age > max) return `年齡不符（${female ? '女 45' : '男 50'}–74 歲）`
      return fam('肺癌') || p.smoking ? null : '無肺癌家族史或吸菸史'
    }
    case 'BCLIVER':
      return age >= 45 && age <= 79 ? null : '年齡不符（45–79 歲）'
    case 'CHILD':
      return age < 7 ? null : '已滿 7 歲'
    default:
      return '未定義的項目'
  }
}

export function checkEligibility(p: Patient, item: PreventItem, records: PreventRecord[], at: string): Eligibility {
  const age = ageOf(p.birthDate, at)
  const base = { itemCode: item.code, itemName: item.name, ruleText: item.ruleText }
  // 只看判斷日（含）以前的紀錄：用過去的日期判斷時，不能被「未來」的紀錄影響
  // 作廢的紀錄（登錄錯誤）不算做過，不佔資格
  const mine = records.filter((r) => !r.voided && r.patientId === p.id && r.itemCode === item.code && r.date <= at).sort((a, b) => b.date.localeCompare(a.date))
  const last = mine[0]?.date

  const notOk = basicRule(p, item.code, age)
  if (notOk) return { ...base, eligible: false, reason: notOk, lastDate: last }
  // 同一天不能做兩次（也擋住兩個櫃台同時登錄同一人）
  if (last === at) return { ...base, eligible: false, reason: '今天已執行', lastDate: last }

  if (item.code === 'CHILD') {
    if (mine.length >= 7) return { ...base, eligible: false, reason: '7 次已全部使用', lastDate: last }
    return { ...base, eligible: true, reason: `已使用 ${mine.length} / 7 次`, lastDate: last }
  }
  if (!last) return { ...base, eligible: true, reason: '符合資格，尚無紀錄' }
  if (item.intervalYears === 0) return { ...base, eligible: false, reason: `終身 1 次，已於 ${toRoc(last)} 使用`, lastDate: last }

  // 成人預防保健 65 歲以上每年一次
  const years = item.code === 'ADULT' && age >= 65 ? 1 : item.intervalYears
  const nextDate = addYears(last, years)
  if (nextDate > at) return { ...base, eligible: false, reason: `距上次（${toRoc(last)}）未滿 ${years} 年，${toRoc(nextDate)} 起可再做`, lastDate: last, nextDate }
  return { ...base, eligible: true, reason: `符合資格（上次 ${toRoc(last)}）`, lastDate: last }
}

/**
 * 結果與檢查內容是否完整（純函式）：登錄、補登報告、種子資料、測試共用。
 * 回傳「欄位 → 錯誤訊息」，一次列出所有問題；沒有問題回傳空物件。
 *
 *   正常／異常需追蹤：這是定案的結果，項目設定的欄位（item.fields）全部要填——
 *     「正常」卻沒有任何數據，等於沒有做檢查，卻佔掉了資格、計入統計。
 *   待報告：檢體送驗中，結果還沒出來，可以不填（補登報告時再填）。
 *
 * 欄位錯誤的鍵：結果是 'result'，檢查內容是 'data:欄位名'（例：'data:血壓'）。
 */
export const FINAL_RESULTS: PreventRecord['result'][] = ['正常', '異常需追蹤']

export function checkPreventResult(
  item: Pick<PreventItem, 'fields'>,
  result: string | undefined,
  data: Record<string, string> | undefined,
  opts: { allowPending: boolean },
): Record<string, string> {
  const allowed: string[] = opts.allowPending ? [...FINAL_RESULTS, '待報告'] : FINAL_RESULTS
  if (!result || !allowed.includes(result)) return { result: '請選擇結果' }
  if (result === '待報告') return {}
  const errors: Record<string, string> = {}
  for (const f of item.fields) if (!String(data?.[f] ?? '').trim()) errors[`data:${f}`] = `請填寫${f}`
  return errors
}
