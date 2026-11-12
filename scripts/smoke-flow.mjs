// 服務層流程冒煙測試：在 Node 中透過 Vite 載入 TypeScript 服務，跑完整就醫流程與住院流程。
// 執行：npm run smoke
import { createServer } from 'vite'

// ---------- 固定的模擬時鐘 ----------
// 種子資料依「現在幾點」決定今天走到哪一步（清晨重建時還沒有人看過診）。測試若用真實時間，
// 清晨跑（GitHub Actions 是 UTC，台灣早上推送就是 UTC 凌晨）今天就沒有待批價、待領藥的病人，大半流程測試會失敗、擋住部署。
// 所以測試一律從「今天 14:30」開始，時間照真實流逝往前走（交易、稽核的先後仍然正確）。setClock 可改到別的時刻測種子
const RealDate = Date
let clockBase = 0
let realBase = 0
function setClock(hh, mm) {
  const d = new RealDate()
  d.setHours(hh, mm, 0, 0)
  clockBase = d.getTime()
  realBase = RealDate.now()
}
setClock(14, 30)
const fakeNow = () => clockBase + (RealDate.now() - realBase)
globalThis.Date = class extends RealDate {
  constructor(...a) {
    if (a.length) super(...a)
    else super(fakeNow())
  }
  static now() {
    return fakeNow()
  }
}

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
const load = (p) => server.ssrLoadModule(p)

let failed = 0
const ok = (cond, msg) => {
  console.log(`${cond ? '  ✔' : '  ✘'} ${msg}`)
  if (!cond) failed++
}
const expectError = async (fn, msg) => {
  try {
    await fn()
    ok(false, `${msg}（應該要被擋下，卻成功了）`)
  } catch (e) {
    ok(e.name === 'ServiceError', `${msg} → 「${e.message}」`)
  }
}

