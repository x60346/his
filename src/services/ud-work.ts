// 住院調劑（UD）的服務層內部判斷：哪一劑可以調劑、這一劑調到哪一步了、哪幾劑要退（病房送回了沒）。
// 不在 services/index.ts 對外（ud.ts 的匯出都會變成 API）；ud.ts、給藥（nursing）、給藥紀錄檢視（ipd）、首頁待辦共用這裡。
import type { IpdOrder, MarRecord, UdBox, UdDispense, UdLine } from '@/types'
import { db } from '@/mock/db'
import type { UdReturnCause } from './ud-rules'
import { find } from './views'

const isUdOrder = (o: IpdOrder | undefined): o is IpdOrder => !!o && o.category === 'medication' && o.type === 'long' && o.status === 'active' && !!o.drugId && o.freq !== 'PRN'

/** 還沒調劑、可以調劑的那一劑（醫囑有效、病人住院中）。退回重調的會清掉 udLineId，回到這裡 */
export function udCandidate(m: MarRecord): IpdOrder | undefined {
  if (m.status !== 'pending' || m.udLineId) return undefined
  const o = db.ipdOrders.find((x) => x.id === m.orderId)
  if (!isUdOrder(o)) return undefined
  return find.admission(m.admissionId)?.status === 'admitted' ? o : undefined
}

/** 一行調劑所在的調劑單與那位病人的藥盒 */
export function udLineHome(lineId: string): { disp: UdDispense; line: UdLine; box: UdBox } | undefined {
  for (const disp of db.udDispenses) {
    const line = disp.lines.find((l) => l.id === lineId)
    if (line) return { disp, line, box: disp.boxes.find((b) => b.admissionId === line.admissionId)! }
  }
  return undefined
}

/** 這一劑調到哪一步：verified 已核對送病房（可以給）、prepared 已調劑待核對；沒調劑回 undefined */
export function udStage(m: Pick<MarRecord, 'udLineId'>): 'verified' | 'prepared' | undefined {
  if (!m.udLineId) return undefined
  const st = udLineHome(m.udLineId)?.box.status
  return st === 'verified' ? 'verified' : st === 'prepared' ? 'prepared' : undefined
}

/** 發出去的這一劑為什麼不會給了（還會給的回 undefined） */
function returnCause(marId: string, line: UdLine): UdReturnCause | undefined {
  const m = db.mar.find((x) => x.id === marId)
  if (m) {
    if (m.status === 'refused') return 'refused'
    if (m.status === 'held') return m.note === '出院時未給藥' ? 'discharged' : 'held'
    return undefined
  }
  // 排程被刪了：停止醫囑、出院都會刪掉還沒給的排程
  if (find.admission(line.admissionId)?.status !== 'admitted') return 'discharged'
  return db.ipdOrders.find((o) => o.id === line.orderId)?.status === 'active' ? 'cancelled' : 'stopped'
}

export interface PendingReturn {
  marIds: string[]
  causes: UdReturnCause[]
}

/**
 * 這一行還沒點收、要退的劑量（只有可換算、真的發出去〔核對過、有扣帳〕的才退），分成：
 *   sent 病房已送回（藥師可以點收）、waiting 病房還沒送回（護理站待辦）
 */
export function pendingReturn(line: UdLine): { sent: PendingReturn; waiting: PendingReturn } {
  const empty = () => ({ marIds: [] as string[], causes: [] as UdReturnCause[] })
  const out = { sent: empty(), waiting: empty() }
  if (!line.perDose || !line.txnId) return out
  const settled = new Set((line.returns ?? []).flatMap((r) => r.marIds))
  const sentIds = new Set((line.sendBacks ?? []).flatMap((s) => s.marIds))
  for (const id of line.marIds) {
    if (settled.has(id)) continue
    const c = returnCause(id, line)
    if (!c) continue
    const bucket = sentIds.has(id) ? out.sent : out.waiting
    bucket.marIds.push(id)
    bucket.causes.push(c)
  }
  return out
}
