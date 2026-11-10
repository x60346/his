// 首頁儀表板：今日營運指標與近 7 日門診人次趨勢。
import { db } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { query } from './http'
import { nameOf } from './views'

export interface DashboardStats {
  date: string
  opd: { total: number; waiting: number; inConsult: number; toCharge: number; toDispense: number; done: number; cancelled: number }
  revenue: { patientTotal: number; nhiPoints: number; receipts: number }
  ipd: { admitted: number; reservedToday: number; emptyBeds: number; totalBeds: number; overdueMar: number }
  lowStockDrugs: number
  byDept: { deptName: string; count: number }[]
  trend: { date: string; count: number }[]
}

export function getDashboard(): Promise<DashboardStats> {
  return query(() => {
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
        toDispense: db.dispenses.filter((d) => d.createdAt.startsWith(t) && d.status !== 'dispensed').length,
        done: count('charged') + count('dispensed'),
        cancelled: count('cancelled'),
      },
      revenue: {
        patientTotal: charges.reduce((s, c) => s + c.patientTotal, 0),
        nhiPoints: charges.reduce((s, c) => s + c.nhiPoints, 0),
        receipts: charges.length,
      },
      ipd: {
        admitted: db.admissions.filter((a) => a.status === 'admitted').length,
        reservedToday: db.admissions.filter((a) => a.status === 'reserved' && a.expectedDate <= t).length,
        emptyBeds: db.beds.filter((b) => b.status === 'empty').length,
        totalBeds: db.beds.length,
        overdueMar: db.mar.filter((m) => m.status === 'pending' && m.scheduledAt < n).length,
      },
      lowStockDrugs: db.drugs.filter((d) => d.active && d.stock <= d.safetyStock).length,
      byDept: [...dept.entries()].map(([id, c]) => ({ deptName: nameOf.dept(id), count: c })).sort((a, b) => b.count - a.count),
      trend: Array.from({ length: 7 }, (_, i) => {
        const date = addDays(t, i - 6)
        return { date, count: db.visits.filter((v) => v.date === date && v.status !== 'cancelled').length }
      }),
    }
  })
}
