// 服務層流程冒煙測試：在 Node 中透過 Vite 載入 TypeScript 服務，跑完整就醫流程與住院流程。
// 執行：npm run smoke
import { createServer } from 'vite'

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
  const visit = await api.bookingApi.register({ patientId: patient.id, sessionId: session.id, identityCode: '01', caseType: '01' })
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

  // 不變式：每種藥 stock = 批號剩餘總和 = 帳本加總，且每筆帳的結存連續
  const broken = dbm.db.drugs.filter((d) => {
    const lots = dbm.db.drugLots.filter((l) => l.drugId === d.id).reduce((s, l) => s + l.qty, 0)
    const txns = dbm.db.stockTxns.filter((t) => t.drugId === d.id)
    const sum = txns.reduce((s, t) => s + t.qty, 0)
    let run = 0
    const chain = txns.every((t) => (run += t.qty) === t.balance)
    return d.stock !== lots || d.stock !== sum || !chain || dbm.db.drugLots.some((l) => l.drugId === d.id && l.qty < 0)
  })
  ok(broken.length === 0, `${dbm.db.drugs.length} 種藥：庫存 = 批號總和 = 帳本加總，結存連續（不符 ${broken.length} 種）`)

  const recvDrug = 'M010'
  const before10 = dbm.db.drugs.find((d) => d.id === recvDrug).stock
  await expectError(() => api.inventoryApi.receiveStock({ drugId: recvDrug, qty: 100, lotNo: '', expiry: '2030-01-01' }), '進貨未填批號')
  await expectError(() => api.inventoryApi.receiveStock({ drugId: recvDrug, qty: 100, lotNo: 'T1', expiry: '2020-01-01' }), '進貨效期已過')
  // G3：效期不再預填，留白送出要擋；今天到期也不能進貨
  await expectError(() => api.inventoryApi.receiveStock({ drugId: recvDrug, qty: 100, lotNo: 'T1', expiry: '' }), '進貨效期空白')
  await expectError(() => api.inventoryApi.receiveStock({ drugId: recvDrug, qty: 100, lotNo: 'T1', expiry: T }), '進貨效期是今天')
  await api.inventoryApi.receiveStock({ drugId: recvDrug, qty: 100, lotNo: 't1', expiry: '2030-01-01' })
  await expectError(() => api.inventoryApi.receiveStock({ drugId: recvDrug, qty: 5, lotNo: 'T1', expiry: '2031-01-01' }), '同批號不同效期')
  const lotT1 = dbm.db.drugLots.find((l) => l.drugId === recvDrug && l.lotNo === 'T1')
  ok(lotT1 && dbm.db.drugs.find((d) => d.id === recvDrug).stock === before10 + 100, '進貨：批號轉大寫、庫存 +100')
  await expectError(() => api.inventoryApi.stocktake({ lotId: lotT1.id, actual: 97, reason: '' }), '盤點有差異未寫原因')
  // G6：實際數量的規則（頁面與服務層共用）
  ok([-3, 2.5, undefined, '', '3', NaN].every((v) => sr.checkStocktakeActual(v)) && [0, 97].every((v) => sr.checkStocktakeActual(v) === null), '盤點實際數量：負數、小數、空白、字串、NaN 不接受；0 與正整數接受')
  try {
    await api.inventoryApi.stocktake({ lotId: lotT1.id, actual: -3, reason: '破損' })
    ok(false, '盤點負數應被擋下')
  } catch (e) {
    ok(e.field === 'actual' && e.message === sr.checkStocktakeActual(-3), `盤點負數 → 「${e.message}」（與頁面同一條規則）`)
  }
  ok((await api.inventoryApi.stocktake({ lotId: lotT1.id, actual: 100, reason: '' })) === null, '帳實相符：不產生調整')
  const adj = await api.inventoryApi.stocktake({ lotId: lotT1.id, actual: 97, reason: '破損' })
  ok(adj.qty === -3 && dbm.db.drugLots.find((l) => l.id === lotT1.id).qty === 97, '盤點輸入實際 97 → 系統算出 −3 並調整該批號')
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
  await expectError(() => A.saveUser({ id: self.id, username: 'admin', name: self.name, role: 'admin', active: false }), '停用自己的帳號')
  await expectError(() => A.saveUser({ id: self.id, username: 'admin', name: self.name, role: 'clerk', active: true }), '拿掉自己的管理員角色')
  await expectError(() => A.saveUser({ username: 'Bad Name', name: 'x', role: 'clerk', active: true, password: '1234' }), '帳號格式不符')
  await expectError(() => A.saveUser({ username: 'clerk01', name: 'x', role: 'clerk', active: true, password: '1234' }), '帳號重複')
  await expectError(() => A.saveUser({ username: 'dr99', name: 'x', role: 'doctor', doctorId: 'DR01', active: true, password: '1234' }), '同一位醫師建立第二個帳號')
  await expectError(() => A.saveUser({ username: 'clerk02', name: '新櫃台', role: 'clerk', active: true, password: '12' }), '新帳號密碼太短')
  const nu = await A.saveUser({ username: 'Clerk02', name: '新櫃台', role: 'clerk', active: true, password: '5678' })
  ok(nu.username === 'clerk02' && !('password' in nu), '新增帳號：帳號轉小寫、回傳不含密碼')
  const admin2 = await A.saveUser({ username: 'admin2', name: '副管理員', role: 'admin', active: true, password: '5678' })
  await A.saveUser({ id: admin2.id, username: 'admin2', name: '副管理員', role: 'admin', active: false })
  await as('admin')
  await A.saveUser({ id: nu.id, username: 'clerk02', name: '新櫃台', role: 'clerk', active: false })
  await expectError(() => api.authApi.login('clerk02', '5678'), '停用的帳號登入')
  await A.resetPassword(nu.id, 'abcd')
  ok(!dbm.db.auditLogs.slice(0, 3).some((l) => l.detail.includes('abcd')), '重設密碼：稽核紀錄不記錄密碼內容')

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
  await expectError(() => A.saveUser({ username: 'drnew', name: '新醫師', role: 'doctor', doctorId: ndoc.id, active: true, password: '1234' }), '為停用的醫師建立帳號')

  // 管理員可以檢視、可以做系統管理，但不能執行臨床操作
  await as('admin')
  const anyPatient = dbm.db.patients[0]
  const anyAdm = dbm.db.admissions.find((a) => a.status === 'admitted')
  const anyMar = dbm.db.mar.find((m) => m.status === 'pending')
  const anyDispense = dbm.db.dispenses.find((d) => d.status === 'pending')
  await expectError(() => api.ipdApi.addOrder({ admissionId: anyAdm.id, type: 'long', category: 'diet', content: '普通飲食' }), '管理員開立住院醫囑')
  await expectError(() => api.nursingApi.executeMar(anyMar.id, 'given'), '管理員執行給藥')
  if (anyDispense) await expectError(() => api.pharmacyApi.verifyDispense(anyDispense.id), '管理員核對處方')
  await expectError(() => api.inventoryApi.receiveStock({ drugId: 'M001', qty: 10, lotNo: 'X1', expiry: '2030-01-01' }), '管理員進貨')
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
  noAdmin.users = noAdmin.users.filter((u) => u.role !== 'admin')
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
      const base = { generic: '', nhiCode: '', spec: '', category: '口服', unit: 'TAB', doseUnit: '', nhiPrice: 2, selfPrice: 5, safetyStock: 50, defaultDose: 1, defaultFreq: 'TID', defaultRoute: 'PO', highAlert: false, active: true }
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
    // B7：訊息不能指向不存在的功能——系統沒有轉科，要說「未提供」，不能叫人「請辦理轉科」
    try {
      await api.admissionApi.changeAttending(adm.id, otherDept.id, '測試')
    } catch (e) {
      ok(e.message.includes('未提供') && !e.message.includes('請辦理轉科'), `跨科變更主治的訊息明說沒有轉科功能（「${e.message}」）`)
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
    await multi(() => A.saveUser({ username: '', name: '', role: '', password: '', active: true }), '新增帳號')
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
} catch (e) {
  failed++
  console.error('\n未預期的錯誤：', e)
} finally {
  await server.close()
}

console.log(failed ? `\n✘ ${failed} 項失敗` : '\n全部通過')
process.exit(failed ? 1 : 0)
