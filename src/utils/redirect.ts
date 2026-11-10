// 登入後要回到哪一頁。
//
// redirect 來自網址的 query，網址是任何人都能改的輸入，所以要先檢查再用：
// - 只接受站內路徑：以 / 開頭，但不能是 //（//evil.com 會被當成「同協定的外部網址」）；
//   反斜線也不行，瀏覽器會把 /\evil.com 當成 //evil.com。
//   我們用 hash 路由，其實跳不出去，但規則集中在這裡，以後換成 history 模式也不會變成 open redirect。
// - 不能指回登入頁本身，否則登入完又回到登入頁。
// - 有沒有權限不在這裡判斷：照常導過去，由路由守衛帶到「沒有權限」頁，每條規則只寫一處。
//
// 路由守衛（已登入卻開登入頁）與登入頁（登入成功）共用這個函式，兩邊的行為才不會分歧。
export function safeRedirect(raw: unknown): string {
  if (typeof raw !== 'string') return '/' // 沒帶，或 ?redirect=a&redirect=b 變成陣列
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/'
  const path = raw.split(/[?#]/)[0]
  if (path === '/login' || path.startsWith('/login/')) return '/'
  return raw
}
