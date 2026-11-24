// 給藥紀錄更正：哪些可以改、改成什麼（服務層內部；畫面與 correctMar 共用同一個判斷）。
//   暫停／拒絕 → 已給藥：病人檢查回來後還是給了、病人後來願意吃。藥要還在病房（還沒送回藥局）、醫囑還有效
//   暫停 ↔ 拒絕：原因記錯
//   已給藥 → 暫停／拒絕：按錯列（藥其實沒給）。只限藥局調劑（UD）的排程給藥——改了之後這一劑照常列入「待送回藥局」；
//     PRN、臨時給藥扣的是病房常備，管制藥有簿冊與見證，系統不自動沖回，要通報病安、請藥局更正
// 只能更正 8 小時內（同一班）記的；更早的寫護理紀錄
import type { MarRecord } from '@/types'
import { db } from '@/mock/db'
import { addMinutes } from '@/utils/date'
import { MAR_CORRECT_MAX_MIN } from './nursing-rules'
import { udLineHome } from './ud-work'
import { find } from './views'

export type MarDoneStatus = Exclude<MarRecord['status'], 'pending'>

export interface MarCorrection {
  /** 可以改成哪些狀態 */
  to: MarDoneStatus[]
  /** 有些改不了的原因（例：已給藥不能改成未給的藥品類別、已送回藥局） */
  why?: string
}

/** 這一筆給藥紀錄現在能怎麼更正；不能更正（還沒執行、超過時間、病人已出院）回 undefined */
export function marCorrection(m: MarRecord, t: string): MarCorrection | undefined {
  if (m.status === 'pending') return undefined
  const at = m.recordedAt ?? m.executedAt
  if (!at || at < addMinutes(t, -MAR_CORRECT_MAX_MIN)) return undefined
  if (find.admission(m.admissionId)?.status !== 'admitted') return undefined
  const o = db.ipdOrders.find((x) => x.id === m.orderId)
  const d = o?.drugId ? find.drug(o.drugId) : undefined
  if (m.status === 'given') {
    if (o?.type !== 'long' || !m.udLineId || m.stockFrom || m.residual || d?.controlled) {
      return { to: [], why: 'PRN、臨時給藥與管制藥已扣病房常備或簿冊，不能在這裡改成未給：請通報病安，並請藥局更正' }
    }
    return { to: ['held', 'refused'] }
  }
  const other: MarDoneStatus = m.status === 'held' ? 'refused' : 'held'
  const home = m.udLineId ? udLineHome(m.udLineId) : undefined
  const sentBack = !!home && ((home.line.sendBacks ?? []).some((s) => s.marIds.includes(m.id)) || (home.line.returns ?? []).some((r) => r.marIds.includes(m.id)))
  if (sentBack) return { to: [other], why: '這一劑已送回藥局，不能改成已給藥' }
  if (o?.type === 'long' && o.status !== 'active') return { to: [other], why: '醫囑已停止，不能改成已給藥' }
  return { to: [other, 'given'] }
}
