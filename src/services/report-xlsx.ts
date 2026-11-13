// 報表 → Excel（.xlsx）。內容和 CSV 同一份「報表表格」（report-csv.ts），只是分工作表、數字是數字：
//   收費報表：「明細」（一筆一列、表頭凍結，可直接篩選加總）、「合計」、區間報表另有「每日小計」
//   管制藥簿冊：一張，抬頭在上、逐筆收支結存、合計在下（和紙本簿冊同一個樣子）
import type { DailyReport } from './charge'
import type { ControlledLedger } from './controlled'
import { controlledLedgerFileName, controlledLedgerTable, dailyReportTable, reportFileName } from './report-csv'
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
