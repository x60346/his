// 收費報表匯出 CSV（純函式）：交給會計用 Excel 開。內容由服務層決定，頁面只負責觸發下載。
import type { DailyReport } from './charge'

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

const line = (cells: (string | number | undefined | null)[]) => cells.map(csvCell).join(',')

/**
 * 報表 → CSV 文字：
 *   1. 明細：收據（含作廢，標狀態）與收回欠款同一張表，依時間排序——會計對帳最常用的是一筆一筆的流水
 *   2. 空一行後列合計：應收、新欠、收回、實收、作廢，和畫面上的數字同一份資料
 * 開頭加 BOM，Excel 才會用 UTF-8 開（否則中文亂碼）；換行用 CRLF（Excel 的慣例）。
 */
export function dailyReportCsv(r: DailyReport): string {
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
    // 退款：負數，算在退款那天
    ...r.refunds.map((x) => ({
      at: x.at,
      key: x.receiptNo,
      cells: ['退款', x.receiptNo, x.at.slice(0, 10), x.at.slice(11), x.chartNo, x.patientName, '', x.payMethods, -x.amount, '', '', x.cashierName, '有效', x.originalReceiptNo],
    })),
  ].sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key))
  const period = r.date === r.to ? r.date : `${r.date} ~ ${r.to}`
  const out = [
    line(['報表期間', period]),
    line(head),
    ...rows.map((x) => line(x.cells)),
    '',
    line(['合計', '金額']),
    line(['應收合計（有效收據）', r.patientTotal]),
    // 合計列的名稱不要和明細的「類別」同名（收費、收回欠款）：在 Excel 篩選類別時才不會混進來
    line(['新記欠款合計', r.newDebt]),
    line(['收回欠款合計', r.repaid]),
    line(['退款合計', -r.refunded]),
    line(['實收合計', r.collected]),
    line(['有效收據張數', r.count]),
    line(['作廢收據', `${r.voidedCount} 張`, r.voidedTotal]),
    line(['健保申報點數', r.nhiPoints]),
  ]
  if (r.byDay.length > 1) {
    out.push('', line(['日期', '收據張數', '應收', '新欠', '收回', '退款', '實收']))
    for (const d of r.byDay) out.push(line([d.date, d.count, d.patientTotal, d.newDebt, d.repaid, -d.refunded, d.collected]))
  }
  return '﻿' + out.join('\r\n') + '\r\n'
}

/** 下載檔名：日結_2026-11-12.csv、收費報表_2026-11-01_2026-11-30.csv */
export const reportFileName = (r: Pick<DailyReport, 'date' | 'to'>) => (r.date === r.to ? `日結_${r.date}.csv` : `收費報表_${r.date}_${r.to}.csv`)
