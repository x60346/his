// 首頁儀表板：今日營運指標與近 7 日門診人次趨勢。
import { db } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { query, sessionRole, sessionUser } from './http'
import { openQuery } from './nursing-rules'
import { nameOf, openDeptTransfer, stockLoc } from './views'
import { usableQty } from './stock-rules'
import { suspendNoticeVisits } from './schedule'
import { awaitingPickup } from './pharmacy'
import { pendingReturn, udCandidate } from './ud-work'

export interface DashboardStats {
  date: string
  opd: { total: number; waiting: number; inConsult: number; toCharge: number; toDispense: number; done: number; cancelled: number }
  /** 今日收入：只回傳給掛號批價與管理員——財務數字不是每個角色都該看到（只在畫面上藏起來不夠，資料本身就不送） */
  revenue?: { patientTotal: number; nhiPoints: number; receipts: number }
  ipd: { admitted: number; reservedToday: number; emptyBeds: number; totalBeds: number; overdueMar: number }
  /** 停診退掛、還沒電話通知的病人數（櫃台待辦） */
  suspendNoticesPending: number
  lowStockDrugs: number
  /** 補貨申請待到貨（和藥品庫存頁「待到貨」卡片同一個來源） */
  restockOpen: number
  /** 採購單待核准（管理員待辦）、已訂購待到貨（藥師待辦） */
  purchasePending: number
  purchaseOrdered: number
  /** 醫師：我（主治）的住院病人有幾筆醫囑疑問待回覆 */
  orderQueries?: number
  /** 醫師：轉入我科、等我接的轉科申請 */
  transferIncoming?: number
  /** 住院藥局：今天還沒調劑的劑量（補調劑）、待退藥點收的項數 */
  udExtra: number
  udReturns: number
  /** 大型醫院：撥補單待撥發（請領中）、待簽收（運送中）；小型醫院沒有（不回傳） */
  transferRequested?: number
  transferIssued?: number
  byDept: { deptName: string; count: number }[]
  trend: { date: string; count: number }[]
}

export function getDashboard(): Promise<DashboardStats> {
  return query(() => {
    const seesRevenue = ['clerk', 'admin'].includes(sessionRole() ?? '') // 看「現在用的角色」：護理師兼櫃台，以護理師身分時看不到收入
    const t = today()
    const n = now()
    const visits = db.visits.filter((v) => v.date === t)
    const active = visits.filter((v) => v.status !== 'cancelled')
    const count = (s: string) => visits.filter((v) => v.status === s).length
    const charges = db.charges.filter((c) => !c.voided && c.paidAt.startsWith(t))

    const dept = new Map<string, number>()
    for (const v of active) dept.set(v.deptId, (dept.get(v.deptId) ?? 0) + 1)

    return {
      date: t,
      opd: {
        total: active.length,
        waiting: count('registered'),
        inConsult: count('in-consult'),
        toCharge: count('consulted'),
        // 與藥局清單同一規則：今天以前開立、還沒發藥的都算（前幾日沒領的也還在等）
        toDispense: db.dispenses.filter((d) => awaitingPickup(d, t)).length,
        done: count('charged') + count('dispensed'),
        cancelled: count('cancelled'),
      },
      revenue: seesRevenue
        ? {
            patientTotal: charges.reduce((s, c) => s + c.patientTotal, 0),
            nhiPoints: charges.reduce((s, c) => s + c.nhiPoints, 0),
            receipts: charges.length,
          }
        : undefined,
      ipd: {
        admitted: db.admissions.filter((a) => a.status === 'admitted').length,
        reservedToday: db.admissions.filter((a) => a.status === 'reserved' && a.expectedDate <= t).length,
        emptyBeds: db.beds.filter((b) => b.status === 'empty').length,
        totalBeds: db.beds.length,
        overdueMar: db.mar.filter((m) => m.status === 'pending' && m.scheduledAt < n).length,
      },
      suspendNoticesPending: suspendNoticeVisits(t).filter((v) => !v.notifiedAt).length,
      // 門診藥局的可用量（不含過期品）低於該地點的安全庫存；和藥品庫存頁的「缺貨／偏低」同一個判斷
      lowStockDrugs: db.drugs.filter((d) => d.active && usableQty(stockLoc.lots(d.id, stockLoc.opd()), today()) <= stockLoc.safety(d, stockLoc.opd())).length,
      udExtra: db.mar.filter((m) => m.scheduledAt.slice(0, 10) <= today() && !!udCandidate(m)).length,
      udReturns: db.udDispenses.flatMap((u) => u.lines).filter((l) => pendingReturn(l).marIds.length > 0).length,
      restockOpen: db.restockRequests.filter((x) => x.status === 'open' && db.drugs.some((d) => d.id === x.drugId && d.active)).length,
      purchasePending: db.purchaseOrders.filter((p) => p.status === 'pending').length,
      ...(() => {
        const me = sessionUser()
        if (sessionRole() !== 'doctor' || !me?.doctorId) return {}
        const mine = new Set(db.admissions.filter((a) => a.status === 'admitted' && a.doctorId === me.doctorId).map((a) => a.id))
        const myDept = db.doctors.find((d) => d.id === me.doctorId)?.deptId
        return {
          orderQueries: db.ipdOrders.filter((o) => mine.has(o.admissionId) && !!openQuery(o)).length,
          transferIncoming: db.admissions.filter((a) => {
            const x = a.status === 'admitted' ? openDeptTransfer(a) : undefined
            return x && x.toDeptId === myDept && (!x.toDoctorId || x.toDoctorId === me.doctorId)
          }).length,
        }
      })(),
      purchaseOrdered: db.purchaseOrders.filter((p) => p.status === 'ordered').length,
      ...(db.stockLocations.length > 1
        ? { transferRequested: db.transfers.filter((x) => x.status === 'requested').length, transferIssued: db.transfers.filter((x) => x.status === 'issued').length }
        : {}),
      byDept: [...dept.entries()].map(([id, c]) => ({ deptName: nameOf.dept(id), count: c })).sort((a, b) => b.count - a.count),
      trend: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(t, i - 6)
        return { date, count: db.visits.filter((v) => v.date === date && v.status !== 'cancelled').length }
      }),
    }
  })
}
