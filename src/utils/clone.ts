// 頁面層用的深複製。
//
// 頁面裡的資料常常是 Vue 的響應式 Proxy（ref、reactive），structuredClone 無法複製 Proxy，
// 會丟出 DataCloneError——病患資料頁按「修改」就是因此打不開對話框。
// 頁面上的資料都是純資料（字串、數字、陣列、物件），用 JSON 來回一次就能安全複製，
// 和服務層 overNetwork 模擬「經過網路」是同一個道理。
export function clonePlain<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}
