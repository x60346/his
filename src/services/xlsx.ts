// 產生 Excel（.xlsx）檔：純函式、不加套件。
// xlsx 是一包 XML 用 zip 包起來；我們只「寫」簡單表格，所以 zip 用不壓縮（stored）就好——
// 檔案大一點，但不需要 deflate，也不必相信一個為了讀寫各種格式而很大的套件。
// 只支援報表需要的：多張工作表、文字與數字儲存格、粗體列、凍結表頭、欄寬。
//
// 和 CSV 的差別（為什麼要有它）：
//   - 金額是真的數字，可以加總；病歷號、收據號、日期是文字，開頭的 0 不會掉、不會被轉成日期
//   - 文字一律存成 inline string，Excel 不會當公式執行（CSV 要在 = + - @ 前加 ' 才擋得住）
//   - 明細、合計、每日小計分開工作表，篩選明細不會混進合計

export type XlsxCell = string | number | null | undefined
export interface XlsxSheet {
  /** 工作表名稱：最多 31 字、不能有 [ ] : * ? / \，同一檔不能重複（buildXlsx 會替你修正） */
  name: string
  rows: XlsxCell[][]
  /** 粗體的列（從 0 起算） */
  bold?: number[]
  /** 凍結最上面幾列（捲動時表頭留著） */
  freeze?: number
}

// ---------- zip（stored，不壓縮） ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 把多個檔案包成 zip（不壓縮）。檔名都是 ASCII（xlsx 內部路徑），日期固定 1980-01-01：同樣內容產生同樣的檔案 */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const crc = crc32(f.data)
    const local = new Uint8Array(30 + name.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // method: stored
    lv.setUint16(10, 0, true) // time
    lv.setUint16(12, 0x21, true) // date 1980-01-01
    lv.setUint32(14, crc, true)
    lv.setUint32(18, f.data.length, true)
    lv.setUint32(22, f.data.length, true)
    lv.setUint16(26, name.length, true)
    lv.setUint16(28, 0, true)
    local.set(name, 30)
    parts.push(local, f.data)

    const cd = new Uint8Array(46 + name.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, 0x02014b50, true) // central directory header
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0x21, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, f.data.length, true)
    cv.setUint32(24, f.data.length, true)
    cv.setUint16(28, name.length, true)
    // 30 extra、32 comment、34 disk、36 internal attr、38 external attr 都是 0
    cv.setUint32(42, offset, true)
    cd.set(name, 46)
    central.push(cd)
    offset += local.length + f.data.length
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true) // end of central directory
  ev.setUint16(8, files.length, true)
  ev.setUint16(10, files.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const all = [...parts, ...central, end]
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0))
  let p = 0
  for (const a of all) {
    out.set(a, p)
    p += a.length
  }
  return out
}

// ---------- 工作表 XML ----------

/** XML 文字轉義；並拿掉 XML 不允許的控制字元（病人資料是外部輸入，一個怪字元就會讓整個檔打不開） */
export function xmlText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 0 → A、25 → Z、26 → AA */
export function colName(i: number): string {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}

/** 顯示寬度：中文（全形）算 2 格 */
const textWidth = (s: string) => [...s].reduce((n, ch) => n + (/[ᄀ-￿]/.test(ch) && !/[｡-ﾟ]/.test(ch) ? 2 : 1), 0)

/** 工作表名稱：Excel 的限制（31 字、不能有 []:*?/\、不能重複） */
function sheetNames(sheets: XlsxSheet[]): string[] {
  const used = new Set<string>()
  return sheets.map((s, i) => {
    const base = (s.name.replace(/[[\]:*?/\\]/g, '_').trim() || `工作表${i + 1}`).slice(0, 31)
    let name = base
    for (let k = 2; used.has(name.toLowerCase()); k++) name = `${base.slice(0, 31 - String(k).length - 1)}_${k}`
    used.add(name.toLowerCase())
    return name
  })
}

function sheetXml(s: XlsxSheet): string {
  const bold = new Set(s.bold ?? [])
  const widths: number[] = []
  const rows = s.rows.map((cells, r) => {
    const cs = cells.map((v, c) => {
      if (v === undefined || v === null || v === '') return ''
      const ref = `${colName(c)}${r + 1}`
      const style = bold.has(r) ? ' s="1"' : ''
      if (typeof v === 'number') {
        if (!Number.isFinite(v)) return ''
        widths[c] = Math.max(widths[c] ?? 0, String(v).length)
        return `<c r="${ref}"${style}><v>${v}</v></c>`
      }
      widths[c] = Math.max(widths[c] ?? 0, Math.max(...v.split('\n').map(textWidth)))
      return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`
    })
    return `<row r="${r + 1}">${cs.join('')}</row>`
  })
  const freeze = s.freeze ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="${s.freeze}" topLeftCell="A${s.freeze + 1}" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : ''
  // 欄寬：依最寬的內容（中文字在 Excel 裡比兩個英數字再寬一點，乘 1.2），介於 8 到 60 之間，再留 3 格邊
  const cols = widths.length ? `<cols>${Array.from(widths, (w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(60, Math.max(8, Math.ceil((w ?? 0) * 1.2) + 3))}" customWidth="1"/>`).join('')}</cols>` : ''
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${rows.join('')}</sheetData></worksheet>`
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

/** 工作表 → .xlsx 檔的位元組 */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  if (!sheets.length) throw new Error('至少要一張工作表')
  const enc = new TextEncoder()
  const names = sheetNames(sheets)
  const n = sheets.length
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  const files: { name: string; data: string }[] = [
    {
      name: '[Content_Types].xml',
      data: `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    },
    {
      name: '_rels/.rels',
      data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((nm, i) => `<sheet name="${xmlText(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: 'xl/styles.xml', data: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ]
  return zipStore(files.map((f) => ({ name: f.name, data: enc.encode(f.data) })))
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
