// 病房常備的內部工具（index 不匯出、不會被包成 API）：效期快到、過期的批號與首頁計數。API 在 ward-stock.ts
import { db } from '@/mock/db'
import { addDays, diffDays } from '@/utils/date'
import { isExpired, WARD_RETURN_DAYS } from './stock-rules'
import { find } from './views'

export interface WardExpiryLot {
  lotId: string
  drugId: string
  drugName: string
  lotNo: string
  expiry: string
  qty: number
  expired: boolean
  /** 還有幾天到期（過期是負的） */
  daysLeft: number
  /** 管制藥級別（收回要見證） */
  controlled?: number
}

/** 病房常備過期、30 天內到期的批號（有量的） */
export function wardExpiryLots(locId: string, t: string): WardExpiryLot[] {
  return db.drugLots
    .filter((l) => l.locationId === locId && l.qty > 0 && (isExpired(l.expiry, t) || l.expiry <= addDays(t, WARD_RETURN_DAYS)))
    .map((l) => ({ lotId: l.id, drugId: l.drugId, drugName: find.drug(l.drugId)?.name ?? l.drugId, lotNo: l.lotNo, expiry: l.expiry, qty: l.qty, expired: isExpired(l.expiry, t), daysLeft: diffDays(t, l.expiry), ...((c) => (c ? { controlled: c } : {}))(find.drug(l.drugId)?.controlled) }))
    .sort((a, b) => a.expiry.localeCompare(b.expiry))
}

/** 首頁（藥師）：各病房常備裡已過期、30 天內到期的批號數 */
export function wardExpiryCounts(t: string) {
  const locs = db.stockLocations.filter((l) => l.kind === 'ward' && l.active)
  const xs = locs.flatMap((l) => wardExpiryLots(l.id, t))
  return { expired: xs.filter((x) => x.expired).length, soon: xs.filter((x) => !x.expired).length }
}

