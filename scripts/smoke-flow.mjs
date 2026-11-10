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
  const { today } = await load('/src/utils/date.ts')
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
  await api.pharmacyApi.dispense(dp.id)
  ok(dbm.db.drugs.find((d) => d.id === 'M001').stock === stockBefore - 9, `發藥扣庫存 ${stockBefore} → ${stockBefore - 9}`)
  const lastTxn = dbm.db.stockTxns.filter((t) => t.drugId === 'M001').at(-1)
  ok(lastTxn.type === 'dispense' && lastTxn.qty === -9 && lastTxn.ref === `領藥號 ${dp.pickupNo}` && lastTxn.balance === stockBefore - 9, `發藥寫入異動帳（${lastTxn.ref}，${lastTxn.qty}，結存 ${lastTxn.balance}）`)

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
  }
  const expiredDrug = dbm.db.drugLots.find((l) => l.qty > 0 && l.expiry < new Date().toISOString().slice(0, 10))
  if (expiredDrug) {
    await api.inventoryApi.scrapExpired(expiredDrug.drugId)
    ok(!dbm.db.drugLots.some((l) => l.drugId === expiredDrug.drugId && l.qty > 0 && l.expiry < new Date().toISOString().slice(0, 10)), '報廢過期批號')
  } else ok(false, '種子資料應有一個已過期批號（M005）')
  ok(dbm.db.visits.find((v) => v.id === visit.id).status === 'dispensed', '發藥 → 掛號狀態已領藥')
  await as('clerk01')
  await expectError(() => api.chargeApi.voidCharge(charge.id, '測試'), '已發藥後作廢收據')

  console.log('\n[規則] 過敏與預防保健')
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
  await expectError(() => api.preventApi.addPreventRecord({ patientId: todo.visit.patientId, itemCode: code, result: '正常', data: {}, doctorId: todo.visit.doctorId }), '同一天重複登錄')
  const pendingRec = dbm.db.preventRecords.find((r) => r.result === '待報告')
  await expectError(() => api.preventApi.fillReport(pendingRec.id, '正常', {}), '補登報告未填內容')
  await expectError(() => api.preventApi.fillReport(pendingRec.id, '', { 報告: 'NILM' }), '補登報告沒選結果')
  await expectError(() => api.preventApi.fillReport(pendingRec.id, '待報告', { 報告: 'NILM' }), '補登報告選「待報告」')
  await api.preventApi.fillReport(pendingRec.id, '正常', { 報告: 'NILM' })
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
  const resv = (await api.admissionApi.listAdmissions({ status: ['reserved'] }))[0]
  const bed = dbm.db.beds.find((b) => b.status === 'empty')
  const adm = await api.admissionApi.checkIn(resv.id, bed.id)
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
  ok(nr.shiftOf('2024-05-01 07:59') === '大夜' && nr.shiftOf('2024-05-01 08:00') === '白班' && nr.shiftOf('2024-05-01 16:00') === '小夜', '班別判斷')
  ok(nr.handoverShiftOf('2024-05-01 08:10') === '大夜' && nr.handoverShiftOf('2024-05-01 15:40') === '白班', '交班預設為正要結束的班別（08:10 寫的是大夜交班）')
  const lastMar = marTomorrow.sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt))[0]
  await expectError(() => api.nursingApi.executeMar(lastMar.id, 'given'), `提早給藥（預定 ${lastMar.scheduledAt}）`)
  await expectError(() => api.nursingApi.executeMar(lastMar.id, 'held', ''), '暫停給藥未寫原因')
  await api.nursingApi.executeMar(lastMar.id, 'held', '病人外出檢查')
  ok(dbm.db.mar.find((m) => m.id === lastMar.id).status === 'held', '暫停給藥可提前決定（須註明原因）')
  const statMar = dbm.db.mar.find((m) => m.orderId === statMed.id)
  await api.nursingApi.executeMar(statMar.id, 'given')
  ok(dbm.db.mar.find((m) => m.id === statMar.id).status === 'given' && dbm.db.ipdOrders.find((o) => o.id === statMed.id).status === 'done', '臨時給藥執行後，醫囑即完成')
  await expectError(() => api.nursingApi.addVitals({ admissionId: adm.id, temp: 52 }), '體溫 52 度')
  await expectError(() => api.nursingApi.addVitals({ admissionId: adm.id, temp: 98.6 }), '體溫 98.6（華氏）')
  await api.nursingApi.addVitals({ admissionId: adm.id, temp: 37.8, pulse: 88, sbp: 128, dbp: 80 })
  const note = await api.nursingApi.addNursingNote({ admissionId: adm.id, focus: '體溫過高', data: '體溫 37.8°C', action: '冰枕使用', response: '' })
  await api.nursingApi.addNoteResponse(note.id, '一小時後 37.2°C')
  await expectError(() => api.nursingApi.addNoteResponse(note.id, '改寫'), '已有反應（R）再補記（紀錄只能增補不能改寫）')
  const ward = await api.nursingApi.listWardPatients(bed.ward)
  ok(ward.some((w) => w.id === adm.id && w.latestVitals?.temp === 37.8), `護理站 ${bed.ward} 看得到新病人與最新生命徵象`)

  await as('dr02')
  await api.admissionApi.discharge(adm.id, { dischargeType: '改善出院', dischargeSummary: '症狀改善' })
  ok(dbm.db.beds.find((b) => b.id === bed.id).status === 'cleaning', '出院 → 病床清潔中')
  ok(dbm.db.ipdOrders.filter((o) => o.admissionId === adm.id).every((o) => o.status !== 'active'), '出院 → 所有醫囑停止')
  ok(!dbm.db.mar.some((m) => m.admissionId === adm.id && m.status === 'pending'), '出院 → 未執行的給藥排程清除')

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

  console.log('\n[系統管理] 帳號、科別、醫師、稽核、匯出入')
  await as('admin')
  const A = api.adminApi
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
    ok(notices.length >= notice.length && (await S.listSuspendNotices()).find((n) => n.visitId === notice[0].visitId).notifiedAt, '停診通知名單：可逐一記錄已通知')

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
    globalThis.localStorage = { setItem() { throw new Error('QuotaExceededError') }, getItem() { return null }, removeItem() {} }
    dbm.storageMode.value = 'persistent'
    const target = dbm.db.patients[2]
    const before = target.phone
    await expectError(() => api.patientApi.updatePatient(target.id, { ...target, phone: '0900-000-000' }), '儲存空間已滿時修改病人資料')
    ok(dbm.db.patients.find((p) => p.id === target.id).phone === before, '存檔失敗時交易回滾，記憶體中的資料也沒有被改')
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
  const dash = await api.dashboardApi.getDashboard()
  console.log(`    今日掛號 ${dash.opd.total}、候診 ${dash.opd.waiting}、待批價 ${dash.opd.toCharge}、待領藥 ${dash.opd.toDispense}；收入 ${dash.revenue.patientTotal} 元；住院 ${dash.ipd.admitted} 人、空床 ${dash.ipd.emptyBeds}`)
  ok(dash.trend.length === 7, '近 7 日趨勢資料')

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
