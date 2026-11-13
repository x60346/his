// 報表匯出（純函式）：CSV 與 Excel（report-xlsx.ts）都從這裡的「報表表格」產生——內容由服務層決定、兩種格式數字一致，頁面只負責觸發下載。
import type { DailyReport } from './charge'
import type { ControlledLedger } from './controlled'

const PAY: Record<string, string> = { cash: '現金', card: '刷卡', mobile: '行動支付' }

/**
 * 一個欄位轉成 CSV：含逗號、引號、換行的要加引號（引號要重複一次）。
 * 文字以 = + - @ 開頭的前面加 '：Excel 會把這種儲存格當公式執行（CSV 注入），
 * 病人姓名、備註是外部輸入，不能讓它變成公式。數字照原樣輸出（負數是金額，不是公式）。
 */
export function csvCell(v: string | number | undefined | null): string {
  if (v === undefined || v === null) return ''
  if (typeof v === 'number') return String(v)
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

type Cells = (string | number | undefined | null)[]
const line = (cells: Cells) => cells.map(csvCell).join(',')

/**
 * 報表 → CSV 文字：
 *   1. 明細：收據（含作廢，標狀態）與收回欠款同一張表，依時間排序——會計對帳最常用的是一筆一筆的流水
 *   2. 空一行後列合計：應收、新欠、收回、實收、作廢，和畫面上的數字同一份資料
 * 開頭加 BOM，Excel 才會用 UTF-8 開（否則中文亂碼）；換行用 CRLF（Excel 的慣例）。
 */
export interface DailyReportTable {
  period: string
  head: string[]
  rows: Cells[]
  totalsHead: string[]
  totals: Cells[]
  byDayHead: string[]
  /** 只有區間報表（兩天以上）才有 */
  byDay: Cells[]
}

/** 報表 → 表格（CSV、Excel 共用）：明細依時間排序、合計、每日小計 */
export function dailyReportTable(r: DailyReport): DailyReportTable {
  const head = ['類別', '收據號碼', '日期', '時間', '病歷號', '姓名', '科別', '付款方式', '金額', '欠款', '申報點數', '收費人員', '狀態', '原收據']
  const rows: { at: string; key: string; cells: (string | number | undefined)[] }[] = [
    ...r.charges.map((c) => ({
      at: c.paidAt,
      key: c.receiptNo,
      cells: ['收費', c.receiptNo, c.paidAt.slice(0, 10), c.paidAt.slice(11), c.chartNo, c.patientName, c.deptName, PAY[c.payMethod], c.patientTotal, c.owed ?? 0, c.nhiPoints, c.cashierName, c.refund ? '已退費' : c.voided ? '作廢' : '有效', ''],
    })),
    ...r.repayments.map((x) => ({
      at: x.at,
      key: x.receiptNo,
      cells: ['收回欠款', x.receiptNo, x.at.slice(0, 10), x.at.slice(11), x.chartNo, x.patientName, '', PAY[x.payMethod], x.amount, '', '', x.cashierName, '有效', x.originalReceiptNo],
    })),
    // 掛號預收：算在收的那天
    ...r.prepays.map((x) => ({
      at: x.at,
      key: x.receiptNo,
      cells: ['掛號預收', x.receiptNo, x.at.slice(0, 10), x.at.slice(11), x.chartNo, x.patientName, '', PAY[x.payMethod], x.amount, '', '', x.cashierName, '有效', ''],
    })),
    // 退款：負數，算在退款那天
    ...r.refunds.map((x) => ({
      at: x.at,
      key: x.receiptNo,
      cells: [x.kind === '退預收' ? '退還預收' : x.kind === '部分退費' ? '部分退費' : '退款', x.receiptNo, x.at.slice(0, 10), x.at.slice(11), x.chartNo, x.patientName, '', x.payMethods, -x.amount, '', '', x.cashierName, '有效', x.originalReceiptNo],
    })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key))
  return {
    period: r.date === r.to ? r.date : `${r.date} ~ ${r.to}`,
    head,
    rows: rows.map((x) => x.cells),
    totalsHead: ['合計', '金額'],
    totals: [
      ['應收合計（有效收據）', r.patientTotal],
      // 合計列的名稱不要和明細的「類別」同名（收費、收回欠款）：在 Excel 篩選類別時才不會混進來
      ['新記欠款合計', r.newDebt],
      ['收回欠款合計', r.repaid],
      ['掛號預收合計', r.prepaidIn],
      ['預收扣抵合計', -r.prepaidApplied],
      ['退款合計', -r.refunded],
      ['實收合計', r.collected],
      ['有效收據張數', r.count],
      ['作廢收據', `${r.voidedCount} 張`, r.voidedTotal],
      ['健保申報點數', r.nhiPoints],
    ],
    byDayHead: ['日期', '收據張數', '應收', '新欠', '收回', '預收', '預收扣抵', '退款', '實收'],
    byDay: r.byDay.length > 1 ? r.byDay.map((d) => [d.date, d.count, d.patientTotal, d.newDebt, d.repaid, d.prepaidIn, -d.prepaidApplied, -d.refunded, d.collected]) : [],
  }
}

/** 報表 → CSV 文字（一張表：期間、明細、空一行、合計、空一行、每日小計） */
export function dailyReportCsv(r: DailyReport): string {
  const t = dailyReportTable(r)
  const out = [line(['報表期間', t.period]), line(t.head), ...t.rows.map(line), '', line(t.totalsHead), ...t.totals.map(line)]
  if (t.byDay.length) out.push('', line(t.byDayHead), ...t.byDay.map(line))
  return '\uFEFF' + out.join('\r\n') + '\r\n'
}

/** 下載檔名：日結_2026-11-12.csv、收費報表_2026-11-01_2026-11-30.csv */
export const reportFileName = (r: Pick<DailyReport, 'date' | 'to'>) => (r.date === r.to ? `日結_${r.date}.csv` : `收費報表_${r.date}_${r.to}.csv`)

/**
 * 管制藥簿冊 → CSV：表頭（藥品、級別、地點、期間、期初）、逐筆（收入、支出、結存、病人、醫師、經手、見證）、合計（期末）。
 * 和畫面同一份資料（controlled.controlledLedger）
 */
export function controlledLedgerTable(r: ControlledLedger): { rows: Cells[]; headRow: number } {
  const rows: Cells[] = [
    ['管制藥品收支結存簿冊'],
    ['藥品', `${r.drug.name}（${r.drug.nameZh}）`, `第 ${r.drug.controlled} 級`, r.drug.spec],
    ['地點', r.locationName, '期間', `${r.from} ～ ${r.to}`, '單位', r.drug.unit],
    [],
    ['日期時間', '類別', '收入', '支出', '殘餘量銷毀', '結存', '單號', '病人', '病歷號', '開立醫師', '經手人', '見證人', '說明'],
    ['', '期初', '', '', '', r.opening],
  ]
  for (const x of r.rows) {
    rows.push([x.at, x.typeLabel, x.kind === 'in' ? x.qty : '', x.kind === 'out' ? x.qty : '', x.kind === 'residual' ? x.qty : '', x.balance, x.ref, x.patientName, x.chartNo, x.doctorName, x.userName, x.witnessName, x.reason])
  }
  rows.push([], ['收入合計', r.totalIn], ['支出合計', r.totalOut], ['殘餘量銷毀合計', r.residualTotal], ['期末結存', r.closing])
  return { rows, headRow: 4 }
}

export function controlledLedgerCsv(r: ControlledLedger): string {
  return '\uFEFF' + controlledLedgerTable(r).rows.map(line).join('\r\n') + '\r\n'
}

export const controlledLedgerFileName = (r: Pick<ControlledLedger, 'drug' | 'locationName' | 'from' | 'to'>) => `管制藥簿冊_${r.drug.name.replace(/\s+/g, '')}_${r.locationName}_${r.from}_${r.to}.csv`
