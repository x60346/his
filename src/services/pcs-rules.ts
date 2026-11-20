// 處置碼 ICD-10-PCS（純函式，示範用的小主檔）：病歷管理師編碼時登錄這次住院的處置碼；DRG 分組看「手術室處置」對到哪一個術式。
// 非手術室處置（呼吸器、插管…）登錄了也不影響分組（Tw-DRG 也是分 OR／non-OR）。服務層（coding.ts、drg-work）、種子、畫面、測試共用
export interface PcsCode {
  code: string
  name: string
  /** 手術室處置（會讓 DRG 走外科） */
  or: boolean
  /** 對應到本院術式主檔（DRG 分組表看術式）；沒有＝不在分組表的手術（其他外科） */
  procId?: string
}

export const PCS_CODES: PcsCode[] = [
  { code: '0PSH04Z', name: '右橈骨開放性復位內固定', or: true, procId: 'P037' },
  { code: '0PSJ04Z', name: '左橈骨開放性復位內固定', or: true, procId: 'P037' },
  { code: '0DTJ4ZZ', name: '腹腔鏡闌尾切除', or: true, procId: 'P038' },
  { code: '0DTJ0ZZ', name: '開腹闌尾切除', or: true, procId: 'P038' },
  { code: '0YU50JZ', name: '右腹股溝疝氣修補（人工網膜）', or: true, procId: 'P039' },
  { code: '0YU60JZ', name: '左腹股溝疝氣修補（人工網膜）', or: true, procId: 'P039' },
  { code: '0JBL0ZZ', name: '右大腿皮下組織切除清創', or: true, procId: 'P040' },
  { code: '0JBN0ZZ', name: '右小腿皮下組織切除清創', or: true, procId: 'P040' },
  { code: '0FT44ZZ', name: '腹腔鏡膽囊切除', or: true },
  { code: '0SRC0J9', name: '右膝人工關節置換（骨水泥）', or: true },
  { code: '5A1955Z', name: '呼吸器使用 96 小時以上', or: false },
  { code: '5A1945Z', name: '呼吸器使用 24–96 小時', or: false },
  { code: '0BH17EZ', name: '經口氣管內管置入', or: false },
  { code: '02HV33Z', name: '中心靜脈導管置入（經皮）', or: false },
  { code: '30233N1', name: '輸注紅血球（經皮、周邊靜脈）', or: false },
]
/** 一次住院最多登錄幾個處置碼 */
export const PCS_MAX = 6
export const pcsOf = (code: string) => PCS_CODES.find((c) => c.code === code)

/** 本院術式建議的處置碼（編碼時依手術紀錄預帶；側別要看手術紀錄改） */
export const PCS_FOR_PROC: Record<string, string> = { P037: '0PSH04Z', P038: '0DTJ4ZZ', P039: '0YU50JZ', P040: '0JBL0ZZ' }

/** 搜尋（代碼開頭或名稱包含） */
export const searchPcsCodes = (kw: string) => {
  const k = kw.trim().toUpperCase()
  return k ? PCS_CODES.filter((c) => c.code.startsWith(k) || c.name.includes(kw.trim())) : PCS_CODES
}

/** 檢查編碼輸入的處置碼：主檔裡的、不重複、最多 6 個（回傳整理好的，或錯誤訊息） */
export function checkPcs(list: { code: string }[]): { ok: true; items: { code: string; name: string }[] } | { ok: false; message: string } {
  if (list.length > PCS_MAX) return { ok: false, message: `處置碼最多 ${PCS_MAX} 個` }
  const seen = new Set<string>()
  const items: { code: string; name: string }[] = []
  for (const x of list) {
    const c = pcsOf(x.code?.trim().toUpperCase() ?? '')
    if (!c) return { ok: false, message: `處置碼 ${x.code || '（空白）'} 不在主檔：請從搜尋選` }
    if (seen.has(c.code)) return { ok: false, message: `處置碼 ${c.code} 重複` }
    seen.add(c.code)
    items.push({ code: c.code, name: c.name })
  }
  return { ok: true, items }
}

/** DRG 分組用的手術：手術室處置才算；對得到術式的用術式 id，對不到的當「不在分組表的手術」 */
export const drgProcsFromPcs = (list: { code: string; name: string }[]) =>
  list.filter((x) => pcsOf(x.code)?.or).map((x) => ({ id: pcsOf(x.code)?.procId ?? `PCS:${x.code}`, name: `${x.code} ${x.name}` }))