try {
  const http = await load('/src/services/http.ts')
  const dbm = await load('/src/mock/db.ts')
  const api = await load('/src/services/index.ts')
  const { today, now: nowStr } = await load('/src/utils/date.ts')
  http.setLatency(0, 0)
  const T = today()
  const as = (username) => api.authApi.login(username, '1234')
  // 盤點單整套走一次（建立 → 依 counts 清點 → 送出 → 管理員覆核過帳）：測試要調整庫存一律照盤點單的路走，帳本不變式仍成立。
  // counts(line, lot) 回傳實點數量；結束時登入身分是 ph01
  const takeStock = async (drugIds, counts, reasonText = '測試', locationId) => {
    await as('ph01')
    // 範圍內沒有庫存批號（例：本來就缺貨的藥）就沒什麼好盤的——盤點單會擋「沒有批號」，這裡直接略過
    const loc = locationId ?? dbm.db.stockLocations.find((x) => x.dispensesOpd).id
    if (!dbm.db.drugLots.some((x) => drugIds.includes(x.drugId) && x.locationId === loc && x.qty > 0)) return null
    const sheet = await api.stocktakeApi.createStocktake({ scope: { kind: 'drugs', drugIds }, ...(locationId ? { locationId } : {}) })
    for (const l of sheet.lines) await api.stocktakeApi.countLine(sheet.id, l.id, counts(l, dbm.db.drugLots.find((x) => x.id === l.lotId)))
    await api.stocktakeApi.submitStocktake(sheet.id)
    await as('admin')
    const v = await api.stocktakeApi.getStocktake(sheet.id)
    const r = await api.stocktakeApi.postStocktake(sheet.id, Object.fromEntries(v.lines.filter((l) => l.diff).map((l) => [l.id, reasonText])))
    await as('ph01')
    return r
  }

  console.log('\n[門診] 掛號 → 看診 → 批價 → 發藥')
  await as('clerk01')
  const sessions = await api.scheduleApi.listSessions({ date: T })
  ok(sessions.length > 0, `今天有 ${sessions.length} 個診次`)
  const closed = sessions.find((s) => s.closed)
  if (closed) {
    const someone = dbm.db.patients[30]
    await expectError(() => api.bookingApi.register({ patientId: someone.id, sessionId: closed.id, identityCode: '01', caseType: '01' }), '掛已截止的診次')
  }
  // 依執行時間，今天可能已經沒有開放的診次（例如深夜），就改掛明天
  const open = (list) => list.find((s) => !s.full && !s.closed)
  const session = open(sessions) ?? open(await api.scheduleApi.listSessions({ date: (await load('/src/utils/date.ts')).addDays(T, 1) }))
  const patient = dbm.db.patients.find((p) => p.allergies.length === 0 && !dbm.db.visits.some((v) => v.sessionId === session.id && v.patientId === p.id))
  // 現場掛號：病人在櫃台，掛號同時報到（掛到明天的就不能報到，叫號前另外處理）
  const visit = await api.bookingApi.register({ patientId: patient.id, sessionId: session.id, identityCode: '01', caseType: '01', checkIn: session.date === T })
  ok(visit.status === 'registered', `${patient.name} 掛 ${session.deptName} ${session.doctorName}，看診號 ${visit.seqNo}`)
  await expectError(() => api.bookingApi.register({ patientId: patient.id, sessionId: session.id, identityCode: '01', caseType: '01' }), '重複掛同一診')

  const docUser = dbm.db.users.find((u) => u.doctorId === session.doctorId)
  await expectError(() => api.opdApi.startConsult(visit.id), '掛號人員嘗試看診（權限）')
  await as(docUser.username)
  const enc = await api.opdApi.startConsult(visit.id)
  ok(dbm.db.visits.find((v) => v.id === visit.id).status === 'in-consult', '叫號後狀態為看診中')
  // B3：過號要留下標記，「下一位」先跳過他；再叫號時清除
  {
    const q = await load('/src/services/queue-rules.ts')
    const Q = (arr) => arr.map(([seqNo, status, skipped]) => ({ id: `v${seqNo}`, seqNo, status, skippedAt: skipped ? 'x' : undefined }))
    ok(q.nextInQueue(Q([[3, 'registered', true], [4, 'registered'], [5, 'registered']]), 'v4')?.seqNo === 5, '過號的 3 號不會被排成下一位（看完 4 號，下一位是 5 號）')
    ok(q.nextInQueue(Q([[3, 'registered', true], [6, 'registered', true], [4, 'dispensed']]))?.seqNo === 3, '只剩過號的人時，從過號者裡挑最小號（這一診才看得完）')
    ok(q.nextInQueue(Q([[3, 'in-consult'], [4, 'cancelled']]), 'v3') === undefined, '沒有候診者就沒有下一位')
    // 上午診 4（過號）、5，下午診 1：號碼只在同一診內比較，依清單順序（上午在前），下一位是上午 5 號，不是下午 1 號
    const twoSessions = [...Q([[4, 'registered', true], [5, 'registered']]), { id: 'pm1', seqNo: 1, status: 'registered' }]
    ok(q.nextInQueue(twoSessions)?.id === 'v5', '上午、下午兩診同一清單：依看診順序，上午 5 號在下午 1 號之前')
    await api.opdApi.skipPatient(visit.id)
    const skipped = dbm.db.visits.find((v) => v.id === visit.id)
    ok(skipped.status === 'registered' && skipped.skippedAt && dbm.db.auditLogs[0].action === '過號', '過號：退回候診、記下過號時間、寫入稽核')
    ok((await api.scheduleApi.listSessions({ date: session.date })).find((s) => s.id === session.id).skipped >= 1, '診次卡顯示「過號」人數')
    await api.opdApi.startConsult(visit.id)
    ok(dbm.db.visits.find((v) => v.id === visit.id).skippedAt === undefined, '過號的人回來重新叫號，過號標記清除')
    // U5：診次卡「目前看到幾號」與候診人數
    const C = (arr) => arr.map(([seqNo, status, calledAt]) => ({ seqNo, status, calledAt }))
    const cn = (arr) => JSON.stringify(q.currentNumber(C(arr)) ?? null)
    ok(cn([[1, 'dispensed', '09:00'], [2, 'in-consult', '09:10'], [3, 'registered']]) === '{"seqNo":2,"inConsult":true}', '目前看到幾號：看診中的那一號')
    ok(cn([[1, 'dispensed', '09:00'], [2, 'consulted', '09:10'], [3, 'registered']]) === '{"seqNo":2,"inConsult":false}', '沒人在看診時：最後看完的號（已看到）')
    ok(cn([[3, 'registered', '09:20'], [1, 'consulted', '09:00']]) === '{"seqNo":1,"inConsult":false}' && cn([[1, 'registered'], [2, 'registered']]) === 'null', '過號回到候診的不算「已看到」；還沒叫過號就沒有')
    ok(cn([[5, 'consulted', '09:30'], [2, 'consulted', '09:50']]) === '{"seqNo":5,"inConsult":false}', '「已看到」是進度（最大號）：過號的 2 號在 5 號之後才看，仍是已看到 5 號')
    const sv = (await api.scheduleApi.listSessions({ date: session.date })).find((s) => s.id === session.id)
    const inS = dbm.db.visits.filter((v) => v.sessionId === session.id && v.status !== 'cancelled')
    ok(sv.current?.seqNo === visit.seqNo && sv.current.inConsult && sv.waiting === inS.filter((v) => v.status === 'registered').length,
      `診次卡：看診中 ${sv.current?.seqNo} 號；候診 ${sv.waiting} 位不含看診中那位（與首頁、門診頁同一個定義）`)
  }

  const draft = {
    subjective: '喉嚨痛 2 天', objective: '咽部紅', assessment: '上呼吸道感染', plan: '症狀治療', vitals: { temp: 37.2 },
    diagnoses: [], medications: [{ drugId: 'M001', dose: 1, freq: 'TID', route: 'PO', days: 3, qty: 9, selfPay: false }],
    procedures: [], refillTimes: 0, admissionRequested: false,
  }
  await expectError(() => api.opdApi.completeEncounter(enc.id, draft), '沒有診斷就完成看診')
  ok(dbm.db.encounters.find((e) => e.id === enc.id).subjective === '', '上一步失敗後交易回滾，病歷沒有被改到一半')

  draft.diagnoses = [{ icd: 'J06.9', name: '急性上呼吸道感染', primary: false }]
  // 劑量合理性：Acetaminophen 常用 1 顆
  const dr = await load('/src/services/dose-rules.ts')
  const acet = dbm.db.drugs.find((d) => d.id === 'M001')
  ok(dr.doseLevel(acet, 3) === 'ok' && dr.doseLevel(acet, 4) === 'high' && dr.doseLevel(acet, 21) === 'absurd', '劑量規則：3 倍內正常、超過 3 倍偏高、超過 20 倍不合理')
  ok(dr.doseLevel({ defaultDose: 10, highAlert: true }, 21) === 'high', '高警訊藥品超過 2 倍即偏高')
  await expectError(() => api.opdApi.completeEncounter(enc.id, { ...draft, medications: [{ ...draft.medications[0], dose: 100 }] }), '門診劑量 100 顆（不合理）')
  await expectError(() => api.opdApi.completeEncounter(enc.id, { ...draft, medications: [{ ...draft.medications[0], dose: 4 }] }), '門診劑量 4 顆（偏高、未確認）')
  await expectError(() => api.opdApi.completeEncounter(enc.id, { ...draft, medications: [{ ...draft.medications[0], days: 999, qty: 0 }] }), '處方天數 999 天')
  ok(dr.checkDays(30) === null && dr.checkDays(31) !== null && dr.checkDays(0) !== null && dr.checkDays(2.5) !== null, '處方天數：1–30 天的整數')
  const done = await api.opdApi.completeEncounter(enc.id, draft)
  ok(done.encounter.diagnoses[0].primary, '未指定主診斷時自動以第一個為主診斷')
  ok(dbm.db.visits.find((v) => v.id === visit.id).status === 'consulted', '完成看診 → 待批價')

  await as('clerk01')
  const pv = await api.chargeApi.previewCharge(visit.id)
  console.log('    收費明細：' + pv.lines.map((l) => `${l.name} ${l.amount}${l.patientPay ? '元' : '點'}`).join('、'))
  ok(pv.patientTotal === 150 + 80, `應收 ${pv.patientTotal} 元（掛號 150 + 基本部分負擔 80），申報 ${pv.nhiPoints} 點`)
  await expectError(() => api.chargeApi.pay(visit.id, { payMethod: 'cash', received: 100 }), '現金不足')
  await expectError(() => api.chargeApi.pay(visit.id, { payMethod: 'cash', received: 999999999 }), '實收多打了 0（找零異常）')
  await expectError(() => api.chargeApi.pay(visit.id, { payMethod: 'cash', received: 500.5 }), '實收非整數')
  const charge = await api.chargeApi.pay(visit.id, { payMethod: 'cash', received: 500 })
  ok(charge.change === 500 - pv.patientTotal, `收據 ${charge.receiptNo}，找零 ${charge.change}`)
  const dp = dbm.db.dispenses.find((d) => d.visitId === visit.id)
  ok(!!dp && dp.status === 'pending', `結帳後自動產生調劑單，領藥號 ${dp?.pickupNo}`)
  await as(docUser.username)
  await expectError(() => api.opdApi.saveDraft(enc.id, draft), '已批價後醫師修改病歷')

  await as('ph01')
  const stockBefore = dbm.db.drugs.find((d) => d.id === 'M001').stock
  await expectError(() => api.pharmacyApi.dispense(dp.id), '未核對就發藥')
  await api.pharmacyApi.verifyDispense(dp.id)
  // U23：發藥前要確認身分——病人說出出生月日由服務層比對，或登記代領人
  {
    const birth = patient.birthDate.slice(5).replace('-', '')
    const wrong = birth === '0101' ? '0102' : '0101'
    try {
      await api.pharmacyApi.dispense(dp.id)
      ok(false, '沒有確認身分應被擋下')
    } catch (e) {
      ok(e.field === 'birthMMDD', `沒輸入生日就發藥 → 「${e.message}」`)
    }
    await expectError(() => api.pharmacyApi.dispense(dp.id, { birthMMDD: wrong }), '生日不符就發藥')
    try {
      await api.pharmacyApi.dispense(dp.id, { proxy: true })
      ok(false, '代領沒填資料應被擋下')
    } catch (e) {
      ok(Object.keys(e.fields ?? {}).sort().join() === 'proxyName,relation', '代領：姓名與關係一次標出')
    }
    ok(dbm.db.dispenses.find((d) => d.id === dp.id).status === 'verified' && dbm.db.drugs.find((d) => d.id === 'M001').stock === stockBefore, '身分沒確認前，調劑單仍是已核對、沒扣庫存')
    await api.pharmacyApi.dispense(dp.id, { birthMMDD: birth })
    ok(dbm.db.dispenses.find((d) => d.id === dp.id).pickupCheck?.method === 'birth' && dbm.db.auditLogs.find((l) => l.action === '發藥')?.detail.includes('核對生日'), '生日相符才發藥，記下確認方式並寫入稽核')
  }
  ok(dbm.db.drugs.find((d) => d.id === 'M001').stock === stockBefore - 9, `發藥扣庫存 ${stockBefore} → ${stockBefore - 9}`)
  const lastTxn = dbm.db.stockTxns.filter((t) => t.drugId === 'M001').at(-1)
  ok(lastTxn.type === 'dispense' && lastTxn.qty === -9 && lastTxn.ref === `領藥號 ${dp.pickupNo}` && lastTxn.balance === stockBefore - 9, `發藥寫入異動帳（${lastTxn.ref}，${lastTxn.qty}，結存 ${lastTxn.balance}）`)
  // B5：沒領的單跨日要帶著走；已發藥依「發藥日」算
  {
    const { addDays } = await load('/src/utils/date.ts')
    const Y = addDays(T, -1)
    const pend = dbm.db.dispenses.find((d) => d.status === 'pending' && d.createdAt.startsWith(T))
    const back = (d, day) => { const orig = d.createdAt; d.createdAt = day + orig.slice(10); return () => (d.createdAt = orig) }
    const undoPend = back(pend, Y)
    const undoDp = back(dbm.db.dispenses.find((d) => d.id === dp.id), Y)
    const todayList = await api.pharmacyApi.listDispenses({ date: T })
    const idx = todayList.findIndex((d) => d.id === pend.id)
    ok(idx >= 0 && todayList.slice(0, idx).every((d) => d.createdAt.startsWith(T) || d.status === 'dispensed') && todayList.slice(idx).filter((d) => d.status !== 'dispensed').every((d) => !d.createdAt.startsWith(T)),
      '昨天開立、還沒領的單出現在今天的清單，排在今天開立的後面')
    ok(todayList.some((d) => d.id === dp.id && d.status === 'dispensed') && !(await api.pharmacyApi.listDispenses({ date: Y })).some((d) => d.id === dp.id),
      '昨天開立、今天發藥的單算在今天的「已發藥」，不在昨天')
    ok(!(await api.pharmacyApi.listDispenses({ date: addDays(Y, -1) })).some((d) => d.id === pend.id), '開立日之前的日期不會出現這張單')
    undoPend()
    undoDp()
  }

  console.log('\n[藥品庫存] 帳本、FEFO、進貨、盤點')
  const sr = await load('/src/services/stock-rules.ts')
  const lotsT = [
    { id: 'a', drugId: 'X', lotNo: 'NEW', expiry: '2027-01-01', qty: 10, receivedAt: '' },
    { id: 'b', drugId: 'X', lotNo: 'OLD', expiry: '2026-12-01', qty: 5, receivedAt: '' },
    { id: 'c', drugId: 'X', lotNo: 'DEAD', expiry: '2026-01-01', qty: 50, receivedAt: '' },
  ]
  const fefo = sr.allocateFefo(lotsT, 8, '2026-06-01')
  ok(fefo.map((t) => `${t.lotNo}:${t.qty}`).join(',') === 'OLD:5,NEW:3', `FEFO 先扣最早到期、略過已過期：${fefo.map((t) => `${t.lotNo}:${t.qty}`).join(',')}`)
  ok(sr.allocateFefo(lotsT, 16, '2026-06-01') === null, '可用量（未過期）不足時不扣（過期品不能發）')
  ok(sr.daysOfSupply(100, 0, 30) === null && sr.daysOfSupply(100, 60, 30) === 50, '可用天數：無用量為「不知道」（null），不是無限大')

  // 不變式（每個庫存地點各自成立）：該地點批號總和 = 該地點帳本加總，且結存連續；drug.stock = 各地點總和
  const ledgerBroken = (db) =>
    db.drugs.filter((d) => {
      const lots = db.drugLots.filter((l) => l.drugId === d.id)
      if (lots.some((l) => l.qty < 0 || !db.stockLocations.some((x) => x.id === l.locationId))) return true
      const perLoc = db.stockLocations.every((loc) => {
        const lq = lots.filter((l) => l.locationId === loc.id).reduce((s, l) => s + l.qty, 0)
        const txns = db.stockTxns.filter((t) => t.drugId === d.id && t.locationId === loc.id)
        let run = 0
        return txns.every((t) => (run += t.qty) === t.balance) && run === lq
      })
      return !perLoc || d.stock !== lots.reduce((s, l) => s + l.qty, 0) || db.stockTxns.some((t) => t.drugId === d.id && !t.locationId)
    })
  const broken = ledgerBroken(dbm.db)
  ok(broken.length === 0, `${dbm.db.drugs.length} 種藥：每個地點的批號總和 = 帳本加總、結存連續；庫存 = 各地點總和（不符 ${broken.length} 種）`)

  const recvDrug = 'M010'
  const before10 = dbm.db.drugs.find((d) => d.id === recvDrug).stock
  await expectError(() => api.inventoryApi.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId: recvDrug, qty: 100, lotNo: '', expiry: '2030-01-01' }), '進貨未填批號')
  await expectError(() => api.inventoryApi.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId: recvDrug, qty: 100, lotNo: 'T1', expiry: '2020-01-01' }), '進貨效期已過')
  // G3：效期不再預填，留白送出要擋；今天到期也不能進貨
  await expectError(() => api.inventoryApi.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId: recvDrug, qty: 100, lotNo: 'T1', expiry: '' }), '進貨效期空白')
  await expectError(() => api.inventoryApi.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId: recvDrug, qty: 100, lotNo: 'T1', expiry: T }), '進貨效期是今天')
  await api.inventoryApi.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId: recvDrug, qty: 100, lotNo: 't1', expiry: '2030-01-01' })
  await expectError(() => api.inventoryApi.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId: recvDrug, qty: 5, lotNo: 'T1', expiry: '2031-01-01' }), '同批號不同效期')
  const lotT1 = dbm.db.drugLots.find((l) => l.drugId === recvDrug && l.lotNo === 'T1')
  ok(lotT1 && dbm.db.drugs.find((d) => d.id === recvDrug).stock === before10 + 100, '進貨：批號轉大寫、庫存 +100')
  // G6：實際數量的規則（頁面與服務層共用）
  ok([-3, 2.5, undefined, '', '3', NaN].every((v) => sr.checkStocktakeActual(v)) && [0, 97].every((v) => sr.checkStocktakeActual(v) === null), '盤點實際數量：負數、小數、空白、字串、NaN 不接受；0 與正整數接受')
  // 盤點一律走盤點單：T1 實點 97，其他批號照帳 → 過帳時系統算出 −3 並調整該批號
  const posted = await takeStock([recvDrug], (l, lot) => (l.lotNo === 'T1' ? 97 : lot.qty), '破損')
  const adjLine = posted.lines.find((l) => l.lotNo === 'T1')
  ok(adjLine.diff === -3 && dbm.db.drugLots.find((l) => l.id === lotT1.id).qty === 97 && posted.lines.filter((l) => l.diff).length === 1, '盤點單：T1 實點 97 → 差異 −3，只調整這一批（其他批號帳實相符不調整）')
  await as('ph01')
  await as('admin')
  const m10 = dbm.db.drugs.find((d) => d.id === recvDrug)
  await api.masterApi.saveDrug({ ...m10, name: m10.name, stock: 99999 })
  ok(dbm.db.drugs.find((d) => d.id === recvDrug).stock === before10 + 97, '維護藥品主檔不能順手改庫存（傳入的 stock 被忽略）')
  await as('ph01')
  // G1：狀態可同時多項；清單標籤、「只看需處理」、摘要卡片同一個來源
  {
    const f = sr.stockFlags
    ok(JSON.stringify(f({ status: 'low', expiredQty: 0, expiringSoon: true })) === '["low","expiring"]', '偏低又近效期 → 兩個標籤都顯示')
    ok(JSON.stringify(f({ status: 'ok', expiredQty: 0, expiringSoon: true })) === '["expiring"]', '庫存足夠但近效期 → 「近效期」（不再顯示「正常」）')
    ok(JSON.stringify(f({ status: 'out', expiredQty: 79, expiringSoon: false })) === '["out","expired"]', '缺貨又有過期批號 → 缺貨＋待報廢')
    ok(f({ status: 'ok', expiredQty: 0, expiringSoon: false }).length === 0, '完全沒問題 → 沒有標籤（顯示「正常」）')
    const all = await api.inventoryApi.listInventory()
    const attention = await api.inventoryApi.listInventory({ attentionOnly: true })
    const sum = await api.inventoryApi.inventorySummary()
    ok(attention.every((r) => r.flags.length > 0) && attention.length === all.filter((r) => r.flags.length).length, `「只看需處理」${attention.length} 項，每一項都有標籤，沒有標著「正常」的`)
    const count = (k) => all.filter((r) => r.flags.includes(k)).length
    ok(sum.out === count('out') && sum.low === count('low') && sum.expiring === count('expiring') && sum.expired === count('expired'), `摘要卡片數字 = 有對應標籤的藥品數（缺貨 ${sum.out}、偏低 ${sum.low}、近效期 ${sum.expiring}、待報廢 ${sum.expired}）`)
    ok(all.some((r) => r.flags.includes('expiring') && r.status === 'ok'), '種子資料中有「庫存足夠但近效期」的藥（G1 的情境）')
    // G7：點摘要卡片篩選，筆數要等於卡片上的數字
    const byFlags = async (flags) => (await api.inventoryApi.listInventory({ flags })).length
    const expiryCount = all.filter((r) => r.flags.includes('expiring') || r.flags.includes('expired')).length
    ok((await byFlags(['out'])) === sum.out && (await byFlags(['low'])) === sum.low && (await byFlags(['expiring', 'expired'])) === expiryCount && (await byFlags([])) === all.length,
      `點卡片篩選：缺貨 ${sum.out}、偏低 ${sum.low}、效期提醒 ${expiryCount} 項，與卡片數字一致；空條件 = 全部`)
  }
  const expiredDrug = dbm.db.drugLots.find((l) => l.qty > 0 && l.expiry < new Date().toISOString().slice(0, 10))
  if (expiredDrug) {
    await api.inventoryApi.scrapExpired(expiredDrug.drugId)
    ok(!dbm.db.drugLots.some((l) => l.drugId === expiredDrug.drugId && l.qty > 0 && l.expiry < new Date().toISOString().slice(0, 10)), '報廢過期批號')
  } else ok(false, '種子資料應有一個已過期批號（M005）')
  ok(dbm.db.visits.find((v) => v.id === visit.id).status === 'dispensed', '發藥 → 掛號狀態已領藥')
  await as('clerk01')
  await expectError(() => api.chargeApi.voidCharge(charge.id, '測試'), '已發藥後作廢收據')

  // B6：上次案件分類（掛號頁提示慢性病回診用）：今天以前、看過診的最近一次，不含退掛與還沒看的掛號
  {
    const seen = (p) => dbm.db.visits.filter((v) => v.patientId === p.id && v.date <= T && !['cancelled', 'registered'].includes(v.status)).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    const chronic = dbm.db.patients.find((p) => seen(p)[0]?.caseType === '04')
    const r = await api.bookingApi.lastCaseType(chronic.id)
    ok(r?.caseType === '04' && r.date === seen(chronic)[0].date, `上次案件分類：${chronic.name} 上次（${r?.date}）為 04 慢性病`)
    const nobody = dbm.db.patients.find((p) => !seen(p).length)
    ok(!nobody || (await api.bookingApi.lastCaseType(nobody.id)) === null, '沒有看過診的病人：沒有上次案件分類')
  }

  // U3：改期＝退舊掛新，同一筆交易；新診次掛不上就全部不動
  {
    const { addDays } = await load('/src/utils/date.ts')
    const later = (await api.scheduleApi.listSessions({ date: addDays(T, 2) })).filter((s) => s.bookable)
    const [s1, s2] = later
    const who = dbm.db.patients.find((p) => !dbm.db.visits.some((v) => v.patientId === p.id && v.date >= T && v.status === 'registered') && !dbm.db.visits.some((v) => [s1.id, s2.id].includes(v.sessionId) && v.patientId === p.id))
    const orig = await api.bookingApi.register({ patientId: who.id, sessionId: s1.id, identityCode: '02', caseType: '04' })
    // 新診次額滿：整筆回滾，原掛號不受影響
    const s2Obj = dbm.db.sessions.find((s) => s.id === s2.id)
    const limit = s2Obj.limit
    s2Obj.limit = dbm.db.visits.filter((v) => v.sessionId === s2.id && v.status !== 'cancelled').length
    await expectError(() => api.bookingApi.rescheduleVisit(orig.id, { sessionId: s2.id, identityCode: '02', caseType: '04' }), '改期到額滿的診次')
    // 交易失敗時整個資料庫換回快照：先前拿到的物件已不是現在的資料，要重新找一次再還原
    dbm.db.sessions.find((s) => s.id === s2.id).limit = limit
    ok(dbm.db.visits.find((v) => v.id === orig.id).status === 'registered', '改期失敗時原掛號仍在（整筆回滾）')
    await expectError(() => api.bookingApi.rescheduleVisit(orig.id, { sessionId: s1.id, identityCode: '02', caseType: '04' }), '改期到同一個診次')
    const moved = await api.bookingApi.rescheduleVisit(orig.id, { sessionId: s2.id, identityCode: '02', caseType: '04' })
    const old = dbm.db.visits.find((v) => v.id === orig.id)
    ok(old.status === 'cancelled' && old.cancelReason?.startsWith('改期至') && moved.sessionId === s2.id && moved.identityCode === '02' && moved.caseType === '04' && dbm.db.auditLogs[0].action === '改期',
      `改期：原掛號退掛（${old.cancelReason}），新掛號沿用身分與案件分類，寫入稽核`)
    await expectError(() => api.bookingApi.rescheduleVisit(orig.id, { sessionId: s1.id, identityCode: '02', caseType: '04' }), '已退掛的掛號再改期')
    await api.bookingApi.cancelVisit(moved.id)
  }

  // U2：掛號時的預估應收 = 批價時「掛號當下就確定」的那幾項（兩邊共用 fixedCharges）
  {
    const billing = await load('/src/services/billing.ts')
    const views = await load('/src/services/views.ts')
    const fixedKinds = ['reg', 'consult', 'copay-basic']
    let mismatch = []
    for (const idt of dbm.db.identities) {
      for (const ct of ['01', '04', 'A3']) {
        for (const withPrevent of [false, true]) {
          const est = await api.bookingApi.estimateFee(idt.code, ct, withPrevent)
          const effective = api.bookingApi.effectiveCaseType(ct, withPrevent)
          const bill = billing.calcChargeLines({ caseType: effective }, { medications: [], procedures: [] }, views.billingLookup(idt.code))
          const billFixed = bill.filter((l) => l.patientPay && fixedKinds.includes(l.kind)).reduce((s, l) => s + l.amount, 0)
          if (est.total !== billFixed) mismatch.push(`${idt.name}/${ct}${withPrevent ? '+預防' : ''}：預估 ${est.total}、批價 ${billFixed}`)
        }
      }
    }
    ok(mismatch.length === 0, `預估應收與批價一致（${dbm.db.identities.length} 種身分 × 3 種案件 × 有無預防保健；08 慢箋不掛號）${mismatch.length ? '：' + mismatch.join('；') : ''}`)
    const basic = dbm.db.billingSettings.basicCopay
    const e01 = await api.bookingApi.estimateFee('01', '01')
    const eA3 = await api.bookingApi.estimateFee('01', '01', true)
    const eVet = await api.bookingApi.estimateFee('02', '01')
    const eSelf = await api.bookingApi.estimateFee('09', '01')
    const consultSelf = dbm.db.procedures.find((p) => p.id === billing.CONSULT_PROC_ID).selfPrice
    ok(e01.total === 150 + basic && eA3.total === 150 && eA3.copayNote === '預防保健免部分負擔' && eVet.total === 50 && eVet.copayNote === '榮民免部分負擔' && eSelf.total === 200 + consultSelf,
      `預估金額：健保一般 ${e01.total}、只做預防保健 ${eA3.total}、榮民 ${eVet.total}（免部分負擔）、自費 ${eSelf.total}（含診察費）`)
  }

  // U8：批價清單上待批價者的應收，與點進去的試算同一個數字；已批價者不估
  {
    const q = await api.chargeApi.listChargeQueue(T)
    const pend = q.filter((v) => v.status === 'consulted')
    const diffs = []
    for (const v of pend) {
      const pv = await api.chargeApi.previewCharge(v.id)
      if (pv.patientTotal !== v.estimate) diffs.push(`${v.patientName} 清單 ${v.estimate}／試算 ${pv.patientTotal}`)
    }
    ok(pend.length > 0 && diffs.length === 0 && q.filter((v) => v.status !== 'consulted').every((v) => v.estimate === undefined),
      `批價清單的預估應收 = 試算金額（${pend.length} 位待批價）${diffs.length ? '：' + diffs.join('；') : ''}`)
  }

  // U15：看診中新增過敏（只能新增、限清單、寫稽核）；新增後過敏比對立刻生效
  {
    const who = dbm.db.patients.find((p) => !p.allergies.includes('Penicillin'))
    await as('ph01')
    await expectError(() => api.patientApi.addAllergy(who.id, 'Penicillin'), '藥師新增過敏')
    await as('dr01')
    await expectError(() => api.patientApi.addAllergy(who.id, '花粉'), '新增清單以外的過敏原')
    const before = (await api.opdApi.allergyWarnings(who.id, ['M003'])).length
    await api.patientApi.addAllergy(who.id, 'Penicillin')
    const after = await api.opdApi.allergyWarnings(who.id, ['M003'])
    ok(before === 0 && after.some((w) => w.allergen === 'Penicillin') && dbm.db.auditLogs[0].action === '新增過敏', '看診中新增 Penicillin 過敏 → Amoxicillin 立刻標示過敏警示，寫入稽核')
    await expectError(() => api.patientApi.addAllergy(who.id, 'Penicillin'), '重複新增同一過敏')
    dbm.db.patients.find((p) => p.id === who.id).allergies = dbm.db.patients.find((p) => p.id === who.id).allergies.filter((a) => a !== 'Penicillin')
    await as('clerk01')
  }

  // U13：醫師個人組套
  {
    const billing = await load('/src/services/billing.ts')
    const times = (f) => dbm.db.frequencies.find((x) => x.code === f)?.timesPerDay ?? 1
    const bad = dbm.db.orderSets.flatMap((s) => [
      ...s.medications.filter((m) => { const d = dbm.db.drugs.find((x) => x.id === m.drugId); return !d?.active || m.qty !== (billing.autoQty(d, m.dose, times(m.freq), m.days) ?? m.qty) }).map((m) => `${s.name}/${m.drugId}`),
      ...s.procedures.filter((p) => !dbm.db.procedures.find((x) => x.id === p.procId)?.active).map((p) => `${s.name}/${p.procId}`),
      ...s.diagnoses.filter((d) => !dbm.db.icdCodes.some((c) => c.code === d.icd)).map((d) => `${s.name}/${d.icd}`),
    ])
    ok(dbm.db.orderSets.length >= 5 && bad.length === 0, `展示組套 ${dbm.db.orderSets.length} 組：項目都可開立、總量與手動開藥算法一致${bad.length ? '：' + bad.join('、') : ''}`)
    const O = api.orderSetApi
    await as('nurse01')
    await expectError(() => O.listOrderSets(), '護理師查看組套')
    await as('dr01')
    const mineList = await O.listOrderSets()
    const dr01 = dbm.db.users.find((u) => u.username === 'dr01').doctorId
    ok(mineList.length > 0 && mineList.every((s) => s.doctorId === dr01), `只看得到自己的組套（${mineList.map((s) => s.name).join('、')}）`)
    try {
      await O.saveOrderSet({ name: '', diagnoses: [], medications: [], procedures: [] })
      ok(false, '空白組套應被擋下')
    } catch (e) {
      ok(e.field === 'name', `存空白組套 → 「${e.message}」`)
    }
    const input = { name: '測試組套', diagnoses: [{ icd: 'J00', name: '急性鼻咽炎（感冒）', primary: true }], medications: [{ drugId: 'M001', dose: 1, freq: 'TID', route: 'PO', days: 3, qty: 9, selfPay: false }], procedures: [] }
    const created = await O.saveOrderSet(input)
    await expectError(() => O.saveOrderSet(input), '存同名組套（未確認覆蓋）')
    const over = await O.saveOrderSet({ ...input, medications: [...input.medications, { drugId: 'M007', dose: 1, freq: 'HS', route: 'PO', days: 3, qty: 3, selfPay: false }], overwrite: true })
    ok(over.id === created.id && over.medications.length === 2 && (await O.listOrderSets()).filter((s) => s.name === '測試組套').length === 1, '確認覆蓋後更新原組套，不會多出一組')
    // 套用時才檢查停用：存的時候能開，後來停用了，展開時要濾掉並列出
    const m7 = dbm.db.drugs.find((d) => d.id === 'M007')
    m7.active = false
    const ex = await O.expandOrderSet(created.id)
    ok(ex.medications.length === 1 && ex.medications[0].drugId === 'M001' && ex.skipped.includes(m7.name), `套用時濾掉已停用的藥並列出（${ex.skipped.join('、')} 未帶入）`)
    await expectError(() => O.saveOrderSet({ ...input, name: '含停用藥', medications: [{ drugId: 'M007', dose: 1, freq: 'HS', route: 'PO', days: 3, qty: 3, selfPay: false }] }), '把已停用的藥存進組套')
    dbm.db.drugs.find((d) => d.id === 'M007').active = true
    await as('dr02')
    await expectError(() => O.expandOrderSet(created.id), '套用別人的組套')
    await expectError(() => O.deleteOrderSet(created.id), '刪除別人的組套')
    await as('dr01')
    await O.deleteOrderSet(created.id)
    ok(!(await O.listOrderSets()).some((s) => s.id === created.id) && dbm.db.auditLogs[0].action === '刪除組套', '刪除自己的組套，寫入稽核')
    await as('clerk01')
  }

  // U9：日結報表——未收款名單、作廢金額、依收費人員、依費用類別（加總都要對得上）
  {
    const toVoid = dbm.db.charges.find((c) => !c.voided && c.paidAt.startsWith(T) && dbm.db.dispenses.find((d) => d.visitId === c.visitId)?.status !== 'dispensed')
    await api.chargeApi.voidCharge(toVoid.id, '測試日結')
    const rep = await api.chargeApi.dailyReport(T)
    const consultedToday = dbm.db.visits.filter((v) => v.date === T && v.status === 'consulted')
    let estSum = 0
    for (const v of consultedToday) estSum += (await api.chargeApi.previewCharge(v.id)).patientTotal
    ok(rep.unpaid.length === consultedToday.length && rep.unpaid.reduce((s, u) => s + u.estimate, 0) === estSum && rep.unpaid.some((u) => u.visitId === toVoid.visitId),
      `日結「未收款」= 當天看完診還沒批價的 ${rep.unpaid.length} 位（含剛作廢回到待批價的），預估合計 ${estSum}`)
    const voidedSum = dbm.db.charges.filter((c) => c.voided && c.paidAt.startsWith(T)).reduce((s, c) => s + c.patientTotal, 0)
    ok(rep.voidedTotal === voidedSum && voidedSum >= toVoid.patientTotal, `作廢金額合計 ${rep.voidedTotal}（${rep.voidedCount} 張）`)
    const cashierSum = rep.byCashier.reduce((s, c) => s + c.collected, 0)
    const f = rep.byFeeType
    ok(cashierSum === rep.collected && rep.byCashier.reduce((s, c) => s + c.count, 0) === rep.count, `依收費人員加總 = 實收合計 ${rep.collected}`)
    ok(f.reg + f.basicCopay + f.drugCopay + f.selfPay === rep.patientTotal && f.reg > 0, `依費用類別加總 = 收入合計（掛號費 ${f.reg}、基本部分負擔 ${f.basicCopay}、藥品部分負擔 ${f.drugCopay}、自費 ${f.selfPay}）`)
    // 補收回來：未收款少一位、收入增加
    const pv = await api.chargeApi.previewCharge(toVoid.visitId)
    await api.chargeApi.pay(toVoid.visitId, { payMethod: 'cash', received: pv.patientTotal })
    const rep2 = await api.chargeApi.dailyReport(T)
    ok(rep2.unpaid.length === rep.unpaid.length - 1 && rep2.patientTotal === rep.patientTotal + pv.patientTotal, '補收後：未收款少一位，收入合計跟著增加')
  }

  // 慢箋領藥：不看診，櫃台登記 → 批價 → 藥局；時間窗、次數、不能跳次
  {
    const R = await load('/src/services/refill-rules.ts')
    const { addDays } = await load('/src/utils/date.ts')
    const w = R.refillWindow('2026-01-01', 28)
    ok(w.from === '2026-01-19' && w.to === '2026-01-28', `規則：01/01 領 28 天 → 01/19–01/28 可領下一次（藥吃完前 10 天）`)
    const f1 = [{ seq: 1, date: '2026-01-01', status: 'dispensed', dispensedDate: '2026-01-01' }]
    const at = (d) => R.refillState(3, 28, f1, d)
    ok(!at('2026-01-18').canRegister && at('2026-01-18').reason === '01/19 起可領' && at('2026-01-19').canRegister && at('2026-01-28').canRegister && at('2026-01-29').expired && !at('2026-01-29').canRegister,
      '規則：前一天不行、第一天與最後一天可以、隔天過期（要回診）')
    ok(R.refillState(2, 28, [{ seq: 1, date: '2026-01-01', status: 'charged' }], '2026-01-20').reason === '上次的藥還沒領', '規則：第一次的藥還沒領，不能登記第 2 次')
    ok(R.refillState(3, 28, [...f1, { seq: 2, date: '2026-01-20', status: 'consulted' }], '2026-01-20').reason === '第 2 次已登記，尚未領藥', '規則：已登記還沒領，不能再登記（不跳次）')
    const done = R.refillState(2, 28, [...f1, { seq: 2, date: '2026-01-20', status: 'dispensed', dispensedDate: '2026-01-20' }], '2026-02-10')
    ok(done.nextSeq === null && done.reason === '已領完', '規則：可調劑 2 次＝第一次＋再領 1 次，領完就沒有了')
    ok(R.refillState(2, 28, [...f1, { seq: 2, date: '2026-01-20', status: 'cancelled' }], '2026-01-20').canRegister, '規則：退掛的那次不算')
    const rx = (id, date, deptId = 'D02') => ({ id, patientId: 'P1', deptId, date, refillTimes: 2 })
    const all = [rx('a', '2026-01-01'), rx('b', '2026-01-15'), rx('c', '2026-01-20', 'D06')]
    ok(R.supersededBy(all[0], all) === '2026-01-15' && !R.supersededBy(all[1], all) && !R.supersededBy(all[2], all), '規則：同科之後又開新慢箋，舊的被取代；別科的不受影響')

    await as('clerk01')
    const B = api.bookingApi
    // 種子裡今天可領的那位
    let ready, pt
    for (const x of dbm.db.patients) {
      const list = await B.listRefills(x.id)
      ready = list.find((f) => f.canRegister)
      if (ready) { pt = x; break }
    }
    ok(!!ready && ready.nextSeq === 2, `種子有一位今天可領慢箋（${pt?.name}，第 ${ready?.nextSeq}/${ready?.total} 次，${ready?.reason}）`)
    const waiting = []
    for (const x of dbm.db.patients) for (const f of await B.listRefills(x.id)) if (!f.canRegister && f.window && f.window.from > T) waiting.push(f)
    ok(waiting.length >= 1, `種子也有還沒到時間的慢箋（${waiting[0]?.reason}）`)

    const orig = dbm.db.encounters.find((e) => e.id === ready.encounterId)
    const sess = dbm.db.sessions.find((x) => x.date === T && !x.suspended)
    await expectError(() => B.register({ patientId: pt.id, sessionId: sess.id, identityCode: '01', caseType: '08' }), '用 08 掛號看診')
    const v = await B.registerRefill(ready.encounterId)
    const enc = dbm.db.encounters.find((e) => e.visitId === v.id)
    ok(v.caseType === '08' && v.status === 'consulted' && v.sessionId === '' && v.refillSeq === 2 && v.refillOf === orig.id && dbm.db.auditLogs[0].action === '慢箋領藥登記',
      '登記領藥：08 案件、直接是已看診、不屬於任何診次、寫入稽核')
    ok(JSON.stringify(enc.medications) === JSON.stringify(orig.medications) && enc.status === 'completed' && enc.subjective.includes('第 2 次'), '藥照抄原處方（劑量、天數、總量都一樣）')
    const q = await api.opdApi.listQueue({ date: T, doctorId: v.doctorId })
    ok(!q.some((x) => x.id === v.id), '不會出現在醫師的候診清單')
    await expectError(() => B.registerRefill(ready.encounterId), '同一張慢箋重複登記')
    const pv = await api.chargeApi.previewCharge(v.id)
    const kinds = pv.lines.map((l) => l.kind)
    const selfPayId = dbm.db.identities.find((i) => i.code === v.identityCode)?.selfPay
    ok(!kinds.some((k) => ['reg', 'consult', 'copay-basic', 'copay-drug'].includes(k)) && (selfPayId || pv.patientTotal === 0),
      `批價：沒有掛號費、診察費、部分負擔（應收 ${pv.patientTotal} 元，申報 ${pv.nhiPoints} 點）`)
    // 登記錯了可以退：病歷一併刪，之後可重新登記
    await B.cancelVisit(v.id)
    ok(dbm.db.visits.find((x) => x.id === v.id).status === 'cancelled' && !dbm.db.encounters.some((e) => e.visitId === v.id) && (await B.listRefills(pt.id)).find((f) => f.encounterId === orig.id)?.canRegister,
      '批價前退掛：系統代填的病歷刪除，可以重新登記')
    const v2 = await B.registerRefill(ready.encounterId)
    await api.chargeApi.pay(v2.id, { payMethod: 'cash', received: pv.patientTotal })
    await expectError(() => B.cancelVisit(v2.id), '已批價的慢箋領藥退掛')
    const dp = dbm.db.dispenses.find((d) => d.visitId === v2.id)
    ok(!!dp && dp.status === 'pending', `批價後產生調劑單（領藥號 ${dp?.pickupNo}）`)
    await as('ph01')
    await api.pharmacyApi.verifyDispense(dp.id)
    const dv = await api.pharmacyApi.dispense(dp.id, { proxy: true, proxyName: '家屬', relation: '子女' })
    ok(dv.refillSeq === 2 && dbm.db.visits.find((x) => x.id === v2.id).status === 'dispensed', '藥局：標示慢箋第 2 次，發藥完成')
    await as('clerk01')
    const after = (await B.listRefills(pt.id)).find((f) => f.encounterId === orig.id)
    ok(after?.nextSeq === 3 && !after.canRegister && after.window.from === addDays(T, R.supplyDays(orig.medications) - R.REFILL_WINDOW_DAYS), `領完第 2 次：第 3 次 ${after?.reason}`)
    const hist = await api.opdApi.patientHistory(pt.id)
    ok(hist.some((h) => h.refillSeq === 2), '醫師的歷史病歷標出這是慢箋領藥（不是看診）')
    // 種子裡被取代的舊慢箋：不列出、直接呼叫也擋
    const oldOne = dbm.db.encounters.find((e) => e.status === 'completed' && e.refillTimes >= 2 && R.supersededBy(e, dbm.db.encounters.filter((x) => x.status === 'completed')))
    if (oldOne) {
      ok(!(await B.listRefills(oldOne.patientId)).some((f) => f.encounterId === oldOne.id), '被同科新慢箋取代的舊慢箋不列出')
      await expectError(() => B.registerRefill(oldOne.id), '登記已被取代的舊慢箋')
    }
    ok((await B.lastCaseType(pt.id))?.date !== T || (await B.lastCaseType(pt.id))?.caseType !== '08', '「上次案件分類」提示不把慢箋領藥算成上次看診')
  }

  // 閒置鎖定：鎖定中什麼都不能做；同一人密碼解鎖；連錯 5 次登出；管理員設定時間
  {
    const I = await load('/src/services/idle-rules.ts')
    const t0 = 1_000_000_000_000
    const at = (sec, min = 15) => I.idlePhase(t0, t0 + sec * 1000, min).phase
    ok(at(0) === 'active' && at(839) === 'active' && at(840) === 'warning' && at(899) === 'warning' && at(900) === 'lock', '規則：15 分鐘 → 前 14 分鐘照常、最後 60 秒倒數、滿 15 分鐘鎖定')
    ok(at(29, 1) === 'active' && at(30, 1) === 'warning' && at(60, 1) === 'lock' && I.idlePhase(t0, t0 + 45_000, 1).secondsLeft === 15, '規則：設 1 分鐘 → 倒數最多一半時間（30 秒），剩餘秒數正確')
    ok(at(3600 * 5) === 'lock', '規則：電腦睡眠醒來（隔了很久）一算就是鎖定，不靠計時器數')
    ok(I.checkIdleMinutes(0) && I.checkIdleMinutes(61) && I.checkIdleMinutes(1.5) && I.checkIdleMinutes(undefined) && !I.checkIdleMinutes(1) && !I.checkIdleMinutes(60), '規則：設定限 1–60 的整數')

    const A = api.authApi
    await as('nurse01')
    ok((await A.idleLockMinutes()) === I.IDLE_LOCK_DEFAULT_MIN, `預設閒置 ${I.IDLE_LOCK_DEFAULT_MIN} 分鐘鎖定`)
    await A.lockSession()
    ok(A.currentLock() && dbm.db.auditLogs[0].action === '閒置鎖定', '鎖定：寫入稽核，重新整理也還原得到（currentLock）')
    try {
      await api.patientApi.searchPatients('王')
      ok(false, '鎖定中查詢應被擋下')
    } catch (e) {
      ok(e.code === 'LOCKED', `鎖定中連查詢都不行 → 「${e.message}」（LOCKED，頁面不提示）`)
    }
    try {
      await api.nursingApi.addVitals({ admissionId: dbm.db.admissions.find((a) => a.status === 'admitted').id, temp: 36.8 })
      ok(false, '鎖定中寫入應被擋下')
    } catch (e) {
      ok(e.code === 'LOCKED', '鎖定中寫入也擋（直接呼叫 API 一樣）')
    }
    const auditBefore = dbm.db.auditLogs.length
    const r1 = await A.unlockSession('9999')
    ok(!r1.ok && r1.remaining === I.UNLOCK_MAX_FAILS - 1 && dbm.db.auditLogs.length === auditBefore + 1 && dbm.db.auditLogs[0].action === '解鎖失敗' && A.currentLock(),
      `密碼錯：仍鎖定、剩 ${r1.remaining} 次，「解鎖失敗」留在稽核（沒有被交易回滾）`)
    const r2 = await A.unlockSession('1234')
    ok(r2.ok && !A.currentLock() && dbm.db.auditLogs[0].action === '解鎖' && (await api.patientApi.searchPatients('王')).length >= 0, '同一人密碼正確 → 解鎖，可以繼續操作')
    // 連錯 5 次 → 登出
    await A.lockSession()
    let last
    for (let k = 0; k < I.UNLOCK_MAX_FAILS; k++) last = await A.unlockSession('0000')
    ok(last.loggedOut && !A.currentUser() && !A.currentLock() && dbm.db.auditLogs[0].detail.includes('強制登出'), `連續錯 ${I.UNLOCK_MAX_FAILS} 次：強制登出，寫入稽核`)
    // 鎖定後換人登入：鎖定狀態不會留給下一個人
    await as('nurse01')
    await A.lockSession()
    await as('clerk01')
    ok(!A.currentLock() && A.currentUser().username === 'clerk01', '切換使用者（登入別人）：不帶著上一個人的鎖定')
    await expectError(() => A.saveIdleLockMinutes(5), '非管理員修改閒置時間')
    await as('admin')
    try {
      await A.saveIdleLockMinutes(0)
      ok(false, '0 分鐘應被擋下')
    } catch (e) {
      ok(e.field === 'idleLockMin', '設定 0 分鐘 → 標在欄位上')
    }
    await A.saveIdleLockMinutes(1)
    ok((await A.idleLockMinutes()) === 1 && dbm.db.auditLogs[0].action === '修改安全設定', '管理員設為 1 分鐘，寫入稽核')
    await A.saveIdleLockMinutes(I.IDLE_LOCK_DEFAULT_MIN)
    await as('clerk01')
  }

  // 變更自己的密碼：規則、要輸入目前密碼、管理員設定的密碼要先改、其他分頁失效
  {
    const P = await load('/src/services/password-rules.ts')
    const pp = (pw, current) => P.passwordProblem(pw, { username: 'nurse01', current })
    ok(pp('') && pp('abc123') && pp('abcdefgh') && pp('12345678') && !pp('abcd1234') && !pp('Ward5a2026'), '規則：至少 8 碼、要有英文字母與數字')
    ok(pp('xNurse01x9') === '不可包含帳號名稱' && pp('abcd1234', 'abcd1234') === '不可與目前密碼相同', '規則：不可包含帳號（不分大小寫）、不可與目前相同')
    ok(dbm.db.users.every((u) => !u.mustChangePassword), '種子的展示帳號都不必先改密碼')

    const A = api.authApi
    const H = http
    await as('nurse01')
    try {
      await A.changeOwnPassword({ current: '0000', next: 'short' })
      ok(false, '目前密碼錯、新密碼太短應被擋下')
    } catch (e) {
      ok(Object.keys(e.fields ?? {}).sort().join() === 'current,next', '目前密碼錯、新密碼不合規則：兩個欄位一次標出')
    }
    await expectError(() => A.changeOwnPassword({ current: '1234', next: '1234' }), '新密碼與目前相同（也太短）')
    // 模擬「另一個分頁」：比較早登入的那個分頁，改完密碼後就失效
    const otherTabLoginAt = H.sessionLoginTime() - 1000
    await A.changeOwnPassword({ current: '1234', next: 'Ward5a2026' })
    // 每次重新找：交易失敗時資料庫整份換掉，先前拿到的物件就不是現在的那一筆了
    const meNow = () => dbm.db.users.find((u) => u.username === 'nurse01')
    const me = meNow()
    ok(me.password === 'Ward5a2026' && me.passwordChangedAt && dbm.db.auditLogs[0].action === '變更密碼' && !dbm.db.auditLogs[0].detail.includes('Ward5a2026'), '變更成功：寫入稽核（不記密碼內容）')
    ok(A.currentUser()?.username === 'nurse01' && (await api.patientApi.searchPatients('王')), '改密碼的這個分頁繼續登入、可以操作')
    H.setSessionUser(me.id, otherTabLoginAt)
    ok(A.currentUser() === null, '比變更時間早登入的分頁：失效（下次操作就會回登入頁）')
    try {
      await api.patientApi.searchPatients('王')
      ok(false, '舊分頁應該已失效')
    } catch (e) {
      ok(e.code === 'UNAUTHORIZED', `舊分頁的查詢 → 「${e.message}」`)
    }
    await expectError(() => A.login('nurse01', '1234'), '用舊密碼登入')
    ok((await A.demoAccounts()).find((a) => a.username === 'nurse01')?.passwordChanged, '登入頁知道這個展示帳號改過密碼（快速登入改為只帶入帳號）')
    await A.login('nurse01', 'Ward5a2026')

    // 管理員重設 → 下次登入必須先改；改之前什麼都不能做
    await as('admin')
    await expectError(() => api.adminApi.resetPassword(dbm.db.users.find((u) => u.username === 'admin').id, 'Admin2026x'), '管理員用重設功能改自己的密碼')
    try {
      await api.adminApi.resetPassword(me.id, '1234')
      ok(false, '重設成 1234 應被擋下')
    } catch (e) {
      ok(e.field === 'password', `管理員重設也套用同一套規則 → 「${e.message}」`)
    }
    await api.adminApi.resetPassword(me.id, 'Temp2026ab')
    ok(meNow().mustChangePassword && dbm.db.auditLogs[0].detail.includes('下次登入須變更'), '重設後：下次登入必須變更，寫入稽核')
    await A.login('nurse01', 'Temp2026ab')
    ok(A.currentUser()?.mustChangePassword, '用管理員給的密碼登入：登入成功，但標記必須變更')
    try {
      await api.patientApi.searchPatients('王')
      ok(false, '必須先改密碼時查詢應被擋下')
    } catch (e) {
      ok(e.code === 'PASSWORD_CHANGE', `改密碼之前什麼都不能做 → 「${e.message}」（直接呼叫 API 也一樣）`)
    }
    await A.changeOwnPassword({ current: 'Temp2026ab', next: 'Mine2026cd' })
    ok(!A.currentUser().mustChangePassword && dbm.db.auditLogs[0].action === '首次變更密碼' && (await api.patientApi.searchPatients('王')), '改成自己的密碼後即可使用，稽核記為「首次變更密碼」')
    // 還原，後面的測試用 1234 登入
    Object.assign(meNow(), { password: '1234' })
    delete meNow().passwordChangedAt
    delete meNow().mustChangePassword
    await as('clerk01')
  }

  // 多角色：一個帳號多個角色，登入時選一個用、右上角切換；權限與稽核都看當下的角色
  {
    const A = api.authApi
    const RR = await load('/src/services/role-rules.ts')
    ok(dbm.db.users.every((u) => Array.isArray(u.roles) && u.roles.length >= 1), '種子：每個帳號至少一個角色')
    ok(RR.rolesProblem([]) && RR.rolesProblem(['doctor', 'pharmacist']) && !RR.rolesProblem(['nurse', 'clerk']) && !RR.rolesProblem(['doctor', 'admin']), '規則：至少一個角色；醫師＋藥師不可兼任（醫藥分業），其他組合可以')
    await A.logout()
    const first = await A.login('staff01', '1234')
    ok(first.chooseRole?.join() === 'nurse,clerk' && !A.currentUser(), '多角色帳號沒指定角色：不登入，回傳可選的角色讓登入頁問')
    await expectError(() => A.login('staff01', '1234', 'pharmacist'), '用帳號沒有的角色登入')
    const asNurse = await A.login('staff01', '1234', 'nurse')
    ok(asNurse.role === 'nurse' && asNurse.roles.join() === 'nurse,clerk' && dbm.db.auditLogs[0].detail.includes('以護理師身分') && dbm.db.auditLogs[0].role === 'nurse', '以護理師身分登入：作業角色 nurse，稽核記下角色')
    // 以護理師身分：櫃台的事不能做，訊息告訴他切換就好
    const clerkOnly = () => api.chargeApi.repayDebt('不存在', { payMethod: 'cash', amount: 1 })
    try {
      await clerkOnly()
      ok(false, '護理師身分不能做櫃台的事')
    } catch (e) {
      ok(e.code === 'FORBIDDEN' && e.message.includes('請切換為「掛號批價」'), `護理師身分做櫃台的事 → 「${e.message}」（帳號有這個角色，提示切換而不是說沒權限）`)
    }
    ok(!(await api.dashboardApi.getDashboard()).revenue, '以護理師身分：首頁看不到收入（看當下角色，不看帳號所有角色）')
    const sw = await A.switchRole('clerk')
    ok(sw.role === 'clerk' && dbm.db.auditLogs[0].action === '切換角色' && dbm.db.auditLogs[0].detail.includes('護理師 → 掛號批價') && dbm.db.auditLogs[0].role === 'clerk', '切換為掛號批價：寫入稽核（從哪個角色換到哪個）')
    ok(!!(await api.dashboardApi.getDashboard()).revenue, '切換後：首頁看得到收入')
    try {
      await clerkOnly()
    } catch (e) {
      ok(e.code === 'NOT_FOUND', '切換後櫃台的操作通過權限檢查（這裡是找不到收據，不是沒權限）')
    }
    await expectError(() => A.switchRole('doctor'), '切換到帳號沒有的角色')
    // 管理員拿掉正在用的角色：改用帳號剩下的角色，不登出
    const staff = () => dbm.db.users.find((u) => u.username === 'staff01')
    await as('admin')
    await api.adminApi.saveUser({ id: staff().id, username: 'staff01', name: staff().name, roles: ['nurse'], active: true })
    ok(dbm.db.auditLogs[0].detail.includes('nurse'), '管理員改角色：稽核記下新的角色')
    ok((await api.adminApi.listUsers()).find((u) => u.username === 'staff01')?.lastLoginAt, '帳號列表的「最近登入」也找得到多角色登入（稽核內容多了角色，改用 userId 比對）')
    await A.login('staff01', '1234')
    ok(A.currentUser()?.role === 'nurse', '只剩一個角色時直接登入，不再問')
    http.setSessionRole('clerk')
    ok(A.currentUser()?.role === 'nurse' && A.roleFellBack(), '記下的角色已被拿掉：改用剩下的角色（不登出），版面會提示')
    await as('admin')
    await api.adminApi.saveUser({ id: staff().id, username: 'staff01', name: staff().name, roles: ['nurse', 'clerk'], active: true })
    // 醫藥分業、醫師需對應醫師、不能拿掉自己的管理員角色
    const ph = dbm.db.users.find((u) => u.username === 'ph01')
    try {
      await api.adminApi.saveUser({ id: ph.id, username: 'ph01', name: ph.name, roles: ['pharmacist', 'doctor'], doctorId: 'DR09', active: true })
      ok(false, '醫師＋藥師應被擋下')
    } catch (e) {
      ok(e.field === 'roles' && e.message.includes('醫藥分業'), `藥師加醫師角色 → 「${e.message}」`)
    }
    try {
      await api.adminApi.saveUser({ id: ph.id, username: 'ph01', name: ph.name, roles: ['nurse', 'doctor'], active: true })
      ok(false, '含醫師角色沒對應醫師應被擋下')
    } catch (e) {
      ok(Object.keys(e.fields ?? { [e.field]: 1 }).includes('doctorId'), '含醫師角色的帳號要對應醫師')
    }
    const me = dbm.db.users.find((u) => u.username === 'admin')
    try {
      await api.adminApi.saveUser({ id: me.id, username: 'admin', name: me.name, roles: ['clerk'], active: true })
      ok(false, '拿掉自己的管理員角色應被擋下')
    } catch (e) {
      ok(e.field === 'roles', '不能拿掉自己的管理員角色')
    }
    // 院長兼醫師：醫師角色時能看診，管理員角色時不能做臨床操作（「管理員不能臨床」的規則照樣成立）
    const dr = dbm.db.users.find((u) => u.username === 'dr01')
    await api.adminApi.saveUser({ id: dr.id, username: 'dr01', name: dr.name, roles: ['doctor', 'admin'], doctorId: dr.doctorId, active: true })
    await A.login('dr01', '1234', 'admin')
    await expectError(() => api.opdApi.startConsult('不存在'), '醫師兼管理員以管理員身分看診')
    ok((await api.adminApi.listUsers()).length > 0, '以管理員身分可以管理帳號')
    await as('admin')
    await api.adminApi.saveUser({ id: dr.id, username: 'dr01', name: dr.name, roles: ['doctor'], doctorId: dr.doctorId, active: true })
    await as('clerk01')
  }

  // 掛號單條碼（U7）：Code 39
  {
    const C = await load('/src/utils/code39.ts')
    const pats = Object.entries(C.CODE39)
    ok(pats.every(([, x]) => x.length === 9 && [...x].filter((c) => c === 'w').length === 3) && new Set(pats.map(([, x]) => x)).size === pats.length,
      `Code 39：${pats.length} 個字元，每個 9 條中正好 3 條寬、彼此不重複`)
    // 對照標準表（ISO/IEC 16388）：起訖符號 *、數字 0、1
    ok(C.CODE39['*'] === 'nwnnwnwnn' && C.CODE39['0'] === 'nnnwwnwnn' && C.CODE39['1'] === 'wnnwnnnnw', 'Code 39：起訖符號與數字對照標準表')
    const b = C.code39Bars('100005')
    // 8 個字（含前後 *）× (6 窄 + 3 寬×3 = 15) + 7 個字間空白 = 127
    ok(b.bars.length === 8 * 5 && b.width === 8 * 15 + 7, `病歷號 100005 → ${b.bars.length} 條黑條、總寬 ${b.width} 個窄條寬`)
    let threw = false
    try {
      C.code39Bars('王')
    } catch {
      threw = true
    }
    ok(threw, '不支援的字元直接報錯（印出掃不出來的條碼比印不出來更糟）')
  }

  // B2：掛號身分選錯可以更正（收費前），更正後依新身分重算
  {
    const pending = dbm.db.visits.find((v) => v.status === 'consulted' && v.identityCode === '01')
    const before = await api.chargeApi.previewCharge(pending.id)
    await expectError(() => api.bookingApi.correctIdentity(pending.id, '01', '測試'), '更正成相同身分')
    try {
      await api.bookingApi.correctIdentity(pending.id, '', '')
      ok(false, '空白更正應被擋下')
    } catch (e) {
      ok(Object.keys(e.fields ?? {}).sort().join() === 'identityCode,reason', '更正身分空白送出：身分與原因一次標出')
    }
    await expectError(() => api.bookingApi.correctIdentity(charge.visitId, '02', '出示榮民證'), '已開收據的掛號更正身分（要先作廢）')
    await as('nurse01')
    await expectError(() => api.bookingApi.correctIdentity(pending.id, '02', '出示榮民證'), '非櫃台人員更正身分')
    await as('clerk01')
    await api.bookingApi.correctIdentity(pending.id, '02', '出示榮民證')
    const after = await api.chargeApi.previewCharge(pending.id)
    const reg = (p) => p.lines.find((l) => l.kind === 'reg')
    ok(reg(before).amount === 150 && reg(after).amount === 50 && after.patientTotal < before.patientTotal && dbm.db.auditLogs[0].action === '更正就醫身分' && dbm.db.auditLogs[0].detail.includes('健保一般 → 榮民'),
      `更正身分後試算依新身分重算（掛號費 150 → 50，應收 ${before.patientTotal} → ${after.patientTotal}），稽核留下前後身分`)
    await api.bookingApi.correctIdentity(pending.id, '01', '測試還原')
  }

  console.log('\n[規則] 過敏與預防保健')
  // U10：錢不夠可以記欠款，之後分次收回；日結的實收對得上錢箱
  {
    const C = api.chargeApi
    const B = await load('/src/services/billing.ts')
    ok(B.checkCash(500, 200) !== null && B.checkCash(500, 200, true) === null && B.checkCash(500, 0, true) === null, '規則：沒勾欠款時不足要擋；勾了欠款，少收（含 0 元）可以')
    ok(B.checkCash(500, 500, true) === '實收已足額，不需記欠款' && B.checkCash(500, -1, true) !== null, '規則：勾了欠款卻足額、或負數，擋下')
    ok(B.checkRepay(300, 300) === null && B.checkRepay(300, 301) !== null && B.checkRepay(300, 0) !== null && B.checkRepay(300, 1.5) !== null, '規則：收回金額需 1～尚欠的整數')

    // 找一位應收夠多的（免部分負擔的病人應收可能是 0，「少收 100」就成了負數）
    let v, pv
    for (const x of dbm.db.visits.filter((x) => x.status === 'consulted' && x.date === T)) {
      const t = await C.previewCharge(x.id)
      if (t.patientTotal >= 200) { v = x; pv = t; break }
    }
    ok(!!v, '找到應收 ≥ 200 的待批價病人')
    const before = await C.dailyReport(T)
    const debtBefore = (await C.getChargeDetail(v.id)).visit.debt
    await expectError(() => C.pay(v.id, { payMethod: 'cash', received: pv.patientTotal - 100 }), '實收不足、沒勾欠款')
    try {
      await C.pay(v.id, { payMethod: 'cash', received: 0, owe: { reason: ' ' } })
      ok(false, '欠款沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'oweReason', '欠款沒寫原因 → 標在「欠款原因」欄')
    }
    await expectError(() => C.pay(v.id, { payMethod: 'card', received: 0, owe: { reason: '測試' } }), '刷卡不能記欠款')
    const paidNow = pv.patientTotal - 100
    const c = await C.pay(v.id, { payMethod: 'cash', received: paidNow, owe: { reason: '忘了帶錢' } })
    ok(c.owed === 100 && c.change === 0 && dbm.db.visits.find((x) => x.id === v.id).status === 'charged', '記欠款 100 元：照常結帳（狀態 charged、不找零）')
    const after = await C.getChargeDetail(v.id)
    ok(after.visit.debt === debtBefore + 100 && after.debts.some((d) => d.chargeId === c.id && d.outstanding === 100), `病人尚欠 ${after.visit.debt} 元，欠款清單列出這張收據`)
    const rep = await C.dailyReport(T)
    ok(rep.newDebt === before.newDebt + 100 && rep.collected === rep.patientTotal - rep.newDebt + rep.repaid && rep.collected === before.collected + paidNow,
      `日結：新欠款 +100，實收只增加實際收到的 ${paidNow} 元`)
    const sumMethods = rep.byPayMethod.cash + rep.byPayMethod.card + rep.byPayMethod.mobile
    ok(sumMethods === rep.collected && rep.byCashier.reduce((s, x) => s + x.collected, 0) === rep.collected, '依付款方式、依收費人員加總都 = 實收')

    await expectError(() => C.repayDebt(c.id, { payMethod: 'cash', amount: 101 }), '收回超過尚欠')
    const r1 = await C.repayDebt(c.id, { payMethod: 'cash', amount: 40 })
    ok(r1.receiptNo.startsWith('R' + T.replace(/-/g, '')) && r1.receiptNo !== c.receiptNo && dbm.db.auditLogs[0].action === '收回欠款', `分次收回 40 元：新收據號 ${r1.receiptNo}，寫入稽核`)
    ok((await C.listDebts(v.patientId)).find((d) => d.chargeId === c.id)?.outstanding === 60, '收回一部分後尚欠 60')
    await expectError(() => C.voidCharge(c.id, '測試'), '已收回過欠款的收據不能作廢')
    await C.repayDebt(c.id, { payMethod: 'mobile', amount: 60 })
    ok(!(await C.listDebts(v.patientId)).some((d) => d.chargeId === c.id), '還清後不再列在欠款')
    const rep2 = await C.dailyReport(T)
    ok(rep2.repaid === rep.repaid + 100 && rep2.collected === rep.collected + 100 && rep2.byPayMethod.mobile === rep.byPayMethod.mobile + 60 && rep2.repayments.length === rep.repayments.length + 2,
      '日結：收回的 100 元算進實收，行動支付 +60，收回明細多兩筆')

    // 沒收回過的欠款收據可以作廢，欠款跟著消失
    const v2 = dbm.db.visits.find((x) => x.status === 'consulted' && x.date === T)
    if (v2) {
      const d0 = (await C.getChargeDetail(v2.id)).visit.debt
      const pv2 = await C.previewCharge(v2.id)
      const c2 = await C.pay(v2.id, { payMethod: 'cash', received: 0, owe: { reason: '測試' } })
      ok((await C.getChargeDetail(v2.id)).visit.debt === d0 + pv2.patientTotal, `全額欠款 ${pv2.patientTotal} 元`)
      await C.voidCharge(c2.id, '測試作廢欠款')
      ok((await C.getChargeDetail(v2.id)).visit.debt === d0, '作廢後欠款一併取消')
    }
  }

  // 展示資料本身不可違反用藥安全
  const { checkAllergies } = await load('/src/services/allergy.ts')
  const unsafe = dbm.db.encounters.filter((e) => {
    const p = dbm.db.patients.find((x) => x.id === e.patientId)
    return checkAllergies(p.allergies, e.medications.map((m) => dbm.db.drugs.find((d) => d.id === m.drugId))).length > 0
  })
  ok(unsafe.length === 0, `種子病歷中沒有開立病人過敏的藥（違規 ${unsafe.length} 筆）`)
  const billing = await load('/src/services/billing.ts')
  const insulin = dbm.db.drugs.find((d) => d.id === 'M038')
  const tab = dbm.db.drugs.find((d) => d.id === 'M001')
  ok(billing.doseUnitOf(insulin) === 'U' && billing.autoQty(insulin, 10, 1, 7) === null, 'Insulin 給藥單位為 U，總量（PEN）不可由劑量換算')
  ok(billing.autoQty(tab, 1, 3, 3) === 9, '錠劑總量可自動換算：1 錠 × TID × 3 天 = 9')
  const { ageOf } = await load('/src/utils/date.ts')
  const childInpatients = dbm.db.admissions.filter((a) => {
    const p = dbm.db.patients.find((x) => x.id === a.patientId)
    return a.status === 'admitted' && ageOf(p.birthDate) < 18
  })
  ok(childInpatients.length === 0, `成人病房的住院病人皆為成人（違規 ${childInpatients.length} 筆）`)
  // 門診科別符合臨床常識（獨立寫一份判斷，不重用種子裡的函式——測試若和被測程式共用邏輯，就抓不到那段邏輯的錯）
  const deptName = (id) => dbm.db.departments.find((d) => d.id === id)?.name
  const misfit = dbm.db.visits.filter((v) => {
    const p = dbm.db.patients.find((x) => x.id === v.patientId)
    const age = ageOf(p.birthDate, v.date)
    const dn = deptName(v.deptId)
    return (dn === '小兒科' && age >= 18) || (dn !== '小兒科' && age < 13) || (dn === '婦產科' && p.gender !== 'F')
  })
  ok(misfit.length === 0, `門診掛號的科別符合病人年齡與性別（違規 ${misfit.length} 筆${misfit.length ? '，例：' + misfit.slice(0, 2).map((v) => `${dbm.db.patients.find((p) => p.id === v.patientId).name}→${deptName(v.deptId)}`).join('、') : ''}）`)
  const allergic = dbm.db.patients.find((p) => p.allergies.includes('Penicillin'))
  const warns = await api.opdApi.allergyWarnings(allergic.id, ['M003', 'M004', 'M001'])
  ok(warns.length === 2, `${allergic.name}（Penicillin 過敏）開 Amoxicillin、Augmentin、Acetaminophen → ${warns.length} 筆警示`)
  const el = await api.preventApi.eligibilityFor(dbm.db.patients[0].id)
  console.log('    ' + el.map((e) => `${e.itemName}:${e.eligible ? '可' : '否'}`).join('  '))
  ok(el.find((e) => e.itemCode === 'CERVIX').eligible === false, '男性不符合子宮頸抹片')

  console.log('\n[預防保健]')
  const pr = await load('/src/services/prevent-rules.ts')
  const colon = dbm.db.preventItems.find((i) => i.code === 'COLON')
  const p50 = { id: 'X', gender: 'M', birthDate: '1970-01-01', familyHistory: [], smoking: false, betelNut: false }
  const rec = (date) => [{ id: 'R', patientId: 'X', itemCode: 'COLON', date, doctorId: 'DR01', result: '正常', data: {} }]
  ok(!pr.checkEligibility(p50, colon, rec('2023-05-02'), '2025-05-01').eligible && pr.checkEligibility(p50, colon, rec('2023-05-02'), '2025-05-02').eligible, '間隔邊界：上次 2023-05-02、每 2 年 → 2025-05-01 不可、2025-05-02 可')
  const leap = pr.checkEligibility(p50, colon, rec('2024-02-29'), '2026-02-28')
  ok(!leap.eligible && leap.nextDate === '2026-03-01', `閏日：2024-02-29 + 2 年 → ${leap.nextDate}（2/28 還不算滿）`)
  ok(pr.checkEligibility(p50, colon, rec('2025-06-01'), '2024-01-01').eligible, '判斷過去日期時，不受之後的紀錄影響')
  const badSeed = dbm.db.preventRecords.filter((r) => {
    const p = dbm.db.patients.find((x) => x.id === r.patientId)
    const item = dbm.db.preventItems.find((i) => i.code === r.itemCode)
    return !pr.checkEligibility(p, item, dbm.db.preventRecords.filter((x) => x.id !== r.id), r.date).eligible
  })
  ok(badSeed.length === 0, `種子資料 ${dbm.db.preventRecords.length} 筆預防保健紀錄皆符合資格規則（違規 ${badSeed.length} 筆）`)
  // 種子資料也要守規則：定案的紀錄欄位要填齊（獨立檢查，不呼叫規則函式）
  const incomplete = dbm.db.preventRecords.filter((r) => r.result !== '待報告' && dbm.db.preventItems.find((i) => i.code === r.itemCode).fields.some((f) => !String(r.data[f] ?? '').trim()))
  ok(incomplete.length === 0, `種子資料中「正常／異常」的預防保健紀錄欄位皆填齊（缺漏 ${incomplete.length} 筆）`)

  await as('clerk01')
  const male = dbm.db.patients.find((p) => p.gender === 'M' && p.birthDate < '1990-01-01')
  const pmSession = (await api.scheduleApi.listSessions({ date: dbm.db.visits.find((v) => v.date > new Date().toISOString().slice(0, 10))?.date ?? '' }))[0]
  if (pmSession) await expectError(() => api.bookingApi.register({ patientId: male.id, sessionId: pmSession.id, identityCode: '01', caseType: '01', preventItems: ['CERVIX'] }), `${male.name}（男）掛號勾子宮頸抹片（服務層也要判斷資格）`)

  await as('nurse01')
  const wl = await api.preventApi.todayWorklist()
  ok(wl.length > 0, `今日待執行預防保健 ${wl.length} 位（來自掛號時勾選）`)
  const todo = wl.find((w) => w.items.some((i) => !i.done))
  const code = todo.items.find((i) => !i.done).code
  await expectError(() => api.preventApi.addPreventRecord({ patientId: todo.visit.patientId, itemCode: code, result: '正常', data: {}, visitId: todo.visit.id }), '護理師登錄未指定執行醫師')
  const todoItem = dbm.db.preventItems.find((i) => i.code === code)
  // 各欄位的合理值（表上有格式的欄位要符合格式，其他自由文字）
  const sample = { 血壓: '120/80', 空腹血糖: '95', 總膽固醇: '180', 身高: '110', 體重: '20', BMI: '22' }
  const fullData = Object.fromEntries(todoItem.fields.map((f) => [f, sample[f] ?? '測試值']))
  // H1：定案的結果（正常／異常）必須填齊項目欄位；錯誤要一次列出所有缺漏
  try {
    await api.preventApi.addPreventRecord({ patientId: todo.visit.patientId, itemCode: code, result: '正常', data: {}, visitId: todo.visit.id })
    ok(false, '空白選「正常」應該被擋下')
  } catch (e) {
    const keys = Object.keys(e.fields ?? {})
    ok(e.name === 'ServiceError' && keys.includes('doctorId') && todoItem.fields.every((f) => keys.includes('data:' + f)), `空白選「正常」被擋，一次列出 ${keys.length} 個欄位（執行醫師＋${todoItem.fields.join('、')}）`)
  }
  if (todoItem.fields.length > 1) {
    const [first, ...rest] = todoItem.fields
    await expectError(() => api.preventApi.addPreventRecord({ patientId: todo.visit.patientId, itemCode: code, result: '正常', data: Object.fromEntries(rest.map((f) => [f, sample[f] ?? '測試值'])), visitId: todo.visit.id, doctorId: todo.visit.doctorId }), `只缺「${first}」也要擋`)
  }
  await expectError(() => api.preventApi.addPreventRecord({ patientId: todo.visit.patientId, itemCode: code, result: '', data: fullData, visitId: todo.visit.id, doctorId: todo.visit.doctorId }), '沒選結果')
  await expectError(() => api.preventApi.addPreventRecord({ patientId: todo.visit.patientId, itemCode: code, result: '正常', data: Object.fromEntries(todoItem.fields.map((f) => [f, '   '])), visitId: todo.visit.id, doctorId: todo.visit.doctorId }), '欄位只填空白')
  await api.preventApi.addPreventRecord({ patientId: todo.visit.patientId, itemCode: code, result: '正常', data: fullData, visitId: todo.visit.id, doctorId: todo.visit.doctorId })
  ok((await api.preventApi.todayWorklist()).find((w) => w.visit.id === todo.visit.id).items.find((i) => i.code === code).done, '登錄後，待執行清單標記完成')
  // U14：看診頁的預防保健狀態，與預防保健頁的工作清單同一份判斷
  {
    const st = await api.preventApi.visitPreventStatus(todo.visit.id)
    const wlRow = (await api.preventApi.todayWorklist()).find((w) => w.visit.id === todo.visit.id)
    const same = st.length === wlRow.items.length && st.every((s) => wlRow.items.find((i) => i.code === s.item.code)?.done === s.done)
    ok(same && st.find((s) => s.item.code === code)?.done && st.find((s) => s.item.code === code)?.result === '正常' && st.every((s) => Array.isArray(s.item.fields)),
      `看診頁的預防保健狀態 = 工作清單（${st.map((s) => `${s.item.name}${s.done ? '✓' + s.result : '待登錄'}`).join('、')}），並帶項目欄位供登錄框使用`)
  }
  await expectError(() => api.preventApi.addPreventRecord({ patientId: todo.visit.patientId, itemCode: code, result: '正常', data: {}, doctorId: todo.visit.doctorId }), '同一天重複登錄')
  const pendingRec = dbm.db.preventRecords.find((r) => r.result === '待報告')
  await expectError(() => api.preventApi.fillReport(pendingRec.id, '正常', {}), '補登報告未填內容')
  await expectError(() => api.preventApi.fillReport(pendingRec.id, '', { 報告: 'NILM' }), '補登報告沒選結果')
  await expectError(() => api.preventApi.fillReport(pendingRec.id, '待報告', { 報告: 'NILM' }), '補登報告選「待報告」')
  // H4：補登時結果與欄位都空白 → 一次標出兩者；新登錄（可選待報告）結果空白時只標結果
  try {
    await api.preventApi.fillReport(pendingRec.id, '', {})
    ok(false, '補登全空白應被擋下')
  } catch (e) {
    const keys = Object.keys(e.fields ?? {})
    ok(keys.includes('result') && keys.includes('data:報告'), `補登全空白：一次標出 ${keys.join('、')}`)
  }
  {
    const pi = dbm.db.preventItems.find((i) => i.code === pendingRec.itemCode)
    const k = Object.keys(pr.checkPreventResult(pi, '', {}, { allowPending: true }))
    ok(k.length === 1 && k[0] === 'result', '新登錄結果空白：只標結果（欄位要不要填取決於選哪個結果）')
    ok(Object.keys(pr.checkPreventResult(pi, '待報告', {}, { allowPending: false })).join() === 'result,data:報告', '補登選「待報告」：結果與欄位都標出（錯誤不會被丟掉）')
  }
  await api.preventApi.fillReport(pendingRec.id, '正常', { 報告: 'NILM' })
  {
    const log = dbm.db.auditLogs[0]
    const itemName = dbm.db.preventItems.find((i) => i.code === pendingRec.itemCode).name
    ok(log.action === '補登預防保健報告' && log.detail.includes(itemName) && !log.detail.includes(pendingRec.itemCode), `補登報告稽核寫中文項目名稱（${log.detail}）`)
  }
  await expectError(() => api.preventApi.fillReport(pendingRec.id, '異常需追蹤', { 報告: '改寫' }), '已有結果的報告再補登（紀錄只能增補不能改寫）')

  // H3：量測欄位格式；BMI 由身高體重計算
  {
    const pr = await load('/src/services/prevent-rules.ts')
    const adult = dbm.db.preventItems.find((i) => i.code === 'ADULT')
    ok(!adult.fields.includes('BMI') && adult.fields.includes('身高') && adult.fields.includes('體重'), '成人預防保健改填身高、體重（BMI 不再手動輸入）')
    const errs = pr.checkPreventResult(adult, '正常', { 血壓: 'abc', 空腹血糖: '-5', 總膽固醇: '99999', 身高: 'ok', 體重: '65' }, { allowPending: true })
    ok(['data:血壓', 'data:空腹血糖', 'data:總膽固醇', 'data:身高'].every((k) => errs[k]) && !errs['data:體重'], `格式錯誤一次列出（${Object.values(errs).join('／')}）`)
    ok(/顛倒/.test(pr.checkFieldFormat('血壓', '80/120') ?? ''), '收縮壓小於舒張壓會提醒是否顛倒')
    ok(pr.checkFieldFormat('血壓', '128 / 82') === null && pr.checkFieldFormat('體重', '62.5') === null, '合理值（含空白的血壓、小數體重）可通過')
    ok(pr.calcBmi('170', '65') === '22.5' && pr.calcBmi('abc', '65') === undefined, 'BMI = 體重 ÷ 身高²（170 cm、65 kg → 22.5）；身高不合理時不計算')
    ok(pr.withDerivedFields({ 身高: '170', 體重: '65', BMI: '99' }).BMI === '22.5', '手動填的 BMI 會被系統計算值覆蓋')
    const who = dbm.db.patients.find((x) => pr.checkEligibility(x, adult, dbm.db.preventRecords, T).eligible)
    const rec = await api.preventApi.addPreventRecord({ patientId: who.id, itemCode: 'ADULT', result: '正常', data: { 血壓: '120/80', 空腹血糖: '95', 總膽固醇: '180', 身高: '170', 體重: '65' }, doctorId: 'DR01' })
    ok(rec.data.BMI === '22.5', `登錄成人預防保健，BMI 自動算出並存入（${rec.data.BMI}）`)
    const badSeedFmt = dbm.db.preventRecords.filter((r) => r.result !== '待報告' && !r.voided && Object.entries(r.data).some(([k, v]) => pr.checkFieldFormat(k, v)))
    const badDesc = badSeedFmt.slice(0, 3).map((r) => `${r.itemCode} ${JSON.stringify(r.data)}`).join('；')
    ok(badSeedFmt.length === 0, `種子資料的量測值都符合格式與範圍（不符 ${badSeedFmt.length} 筆${badDesc ? '：' + badDesc : ''}）`)
    const adultSeed = dbm.db.preventRecords.filter((r) => r.itemCode === 'ADULT' && r.result !== '待報告')
    ok(adultSeed.length > 0 && adultSeed.every((r) => r.data.BMI === pr.calcBmi(r.data['身高'], r.data['體重'])), `種子資料 ${adultSeed.length} 筆成人預防保健的 BMI 都與身高體重一致`)
  }

  // H2：作廢——紀錄保留、加註記；作廢後不佔資格、不計統計、不能補登，可重新登錄
  {
    const pr = await load('/src/services/prevent-rules.ts')
    const target = dbm.db.preventRecords.find((r) => r.patientId === todo.visit.patientId && r.itemCode === code && r.date === T)
    const month = T.slice(0, 7)
    const statBefore = (await api.preventApi.monthlyStats(month)).find((x) => x.code === code).count
    await expectError(() => api.preventApi.voidPreventRecord(target.id, '  '), '作廢沒填原因')
    await as('clerk01')
    await expectError(() => api.preventApi.voidPreventRecord(target.id, '登錄錯誤'), '掛號人員作廢預防保健紀錄（權限）')
    await as('nurse01')
    await api.preventApi.voidPreventRecord(target.id, '選錯項目')
    const kept = dbm.db.preventRecords.find((r) => r.id === target.id)
    ok(kept && kept.voided?.reason === '選錯項目' && Object.keys(kept.data).length > 0, '作廢後紀錄仍在、原內容未改，加上作廢原因')
    await expectError(() => api.preventApi.voidPreventRecord(target.id, '再一次'), '重複作廢')
    ok((await api.preventApi.monthlyStats(month)).find((x) => x.code === code).count === statBefore - 1, '作廢的紀錄不計入月統計')
    ok(!(await api.preventApi.todayWorklist()).find((w) => w.visit.id === todo.visit.id).items.find((i) => i.code === code).done, '作廢後，今日工作變回待執行')
    const pt = dbm.db.patients.find((x) => x.id === todo.visit.patientId)
    ok(pr.checkEligibility(pt, todoItem, dbm.db.preventRecords, T).eligible, '作廢後資格恢復（不再顯示「今天已執行」）')
    await api.preventApi.addPreventRecord({ patientId: pt.id, itemCode: code, result: '正常', data: fullData, visitId: todo.visit.id, doctorId: todo.visit.doctorId })
    ok(true, '作廢後可以重新登錄正確的一筆')
    // 待報告的紀錄作廢後：不出現在待補登清單、也不能補登
    // 自己建一筆待報告（不依賴種子資料剛好還剩一筆），確保這段一定會執行
    let combo
    for (const it of dbm.db.preventItems.filter((i) => i.needsReport && i.active !== false)) {
      const who = dbm.db.patients.find((x) => pr.checkEligibility(x, it, dbm.db.preventRecords, T).eligible)
      if (who) { combo = { it, who }; break }
    }
    ok(!!combo, '找得到可登錄「待報告」的病人與項目')
    const pend = await api.preventApi.addPreventRecord({ patientId: combo.who.id, itemCode: combo.it.code, result: '待報告', data: {}, doctorId: 'DR01' })
    ok((await api.preventApi.listPreventRecords({ result: '待報告' })).some((r) => r.id === pend.id), '新的待報告紀錄出現在待補登清單')
    await api.preventApi.voidPreventRecord(pend.id, '選錯病人')
    ok(!(await api.preventApi.listPreventRecords({ result: '待報告' })).some((r) => r.id === pend.id), '作廢的待報告紀錄不出現在待補登清單')
    await expectError(() => api.preventApi.fillReport(pend.id, '正常', { 報告: 'NILM' }), '作廢的紀錄補登報告')
    ok(dbm.db.auditLogs.some((l) => l.action === '作廢預防保健紀錄'), '作廢寫入稽核紀錄')
  }

  console.log('\n[住院] 預約 → 報到 → 醫囑 → 給藥 → 出院')
  await as('nurse01')
  const resvList = await api.admissionApi.listAdmissions({ status: ['reserved'] })
  const resv = resvList[0]
  const bed = dbm.db.beds.find((b) => b.status === 'empty')
  // U21：保留床要指定病人；那位病人報到時可以直接選，別人不行；報到在別床、預約取消時自動解除保留
  {
    const spare = dbm.db.beds.find((b) => b.status === 'empty' && b.id !== bed.id)
    try {
      await api.admissionApi.setBedStatus(spare.id, 'reserved')
      ok(false, '沒指定病人的保留應被擋下')
    } catch (e) {
      ok(e.field === 'reservedFor', `保留床沒指定病人 → 「${e.message}」`)
    }
    await api.admissionApi.setBedStatus(bed.id, 'reserved', resv.id)
    await api.admissionApi.setBedStatus(spare.id, 'reserved', resv.id)
    const shown = (await api.admissionApi.listBeds(bed.ward)).find((b) => b.id === bed.id)
    ok(shown.reservedForName === resv.patientName, `床位圖顯示「保留：${shown.reservedForName}」`)
    if (resvList[1]) await expectError(() => api.admissionApi.checkIn(resvList[1].id, bed.id), `別的病人報到在保留給 ${resv.patientName} 的床`)
    // 新建一筆預約、保留一床，再取消預約：保留的床要放回空床
    const someone = dbm.db.patients.find((p) => !dbm.db.admissions.some((a) => a.patientId === p.id && ['reserved', 'admitted'].includes(a.status)) && p.birthDate < '2000-01-01')
    const r2 = await api.admissionApi.reserve({ patientId: someone.id, deptId: resv.deptId, doctorId: resv.doctorId, preferBedClass: '健保床', reason: '測試', diagnosis: 'J18.9 肺炎', expectedDate: T })
    const third = dbm.db.beds.find((b) => b.status === 'empty' && b.id !== bed.id && b.id !== spare.id)
    await api.admissionApi.setBedStatus(third.id, 'reserved', r2.id)
    await api.admissionApi.cancelReservation(r2.id)
    ok(dbm.db.beds.find((b) => b.id === third.id).status === 'empty' && !dbm.db.beds.find((b) => b.id === third.id).reservedFor, '住院預約取消時，保留給他的床自動放回空床')
    globalThis.__spareBed = spare.id
  }
  const adm = await api.admissionApi.checkIn(resv.id, bed.id)
  {
    const b1 = dbm.db.beds.find((b) => b.id === bed.id)
    const b2 = dbm.db.beds.find((b) => b.id === globalThis.__spareBed)
    ok(b1.status === 'occupied' && !b1.reservedFor && b2.status === 'empty' && !b2.reservedFor, '保留給這位病人的床可以直接報到；他另一張保留床同時放回空床')
  }
  ok(adm.status === 'admitted' && dbm.db.beds.find((b) => b.id === bed.id).status === 'occupied', `${adm.patientName} 報到 ${bed.bedNo}，住院號 ${adm.admitNo}`)
  const occupied = dbm.db.beds.find((b) => b.status === 'occupied' && b.id !== bed.id)
  await expectError(() => api.admissionApi.transferBed(adm.id, occupied.id), '轉到有人的病床')

  await as('dr02')
  const order = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'long', category: 'medication', drugId: 'M036', content: '', dose: 1, freq: 'Q12H', route: 'IV' })
  const marTomorrow = dbm.db.mar.filter((m) => m.orderId === order.id)
  ok(marTomorrow.length >= 2, `開立 Ceftriaxone Q12H → 自動產生 ${marTomorrow.length} 筆給藥排程`)
  const dupInput = { admissionId: adm.id, type: 'long', category: 'medication', drugId: 'M036', content: '', dose: 1, freq: 'Q12H', route: 'IV' }
  await expectError(() => api.ipdApi.addOrder(dupInput), '已有執行中的 Ceftriaxone 又開一筆（未確認）')
  const dupOrder = await api.ipdApi.addOrder({ ...dupInput, allowDuplicate: true })
  ok(!('allowDuplicate' in dbm.db.ipdOrders.find((o) => o.id === dupOrder.id)), '醫師確認後可再開一筆；「確認」旗標不會存進醫囑資料')
  await api.ipdApi.stopOrder(dupOrder.id)
  const doseBase = { admissionId: adm.id, type: 'stat', category: 'medication', drugId: 'M001', content: '', freq: 'STAT', route: 'PO' }
  await expectError(() => api.ipdApi.addOrder({ ...doseBase, dose: 100 }), '住院劑量每次 100 顆（不合理）')
  await expectError(() => api.ipdApi.addOrder({ ...doseBase, dose: 5 }), '住院劑量每次 5 顆（偏高、未確認）')
  const highOrder = await api.ipdApi.addOrder({ ...doseBase, dose: 5, confirmHighDose: true })
  ok(highOrder.dose === 5 && !('confirmHighDose' in dbm.db.ipdOrders.find((o) => o.id === highOrder.id)), '劑量偏高經醫師確認後可開立；確認旗標不存進醫囑')
  await api.ipdApi.stopOrder(highOrder.id)

  await api.ipdApi.addOrder({ admissionId: adm.id, type: 'long', category: 'diet', content: '普通飲食' })
  await api.ipdApi.addOrder({ admissionId: adm.id, type: 'long', category: 'diet', content: '糖尿病飲食' })
  const diets = dbm.db.ipdOrders.filter((o) => o.admissionId === adm.id && o.category === 'diet' && o.status === 'active')
  ok(diets.length === 1 && diets[0].content === '糖尿病飲食', '開立新飲食醫囑時，舊的自動停止（同時只有一種飲食）')

  const statMed = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'medication', drugId: 'M001', content: '', dose: 1, freq: 'STAT', route: 'PO' })

  await as('nurse01')
  const nr = await load('/src/services/nursing-rules.ts')
  ok(nr.marUrgency('2024-05-01 09:00', '2024-05-01 07:59') === 'upcoming' && nr.marUrgency('2024-05-01 09:00', '2024-05-01 08:00') === 'due' && nr.marUrgency('2024-05-01 09:00', '2024-05-01 09:31') === 'overdue', '給藥時間窗：前 60 分鐘可給、逾 30 分鐘算逾時')
  // U16：護理站看得到所有醫囑（飲食、護理、處置、用藥），24 小時內的異動要標出來
  {
    const N = '2024-05-02 10:00'
    ok(nr.orderChange({ status: 'active', startAt: '2024-05-01 10:00' }, N) === 'new' && nr.orderChange({ status: 'active', startAt: '2024-05-01 09:59' }, N) === null, '醫囑 24 小時內新開標「新」，超過就不標')
    ok(nr.orderChange({ status: 'stopped', startAt: '2024-04-01 08:00', stopAt: '2024-05-02 08:00' }, N) === 'stopped' && nr.orderChange({ status: 'done', startAt: '2024-05-02 08:00', stopAt: '2024-05-02 09:00' }, N) === 'done' && nr.orderChange({ status: 'stopped', startAt: '2024-04-01 08:00', stopAt: '2024-04-30 08:00' }, N) === null,
      '24 小時內停止／完成的仍列出（已停、已完成），更早的不列')
  }
  // B4：生命徵象異常只有一條規則 isAbnormal；頁面不得自己寫門檻（以前醫師頁寫死體溫 ≥38，37.8°C 護理站紅、醫師頁不紅）
  {
    ok(nr.isAbnormal('temp', 37.8) && !nr.isAbnormal('temp', 37.5) && nr.isAbnormal('spo2', 93) && nr.isAbnormal('pulse', 105), '異常判斷：體溫 37.8、SpO2 93、脈搏 105 都算異常')
    const { readFileSync, readdirSync, statSync } = await import('node:fs')
    const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(`${dir}/${f}`).isDirectory() ? walk(`${dir}/${f}`) : [`${dir}/${f}`]))
    const hardcoded = walk('src/pages')
      .filter((f) => /\.(vue|ts)$/.test(f))
      .flatMap((f) => readFileSync(f, 'utf8').split('\n').map((line, i) => [f, i + 1, line]))
      .filter(([, , line]) => /\.(temp|pulse|resp|sbp|dbp|spo2|pain)\b[^\n]{0,12}[<>]=?\s*\d/.test(line))
    ok(hardcoded.length === 0, `頁面沒有自己寫生命徵象門檻${hardcoded.length ? '：' + hardcoded.map(([f, n]) => `${f}:${n}`).join('、') : ''}`)
  }
  ok(nr.shiftOf('2024-05-01 07:59') === '大夜' && nr.shiftOf('2024-05-01 08:00') === '白班' && nr.shiftOf('2024-05-01 16:00') === '小夜', '班別判斷')
  ok(nr.handoverShiftOf('2024-05-01 08:10') === '大夜' && nr.handoverShiftOf('2024-05-01 15:40') === '白班', '交班預設為正要結束的班別（08:10 寫的是大夜交班）')
  // B1：交班屬於「班」，不屬於日曆日——小夜 23:45 寫的，大夜 00:15 要看得到
  {
    const key = (s) => `${s.date} ${s.shift}`
    ok(key(nr.shiftInstanceOf('小夜', '2024-05-02 00:10')) === '2024-05-01 小夜' && key(nr.shiftInstanceOf('小夜', '2024-05-01 23:45')) === '2024-05-01 小夜', '午夜後才寫的小夜交班，歸在前一天的小夜')
    ok(key(nr.shiftInstanceOf('大夜', '2024-05-02 08:10')) === '2024-05-02 大夜' && key(nr.shiftInstanceOf('白班', '2024-05-02 15:40')) === '2024-05-02 白班', '大夜 08:10、白班 15:40 寫的交班留在當天')
    ok(nr.recentShifts('2024-05-02 00:15', 3).map(key).join('、') === '2024-05-02 大夜、2024-05-01 小夜、2024-05-01 白班', '大夜 00:15 的最近三班：本班、前一天小夜、前一天白班（23:45 的小夜交班看得到）')
    ok(nr.recentShifts('2024-03-01 09:00', 4).map(key).join('、') === '2024-03-01 白班、2024-03-01 大夜、2024-02-29 小夜、2024-02-29 白班', '往回數班會正確跨月（閏年 2/29）')
    const ho = await api.nursingApi.addHandover({ ward: bed.ward, shift: nr.handoverShiftOf(nowStr()), admissionId: adm.id, content: '測試交班：明早空腹抽血' })
    const groups = await api.nursingApi.listHandovers(bed.ward)
    ok(groups[0] && groups.some((g) => g.items.some((h) => h.id === ho.id)) && groups.every((g, i) => i === 0 || `${groups[i - 1].date}${nr.SHIFT_ORDER.indexOf(groups[i - 1].shift)}` > `${g.date}${nr.SHIFT_ORDER.indexOf(g.shift)}`), `剛寫的交班出現在最近三班的清單，班次由新到舊（${groups.map(key).join('、')}）`)
  }
  const lastMar = marTomorrow.sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))[0]
  await expectError(() => api.nursingApi.executeMar(lastMar.id, 'given'), `提早給藥（預定 ${lastMar.scheduledAt}）`)
  await expectError(() => api.nursingApi.executeMar(lastMar.id, 'held', ''), '暫停給藥未寫原因')
  await api.nursingApi.executeMar(lastMar.id, 'held', '病人外出檢查')
  ok(dbm.db.mar.find((m) => m.id === lastMar.id).status === 'held', '暫停給藥可提前決定（須註明原因）')
  const statMar = dbm.db.mar.find((m) => m.orderId === statMed.id)
  await api.nursingApi.executeMar(statMar.id, 'given')
  ok(dbm.db.mar.find((m) => m.id === statMar.id).status === 'given' && dbm.db.ipdOrders.find((o) => o.id === statMed.id).status === 'done', '臨時給藥執行後，醫囑即完成')
  // U20：補登實際給藥時間——不晚於現在、不早於可給時間、最多往前 2 小時；登打時間一併記錄
  {
    const S = '2024-05-02 09:00'
    const N = '2024-05-02 09:40'
    ok(nr.checkGivenAt(S, '2024-05-02 09:00', N) === null && nr.checkGivenAt(S, '2024-05-02 08:00', N) === null, '補登 09:00、08:00（預定前 60 分鐘內）都可以')
    ok(nr.checkGivenAt(S, '2024-05-02 09:50', N)?.includes('晚於現在') && nr.checkGivenAt(S, '2024-05-02 07:59', N)?.includes('早於可給藥時間'), '補登不能晚於現在、不能早於可給藥時間（不能繞過太早給藥）')
    ok(nr.checkGivenAt('2024-05-02 06:00', '2024-05-02 06:00', '2024-05-02 08:01')?.includes('2 小時'), '補登最多往前 2 小時')
    await as('dr02')
    const stat2 = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'medication', drugId: 'M001', content: '', dose: 1, freq: 'STAT', route: 'PO' })
    await as('nurse01')
    const m2 = dbm.db.mar.find((m) => m.orderId === stat2.id)
    const { addMinutes } = await load('/src/utils/date.ts')
    const t0 = nowStr()
    await expectError(() => api.nursingApi.executeMar(m2.id, 'given', '', addMinutes(t0, 10)), '補登未來的給藥時間')
    const backAt = addMinutes(t0, -10)
    await api.nursingApi.executeMar(m2.id, 'given', '', backAt)
    const rec = dbm.db.mar.find((m) => m.id === m2.id)
    ok(rec.executedAt === backAt && rec.recordedAt && rec.recordedAt >= backAt && dbm.db.ipdOrders.find((o) => o.id === stat2.id).stopAt === backAt && dbm.db.auditLogs[0].detail.includes('補登'),
      `補登：實際給藥 ${backAt.slice(11)}、登打 ${rec.recordedAt?.slice(11)} 都記下，臨時醫囑完成時間用實際時間，稽核註明補登`)
    ok(dbm.db.mar.find((m) => m.id === statMar.id).recordedAt === undefined, '沒有補登的給藥不記 recordedAt（畫面不顯示「補登」）')
  }
  {
    const groups = await api.nursingApi.listNursingOrders(adm.id)
    const all = groups.flatMap((g) => g.orders)
    const by = (pred) => all.find(pred)
    const diets = groups.find((g) => g.category === 'diet')?.orders ?? []
    ok(groups[0]?.category === 'diet' && diets[0]?.content === '糖尿病飲食' && diets[0].status === 'active' && diets[0].change === 'new',
      '護理站醫囑：飲食排最前面，目前的「糖尿病飲食」標「新」')
    ok(by((o) => o.content === '普通飲食')?.change === 'stopped' && by((o) => o.id === dupOrder.id)?.change === 'stopped' && by((o) => o.id === statMed.id)?.change === 'done',
      `被取代的飲食、剛停止的醫囑標「已停」，執行完的臨時醫囑標「已完成」（24 小時內仍列出）［普通飲食 ${by((o) => o.content === '普通飲食')?.change}、重複醫囑 ${by((o) => o.id === dupOrder.id)?.change}、臨時給藥 ${by((o) => o.id === statMed.id)?.change}］`)
    ok(all.every((o) => o.status === 'active' || o.change) && groups.some((g) => g.category === 'medication'), '只列執行中與 24 小時內異動的醫囑；用藥也列出供參考')
    // U18：新醫囑／停止要護理師核對；沒核對就一直標著
    ok(nr.needsAck({ status: 'active' }) && !nr.needsAck({ status: 'active', ackAt: 'x' }) && nr.needsAck({ status: 'stopped', ackAt: 'x' }) && !nr.needsAck({ status: 'stopped', stopAckAt: 'x' }) && !nr.needsAck({ status: 'done' }),
      '待核對：新開未簽收、停止未確認；執行完成的不用')
    const seedUnacked = dbm.db.ipdOrders.filter((o) => o.admissionId !== adm.id && nr.needsAck(o))
    ok(seedUnacked.length === 0, `展示資料的醫囑都已核對（打開護理站不會每位都掛「新醫囑」）${seedUnacked.length ? '：' + seedUnacked.length + ' 筆未核對' : ''}`)
    const wardList = await api.nursingApi.listWardPatients(bed.ward)
    const me = wardList.find((p) => p.id === adm.id)
    const expected = dbm.db.ipdOrders.filter((o) => o.admissionId === adm.id && nr.needsAck(o)).length
    ok(me.unackedCount === expected && expected > 0 && all.filter((o) => o.needsAck).length === expected, `病人清單「新醫囑 ${me.unackedCount}」= 醫囑分頁的待核對筆數`)
    const shownIds = all.filter((o) => o.needsAck).map((o) => o.id)
    // 按下核對之前，醫師剛好又開了一筆：畫面上沒看到的那筆不能被一起簽掉
    await as('dr02')
    const lateOrder = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'long', category: 'nursing', content: '測試：剛開的護理醫囑' })
    await expectError(() => api.nursingApi.ackOrders(adm.id, shownIds), '醫師核對醫囑')
    await as('nurse01')
    const r = await api.nursingApi.ackOrders(adm.id, shownIds)
    const after = (await api.nursingApi.listWardPatients(bed.ward)).find((p) => p.id === adm.id)
    ok(r.count === expected && after.unackedCount === 1 && nr.needsAck(dbm.db.ipdOrders.find((o) => o.id === lateOrder.id)) && dbm.db.auditLogs[0].action === '核對醫囑',
      `核對 ${r.count} 項後只剩剛開、還沒顯示的那 1 筆待核對；寫入稽核`)
    await api.nursingApi.ackOrders(adm.id, [lateOrder.id])
    await expectError(() => api.nursingApi.ackOrders(adm.id, [lateOrder.id]), '重複核對')
    // 醫囑逐筆核對、有疑問退回醫師：疑問期間不能核對、執行暫停（緊急可寫原因強制）；醫師回覆確認或停止
    {
      const N = api.nursingApi
      const { addMinutes } = await load('/src/utils/date.ts')
      ok(!nr.openQuery({}) && nr.openQuery({ queries: [{ reason: 'a' }] })?.reason === 'a' && !nr.openQuery({ queries: [{ reason: 'a', replyAt: 'x' }] }) && nr.openQuery({ queries: [{ reason: 'a', replyAt: 'x' }, { reason: 'b' }] })?.reason === 'b',
        '待醫師回覆＝最後一筆疑問還沒回覆（可以多輪）')
      await as('dr02')
      const med = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'long', category: 'medication', drugId: 'M001', content: '', dose: 1, freq: 'QID', route: 'PO' })
      const other = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'long', category: 'nursing', content: '測試：翻身 Q2H' })
      const lab = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P003', content: '' })
      await as('nurse01')
      try {
        await N.queryOrder(med.id, '')
        ok(false, '疑問沒寫原因應被擋下')
      } catch (e) {
        ok(e.field === 'reason', `有疑問沒寫原因 → 「${e.message}」`)
      }
      await N.queryOrder(med.id, '頻率 QID 疑為 TID')
      await expectError(() => N.queryOrder(med.id, '再問一次'), '已有疑問還沒回覆又提')
      const v1 = (await N.listNursingOrders(adm.id)).flatMap((g) => g.orders)
      ok(v1.find((o) => o.id === med.id)?.pendingQuery?.reason === '頻率 QID 疑為 TID' && dbm.db.auditLogs[0].action === '醫囑疑問', '提出疑問：醫囑上標「待醫師回覆」、寫入稽核')
      await expectError(() => N.ackOrders(adm.id, [med.id]), '核對有疑問的醫囑（單筆）')
      const bulk = await N.ackOrders(adm.id, [med.id, other.id])
      ok(bulk.count === 1 && bulk.skipped === 1 && nr.needsAck(dbm.db.ipdOrders.find((o) => o.id === med.id)), '整批核對：有疑問的那筆跳過、其他照常核對（回報略過幾筆）')
      // 給藥暫停：排一筆現在該給的
      const mar = dbm.db.mar.find((m) => m.orderId === med.id && m.status === 'pending')
      mar.scheduledAt = addMinutes(nowStr(), -5)
      // 排程給藥要先由住院藥局調劑（這一劑改到現在＝今天，用補調劑）
      await as('ph01')
      await api.udApi.dispenseUd({ kind: 'extra', marIds: [mar.id] })
      await as('nurse01')
      const mv = (await api.ipdApi.listMar(adm.id, mar.scheduledAt.slice(0, 10))).find((m) => m.id === mar.id)
      ok(mv?.queried === '頻率 QID 疑為 TID', '給藥紀錄這一筆標「待醫師回覆」')
      try {
        await N.executeMar(mar.id, 'given')
        ok(false, '疑問期間給藥應被擋下')
      } catch (e) {
        ok(e.code === 'CONFLICT' && e.field === 'query', `疑問期間給藥 → 「${e.message}」`)
      }
      const forced = await N.executeMar(mar.id, 'given', '', undefined, { reason: '已電話請示醫師，口頭確認' })
      ok(forced.status === 'given' && forced.note.includes('疑問期間仍給藥：已電話請示醫師') && dbm.db.auditLogs[0].action === '疑問期間仍給藥', '緊急時寫原因強制給藥：記在給藥紀錄與稽核')
      // 醫師端：病人清單、首頁待辦、醫囑上都看得到
      await as('dr02')
      const myAdm = (await api.admissionApi.listAdmissions({ status: ['admitted'] })).find((a) => a.id === adm.id)
      const ov = (await api.ipdApi.listOrders(adm.id)).find((o) => o.id === med.id)
      // 首頁待辦算的是「我主治的病人」：用這位病人的主治醫師登入看
      const attending = dbm.db.users.find((u) => u.doctorId === dbm.db.admissions.find((x) => x.id === adm.id).doctorId)
      await as(attending.username)
      const dash = await api.dashboardApi.getDashboard()
      await as('dr02')
      ok(myAdm.openQueries === 1 && ov.pendingQuery?.byName && dash.orderQueries >= 1, `醫師看得到：病人清單「疑問 ${myAdm.openQueries}」、首頁待辦 ${dash.orderQueries}、醫囑上的疑問與提問人`)
      await as('nurse01')
      await expectError(() => api.ipdApi.replyOrderQuery(med.id, '護理師自己回'), '護理師回覆疑問')
      await as('dr02')
      try {
        await api.ipdApi.replyOrderQuery(med.id, '')
        ok(false, '回覆空白應被擋下')
      } catch (e) {
        ok(e.field === 'reply', `回覆空白 → 「${e.message}」`)
      }
      await api.ipdApi.replyOrderQuery(med.id, '頻率無誤，依疼痛控制需求 QID')
      await as('nurse01')
      const v2 = (await N.listNursingOrders(adm.id)).flatMap((g) => g.orders).find((o) => o.id === med.id)
      ok(!v2.pendingQuery && v2.lastReply?.reply.includes('頻率無誤') && v2.needsAck, '醫師確認無誤：疑問解除，護理師看到回覆、要再核對一次')
      ok((await N.ackOrders(adm.id, [med.id])).count === 1, '回覆後可以核對')
      // 臨時醫囑：疑問期間不能執行；醫師停止 → 疑問自動結案
      await N.queryOrder(lab.id, '病人今早已抽過血')
      await expectError(() => N.completeStatOrder(lab.id), '疑問期間執行臨時醫囑')
      await as('dr02')
      await api.ipdApi.stopOrder(lab.id)
      const labQ = dbm.db.ipdOrders.find((o) => o.id === lab.id).queries.at(-1)
      ok(labQ.resolution === 'stopped' && labQ.replyAt && dbm.db.auditLogs[0].detail.includes('回覆護理師疑問'), '醫師停止有疑問的醫囑：疑問自動結案（記為「已停止此醫囑」）')
      await as('nurse01')
      await N.ackOrders(adm.id, dbm.db.ipdOrders.filter((o) => o.admissionId === adm.id && nr.needsAck(o)).map((o) => o.id))
      const { readFileSync } = await import('node:fs')
      const pages = ['src/pages/nursing/components/OrdersPanel.vue', 'src/pages/nursing/components/MarPanel.vue', 'src/pages/ipd/IpdPage.vue'].map((p) => readFileSync(p, 'utf8')).join('\n')
      ok(!pages.includes('replyAt') && !pages.includes('queries'), '頁面不自己判斷「待回覆」：用服務層的 pendingQuery／queried（規則 openQuery 只有一份）')
    }
    // U17：本班待辦（全病房）
    {
      const r = (s) => `${s.start}~${s.end.slice(11)}`
      ok(r(nr.shiftRange('2024-05-02 10:30')) === '2024-05-02 08:00~16:00' && r(nr.shiftRange('2024-05-02 23:59')) === '2024-05-02 16:00~00:00' && r(nr.shiftRange('2024-05-02 00:15')) === '2024-05-02 00:00~08:00', '這一班的起訖：白班 08–16、小夜 16–24、大夜 00–08')
      await as('dr02')
      const statLab = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P003', content: '' })
      await as('nurse01')
      const tasks = await api.nursingApi.listWardTasks(bed.ward)
      const rank = { overdue: 0, due: 1, todo: 2, upcoming: 3 }
      ok(tasks.every((t, i) => i === 0 || rank[tasks[i - 1].urgency] <= rank[t.urgency]), `本班待辦依急迫程度排序：逾時 → 現在 → 待處理 → 稍後（${tasks.length} 項）`)
      ok(tasks.some((t) => t.kind === 'stat' && t.id === statLab.id) && tasks.some((t) => t.kind === 'ack' && t.admissionId === adm.id), '本班待辦包含剛開的臨時檢驗、待核對醫囑')
      const { end } = nr.shiftRange(nowStr())
      ok(tasks.filter((t) => t.kind === 'mar' && t.urgency === 'upcoming').every((t) => t.at < end), '還沒到時間的給藥只列到這一班結束')
      const wardNow = await api.nursingApi.listWardPatients(bed.ward)
      const mism = wardNow.filter((p) => tasks.filter((t) => t.admissionId === p.id && t.kind === 'mar' && t.urgency === 'overdue').length !== p.overdueCount || tasks.filter((t) => t.admissionId === p.id && t.kind === 'mar' && t.urgency === 'due').length !== p.dueCount)
      ok(mism.length === 0, `每位病人的逾時／可給筆數，與病人清單的徽章一致${mism.length ? '：' + mism.map((p) => p.patientName).join('、') : ''}`)
      // B8：「本班未量」的判斷，病人清單與本班待辦同一條（measuredThisShift）
      ok(nr.measuredThisShift('2024-05-02 08:00', '2024-05-02 10:30') && !nr.measuredThisShift('2024-05-02 07:59', '2024-05-02 10:30') && !nr.measuredThisShift('2024-05-01 20:00', '2024-05-02 01:00') && !nr.measuredThisShift(undefined, '2024-05-02 10:30'),
        '本班量過：白班 08:00 起算；昨天 20:00 的不算大夜量過；沒量過的不算')
      const vsMismatch = wardNow.filter((p) => p.measuredThisShift === tasks.some((t) => t.kind === 'vitals' && t.admissionId === p.id))
      ok(vsMismatch.length === 0, `病人清單的「本班未量」與本班待辦一致${vsMismatch.length ? '：' + vsMismatch.map((p) => p.patientName).join('、') : ''}`)
      const noVs = tasks.find((t) => t.kind === 'vitals')
      if (noVs) {
        await api.nursingApi.addVitals({ admissionId: noVs.admissionId, temp: 36.8, pulse: 80, resp: 16, sbp: 120, dbp: 75, spo2: 98 })
        ok(!(await api.nursingApi.listWardTasks(bed.ward)).some((t) => t.kind === 'vitals' && t.admissionId === noVs.admissionId), '本班量過生命徵象後，「尚未測量」就從待辦消失')
      }
      await api.nursingApi.ackOrders(adm.id, [statLab.id])
    }
    const noStop = dbm.db.ipdOrders.filter((o) => o.status !== 'active' && !o.stopAt)
    ok(noStop.length === 0, `已停止／已完成的醫囑都有停止時間 stopAt（含種子資料、臨時給藥）${noStop.length ? '：缺 ' + noStop.length + ' 筆' : ''}`)
  }
  await expectError(() => api.nursingApi.addVitals({ admissionId: adm.id, temp: 52 }), '體溫 52 度')
  await expectError(() => api.nursingApi.addVitals({ admissionId: adm.id, temp: 98.6 }), '體溫 98.6（華氏）')
  await api.nursingApi.addVitals({ admissionId: adm.id, temp: 37.8, pulse: 88, sbp: 128, dbp: 80 })
  const note = await api.nursingApi.addNursingNote({ admissionId: adm.id, focus: '體溫過高', data: '體溫 37.8°C', action: '冰枕使用', response: '' })
  await api.nursingApi.addNoteResponse(note.id, '一小時後 37.2°C')
  await expectError(() => api.nursingApi.addNoteResponse(note.id, '改寫'), '已有反應（R）再補記（紀錄只能增補不能改寫）')
  const ward = await api.nursingApi.listWardPatients(bed.ward)
  ok(ward.some((w) => w.id === adm.id && w.latestVitals?.temp === 37.8), `護理站 ${bed.ward} 看得到新病人與最新生命徵象`)

  await as('dr02')
  // U19：出院前先列出還沒做完的事；逾時沒給的藥標「暫停：出院時未給藥」保留，不刪
  {
    const { addMinutes } = await load('/src/utils/date.ts')
    const t0 = nowStr()
    const lab = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P003', content: '' })
    // 確保有一筆逾時、一筆未來的給藥排程（依執行時間，種子不一定剛好有）
    const pend = dbm.db.mar.filter((m) => m.admissionId === adm.id && m.status === 'pending')
    if (pend[0]) pend[0].scheduledAt = addMinutes(t0, -90)
    if (pend[1]) pend[1].scheduledAt = addMinutes(t0, 120)
    const overdueId = pend[0]?.id
    // 出院病摘由醫師撰寫；簽署＝准予出院。沒簽署，住院中心不能辦
    {
      const I = api.ipdApi
      const blank = { diagnosis: '', course: '', condition: '', followUp: '', dischargeType: '' }
      const full = { diagnosis: 'J18.9 肺炎', course: '抗生素治療後退燒', condition: '生命徵象穩定', followUp: '一週後門診', dischargeType: '改善出院' }
      try {
        await I.saveDischargeSummary(adm.id, { ...blank, diagnosis: 'J18.9' }, true)
        ok(false, '病摘空白簽署應被擋下')
      } catch (e) {
        ok(Object.keys(e.fields ?? {}).sort().join() === 'condition,course,dischargeType,followUp', '簽署時空白欄位一次標出（住院經過、出院時狀況、追蹤、轉歸）')
      }
      await I.saveDischargeSummary(adm.id, { ...blank, diagnosis: 'J18.9 肺炎', course: '寫到一半' }, false)
      const draft = dbm.db.admissions.find((a) => a.id === adm.id).dischargeSummary
      ok(draft?.course === '寫到一半' && !draft.signedAt, '可存草稿（不必填齊、未簽署）')
      await as('clerk01')
      try {
        await api.admissionApi.discharge(adm.id, { confirmUnfinished: true })
        ok(false, '醫師沒准予出院應被擋下')
      } catch (e) {
        ok(e.message.includes('醫師尚未准予出院') && dbm.db.admissions.find((a) => a.id === adm.id).status === 'admitted', `病摘只是草稿，住院中心辦出院 → 「${e.message}」`)
      }
      await expectError(() => I.saveDischargeSummary(adm.id, full, true), '掛號批價人員寫出院病摘')
      await as('nurse01')
      await expectError(() => I.saveDischargeSummary(adm.id, full, true), '護理師寫出院病摘')
      await as('dr02')
      await I.saveDischargeSummary(adm.id, full, true)
      ok((await api.admissionApi.getAdmission(adm.id)).dischargeReady && dbm.db.auditLogs[0].action === '准予出院', '醫師簽署＝准予出院（dischargeReady），寫入稽核')
      await expectError(() => I.saveDischargeSummary(adm.id, { ...full, course: '偷改' }, false), '已准予出院後直接改病摘')
      await expectError(() => api.admissionApi.discharge(adm.id, { confirmUnfinished: true }), '醫師自己辦出院手續（手續由住院中心、護理師辦）')
      try {
        await I.cancelDischargeOrder(adm.id, ' ')
        ok(false, '取消沒寫原因應被擋下')
      } catch (e) {
        ok(e.field === 'reason', '取消准予出院沒寫原因 → 標在「取消原因」')
      }
      await I.cancelDischargeOrder(adm.id, '再度發燒')
      const back = dbm.db.admissions.find((a) => a.id === adm.id).dischargeSummary
      ok(!back.signedAt && back.course === full.course && !(await api.admissionApi.getAdmission(adm.id)).dischargeReady, '取消准予出院：簽署取消、內容留著當草稿')
      await I.saveDischargeSummary(adm.id, { ...full, dischargeType: '治癒出院' }, true)
      await as('clerk01')
    }
    const chk = await api.admissionApi.dischargeCheck(adm.id)
    ok(chk.overdueMar.length >= 1 && chk.pendingStat.some((o) => o.content.includes('CBC')) && chk.laterMar >= 1, `出院前檢查：逾時未給藥 ${chk.overdueMar.length}、未執行臨時醫囑 ${chk.pendingStat.length}、之後的排程 ${chk.laterMar}`)
    try {
      await api.admissionApi.discharge(adm.id, {})
      ok(false, '有未執行項目卻沒確認，應被擋下')
    } catch (e) {
      ok(e.field === 'confirmUnfinished' && dbm.db.admissions.find((a) => a.id === adm.id).status === 'admitted', `有未執行項目、沒確認就出院 → 「${e.message}」`)
    }
    await api.admissionApi.discharge(adm.id, { confirmUnfinished: true })
    ok(dbm.db.admissions.find((a) => a.id === adm.id).dischargeType === '治癒出院', '出院轉歸取自醫師簽署的病摘（重新簽署改成治癒出院）')
    const kept = dbm.db.mar.find((m) => m.id === overdueId)
    ok(kept?.status === 'held' && kept.note === '出院時未給藥', '逾時沒給的藥保留在紀錄上，標為「暫停：出院時未給藥」（不刪除）')
    ok(dbm.db.ipdOrders.find((o) => o.id === lab.id).status === 'stopped' && !('confirmUnfinished' in dbm.db.admissions.find((a) => a.id === adm.id)) && dbm.db.auditLogs[0].detail.includes('未執行'), '未執行的臨時醫囑停止；確認旗標不寫進住院紀錄；稽核記下未執行數量')
  }
  ok(dbm.db.beds.find((b) => b.id === bed.id).status === 'cleaning', '出院 → 病床清潔中')
  ok(dbm.db.ipdOrders.filter((o) => o.admissionId === adm.id).every((o) => o.status !== 'active'), '出院 → 所有醫囑停止')
  ok(!dbm.db.mar.some((m) => m.admissionId === adm.id && m.status === 'pending'), '出院 → 還沒到時間的給藥排程清除')

  {
    // 種子：已出院的都有醫師簽署的病摘，簽署不晚於出院；有一位住院中的已准予出院（展示住院中心辦理）
    const dis = dbm.db.admissions.filter((a) => a.status === 'discharged')
    const bad = dis.filter((a) => !a.dischargeSummary?.signedAt || a.dischargeSummary.signedAt > a.dischargedAt || a.dischargeSummary.dischargeType !== a.dischargeType)
    ok(dis.length > 0 && bad.length === 0, `已出院 ${dis.length} 筆都有醫師簽署的病摘，簽署 ≤ 出院、轉歸一致`)
    const ready = (await api.admissionApi.listAdmissions({ status: ['admitted'] })).filter((a) => a.dischargeReady)
    ok(ready.length >= 1 && ready.every((a) => a.dischargeSummary.signedAt <= nowStr()), `住院中已准予出院 ${ready.length} 位（簽署時間不在未來）`)
  }

  {
    // 慢箋領藥的就醫：不屬於任何診次、藥與原處方相同、第幾次不超過可調劑次數
    const rv = dbm.db.visits.filter((v) => v.refillOf)
    const bad = rv.filter((v) => {
      const o = dbm.db.encounters.find((e) => e.id === v.refillOf)
      const e = dbm.db.encounters.find((x) => x.visitId === v.id)
      return v.sessionId !== '' || v.caseType !== '08' || !o || v.refillSeq > o.refillTimes || (v.status !== 'cancelled' && JSON.stringify(e?.medications) !== JSON.stringify(o.medications))
    })
    ok(bad.length === 0, `慢箋領藥 ${rv.length} 筆：不屬於診次、08 案件、藥同原處方、次數不超過`)
  }

  // 不變式：資料庫裡不可以有「未來發生的事」（排程類欄位除外）
  const nowS = (await load('/src/utils/date.ts')).now()
  const futureHits = []
  for (const [table, rows] of Object.entries(dbm.db)) {
    if (!Array.isArray(rows)) continue
    for (const r of rows) for (const [k, v] of Object.entries(r)) {
      if (k === 'scheduledAt' || typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) continue
      if (v > nowS) futureHits.push(`${table}.${k}=${v}`)
    }
  }
  ok(futureHits.length === 0, `所有資料的時間戳記都不晚於現在（違規 ${futureHits.length} 筆${futureHits.length ? '：' + futureHits.slice(0, 3).join('、') : ''}）`)
  {
    // 看過診的掛號一定叫過號，而且「掛號 ≤ 叫號 ≤ 完成看診」（種子資料曾經都沒有叫號時間，「目前看到幾號」算不出來）
    // 慢箋領藥不看診、不叫號，不算在內
    const seen = dbm.db.visits.filter((v) => !['registered', 'cancelled'].includes(v.status) && !v.refillOf)
    const badCall = seen.filter((v) => {
      const e = dbm.db.encounters.find((x) => x.visitId === v.id)
      return !v.calledAt || v.calledAt < v.createdAt || (e?.completedAt && v.calledAt > e.completedAt)
    })
    ok(seen.length > 0 && badCall.length === 0, `看過診的 ${seen.length} 筆掛號都有叫號時間，且在掛號與完成看診之間${badCall.length ? '：違規 ' + badCall.length + ' 筆，例 ' + badCall.slice(0, 2).map((v) => `${v.createdAt}/${v.calledAt}/${dbm.db.encounters.find((x) => x.visitId === v.id)?.completedAt}`).join('、') : ''}`)
  }

  console.log('\n[系統管理] 帳號、科別、醫師、稽核、匯出入')
  await as('admin')
  const A = api.adminApi
  // I3：科別代碼不重複、家醫科是 FM（以前誤為 IM）
  {
    const codes = dbm.db.departments.map((d) => d.code)
    ok(new Set(codes).size === codes.length && dbm.db.departments.find((d) => d.name === '家醫科')?.code === 'FM', `種子科別代碼不重複，家醫科為 FM（${codes.join('、')}）`)
  }
  const self = dbm.db.users.find((u) => u.username === 'admin')
  await expectError(() => A.saveUser({ id: self.id, username: 'admin', name: self.name, roles: ['admin'], active: false }), '停用自己的帳號')
  await expectError(() => A.saveUser({ id: self.id, username: 'admin', name: self.name, roles: ['clerk'], active: true }), '拿掉自己的管理員角色')
  await expectError(() => A.saveUser({ username: 'Bad Name', name: 'x', roles: ['clerk'], active: true, password: 'Welcome123' }), '帳號格式不符')
  await expectError(() => A.saveUser({ username: 'clerk01', name: 'x', roles: ['clerk'], active: true, password: 'Welcome123' }), '帳號重複')
  await expectError(() => A.saveUser({ username: 'dr99', name: 'x', roles: ['doctor'], doctorId: 'DR01', active: true, password: 'Welcome123' }), '同一位醫師建立第二個帳號')
  await expectError(() => A.saveUser({ username: 'clerk02', name: '新櫃台', roles: ['clerk'], active: true, password: '12' }), '新帳號密碼太短')
  const nu = await A.saveUser({ username: 'Clerk02', name: '新櫃台', roles: ['clerk'], active: true, password: 'Welcome123' })
  ok(nu.username === 'clerk02' && !('password' in nu), '新增帳號：帳號轉小寫、回傳不含密碼')
  const admin2 = await A.saveUser({ username: 'admin2', name: '副管理員', roles: ['admin'], active: true, password: 'Welcome123' })
  await A.saveUser({ id: admin2.id, username: 'admin2', name: '副管理員', roles: ['admin'], active: false })
  await as('admin')
  await A.saveUser({ id: nu.id, username: 'clerk02', name: '新櫃台', roles: ['clerk'], active: false })
  await expectError(() => api.authApi.login('clerk02', 'Welcome123'), '停用的帳號登入')
  await A.resetPassword(nu.id, 'Reset2026x')
  ok(!dbm.db.auditLogs.slice(0, 3).some((l) => l.detail.includes('Reset2026x')), '重設密碼：稽核紀錄不記錄密碼內容')

  const busyDept = dbm.db.departments.find((d) => dbm.db.doctors.some((x) => x.deptId === d.id && x.active))
  await expectError(() => A.saveDepartment({ ...busyDept, active: false }), `停用仍有在職醫師的 ${busyDept.name}`)
  await expectError(() => A.saveDepartment({ code: busyDept.code, name: '重複代碼科', active: true }), '科別代碼重複')
  const nd = await A.saveDepartment({ code: 'rhe', name: '風濕免疫科', active: true })
  ok(nd.code === 'RHE' && /^D\d+$/.test(nd.id), `新增科別 ${nd.id} ${nd.code}`)
  const busyDoc = (await A.listDoctors()).find((d) => d.impact.futureVisits > 0)
  await expectError(() => A.saveDoctor({ ...busyDoc, active: false }), `停用仍有掛號的 ${busyDoc.name}`)
  const ndoc = await A.saveDoctor({ name: '新醫師', deptId: nd.id, title: '', licenseNo: 'L-NEW-1', active: true })
  await expectError(() => A.saveDepartment({ ...nd, active: false }), '科別有新醫師時不可停用')
  await A.saveDoctor({ ...ndoc, active: false })
  await A.saveDepartment({ ...nd, active: false })
  ok(!dbm.db.departments.find((d) => d.id === nd.id).active, '醫師停用後，科別可以停用')
  await expectError(() => A.saveUser({ username: 'drnew', name: '新醫師', roles: ['doctor'], doctorId: ndoc.id, active: true, password: 'Welcome123' }), '為停用的醫師建立帳號')

  // 管理員可以檢視、可以做系統管理，但不能執行臨床操作
  await as('admin')
  const anyPatient = dbm.db.patients[0]
  const anyAdm = dbm.db.admissions.find((a) => a.status === 'admitted')
  const anyMar = dbm.db.mar.find((m) => m.status === 'pending')
  const anyDispense = dbm.db.dispenses.find((d) => d.status === 'pending')
  await expectError(() => api.ipdApi.addOrder({ admissionId: anyAdm.id, type: 'long', category: 'diet', content: '普通飲食' }), '管理員開立住院醫囑')
  await expectError(() => api.nursingApi.executeMar(anyMar.id, 'given'), '管理員執行給藥')
  if (anyDispense) await expectError(() => api.pharmacyApi.verifyDispense(anyDispense.id), '管理員核對處方')
  await expectError(() => api.inventoryApi.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId: 'M001', qty: 10, lotNo: 'X1', expiry: '2030-01-01' }), '管理員進貨')
  ok((await api.patientApi.searchPatients(anyPatient.name)).length > 0 && (await api.ipdApi.listOrders(anyAdm.id)).length > 0, '管理員仍可檢視病人與醫囑（唯讀）')
  ok((await A.listUsers()).length > 0, '管理員可以做系統管理（明確寫出 admin 的功能）')

  const logs = await A.listAuditLogs({ action: '新增帳號' })
  ok(logs.rows.length >= 2 && logs.actions.includes('登入'), `稽核紀錄可依動作篩選（新增帳號 ${logs.rows.length} 筆）`)
  ok(!('deleteAuditLog' in A) && !('saveAuditLog' in A), '稽核紀錄沒有修改或刪除的 API')

  const dump = await A.exportData()
  await expectError(() => A.importData('{not json'), '匯入非 JSON 檔')
  await expectError(() => A.importData(JSON.stringify({ ...JSON.parse(dump), schema: 1 })), '匯入舊版本資料')
  // I5：不完整的檔案先說怎麼辦，缺少的名稱最多列 5 個
  try {
    await A.importData(JSON.stringify({ schema: dbm.SCHEMA_VERSION, patients: [] }))
    ok(false, '匯入不完整的檔案應被擋下')
  } catch (e) {
    const listed = (e.message.split('缺少：')[1] ?? '').split('…')[0].split('、').length
    ok(e.message.startsWith('這不是完整的匯出檔') && listed <= 5 && /等 \d+ 項/.test(e.message), `匯入不完整的檔案 → 「${e.message.replace('\n', '／')}」`)
  }
  const partial = JSON.parse(dump)
  delete partial.mar
  await expectError(() => A.importData(JSON.stringify(partial)), '匯入只缺一項的檔案（不加「等 N 項」）')
  const noAdmin = JSON.parse(dump)
  noAdmin.users = noAdmin.users.filter((u) => !u.roles.includes('admin'))
  await expectError(() => A.importData(JSON.stringify(noAdmin)), '匯入沒有管理員的資料')
  const before = dbm.db.patients.length
  const modified = JSON.parse(dump)
  modified.patients = modified.patients.slice(0, 5)
  const r = await A.importData(JSON.stringify(modified))
  ok(dbm.db.patients.length === 5 && r.sessionKept, `匯入成功：病人 ${before} → 5 筆，登入狀態保留`)
  await A.importData(dump)
  ok(dbm.db.patients.length === before, '再匯入原本的匯出檔，資料還原')

  console.log('\n[排班] 每週範本、代診、停診')
  {
    const { addDays: addD } = await load('/src/utils/date.ts')
    const S = api.scheduleApi
    await as('admin')
    // 找一個未來、同科有其他醫師可代診的診次
    let target, impact
    for (let k = 1; k <= 14 && !target; k++) {
      for (const s of await S.listSessions({ date: addD(T, k) })) {
        const im = await S.getSessionImpact(s.id)
        if (!im.blocked && im.candidates.length) { target = s; impact = im; break }
      }
    }
    ok(!!target, `找到可代診的診次：${target?.date} ${target?.doctorName}（候選 ${impact?.candidates.map((c) => c.name).join('、')}）`)
    // 先替這個診次掛兩位病人
    await as('clerk01')
    for (const p of dbm.db.patients.slice(30, 32)) await api.bookingApi.register({ patientId: p.id, sessionId: target.id, identityCode: '01', caseType: '01' })
    await as('admin')
    const other = dbm.db.doctors.find((d) => d.active && d.deptId !== target.deptId)
    await expectError(() => S.substituteSession(target.id, other.id, '請假'), '跨科代診')
    await expectError(() => S.substituteSession(target.id, impact.candidates[0].id, ''), '代診未填原因')
    const sub = impact.candidates[0]
    const sv = await S.substituteSession(target.id, sub.id, '出國開會')
    const movedVisits = dbm.db.visits.filter((v) => v.sessionId === target.id && v.status !== 'cancelled')
    ok(sv.doctorId === sub.id && sv.originalDoctorName === target.doctorName && movedVisits.every((v) => v.doctorId === sub.id), `代診：${target.doctorName} → ${sub.name}，${movedVisits.length} 筆掛號一起轉移`)
    await as(dbm.db.users.find((u) => u.doctorId === sub.id).username)
    const q = await api.opdApi.listQueue({ date: target.date, doctorId: sub.id })
    ok(movedVisits.every((v) => q.some((x) => x.id === v.id)), '轉移的病人出現在代診醫師的候診清單')

    await as('admin')
    // 停診另一個有掛號的未來診次
    let susp
    for (let k = 1; k <= 14 && !susp; k++) susp = (await S.listSessions({ date: addD(T, k) })).find((s) => s.booked > 0 && s.id !== target.id && !s.suspended)
    if (!susp) {
      susp = (await S.listSessions({ date: addD(T, 2) }))[0]
      await as('clerk01')
      await api.bookingApi.register({ patientId: dbm.db.patients[33].id, sessionId: susp.id, identityCode: '01', caseType: '01' })
      await as('admin')
    }
    await expectError(() => S.suspendSession(susp.id, ''), '停診未填原因')
    const notice = await S.suspendSession(susp.id, '醫師病假')
    ok(notice.length > 0 && dbm.db.visits.filter((v) => v.sessionId === susp.id).every((v) => v.status === 'cancelled' && v.cancelReason === '停診：醫師病假'), `停診：${notice.length} 筆掛號退掛，並列入通知名單（含電話 ${notice[0].phone}）`)
    await expectError(() => S.suspendSession(susp.id, '再停一次'), '重複停診')
    await as('clerk01')
    await expectError(() => api.bookingApi.register({ patientId: dbm.db.patients[34].id, sessionId: susp.id, identityCode: '01', caseType: '01' }), '掛停診的診次')
    ok(!(await S.listSessions({ date: susp.date })).find((s) => s.id === susp.id).bookable, '停診的診次 bookable = false（掛號頁不能選）')
    await as('admin')
    const notices = await S.listSuspendNotices()
    await S.markNotified(notice[0].visitId)
    await expectError(() => S.markNotified(notice[0].visitId), '重複記錄通知')
    const marked = (await S.listSuspendNotices()).find((n) => n.visitId === notice[0].visitId)
    ok(notices.length >= notice.length && marked.notifiedAt && marked.notifiedByName === dbm.db.users.find((u) => u.username === 'admin').name, '停診通知名單：可逐一記錄已通知，並記下記錄者')
    // I4：按錯可以撤銷，撤銷寫入稽核紀錄
    // U6：通知名單開給櫃台（打電話是櫃台的工作）；停診、代診本身仍只限管理員；其他角色看不到
    await as('nurse01')
    await expectError(() => S.listSuspendNotices(), '護理師查看停診通知名單')
    await expectError(() => S.unmarkNotified(notice[0].visitId), '護理師撤銷停診通知')
    await as('clerk01')
    const clerkView = await S.listSuspendNotices()
    ok(clerkView.some((n) => n.visitId === notice[0].visitId), '櫃台可以查看停診通知名單')
    const dash = await api.dashboardApi.getDashboard()
    ok(dash.suspendNoticesPending === clerkView.filter((n) => !n.notifiedAt).length, `首頁「停診待通知」= 名單上未通知人數（${dash.suspendNoticesPending}）`)
    const otherSession = dbm.db.sessions.find((s) => s.date > T && !s.suspended)
    await expectError(() => S.suspendSession(otherSession.id, '櫃台測試'), '櫃台停診（仍只限管理員）')
    await as('admin')
    await S.unmarkNotified(notice[0].visitId)
    const undone = (await S.listSuspendNotices()).find((n) => n.visitId === notice[0].visitId)
    ok(!undone.notifiedAt && !undone.notifiedByName && dbm.db.auditLogs[0].action === '撤銷停診通知' && dbm.db.auditLogs[0].detail.includes('原記錄'), '撤銷停診通知：回到待通知，稽核紀錄留下原記錄時間與記錄者')
    {
      const pendingNow = (await S.listSuspendNotices()).filter((n) => !n.notifiedAt).length
      const d2 = await api.dashboardApi.getDashboard()
      ok(pendingNow >= 1 && d2.suspendNoticesPending === pendingNow, `撤銷後首頁「停診待通知」跟著變成 ${d2.suspendNoticesPending}`)
    }
    await expectError(() => S.unmarkNotified(notice[0].visitId), '撤銷尚未通知的病人')
    const normalVisit = dbm.db.visits.find((v) => !v.cancelReason?.startsWith('停診'))
    await expectError(() => S.unmarkNotified(normalVisit.id), '撤銷非停診退掛的掛號')
    await S.markNotified(notice[0].visitId)

    // 今天已開始看診的診次不能停
    const started = dbm.db.sessions.find((s) => s.date === T && dbm.db.visits.some((v) => v.sessionId === s.id && v.status === 'dispensed'))
    if (started) await expectError(() => S.suspendSession(started.id, '測試'), '停診已開始看診的診次')

    // 診間主檔（U30）：門診表只能選有的、啟用中的診間
    ok(dbm.db.rooms.length > 0 && dbm.db.weeklySlots.every((w) => dbm.db.rooms.some((x) => x.roomNo === w.roomNo && x.active)) && dbm.db.sessions.every((x) => dbm.db.rooms.some((y) => y.roomNo === x.roomNo)),
      `種子：${dbm.db.rooms.length} 間診間，每個門診表與診次的診間都在主檔裡`)
    ok(dbm.db.rooms.every((x) => x.location.startsWith(x.roomNo[0] + ' 樓')), '種子：診間位置的樓層 = 診間號第一碼（201 在 2 樓）')
    try {
      await S.saveRoom({ roomNo: '', location: '', active: true }, true)
      ok(false, '空白診間應被擋下')
    } catch (e) {
      ok(Object.keys(e.fields ?? {}).sort().join() === 'location,roomNo', '新增診間空白：診間號與位置一次標出')
    }
    await expectError(() => S.saveRoom({ roomNo: '2 01', location: 'x', active: true }, true), '診間號含空白')
    const nr = await S.saveRoom({ roomNo: 'n01', location: '1 樓 夜間門診區', active: true }, true)
    await S.saveRoom({ roomNo: 'Z99', location: '9 樓 測試', active: true }, true)
    ok(nr.roomNo === 'N01' && dbm.db.auditLogs[1].action === '新增診間', '新增診間：診間號轉大寫，寫入稽核')
    await expectError(() => S.saveRoom({ roomNo: 'N01', location: '重複', active: true }, true), '新增已存在的診間')
    await expectError(() => S.saveRoom({ roomNo: 'X77', location: '不存在', active: true }, false), '修改不存在的診間')
    const usedRoom = dbm.db.weeklySlots[0].roomNo
    try {
      await S.saveRoom({ ...dbm.db.rooms.find((x) => x.roomNo === usedRoom), active: false }, false)
      ok(false, '還有門診表在用的診間不能停用')
    } catch (e) {
      ok(e.field === 'active' && e.message.includes('請先改到其他診間'), `停用還有門診表在用的 ${usedRoom} 診 → 「${e.message.slice(0, 40)}…」`)
    }
    const anyDoc = dbm.db.doctors.find((d) => d.active)
    const freeAny = [0, 1, 2, 3, 4, 5, 6].find((wd) => !dbm.db.weeklySlots.some((x) => x.doctorId === anyDoc.id && x.weekday === wd && x.period === 'NIGHT'))
    try {
      await S.saveWeeklySlot({ doctorId: anyDoc.id, weekday: freeAny, period: 'NIGHT', roomNo: '2O1', limit: 20 })
      ok(false, '打錯的診間應被擋下')
    } catch (e) {
      ok(e.field === 'roomNo' && e.message.includes('沒有 2O1 診'), `門診表用不存在的診間（2O1，字母 O）→ 「${e.message}」`)
    }
    await S.saveRoom({ roomNo: 'Z99', location: '9 樓 測試', active: false }, false)
    try {
      await S.saveWeeklySlot({ doctorId: anyDoc.id, weekday: freeAny, period: 'NIGHT', roomNo: 'Z99', limit: 20 })
      ok(false, '停用的診間應被擋下')
    } catch (e) {
      ok(e.field === 'roomNo' && e.message.includes('已停用'), '門診表用已停用的診間 → 擋下')
    }
    await S.saveRoom({ roomNo: 'Z99', location: '9 樓 測試', active: true }, false)
    // 掛號單上的位置：診次的診間位置帶到掛號資料
    const someVisit = (await api.bookingApi.listVisits({ date: T })).find((v) => !v.refillOf)
    ok(someVisit.roomLocation === dbm.db.rooms.find((x) => x.roomNo === someVisit.roomNo).location, `掛號資料帶診間位置（${someVisit.roomNo} 診：${someVisit.roomLocation}）`)

    // 每週範本
    const slot0 = dbm.db.weeklySlots[0]
    await expectError(() => S.saveWeeklySlot({ doctorId: slot0.doctorId, weekday: slot0.weekday, period: slot0.period, roomNo: 'Z99', limit: 30 }), '同一醫師同一時段排兩個診')
    const otherDoc = dbm.db.doctors.find((d) => d.active && d.id !== slot0.doctorId && !dbm.db.weeklySlots.some((s) => s.doctorId === d.id && s.weekday === slot0.weekday && s.period === slot0.period))
    await expectError(() => S.saveWeeklySlot({ doctorId: otherDoc.id, weekday: slot0.weekday, period: slot0.period, roomNo: slot0.roomNo, limit: 30 }), '診間同一時段重複使用')
    const freeWd = [0, 1, 2, 3, 4, 5, 6].find((wd) => !dbm.db.weeklySlots.some((s) => s.doctorId === otherDoc.id && s.weekday === wd && s.period === 'NIGHT'))
    const r1 = await S.saveWeeklySlot({ doctorId: otherDoc.id, weekday: freeWd, period: 'NIGHT', roomNo: 'N01', limit: 20 })
    let day = T
    for (let k = 1; k <= 7; k++) if (new Date(addD(T, k)).getDay() === freeWd) day = addD(T, k)
    const gen = (await S.listSessions({ date: day })).find((s) => s.doctorId === otherDoc.id && s.period === 'NIGHT')
    ok(!!gen && gen.roomNo === 'N01', `新增每週範本 → ${day} 自動產生夜診診次`)
    await as('clerk01')
    await api.bookingApi.register({ patientId: dbm.db.patients[35].id, sessionId: gen.id, identityCode: '01', caseType: '01' })
    await as('admin')
    const del = await S.deleteWeeklySlot(r1.slot.id)
    ok(del.keptSessions === 1 && dbm.db.sessions.some((s) => s.id === gen.id), '刪除範本：已有掛號的未來診次保留（不讓掛號默默消失）')
  }

  console.log('\n[收費設定・主檔・讀取權限]')
  {
    await as('admin')
    const B = api.adminApi
    const M = api.masterApi
    const s0 = await B.getBillingSettings()
    const rc0 = await api.chargeApi.getReceipt(charge.id)
    await expectError(() => B.saveBillingSettings({ ...s0, drugCopayStep: 0 }), '藥品部分負擔級距設為 0')
    await expectError(() => B.saveBillingSettings({ ...s0, drugCopayMax: 10 }), '上限小於每級加收金額')
    const id01 = dbm.db.identities.find((i) => i.code === '01')
    const sv = await B.saveBillingSettings({ ...s0, basicCopay: 100 })
    await B.saveIdentity({ ...id01, regFee: 200 })
    const rc1 = await api.chargeApi.getReceipt(charge.id)
    ok(rc1.patientTotal === rc0.patientTotal && JSON.stringify(rc1.lines) === JSON.stringify(rc0.lines), `調高掛號費與部分負擔後，已開立的收據 ${charge.receiptNo} 金額不變（${rc1.patientTotal} 元）`)
    const pendingV = dbm.db.visits.find((v) => v.status === 'consulted' && v.identityCode === '01' && v.caseType !== 'A3')
    ok(sv.affectedPending === dbm.db.visits.filter((v) => v.status === 'consulted').length, `儲存時回報受影響的待批價 ${sv.affectedPending} 筆`)
    if (pendingV) {
      const p2 = await api.chargeApi.previewCharge(pendingV.id)
      ok(p2.lines.some((l) => l.kind === 'reg' && l.amount === 200) && p2.lines.some((l) => l.kind === 'copay-basic' && l.amount === 100), '尚未收費的批價以新參數計算（掛號費 200、基本部分負擔 100）')
    }
    const billing = await load('/src/services/billing.ts')
    ok(billing.drugCopay(100, s0) === 0 && billing.drugCopay(250, s0) === 40 && billing.drugCopay(5000, s0) === 200, '藥品部分負擔：100 元以下免收、250 → 40、上限 200')
    await B.saveBillingSettings(s0)
    await B.saveIdentity({ ...id01, regFee: 150 })

    // 主檔：停用前檢查、停用後不能開立、歷史照常顯示
    const usedDrugId = dbm.db.ipdOrders.find((o) => o.status === 'active' && o.drugId)?.drugId
    const usedDrug = dbm.db.drugs.find((d) => d.id === usedDrugId)
    await expectError(() => M.saveDrug({ ...usedDrug, active: false }), `停用住院醫囑使用中的 ${usedDrug.name}`)
    const freeDrug = dbm.db.drugs.find((d) => d.active && d.id !== 'M001' && !dbm.db.ipdOrders.some((o) => o.drugId === d.id && o.status === 'active'))
    await M.saveDrug({ ...freeDrug, active: false })

    // I1：同名藥要確認、價格必須大於 0
    {
      const base = { generic: '', nhiCode: '', spec: '', category: '口服', unit: 'TAB', doseUnit: '', nhiPrice: 2, selfPrice: 5, safetyStock: 50, defaultDose: 1, defaultFreq: 'TID', defaultRoute: 'PO', highAlert: false, indication: '測試用', warning: '測試用', timing: 'PC', nameZh: '測試藥', active: true }
      const m001 = dbm.db.drugs.find((d) => d.id === 'M001')
      await expectError(() => M.saveDrug({ ...base, name: '  acetaminophen   500MG ' }), '新增與 M001 同名的藥（大小寫、空白不同）未確認')
      await expectError(() => M.saveDrug({ ...base, name: freeDrug.name }), `新增與停用中的 ${freeDrug.id} 同名的藥未確認`)
      const dup = await M.saveDrug({ ...base, name: m001.name, allowSameName: true })
      ok(dup.id !== 'M001' && !('allowSameName' in dup), `確認後可新增同名藥 ${dup.id}（確認旗標不會存進主檔）`)
      await M.saveDrug({ ...m001, spec: '500 mg/tab（改規格）' })
      ok(true, 'M001 已有同名的 M041，改 M001 的規格（沒改藥名）不需確認')
      const other = dbm.db.drugs.find((d) => d.id === 'M002')
      await expectError(() => M.saveDrug({ ...other, name: m001.name }), '把 M002 改名成與 M001 同名未確認')
      await M.saveDrug({ ...other, safetyStock: other.safetyStock + 1 })
      ok(dbm.db.drugs.find((d) => d.id === 'M002').safetyStock === other.safetyStock + 1, '修改其他欄位、保留自己原本的藥名，不需確認')
      const spaced = await M.saveDrug({ ...base, name: '  Losartan   50mg  Tabs ' })
      ok(spaced.name === 'Losartan 50mg Tabs', `藥名去頭尾空白、連續空白存成一個，其他字元不變（「${spaced.name}」）`)
      await M.saveDrug({ ...spaced, active: false })
      await expectError(() => M.saveDrug({ ...base, name: '新藥 A', nhiPrice: 0 }), '健保價 0')
      await expectError(() => M.saveDrug({ ...base, name: '新藥 A', selfPrice: 0 }), '自費價 0')
      await expectError(() => M.saveDrug({ ...base, name: '新藥 A', nhiPrice: undefined }), '健保價空白')
      await M.saveDrug({ ...dup, active: false }) // 停用測試用的同名藥：沒改藥名，不需再確認
      ok(dbm.db.drugs.find((d) => d.id === dup.id).active === false, '已確認過的同名藥，之後停用不必再確認')
      await M.saveDrug({ ...dbm.db.drugs.find((d) => d.id === 'M001'), spec: m001.spec })
    }
    await expectError(() => M.saveProcedure({ ...dbm.db.procedures.find((p) => p.id === 'P001'), active: false }), '停用一般門診診察費')
    const xray = dbm.db.procedures.find((p) => p.id === 'P013')
    await M.saveProcedure({ ...xray, active: false })
    await M.saveIcd({ ...dbm.db.icdCodes.find((c) => c.code === 'J06.9'), active: false })
    await expectError(() => M.saveIcd({ code: 'J06.9', name: '重複', nameEn: '', isNew: true }), '新增重複的診斷碼')
    await expectError(() => M.saveIcd({ code: '123', name: '格式錯誤', nameEn: '', isNew: true }), '診斷碼格式錯誤')
    ok(!(await M.searchIcd('J06')).some((c) => c.code === 'J06.9') && !(await M.listDrugs()).some((d) => d.id === freeDrug.id), '停用的藥品、診斷碼不出現在開立時的搜尋')
    const ipdAdm = dbm.db.admissions.find((a) => a.status === 'admitted')
    await as(dbm.db.users.find((u) => u.doctorId === ipdAdm.doctorId).username)
    await expectError(() => api.ipdApi.addOrder({ admissionId: ipdAdm.id, type: 'long', category: 'medication', drugId: freeDrug.id, content: '', dose: 1, freq: 'QD', route: 'PO' }), `開立已停用的 ${freeDrug.name}`)
    await expectError(() => api.ipdApi.addOrder({ admissionId: ipdAdm.id, type: 'stat', category: 'procedure', procId: 'P013', content: '' }), '開立已停用的胸部 X 光')
    const hist = await api.opdApi.patientHistory(visit.patientId)
    ok(hist.some((h) => h.diagnoses?.some?.((d) => d.icd === 'J06.9') || JSON.stringify(h).includes('J06.9')), '停用的診斷碼在舊病歷上照常顯示')

    await as('admin')
    await M.savePreventItem({ ...dbm.db.preventItems.find((i) => i.code === 'ORAL'), active: false })
    ok(!(await api.preventApi.eligibilityFor(dbm.db.patients[0].id)).some((e) => e.itemCode === 'ORAL'), '停用的預防保健項目不再判斷資格')
    await expectError(() => M.savePreventItem({ ...dbm.db.preventItems.find((i) => i.code === 'COLON'), fields: [] }), '預防保健項目沒有登錄欄位')
    // 還原
    await M.saveDrug({ ...dbm.db.drugs.find((d) => d.id === freeDrug.id), active: true })
    await M.saveProcedure({ ...xray, active: true })
    await M.saveIcd({ ...dbm.db.icdCodes.find((c) => c.code === 'J06.9'), active: true })
    await M.savePreventItem({ ...dbm.db.preventItems.find((i) => i.code === 'ORAL'), active: true })

    // 讀取權限：未登入不能讀任何資料（登入頁的展示帳號清單除外）
    await api.authApi.logout()
    await expectError(() => api.patientApi.searchPatients('王'), '未登入查詢病人')
    await expectError(() => api.ipdApi.listOrders(ipdAdm.id), '未登入讀取醫囑')
    await expectError(() => api.inventoryApi.listInventory(), '未登入讀取庫存')
    ok((await api.authApi.demoAccounts()).length > 0, '登入頁的展示帳號清單仍可讀取（明確標示 public）')
    await as('admin')
  }

  console.log('\n[登入]')
  {
    const u = await api.authApi.login('  ADMIN ', '1234')
    ok(u.username === 'admin', '帳號打大寫、前後有空白也能登入')
    await expectError(() => api.authApi.login('', ''), '帳號密碼都沒填')
    await expectError(() => api.authApi.login('admin', 'wrong'), '密碼錯誤')
  }

  console.log('\n[病人資料範圍]')
  {
    await as('clerk01')
    const v = await load('/src/utils/validators.ts')
    const base = { gender: 'F', birthDate: '1990-01-01', phone: '', defaultIdentity: '01', allergies: [], familyHistory: [], smoking: false, betelNut: false, bloodType: '', address: '', emergencyContact: '', emergencyPhone: '' }
    await expectError(() => api.patientApi.createPatient({ ...base, name: '王'.repeat(31), idNo: v.makeIdNo('E', 'F', 8880001) }), '姓名 31 個字')
    await expectError(() => api.patientApi.createPatient({ ...base, name: '測試', birthDate: '1800-01-01', idNo: v.makeIdNo('E', 'F', 8880002) }), '出生日期 1800 年')
    const p = await api.patientApi.createPatient({ ...base, name: '  前後空白  ', idNo: v.makeIdNo('E', 'F', 8880003) })
    ok(p.name === '前後空白', '姓名前後的空白會被去掉再存')
  }

  console.log('\n[登入後導向]')
  {
    const { safeRedirect } = await load('/src/utils/redirect.ts')
    const cases = [
      ['/pharmacy', '/pharmacy', '站內路徑'],
      ['/patients?q=王', '/patients?q=王', '帶查詢參數的站內路徑'],
      [undefined, '/', '沒帶 redirect'],
      [['/a', '/b'], '/', '重複參數（陣列）'],
      ['', '/', '空字串'],
      ['https://evil.com', '/', '外部網址'],
      ['//evil.com', '/', '// 開頭（同協定外部網址）'],
      ['/\\evil.com', '/', '含反斜線'],
      ['/login', '/', '指回登入頁'],
      ['/login?redirect=/x', '/', '指回登入頁（帶參數）'],
    ]
    for (const [input, want, label] of cases) ok(safeRedirect(input) === want, `${label} → ${want}`)
  }

  console.log('\n[儲存失敗]')
  {
    // 模擬「可以儲存、但這次寫入失敗（空間已滿）」：操作必須失敗並回滾，不能顯示成功
    await as('clerk01')
    const savedMode = dbm.storageMode.value
    const savedLS = globalThis.localStorage
    // 瀏覽器丟的是 DOMException，原因在 name（不是 message）——模擬要和真實一致，否則判斷原因的程式測不到
    const failWith = (name) => ({ setItem() { throw new DOMException('模擬寫入失敗', name) }, getItem() { return null }, removeItem() {} })
    globalThis.localStorage = failWith('QuotaExceededError')
    dbm.storageMode.value = 'persistent'
    const target = dbm.db.patients[2]
    const before = target.phone
    await expectError(() => api.patientApi.updatePatient(target.id, { ...target, phone: '0900-000-000' }), '儲存空間已滿時修改病人資料')
    ok(dbm.db.patients.find((p) => p.id === target.id).phone === before, '存檔失敗時交易回滾，記憶體中的資料也沒有被改')
    // K1：原因要說對
    const msgFor = async (name) => {
      globalThis.localStorage = failWith(name)
      try { await api.patientApi.updatePatient(target.id, { ...target, phone: '0900-000-001' }) } catch (e) { return e.message }
    }
    ok(/空間已滿/.test(await msgFor('QuotaExceededError')), '空間已滿（QuotaExceededError）→ 提示「儲存空間已滿」')
    ok(/不允許/.test(await msgFor('SecurityError')) && !/空間已滿/.test(await msgFor('SecurityError')), '瀏覽器不允許（SecurityError）→ 提示「不允許儲存」，不會說成空間已滿')
    ok(dbm.classifyStorageError(new DOMException('', 'NS_ERROR_DOM_QUOTA_REACHED')) === 'full' && dbm.classifyStorageError({ name: 'X', code: 22 }) === 'full', '舊版 Firefox 的名稱、代碼 22 也判斷為空間已滿')
    globalThis.localStorage = savedLS
    dbm.storageMode.value = savedMode
  }

  console.log('\n[變更主治醫師]（第三輪 I2）')
  {
    // 找一位住院中、科內還有其他在職醫師的病人
    const adm = dbm.db.admissions.find((a) => a.status === 'admitted' && dbm.db.doctors.some((d) => d.active && d.deptId === a.deptId && d.id !== a.doctorId))
    ok(!!adm, '找得到可變更主治的住院病人（同科還有其他醫師）')
    const fromId = adm.doctorId
    const to = dbm.db.doctors.find((d) => d.active && d.deptId === adm.deptId && d.id !== fromId)
    const otherDept = dbm.db.doctors.find((d) => d.active && d.deptId !== adm.deptId)
    const ordersBefore = dbm.db.ipdOrders.filter((o) => o.admissionId === adm.id).map((o) => o.doctorId).join(',')
    const impactBefore = (await (async () => { await as('admin'); return api.adminApi.listDoctors() })()).find((d) => d.id === fromId).impact.admittedPatients
    await expectError(() => api.admissionApi.changeAttending(adm.id, to.id, '醫師離職'), '管理員變更主治醫師（不執行臨床操作）')
    await as('nurse01')
    const cands = await api.admissionApi.listAttendingCandidates(adm.id)
    ok(cands.length > 0 && cands.every((c) => c.id !== fromId && dbm.db.doctors.find((d) => d.id === c.id).deptId === adm.deptId), `可接手名單只有同科、不含目前主治（${cands.map((c) => c.name).join('、')}）`)
    try {
      await api.admissionApi.changeAttending(adm.id, '', '')
      ok(false, '空白送出應被擋下')
    } catch (e) {
      ok(Object.keys(e.fields ?? {}).length === 2, '沒選醫師、沒填原因：兩個欄位一次標出')
    }
    await expectError(() => api.admissionApi.changeAttending(adm.id, fromId, '測試'), '改成目前的主治醫師')
    await expectError(() => api.admissionApi.changeAttending(adm.id, otherDept.id, '測試'), '改成其他科的醫師')
    // B7：訊息不能指向不存在的功能——跨科要說去哪裡辦（轉科在「住院醫囑」申請），而且那個功能真的存在
    try {
      await api.admissionApi.changeAttending(adm.id, otherDept.id, '測試')
    } catch (e) {
      ok(e.message.includes('申請轉科') && typeof api.admissionApi.requestDeptTransfer === 'function', `跨科變更主治：訊息指向實際存在的轉科功能（「${e.message}」）`)
    }
    const r = await api.admissionApi.changeAttending(adm.id, to.id, '醫師休假')
    const saved = dbm.db.admissions.find((a) => a.id === adm.id)
    ok(r.doctorName === to.name && saved.doctorId === to.id, `主治醫師改為 ${to.name}`)
    ok(saved.attendingHistory?.length === 1 && saved.attendingHistory[0].from === fromId && saved.attendingHistory[0].reason === '醫師休假', '留下變更紀錄（從誰、改成誰、原因）')
    ok(dbm.db.ipdOrders.filter((o) => o.admissionId === adm.id).map((o) => o.doctorId).join(',') === ordersBefore, '已開立的醫囑仍記原開立醫師（沒有被改寫）')
    ok((await api.admissionApi.listAdmissions({ status: ['admitted'] })).some((a) => a.id === adm.id && a.doctorId === to.id), '住院醫囑頁的病人清單（依主治醫師）跟著改變')
    ok(dbm.db.auditLogs.some((l) => l.action === '變更主治醫師'), '寫入稽核紀錄')
    await as('admin')
    const impactAfter = (await api.adminApi.listDoctors()).find((d) => d.id === fromId).impact.admittedPatients
    ok(impactAfter === impactBefore - 1, `原主治醫師「停用前需處理」的住院病人數 ${impactBefore} → ${impactAfter}`)
    const msg = await (async () => { try { await api.adminApi.saveDoctor({ ...dbm.db.doctors.find((d) => d.id === fromId), active: false }) } catch (e) { return e.message } })()
    ok(impactAfter > 0 && !!msg?.includes('請住院中心「變更主治醫師」'), `停用醫師的提示指向住院中心（「${msg?.match(/\d+ 位住院[^；]*/)?.[0]}」）`)
  }

  console.log('\n[表單錯誤一次標出]（第三輪 G2、I7）')
  {
    // 空白或亂填送出：欄位層的錯誤要一次全部回報，不是改一個、送出、再冒出下一個
    const multi = async (fn, label) => {
      try {
        await fn()
        ok(false, `${label}（應該要被擋下，卻成功了）`)
      } catch (e) {
        const keys = Object.keys(e.fields ?? {})
        ok(e.name === 'ServiceError' && keys.length >= 2, `${label}：一次回報 ${keys.length} 個欄位（${keys.join('、')}）`)
      }
    }
    const A = api.adminApi
    const M = api.masterApi
    await as('admin')
    await multi(() => A.saveUser({ username: '', name: '', roles: [], password: '', active: true }), '新增帳號')
    await multi(() => A.saveDepartment({ code: '', name: '', active: true }), '新增科別')
    await multi(() => A.saveDoctor({ name: '', deptId: '', title: '', licenseNo: '', active: true }), '新增醫師')
    await multi(() => A.saveBillingSettings({ basicCopay: -1, drugCopayFreeUpTo: -1, drugCopayStep: 0, drugCopayPerStep: -1, drugCopayMax: -1 }), '收費設定')
    await multi(() => A.saveIdentity({ ...dbm.db.identities.find((i) => i.code === '01'), name: '', regFee: -1 }), '就醫身分')
    await multi(() => M.saveDrug({ name: '', generic: '', nhiCode: '', spec: '', category: '', unit: '', doseUnit: '', nhiPrice: undefined, selfPrice: undefined, safetyStock: -1, defaultDose: 0, defaultFreq: '', defaultRoute: '', highAlert: false, active: true }), '新增藥品')
    await multi(() => M.saveProcedure({ code: '', name: '', category: '', points: -1, selfPrice: -1, active: true }), '新增醫令')
    await multi(() => M.saveIcd({ code: '', name: '', nameEn: '', isNew: true }), '新增診斷碼')
    await multi(() => M.savePreventItem({ ...dbm.db.preventItems.find((i) => i.code === 'ORAL'), name: '', intervalYears: 99, fields: [] }), '預防保健項目')
    await multi(() => api.scheduleApi.saveWeeklySlot({ doctorId: '', weekday: 9, period: '', roomNo: '', limit: 0 }), '每週排班')
    const tomorrow = (await load('/src/utils/date.ts')).addDays(T, 1)
    const futureSession = (await api.scheduleApi.listSessions({ date: tomorrow })).find((s) => !s.suspended && s.booked === 0)
    if (futureSession) await multi(() => api.scheduleApi.substituteSession(futureSession.id, '', ''), '代診')
    else ok(false, '明天應有可代診的診次（測試前提）')
    // 欄位層通過後才檢查規則：格式錯（J06-9 的「-」）不會被當成合法 ICD
    await expectError(() => M.saveIcd({ code: 'J06-9', name: '測試', nameEn: '', isNew: true }), '診斷碼 J06-9（小數點寫成其他符號）')
    await as('ph01')
    await multi(() => api.inventoryApi.receiveStock({ drugId: 'M001', qty: 0, lotNo: '', expiry: '' }), '進貨')
    await as('clerk01')
    await multi(() => api.patientApi.createPatient({ name: '', gender: 'F', birthDate: '1800-01-01', idNo: 'X', phone: 'abc', defaultIdentity: '', allergies: [], familyHistory: [], smoking: false, betelNut: false, bloodType: '', address: '', emergencyContact: '', emergencyPhone: '' }), '初診建檔')
    await as('nurse01')
    const adm = dbm.db.admissions.find((a) => a.status === 'admitted')
    await multi(() => api.nursingApi.addVitals({ admissionId: adm.id, temp: 99, pulse: 999 }), '生命徵象')
    await multi(() => api.nursingApi.addNursingNote({ admissionId: adm.id, focus: '', data: '', action: '', response: '' }), '護理紀錄')
  }

  console.log('\n[首頁]')
  // U27：今日收入只給掛號批價與管理員；其他角色連資料都不送
  {
    const seen = {}
    for (const u of ['clerk01', 'admin', 'dr01', 'nurse01', 'ph01']) {
      await as(u)
      seen[u] = (await api.dashboardApi.getDashboard()).revenue !== undefined
    }
    ok(seen.clerk01 && seen.admin && !seen.dr01 && !seen.nurse01 && !seen.ph01, `首頁今日收入：掛號批價、管理員看得到；醫師、護理師、藥師拿不到（${JSON.stringify(seen)}）`)
    await as('clerk01')
  }
  const dash = await api.dashboardApi.getDashboard()
  console.log(`    今日掛號 ${dash.opd.total}、候診 ${dash.opd.waiting}、待批價 ${dash.opd.toCharge}、待領藥 ${dash.opd.toDispense}；收入 ${dash.revenue.patientTotal} 元；住院 ${dash.ipd.admitted} 人、空床 ${dash.ipd.emptyBeds}`)
  ok(dash.trend.length === 7, '近 7 日趨勢資料')
  {
    await as('ph01')
    const ph = (await api.pharmacyApi.listDispenses({ date: T })).filter((d) => d.status !== 'dispensed').length
    ok(dash.opd.toDispense === ph, `首頁「待領藥」${dash.opd.toDispense} = 藥局清單待調劑＋已核對（同一個 awaitingPickup）`)
  }

  const leak = await api.patientApi.getPatient(patient.id)
  leak.name = '被頁面改掉'
  ok(dbm.db.patients.find((p) => p.id === patient.id).name === patient.name, '頁面修改回傳物件不會影響資料庫（回傳的是複本）')

  // 同一位醫師同時兩位看診中：叫號時先擋下、確認後才能叫（病人去檢查時先看下一位是正常的，要防的是忘了按完成）
  console.log('\n[同時看診]')
  {
    const regsOf = (docId) => dbm.db.visits.filter((v) => v.date === T && v.doctorId === docId && v.status === 'registered' && !v.refillOf && v.checkedInAt)
    const docs = dbm.db.users.filter((u) => u.active && u.roles.includes('doctor') && u.doctorId && !dbm.db.visits.some((v) => v.date === T && v.doctorId === u.doctorId && v.status === 'in-consult'))
    const docA = docs.find((u) => regsOf(u.doctorId).length >= 3)
    const docB = docs.find((u) => u !== docA && regsOf(u.doctorId).length >= 1)
    ok(!!docA && !!docB, `今天有兩位醫師有候診病人（${docA?.username}、${docB?.username}）`)
    const [a, b, c] = regsOf(docA.doctorId)
    await as(docA.username)
    await api.opdApi.startConsult(a.id)
    try {
      await api.opdApi.startConsult(b.id)
      ok(false, '上一位還在看診中就叫下一位，應先擋下')
    } catch (e) {
      ok(e.code === 'CONFLICT' && e.field === 'parallel' && e.message.includes(`第 ${a.seqNo} 號`), `上一位沒完成就叫號 → 「${e.message}」`)
    }
    ok(dbm.db.visits.find((v) => v.id === b.id).status === 'registered', '被擋下時下一位還是候診（沒有被改到一半）')
    ok((await api.opdApi.startConsult(a.id)).visitId === a.id, '重新開啟同一位（自己就是看診中的那位）不算衝突')
    await as(docB.username)
    const bOther = regsOf(docB.doctorId)[0]
    await api.opdApi.startConsult(bOther.id)
    ok(dbm.db.visits.find((v) => v.id === bOther.id).status === 'in-consult', '別的醫師的看診中不算：另一位醫師照常叫號')
    await api.opdApi.skipPatient(bOther.id)
    await as(docA.username)
    await api.opdApi.startConsult(b.id, { allowParallel: true })
    const both = dbm.db.visits.filter((v) => [a.id, b.id].includes(v.id) && v.status === 'in-consult').length
    ok(both === 2 && dbm.db.auditLogs[0].action === '開始看診' && dbm.db.auditLogs[0].detail.includes('同時看診') && dbm.db.auditLogs[0].detail.includes(`第 ${a.seqNo} 號`),
      `確認後可以同時看診，稽核記下「${dbm.db.auditLogs[0].detail}」`)
    await api.opdApi.skipPatient(a.id)
    await api.opdApi.skipPatient(b.id)
    await api.opdApi.startConsult(c.id)
    ok(dbm.db.visits.find((v) => v.id === c.id).status === 'in-consult' && !dbm.db.auditLogs[0].detail.includes('同時看診'), '前面的人過號（或完成）後叫號，不再提醒')
    await api.opdApi.skipPatient(c.id)
  }

  // 報到：現場掛號同時報到、預約的到院才報到；「下一位」先叫已報到的；叫未報到的要確認
  console.log('\n[報到]')
  {
    // 不存 dbm.db：交易失敗會把整個資料庫換成快照，先前拿到的參照就不是現在的資料
    const { addDays } = await load('/src/utils/date.ts')
    const q = await load('/src/services/queue-rules.ts')
    const Q = (arr) => arr.map(([seqNo, inn, skipped]) => ({ id: `v${seqNo}`, seqNo, status: 'registered', checkedInAt: inn ? 'x' : undefined, skippedAt: skipped ? 'x' : undefined }))
    ok(q.nextInQueue(Q([[1, false], [2, true], [3, true]]))?.seqNo === 2, '預約 1 號還沒到：下一位是已報到的 2 號')
    ok(q.nextInQueue(Q([[1, false], [2, true, true]]))?.seqNo === 1, '沒有已報到的人時，先叫未報到的 1 號（叫號時再確認），過號的排最後')
    ok(q.nextInQueue(Q([[2, true, true], [3, true, true]]))?.seqNo === 2, '只剩過號的人時仍叫得到（這一診看得完）')

    // 種子：叫過號的都有報到時間，而且在掛號之後、叫號之前；今天下午家醫科有一位預約還沒到
    const called = dbm.db.visits.filter((v) => v.calledAt && !v.refillOf)
    const badOrder = called.filter((v) => !v.checkedInAt || v.checkedInAt < v.createdAt || v.checkedInAt > v.calledAt)
    ok(called.length > 0 && !badOrder.length, `種子：叫過號的 ${called.length} 筆都有報到時間，且 掛號 ≤ 報到 ≤ 叫號${badOrder.length ? '：' + badOrder.slice(0, 3).map((v) => v.id).join('、') : ''}`)
    ok(!dbm.db.visits.some((v) => v.checkedInAt && v.date > T), '種子：未來的預約都還沒報到')
    const noShow = dbm.db.visits.find((v) => v.date === T && v.status === 'registered' && !v.checkedInAt && v.createdAt < T && v.deptId === 'D01')
    ok(!!noShow, `種子：今天有預約未到的病人（${noShow ? `第 ${noShow.seqNo} 號` : '沒有'}）`)
    const noShowSession = noShow && (await api.scheduleApi.listSessions({ date: T })).find((x) => x.id === noShow.sessionId)
    ok(noShowSession?.notArrived >= 1, `診次卡顯示「未報到」人數（${noShowSession?.notArrived}）`)
    const future = (await api.scheduleApi.listSessions({ date: addDays(T, 3) })).filter((x) => x.booked > 0)
    ok(future.every((x) => x.notArrived === 0), '未來的診次不算「未報到」（本來就還沒到）')

    // 報到
    const B = api.bookingApi
    await as('dr01')
    await expectError(() => B.checkIn(noShow.id), '醫師按報到（權限：櫃台、護理）')
    await as('clerk01')
    const fut = dbm.db.visits.find((v) => v.date > T && v.status === 'registered')
    await expectError(() => B.checkIn(fut.id), '預約下週的掛號今天報到')
    const freeS = (await api.scheduleApi.listSessions({ date: addDays(T, 2) })).find((x) => x.bookable)
    const someone = dbm.db.patients.find((p) => !dbm.db.visits.some((v) => v.sessionId === freeS.id && v.patientId === p.id))
    try {
      await B.register({ patientId: someone.id, sessionId: freeS.id, identityCode: '01', caseType: '01', checkIn: true })
      ok(false, '掛後天的門診同時報到應被擋下')
    } catch (e) {
      ok(e.field === 'checkIn', `掛後天的門診勾「同時報到」→ 「${e.message}」`)
    }
    const doctorOf = dbm.db.users.find((u) => u.doctorId === noShow.doctorId)
    await as(doctorOf.username)
    try {
      await api.opdApi.startConsult(noShow.id)
      ok(false, '叫未報到的病人應先確認')
    } catch (e) {
      ok(e.code === 'CONFLICT' && e.field === 'checkIn' && dbm.db.visits.find((v) => v.id === noShow.id).status === 'registered', `叫未報到的病人 → 「${e.message}」，狀態不變`)
    }
    await as('clerk01')
    const r = await B.checkIn(noShow.id)
    ok(!!r.checkedInAt && dbm.db.auditLogs[0].action === '報到', `報到：記下時間 ${r.checkedInAt.slice(11)}、寫入稽核`)
    await expectError(() => B.checkIn(noShow.id), '重複報到')
    const refillV = dbm.db.visits.find((v) => v.refillOf && v.status === 'consulted')
    if (refillV) await expectError(() => B.checkIn(refillV.id), '慢箋領藥報到（不看診）')
    // 醫師確認後叫未報到的人：叫得到，稽核記下「未報到」
    const other = dbm.db.visits.find((v) => v.date === T && v.status === 'registered' && !v.checkedInAt && !v.refillOf)
    if (other) {
      await as(dbm.db.users.find((u) => u.doctorId === other.doctorId).username)
      await api.opdApi.startConsult(other.id, { allowNotCheckedIn: true, allowParallel: true })
      ok(dbm.db.visits.find((v) => v.id === other.id).status === 'in-consult' && dbm.db.auditLogs[0].detail.includes('未報到'), `確認後叫未報到的病人，稽核記下「${dbm.db.auditLogs[0].detail}」`)
      await api.opdApi.skipPatient(other.id)
    } else ok(true, '（今天沒有其他未報到的人可測確認叫號）')
    await as('clerk01')
    // 今天現場掛號同時報到；已報到的人當場改掛今天別的診，不必再報到
    const todayS = (await api.scheduleApi.listSessions({ date: T })).filter((x) => x.bookable)
    const walkIn = dbm.db.patients.find((p) => !dbm.db.visits.some((v) => v.date === T && v.patientId === p.id))
    const w = await B.register({ patientId: walkIn.id, sessionId: todayS[0].id, identityCode: '01', caseType: '01', checkIn: true })
    ok(!!w.checkedInAt && dbm.db.auditLogs[0].detail.includes('已報到'), '現場掛號勾「同時報到」：掛號即報到')
    const moved = await B.rescheduleVisit(w.id, { sessionId: todayS[1].id, identityCode: '01', caseType: '01' })
    ok(!!moved.checkedInAt, '已報到的人改掛今天別的診，仍是已報到')
    const later = await B.register({ patientId: walkIn.id, sessionId: freeS.id, identityCode: '01', caseType: '01' })
    ok(!later.checkedInAt, '預約後天的門診：還沒報到')
    await B.cancelVisit(later.id)
    await B.cancelVisit(moved.id)
    // 頁面只呈現：叫號順序在 nextInQueue，頁面不自己用報到時間排序
    const { readFileSync } = await import('node:fs')
    const page = readFileSync('src/pages/opd/OpdPage.vue', 'utf8')
    ok(!/checkedInAt[^\n]{0,40}(sort|find)\(/.test(page) && !/(sort|find)\([^\n]{0,60}checkedInAt/.test(page), '看診頁不自己依報到排「下一位」（規則在 nextInQueue）')
  }

  // 收費報表：日期區間、依日期小計、匯出 CSV
  console.log('\n[收費報表區間與匯出]')
  {
    const { addDays } = await load('/src/utils/date.ts')
    const C = api.chargeApi
    await as('clerk01')
    const from = addDays(T, -6)
    const r = await C.dailyReport(from, T)
    const days = []
    for (let d = from; d <= T; d = addDays(d, 1)) days.push(await C.dailyReport(d))
    const sum = (k) => days.reduce((a, x) => a + x[k], 0)
    ok(r.byDay.length === 7 && r.byDay.map((d) => d.date).join() === days.map((d) => d.date).join(), '7 天區間：依日期每天一列（沒收費的日子也列出）')
    ok(['count', 'patientTotal', 'newDebt', 'repaid', 'collected', 'nhiPoints', 'voidedCount'].every((k) => r[k] === sum(k)),
      `區間合計 = 各單日報表相加（收據 ${r.count} 張、實收 ${r.collected}）`)
    ok(r.byDay.every((d, i) => d.collected === days[i].collected && d.count === days[i].count), '依日期小計 = 該日的日結報表')
    ok(r.byDay.reduce((a, d) => a + d.collected, 0) === r.collected, '依日期小計加總 = 實收合計')
    ok(r.byCashier.reduce((a, c) => a + c.collected, 0) === r.collected && Object.values(r.byPayMethod).reduce((a, b) => a + b, 0) === r.collected, '區間的收費人員別、付款方式別加總也等於實收')
    ok(r.unpaid.length === days.reduce((a, x) => a + x.unpaid.length, 0), `未收款名單含期間內每一天（${r.unpaid.length} 位，帶就醫日）`)
    const single = await C.dailyReport(T)
    ok(single.date === T && single.to === T && single.byDay.length === 1, '只給一天：照舊是日結報表')
    for (const [a, b, msg] of [[T, addDays(T, -1), '結束日期早於起始日期'], [addDays(T, -31), T, '超過 31 天']]) {
      try {
        await C.dailyReport(a, b)
        ok(false, `${msg}應被擋下`)
      } catch (e) {
        ok(e.field === 'to', `${msg} → 「${e.message}」（標在結束日期）`)
      }
    }
    ok(!!(await C.dailyReport(addDays(T, -30), T)), '剛好 31 天可以查')

    const X = await load('/src/services/report-csv.ts')
    ok(X.csvCell('a,b') === '"a,b"' && X.csvCell('說"好"') === '"說""好"""' && X.csvCell('第一行\n第二行') === '"第一行\n第二行"', 'CSV 欄位：逗號、引號、換行要加引號（引號重複一次）')
    ok(X.csvCell('=1+1') === "'=1+1" && X.csvCell('@SUM(A1)') === "'@SUM(A1)" && X.csvCell('-5') === "'-5" && X.csvCell(-5) === '-5' && X.csvCell(undefined) === '', '公式開頭的文字加 \' 防 CSV 注入；數字照原樣')
    const csv = X.dailyReportCsv(r)
    const lines = csv.slice(1).split('\r\n')
    ok(csv.startsWith('\uFEFF') && csv.includes('\r\n'), 'CSV 開頭有 BOM（Excel 才不會亂碼）、換行用 CRLF')
    const detail = lines.filter((l) => l.startsWith('收費,') || l.startsWith('收回欠款,'))
    ok(detail.length === r.charges.length + r.repayments.length, `明細列數 = 收據 ${r.charges.length} ＋ 收回欠款 ${r.repayments.length}`)
    const validSum = detail.filter((l) => l.startsWith('收費,') && l.includes(',有效,')).reduce((a, l) => a + Number(l.split(',')[8]), 0)
    ok(validSum === r.patientTotal && lines.includes(`實收合計,${r.collected}`), `CSV 有效收據金額加總 = 應收合計 ${r.patientTotal}；合計列有實收 ${r.collected}`)
    ok(lines.filter((l) => /^\d{4}-\d{2}-\d{2},/.test(l)).length === 7, 'CSV 附依日期小計（區間才有）')
    ok(!X.dailyReportCsv(single).includes('日期,收據張數') && X.reportFileName(single) === `日結_${T}.csv` && X.reportFileName(r) === `收費報表_${from}_${T}.csv`, '單日不附日期小計；檔名區分日結與區間')
    const { readFileSync } = await import('node:fs')
    const page = readFileSync('src/pages/charge/components/DailyReport.vue', 'utf8')
    ok(page.includes('dailyReportCsv(') && !page.includes('\\uFEFF') && !/join\(',/.test(page), '報表頁不自己組 CSV（用 dailyReportCsv，與畫面同一份報表）')
  }

  // 片語（醫師個人、.簡碼 展開）與科室共用組套（同科醫師都能用、能改）
  console.log('\n[片語與科室組套]')
  {
    const R = await load('/src/services/phrase-rules.ts')
    const P = [{ code: 'htn', text: '高血壓控制良好。' }]
    const ex = (t, c = t.length) => R.expandPhrase(t, c, P)
    ok(ex('.htn')?.text === '高血壓控制良好。' && ex('.htn').cursor === 8, '「.htn」展開成片語，游標停在片語後面')
    ok(ex('病史：.HTN')?.text === '病史：高血壓控制良好。' && ex('血壓 .htn')?.text === '血壓 高血壓控制良好。', '前面是中文標點或空白也能展開；簡碼不分大小寫')
    const mid = R.expandPhrase('A .htn B', 6, P)
    ok(mid?.text === 'A 高血壓控制良好。 B' && mid.cursor === 10, '在文字中間展開，後面的字保留')
    ok(ex('3.5mg') === null && ex('abc.htn') === null && ex('.xyz') === null && ex('htn') === null, '「3.5mg」「abc.htn」不算片語；找不到的簡碼不動（醫師打的字不會消失）')
    ok(JSON.stringify(R.checkPhrase({ code: '', text: '' })) === JSON.stringify({ code: '請輸入簡碼', text: '請輸入片語內容' }) && R.checkPhrase({ code: 'a-b', text: 'x' }).code && R.checkPhrase({ code: 'abcdefghijk', text: 'x' }).code && !Object.keys(R.checkPhrase({ code: '.HTN', text: 'x' })).length,
      '簡碼與內容一次標出；只能英數、最多 10 碼；「.HTN」視為 htn')
    const PH = api.phraseApi
    await as('clerk01')
    await expectError(() => PH.listPhrases(), '櫃台查看片語')
    await as('nurse01')
    const nurseOwn = await PH.listPhrases()
    ok(nurseOwn.length >= 3 && nurseOwn.every((p) => p.userId === 'U201') && nurseOwn.some((p) => p.code === 'fall'), `護理師也有自己的片語（${nurseOwn.map((p) => '.' + p.code).join('、')}），看不到醫師的`)
    await as('dr01')
    const dr01 = dbm.db.users.find((u) => u.username === 'dr01').id
    const mine = await PH.listPhrases()
    ok(mine.length >= 3 && mine.every((p) => p.userId === dr01), `只看得到自己的片語（${mine.map((p) => '.' + p.code).join('、')}）`)
    try {
      await PH.savePhrase({ code: '', text: '' })
      ok(false, '空白片語應被擋下')
    } catch (e) {
      ok(e.fields?.code && e.fields?.text, '空白片語：簡碼、內容一次標出')
    }
    const np = await PH.savePhrase({ code: '.CC', text: '  咳嗽三天  ' })
    ok(np.code === 'cc' && np.text === '咳嗽三天' && dbm.db.auditLogs[0].action === '新增片語', '新增片語：簡碼存小寫、內容去頭尾空白、寫入稽核')
    try {
      await PH.savePhrase({ code: 'WNL', text: '重複' })
      ok(false, '重複簡碼應被擋下')
    } catch (e) {
      ok(e.field === 'code' && e.message.includes('.wnl'), `重複簡碼（不分大小寫）→ 「${e.message}」`)
    }
    const ed = await PH.savePhrase({ id: np.id, code: 'cc', text: '咳嗽一週' })
    ok(ed.id === np.id && (await PH.listPhrases()).filter((p) => p.code === 'cc').length === 1, '修改片語（同簡碼不算重複）')
    await as('dr02')
    ok(!(await PH.listPhrases()).some((p) => p.id === np.id), '別的醫師看不到我的片語')
    await expectError(() => PH.savePhrase({ id: np.id, code: 'cc', text: '改別人的' }), '修改別的醫師的片語')
    await expectError(() => PH.deletePhrase(np.id), '刪除別的醫師的片語')
    await as('dr01')
    await PH.deletePhrase(np.id)
    ok(!(await PH.listPhrases()).some((p) => p.id === np.id), '刪除自己的片語')
    {
      // 片語展開只有一份（usePhrases）：門診、住院病程與病摘、護理紀錄、交班都用它，頁面不自己呼叫 expandPhrase
      const { readFileSync } = await import('node:fs')
      const used = ['src/pages/opd/OpdPage.vue', 'src/pages/ipd/IpdPage.vue', 'src/pages/nursing/components/NursingNotesPanel.vue', 'src/pages/nursing/components/HandoverPanel.vue'].map((p) => [p, readFileSync(p, 'utf8')])
      ok(used.every(([, t]) => t.includes('usePhrases') && t.includes('phrase.onKey') && !t.includes('expandPhrase(')), '片語可用在門診 SOAP、住院病程與出院病摘、護理紀錄、交班，展開只有一份（usePhrases）')
    }

    // 科室組套：內科（陳映如 dr02、黃柏翰 dr03）共用「糖尿病追蹤」；家醫科 dr01 看不到
    const O = api.orderSetApi
    const deptSet = dbm.db.orderSets.find((x) => x.scope === 'dept' && x.name === '糖尿病追蹤')
    ok(!!deptSet && deptSet.deptId === 'D02', '種子：內科共用組套「糖尿病追蹤」')
    ok(!(await O.listOrderSets()).some((x) => x.id === deptSet.id), '家醫科醫師看不到內科的科室組套')
    await expectError(() => O.expandOrderSet(deptSet.id), '家醫科醫師套用內科組套')
    await as('dr03')
    const list3 = await O.listOrderSets()
    const seen = list3.find((x) => x.id === deptSet.id)
    ok(!!seen && seen.deptName === '內科' && seen.updatedByName === '陳映如', '同科的黃柏翰看得到陳映如建立的科室組套（標出最後修改人）')
    const firstDept = list3.findIndex((x) => x.scope === 'dept')
    ok(firstDept === -1 || list3.slice(firstDept).every((x) => x.scope === 'dept'), '選單：個人組套在前、科室組套在後')
    ok((await O.expandOrderSet(deptSet.id)).medications.length > 0, '同科醫師可以套用')
    const input = { name: '糖尿病追蹤', diagnoses: deptSet.diagnoses, medications: deptSet.medications.slice(0, 1), procedures: [], scope: 'dept' }
    try {
      await O.saveOrderSet(input)
      ok(false, '同名科室組套應先確認')
    } catch (e) {
      ok(e.code === 'CONFLICT' && e.field === 'name' && e.message.includes('內科科室組套') && e.message.includes('陳映如'), `存同名科室組套 → 「${e.message}」`)
    }
    const over = await O.saveOrderSet({ ...input, overwrite: true, plan: '黃醫師改過' })
    ok(over.id === deptSet.id && over.updatedBy === 'DR03' && dbm.db.auditLogs[0].detail.includes('內科科室組套'), '同科醫師確認後覆蓋科室組套：記下最後修改人、稽核標明科室組套')
    const own = await O.saveOrderSet({ ...input, scope: 'personal', name: '糖尿病追蹤' })
    ok(own.scope === 'personal' && own.id !== deptSet.id, '個人組套可以和科室組套同名（各自的範圍）')
    await as('dr02')
    const again = (await O.listOrderSets()).find((x) => x.id === deptSet.id)
    ok(again?.updatedByName === '黃柏翰' && again.plan === '黃醫師改過' && !(await O.listOrderSets()).some((x) => x.id === own.id), '陳映如看到黃柏翰改過的版本；看不到黃柏翰的個人組套')
    await as('dr03')
    await O.deleteOrderSet(own.id)
    await O.deleteOrderSet(deptSet.id)
    await as('dr02')
    ok(!(await O.listOrderSets()).some((x) => x.id === deptSet.id), '同科醫師刪除科室組套後，大家都看不到了')
    const { readFileSync } = await import('node:fs')
    const bar = readFileSync('src/pages/opd/components/OrderSetBar.vue', 'utf8')
    const opd = readFileSync('src/pages/opd/OpdPage.vue', 'utf8')
    ok(!/doctorId|deptId ===|deptId !==/.test(bar), '組套列不自己判斷誰能看、能改（服務層 canUse）')
    const usePh = readFileSync('src/composables/usePhrases.ts', 'utf8')
    ok(usePh.includes('expandPhrase(') && usePh.includes('isComposing') && opd.includes('usePhrases') && !/startsWith\('\.'\)/.test(opd), '片語用 expandPhrase 展開（usePhrases）、輸入法選字時不攔空白鍵')
    await as('clerk01')
  }

  // 藥價生效日：批價依「看診日」的價格；調價前看診、之後才批價的仍收舊價；已批價的收據不受影響
  console.log('\n[藥價生效日]')
  {
    const { addDays } = await load('/src/utils/date.ts')
    const R = await load('/src/services/drug-rules.ts')
    const base = { nhiPrice: 2, selfPrice: 5, priceChanges: [{ from: '2026-03-01', nhiPrice: 2.5, selfPrice: 6 }, { from: '2026-06-01', nhiPrice: 3, selfPrice: 7 }] }
    ok(R.drugPriceOn(base, '2026-02-28').nhiPrice === 2 && R.drugPriceOn(base, '2026-03-01').nhiPrice === 2.5 && R.drugPriceOn(base, '2026-05-31').selfPrice === 6 && R.drugPriceOn(base, '2026-12-31').nhiPrice === 3,
      '某天的價格：生效日當天起用新價，之前用前一個價格')
    ok(R.nextPriceChange(base, '2026-04-01')?.from === '2026-06-01' && !R.nextPriceChange(base, '2026-07-01'), '已排定、還沒生效的下一筆調價')
    const rep = R.applyPriceChange(base, { from: '2026-03-01', nhiPrice: 2.8, selfPrice: 6 })
    ok(rep.length === 2 && rep[0].nhiPrice === 2.8, '同一天再調價：取代那天的調價')
    const cancel = R.applyPriceChange(base, { from: '2026-06-01', nhiPrice: 2.5, selfPrice: 6 })
    ok(cancel.length === 1 && cancel[0].from === '2026-03-01', '把某天的價格改回生效前的價格＝取消那天的調價')
    ok(R.applyPriceChange({ nhiPrice: 2, selfPrice: 5 }, { from: '2026-01-01', nhiPrice: 2, selfPrice: 5 }).length === 0, '價格沒變（例如只改藥名）不會多一筆調價')
    ok(R.applyPriceChange(base, { from: '2026-04-01', nhiPrice: 2.6, selfPrice: 6 }).map((x) => x.from).join() === '2026-03-01,2026-04-01,2026-06-01', '補一筆中間的調價，之後已排定的保留、依日期排序')

    // 種子：Amlodipine 3 天前調價 3.6 → 3.2；之前看診的收據是舊價、之後的是新價
    const amlo = dbm.db.drugs.find((d) => d.id === 'M012')
    const amloLines = dbm.db.charges.filter((c) => !c.voided).flatMap((c) => {
      const v = dbm.db.visits.find((x) => x.id === c.visitId)
      return c.lines.filter((l) => l.kind === 'drug' && l.name === amlo.name).map((l) => ({ date: v.date, unit: l.unitPrice }))
    })
    const changeDay = amlo.priceChanges?.[0]?.from
    ok(!!changeDay && amloLines.length > 0 && amloLines.every((l) => l.unit === (l.date >= changeDay ? 3.2 : 3.6)),
      `種子：Amlodipine ${changeDay} 起 3.2，${amloLines.length} 筆收據都依看診日計價（舊價 ${amloLines.filter((l) => l.unit === 3.6).length} 筆）`)
    const metNext = (await api.masterApi.listDrugs({ includeInactive: true })).find((d) => d.id === 'M015')
    ok(metNext?.nextPrice?.nhiPrice === 2.2 && metNext.nhiPrice === 2, 'Metformin 已排定下個月調價：清單顯示今天的價格與下一筆調價')

    // 調價對「還沒批價」的影響：找今天看完診、還沒批價、有健保藥的人
    const C = api.chargeApi
    const target = dbm.db.visits.find((v) => v.date === T && v.status === 'consulted' && dbm.db.encounters.find((e) => e.visitId === v.id)?.medications.some((m) => !m.selfPay))
    ok(!!target, '今天有看完診、還沒批價、開了健保藥的病人')
    const enc = dbm.db.encounters.find((e) => e.visitId === target.id)
    const med = enc.medications.find((m) => !m.selfPay)
    const drug = dbm.db.drugs.find((d) => d.id === med.drugId)
    const before = (await C.getChargeDetail(target.id)).preview
    const paid = dbm.db.charges.find((c) => !c.voided && c.lines.some((l) => l.name === drug.name))
    const paidLines = paid && JSON.stringify(paid.lines)
    await as('admin')
    const M = api.masterApi
    const row = (await M.listDrugs({ includeInactive: true })).find((d) => d.id === drug.id)
    const now0 = row.nhiPrice
    try {
      await M.saveDrug({ ...row, nhiPrice: now0 + 1, priceFrom: addDays(T, -1) })
      ok(false, '回溯調價應被擋下')
    } catch (e) {
      ok(e.field === 'priceFrom', `生效日早於今天 → 「${e.message}」`)
    }
    await M.saveDrug({ ...row, nhiPrice: now0 + 1, priceFrom: addDays(T, 1) })
    const sched = (await M.listDrugs({ includeInactive: true })).find((d) => d.id === drug.id)
    ok(sched.nhiPrice === now0 && sched.nextPrice?.nhiPrice === now0 + 1 && dbm.db.auditLogs[0].detail.includes('藥價'), `排定明天調價：今天仍是 ${now0}、清單提示明天起 ${now0 + 1}；稽核記下調價`)
    await as('clerk01')
    ok((await C.getChargeDetail(target.id)).preview.patientTotal === before.patientTotal && (await C.getChargeDetail(target.id)).preview.nhiPoints === before.nhiPoints, '明天才生效：今天看診的批價不變')
    await as('admin')
    await M.saveDrug({ ...row, nhiPrice: now0 + 1 })
    await as('clerk01')
    const after = (await C.getChargeDetail(target.id)).preview
    const lineOf = (p) => p.lines.find((l) => l.kind === 'drug' && l.name === drug.name)
    ok(lineOf(after)?.unitPrice === now0 + 1 && after.nhiPoints > before.nhiPoints, `今天起生效（生效日空白＝今天）：今天看診的批價用新價 ${now0 + 1}`)
    // 同一位病人若是昨天看診、今天才來批價：收昨天的價格
    const keepDate = target.date
    dbm.db.visits.find((v) => v.id === target.id).date = addDays(T, -1)
    const yest = (await C.getChargeDetail(target.id)).preview
    dbm.db.visits.find((v) => v.id === target.id).date = keepDate
    ok(lineOf(yest)?.unitPrice === now0, `昨天看診、今天才批價：仍收看診那天的價格 ${now0}（依看診日）`)
    ok(!paid || JSON.stringify(dbm.db.charges.find((c) => c.id === paid.id).lines) === paidLines, '已批價的收據不受調價影響（明細是批價當時存下的）')
    // 還原：把今天的價格改回原價＝取消今天的調價
    await as('admin')
    await M.saveDrug({ ...row, nhiPrice: now0, priceFrom: addDays(T, 1) })
    await M.saveDrug({ ...row, nhiPrice: now0 })
    const restored = dbm.db.drugs.find((d) => d.id === drug.id)
    ok(R.drugPriceOn(restored, T).nhiPrice === now0 && !R.nextPriceChange(restored, T) && (restored.priceChanges ?? []).every((c) => c.from < T),
      '改回原價：今天與明天的調價都取消，不留多餘紀錄')
    const nd = await M.saveDrug({ name: '調價測試新藥 1mg', generic: '', nhiCode: '', spec: '', category: '外用', unit: 'TUB', doseUnit: '', nhiPrice: 9, selfPrice: 20, safetyStock: 0, defaultDose: 1, defaultFreq: 'QD', defaultRoute: 'EXT', highAlert: false, indication: '測試', warning: '測試', timing: 'ANY', nameZh: '測試', active: true, priceFrom: addDays(T, 5) })
    ok(nd.nhiPrice === 9 && !nd.priceChanges, '新增藥品：價格就是原價（生效日不適用）')
    await as('clerk01')
    const { readFileSync } = await import('node:fs')
    const billingSrc = readFileSync('src/services/billing.ts', 'utf8')
    ok(billingSrc.includes('drugPriceOn(d, visit.date)') && !/\bd\.(nhiPrice|selfPrice)\b/.test(billingSrc), '批價只用 drugPriceOn(藥, 看診日) 取價，不直接讀主檔價格')
  }

  // 開藥時的庫存提示用「可用量」（未過期批號），不是帳上總量；處方箋有效期只提醒、不擋
  console.log('\n[可用庫存與處方箋有效期]')
  {
    const { addDays } = await load('/src/utils/date.ts')
    const SR = await load('/src/services/stock-rules.ts')
    await as('dr01')
    const rows = await api.masterApi.listDrugs({ includeInactive: true })
    const bad = rows.filter((d) => d.usable !== SR.usableQty(dbm.db.drugLots.filter((l) => l.drugId === d.id), T))
    ok(rows.length > 0 && !bad.length, `藥品清單的可用量 = 未過期批號總和（和藥局發藥同一個 usableQty）${bad.length ? '：' + bad.map((d) => d.id).join('、') : ''}`)
    // 造一批過期品：帳上總量變多，可用量不變——開藥提示不能被它灌水
    const d0 = dbm.db.drugs.find((d) => d.id === 'M001')
    const before = rows.find((d) => d.id === 'M001')
    dbm.db.drugLots.push({ id: 'LOT-EXPIRED-TEST', drugId: 'M001', lotNo: 'EXP-T', expiry: addDays(T, -1), qty: 500, receivedAt: `${addDays(T, -400)} 09:00` })
    d0.stock += 500
    const after = (await api.masterApi.listDrugs({ keyword: 'Acetaminophen' })).find((d) => d.id === 'M001')
    ok(after.stock === before.stock + 500 && after.usable === before.usable, `過期 500 顆：帳上 ${after.stock}，可用仍是 ${after.usable}（開藥提示用可用量）`)
    dbm.db.drugLots = dbm.db.drugLots.filter((l) => l.id !== 'LOT-EXPIRED-TEST')
    dbm.db.drugs.find((d) => d.id === 'M001').stock -= 500
    const { readFileSync } = await import('node:fs')
    const med = readFileSync('src/pages/opd/components/MedicationEditor.vue', 'utf8')
    const ipdDlg = readFileSync('src/pages/ipd/components/OrderDialog.vue', 'utf8')
    ok(!/\.stock\b/.test(med) && !/\.stock\b/.test(ipdDlg) && med.includes('.usable'), '門診處方表、住院醫囑不用帳上總量（stock）判斷庫存')

    // 處方箋有效期：看診日起 3 日（含當天）
    const RX = await load('/src/services/rx-rules.ts')
    ok(RX.rxValidUntil('2026-11-10') === '2026-11-12' && !RX.rxExpired('2026-11-10', '2026-11-12 23:59') && RX.rxExpired('2026-11-10', '2026-11-13'), '11/10 開立：有效至 11/12，11/13 起逾期')
    ok(RX.rxValidUntil('2026-02-27') === '2026-03-01' && RX.rxValidUntil('2026-12-31') === '2027-01-02', '有效期跨月、跨年')
    await as('ph01')
    const P = api.pharmacyApi
    const pend = dbm.db.dispenses.find((d) => d.status === 'pending' && d.createdAt.startsWith(T))
    ok(!!pend, '今天有待調劑的單')
    const fresh = await P.getDispense(pend.id)
    ok(!fresh.rxExpired && fresh.rxValidUntil === addDays(fresh.date, 2), '今天開立的處方：未逾期')
    const enc = dbm.db.encounters.find((e) => e.id === pend.encounterId)
    const keepDate = enc.date
    enc.date = addDays(T, -5)
    const old = await P.getDispense(pend.id)
    ok(old.rxExpired && old.rxValidUntil === addDays(T, -3), `5 天前看診的處方：逾期（有效至 ${old.rxValidUntil}）`)
    const listed = (await P.listDispenses({ date: T })).find((x) => x.id === pend.id)
    ok(listed?.rxExpired === true, '藥局清單上標出逾期')
    await P.verifyDispense(pend.id)
    const p = dbm.db.patients.find((x) => x.id === pend.patientId)
    const done = await P.dispense(pend.id, { birthMMDD: p.birthDate.slice(5).replace('-', '') })
    ok(done.status === 'dispensed' && dbm.db.auditLogs[0].action === '發藥' && dbm.db.auditLogs[0].detail.includes('逾有效期'), `逾期處方不擋：照常發藥，稽核記下「${dbm.db.auditLogs[0].detail}」`)
    ok((await P.getDispense(pend.id)).rxExpired, '已發的單：依發藥那天判斷，紀錄上看得出是逾期後才發')
    dbm.db.encounters.find((e) => e.id === pend.encounterId).date = keepDate
    const page = readFileSync('src/pages/pharmacy/PharmacyPage.vue', 'utf8')
    ok(page.includes('x.rxExpired') && !/ageDays\(x\)\s*>=/.test(page), '藥局頁的逾期標示用服務層的 rxExpired，不自己寫天數門檻')
    await as('clerk01')
  }

  // 盤點單：建立 → 盲盤清點（期間照常發藥）→ 送出 → 另一人覆核過帳；退回、取消、架上找到的批號
  console.log('\n[盤點單]')
  {
    const R = await load('/src/services/stocktake-rules.ts')
    const INV = await load('/src/services/stock-ledger.ts')
    const S = api.stocktakeApi
    const sheetLike = { status: 'submitted', submittedBy: 'U302', lines: [{ countedBy: 'U301', counted: 5, systemQty: 7 }, { countedBy: 'U302', counted: 3, systemQty: 3 }] }
    ok(R.lineDiff({ counted: 5, systemQty: 7 }) === -2 && R.lineDiff({ counted: 4 }) === 4 && R.lineDiff({}) === undefined, '差異＝實點 − 清點那一刻的帳（架上找到的批號帳上為 0）')
    ok(R.reviewBlocker(sheetLike, 'U301') && R.reviewBlocker(sheetLike, 'U302') && !R.reviewBlocker(sheetLike, 'U001') && R.reviewBlocker({ ...sheetLike, status: 'counting' }, 'U001'), '覆核：清點過的人、送出的人都不能覆核；其他人可以；還沒送出不能覆核')

    await as('nurse01')
    await expectError(() => S.createStocktake({ scope: { kind: 'all' } }), '護理師建立盤點單')
    await as('ph01')
    try {
      await S.createStocktake({ scope: { kind: 'drugs', drugIds: [] } })
      ok(false, '指定藥品卻沒選應被擋下')
    } catch (e) {
      ok(e.field === 'drugIds', `指定藥品沒選 → 「${e.message}」`)
    }
    const opd = dbm.db.stockLocations.find((x) => x.dispensesOpd).id
    const lotsOf = (id) => dbm.db.drugLots.filter((l) => l.drugId === id && l.locationId === opd && l.qty > 0)
    const sheet = await S.createStocktake({ scope: { kind: 'drugs', drugIds: ['M001', 'M003'] } })
    ok(sheet.no.startsWith(`PD${T.replace(/-/g, '')}-`) && sheet.total === lotsOf('M001').length + lotsOf('M003').length && sheet.status === 'counting', `建立 ${sheet.no}：範圍內有庫存的批號各一列（${sheet.total} 批）`)
    ok(!sheet.revealed && sheet.lines.every((l) => !('systemQty' in l) && !('diff' in l)), '清點中：帳上數量與差異根本不出服務層（不只是畫面不顯示）')
    await expectError(() => S.createStocktake({ scope: { kind: 'drugs', drugIds: ['M001'] } }), '同一批號同時在兩張進行中的盤點單')

    // 盲盤：庫存頁、明細、補貨對話框都看不到 M001 的數量；不在範圍內的 M002 照常
    const rows = await api.inventoryApi.listInventory({})
    const r1 = rows.find((r) => r.id === 'M001')
    const r2 = rows.find((r) => r.id === 'M002')
    ok(r1.counting === sheet.no && r1.usable === 0 && r1.stock === 0 && r1.daysLeft === null && !r1.flags.length && !r2.counting && r2.usable > 0, '盲盤：庫存清單上 M001 顯示盤點中（數量、標籤都遮掉），範圍外的 M002 照常')
    const led = await api.inventoryApi.getDrugLedger('M001')
    ok(led.counting === sheet.no && led.txns.length === 0 && led.lots.every((l) => l.qty === 0) && led.lots.length > 0, '盲盤：藥品明細列批號效期、不列數量與異動（結存就是帳上數量）')
    const plan = await api.inventoryApi.getRestockPlan('M001')
    ok(plan.counting === sheet.no && plan.usable === 0 && plan.suggestion.qty === 0 && plan.suggestion.formula.includes('盤點中'), '盲盤：補貨對話框也不給可用量與建議量（建議量是用可用量算的）')
    const summary = await api.inventoryApi.inventorySummary()
    ok(typeof summary.low === 'number', '摘要卡片照常（盤點中的藥不計入缺貨／偏低）')

    // 清點：負數擋下（與頁面同一條規則）；重填會覆蓋
    const [a1, a2] = sheet.lines.filter((l) => l.drugId === 'M001')
    try {
      await S.countLine(sheet.id, a1.id, -1)
      ok(false, '負數應被擋下')
    } catch (e) {
      ok(e.field === 'counted', `清點負數 → 「${e.message}」`)
    }
    const lotA = dbm.db.drugLots.find((l) => l.id === a1.lotId)
    const qA = lotA.qty
    await S.countLine(sheet.id, a1.id, qA + 5)
    await S.countLine(sheet.id, a1.id, qA - 2) // 重填：實點比帳少 2
    // 清點之後才發藥 5（盤點期間照常發藥）：差異仍是 −2，不會變成 −7
    INV.postStock({ kind: 'out', type: 'dispense', drugId: 'M001', locationId: opd, qty: 5, lotId: lotA.id, ref: '測試：盤點期間發藥' }, 'U301')
    await expectError(() => S.submitStocktake(sheet.id), '還有批號沒填數量就送出')
    for (const l of sheet.lines.filter((x) => x.id !== a1.id)) await S.countLine(sheet.id, l.id, dbm.db.drugLots.find((x) => x.id === l.lotId).qty)
    const sub = await S.submitStocktake(sheet.id)
    const subA = sub.lines.find((l) => l.id === a1.id)
    ok(sub.status === 'submitted' && sub.revealed && subA.systemQty === qA && subA.diff === -2 && sub.diffCount === 1, `送出後才揭露：${a1.lotNo} 帳 ${qA}（清點那一刻）、實點 ${qA - 2}、差異 −2；盤點期間發出的 5 不算盤虧`)
    await expectError(() => S.countLine(sheet.id, a1.id, 1), '送出後再改數量')
    await expectError(() => S.postStocktake(sheet.id, { [a1.id]: 'x' }), '清點的人自己覆核')
    await as('ph02')
    try {
      await S.postStocktake(sheet.id, {})
      ok(false, '有差異沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === `reason-${a1.id}`, `有差異沒寫原因 → 「${e.message}」（標在那一列）`)
    }
    const done = await S.postStocktake(sheet.id, { [a1.id]: '破損 2 盒' })
    const txn = dbm.db.stockTxns.find((t) => t.id === done.lines.find((l) => l.id === a1.id).txnId)
    ok(done.status === 'posted' && done.reviewedByName === '林雅婷' && txn.type === 'adjust' && txn.qty === -2 && txn.ref === sheet.no && txn.reason.includes('破損'), '另一位藥師覆核過帳：一批一筆調整，單號、原因寫在異動上')
    ok(dbm.db.drugLots.find((l) => l.id === lotA.id).qty === qA - 2 - 5, `過帳後這一批＝實點 ${qA - 2} − 清點後發出 5（帳實一致）`)
    ok(!(await api.inventoryApi.listInventory({})).find((r) => r.id === 'M001').counting && dbm.db.auditLogs[0].action === '盤點過帳', '過帳後恢復顯示數量；稽核記下盤點過帳')
    ok(!a2 || !done.lines.find((l) => l.id === a2.id).txnId, '帳實相符的批號不產生調整')

    // 退回重盤、取消
    await as('ph01')
    const s2 = await S.createStocktake({ scope: { kind: 'category', category: '眼用' } })
    for (const l of s2.lines) await S.countLine(s2.id, l.id, 1)
    await S.submitStocktake(s2.id)
    await as('admin')
    await expectError(() => S.returnStocktake(s2.id, ''), '退回沒寫原因')
    const back = await S.returnStocktake(s2.id, '差異太大，請重點')
    ok(back.status === 'counting' && back.returns.length === 1 && !back.revealed && back.lines.every((l) => l.counted === 1), '管理員退回重盤：回到清點中、數量保留、又看不到帳上數量')
    await as('ph01')
    await expectError(() => S.cancelStocktake(s2.id, ''), '取消沒寫原因')
    const can = await S.cancelStocktake(s2.id, '改天再盤')
    const eyeDrug = s2.lines[0].drugId
    ok(can.status === 'cancelled' && !(await api.inventoryApi.listInventory({})).find((r) => r.id === eyeDrug).counting, '取消盤點：不調整，數量恢復顯示')

    // 架上找到、帳上沒有的批號：加一列，過帳時盤盈入庫
    const s3 = await S.createStocktake({ scope: { kind: 'drugs', drugIds: ['M002'] } })
    for (const l of s3.lines) await S.countLine(s3.id, l.id, dbm.db.drugLots.find((x) => x.id === l.lotId).qty)
    try {
      await S.addFoundLot(s3.id, { drugId: 'M003', lotNo: 'X', expiry: '2030-01-01', counted: 1 })
      ok(false, '範圍外的藥應被擋下')
    } catch (e) {
      ok(e.field === 'drugId', `加範圍外的藥 → 「${e.message}」`)
    }
    const s3b = await S.addFoundLot(s3.id, { drugId: 'M002', lotNo: 'found-1', expiry: '2029-05-31', counted: 12 })
    await expectError(() => S.addFoundLot(s3.id, { drugId: 'M002', lotNo: 'FOUND-1', expiry: '2029-05-31', counted: 1 }), '同一批號加兩次')
    await S.submitStocktake(s3.id)
    await as('admin')
    const fl = s3b.lines.at(-1)
    await S.postStocktake(s3.id, { [fl.id]: '進貨未登記' })
    const newLot = dbm.db.drugLots.find((l) => l.drugId === 'M002' && l.lotNo === 'FOUND-1' && l.locationId === opd)
    ok(newLot?.qty === 12 && newLot.expiry === '2029-05-31', '架上找到的批號：過帳時盤盈 12 入庫（新批號）')

    // 清點後這一批又被發光、帳上不夠扣盤虧：整張不過帳，請退回重盤
    await as('ph01')
    const s4 = await S.createStocktake({ scope: { kind: 'drugs', drugIds: ['M003'] } })
    const l4 = s4.lines[0]
    const lot4 = dbm.db.drugLots.find((l) => l.id === l4.lotId)
    for (const l of s4.lines) await S.countLine(s4.id, l.id, l.id === l4.id ? lot4.qty - 3 : dbm.db.drugLots.find((x) => x.id === l.lotId).qty)
    INV.postStock({ kind: 'out', type: 'dispense', drugId: 'M003', locationId: opd, qty: lot4.qty, lotId: lot4.id, ref: '測試：清點後發光' }, 'U301')
    await S.submitStocktake(s4.id)
    await as('admin')
    await expectError(() => S.postStocktake(s4.id, { [l4.id]: '破損' }), '清點後這一批已發光、不夠扣盤虧')
    ok(dbm.db.stocktakes.find((x) => x.id === s4.id).status === 'submitted', '過帳失敗整張不動（仍待覆核，可退回重盤）')
    await S.cancelStocktake(s4.id, '測試結束')

    // 藥局：盤點中的藥，調劑單上看不到庫存數字，但有貨照樣能核對（缺不缺用真的量判斷，不能拿遮掉的 0 擋人）
    await as('ph01')
    const medsOf2 = (d) => dbm.db.encounters.find((e) => e.id === d.encounterId).medications
    const pd = dbm.db.dispenses.find((d) => d.status === 'pending' && medsOf2(d).every((m) => dbm.db.drugLots.filter((l) => l.drugId === m.drugId && l.locationId === opd && l.expiry >= T).reduce((n, l) => n + l.qty, 0) >= m.qty))
    if (pd) {
      const dId = medsOf2(pd)[0].drugId
      const s5 = await S.createStocktake({ scope: { kind: 'drugs', drugIds: [dId] } })
      const item = (await api.pharmacyApi.getDispense(pd.id)).items.find((i) => i.drugId === dId)
      ok(item.counting === s5.no && item.stock === 0 && !item.shortage, '盲盤：調劑單上這種藥顯示盤點中（不給數字），不算缺藥')
      ok((await api.pharmacyApi.verifyDispense(pd.id)).status === 'verified', '盤點中照常核對（缺藥判斷用真的可用量）')
      await S.cancelStocktake(s5.id, '測試結束')
    } else ok(false, '找不到可核對的待調劑單來測盤點中調劑')
    ok(!('stocktake' in api.inventoryApi), '單批直接調整已移除：所有盤點都走盤點單（另一人覆核）')
    const { readFileSync, existsSync } = await import('node:fs')
    ok(!existsSync('src/pages/drugs/components/StocktakeDialog.vue') && !readFileSync('src/pages/drugs/components/DrugDetail.vue', 'utf8').includes('StocktakeDialog'), '藥品明細不再有「盤點」按鈕')
    const sheetVue = readFileSync('src/pages/drugs/components/StocktakeSheet.vue', 'utf8')
    ok(sheetVue.includes('checkStocktakeActual(') && !/countedBy\s*===|submittedBy\s*===/.test(sheetVue), '盤點畫面：數量規則與服務層同一條；誰能覆核看服務層的 reviewBlocked，不自己判斷')
    // 清點存檔要排隊：共用一個 useAction 時，上一列還在存、下一列的存檔會被「進行中」擋掉（數字留在格子裡、其實沒存）
    ok(!sheetVue.includes('useAction(stocktakeApi.countLine') && sheetVue.includes('queue = queue.then') && sheetVue.includes('await queue'), '清點存檔排隊送出，送出前等所有存檔完成（手快不會漏存）')
    ok(ledgerBroken(dbm.db).length === 0, '盤點過帳後各地點帳本仍對得起來')
    await as('clerk01')
  }

  // 調劑雙人核對（U24）：管理員可設定「核對與發藥須由不同藥師」；預設關閉（單人藥局要能發藥）
  console.log('\n[調劑雙人核對]')
  {
    const RX = await load('/src/services/rx-rules.ts')
    ok(RX.dispenseBlocker({ status: 'verified', verifiedBy: 'U301' }, 'U301', true) && !RX.dispenseBlocker({ status: 'verified', verifiedBy: 'U301' }, 'U302', true) && !RX.dispenseBlocker({ status: 'verified', verifiedBy: 'U301' }, 'U301', false),
      '雙人核對開啟：核對的人不能自己發藥、別人可以；關閉時同一人可以')
    const PH = api.pharmacyApi
    await as('ph01')
    ok((await PH.dispensePolicy()).twoPersonDispense === false, '預設關閉（只有一位藥師的診所照常能發藥）')
    await expectError(() => PH.saveDispensePolicy(true), '藥師改調劑政策')
    await as('admin')
    await PH.saveDispensePolicy(true)
    ok(dbm.db.auditLogs[0].detail.includes('調劑雙人核對 關 → 開'), '管理員開啟，稽核記下')
    await api.authApi.saveIdleLockMinutes(20)
    ok((await PH.dispensePolicy()).twoPersonDispense === true && dbm.db.securitySettings.idleLockMin === 20, '改閒置鎖定不會把雙人核對的設定蓋掉（同一個設定物件，要合併）')
    await as('ph01')
    // 用盤點單測試留下的「ph01 已核對」那張（今天能發得出來的待調劑單只有一張，前面已經核對過了）
    const pd = dbm.db.dispenses.find((d) => d.status === 'verified' && d.verifiedBy === 'U301')
    ok(!!pd, 'ph01 核對過、等發藥的單')
    const mine = await PH.getDispense(pd.id)
    ok(!!mine.dispenseBlocked, `核對的藥師打開調劑單就看到「${mine.dispenseBlocked}」（不必按了才被擋）`)
    const pt = dbm.db.patients.find((p) => p.id === pd.patientId)
    const check = { birthMMDD: pt.birthDate.slice(5).replace('-', '') }
    await expectError(() => PH.dispense(pd.id, check), '核對的藥師自己發藥（雙人核對開啟）')
    await as('ph02')
    ok(!(await PH.getDispense(pd.id)).dispenseBlocked, '另一位藥師打開：可以發藥')
    const done = await PH.dispense(pd.id, check)
    ok(done.status === 'dispensed' && done.dispensedBy === 'U302' && done.verifiedBy === 'U301', '第二位藥師發藥：核對 ph01、發藥 ph02 各自留下')
    await as('admin')
    await PH.saveDispensePolicy(false)
    await api.authApi.saveIdleLockMinutes(15)
    await as('clerk01')
  }


  // 採購單：藥師開單 → 管理員核准／退回 → 分批到貨（對品項入批號效期）→ 已到齊／短交結案；無單進貨要原因
  console.log('\n[採購單]')
  {
    const PR = await load('/src/services/purchase-rules.ts')
    const P = api.purchaseApi
    const { readFileSync } = await import('node:fs')
    ok(PR.remainingOf({ qty: 10, receivedQty: 4 }) === 6 && PR.remainingOf({ qty: 10, receivedQty: 12 }) === 0 && PR.purchaseTotal([{ qty: 3, unitCost: 1.5 }, { qty: 10, unitCost: 2.25 }]) === 27, '尚未到貨數量、採購金額（四捨五入到元）')
    // 帳本寫入不對外：以前 inventoryApi.postStock 不檢查登入就能改庫存
    ok(!Object.values(api).some((m) => m && typeof m === 'object' && 'postStock' in m) && !readFileSync('src/services/index.ts', 'utf8').includes('stock-ledger'), '帳本寫入（postStock）不經任何 Api 對外，只能透過有權限檢查的服務')

    // 無單進貨：要原因（和數量、批號、效期一次標出）；「其他」要說明；異動帳標「無單進貨」
    await as('ph01')
    try {
      await api.inventoryApi.receiveStock({ drugId: 'M001', qty: 0, lotNo: '', expiry: '', reason: '' })
      ok(false, '空白無單進貨應被擋下')
    } catch (e) {
      ok(['reason', 'qty', 'lotNo', 'expiry'].every((k) => e.fields?.[k]), `無單進貨空白送出：原因、數量、批號、效期一次標出（${Object.keys(e.fields ?? {}).join('、')}）`)
    }
    try {
      await api.inventoryApi.receiveStock({ drugId: 'M001', qty: 5, lotNo: 'NP-1', expiry: '2030-01-01', reason: '其他' })
      ok(false, '其他沒說明應被擋下')
    } catch (e) {
      ok(e.field === 'note', `原因選「其他」沒說明 → 「${e.message}」`)
    }
    const np = await api.inventoryApi.receiveStock({ drugId: 'M001', qty: 5, lotNo: 'NP-1', expiry: '2030-01-01', reason: '廠商贈品／樣品', note: '業務送樣' })
    ok(np.ref === '無單進貨：廠商贈品／樣品（業務送樣）', `無單進貨的異動標出原因（${np.ref}）`)

    // 種子：帳上每一筆採購進貨都對得到一張已到齊的採購單；另有待核准、已訂購各一張
    const recvTxns = dbm.db.stockTxns.filter((t) => t.type === 'receive' && !t.ref?.startsWith('無單進貨'))
    const orphan = recvTxns.filter((t) => !dbm.db.purchaseOrders.some((p) => p.no === t.ref && p.lines.some((l) => l.txnIds.includes(t.id))))
    ok(recvTxns.length > 0 && !orphan.length, `種子：${recvTxns.length} 筆進貨都對得到採購單（單號＝異動單號、品項記著這筆異動）`)
    const pend = dbm.db.purchaseOrders.find((p) => p.status === 'pending')
    const ord = dbm.db.purchaseOrders.find((p) => p.status === 'ordered')
    ok(!!pend?.lines.some((l) => l.restockId) && !!ord, '種子：一張待核准（由補貨申請帶入）、一張已訂購等到貨')

    // 需求清單：已列入採購單的補貨申請不再列出；低於安全庫存的藥有建議量
    await as('nurse01')
    await expectError(() => P.purchaseCandidates(), '護理師看採購需求')
    await as('ph01')
    const cand = await P.purchaseCandidates()
    ok(!cand.some((c) => c.restock?.id === pend.lines.find((l) => l.restockId).restockId) && cand.some((c) => c.reason === 'low' && c.suggestedQty > 0), '需求清單：已列入採購單的申請不重複列出；低於安全庫存的藥附建議量')

    // 開單驗證
    try {
      await P.savePurchaseDraft({ supplier: '', lines: [] })
      ok(false, '空白採購單應被擋下')
    } catch (e) {
      ok(e.fields?.supplier && e.fields?.lines, '空白採購單：供應商、品項一次標出')
    }
    try {
      await P.savePurchaseDraft({ supplier: 'X', lines: [{ drugId: 'M001', qty: 10, unitCost: 1 }, { drugId: 'M001', qty: 5, unitCost: 1 }, { drugId: 'M002', qty: 0, unitCost: 1 }] })
      ok(false, '重複品項應被擋下')
    } catch (e) {
      ok(e.fields?.['line-1']?.includes('重複') && e.fields?.['line-2']?.includes('正整數'), '同一種藥兩行、數量 0：標在那一行')
    }
    await expectError(() => P.savePurchaseDraft({ supplier: 'X', lines: [{ drugId: pend.lines.find((l) => l.restockId).drugId, qty: 1, unitCost: 1, restockId: pend.lines.find((l) => l.restockId).restockId }] }), '同一張補貨申請列入兩張採購單')

    // 開單 → 送出 → 核准（只有管理員）→ 分批到貨 → 到齊
    const draft = await P.savePurchaseDraft({ supplier: '測試藥商', expectedDate: T, lines: [{ drugId: 'M002', qty: 30, unitCost: 2.5 }, { drugId: 'M003', qty: 10, unitCost: 3 }] })
    ok(draft.status === 'draft' && draft.no.startsWith(`PO${T.replace(/-/g, '')}-`) && draft.total === 105, `開單 ${draft.no}：草稿、金額 105 元`)
    await P.submitPurchase(draft.id)
    await expectError(() => P.savePurchaseDraft({ id: draft.id, supplier: '改', lines: [{ drugId: 'M002', qty: 1, unitCost: 1 }] }), '送出後修改')
    await expectError(() => P.receivePurchase(draft.id, 'L1', { qty: 1, lotNo: 'A', expiry: '2030-01-01' }), '還沒核准就到貨入庫')
    await expectError(() => P.approvePurchase(draft.id), '藥師自己核准')
    await as('admin')
    const appr = await P.approvePurchase(draft.id)
    ok(appr.status === 'ordered' && appr.approvedByName === '系統管理員' && appr.locationId === dbm.db.stockLocations.find((l) => l.receivesPurchase).id, '管理員核准：已訂購，入庫地點＝採購入庫的地點')
    await as('ph01')
    try {
      await P.receivePurchase(draft.id, 'L1', { qty: 31, lotNo: 'PO-A', expiry: '2030-01-01' })
      ok(false, '超收應被擋下')
    } catch (e) {
      ok(e.field === 'qty' && e.message.includes('30'), `到貨超過訂購量 → 「${e.message}」`)
    }
    const r1 = await P.receivePurchase(draft.id, 'L1', { qty: 20, lotNo: 'po-a', expiry: '2030-01-01' })
    const t1 = dbm.db.stockTxns.at(-1)
    ok(r1.status === 'ordered' && r1.lines[0].receivedQty === 20 && r1.lines[0].remaining === 10 && t1.ref === draft.no && t1.lots[0].lotNo === 'PO-A', '分批到貨：入 20、尚欠 10，異動單號＝採購單號、批號轉大寫')
    await P.receivePurchase(draft.id, 'L1', { qty: 10, lotNo: 'PO-B', expiry: '2031-01-01' })
    const all = await P.receivePurchase(draft.id, 'L2', { qty: 10, lotNo: 'PO-C', expiry: '2030-06-30' })
    ok(all.status === 'received' && dbm.db.auditLogs[0].detail.includes('已到齊'), '全部到齊：自動「已到齊」')
    await expectError(() => P.receivePurchase(draft.id, 'L1', { qty: 1, lotNo: 'X', expiry: '2030-01-01' }), '已到齊再入庫')

    // 到貨沖銷補貨申請：核准待核准的那張、到貨後申請結案
    const reqLine = pend.lines.find((l) => l.restockId)
    await as('admin')
    await P.approvePurchase(pend.id)
    await as('ph01')
    await P.receivePurchase(pend.id, reqLine.id, { qty: reqLine.qty, lotNo: 'RS-PO', expiry: '2030-01-01' })
    ok(dbm.db.restockRequests.find((r) => r.id === reqLine.restockId).status === 'fulfilled', '採購到貨照常沖銷補貨申請（到齊就結案）')

    // 退回、短交結案、取消
    const d2 = await P.savePurchaseDraft({ supplier: '測試藥商', lines: [{ drugId: 'M004', qty: 5, unitCost: 9 }] })
    await P.submitPurchase(d2.id)
    await as('admin')
    await expectError(() => P.rejectPurchase(d2.id, ''), '退回沒寫原因')
    const rej = await P.rejectPurchase(d2.id, '數量太少，併下次')
    ok(rej.status === 'draft' && rej.rejections.length === 1, '管理員退回：回到草稿、記下原因')
    await as('ph01')
    await expectError(() => P.closePurchase(d2.id, '測試'), '草稿短交結案')
    const can = await P.cancelPurchase(d2.id, '不買了')
    ok(can.status === 'cancelled' && can.closeReason === '不買了', '草稿可以取消（寫原因）')
    const ordLine = ord.lines[0]
    await P.receivePurchase(ord.id, ordLine.id, { qty: 1, lotNo: 'SHORT-1', expiry: '2030-01-01' })
    await expectError(() => P.cancelPurchase(ord.id, '不要了'), '已有到貨還要取消')
    const closed = await P.closePurchase(ord.id, '廠商缺貨，剩餘不再出貨')
    ok(closed.status === 'closed' && closed.lines[0].receivedQty === 1, '已到一部分：短交結案（寫原因），已入庫的保留')
    const dash = await api.dashboardApi.getDashboard()
    ok(dash.purchasePending === dbm.db.purchaseOrders.filter((p) => p.status === 'pending').length && dash.purchaseOrdered === dbm.db.purchaseOrders.filter((p) => p.status === 'ordered').length, '首頁待辦：採購單待核准（管理員）、待到貨（藥師）')
    const view = readFileSync('src/pages/drugs/components/PurchaseOrderView.vue', 'utf8')
    ok(!/status\s*===\s*'ordered'\s*&&[^\n]*receivedQty\s*</.test(view) && view.includes('purchaseTotal('), '採購畫面：金額用共用的 purchaseTotal，到貨上限由服務層擋')
    // 入庫對話框「一掛上就是打開的」（採購單點某一行時 v-if 與打開同時成立）：重設表單的 watch 要 immediate，否則數量不會帶入
    ok(/watch\(\s*open,[\s\S]{0,800}\{ immediate: true \}/.test(readFileSync('src/components/ReceiveStockDialog.vue', 'utf8')), '入庫對話框打開就帶入尚未到貨數量（watch immediate）')
    ok(ledgerBroken(dbm.db).length === 0, '採購到貨後各地點帳本仍對得起來')
    await as('clerk01')
  }

  // 藥袋法定欄位（藥師法）：性別、作用或適應症、警語或副作用、藥局名稱地址、調劑者、調劑日期
  console.log('\n[藥袋法定欄位]')
  {
    const missing = dbm.db.drugs.filter((d) => !d.indication?.trim() || !d.warning?.trim())
    ok(missing.length === 0, `${dbm.db.drugs.length} 種藥都有作用與警語（缺 ${missing.map((d) => d.id).join('、') || 0}）`)
    await as('admin')
    try {
      await api.masterApi.saveDrug({ name: '測試新藥 10mg', generic: '', nhiCode: '', spec: '', category: '口服', unit: 'TAB', doseUnit: '', nhiPrice: 2, selfPrice: 5, safetyStock: 50, defaultDose: 1, defaultFreq: 'TID', defaultRoute: 'PO', highAlert: false, indication: ' ', warning: '', timing: 'PC', nameZh: '測試新藥', active: true })
      ok(false, '新增藥品沒填作用、警語應被擋下')
    } catch (e) {
      ok(e.fields?.indication && e.fields?.warning, `新增藥品沒填作用、警語 → 兩欄一次標出（${Object.values(e.fields ?? {}).join('；')}）`)
    }
    await as('ph01')
    const ph = dbm.db.users.find((u) => u.username === 'ph01')
    const verified = dbm.db.dispenses.find((d) => d.verifiedBy && d.verifiedAt)
    const vv = await api.pharmacyApi.getDispense(verified.id)
    ok(vv.pharmacistName === dbm.db.users.find((u) => u.id === verified.verifiedBy).name && vv.dispenseDate === verified.verifiedAt.slice(0, 10),
      `已核對的單：調劑藥師＝核對的人（${vv.pharmacistName}）、調劑日＝核對日`)
    const pend = dbm.db.dispenses.find((d) => d.status === 'pending')
    const pv = await api.pharmacyApi.getDispense(pend.id)
    ok(pv.pharmacistName === ph.name && pv.dispenseDate === T, `還沒核對就先印：調劑藥師＝目前登入的藥師（${pv.pharmacistName}）、調劑日＝今天`)
    const it = pv.items[0]
    const drug = dbm.db.drugs.find((d) => d.id === it.drugId)
    ok(it.indication === drug.indication && it.warning === drug.warning && ['M', 'F'].includes(pv.gender) && pv.age >= 0, `藥袋資料帶出 ${it.drugName}：作用「${it.indication}」、警語、病人性別年齡`)
    // 藥袋元件真的有印出這些欄位（避免服務層有給、畫面沒印）
    const { readFileSync } = await import('node:fs')
    const bag = readFileSync('src/pages/pharmacy/components/DrugBagLabels.vue', 'utf8')
    const need = ['it.indication', 'it.warning', 'd.gender', 'd.age', 'd.pharmacistName', 'd.dispenseDate', 'HOSPITAL.address', 'HOSPITAL.phone', 'HOSPITAL.name', 'it.qty', 'it.dose', 'it.drugName', 'd.patientName']
    const lack = need.filter((k) => !bag.includes(k))
    ok(lack.length === 0, `藥袋元件印出全部法定欄位（缺 ${lack.join('、') || 0}）`)
  }

  // 服用時機：藥品主檔欄位（以前藥袋一律印「飯後服用」）
  console.log('\n[服用時機]')
  {
    const dr = await load('/src/services/drug-rules.ts')
    const tt = dr.timingText
    ok(tt('AC', 'QD', 'PO') === '飯前 30 分鐘服用' && tt('EMPTY', 'QD', 'PO') === '早餐前 30–60 分鐘空腹服用' && tt('WITH', 'BID', 'PO') === '隨餐服用' && tt('PC', 'TID', 'PO') === '飯後服用' && tt('ANY', 'QD', 'PO') === '飯前飯後皆可',
      '五種時機的藥袋文字')
    ok(tt('AC', 'HS', 'PO') === '' && tt('PC', 'PRN', 'PO') === '' && tt('PC', 'STAT', 'PO') === '', '頻率已說明時機（睡前、需要時、立即）不再加註')
    ok(tt('PC', 'TID', 'EXT') === '' && tt('ANY', 'HS', 'SC') === '', '非口服不印')
    const byId = (id) => dbm.db.drugs.find((d) => d.id === id)
    const oral = dbm.db.drugs.filter((d) => d.category === '口服')
    ok(oral.every((d) => dr.DRUG_TIMINGS.includes(d.timing)) && dbm.db.drugs.filter((d) => d.category !== '口服').every((d) => d.timing === 'ANY'), `${oral.length} 種口服藥都有服用時機；非口服一律「皆可」`)
    ok(byId('M022').timing === 'AC' && byId('M027').timing === 'EMPTY' && byId('M015').timing === 'WITH' && byId('M002').timing === 'PC',
      'Omeprazole 飯前、Levothyroxine 空腹、Metformin 隨餐、Ibuprofen 飯後（以前全部印飯後）')
    await as('admin')
    try {
      await api.masterApi.saveDrug({ ...byId('M012'), timing: '' })
      ok(false, '口服藥沒選服用時機應被擋下')
    } catch (e) {
      ok(e.fields?.timing || e.field === 'timing', `口服藥沒選服用時機 → 「${e.fields?.timing ?? e.message}」`)
    }
    const gel = await api.masterApi.saveDrug({ ...byId('M032'), timing: 'AC' })
    ok(gel.timing === 'ANY', '外用藥存成「皆可」（傳入的飯前被忽略）')
    await as('ph01')
    const omeDisp = dbm.db.dispenses.find((d) => d.status !== 'dispensed' && dbm.db.encounters.find((e) => e.id === d.encounterId).medications.length)
    const v = await api.pharmacyApi.getDispense(omeDisp.id)
    ok(v.items.every((it) => it.timingText === tt(byId(it.drugId).timing, it.freq, it.route) && it.timingShort === tt(byId(it.drugId).timing, it.freq, it.route, true)),
      `調劑單帶出服用時機（${v.items.map((it) => `${it.drugName}：${it.timingShort || '不印'}`).join('、')}）`)
    const { readFileSync } = await import('node:fs')
    const bag = readFileSync('src/pages/pharmacy/components/DrugBagLabels.vue', 'utf8')
    ok(bag.includes('it.timingText') && !bag.includes("'飯後服用'"), '藥袋元件用服務層算好的時機，不再自己寫死「飯後服用」')
  }

  // 藥品中文名與搜尋：中文名、別名、作用都搜得到；開藥選單與藥品庫存同一個規則
  console.log('\n[藥品中文名]')
  {
    const dr = await load('/src/services/drug-rules.ts')
    const seedDrugs = dbm.db.drugs.filter((d) => /^M0[0-4]\d$/.test(d.id))
    ok(seedDrugs.every((d) => d.nameZh?.trim()), `${seedDrugs.length} 種藥都有中文名`)
    await as('ph01')
    const names = async (kw) => (await api.masterApi.listDrugs({ keyword: kw })).map((d) => d.id)
    const inv = async (kw) => (await api.inventoryApi.listInventory({ keyword: kw })).map((d) => d.id).sort()
    ok((await names('普拿疼')).includes('M001') && (await names('乙醯胺酚')).includes('M001'), '搜「普拿疼」（別名）、「乙醯胺酚」（中文名）都找到 Acetaminophen')
    const bp = await names('降血壓')
    ok(['M012', 'M013', 'M014'].every((id) => bp.includes(id)), `搜「降血壓」（作用）列出 ${bp.length} 種降血壓藥`)
    ok((await names('acetaminophen')).includes('M001') && (await names('AC00012100')).includes('M012'), '英文藥名（不分大小寫）、健保碼照樣搜得到')
    let same = true
    for (const kw of ['普拿疼', '降血壓', '胰島素', 'metformin', '點滴']) same &&= JSON.stringify((await names(kw)).sort()) === JSON.stringify(await inv(kw))
    ok(same, '開藥選單與藥品庫存頁的搜尋結果一致（同一個 matchesDrug）')
    ok(dr.matchesDrug({ id: 'X', name: 'A', nameZh: '甲', generic: '', nhiCode: '' }, '  ') && !dr.matchesDrug({ id: 'X', name: 'A', nameZh: '甲', generic: '', nhiCode: '' }, '乙'), '空白關鍵字＝全部；不相干的字不符合')
    await as('admin')
    const m1 = dbm.db.drugs.find((d) => d.id === 'M001')
    try {
      await api.masterApi.saveDrug({ ...m1, nameZh: ' ' })
      ok(false, '沒填中文名應被擋下')
    } catch (e) {
      ok(e.fields?.nameZh || e.field === 'nameZh', `主檔沒填中文名 → 「${e.fields?.nameZh ?? e.message}」`)
    }
    const saved = await api.masterApi.saveDrug({ ...m1, aliases: [' 普拿疼 ', '', '普拿疼', '止痛藥'] })
    ok(JSON.stringify(saved.aliases) === '["普拿疼","止痛藥"]', `別名去空白、去空項、去重複：${JSON.stringify(saved.aliases)}`)
    await api.masterApi.saveDrug({ ...m1 })
    await as('ph01')
    const pend = dbm.db.dispenses.find((d) => d.status !== 'dispensed')
    const v = await api.pharmacyApi.getDispense(pend.id)
    ok(v.items.every((it) => it.drugNameZh === dbm.db.drugs.find((d) => d.id === it.drugId).nameZh), `調劑單帶出中文名（${v.items.map((it) => it.drugNameZh).join('、')}）`)
    const { readFileSync } = await import('node:fs')
    ok(readFileSync('src/pages/pharmacy/components/DrugBagLabels.vue', 'utf8').includes('it.drugNameZh'), '藥袋印出中文名')
  }

  // 處方天數一次改完：可換算的重算；手動總量、無法換算的保留並標「請確認」；天數不合法一筆都不改
  console.log('\n[處方天數一次改完]')
  {
    const dr = await load('/src/services/dose-rules.ts')
    const drugOf = (id) => dbm.db.drugs.find((d) => d.id === id)
    const timesOf = (f) => dbm.db.frequencies.find((x) => x.code === f)?.timesPerDay ?? 1
    const rows = [
      { drugId: 'M001', dose: 1, freq: 'TID', days: 3, qty: 9 },
      { drugId: 'M012', dose: 1, freq: 'QD', days: 3, qty: 5, _manual: true },
      { drugId: 'M038', dose: 10, freq: 'HS', days: 3, qty: 1 },
      { drugId: 'M015', dose: 1, freq: 'BID', days: 7, qty: 14 },
    ]
    const before = JSON.stringify(rows)
    const res = dr.applyDaysToAll(rows, 7, drugOf, timesOf)
    const byId = (id) => res.rows.find((x) => x.drugId === id)
    ok(res.rows.every((x) => x.days === 7) && byId('M001').qty === 21 && !byId('M001')._qtyStale, '可換算的藥：天數改 7、總量重算為 21')
    ok(byId('M012').qty === 5 && byId('M012')._qtyStale && byId('M038').qty === 1 && byId('M038')._qtyStale, '總量手動填的、無法換算的（Insulin）：總量保留，標「請確認總量」')
    ok(JSON.stringify(res.stale.sort()) === '["M012","M038"]' && !byId('M015')._qtyStale && byId('M015').qty === 14, `本來就是 7 天的不動；需確認的是 ${res.stale.join('、')}`)
    ok(JSON.stringify(rows) === before, '不改動傳入的資料（回傳新的列）')
    const bad = dr.applyDaysToAll(rows, 31, drugOf, timesOf)
    ok(bad.error && JSON.stringify(rows) === before, `天數 31 → 「${bad.error}」，一筆都不改`)
    ok(dr.applyDaysToAll(rows, 0, drugOf, timesOf).error && dr.applyDaysToAll(rows, 2.5, drugOf, timesOf).error, '天數 0、小數也擋（和單筆同一個 checkDays）')
    ok(JSON.stringify(dr.distinctDays(rows)) === '[3,7]' && dr.distinctDays(res.rows).length === 1, '天數不一致提示：3、7 天；套用後一致')
    const { readFileSync } = await import('node:fs')
    const ed = readFileSync('src/pages/opd/components/MedicationEditor.vue', 'utf8')
    const opd = readFileSync('src/pages/opd/OpdPage.vue', 'utf8')
    ok(ed.includes('applyDaysToAll(') && opd.includes('_qtyStale: _s'), '處方表用 applyDaysToAll；送出前移除畫面用的旗標')
  }

  // 同前次：帶診斷、藥品、處置、A、P；S、O、生命徵象不帶；停用的濾掉（和組套同一個 pickUsable）；慢箋調劑改帶原處方
  console.log('\n[同前次]')
  {
    const db = dbm.db
    const isRefill = (e) => !!db.visits.find((v) => v.id === e.visitId)?.refillOf
    const e0 = db.encounters.find((e) => e.status === 'completed' && !isRefill(e) && e.medications.length >= 2)
    const saved = JSON.stringify(e0)
    const proc = db.procedures.find((p) => p.active && p.id !== 'P001')
    Object.assign(e0, { subjective: '咳嗽三天', objective: '咽喉紅', assessment: '上呼吸道感染', plan: '多喝水，三天後回診', vitals: { temp: 38.2 }, procedures: [{ procId: proc.id, qty: 1, selfPay: false }] })
    const off = db.drugs.find((d) => d.id === e0.medications[0].drugId)
    off.active = false
    await as('nurse01')
    await expectError(() => api.opdApi.expandEncounter(e0.id, e0.patientId), '護理師展開前次病歷（權限）')
    await as('dr01')
    const x = await api.opdApi.expandEncounter(e0.id, e0.patientId)
    ok(x.diagnoses.length === e0.diagnoses.length && x.procedures.length === 1 && x.procedures[0].procId === proc.id, `帶入診斷 ${x.diagnoses.length} 個、處置 ${proc.name}`)
    ok(x.medications.length === e0.medications.length - 1 && !x.medications.some((m) => m.drugId === off.id) && x.skipped.includes(off.name), `停用的 ${off.name} 濾掉並列出（未帶入：${x.skipped.join('、')}）`)
    ok(x.assessment === '上呼吸道感染' && x.plan === '多喝水，三天後回診', '帶入 A 評估、P 計畫')
    ok(!('subjective' in x) && !('objective' in x) && !('vitals' in x), 'S 主訴、O 客觀、生命徵象不帶（本次的事實不能沿用上次的）')
    x.medications[0].dose = 99
    ok(e0.medications.every((m) => m.dose !== 99), '回傳的是複本，改它不會改到舊病歷')
    const other = db.patients.find((p) => p.id !== e0.patientId)
    await expectError(() => api.opdApi.expandEncounter(e0.id, other.id), '把別的病人的病歷帶進本次')
    off.active = true
    Object.assign(e0, JSON.parse(saved))
    // 慢箋調劑那筆不是看診（沒有評估、計畫）：改帶原處方那次
    let rv = db.visits.find((v) => v.refillOf && db.encounters.some((e) => e.visitId === v.id))
    ok(!!rv, `種子有慢箋調劑紀錄可測（${rv ? rv.date : '沒有'}）`)
    if (rv) {
      const re = db.encounters.find((e) => e.visitId === rv.id)
      const orig = db.encounters.find((e) => e.id === rv.refillOf)
      const keepA = orig.assessment
      orig.assessment = '慢性病控制穩定'
      const y = await api.opdApi.expandEncounter(re.id, re.patientId)
      ok(y.refillFrom === re.date && y.date === orig.date && y.assessment === '慢性病控制穩定', `前次是慢箋調劑（${re.date}）→ 帶入 ${orig.date} 原處方看診的內容`)
      orig.assessment = keepA
    }
    // 頁面只呈現：停用判斷在服務層（pickUsable），合併規則只有 mergeIntoDraft 一份
    const { readFileSync, readdirSync } = await import('node:fs')
    const opdDir = 'src/pages/opd'
    const files = [...readdirSync(opdDir).map((n) => `${opdDir}/${n}`), ...readdirSync(`${opdDir}/components`).map((n) => `${opdDir}/components/${n}`)].filter((p) => p.endsWith('.vue'))
    const activeChecks = files.filter((p) => /\.active\b/.test(readFileSync(p, 'utf8')))
    ok(!activeChecks.length, `門診頁面不自己判斷停用${activeChecks.length ? '：' + activeChecks.join('、') : ''}`)
    const page = readFileSync(`${opdDir}/OpdPage.vue`, 'utf8')
    const merges = (page.match(/draft\.value\.medications\.push\(/g) ?? []).length
    ok(merges === 1 && /function applySet[\s\S]{0,300}mergeIntoDraft\(/.test(page) && /function copyFrom[\s\S]{0,400}mergeIntoDraft\(/.test(page), '組套、同前次、只帶處方共用 mergeIntoDraft（處方只有一處加藥）')
    const os = readFileSync('src/services/orderset.ts', 'utf8')
    ok(os.includes('pickUsable(') && !/find\.drug\([^)]*\)\?\.active/.test(os.slice(os.indexOf('export function expandOrderSet'))), '組套展開與同前次共用 pickUsable')
    await as('clerk01')
  }

  // 優免：只減掛號費與自費項目，部分負擔不減；需原因的要填；停用的不能用；日結有優免合計
  console.log('\n[優免]')
  {
    const B = await load('/src/services/billing.ts')
    const lines = [
      { kind: 'reg', name: '掛號費', qty: 1, unitPrice: 150, amount: 150, patientPay: true },
      { kind: 'consult', name: '診察費', qty: 1, unitPrice: 300, amount: 300, patientPay: false },
      { kind: 'drug', name: '藥', qty: 10, unitPrice: 5, amount: 50, patientPay: false },
      { kind: 'self', name: '自費藥', qty: 1, unitPrice: 155, amount: 155, patientPay: true },
      { kind: 'copay-basic', name: '基本部分負擔', qty: 1, unitPrice: 80, amount: 80, patientPay: true },
      { kind: 'copay-drug', name: '藥品部分負擔', qty: 1, unitPrice: 20, amount: 20, patientPay: true },
    ]
    const staff = { code: 'X1', name: '員工', regMode: 'all', regAmount: 0, selfPayRate: 80, needsReason: false, active: true }
    const a = B.applyDiscount(lines, staff)
    const sa = B.summarize(a)
    const s0 = B.summarize(lines)
    ok(B.discountAmountOf(a) === 150 + 31 && sa.patientTotal === s0.patientTotal - 181, `員工：掛號費全免 −150、自費 155 打 8 折 −31（四捨五入）→ 應收 ${s0.patientTotal} → ${sa.patientTotal}`)
    ok(a.filter((l) => l.kind.startsWith('copay')).reduce((n, l) => n + l.amount, 0) === 100 && sa.nhiPoints === s0.nhiPoints, '部分負擔一律不減（80＋20 照收），健保申報點數不變')
    const fam = B.applyDiscount([{ ...lines[0], amount: 30, unitPrice: 30 }, lines[3]], { ...staff, regMode: 'amount', regAmount: 50, selfPayRate: 90 })
    ok(fam.find((l) => l.name.includes('掛號費') && l.kind === 'discount').amount === -30 && B.discountAmountOf(fam) === 30 + 16, '減固定金額不超過掛號費本身（掛號費 30、減 50 → 只減 30）；9 折 155 → −16')
    const selfId = B.applyDiscount([{ kind: 'consult', name: '診察費（自費）', qty: 1, unitPrice: 500, amount: 500, patientPay: true }], { ...staff, regMode: 'none', selfPayRate: 0 })
    ok(B.discountAmountOf(selfId) === 500 && B.summarize(selfId).patientTotal === 0, '自費身分的診察費算自費項目；0 成（全免）減到 0，不會變負數')
    ok(B.checkDiscountRule({ name: '無效', regMode: 'none', selfPayRate: 100 }).selfPayRate && B.checkDiscountRule({ name: 'x', regMode: 'amount', regAmount: 0, selfPayRate: 100 }).regAmount && B.checkDiscountRule({ name: '', regMode: 'all', selfPayRate: 120 }).name,
      '類別檢查：沒作用的優免、減 0 元、名稱空白、超過 100 成都擋')

    await as('clerk01')
    const visitP = dbm.db.visits.find((v) => v.date === T && v.status === 'consulted' && !v.refillOf)
    ok(!!visitP, '今天有待批價的病人')
    const base = await api.chargeApi.previewCharge(visitP.id)
    const pv = await api.chargeApi.previewCharge(visitP.id, 'DC01')
    ok(pv.discount?.name === '員工' && pv.patientTotal === base.patientTotal - pv.discount.amount && pv.nhiPoints === base.nhiPoints, `試算套用員工優免：${base.patientTotal} → ${pv.patientTotal}（−${pv.discount?.amount}）`)
    try {
      await api.chargeApi.pay(visitP.id, { payMethod: 'cash', received: 9999, discount: { code: 'DC05' } })
      ok(false, '專案減免沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'discountReason', `專案減免沒寫原因 → 「${e.message}」`)
    }
    await expectError(() => api.adminApi.saveDiscount({ name: '櫃台自己加', regMode: 'all', regAmount: 0, selfPayRate: 100, needsReason: false, active: true }), '櫃台新增優免類別')
    await as('admin')
    try {
      await api.adminApi.saveDiscount({ name: '員工', regMode: 'all', regAmount: 0, selfPayRate: 100, needsReason: false, active: true })
      ok(false, '同名應被擋下')
    } catch (e) {
      ok(e.fields?.name, `新增同名優免 → 「${e.fields?.name}」`)
    }
    const dc3 = dbm.db.discounts.find((d) => d.code === 'DC03')
    await api.adminApi.saveDiscount({ ...dc3, active: false })
    await as('clerk01')
    try {
      await api.chargeApi.previewCharge(visitP.id, 'DC03')
      ok(false, '停用的優免應被擋下')
    } catch (e) {
      ok(e.field === 'discount', `停用的優免 → 「${e.message}」`)
    }
    ok(!(await api.chargeApi.listDiscounts()).some((d) => d.code === 'DC03'), '批價頁選單不列停用的類別')
    const dd = await api.chargeApi.getChargeDetail(visitP.id, 'DC03')
    ok(dd.discountError?.includes('已停用') && dd.preview && !dd.preview.discount && dd.preview.patientTotal === base.patientTotal, '批價頁選的優免剛被停用：試算退回不含優免，並說明原因（整頁不會壞掉）')
    await as('admin')
    await api.adminApi.saveDiscount({ ...dc3, active: true })
    await as('clerk01')
    const charge = await api.chargeApi.pay(visitP.id, { payMethod: 'cash', received: pv.patientTotal, discount: { code: 'DC01' } })
    ok(charge.patientTotal === pv.patientTotal && charge.discount?.amount === pv.discount.amount && charge.lines.some((l) => l.kind === 'discount') && dbm.db.auditLogs[0].detail.includes('優免：員工'),
      `結帳：收據記下優免（員工 −${charge.discount?.amount}）、明細有優免列、稽核有紀錄`)
    const other = dbm.db.visits.find((v) => v.patientId === visitP.patientId && v.id !== visitP.id)
    if (other) ok((await api.chargeApi.getChargeDetail(other.id)).lastDiscount?.code === 'DC01', '同一位病人下次批價：提示「上次使用：員工」')
    const after = await api.chargeApi.getChargeDetail(visitP.id, 'DC01')
    ok(after.receipt?.discount?.code === 'DC01' && !after.preview && !after.discountError, '結帳後頁面仍帶著優免重新整理：拿到收據、不會報「已批價」錯誤')
    const rep = await api.chargeApi.dailyReport(T)
    const valid = dbm.db.charges.filter((c) => c.paidAt.startsWith(T) && !c.voided)
    const fee = rep.byFeeType
    ok(rep.discountTotal === valid.reduce((n, c) => n + (c.discount?.amount ?? 0), 0) && rep.discounts.some((d) => d.name === '員工') && fee.discount === -rep.discountTotal,
      `日結：優免合計 ${rep.discountTotal} 元＝各收據減免加總，依類別列出`)
    ok(fee.reg + fee.basicCopay + fee.drugCopay + fee.selfPay + fee.discount === rep.patientTotal, '日結依費用類別（含優免負數）加總＝應收合計')
  }

  // U25：調劑窗口缺藥 → 申請補貨（只填數量）→ 到貨入庫（批號、效期）自動結案
  console.log('\n[補貨申請（U25）]')
  {
    const g = sr.suggestRestockQty
    const a = g({ usable: 18, need: 30, safetyStock: 50, used30: 90 })
    ok(a.qty === 110 && a.formula.startsWith('缺 12＋安全庫存 50＋14 天用量 42＝104 → 110'), `建議量：缺 12＋安全庫存 50＋14 天用量（日均 3）42＝104 → 進位 110（「${a.formula}」）`)
    const b = g({ usable: 30, need: 0, safetyStock: 50, used30: 0 })
    ok(b.qty === 20 && b.formula.includes('－現有 30'), `沒有病人在等、近期無用量：補回安全庫存即可（${b.qty}，「${b.formula}」）`)
    ok(g({ usable: 500, need: 0, safetyStock: 50, used30: 30 }).qty === 0, '庫存充足：建議 0（不需補貨）')
    const c = g({ usable: 0, need: 30, safetyStock: 50, used30: 90, onOrder: 200 })
    ok(c.qty === 0 && c.formula.includes('已扣除申請中 200'), `已申請未到貨的量算進來：第二位病人缺同一種藥不會重複叫一整批（「${c.formula}」）`)
    ok(g({ usable: 0, need: 1, safetyStock: 0, used30: 0 }).qty === 10, '缺 1 也進位到 10')

    await as('ph01')
    const medsOf = (d) => dbm.db.encounters.find((e) => e.id === d.encounterId).medications
    const pend = dbm.db.dispenses.find((d) => d.status === 'pending' && d.createdAt.startsWith(T) && medsOf(d).length)
    ok(!!pend, '今天有待調劑的單（14:30 的種子）')
    const drugId = medsOf(pend)[0].drugId
    // 先清掉這種藥原本的待到貨申請（若有），確保從頭開始
    for (const r0 of dbm.db.restockRequests.filter((x) => x.drugId === drugId && x.status === 'open')) await api.inventoryApi.cancelRestock(r0.id, '測試前清除')
    // 用盤點把可用庫存清成 0（照服務層的路走，帳本不變式仍成立）
    await takeStock([drugId], (l, lot) => (l.expiry >= T ? 0 : lot.qty), '測試：模擬缺藥')
    const itemOf = async () => (await api.pharmacyApi.getDispense(pend.id)).items.find((i) => i.drugId === drugId)
    let it = await itemOf()
    ok(it.shortage && !it.restock, `${it.drugName} 清空後：調劑單顯示缺藥、還沒有補貨申請`)
    await expectError(() => api.pharmacyApi.verifyDispense(pend.id), '缺藥時核對')

    const plan = await api.inventoryApi.getRestockPlan(drugId)
    const expect = g({ usable: 0, need: plan.need, safetyStock: plan.safetyStock, used30: plan.used30 })
    ok(plan.usable === 0 && plan.need >= it.qty && plan.suggestion.qty === expect.qty && plan.suggestion.qty > 0,
      `申請對話框：可用 0、等待中的處方需 ${plan.need}（${plan.waitingCount} 張）、建議 ${plan.suggestion.qty}（${plan.suggestion.formula}）`)
    try {
      await api.inventoryApi.requestRestock({ drugId, qty: 0, dispenseId: pend.id })
      ok(false, '新申請數量 0 應被擋下')
    } catch (e) {
      ok(e.field === 'qty', `新申請數量 0 → 「${e.message}」（標在數量欄）`)
    }
    await as('clerk01')
    await expectError(() => api.inventoryApi.requestRestock({ drugId, qty: 10 }), '櫃台申請補貨')
    await as('ph01')
    const done = dbm.db.dispenses.find((d) => d.status === 'dispensed')
    await expectError(() => api.inventoryApi.requestRestock({ drugId: medsOf(done)[0].drugId, qty: 10, dispenseId: done.id }), '為已發藥的單申請補貨')
    const notIn = dbm.db.drugs.find((d) => d.active && !medsOf(pend).some((m) => m.drugId === d.id))
    await expectError(() => api.inventoryApi.requestRestock({ drugId: notIn.id, qty: 10, dispenseId: pend.id }), '處方沒有這種藥卻掛在這張單上')

    const req = await api.inventoryApi.requestRestock({ drugId, qty: plan.suggestion.qty, dispenseId: pend.id, note: '請藥商下午送' })
    ok(req.status === 'open' && req.qty === plan.suggestion.qty && req.waiting.some((w) => w.dispenseId === pend.id && w.pickupNo === pend.pickupNo),
      `送出申請：${req.qty} ${req.unit}，等待名單有領藥號 ${pend.pickupNo}`)
    it = await itemOf()
    ok(it.shortage && it.restock?.includesThis && it.restock.outstanding === req.qty, '調劑單：仍缺藥、標示「已申請補貨」與尚欠數量')
    await expectError(() => api.pharmacyApi.verifyDispense(pend.id), '已申請但還沒到貨就核對')

    const req2 = await api.inventoryApi.requestRestock({ drugId, qty: 20 })
    ok(req2.id === req.id && req2.qty === req.qty + 20 && dbm.db.restockRequests.filter((x) => x.drugId === drugId && x.status === 'open').length === 1,
      `同一種藥再申請：加到原申請（${req.qty} → ${req2.qty}），不另開一張`)
    try {
      await api.inventoryApi.requestRestock({ drugId, qty: 0, dispenseId: pend.id })
      ok(false, '已在等待名單上又追加 0 應被擋下')
    } catch (e) {
      ok(e.field === 'qty', `已在等待名單上、追加 0 → 「${e.message}」`)
    }
    const plan2 = await api.inventoryApi.getRestockPlan(drugId)
    ok(plan2.open?.id === req.id && plan2.suggestion.formula.includes(`已扣除申請中 ${req2.qty}`), `再開對話框：顯示既有申請，建議量扣掉申請中的 ${req2.qty}（${plan2.suggestion.formula}）`)

    const sum = await api.inventoryApi.inventorySummary()
    const list = await api.inventoryApi.listInventory({ restockOnly: true })
    const dash = await api.dashboardApi.getDashboard()
    const row = list.find((r) => r.id === drugId)
    ok(sum.restockOpen === list.length && dash.restockOpen === sum.restockOpen && row?.restock?.waiting === 1 && list[0].restock.waiting >= list[list.length - 1].restock.waiting,
      `待到貨：首頁 ${dash.restockOpen} = 庫存卡片 ${sum.restockOpen} = 篩選清單 ${list.length} 項；有病人在等的排前面`)

    const total = req2.qty
    const t1 = await api.inventoryApi.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId, qty: 10, lotNo: 'RS-A', expiry: '2030-01-01' })
    ok(t1.restock?.status === 'open' && t1.restock.outstanding === total - 10, `分批到貨 10：申請留著，尚欠 ${t1.restock?.outstanding}`)
    ok((await api.inventoryApi.getDrugLedger(drugId)).restock?.receivedQty === 10, '庫存明細顯示已到 10')
    const t2 = await api.inventoryApi.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId, qty: total - 10, lotNo: 'RS-B', expiry: '2030-01-01' })
    const closed = dbm.db.restockRequests.find((x) => x.id === req.id)
    ok(t2.restock?.status === 'fulfilled' && closed.status === 'fulfilled' && closed.txnIds.length === 2 && closed.closedBy === 'U301' && !(await api.inventoryApi.getDrugLedger(drugId)).restock,
      '到齊：自動結案，記下兩筆入庫異動與結案人；明細不再顯示待到貨')
    it = await itemOf()
    ok(!it.shortage && !it.restock, '到貨後：調劑單不再缺藥')
    ok((await api.pharmacyApi.verifyDispense(pend.id)).status === 'verified', '到貨後可以核對了')
    const logs = dbm.db.auditLogs.slice(0, 40)
    ok(logs.some((l) => l.action === '補貨申請' && l.detail.includes(`領藥號 ${pend.pickupNo}`)) && logs.some((l) => l.action === '追加補貨申請') && logs.some((l) => l.action === '藥品進貨' && l.detail.includes('補貨申請已到齊')),
      '稽核：補貨申請（含領藥號）、追加、進貨到齊都有紀錄')

    const r3 = await api.inventoryApi.requestRestock({ drugId, qty: 30 })
    try {
      await api.inventoryApi.cancelRestock(r3.id, '  ')
      ok(false, '取消沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'reason', `取消補貨申請沒寫原因 → 「${e.message}」`)
    }
    const c3 = await api.inventoryApi.cancelRestock(r3.id, '改開替代藥')
    ok(c3.status === 'cancelled' && c3.cancelReason === '改開替代藥', '取消申請：記下原因')
    await expectError(() => api.inventoryApi.cancelRestock(r3.id, '再取消'), '已取消的申請再取消')
    ok(!(await api.inventoryApi.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId, qty: 5, lotNo: 'RS-C', expiry: '2030-01-01' })).restock, '取消後進貨：不會去抵已取消的申請')
  }

  // B11：在一天中不同時刻重建種子——時間軸要合理、號碼依時間先後（放在最後：改時鐘會影響前面的流程）
  console.log('\n[種子時間軸（B11）]')
  {
    const { buildSeed } = await load('/src/mock/seed.ts')
    const D = await load('/src/utils/date.ts')
    const ordered = (list, time, num) => {
      const bad = []
      for (let i = 1; i < list.length; i++) if (time(list[i]) < time(list[i - 1]) && num(list[i]) > num(list[i - 1])) bad.push(`${num(list[i - 1])}@${time(list[i - 1])} → ${num(list[i])}@${time(list[i])}`)
      return bad
    }
    const groupBy = (list, key) => {
      const m = new Map()
      for (const x of list) m.set(key(x), [...(m.get(key(x)) ?? []), x])
      return [...m.values()]
    }
    for (const [hh, mm] of [[5, 38], [9, 0], [14, 30], [22, 0]]) {
      setClock(hh, mm)
      const label = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
      const now = D.now()
      const Td = D.today()
      const db = buildSeed()
      const vById = new Map(db.visits.map((v) => [v.id, v]))
      // 1. 沒有未來的事（就醫、病歷、收費、調劑相關的時間）
      const times = [
        ...db.visits.flatMap((v) => [v.createdAt, v.calledAt]),
        ...db.encounters.map((e) => e.completedAt),
        ...db.charges.map((c) => c.paidAt),
        ...db.dispenses.flatMap((d) => [d.createdAt, d.verifiedAt, d.dispensedAt]),
      ].filter(Boolean)
      const future = times.filter((t) => t > now)
      // 2. 流程先後：掛號 ≤ 叫號 ≤ 完成 ≤ 批價 ≤ 發藥
      const flowBad = db.visits.filter((v) => {
        const e = db.encounters.find((x) => x.visitId === v.id)
        const c = db.charges.find((x) => x.visitId === v.id)
        const d = db.dispenses.find((x) => x.visitId === v.id)
        const seq = [v.createdAt, v.calledAt, e?.completedAt, c?.paidAt, d?.createdAt, d?.dispensedAt].filter(Boolean)
        return seq.some((t, i) => i && t < seq[i - 1])
      })
      // 3. 號碼依時間：看診號（同診次）、收據號、領藥號（同一天）、就醫序號（同一位病人）
      const seqBad = groupBy(db.visits, (v) => v.sessionId).flatMap((l) => ordered(l.sort((a, b) => a.seqNo - b.seqNo), (v) => v.createdAt, (v) => v.seqNo))
      const rcBad = groupBy(db.charges, (c) => vById.get(c.visitId).date).flatMap((l) => ordered(l.sort((a, b) => a.receiptNo.localeCompare(b.receiptNo)), (c) => c.paidAt, (c) => c.receiptNo))
      const pkBad = groupBy(db.dispenses, (d) => vById.get(d.visitId).date).flatMap((l) => ordered(l.sort((a, b) => a.pickupNo - b.pickupNo), (d) => d.createdAt, (d) => d.pickupNo))
      const csBad = groupBy(db.visits, (v) => v.patientId).flatMap((l) => ordered(l.sort((a, b) => a.cardSeq.localeCompare(b.cardSeq)), (v) => v.createdAt, (v) => v.cardSeq))
      ok(!future.length && !flowBad.length, `${label} 重建：沒有未來的時間（${future.length}）、掛號≤叫號≤完成≤批價≤發藥（違規 ${flowBad.length}）`)
      ok(!seqBad.length && !rcBad.length && !pkBad.length && !csBad.length,
        `${label} 重建：看診號、收據號、領藥號、就醫序號都依時間先後${[...seqBad, ...rcBad, ...pkBad, ...csBad].slice(0, 2).join('；')}`)
      // 4. 今天：看過診的人數、下午診的掛號
      const todayV = db.visits.filter((v) => v.date === Td && !v.refillOf)
      const seen = todayV.filter((v) => ['consulted', 'charged', 'dispensed'].includes(v.status))
      const pmSessionIds = new Set(db.sessions.filter((x) => x.date === Td && x.period === 'PM').map((x) => x.id))
      const pmRegs = todayV.filter((v) => pmSessionIds.has(v.sessionId))
      const sameTime = groupBy(todayV, (v) => v.createdAt).some((l) => l.length >= 4)
      if (hh === 5) {
        ok(seen.length === 0 && pmRegs.every((v) => v.createdAt < Td) && todayV.every((v) => v.createdAt < Td),
          `清晨 05:38：今天沒有人看過診；今天的 ${todayV.length} 筆掛號都是前幾天預約的（不再全部擠在同一個時間）`)
      }
      if (hh === 9) ok(seen.length >= 1 && seen.length < 6 && !todayV.some((v) => ['charged', 'dispensed'].includes(v.status) && db.charges.find((c) => c.visitId === v.id).paidAt > now), `09:00：前幾位看完（${seen.length} 位），其餘還在候診`)
      if (hh === 14) {
        const st = (s) => todayV.filter((v) => v.status === s).length
        ok(st('dispensed') === 2 && st('charged') === 2 && st('consulted') === 2 && pmRegs.every((v) => v.createdAt < Td || v.createdAt >= `${Td} 13:00`), `14:30：完整的今日情境（已領藥 2、已批價 2、待批價 2），下午診 13:00 起掛號`)
      }
      ok(!sameTime, `${label} 重建：今天沒有一大群人擠在同一個掛號時間`)
    }
    setClock(14, 30)
  }

  console.log('\n[轉科]')
  {
    dbm.resetDatabase('small')
    const db = () => dbm.db
    const A = api.admissionApi
    const userOf = (doctorId) => db().users.find((u) => u.doctorId === doctorId).username
    const stroke = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63.9'))
    const fromDoc = stroke.doctorId
    ok(stroke.deptTransfers?.[0]?.status === 'pending' && stroke.deptTransfers[0].toDeptId === 'D08', '展示資料：腦梗塞的病人已申請轉復健科（待接受）')
    await as('dr09')
    const dash = await api.dashboardApi.getDashboard()
    let inc = await A.listIncomingTransfers()
    ok(dash.transferIncoming === 1 && inc.length === 1 && inc[0].admission.id === stroke.id && inc[0].orders.length > 0 && inc[0].orders.every((o) => o.type === 'long' && o.status === 'active'),
      `復健科醫師：首頁待辦「轉入申請 ${dash.transferIncoming}」、清單帶著 ${inc[0]?.orders.length} 筆執行中的長期醫囑`)
    await as('dr04')
    ok((await A.listIncomingTransfers()).length === 0 && (await api.dashboardApi.getDashboard()).transferIncoming === 0, '其他科醫師看不到這筆轉入申請')
    await expectError(() => A.declineDeptTransfer(stroke.id, '不收'), '外科醫師婉拒轉復健科的申請')
    await as(userOf(fromDoc))
    await expectError(() => A.changeAttending(stroke.id, 'DR03', '交班'), '轉科申請中變更主治')
    await expectError(() => api.ipdApi.saveDischargeSummary(stroke.id, { diagnosis: 'x', course: 'x', condition: 'x', followUp: 'x', dischargeType: '治癒出院' }, true), '轉科申請中簽准予出院')
    await expectError(() => A.requestDeptTransfer(stroke.id, { toDeptId: 'D03', reason: '再申請一次' }), '已有申請中的轉科又申請')
    // 婉拒
    await as('dr09')
    try {
      await A.declineDeptTransfer(stroke.id, '')
      ok(false, '婉拒沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'reason', `婉拒沒寫原因 → 「${e.message}」`)
    }
    let v = await A.declineDeptTransfer(stroke.id, '目前病床已滿，請下週再轉')
    ok(v.lastTransfer?.status === 'declined' && v.lastTransfer.decisionNote.includes('病床已滿') && v.doctorId === fromDoc && v.deptId === 'D02', '婉拒：病人留在原科，原科看得到婉拒原因')
    // 重新申請：欄位檢查一次標出
    await as(userOf(fromDoc))
    try {
      await A.requestDeptTransfer(stroke.id, { toDeptId: 'D02', toDoctorId: 'DR04', reason: '' })
      ok(false, '申請欄位錯誤應被擋下')
    } catch (e) {
      ok(e.fields?.toDeptId && e.fields?.reason && e.fields?.toDoctorId, `申請轉科欄位錯誤一次標出：${Object.values(e.fields ?? {}).join('／')}`)
    }
    await as('dr04')
    await expectError(() => A.requestDeptTransfer(stroke.id, { toDeptId: 'D08', reason: '外科代申請' }), '別科醫師替這位病人申請轉科')
    await as(userOf(fromDoc))
    await A.requestDeptTransfer(stroke.id, { toDeptId: 'D08', toDoctorId: 'DR09', reason: '急性期穩定，轉復健科' })
    v = await A.cancelDeptTransfer(stroke.id)
    ok(v.lastTransfer?.status === 'cancelled', '原科可以撤回申請')
    await A.requestDeptTransfer(stroke.id, { toDeptId: 'D08', toDoctorId: 'DR09', reason: '急性期穩定，轉復健科' })
    // 接受：只能對畫面上看到的醫囑做決定
    await as('dr09')
    inc = await A.listIncomingTransfers()
    const item = inc.find((x) => x.admission.id === stroke.id)
    ok(item?.transfer.toDoctorName && item.transfer.reason.includes('急性期'), `指定 ${item?.transfer.toDoctorName} 接手：他的清單上有這筆`)
    await as(userOf(fromDoc))
    const late = await api.ipdApi.addOrder({ admissionId: stroke.id, type: 'long', category: 'nursing', content: '測試：下床活動需陪同' })
    await as('dr09')
    const shown = item.orders.map((o) => o.id)
    const med = item.orders.find((o) => o.category === 'medication' && db().mar.some((m) => m.orderId === o.id && m.status === 'pending' && m.udLineId))
    await expectError(() => A.acceptDeptTransfer(stroke.id, { shownOrderIds: shown, stopOrderIds: [] }), '原科剛又開的醫囑新主治沒看過就接受')
    const bed = db().beds.find((b) => b.status === 'empty' && b.ward !== db().beds.find((x) => x.id === stroke.bedId).ward)
    const oldBed = stroke.bedId
    v = await A.acceptDeptTransfer(stroke.id, { shownOrderIds: [...shown, late.id], stopOrderIds: [med.id, late.id], bedId: bed.id })
    const a2 = db().admissions.find((a) => a.id === stroke.id)
    const x = a2.deptTransfers.at(-1)
    ok(v.deptId === 'D08' && v.doctorId === 'DR09' && a2.attendingHistory.at(-1).reason.startsWith('轉科：內科 → 復健科') && x.status === 'accepted' && db().auditLogs[0].action === '接受轉科',
      '接受：科別、主治改為復健科與接手醫師；主治變更紀錄註明轉科；寫入稽核')
    const kept = shown.filter((id) => id !== med.id)
    ok(db().ipdOrders.find((o) => o.id === med.id).status === 'stopped' && kept.every((id) => db().ipdOrders.find((o) => o.id === id).status === 'active') && !db().mar.some((m) => m.orderId === med.id && m.status === 'pending'),
      `醫囑：停止勾選的 2 筆（排程一併刪除），其餘 ${kept.length} 筆延續（仍記原開立者）`)
    ok(v.bed?.id === bed.id && db().beds.find((b) => b.id === oldBed).status === 'cleaning' && x.fromBedId === oldBed && x.toBedId === bed.id, `一併轉床：${db().beds.find((b) => b.id === oldBed).bedNo} → ${bed.bedNo}（原床清潔中）`)
    await as('ph01')
    ok((await api.udApi.getUdWork()).returns.some((r) => r.admissionId === stroke.id && r.causes.includes('醫囑停止')), '停止的給藥醫囑已調劑沒給的，自動列入待退藥')
    await as('nurse01')
    ok((await api.nursingApi.listNursingOrders(stroke.id)).flatMap((g) => g.orders).some((o) => o.id === med.id && o.needsAck), '護理站：轉科停止的醫囑要核對')
    await as('dr09')
    ok((await api.dashboardApi.getDashboard()).transferIncoming === 0 && (await A.listAdmissions({ status: ['admitted'] })).some((a) => a.id === stroke.id && a.doctorId === 'DR09'), '接受後：待辦清空，病人出現在新主治的住院病人清單')
    await expectError(() => A.acceptDeptTransfer(stroke.id, { shownOrderIds: [], stopOrderIds: [] }), '已接受的轉科再接受一次')
  }

  console.log('\n[住院調劑（UD）]')
  {
    dbm.resetDatabase('small')
    const { addDays, addMinutes } = await load('/src/utils/date.ts')
    const db = () => dbm.db
    const U = api.udApi
    const udr = await load('/src/services/ud-rules.ts')
    ok(udr.udPerDose({ unit: '顆' }, 2) === 2 && udr.udPerDose({ unit: 'PEN', doseUnit: 'U' }, 10) === undefined && udr.udPerDose({ unit: '顆' }, 0.5) === undefined,
      '每劑幾個調劑單位：給藥單位＝調劑單位且整數才換算（胰島素 10 U、半顆都不換算）')
    const ipd = db().stockLocations.find((l) => l.dispensesIpd).id
    const usableAt = (drugId) => db().drugLots.filter((l) => l.drugId === drugId && l.locationId === ipd && l.expiry >= T).reduce((n, l) => n + l.qty, 0)
    // 種子：昨天 15:00 調好今天的
    const seedUd = db().udDispenses[0]
    const todayLong = db().mar.filter((m) => m.scheduledAt.startsWith(T) && db().ipdOrders.find((o) => o.id === m.orderId)?.type === 'long')
    ok(seedUd?.kind === 'daily' && seedUd.dispensedAt.startsWith(addDays(T, -1)) && todayLong.length > 0 && todayLong.every((m) => m.udLineId),
      `展示資料：昨天 15:00 已調劑今天的 ${todayLong.length} 劑（${seedUd?.no}）`)
    ok(seedUd.lines.every((l) => l.qty === 0 || db().stockTxns.find((x) => x.id === l.txnId && x.ref === seedUd.no && x.locationId === ipd && x.qty === -l.qty)), '展示資料的調劑都有扣住院藥局的異動（同單號、同數量）')
    ok(ledgerBroken(db()).length === 0, '加上住院調劑後，帳本、批號、結存仍對得起來')
    await as('nurse01')
    await expectError(() => U.getUdWork(), '護理師看住院調劑工作清單')
    await as('ph01')
    let w = await U.getUdWork()
    const dailyLines = w.daily.flatMap((g) => g.lines)
    ok(w.extra.length === 0 && w.daily.length > 0 && w.returns.length === 0 && w.recent.length === 1, `工作清單：補調劑 0、明天 ${w.daily.length} 位病人 ${dailyLines.length} 項、待退藥 0`)
    const insulin = dailyLines.find((l) => !l.perDose)
    ok(insulin && insulin.doseUnit !== insulin.unit && dailyLines.filter((l) => l.perDose).every((l) => l.qty === l.perDose * l.marIds.length), `可換算的自動算量（每劑 × 劑數）；${insulin?.drugName} 每次 ${insulin?.dose} ${insulin?.doseUnit} 無法換算`)
    const dailyIds = dailyLines.flatMap((l) => l.marIds)
    try {
      await U.dispenseUd({ kind: 'daily', marIds: dailyIds })
      ok(false, '無法換算的藥沒填數量應被擋下')
    } catch (e) {
      ok(e.field === `qty.${insulin.orderId}`, `無法換算沒填數量 → 「${e.message}」`)
    }
    // 醫師剛好又開了一筆（藥師畫面上沒有）：不會被一起調劑
    await as('dr02')
    const admId = w.daily[0].admissionId
    const fresh = await api.ipdApi.addOrder({ admissionId: admId, type: 'long', category: 'medication', drugId: 'M010', content: '', dose: 1, freq: 'QID', route: 'PO', allowDuplicate: true })
    await as('ph01')
    const need = {}
    for (const l of dailyLines.filter((l) => l.perDose)) need[l.drugId] = (need[l.drugId] ?? 0) + l.qty
    const before = Object.fromEntries(Object.keys(need).map((d) => [d, usableAt(d)]))
    const r = await U.dispenseUd({ kind: 'daily', marIds: dailyIds, qtys: { [insulin.orderId]: 0 } })
    ok(r.lines === dailyLines.length && Object.entries(need).every(([d, q]) => usableAt(d) === before[d] - q) && db().auditLogs[0].action === '住院調劑',
      `每日調劑 ${r.no}：${r.patients} 位病人 ${r.lines} 項，扣住院藥局（胰島素床邊已有填 0，不扣）`)
    ok(dailyIds.every((id) => db().mar.find((m) => m.id === id).udLineId) && !db().stockTxns.some((x) => x.ref === r.no && x.drugId === insulin.drugId), '那幾劑標為已調劑；填 0 的不產生異動')
    await expectError(() => U.dispenseUd({ kind: 'daily', marIds: dailyIds, qtys: { [insulin.orderId]: 0 } }), '同幾劑再調劑一次（畫面過期）')
    w = await U.getUdWork()
    const freshExtra = w.extra.flatMap((g) => g.lines).find((l) => l.orderId === fresh.id)
    const freshDaily = w.daily.flatMap((g) => g.lines).find((l) => l.orderId === fresh.id)
    ok(freshExtra?.marIds.length === db().mar.filter((m) => m.orderId === fresh.id && m.scheduledAt.startsWith(T)).length && freshDaily?.marIds.length === 4,
      `剛開的醫囑沒被一起調劑：補調劑今天 ${freshExtra?.marIds.length} 劑、明天 ${freshDaily?.marIds.length} 劑另外列`)
    await expectError(() => U.dispenseUd({ kind: 'daily', marIds: freshExtra.marIds }), '今天的劑量用每日調劑')
    // 護理師：還沒調劑的不能給
    await as('nurse01')
    const fm = db().mar.find((m) => m.id === freshExtra.marIds[0])
    fm.scheduledAt = addMinutes(nowStr(), -5)
    const mv = (await api.ipdApi.listMar(admId, T)).find((m) => m.id === fm.id)
    try {
      await api.nursingApi.executeMar(fm.id, 'given')
      ok(false, '還沒調劑就給藥應被擋下')
    } catch (e) {
      ok(mv?.awaitingUd && e.code === 'CONFLICT' && e.field === 'ud', `給藥紀錄標「待藥局調劑」；還沒調劑就給 → 「${e.message}」`)
    }
    await as('ph01')
    await U.dispenseUd({ kind: 'extra', marIds: freshExtra.marIds })
    const r2 = await U.dispenseUd({ kind: 'daily', marIds: freshDaily.marIds })
    await as('nurse01')
    const given = await api.nursingApi.executeMar(fm.id, 'given')
    ok(given.status === 'given', '補調劑後可以給')
    // 退藥：暫停一劑、醫師停止醫囑（明天已調好的 4 劑被取消）
    const later = db().mar.find((m) => m.orderId === fresh.id && m.status === 'pending' && m.udLineId && m.scheduledAt.startsWith(T))
    await api.nursingApi.executeMar(later.id, 'held', '病人禁食')
    await as('dr02')
    await api.ipdApi.stopOrder(fresh.id)
    await as('ph01')
    w = await U.getUdWork()
    const lineOf = (x) => db().udDispenses.find((u) => u.id === x.dispenseId).lines.find((l) => l.id === x.lineId)
    const rows = w.returns.filter((x) => lineOf(x).orderId === fresh.id)
    ok(rows.length === 2, `待退藥 ${rows.length} 項：${rows.map((x) => `${x.no} ${x.drugName} 應退 ${x.expected}（${x.causes}）`).join('；')}`)
    const extraRow = rows.find((x) => x.causes.includes('暫停給藥 1'))
    const stopRow = rows.find((x) => x.no === r2.no)
    ok(!!extraRow && stopRow?.causes === '醫囑停止 4' && stopRow.expected === 4, '退藥原因：暫停給藥、醫囑停止（排程被刪也追得到）')
    try {
      await U.receiveUdReturn(stopRow.lineId, { qty: stopRow.expected + 1 })
      ok(false, '實收多於應退應被擋下')
    } catch (e) {
      ok(e.field === 'qty', `實收多於應退 → 「${e.message}」`)
    }
    try {
      await U.receiveUdReturn(stopRow.lineId, { qty: stopRow.expected - 1 })
      ok(false, '短少沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'reason', `短少沒寫原因 → 「${e.message}」`)
    }
    const b10 = usableAt('M010')
    const rr = await U.receiveUdReturn(stopRow.lineId, { qty: stopRow.expected - 1, reason: '破損 1 顆' })
    const back = db().stockTxns.filter((x) => rr.txnIds.includes(x.id))
    const outTxn = db().stockTxns.find((x) => x.id === lineOf(stopRow).txnId)
    ok(usableAt('M010') === b10 + stopRow.expected - 1 && back.length > 0 && back.every((x) => x.type === 'return' && x.locationId === ipd && outTxn.lots.some((m) => m.lotNo === x.lots[0].lotNo)) && db().auditLogs[0].action === '退藥點收',
      `點收 ${rr.qty}／應退 ${rr.expected}（破損 1）：入住院藥局，退回發出時的批號`)
    await U.receiveUdReturn(extraRow.lineId, { qty: extraRow.expected })
    await expectError(() => U.receiveUdReturn(extraRow.lineId, { qty: 1 }), '已點收的再點收一次')
    ok(!(await U.getUdWork()).returns.some((x) => x.lineId === extraRow.lineId || x.lineId === stopRow.lineId), '點收後離開待退藥清單')
    // PRN：病房常備，給的時候扣住院藥局
    await as('nurse01')
    const prn = db().ipdOrders.find((o) => o.freq === 'PRN' && o.status === 'active' && db().drugs.find((d) => d.id === o.drugId && !d.doseUnit))
    const bp = usableAt(prn.drugId)
    await api.nursingApi.givePrn(prn.id, '體溫 38.5°C')
    const last = db().stockTxns.at(-1)
    ok(usableAt(prn.drugId) === bp - prn.dose && last.ref.startsWith('病房常備') && last.locationId === ipd, `PRN 給藥扣住院藥局（病房常備 ${prn.dose}）`)
    ok(!('wardStockOut' in api.nursingApi) && !('pendingReturn' in api.udApi) && !('wardStockOut' in api.udApi), '病房常備扣帳、待退計算都不對外（服務層內部）')
    // 出院：已調好、還沒給的劑量（出院時取消的排程、逾時沒給的）都要退
    {
      const lineById = (id) => db().udDispenses.flatMap((u) => u.lines).find((l) => l.id === id)
      const dis = db().admissions.find((a) => a.status === 'admitted' && db().mar.some((m) => m.admissionId === a.id && m.status === 'pending' && m.udLineId && lineById(m.udLineId)?.perDose))
      ok(!!dis, '有已調劑、還沒給的病人可以測出院退藥')
      if (dis) {
        await as(db().users.find((u) => u.doctorId === dis.doctorId).username)
        await api.ipdApi.saveDischargeSummary(dis.id, { diagnosis: dis.diagnosis, course: '測試', condition: '穩定', followUp: '門診追蹤', dischargeType: '治癒' }, true)
        await as('nurse01')
        await api.admissionApi.discharge(dis.id, { confirmUnfinished: true })
        await as('ph01')
        const rws = (await U.getUdWork()).returns.filter((x) => x.admissionId === dis.id)
        ok(rws.length > 0 && rws.every((x) => x.causes.startsWith('出院')), `出院後：今天已調好沒給的 ${rws.reduce((n, x) => n + x.doses, 0)} 劑列入待退藥（原因「出院」）`)
      }
    }
    ok(ledgerBroken(db()).length === 0, '調劑、退藥、病房常備之後，帳本仍對得起來')
  }

  // 醫院規模：大型（藥庫＋門診藥局＋住院藥局）。重播的事件與小型相同，只是放在不同地點
  console.log('\n[醫院規模：大型]')
  {
    const { buildSeed } = await load('/src/mock/seed.ts')
    const small = buildSeed({ scale: 'small' })
    const large = buildSeed({ scale: 'large' })
    ok(small.stockLocations.length === 1 && large.stockLocations.map((l) => l.name).join('、') === '藥庫、門診藥局、住院藥局', `小型 1 個地點；大型 ${large.stockLocations.map((l) => l.name).join('、')}`)
    // 全院總量：大型＝小型＋藥庫多進的那一批（示範用偏低、缺貨的藥沒有多進，兩邊一樣）
    const extra = (d) => large.stockTxns.filter((t) => t.drugId === d.id && t.type === 'receive' && t.lots[0]?.lotNo.endsWith('W')).reduce((a, t) => a + t.qty, 0)
    ok(large.drugs.every((d) => d.stock === small.drugs.find((x) => x.id === d.id).stock + extra(d)), '兩種規模的全院總量只差藥庫多進的那一批（其餘事件完全相同）')
    const flagCount = (db, loc) => db.drugs.filter((d) => {
      const u = db.drugLots.filter((l) => l.drugId === d.id && l.locationId === loc && l.expiry >= T).reduce((a, l) => a + l.qty, 0)
      return u <= (db.safetyStocks.find((s) => s.locationId === loc && s.drugId === d.id)?.qty ?? d.safetyStock)
    }).length
    ok(flagCount(large, 'LOC-OPD') <= flagCount(small, 'LOC-PH') + 1 && flagCount(large, 'LOC-WH') <= flagCount(small, 'LOC-PH') + 1,
      `偏低／缺貨的數量合理：小型 ${flagCount(small, 'LOC-PH')}、大型門診藥局 ${flagCount(large, 'LOC-OPD')}、藥庫 ${flagCount(large, 'LOC-WH')}（不會一大半都在警示）`)
    ok(ledgerBroken(large).length === 0, '大型：每個地點的批號、帳本、結存都對得起來')
    const byType = (t) => [...new Set(large.stockTxns.filter((x) => x.type === t).map((x) => x.locationId))].join()
    ok(byType('dispense') === 'LOC-OPD,LOC-IPD' && large.stockTxns.filter((x) => x.type === 'dispense' && x.locationId === 'LOC-IPD').every((x) => x.ref.startsWith('UD')) && byType('receive') === 'LOC-WH' && byType('opening') === 'LOC-WH', '門診發藥從門診藥局扣、住院調劑從住院藥局扣；期初、進貨只進藥庫')
    const outs = large.stockTxns.filter((x) => x.type === 'transfer-out')
    const unpaired = outs.filter((o) => {
      const i = large.stockTxns.find((x) => x.type === 'transfer-in' && x.ref === o.ref && x.drugId === o.drugId)
      return !i || i.qty !== -o.qty || JSON.stringify(i.lots.map((l) => [l.lotNo, l.qty])) !== JSON.stringify(o.lots.map((l) => [l.lotNo, -l.qty]))
    })
    ok(outs.length > 0 && !unpaired.length && outs.every((o) => o.locationId === 'LOC-WH'), `撥補 ${outs.length} 次：藥庫撥出與藥局撥入成對（同單號、同數量、同批號）`)
    const sameLot = large.drugLots.filter((l) => l.locationId !== 'LOC-WH').every((l) => large.drugLots.some((w) => w.locationId === 'LOC-WH' && w.drugId === l.drugId && w.lotNo === l.lotNo && w.expiry === l.expiry))
    ok(sameLot, '藥局的批號都來自藥庫（批號、效期跟著藥走，追溯得到）')
    const m1 = large.drugs.find((d) => d.id === 'M001')
    ok(large.safetyStocks.find((x) => x.locationId === 'LOC-WH' && x.drugId === 'M001')?.qty === m1.safetyStock * 3, '藥庫的安全庫存另外設定（主檔的 3 倍）')

    // 大型實際操作：重建 → 發藥扣門診藥局、進貨預設進藥庫、各地點庫存查得到
    dbm.resetDatabase('large')
    ok(dbm.db.hospitalScale === 'large', '重建展示資料可選大型')
    await as('ph01')
    {
      const w = await api.udApi.getUdWork()
      const g = w.daily[0]
      const ids = g.lines.filter((l) => l.perDose).flatMap((l) => l.marIds)
      const r = await api.udApi.dispenseUd({ kind: 'daily', marIds: ids })
      const tx = dbm.db.stockTxns.filter((x) => x.ref === r.no)
      ok(w.locationId === 'LOC-IPD' && tx.length > 0 && tx.every((x) => x.locationId === 'LOC-IPD'), `大型：住院調劑扣住院藥局（${w.locationName}），門診藥局、藥庫不動`)
    }
    const I = api.inventoryApi
    const L = await I.listStockLocations()
    ok(L.scale === 'large' && L.opd === 'LOC-OPD' && L.receiving === 'LOC-WH' && L.locations.length === 3, '地點清單：門診發藥＝門診藥局、採購入庫＝藥庫')
    const pend = dbm.db.dispenses.find((d) => d.status === 'pending' && dbm.db.encounters.find((e) => e.id === d.encounterId).medications.every((m) => dbm.db.drugLots.filter((l) => l.drugId === m.drugId && l.locationId === 'LOC-OPD' && l.expiry >= T).reduce((a, l) => a + l.qty, 0) >= m.qty))
    ok(!!pend, '有門診藥局發得出來的待調劑單')
    const whBefore = dbm.db.drugLots.filter((l) => l.locationId === 'LOC-WH').reduce((a, l) => a + l.qty, 0)
    await api.pharmacyApi.verifyDispense(pend.id)
    const pt = dbm.db.patients.find((p) => p.id === pend.patientId)
    await api.pharmacyApi.dispense(pend.id, { birthMMDD: pt.birthDate.slice(5).replace('-', '') })
    const last = dbm.db.stockTxns.at(-1)
    ok(last.type === 'dispense' && last.locationId === 'LOC-OPD' && dbm.db.drugLots.filter((l) => l.locationId === 'LOC-WH').reduce((a, l) => a + l.qty, 0) === whBefore, '發藥扣門診藥局，藥庫不動')
    const rcv = await I.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId: 'M010', qty: 50, lotNo: 'BIG-1', expiry: '2030-01-01' })
    ok(rcv.locationId === 'LOC-WH' && dbm.db.drugLots.some((l) => l.lotNo === 'BIG-1' && l.locationId === 'LOC-WH'), '進貨沒指定地點：進藥庫')
    const wh = await I.listInventory({ locationId: 'LOC-WH' })
    const opd = await I.listInventory({ locationId: 'LOC-OPD' })
    const m10wh = wh.find((r) => r.id === 'M010')
    const m10opd = opd.find((r) => r.id === 'M010')
    ok(m10wh.stock + m10opd.stock + (await I.listInventory({ locationId: 'LOC-IPD' })).find((r) => r.id === 'M010').stock === dbm.db.drugs.find((d) => d.id === 'M010').stock, '各地點的庫存加起來＝全院總量')
    ok(m10wh.safetyStock === dbm.db.drugs.find((d) => d.id === 'M010').safetyStock * 3 && m10opd.safetyStock === dbm.db.drugs.find((d) => d.id === 'M010').safetyStock, '庫存頁的安全庫存是該地點的（藥庫 3 倍、門診藥局用主檔值）')
    const opdDrugs = await api.masterApi.listDrugs({ includeInactive: true })
    ok(opdDrugs.every((d) => d.usable === m10opd.usable || d.id !== 'M010'), '醫師開藥看到的可用量＝門診藥局的（不是全院、不是藥庫）')
    const ledger = await I.getDrugLedger('M010', 'LOC-WH')
    ok(ledger.txns.every((t) => t.locationId === 'LOC-WH') && ledger.lots.every((l) => l.locationId === 'LOC-WH'), '藥品明細依地點：只列這個地點的批號與異動')
    await expectError(() => I.listInventory({ locationId: 'LOC-NOPE' }), '查不存在的地點')
    const ordL = dbm.db.purchaseOrders.find((p) => p.status === 'ordered')
    await api.purchaseApi.receivePurchase(ordL.id, ordL.lines[0].id, { qty: 1, lotNo: 'BIG-PO', expiry: '2030-01-01' })
    ok(ordL.locationId === 'LOC-WH' && dbm.db.drugLots.some((l) => l.lotNo === 'BIG-PO' && l.locationId === 'LOC-WH'), '大型：採購到貨進藥庫')
    ok(ledgerBroken(dbm.db).length === 0, '大型操作後，各地點帳本仍對得起來')
    // ---- 撥補單（大型醫院）：藥局請領 → 藥庫撥發（運送中）→ 藥局逐批簽收 ----
    const TRA = api.transferApi
    const trTxns = dbm.db.stockTxns.filter((t) => t.type === 'transfer-out' || t.type === 'transfer-in')
    const orphanTr = trTxns.filter((t) => !dbm.db.transfers.some((x) => x.no === t.ref && x.status === 'received'))
    const dupLine = dbm.db.transfers.filter((x) => new Set(x.lines.map((l) => l.drugId)).size !== x.lines.length)
    ok(trTxns.length > 0 && !orphanTr.length && !dupLine.length, `種子：${trTxns.length} 筆撥出／撥入都對得到已簽收的撥補單（單號＝異動單號；一張單同一種藥只有一行）`)
    const reqTr = dbm.db.transfers.find((x) => x.status === 'requested')
    const rsId = reqTr?.lines[0].restockId
    ok(!!rsId && !dbm.db.purchaseOrders.some((p) => p.lines.some((l) => l.restockId === rsId)), '種子：補貨申請在大型醫院列入請領中的撥補單（不是採購單）')
    // 補貨申請是門診藥局的需求：藥庫到貨不能沖銷
    const rsDrug = reqTr.lines[0].drugId
    await I.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId: rsDrug, locationId: 'LOC-WH', qty: 999, lotNo: 'WH-ONLY', expiry: '2030-01-01' })
    ok(dbm.db.restockRequests.find((r) => r.id === rsId).status === 'open', '藥庫到貨不沖銷門診藥局的補貨申請（以前一到藥庫就結案，病人在窗口還是領不到）')
    await expectError(() => TRA.transferCandidates('LOC-WH'), '從藥庫發起請領')
    const tc = await TRA.transferCandidates('LOC-OPD')
    ok(!tc.some((c) => c.restock?.id === rsId), '請領需求清單：已在撥補單上的補貨申請不重複列出')
    await expectError(() => TRA.requestTransfer({ toLocationId: 'LOC-OPD', lines: [{ drugId: rsDrug, qty: 1, restockId: rsId }] }), '同一張補貨申請請領兩次')
    try {
      await TRA.requestTransfer({ toLocationId: 'LOC-OPD', lines: [{ drugId: 'M001', qty: 5 }, { drugId: 'M001', qty: 3 }] })
      ok(false, '重複品項應被擋下')
    } catch (e) {
      ok(e.fields?.['line-1']?.includes('重複'), '請領同一種藥兩行：標在那一行')
    }
    // 撥發
    const line = reqTr.lines[0]
    const line2 = reqTr.lines[1]
    ok(!!line2 && line2.drugId === 'M001', '種子的請領單第二行是藥庫有的藥（示範少撥）')
    try {
      await TRA.issueTransfer(reqTr.id, { [line.id]: line.qty + 1, [line2.id]: line2.qty })
      ok(false, '多撥應被擋下')
    } catch (e) {
      ok(e.field === `issue-${line.id}`, `撥發多於請領 → 「${e.message}」`)
    }
    await expectError(() => TRA.issueTransfer(reqTr.id, { [line.id]: 0, [line2.id]: 0 }), '每一項都撥 0')
    await expectError(() => TRA.issueTransfer(reqTr.id, { [line.id]: line.qty }), '漏填某一行的撥發數量')
    const totalBefore = dbm.db.drugs.find((d) => d.id === rsDrug).stock
    const issued = await TRA.issueTransfer(reqTr.id, { [line.id]: line.qty, [line2.id]: line2.qty - 5 })
    const outTxn = dbm.db.stockTxns.filter((t) => t.type === 'transfer-out' && t.drugId === rsDrug).at(-1)
    ok(issued.lines[1].issuedQty === line2.qty - 5, '藥庫可以少撥（第二行少撥 5）')
    ok(issued.status === 'issued' && outTxn.type === 'transfer-out' && outTxn.locationId === 'LOC-WH' && outTxn.ref === reqTr.no && issued.lines[0].lots.reduce((n, x) => n + x.qty, 0) === line.qty, `撥發：藥庫依 FEFO 扣 ${line.qty}（${issued.lines[0].lots.map((x) => x.lotNo).join('、')}），單號寫在異動上`)
    ok(dbm.db.drugs.find((d) => d.id === rsDrug).stock === totalBefore - line.qty && (await I.listInventory({ locationId: 'LOC-OPD' })).find((r) => r.id === rsDrug).inTransit === line.qty, '運送中：藥庫已扣、門診藥局還沒入（庫存頁標「運送中」）')
    await expectError(() => TRA.cancelTransfer(reqTr.id, '不要了'), '運送中取消')
    // 簽收：多收擋下、短少要原因
    const lots = issued.lines[0].lots
    try {
      await TRA.receiveTransfer(reqTr.id, { received: { [line.id]: lots.map((x, k) => (k === 0 ? x.qty + 1 : x.qty)), [line2.id]: issued.lines[1].lots.map((x) => x.qty) } })
      ok(false, '多收應被擋下')
    } catch (e) {
      ok(e.field === `recv-${line.id}-0`, `簽收多於撥發 → 「${e.message}」`)
    }
    const less = lots.map((x, k) => (k === 0 ? x.qty - 1 : x.qty))
    try {
      await TRA.receiveTransfer(reqTr.id, { received: { [line.id]: less, [line2.id]: issued.lines[1].lots.map((x) => x.qty) } })
      ok(false, '短少沒原因應被擋下')
    } catch (e) {
      ok(e.field === `short-${line.id}`, `短少 1 沒寫原因 → 「${e.message}」`)
    }
    const opdBefore = dbm.db.drugLots.filter((l) => l.drugId === rsDrug && l.locationId === 'LOC-OPD').reduce((n, l) => n + l.qty, 0)
    const done = await TRA.receiveTransfer(reqTr.id, { received: { [line.id]: less, [line2.id]: issued.lines[1].lots.map((x) => x.qty) }, shortReasons: { [line.id]: '運送破損 1 盒' } })
    const inTx = dbm.db.stockTxns.filter((t) => t.type === 'transfer-in' && t.ref === reqTr.no && t.drugId === rsDrug)
    ok(done.status === 'received' && done.lines[0].shortQty === 1 && inTx.every((t) => t.locationId === 'LOC-OPD') && inTx.every((t) => lots.some((x) => x.lotNo === t.lots[0].lotNo)), '簽收：實收入門診藥局（批號效期照撥出的），短少 1 記下原因')
    ok(dbm.db.drugLots.filter((l) => l.drugId === rsDrug && l.locationId === 'LOC-OPD').reduce((n, l) => n + l.qty, 0) === opdBefore + line.qty - 1 && dbm.db.drugs.find((d) => d.id === rsDrug).stock === totalBefore - 1, '門診藥局多了實收量；全院總量只少了短少的 1')
    const rs = dbm.db.restockRequests.find((r) => r.id === rsId)
    ok(rs.receivedQty === line.qty - 1 && (rs.qty > line.qty - 1 ? rs.status === 'open' : rs.status === 'fulfilled'), `補貨申請由門診藥局簽收沖銷（收 ${line.qty - 1}／申請 ${rs.qty}，${rs.status === 'open' ? '短少的部分仍待補' : '已結案'}）`)
    // 新請領 → 取消
    const nt = await TRA.requestTransfer({ toLocationId: 'LOC-IPD', note: '測試', lines: [{ drugId: 'M001', qty: 10 }] })
    ok(nt.status === 'requested' && nt.fromLocationId === 'LOC-WH' && nt.toLocationId === 'LOC-IPD', `住院藥局請領 ${nt.no}：向藥庫`)
    await expectError(() => TRA.cancelTransfer(nt.id, ''), '取消請領沒寫原因')
    ok((await TRA.cancelTransfer(nt.id, '開錯了')).status === 'cancelled', '請領中可以取消（寫原因）')
    // 各地點安全庫存可改
    try {
      await I.setSafetyStock('M001', 'LOC-WH', -1)
      ok(false, '負數應被擋下')
    } catch (e) {
      ok(e.field === 'qty', `安全庫存負數 → 「${e.message}」`)
    }
    await I.setSafetyStock('M001', 'LOC-WH', 7777)
    ok((await I.listInventory({ locationId: 'LOC-WH' })).find((r) => r.id === 'M001').safetyStock === 7777 && (await I.listInventory({ locationId: 'LOC-OPD' })).find((r) => r.id === 'M001').safetyStock !== 7777, '各地點的安全庫存各自改（藥庫改了、門診藥局不變）')
    const dashL = await api.dashboardApi.getDashboard()
    ok(dashL.transferRequested === dbm.db.transfers.filter((x) => x.status === 'requested').length && dashL.transferIssued === 0, '首頁待辦（大型）：撥補待撥發、待簽收')
    ok(!Object.values(api).some((m) => m && typeof m === 'object' && ('inTransit' in m || 'inTransitTo' in m)), '內部查詢（運送中數量）不經 Api 對外')
    dbm.resetDatabase('small')
    ok(dbm.db.hospitalScale === 'small' && dbm.db.stockLocations.length === 1, '再重建回小型')
    await as('ph01')
    await expectError(() => api.transferApi.requestTransfer({ toLocationId: 'LOC-PH', lines: [{ drugId: 'M001', qty: 1 }] }), '小型醫院（只有一個藥局）請領')
    ok((await api.dashboardApi.getDashboard()).transferRequested === undefined, '小型醫院首頁沒有撥補待辦')
    await as('clerk01')
  }
} catch (e) {
  failed++
  console.error('\n未預期的錯誤：', e)
} finally {
  await server.close()
}

console.log(failed ? `\n✘ ${failed} 項失敗` : '\n全部通過')
process.exit(failed ? 1 : 0)
