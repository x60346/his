// 腎功能劑量提醒（開醫囑對話框用）：選了藥就查這位病人的 CrCl 與這支藥的分級建議。規則在 renal-rules，資料在 renal-work
import { db } from '@/mock/db'
import { query } from './http'
import { renalBandOf } from './renal-rules'
import { renalOf } from './renal-work'
import { find } from './views'

/** 主檔有腎功能分級的藥才回：CrCl 與落在哪一級（算不出也回原因，提醒先補資料）；其他藥回 null */
export function renalHintOf(admissionId: string, drugId: string): Promise<{ crcl: number | null; text: string; advice?: string } | null> {
  return query(() => {
    const bands = find.drug(drugId)?.renal
    if (!bands?.length || !db.admissions.some((a) => a.id === admissionId)) return null
    const r = renalOf(admissionId)
    const band = renalBandOf(bands, r.crcl)
    return { crcl: r.crcl, text: r.text, ...(band ? { advice: `CrCl < ${band.below}：${band.text}${band.freq ? `（${band.freq}）` : ''}` } : {}) }
  })
}
