// 檢驗品管（QC）：檢驗科每天每個品管項目登打兩個濃度的品管值，系統用 Westgard 判定（1-3s、2-2s 拒絕；1-2s 警告）；
// 今天沒做、或最後一次被拒絕的項目不能發報告（lab.reportLab 擋）；拒絕後重做要寫矯正措施。Levey-Jennings 圖看近 20 天。
// 規則與品管液主檔在 qc-rules
import type { QcRun } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now } from '@/utils/date'
import { audit, failFields, mutate, query, requireUser } from './http'
import { checkQcInput, qcAnalyte, QC_ANALYTES, QC_RESULT_LABEL, qcStatusToday, qcZ, westgard } from './qc-rules'
import { nameOf } from './views'

export interface QcRunView extends QcRun {
  byName: string
  resultLabel: string
}
const view = (r: QcRun): QcRunView => ({ ...r, byName: nameOf.user(r.by), resultLabel: QC_RESULT_LABEL[r.result] })

export interface QcOverview {
  date: string
  analytes: {
    code: string
    name: string
    unit: string
    levels: { mean: number; sd: number }[]
    status: 'ok' | 'warn' | 'reject' | 'missing'
    /** 近 20 天（含今天）的紀錄，舊的在前：畫 Levey-Jennings 圖 */
    runs: QcRunView[]
  }[]
}

/** 品管頁：每個項目今天的狀態與近 20 天紀錄 */
export function qcOverview(): Promise<QcOverview> {
  return query(() => {
    requireUser('lab')
    const date = now().slice(0, 10)
    const from = addDays(date, -19)
    return {
      date,
      analytes: QC_ANALYTES.map((a) => ({
        code: a.code, name: a.name, unit: a.unit, levels: a.levels, status: qcStatusToday(db.qcRuns, a.code, date),
        runs: db.qcRuns.filter((r) => r.analyte === a.code && r.date >= from).sort((x, y) => x.at.localeCompare(y.at)).map(view),
      })),
    }
  })
}

/** 登打一次品管：Westgard 判定（2-2s 也看同一項目上一次）；同一天上一次被拒絕的要寫矯正措施 */
export function recordQc(input: { analyte: string; values: [number, number]; correction?: string }): Promise<QcRunView> {
  return mutate(() => {
    const u = requireUser('lab')
    const t = now()
    const date = t.slice(0, 10)
    const lastToday = db.qcRuns.filter((r) => r.analyte === input.analyte && r.date === date).sort((a, b) => a.at.localeCompare(b.at)).at(-1)?.result
    failFields(checkQcInput(input, lastToday))
    const values: [number, number] = [Number(input.values[0]), Number(input.values[1])]
    const z: [number, number] = [qcZ(input.analyte, 0, values[0]), qcZ(input.analyte, 1, values[1])]
    const prev = db.qcRuns.filter((r) => r.analyte === input.analyte).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
    const { result, rules } = westgard(z, prev?.z)
    const r: QcRun = { id: newId('QC'), analyte: input.analyte, date, at: t, by: u.id, values, z, result, rules, ...(input.correction?.trim() ? { correction: input.correction.trim() } : {}) }
    db.qcRuns.push(r)
    audit('檢驗品管', `${qcAnalyte(input.analyte)!.name}：${values.join('／')}（z ${z.join('／')}）${QC_RESULT_LABEL[result]}${rules.length ? `（${rules.join('、')}）` : ''}${r.correction ? `；矯正：${r.correction}` : ''}`)
    return view(r)
  })
}
