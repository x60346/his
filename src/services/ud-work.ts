// 住院調劑（UD）的服務層內部判斷：哪一劑可以調劑、哪幾劑要退。
// 不在 services/index.ts 對外（ud.ts 的匯出都會變成 API）；ud.ts 的工作清單、首頁待辦共用這裡。
import type { IpdOrder, MarRecord, UdLine } from '@/types'
import { db } from '@/mock/db'
import type { UdReturnCause } from './ud-rules'
import { find } from './views'

const isUdOrder = (o: IpdOrder | undefined): o is IpdOrder => !!o && o.category === 'medication' && o.type === 'long' && o.status === 'active' && !!o.drugId && o.freq !== 'PRN'

/** 還沒調劑、可以調劑的那一劑（醫囑有效、病人住院中） */
export function udCandidate(m: MarRecord): IpdOrder | undefined {
  if (m.status !== 'pending' || m.udLineId) return undefined
  const o = db.ipdOrders.find((x) => x.id === m.orderId)
  if (!isUdOrder(o)) return undefined
  return find.admission(m.admissionId)?.status === 'admitted' ? o : undefined
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

/** 這一行還沒點收、要退的劑量（只有可換算、真的有發的才退） */
export function pendingReturn(line: UdLine): { marIds: string[]; causes: UdReturnCause[] } {
  if (!line.perDose || !line.txnId) return { marIds: [], causes: [] }
  const settled = new Set((line.returns ?? []).flatMap((r) => r.marIds))
  const out = { marIds: [] as string[], causes: [] as UdReturnCause[] }
  for (const id of line.marIds) {
    if (settled.has(id)) continue
    const c = returnCause(id, line)
    if (c) {
      out.marIds.push(id)
      out.causes.push(c)
    }
  }
  return out
}

