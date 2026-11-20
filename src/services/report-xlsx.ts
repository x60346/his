// 報表 → Excel（.xlsx）。內容和 CSV 同一份「報表表格」（report-csv.ts），只是分工作表、數字是數字：
//   收費報表：「明細」（一筆一列、表頭凍結，可直接篩選加總）、「合計」、區間報表另有「每日小計」
//   管制藥簿冊：一張，抬頭在上、逐筆收支結存、合計在下（和紙本簿冊同一個樣子）
import type { DailyReport } from './charge'
import type { ControlledLedger, ControlledReport } from './controlled'
import type { ManagementReport } from './management'
import { MGMT_KPIS, mgmtChangeText } from './management-rules'
import { controlledLedgerFileName, controlledLedgerTable, controlledReportFileName, controlledReportTable, dailyReportTable, reportFileName } from './report-csv'
import { buildXlsx, type XlsxSheet } from './xlsx'

export function dailyReportXlsx(r: DailyReport): Uint8Array {
  const t = dailyReportTable(r)
  const sheets: XlsxSheet[] = [
    { name: '明細', rows: [t.head, ...t.rows], bold: [0], freeze: 1 },
    { name: '合計', rows: [['報表期間', t.period], [], t.totalsHead, ...t.totals], bold: [2] },
  ]
  if (t.byDay.length) sheets.push({ name: '每日小計', rows: [t.byDayHead, ...t.byDay], bold: [0], freeze: 1 })
  return buildXlsx(sheets)
}

export const reportXlsxFileName = (r: Pick<DailyReport, 'date' | 'to'>) => reportFileName(r).replace(/\.csv$/, '.xlsx')

export function controlledLedgerXlsx(r: ControlledLedger): Uint8Array {
  const t = controlledLedgerTable(r)
  return buildXlsx([{ name: '收支結存簿冊', rows: t.rows, bold: [0, t.headRow], freeze: t.headRow + 1 }])
}

export const controlledLedgerXlsxFileName = (r: Pick<ControlledLedger, 'drug' | 'locationName' | 'from' | 'to'>) => controlledLedgerFileName(r).replace(/\.csv$/, '.xlsx')

/** 管制藥品收支結存申報表：一張工作表，表頭與全院合計粗體 */
export function controlledReportXlsx(r: ControlledReport): Uint8Array {
  const t = controlledReportTable(r)
  return buildXlsx([{ name: '收支結存申報', rows: t.rows, bold: [0, t.headRow, ...t.totalRows], freeze: t.headRow + 1 }])
}

export const controlledReportXlsxFileName = (r: Pick<ControlledReport, 'from' | 'to'>) => controlledReportFileName(r).replace(/\.csv$/, '.xlsx')

/**
 * 經營月報：「摘要」（指標 × 本月、上月、去年同月、增減）、「門診科別」「門診醫師」「住院科別」「近 12 個月」。
 * 沒有資料的格子留空（不是 0，免得被當成真的是零）
 */
export function managementXlsx(r: ManagementReport): Uint8Array {
  const cell = (v: number | null | undefined) => (v === null || v === undefined ? '' : v)
  const sum = [
    ['經營月報', `${r.month}${r.partial ? `（算到 ${r.to}）` : ''}`, `病床 ${r.beds} 床`],
    [],
    ['分類', '指標', '單位', r.month, `上月 ${r.prev.month}`, `去年同月 ${r.lastYear.month}`, '比上月', '比去年同月'],
    ...MGMT_KPIS.map((k) => [k.group, k.label, k.unit, cell(r.current[k.key]), cell(r.prev[k.key]), cell(r.lastYear[k.key]), mgmtChangeText(r.current[k.key], r.prev[k.key], k.unit), mgmtChangeText(r.current[k.key], r.lastYear[k.key], k.unit)]),
  ]
  return buildXlsx([
    { name: '摘要', rows: sum, bold: [0, 2], freeze: 3 },
    { name: '門診科別', rows: [['科別', '人次', '初診', '占比 %'], ...r.opdByDept.map((d) => [d.deptName, d.visits, d.first, d.share])], bold: [0], freeze: 1 },
    { name: '門診醫師', rows: [['醫師', '科別', '人次'], ...r.opdByDoctor.map((d) => [d.doctorName, d.deptName, d.visits])], bold: [0], freeze: 1 },
    { name: '住院科別', rows: [['科別', '入院', '出院', '住院人日'], ...r.ipdByDept.map((d) => [d.deptName, d.admissions, d.discharges, d.patientDays])], bold: [0], freeze: 1 },
    { name: '近12個月', rows: [['月份', '門診人次', '實收', '佔床率 %', 'CMI', '淨核減率 %', '退件率 %'], ...r.trend.map((x) => [x.month, cell(x.opdVisits), cell(x.collected), cell(x.occupancy), cell(x.cmi), cell(x.cutRate), cell(x.rejectRate)])], bold: [0], freeze: 1 },
    { name: 'DRG', rows: [['DRG', '名稱', '權重', '筆數', '實際點數', '給付點數', '盈虧', '平均住院日'], ...r.drg.rows.map((d) => [d.code, d.name, d.weight, d.count, d.actual, d.pay, d.diff, d.alos]), [], [`不適用 DRG：${r.drg.exempt} 筆`]], bold: [0], freeze: 1 },
  ])
}

export const managementXlsxFileName = (r: Pick<ManagementReport, 'month'>) => `經營月報_${r.month}.xlsx`
