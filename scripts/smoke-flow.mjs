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
  /**
   * 重建展示資料。給藥條碼核對（預設開）只在「[給藥條碼核對]」那段測；其他段測的是別的規則，重建後先關掉掃描，
   * 不然每一筆給藥都要先掃腕帶與藥品
   */
  // 責任分床：首頁待辦只算自己的病人——舊的測試都假設看全院，分床另外測（[護理排班與分床] 用 dbm.resetDatabase）
  const resetDb = (scale) => {
    dbm.resetDatabase(scale)
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    dbm.db.nurseAssignments = []
  }
  dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
  dbm.db.nurseAssignments = []
  /** 住院開醫囑時醫師確認交互作用、重複用藥提醒（不是這段要測的東西時用；嚴重的帶原因） */
  const withRxOk = async (input) => ({ ...input, rxAlertReasons: Object.fromEntries((await api.ipdApi.orderRxAlerts(input.admissionId, input.drugId)).map((x) => [x.key, '測試確認'])) })
  const dateUtil = await load('/src/utils/date.ts')
  const { today, now: nowStr } = dateUtil
  http.setLatency(0, 0)
  const T = today()
  const as = (username) => api.authApi.login(username, '1234')
  // 測試要幾位「空閒」的一般健保病人：種子剩下的不夠（死亡、安寧等示範也從空閒病人挑）就自己建，建完切回原本的帳號
  let madePatients = 0
  const topUpPatients = async (list, n, backTo) => {
    const vv = await load('/src/utils/validators.ts')
    while (list.length < n) {
      madePatients++
      await as('clerk01')
      list.push(await api.patientApi.createPatient({ gender: madePatients % 2 ? 'M' : 'F', birthDate: '1972-03-03', phone: '', defaultIdentity: '01', allergies: [], familyHistory: [], smoking: false, betelNut: false, bloodType: '', address: '', emergencyContact: '', emergencyPhone: '', name: `測試病人${madePatients}`, idNo: vv.makeIdNo('E', madePatients % 2 ? 'M' : 'F', 7770100 + madePatients) }))
    }
    if (backTo) await as(backTo)
    return list
  }
  /** 今天前後 n 天（YYYY-MM-DD） */
  const addDaysT = (n) => dateUtil.addDays(T, n)
  /** 退回藥庫：藥庫全部同意、藥局送出（申請 → 核准 → 運送中） */
  const approveAndShip = async (rt) => {
    await api.transferApi.approveReturn(rt.id, { approved: Object.fromEntries(rt.lines.map((l) => [l.id, l.lots.map((x) => x.requestedQty ?? x.qty)])) })
    return api.transferApi.shipReturn(rt.id)
  }
  /** 門診退藥：把還沒退的全部退掉（整張退藥） */
  const returnAll = (id, reason, extra = {}) => {
    const d = dbm.db.dispenses.find((x) => x.id === id)
    const meds = dbm.db.encounters.find((e) => e.id === d?.encounterId)?.medications ?? []
    const back = (i) => (d?.returns ?? []).flatMap((r) => r.lines).filter((l) => l.idx === i).reduce((n, l) => n + l.qty, 0)
    return api.pharmacyApi.returnDispense(id, { reason, lines: meds.map((m, i) => ({ idx: i, qty: Math.max(0, m.qty - back(i)) })), ...extra })
  }
  /** 第二人當場確認（管制藥點班見證、報廢覆核）：拿一次性的確認 token */
  const witnessOf = async (target, username) => {
    const r = await api.witnessApi.approveWitness({ ...target, username, password: '1234' })
    if (!r.ok) throw new Error(`第二人確認失敗：${r.message}`)
    return r.token
  }
  /** 住院調劑＋核對送出（雙人核對預設關閉，同一位藥師即可）；給藥測試要先有這一步 */
  const udSupply = async (kind, marIds, qtys) => {
    const r = await api.udApi.dispenseUd({ kind, marIds, qtys })
    const d = dbm.db.udDispenses.find((x) => x.no === r.no)
    for (const b of d.boxes) await api.udApi.verifyUdBox(d.id, b.admissionId)
    return r
  }
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
    const someone = dbm.db.patients.filter((p) => !p.deceasedAt).at(-6)
    await expectError(() => api.bookingApi.register({ patientId: someone.id, sessionId: closed.id, identityCode: '01', caseType: '01' }), '掛已截止的診次')
  }
  // 依執行時間，今天可能已經沒有開放的診次（例如深夜），就改掛明天
  const open = (list) => list.find((s) => !s.full && !s.closed)
  const session = open(sessions) ?? open(await api.scheduleApi.listSessions({ date: (await load('/src/utils/date.ts')).addDays(T, 1) }))
  const patient = dbm.db.patients.find((p) => !p.deceasedAt && p.allergies.length === 0 && !dbm.db.visits.some((v) => v.sessionId === session.id && v.patientId === p.id))
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
  ok(lastTxn.type === 'dispense' && lastTxn.qty === -9 && lastTxn.ref === `領藥號 ${dp.pickupNo}` && lastTxn.balance === dbm.db.drugLots.filter((l) => l.drugId === 'M001' && l.locationId === lastTxn.locationId).reduce((n, l) => n + l.qty, 0), `發藥寫入異動帳（結存是這個地點的）（${lastTxn.ref}，${lastTxn.qty}，結存 ${lastTxn.balance}）`)
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
    await api.inventoryApi.scrapExpired(expiredDrug.drugId, undefined, await witnessOf({ purpose: 'scrapExpired', drugId: expiredDrug.drugId }, 'ph02'))
    ok(!dbm.db.drugLots.some((l) => l.drugId === expiredDrug.drugId && l.qty > 0 && l.expiry < new Date().toISOString().slice(0, 10)), '報廢過期批號')
  } else ok(false, '種子資料應有一個已過期批號（M005）')
  ok(dbm.db.visits.find((v) => v.id === visit.id).status === 'dispensed', '發藥 → 掛號狀態已領藥')
  await as('clerk01')
  await expectError(() => api.chargeApi.voidCharge(charge.id, '測試'), '已發藥後作廢收據')

  // B6：上次案件分類（掛號頁提示慢性病回診用）：今天以前、看過診的最近一次，不含退掛與還沒看的掛號
  {
    const seen = (p) => dbm.db.visits.filter((v) => v.patientId === p.id && v.date <= T && !['cancelled', 'registered'].includes(v.status)).sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    const chronic = dbm.db.patients.find((p) => !p.deceasedAt && seen(p)[0]?.caseType === '04')
    const r = await api.bookingApi.lastCaseType(chronic.id)
    ok(r?.caseType === '04' && r.date === seen(chronic)[0].date, `上次案件分類：${chronic.name} 上次（${r?.date}）為 04 慢性病`)
    const nobody = dbm.db.patients.find((p) => !p.deceasedAt && !seen(p).length)
    ok(!nobody || (await api.bookingApi.lastCaseType(nobody.id)) === null, '沒有看過診的病人：沒有上次案件分類')
  }

  // U3：改期＝退舊掛新，同一筆交易；新診次掛不上就全部不動
  {
    const { addDays } = await load('/src/utils/date.ts')
    const later = (await api.scheduleApi.listSessions({ date: addDays(T, 2) })).filter((s) => s.bookable)
    const [s1, s2] = later
    const who = dbm.db.patients.find((p) => !p.deceasedAt && !dbm.db.visits.some((v) => v.patientId === p.id && v.date >= T && v.status === 'registered') && !dbm.db.visits.some((v) => [s1.id, s2.id].includes(v.sessionId) && v.patientId === p.id))
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
    const who = dbm.db.patients.find((p) => !p.deceasedAt && !p.allergies.includes('Penicillin'))
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
    // 急診不分年齡、性別
    return !v.er && ((dn === '小兒科' && age >= 18) || (dn !== '小兒科' && age < 13) || (dn === '婦產科' && p.gender !== 'F'))
  })
  ok(misfit.length === 0, `門診掛號的科別符合病人年齡與性別（違規 ${misfit.length} 筆${misfit.length ? '，例：' + misfit.slice(0, 2).map((v) => `${dbm.db.patients.find((p) => p.id === v.patientId).name}→${deptName(v.deptId)}`).join('、') : ''}）`)
  const allergic = dbm.db.patients.find((p) => !p.deceasedAt && p.allergies.includes('Penicillin'))
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
  const male = dbm.db.patients.find((p) => !p.deceasedAt && p.gender === 'M' && p.birthDate < '1990-01-01')
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
    const who = dbm.db.patients.find((x) => !x.deceasedAt && pr.checkEligibility(x, adult, dbm.db.preventRecords, T).eligible)
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
      const who = dbm.db.patients.find((x) => !x.deceasedAt && pr.checkEligibility(x, it, dbm.db.preventRecords, T).eligible)
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
  // 內科的那一筆：下面用 dr02（內科）開醫囑——同科醫師才能寫（care-team）
  const resv = resvList.find((r) => r.deptId === 'D02') ?? resvList[0]
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
    const otherResv = resvList.find((r) => r.id !== resv.id)
    if (otherResv) await expectError(() => api.admissionApi.checkIn(otherResv.id, bed.id), `別的病人報到在保留給 ${resv.patientName} 的床`)
    // 新建一筆預約、保留一床，再取消預約：保留的床要放回空床
    const someone = dbm.db.patients.find((p) => !p.deceasedAt && !dbm.db.admissions.some((a) => a.patientId === p.id && ['reserved', 'admitted'].includes(a.status)) && p.birthDate < '2000-01-01')
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
      await udSupply('extra', [mar.id])
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
    await api.ipdChargeApi.payIpd(adm.id, { payMethod: 'card', received: 0 }) // 出院前要先結帳（住院結帳另有一段測試）
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
  await expectError(() => A.saveUser({ username: 'clerk09', name: '新櫃台', roles: ['clerk'], active: true, password: '12' }), '新帳號密碼太短')
  const nu = await A.saveUser({ username: 'Clerk09', name: '新櫃台', roles: ['clerk'], active: true, password: 'Welcome123' })
  ok(nu.username === 'clerk09' && !('password' in nu), '新增帳號：帳號轉小寫、回傳不含密碼')
  const admin2 = await A.saveUser({ username: 'admin2', name: '副管理員', roles: ['admin'], active: true, password: 'Welcome123' })
  await A.saveUser({ id: admin2.id, username: 'admin2', name: '副管理員', roles: ['admin'], active: false })
  await as('admin')
  await A.saveUser({ id: nu.id, username: 'clerk09', name: '新櫃台', roles: ['clerk'], active: false })
  await expectError(() => api.authApi.login('clerk09', 'Welcome123'), '停用的帳號登入')
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
      await api.bookingApi.register({ patientId: dbm.db.patients.filter((p) => !p.deceasedAt).at(-3).id, sessionId: susp.id, identityCode: '01', caseType: '01' })
      await as('admin')
    }
    await expectError(() => S.suspendSession(susp.id, ''), '停診未填原因')
    // 停診前已經退掛的（病人自己取消）不動，原因維持原樣
    const activeBefore = new Set(dbm.db.visits.filter((v) => v.sessionId === susp.id && v.status !== 'cancelled').map((v) => v.id))
    const notice = await S.suspendSession(susp.id, '醫師病假')
    ok(notice.length > 0 && dbm.db.visits.filter((v) => activeBefore.has(v.id)).every((v) => v.status === 'cancelled' && v.cancelReason === '停診：醫師病假'), `停診：${notice.length} 筆掛號退掛，並列入通知名單（含電話 ${notice[0].phone}）`)
    await expectError(() => S.suspendSession(susp.id, '再停一次'), '重複停診')
    await as('clerk01')
    await expectError(() => api.bookingApi.register({ patientId: dbm.db.patients.filter((p) => !p.deceasedAt).at(-2).id, sessionId: susp.id, identityCode: '01', caseType: '01' }), '掛停診的診次')
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
    await api.bookingApi.register({ patientId: dbm.db.patients.filter((p) => !p.deceasedAt).at(-1).id, sessionId: gen.id, identityCode: '01', caseType: '01' })
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
    ok(sv.affectedPending === dbm.db.visits.filter((v) => v.status === 'consulted' && v.date >= T).length, `儲存時回報受影響的待批價 ${sv.affectedPending} 筆（今天起看診的；之前看診的照舊價）`)
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
    const someone = dbm.db.patients.find((p) => !p.deceasedAt && !dbm.db.visits.some((v) => v.sessionId === freeS.id && v.patientId === p.id))
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
    const walkIn = dbm.db.patients.find((p) => !p.deceasedAt && !dbm.db.visits.some((v) => v.date === T && v.patientId === p.id))
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
    for (const [a, b, msg] of [[T, addDays(T, -1), '結束日期早於起始日期'], [addDays(T, -366), T, '超過一年（367 天）']]) {
      try {
        await C.dailyReport(a, b)
        ok(false, `${msg}應被擋下`)
      } catch (e) {
        ok(e.field === 'to', `${msg} → 「${e.message}」（標在結束日期）`)
      }
    }
    const y = await C.dailyReport(addDays(T, -365), T)
    ok(y.byDay.length === 366 && y.byDay.reduce((a, d) => a + d.collected, 0) === y.collected, '剛好一年（366 天）可以查，每日小計加總＝實收')
    ok(y.byMonth?.length >= 12 && y.byMonth.reduce((a, m) => a + m.collected, 0) === y.collected && y.byMonth.reduce((a, m) => a + m.count, 0) === y.count && y.byMonth.every((m) => /^\d{4}-\d{2}$/.test(m.date)), `超過兩個月有依月份小計（${y.byMonth?.length} 個月），加總＝實收、收據數`)
    ok(!(await C.dailyReport(addDays(T, -61), T)).byMonth && !!(await C.dailyReport(addDays(T, -62), T)).byMonth, '62 天以內照舊依日期；63 天起改依月份')

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
    // 這一段測個人、科室、病房的範圍；全院共用另外測（下面「全院片語」）
    const lp = async (q) => (await PH.listPhrases(q)).phrases.filter((p) => p.scope !== 'hospital')
    await as('clerk01')
    await expectError(() => PH.listPhrases(), '櫃台查看片語')
    await as('nurse01')
    const nurseOwn = await lp()
    ok(nurseOwn.length >= 3 && nurseOwn.every((p) => p.userId === 'U201') && nurseOwn.some((p) => p.code === 'fall'), `護理師也有自己的片語（${nurseOwn.map((p) => '.' + p.code).join('、')}），看不到醫師的`)
    await as('dr01')
    const dr01 = dbm.db.users.find((u) => u.username === 'dr01').id
    const mine = await lp()
    ok(mine.length >= 3 && mine.every((p) => p.userId === dr01 && !p.scope), `只看得到自己的片語（${mine.map((p) => '.' + p.code).join('、')}）`)
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
    ok(ed.id === np.id && (await lp()).filter((p) => p.code === 'cc').length === 1, '修改片語（同簡碼不算重複）')
    await as('dr02')
    ok(!(await lp()).some((p) => p.id === np.id), '別的醫師看不到我的片語')
    await expectError(() => PH.savePhrase({ id: np.id, code: 'cc', text: '改別人的' }), '修改別的醫師的片語')
    await expectError(() => PH.deletePhrase(np.id), '刪除別的醫師的片語')
    await as('dr01')
    await PH.deletePhrase(np.id)
    ok(!(await lp()).some((p) => p.id === np.id), '刪除自己的片語')

    // 共用片語：醫師＝科室（同科都能用、能改），護理師＝目前的病房；同簡碼個人優先
    const ward5A = '5A 內科病房'
    await as('dr02')
    const d2 = await PH.listPhrases()
    const htns = d2.phrases.filter((p) => p.code === 'htn')
    ok(d2.shareTarget?.label === '內科科室共用' && d2.phrases.some((p) => p.code === 'dmedu' && p.scope === 'dept' && p.updatedByName === '黃柏翰'), 'dr02 看得到內科科室共用片語（dr03 建的，標出最後修改的人）')
    ok(htns.length === 2 && !htns[0].scope && htns[1].scope === 'dept' && htns[1].shadowed && !htns[0].shadowed, '同簡碼 .htn：個人的排前面，共用的標「被個人片語蓋住」')
    const ex2 = R.expandPhrase('.htn', 4, d2.phrases)
    ok(ex2.text === htns[0].text, '展開 .htn 用的是自己的個人片語（個人優先）')
    await as('dr03')
    const d3 = await lp()
    ok(R.expandPhrase('.htn', 4, d3).text.startsWith('高血壓，目前藥物治療中') && !d3.find((p) => p.code === 'htn').shadowed, 'dr03 沒有個人的 .htn：展開成科室共用的')
    await as('dr01')
    ok(!(await lp()).some((p) => p.scope === 'dept'), '家醫科 dr01 看不到內科的共用片語')
    await expectError(() => PH.savePhrase({ id: htns[1].id, code: 'htn', text: '改別科的' }), '別科醫師修改科室共用片語')
    // dr02 新增科室共用：同範圍不可重複簡碼；個人與共用可同簡碼
    await as('dr02')
    try {
      await PH.savePhrase({ code: 'dmedu', text: '重複', shared: true })
      ok(false, '科室共用同簡碼應被擋下')
    } catch (e) {
      ok(e.fields?.code?.includes('內科科室共用已有簡碼'), `科室共用簡碼重複 → 「${e.fields?.code}」`)
    }
    const sp = await PH.savePhrase({ code: 'stable', text: '科室版：病情穩定。', shared: true })
    ok(sp.scope === 'dept' && sp.deptId === 'D02' && dbm.db.auditLogs[0].detail === '內科科室共用 .stable', '共用片語可以和自己的個人片語同簡碼；稽核寫出範圍')
    await as('dr03')
    const edd = await PH.savePhrase({ id: sp.id, code: 'stable', text: '科室版：病情穩定，續觀察。' })
    ok(edd.scope === 'dept' && dbm.db.phrases.find((p) => p.id === sp.id).updatedBy === dbm.db.users.find((u) => u.username === 'dr03').id, '同科的 dr03 能改，記下最後修改的人；修改不會換範圍')
    await PH.deletePhrase(sp.id)
    ok(!dbm.db.phrases.some((p) => p.id === sp.id) && dbm.db.auditLogs[0].action === '刪除片語', '同科的人也能刪共用片語（寫稽核）')

    // 護理師：病房共用依目前所在的病房
    await as('nurse01')
    const n5 = await PH.listPhrases({ ward: ward5A })
    ok(n5.shareTarget?.label === '5A 內科病房共用' && n5.phrases.some((p) => p.code === 'turn' && p.scope === 'ward') && n5.phrases.findIndex((p) => p.scope) > n5.phrases.findLastIndex((p) => !p.scope), '在 5A 寫紀錄：有 5A 的病房共用片語，排在個人的後面')
    const n6 = await PH.listPhrases({ ward: '6B 外科病房' })
    ok(!n6.phrases.some((p) => p.scope === 'ward') && n6.shareTarget?.label === '6B 外科病房共用', '換到 6B：看不到 5A 的共用片語')
    ok(!(await lp()).some((p) => p.scope) && !(await PH.listPhrases()).shareTarget, '沒選病房只有個人的，也不能新增病房共用')
    await expectError(() => PH.listPhrases({ ward: '9Z' }), '不存在的病房')
    await expectError(() => PH.savePhrase({ code: 'x1', text: 'x', shared: true }), '沒選病房新增病房共用片語')
    const wp = await PH.savePhrase({ code: 'pain', text: '疼痛評估 0 分。', shared: true, ward: '6B 外科病房' })
    ok(wp.scope === 'ward' && wp.ward === '6B 外科病房', '在 6B 新增的病房共用片語屬於 6B')
    const turn = n5.phrases.find((p) => p.code === 'turn')
    await expectError(() => PH.savePhrase({ id: turn.id, code: 'turn', text: '在 6B 改 5A 的', ward: '6B 外科病房' }), '在別的病房修改 5A 的共用片語')
    await as('dr02')
    ok(!(await PH.listPhrases({ ward: '6B 外科病房' })).phrases.some((p) => p.scope === 'ward'), '醫師看不到護理病房共用片語')
    await as('nurse01')
    await PH.deletePhrase(wp.id, { ward: '6B 外科病房' })

    // 全院片語：醫師、護理師各一組；大家都能用，只有被指定的人能改；優先順序 個人 > 科室／病房 > 全院
    {
      const RR = await load('/src/services/phrase-rules.ts')
      const all = (await PH.listPhrases({ ward: ward5A }))
      const hosp = all.phrases.filter((p) => p.scope === 'hospital')
      ok(hosp.length >= 2 && hosp.every((p) => p.forRole === 'nurse' && !p.canEdit) && all.hospital.label === '全院護理共用' && !all.hospital.canEdit, '護理師看得到全院護理片語（不是醫師那組）；nurse01 沒被指定，不能改')
      const fall = all.phrases.filter((p) => p.code === 'fall')
      ok(fall[0].scope !== 'hospital' && fall.find((p) => p.scope === 'hospital')?.shadowedBy === '你的個人片語' && RR.expandPhrase('.fall', 5, all.phrases)?.text === fall[0].text, '同簡碼 .fall：個人的優先（全院的標「被你的個人片語蓋住」）')
      ok(all.phrases.find((p) => p.code === 'pain')?.scope === 'hospital' &&RR.expandPhrase('.pain', 5, all.phrases)?.text === all.phrases.find((p) => p.code === 'pain').text, '沒有更近的同簡碼：展開全院片語（.pain）')
      const h1 = hosp.find((p) => p.code === 'pain')
      await expectError(() => PH.savePhrase({ id: h1.id, code: 'pain', text: '亂改' }), '沒被指定的護理師改全院片語')
      await expectError(() => PH.deletePhrase(h1.id), '沒被指定的護理師刪全院片語')
      await expectError(() => PH.savePhrase({ code: 'x2', text: 'x', hospital: true }), '沒被指定的護理師新增全院片語')
      await as('nurse02')
      const nh = await PH.savePhrase({ code: 'iso', text: '依感染管制規範執行接觸隔離，進出病室洗手並穿戴隔離衣。', hospital: true })
      ok(nh.scope === 'hospital' && nh.forRole === 'nurse' && dbm.db.auditLogs[0].detail === '全院護理共用 .iso', '被指定的 nurse02 新增全院護理片語（寫稽核）')
      await expectError(() => PH.savePhrase({ code: 'iso', text: '重複', hospital: true }), '全院片語簡碼重複')
      await as('dr02')
      const drAll = await PH.listPhrases()
      ok(!drAll.phrases.some((p) => p.code === 'iso') && drAll.phrases.some((p) => p.code === 'ama' && p.scope === 'hospital') && drAll.hospital.label === '全院醫師共用', '醫師看不到護理那組，看得到全院醫師片語（.ama）')
      await expectError(() => PH.savePhrase({ code: 'x3', text: 'x', hospital: true }), '沒被指定的醫師新增全院片語')
      await as('dr01')
      const ama = (await PH.listPhrases()).phrases.find((p) => p.code === 'ama')
      ok(ama.canEdit && (await PH.savePhrase({ id: ama.id, code: 'ama', text: ama.text + '（已通知主治醫師）' })).text.endsWith('（已通知主治醫師）'), '被指定的 dr01 可以改全院醫師片語')
      const fu = (await PH.listPhrases()).phrases.filter((p) => p.code === 'fu')
      ok(fu[0].scope === undefined && fu[1]?.scope === 'hospital' && fu[1].shadowed, 'dr01 的個人 .fu 蓋住全院的 .fu')
      await as('nurse02')
      await PH.deletePhrase(nh.id)
      const PR3 = await load('/src/services/permission-rules.ts')
      ok(PR3.permDef('phrase.hospital').grantOnly && PR3.permDef('phrase.hospital').candidates.join() === 'doctor,nurse', '「維護全院片語」只能指定給個人（醫師、護理師）')
    }
    await as('dr01')
    {
      const { readFileSync } = await import('node:fs')
      const nn = readFileSync('src/pages/nursing/components/NursingNotesPanel.vue', 'utf8')
      const ho = readFileSync('src/pages/nursing/components/HandoverPanel.vue', 'utf8')
      const svc = readFileSync('src/services/phrase.ts', 'utf8')
      ok(nn.includes('usePhrases(() => props.admission.bed?.ward)') && ho.includes('usePhrases(() => props.ward)'), '護理紀錄、交班帶目前的病房（病房共用片語）')
      ok(svc.includes('rankOf(a) - rankOf(b)'), '「個人 > 科室／病房 > 全院」靠服務層排序＋ expandPhrase 取第一個，頁面不另寫')
    }
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
    // 原本就排好的調價（例：Metformin 下個月）要留著：只看今天、明天的有沒有取消（以前寫「之後都沒有調價」，抽到 Metformin 的那天會失敗）
    const keptLater = (row.priceChanges ?? []).filter((c) => c.from > addDays(T, 1))
    ok(R.drugPriceOn(restored, T).nhiPrice === now0 && (restored.priceChanges ?? []).every((c) => c.from < T || c.from > addDays(T, 1)) && keptLater.every((c) => restored.priceChanges.some((x) => x.from === c.from && x.nhiPrice === c.nhiPrice)),
      '改回原價：今天與明天的調價都取消，不留多餘紀錄（原本排好的之後的調價留著）')
    const nd = await M.saveDrug({ name: '調價測試新藥 1mg', generic: '', nhiCode: '', spec: '', category: '外用', unit: 'TUB', doseUnit: '', nhiPrice: 9, selfPrice: 20, safetyStock: 0, defaultDose: 1, defaultFreq: 'QD', defaultRoute: 'EXT', highAlert: false, indication: '測試', warning: '測試', timing: 'ANY', nameZh: '測試', active: true, priceFrom: addDays(T, 5) })
    ok(nd.nhiPrice === 9 && !nd.priceChanges, '新增藥品：價格就是原價（生效日不適用）')
    await as('clerk01')
    const { readFileSync } = await import('node:fs')
    const billingSrc = readFileSync('src/services/billing.ts', 'utf8')
    ok(billingSrc.includes('const date = visit.date') && billingSrc.includes('drugPriceOn(d, date)') && !/\bd\.(nhiPrice|selfPrice)\b/.test(billingSrc), '批價只用 drugPriceOn(藥, 看診日) 取價，不直接讀主檔價格')
  }

  // 開藥時的庫存提示用「可用量」（未過期批號），不是帳上總量；處方箋有效期只提醒、不擋
  console.log('\n[可用庫存與處方箋有效期]')
  {
    const { addDays } = await load('/src/utils/date.ts')
    const SR = await load('/src/services/stock-rules.ts')
    await as('dr01')
    const rows = await api.masterApi.listDrugs({ includeInactive: true })
    const opdLoc = dbm.db.stockLocations.find((l) => l.dispensesOpd).id
    const bad = rows.filter((d) => d.usable !== SR.usableQty(dbm.db.drugLots.filter((l) => l.drugId === d.id && l.locationId === opdLoc), T))
    ok(rows.length > 0 && !bad.length, `藥品清單的可用量 = 門診藥局未過期批號總和（和藥局發藥同一個 usableQty；病房常備不算）${bad.length ? '：' + bad.map((d) => d.id).join('、') : ''}`)
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
    const opdQty = (drugId) => dbm.db.drugLots.filter((l) => l.drugId === drugId && l.locationId === opd && l.expiry >= T).reduce((n, l) => n + l.qty, 0)
    let pd = dbm.db.dispenses.find((d) => d.status === 'pending' && medsOf2(d).every((m) => opdQty(m.drugId) >= m.qty))
    if (!pd) {
      // 今天的待調劑單可能剛好都含示範缺貨的藥（看當天種子）：先進貨補足，測試不依賴日期
      pd = dbm.db.dispenses.find((d) => d.status === 'pending')
      for (const m of medsOf2(pd)) if (opdQty(m.drugId) < m.qty) INV.postStock({ kind: 'in', type: 'adjust', reason: '測試', drugId: m.drugId, locationId: opd, qty: m.qty, lot: { lotNo: 'TEST-PD', expiry: '2099-12-31' }, ref: '測試：補足待調劑單' }, 'U301')
    }
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
      await P.savePurchaseDraft({ supplierId: '', lines: [] })
      ok(false, '空白採購單應被擋下')
    } catch (e) {
      ok(e.fields?.supplierId && e.fields?.lines, '空白採購單：供應商、品項一次標出')
    }
    try {
      await P.savePurchaseDraft({ supplierId: 'S001', lines: [{ drugId: 'M001', qty: 10, unitCost: 1 }, { drugId: 'M001', qty: 5, unitCost: 1 }, { drugId: 'M002', qty: 0, unitCost: 1 }] })
      ok(false, '重複品項應被擋下')
    } catch (e) {
      ok(e.fields?.['line-1']?.includes('重複') && e.fields?.['line-2']?.includes('正整數'), '同一種藥兩行、數量 0：標在那一行')
    }
    await expectError(() => P.savePurchaseDraft({ supplierId: 'S001', lines: [{ drugId: pend.lines.find((l) => l.restockId).drugId, qty: 1, unitCost: 1, restockId: pend.lines.find((l) => l.restockId).restockId }] }), '同一張補貨申請列入兩張採購單')

    // 開單 → 送出 → 核准（只有管理員）→ 分批到貨 → 到齊
    const draft = await P.savePurchaseDraft({ supplierId: 'S003', expectedDate: T, lines: [{ drugId: 'M002', qty: 30, unitCost: 2.5 }, { drugId: 'M003', qty: 10, unitCost: 3 }] })
    ok(draft.status === 'draft' && draft.no.startsWith(`PO${T.replace(/-/g, '')}-`) && draft.total === 105, `開單 ${draft.no}：草稿、金額 105 元`)
    await P.submitPurchase(draft.id)
    await expectError(() => P.savePurchaseDraft({ id: draft.id, supplierId: 'S001', lines: [{ drugId: 'M002', qty: 1, unitCost: 1 }] }), '送出後修改')
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
    const d2 = await P.savePurchaseDraft({ supplierId: 'S003', lines: [{ drugId: 'M004', qty: 5, unitCost: 9 }] })
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

  // 單一處方改服用時機：門診只存「和主檔不同、適用的」指定；住院開立時把有效時機存在醫囑上
  console.log('\n[單一處方改服用時機]')
  {
    const dr = await load('/src/services/drug-rules.ts')
    const { addDays } = await load('/src/utils/date.ts')
    const n = (drugTiming, rx) => dr.normalizeRxTiming(drugTiming, rx)
    ok(dr.effectiveTiming('WITH', 'PC') === 'PC' && dr.effectiveTiming('WITH', undefined) === 'WITH' && dr.effectiveTiming(undefined, undefined) === 'ANY', '有效時機：醫師指定優先，否則照主檔')
    ok(n('WITH', { timing: 'PC', freq: 'BID', route: 'PO' }) === 'PC' && n('WITH', { timing: 'WITH', freq: 'BID', route: 'PO' }) === undefined && n('WITH', { timing: '', freq: 'BID', route: 'PO' }) === undefined,
      '存檔整理：和主檔不同的才存；選回主檔、空值都不存')
    ok(n('PC', { timing: 'AC', freq: 'HS', route: 'PO' }) === undefined && n('ANY', { timing: 'PC', freq: 'Q8H', route: 'IV' }) === undefined && n('PC', { timing: 'XX', freq: 'QD', route: 'PO' }) === 'invalid',
      '不適用（睡前、非口服）不存；不認得的值回報錯誤')

    // 組套存檔走同一份整理（cleanRxTimings）；套用時原樣帶出
    await as('dr01')
    const med = (drugId, freq, route, timing) => ({ drugId, dose: 1, freq, route, days: 3, qty: 3, selfPay: false, ...(timing ? { timing } : {}) })
    const set = await api.orderSetApi.saveOrderSet({ name: '時機測試', diagnoses: [{ icd: 'J00', name: '急性鼻咽炎（感冒）', primary: true }], procedures: [],
      medications: [med('M015', 'BID', 'PO', 'PC'), med('M022', 'QD', 'PO', 'AC'), med('M007', 'HS', 'PO', 'AC'), med('M002', 'TID', 'PO', 'ANY')] })
    const tm = Object.fromEntries(set.medications.map((m) => [m.drugId, m.timing ?? '主檔']))
    ok(tm.M015 === 'PC' && tm.M022 === '主檔' && tm.M007 === '主檔' && tm.M002 === 'ANY', `組套只存有意義的指定（${Object.entries(tm).map(([k, v]) => `${k}：${v}`).join('、')}）`)
    await expectError(() => api.orderSetApi.saveOrderSet({ name: '時機錯誤', diagnoses: [], procedures: [], medications: [med('M015', 'BID', 'PO', 'XX')] }), '存不認得的服用時機')
    const ex = await api.orderSetApi.expandOrderSet(set.id)
    ok(ex.medications.find((m) => m.drugId === 'M015').timing === 'PC', '套用組套帶出醫師指定的時機')
    await api.orderSetApi.deleteOrderSet(set.id)
    const { readFileSync } = await import('node:fs')
    ok(/cleanRxTimings\(e\.medications\)/.test(readFileSync('src/services/opd.ts', 'utf8')), '完成看診也走同一份整理（cleanRxTimings）')

    // 種子：糖尿病追蹤的 Metformin 醫師改飯後 → 藥局處方表、藥袋照指定印
    await as('ph01')
    const rxEnc = dbm.db.encounters.find((e) => e.medications.some((m) => m.drugId === 'M015' && m.timing === 'PC') && dbm.db.dispenses.some((d) => d.encounterId === e.id))
    ok(!!rxEnc, '示範資料有醫師指定時機的處方（Metformin 隨餐 → 飯後）')
    const rxView = await api.pharmacyApi.getDispense(dbm.db.dispenses.find((d) => d.encounterId === rxEnc.id).id)
    const met = rxView.items.find((it) => it.drugId === 'M015')
    const other = rxView.items.find((it) => it.drugId !== 'M015')
    ok(met.timingText === '飯後服用' && met.timingShort === '飯後' && met.timingByDoctor === true && other && !other.timingByDoctor,
      `調劑單：Metformin 印「${met.timingText}」並標醫師指定；同張其他藥照主檔（${other?.drugName}：${other?.timingShort || '不印'}）`)

    // 住院排程：一天幾次的對齊用餐，間隔型、非口服照固定時間
    const mt = (freq, timing, route = 'PO') => dr.marTimes(freq, dbm.db.frequencies.find((f) => f.code === freq).times, timing, route).join(',')
    ok(mt('TID', 'AC') === '07:00,11:30,17:00' && mt('TID', 'PC') === '08:00,12:30,18:00' && mt('TID', 'WITH') === '07:30,12:00,17:30' && mt('QD', 'EMPTY') === '06:30',
      `TID 飯前 ${mt('TID', 'AC')}、飯後 ${mt('TID', 'PC')}、隨餐 ${mt('TID', 'WITH')}；QD 空腹 ${mt('QD', 'EMPTY')}`)
    ok(mt('BID', 'PC') === '08:00,18:00' && mt('QID', 'AC') === '07:00,11:30,17:00,21:00', 'BID 早晚兩餐；QID 第 4 次在睡前 21:00')
    ok(mt('TID', 'ANY') === '09:00,13:00,17:00' && mt('Q8H', 'AC') === '06:00,14:00,22:00' && mt('Q12H', 'PC') === '09:00,21:00' && mt('TID', 'PC', 'IV') === '09:00,13:00,17:00' && mt('HS', 'AC') === '21:00',
      '飯前飯後皆可、間隔型（Q8H、Q12H）、非口服、睡前照頻率的固定時間')

    const adm = dbm.db.admissions.find((a) => a.status === 'admitted')
    await as('dr02')
    const tomorrow = addDays(T, 1)
    const marOf = (o) => dbm.db.mar.filter((m) => m.orderId === o.id && m.scheduledAt.startsWith(tomorrow)).map((m) => m.scheduledAt.slice(11)).sort().join(',')
    const add = (drugId, freq, route, timing) => api.ipdApi.addOrder({ admissionId: adm.id, type: 'long', category: 'medication', drugId, content: '', dose: 1, freq, route, allowDuplicate: true, ...(timing !== undefined ? { timing } : {}) })
    const ome = await add('M022', 'QD', 'PO')
    const metO = await add('M015', 'TID', 'PO', 'PC')
    const iv = await add('M036', 'Q12H', 'IV', 'PC')
    const hs = await add('M007', 'HS', 'PO', 'AC')
    ok(ome.timing === 'AC' && !ome.timingSet && marOf(ome) === '07:00' && ome.timingShort === '飯前', `照主檔：Omeprazole 存「飯前」在醫囑上，明天 ${marOf(ome)} 給（以前 09:00）`)
    ok(metO.timing === 'PC' && metO.timingSet === true && marOf(metO) === '08:00,12:30,18:00', `醫師指定飯後：Metformin TID 排 ${marOf(metO)}，標醫師指定`)
    ok(iv.timing === undefined && marOf(iv) === '09:00,21:00' && hs.timing === undefined && marOf(hs) === '21:00', '非口服、睡前不存時機（傳入的被忽略），照固定時間')
    await expectError(() => add('M015', 'TID', 'PO', 'XX'), '住院醫囑不認得的服用時機')
    const marV = (await api.ipdApi.listMar(adm.id, tomorrow)).filter((m) => m.orderId === ome.id || m.orderId === iv.id)
    ok(marV.find((m) => m.orderId === ome.id).timingShort === '飯前' && marV.find((m) => m.orderId === iv.id).timingShort === '', '護理站給藥列標「飯前」（說明為什麼是 07:00）；IV 不標')

    // 主檔之後改時機：已開的醫囑不跟著變，不會多出一劑
    const omeDrug = dbm.db.drugs.find((d) => d.id === 'M022')
    omeDrug.timing = 'PC'
    const day2 = addDays(T, 2)
    await api.ipdApi.listMar(adm.id, day2)
    const day2Times = dbm.db.mar.filter((m) => m.orderId === ome.id && m.scheduledAt.startsWith(day2)).map((m) => m.scheduledAt.slice(11))
    ok(day2Times.join(',') === '07:00' && marOf(ome) === '07:00', `主檔改成飯後後，已開的醫囑仍 ${day2Times.join(',')} 一劑（時機存在醫囑上，沒有多排 08:00）`)
    omeDrug.timing = 'AC'
    for (const o of [ome, metO, iv, hs]) await api.ipdApi.stopOrder(o.id)

    // 示範資料：住院的給藥時間也用同一份規則；糖尿病病人的 Metformin 醫師指定飯後
    const seedMet = dbm.db.ipdOrders.find((o) => o.drugId === 'M015' && o.timingSet && o.status === 'active')
    ok(seedMet && seedMet.timing === 'PC' && dbm.db.mar.filter((m) => m.orderId === seedMet.id && m.scheduledAt.startsWith(T)).map((m) => m.scheduledAt.slice(11)).join(',') === '08:00,18:00',
      '示範住院醫囑：Metformin BID 醫師指定飯後，排 08:00、18:00')
    const seedOk = dbm.db.ipdOrders.filter((o) => o.category === 'medication' && o.type === 'long' && o.freq !== 'PRN' && o.createdAt < T && !o.timingSet)
    const bad = seedOk.filter((o) => {
      const f = dbm.db.frequencies.find((x) => x.code === o.freq)
      const want = dr.marTimes(o.freq, f.times, o.timing, o.route)
      return dbm.db.mar.filter((m) => m.orderId === o.id && m.scheduledAt.startsWith(T)).some((m) => !want.includes(m.scheduledAt.slice(11)))
    })
    if (bad.length) console.log(bad.map((o) => [o.id, o.drugId, o.freq, o.route, o.timing, o.createdAt, dbm.db.mar.filter((m) => m.orderId === o.id && m.scheduledAt.startsWith(T)).map((m) => m.scheduledAt.slice(11)).join(',')].join(' ')).join(' | '))
    ok(bad.length === 0, `示範資料 ${seedOk.length} 筆長期給藥醫囑的排程都符合 marTimes`)
    const srcSeed = readFileSync('src/mock/seed.ts', 'utf8')
    const srcIpd = readFileSync('src/services/ipd.ts', 'utf8')
    ok(srcSeed.includes('marTimes(') && srcIpd.includes('marTimes(') && !/for \(const t of f\.times\)/.test(srcSeed) && !/for \(const t of times\)[\s\S]{0,20}\?\.times/.test(srcIpd),
      '排程只有一份規則：服務層與種子都呼叫 marTimes，沒有另外照頻率固定時間排')
    const pages = ['src/pages/opd/components/MedicationEditor.vue', 'src/pages/ipd/components/OrderDialog.vue'].map((f) => readFileSync(f, 'utf8'))
    ok(pages.every((t) => t.includes('timingApplies(')) && !pages.some((t) => /'HS', 'PRN'|\['HS'/.test(t)), '開藥畫面的時機選單用 timingApplies 判斷，不自己列睡前／需要時')
  }

  // 醫令點數、掛號費、部分負擔的生效日：和藥價同一套（dated-rules），批價看看診日
  console.log('\n[醫令點數・掛號費・部分負擔生效日]')
  {
    const D = await load('/src/services/dated-rules.ts')
    const billing = await load('/src/services/billing.ts')
    const { addDays } = await load('/src/utils/date.ts')
    const keys = ['v']
    const ch = [{ from: '2026-12-01', v: 2 }, { from: '2027-01-01', v: 3 }]
    ok(D.valueOn({ v: 1 }, ch, '2026-11-30', keys).v === 1 && D.valueOn({ v: 1 }, ch, '2026-12-01', keys).v === 2 && D.valueOn({ v: 1 }, ch, '2027-02-01', keys).v === 3, '某天的值：生效日 ≤ 那天的最後一筆，之前是原值')
    ok(D.nextChange(ch, '2026-12-01').from === '2027-01-01' && D.nextChange(ch, '2027-01-01') === undefined, '下一筆已排定的調整')
    ok(D.applyChange({ v: 1 }, ch, { from: '2026-12-01', v: 1 }, keys).map((c) => c.from).join() === '2027-01-01' && D.applyChange({ v: 1 }, [{ from: '2026-12-01', v: 2 }], { from: '2026-11-20', v: 2 }, keys).map((c) => c.from).join() === '2026-11-20',
      '改回原值＝取消那天的調整；提前一筆相同的值，後面那筆變成多餘也拿掉')
    ok(D.checkFrom(addDays(T, -1), T) && D.checkFrom('', T) && D.checkFrom(T, T) === null, '生效日：不能早於今天、不能空白')

    await as('admin')
    const M = api.masterApi
    const A = api.adminApi
    const tomorrow = addDays(T, 1)
    const yesterday = addDays(T, -1)

    // 醫令：明天起調點數
    const p001 = dbm.db.procedures.find((x) => x.id === 'P001')
    const pts0 = p001.points
    await expectError(() => M.saveProcedure({ ...p001, points: pts0 + 50, priceFrom: yesterday }), '醫令點數生效日早於今天')
    await M.saveProcedure({ ...p001, points: pts0 + 50, priceFrom: tomorrow })
    const p1 = dbm.db.procedures.find((x) => x.id === 'P001')
    const lv = (await M.listProcedures({ includeInactive: true })).find((x) => x.id === 'P001')
    ok(p1.points === pts0 && p1.priceChanges?.length === 1 && lv.points === pts0 && lv.nextPrice?.points === pts0 + 50 && lv.nextPrice.from === tomorrow,
      `診察費明天起 ${pts0}→${pts0 + 50} 點：主檔原值不動、記一筆調整；清單顯示今天 ${lv.points} 點與「${tomorrow.slice(5)} 起 ${lv.nextPrice?.points}」`)
    ok(billing.procPriceOn(p1, T).points === pts0 && billing.procPriceOn(p1, tomorrow).points === pts0 + 50, '醫令某天的點數：今天舊、明天新')
    const np = await M.saveProcedure({ code: 'TEST-D1', name: '生效日測試醫令', category: '處置', points: 30, selfPrice: 60, active: true, priceFrom: addDays(T, 5) })
    ok(np.points === 30 && !np.priceChanges, '新增醫令：點數就是原值（生效日不適用）')

    // 掛號費：明天起；今天的預估不變，明天診次的預估用新的
    const id01 = dbm.db.identities.find((i) => i.code === '01')
    const fee0 = id01.regFee
    await expectError(() => A.saveIdentity({ ...id01, regFee: fee0 + 50, feeFrom: yesterday }), '掛號費生效日早於今天')
    const ri = await A.saveIdentity({ ...id01, regFee: fee0 + 50, feeFrom: tomorrow })
    const iv = (await M.listIdentities()).find((i) => i.code === '01')
    ok(ri.affectedPending === 0 && iv.regFee === fee0 && iv.nextFee?.regFee === fee0 + 50, `掛號費明天起 ${fee0}→${fee0 + 50}：清單今天仍 ${iv.regFee}、標明天起；還沒有人受影響（0 筆待批價）`)
    await as('clerk01')
    const regOf = (est) => est.lines.find((l) => l.kind === 'reg').amount
    const estToday = await api.bookingApi.estimateFee('01', '01')
    const estTomorrow = await api.bookingApi.estimateFee('01', '01', false, tomorrow)
    ok(regOf(estToday) === fee0 && regOf(estTomorrow) === fee0 + 50, `掛號頁預估依看診日：今天 ${regOf(estToday)}、明天的診次 ${regOf(estTomorrow)}`)

    // 部分負擔：今天起調整；昨天看診、還沒批價的照舊（以前會被改價）
    await as('admin')
    const s0 = await A.getBillingSettings()
    const sv = await A.saveBillingSettings({ ...s0, basicCopay: s0.basicCopay + 20 })
    const sNow = await A.getBillingSettings()
    ok(sv.from === T && sNow.basicCopay === s0.basicCopay + 20 && !sNow.next, `部分負擔今天起 ${s0.basicCopay}→${sNow.basicCopay}`)
    const lk = { identity: { ...dbm.db.identities.find((i) => i.code === '01') }, settings: dbm.db.billingSettings, drug: (x) => dbm.db.drugs.find((d) => d.id === x), procedure: (x) => dbm.db.procedures.find((d) => d.id === x) }
    const enc = { medications: [], procedures: [] }
    const basicOf = (date) => billing.calcChargeLines({ date, caseType: '01' }, enc, lk).find((l) => l.kind === 'copay-basic').amount
    ok(basicOf(yesterday) === s0.basicCopay && basicOf(T) === s0.basicCopay + 20, `批價依看診日：昨天看診 ${basicOf(yesterday)} 元（照舊）、今天看診 ${basicOf(T)} 元`)
    const pend = dbm.db.visits.filter((v) => v.status === 'consulted')
    ok(sv.affectedPending === pend.filter((v) => v.date >= T).length, `回報受影響的待批價 ${sv.affectedPending} 筆（只算今天起看診的，共 ${pend.length} 筆待批價）`)
    const regLine = billing.calcChargeLines({ date: tomorrow, caseType: '01' }, enc, lk).find((l) => l.kind === 'reg')
    const consult = billing.calcChargeLines({ date: tomorrow, caseType: '01' }, enc, lk).find((l) => l.kind === 'consult')
    ok(regLine.amount === fee0 + 50 && consult.amount === pts0 + 50, '明天看診：掛號費、診察費都用明天起的新值')

    // 取消：把那天的值改回原值，不留紀錄
    await A.saveBillingSettings({ ...s0 })
    await A.saveIdentity({ ...id01, regFee: fee0, feeFrom: tomorrow })
    await M.saveProcedure({ ...p1, points: pts0, priceFrom: tomorrow })
    ok(!dbm.db.billingSettings.changes && !dbm.db.identities.find((i) => i.code === '01').feeChanges && !dbm.db.procedures.find((x) => x.id === 'P001').priceChanges,
      '改回原值＝取消排定的調整，三種都不留多餘紀錄')
    ok(dbm.db.auditLogs.some((l) => l.action === '修改就醫身分' && l.detail.includes(`${tomorrow} 起`)) && dbm.db.auditLogs.some((l) => l.action === '修改醫令主檔' && l.detail.includes(`${tomorrow} 起`)),
      '稽核記下哪天起、從多少改成多少')
    const { readFileSync } = await import('node:fs')
    const bsrc = readFileSync('src/services/billing.ts', 'utf8')
    ok(!/identity\.regFee|consult\.(points|selfPrice)|proc\.(points|selfPrice)|lk\.settings\.basicCopay/.test(bsrc) && bsrc.includes('regFeeOn(identity, date)') && bsrc.includes('procPriceOn(proc, date)'),
      '批價不直接讀主檔的掛號費、點數、部分負擔，一律依看診日查')
  }

  // 供應商主檔：採購單只能選主檔裡啟用中的；統編檢查碼；停用前檢查進行中的單；以前的進價
  console.log('\n[供應商主檔]')
  {
    const R = await load('/src/services/purchase-rules.ts')
    ok(R.taxIdProblem('') === null && R.taxIdProblem('04595257') === null && R.taxIdProblem('10000073') === null, '統編：空白不檢查；檢查碼正確的通過（含第 7 碼是 7 的特例）')
    ok(R.taxIdProblem('04595258')?.includes('檢查碼') && R.taxIdProblem('1234567')?.includes('8 碼') && R.taxIdProblem('0459525A')?.includes('8 碼'), '統編：打錯一碼擋下、不是 8 碼數字擋下')
    ok(R.normalizeSupplierName(' 杏林藥業（股）  公司') === R.normalizeSupplierName('杏林藥業(股) 公司'), '名稱比對：空白、全形半形括號視為相同')

    const P = api.purchaseApi
    await as('nurse01')
    await expectError(() => P.listSuppliers(), '護理師看供應商')
    await as('ph01')
    const all = await P.listSuppliers({ includeInactive: true })
    const act = await P.listSuppliers()
    ok(all.length === 4 && act.length === 3 && !act.some((x) => x.id === 'S004'), `示範資料 ${all.length} 家（1 家停用）；預設只列往來中的`)
    ok(dbm.db.purchaseOrders.every((po) => dbm.db.suppliers.some((x) => x.id === po.supplierId) && po.supplier), '每張採購單都指向供應商主檔，並存開單時的名稱')
    ok(all.every((x) => R.taxIdProblem(x.taxId) === null), '示範資料的統編都符合檢查碼')

    // 新增：名稱必填、同名（含停用的）擋、統編錯擋、統編重複擋——一次標出
    try {
      await P.saveSupplier({ name: '', taxId: '12345678', active: true })
      ok(false, '空白名稱應被擋下')
    } catch (e) {
      ok(e.fields?.name && e.fields?.taxId, '新增供應商：名稱空白、統編錯一次標出')
    }
    await expectError(() => P.saveSupplier({ name: '安心藥品有限公司', active: true }), '新增和停用中的同名供應商')
    await expectError(() => P.saveSupplier({ name: '新藥商', taxId: '24536801', active: true }), '統編和現有供應商重複')
    const ns = await P.saveSupplier({ name: '  新興藥品  有限公司 ', taxId: '10000073', contact: '林小姐', phone: '02-1234-5678', active: true })
    ok(ns.id === 'S005' && ns.name === '新興藥品 有限公司' && ns.taxId === '10000073' && dbm.db.auditLogs[0].action === '新增供應商', `新增 ${ns.id}：名稱去多餘空白、寫稽核`)

    // 採購單：只能選啟用中的；名稱存當時的
    await expectError(() => P.savePurchaseDraft({ supplierId: 'S004', lines: [{ drugId: 'M002', qty: 1, unitCost: 1 }] }), '採購單選停用的供應商')
    await expectError(() => P.savePurchaseDraft({ supplierId: 'NOPE', lines: [{ drugId: 'M002', qty: 1, unitCost: 1 }] }), '採購單選不存在的供應商')
    const d = await P.savePurchaseDraft({ supplierId: ns.id, lines: [{ drugId: 'M002', qty: 10, unitCost: 2 }] })
    ok(d.supplierId === ns.id && d.supplier === ns.name, '採購單記供應商 id 與當時的名稱')
    // 有進行中的單不能停用；改名不影響舊單
    await expectError(() => P.saveSupplier({ ...ns, active: false }), '有進行中採購單的供應商停用')
    const renamed = await P.saveSupplier({ ...ns, name: '新興藥品股份有限公司' })
    ok(renamed.name === '新興藥品股份有限公司' && (await P.getPurchaseOrder(d.id)).supplier === ns.name, '供應商改名：舊採購單仍是開單時的名稱')
    ok((await P.listSuppliers()).find((x) => x.id === ns.id).openOrders.includes(d.no), '清單列出進行中的採購單號（停用前要先處理）')
    await P.cancelPurchase(d.id, '測試取消')
    const off = await P.saveSupplier({ ...renamed, active: false })
    ok(!off.active && !(await P.listSuppliers()).some((x) => x.id === ns.id), '取消採購單後可以停用；停用的不在採購單選單')

    // 以前的進價：每種藥最近一次，附其他供應商最近的
    const pr = await P.supplierPrices('S001')
    const counted = dbm.db.purchaseOrders.filter((po) => po.supplierId === 'S001' && ['ordered', 'received', 'closed'].includes(po.status))
    const latest = (drugId) => counted.filter((po) => po.lines.some((l) => l.drugId === drugId)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    ok(pr.length > 0 && pr.every((x) => latest(x.drugId).no === x.poNo && latest(x.drugId).lines.find((l) => l.drugId === x.drugId).unitCost === x.unitCost),
      `台灣藥品 ${pr.length} 種藥的最近進價都對（單號、價格）`)
    const withOther = pr.find((x) => x.other)
    ok(!!withOther && withOther.other.supplier !== '台灣藥品股份有限公司', `附其他供應商比價（例：${withOther?.drugName} 這家 ${withOther?.unitCost}、${withOther?.other?.supplier} ${withOther?.other?.unitCost}）`)
    ok((await P.supplierPrices(ns.id)).length === 0, '取消的採購單不算進價紀錄')
    const pendPo = await P.savePurchaseDraft({ supplierId: 'S003', lines: [{ drugId: 'M002', qty: 10, unitCost: 0.5 }] })
    await P.submitPurchase(pendPo.id)
    ok(!(await P.supplierPrices('S003')).some((x) => x.poNo === pendPo.no), `待核准的 ${pendPo.no} 不算進價紀錄（可能被退回）`)
    await P.cancelPurchase(pendPo.id, '測試取消')
    ok((await P.listSuppliers()).every((x) => x.orderCount > 0), '示範資料：三家往來中的都有進貨紀錄（同一天到貨依藥品輪替分給三家）')
    const cand = await P.purchaseCandidates()
    ok(cand.filter((c) => c.last).every((c) => dbm.db.suppliers.some((x) => x.id === c.last.supplierId)), '需求清單的「上次」帶供應商 id（開單時可直接選上）')
  }

  // 密碼期限與歷史：從本人設定那天算、到期前提醒、過期只能改密碼（不鎖帳號）；不可重複最近幾次
  console.log('\n[密碼期限與歷史]')
  {
    const R = await load('/src/services/password-rules.ts')
    const { addDays } = await load('/src/utils/date.ts')
    const a80 = R.passwordAge(addDays(T, -80), T, 90)
    const a90 = R.passwordAge(addDays(T, -90), T, 90)
    ok(a80.daysLeft === 10 && a80.warn && !a80.expired && a90.daysLeft === 0 && a90.expired && !a90.warn && R.passwordAge(addDays(T, -60), T, 90).warn === false,
      '期限：80 天前設定還剩 10 天（提醒期）；第 90 天起過期；還剩 30 天不提醒')
    ok(R.passwordAge(addDays(T, -500), T, 0) === null && R.passwordAge(undefined, T, 90) === null, '期限 0＝不限；不知道設定日不算')
    const recent = ['cur1', 'old2', 'old3', 'old4']
    ok(R.reusedPassword('old3', recent, 3)?.includes('最近 3 次') && R.reusedPassword('old4', recent, 3) === null && R.reusedPassword('cur1', recent, 0) === '不可與目前密碼相同' && R.reusedPassword('old2', recent, 0) === null,
      '不可重複最近 3 次（含目前）；0 次時仍不能和目前相同')
    const cp = R.checkPasswordPolicy
    ok(!Object.keys(cp({ maxDays: 0, history: 0 })).length && !Object.keys(cp({ maxDays: 90, history: 3 })).length && cp({ maxDays: 29, history: 3 }).maxDays && cp({ maxDays: 366, history: 3 }).maxDays && cp({ maxDays: 90, history: 11 }).history && cp({ maxDays: 1.5, history: -1 }).history,
      '設定範圍：期限 0 或 30–365、歷史 0–10 的整數')

    ok(dbm.db.users.every((u) => u.passwordSetOn) && dbm.db.users.find((u) => u.username === 'nurse02').passwordSetOn === addDays(T, -80), '示範帳號都有密碼設定日；nurse02 是 80 天前（示範快到期）')
    const n2 = await as('nurse02')
    ok(n2.passwordDaysLeft === 10 && !n2.passwordExpired && !('passwordHistory' in n2) && !('password' in n2), 'nurse02 登入：提示 10 天後到期；登入資料不含密碼與歷史')
    ok(!(await as('ph01')).passwordDaysLeft, '剛設定的帳號不提醒')

    // 管理員縮短期限：nurse02 立刻過期（不鎖帳號）
    await as('admin')
    await expectError(() => api.authApi.savePasswordPolicy({ maxDays: 10, history: 3 }), '密碼期限設 10 天')
    const pol = await api.authApi.savePasswordPolicy({ maxDays: 60, history: 3 })
    ok(pol.expiredUsers === 1 && dbm.db.auditLogs[0].detail.includes('密碼期限 90→60'), '期限改成 60 天：回報 1 個帳號已過期、寫稽核')
    const ur = (await api.adminApi.listUsers()).find((u) => u.username === 'nurse02')
    ok(ur.passwordState?.expired === true && !('passwordHistory' in ur), '帳號清單標 nurse02 密碼過期（不含密碼歷史）')
    const ex = await as('nurse02')
    ok(ex.passwordExpired === true, '過期仍能登入（不鎖帳號），版面依 passwordExpired 蓋上變更畫面')
    try {
      await api.nursingApi.listWardPatients('5A')
      ok(false, '過期應擋下其他操作')
    } catch (e) {
      ok(e.code === 'PASSWORD_CHANGE' && e.message.includes('過期'), `過期時其他 API 一律擋下 → 「${e.message}」`)
    }

    // 改密碼：規則、不可重複最近 3 次
    const ch = (current, next) => api.authApi.changeOwnPassword({ current, next })
    await ch('1234', 'Nurse111')
    const u2 = () => dbm.db.users.find((u) => u.username === 'nurse02')
    ok(u2().passwordSetOn === T && u2().passwordHistory[0] === '1234' && dbm.db.auditLogs[0].action === '密碼過期變更', '改了就重新起算、舊密碼進歷史、稽核記「密碼過期變更」')
    ok(!api.authApi.currentUser().passwordExpired, '改完不再過期，可以照常操作')
    await ch('Nurse111', 'Nurse222')
    await ch('Nurse222', 'Nurse333')
    try {
      await ch('Nurse333', 'Nurse111')
      ok(false, '最近 3 次用過的應被擋下')
    } catch (e) {
      ok(e.fields?.next?.includes('最近 3 次'), `改回 3 次前的密碼 → 「${e.fields?.next}」`)
    }
    await ch('Nurse333', 'Nurse444')
    ok(u2().password === 'Nurse444' && u2().passwordHistory.slice(0, 4).join() === 'Nurse333,Nurse222,Nurse111,1234', '更早的（第 4 次前）可以再用；歷史新到舊保留')

    // 管理員重設：舊密碼也進歷史，本人不能改回外洩的那組
    await as('admin')
    await api.adminApi.resetPassword(u2().id, 'Temp9999')
    ok(u2().passwordHistory[0] === 'Nurse444' && u2().mustChangePassword, '管理員重設：外洩的舊密碼進歷史')
    await api.authApi.login('nurse02', 'Temp9999')
    try {
      await ch('Temp9999', 'Nurse444')
      ok(false, '改回重設前的密碼應被擋下')
    } catch (e) {
      ok(e.fields?.next?.includes('最近'), '本人不能改回重設前（外洩）的密碼')
    }
    await ch('Temp9999', 'Nurse555')
    ok(dbm.db.auditLogs[0].action === '首次變更密碼' && u2().passwordHistory[0] === 'Temp9999', '管理員給的暫時密碼也記進歷史')

    // 期限 0＝不限；還原
    await as('admin')
    await api.authApi.savePasswordPolicy({ maxDays: 0, history: 3 })
    Object.assign(u2(), { password: '1234', passwordSetOn: addDays(T, -500) })
    ok(!(await as('nurse02')).passwordExpired, '期限 0：500 天前設定的也不過期')
    await as('admin')
    await api.authApi.savePasswordPolicy({ maxDays: 90, history: 3 })
    Object.assign(u2(), { password: '1234', passwordSetOn: addDays(T, -80) })
    delete u2().passwordHistory
    const { readFileSync } = await import('node:fs')
    const httpSrc = readFileSync('src/services/http.ts', 'utf8')
    ok(/passwordAgeOf\(u!\)\?\.expired\) fail\('密碼已過期/.test(httpSrc), '過期檢查在服務層 requireUser（直接呼叫 API 也擋），不是只有畫面')
  }

  // 醫囑疑問直接修改：畫面一步，資料上停止舊的＋開新的；檢查與開立共用；從下一劑開始（不多給一劑）
  console.log('\n[修改住院醫囑]')
  {
    const { addMinutes } = await load('/src/utils/date.ts')
    const I = api.ipdApi
    const db = () => dbm.db
    const nowS = nowStr()
    // 找一筆長期給藥（非 PRN），今天稍後還有待給的劑量
    const old = db().ipdOrders.find((o) => o.status === 'active' && o.category === 'medication' && o.type === 'long' && o.freq !== 'PRN' && !o.queries?.some((q) => !q.replyAt) &&
      db().admissions.find((a) => a.id === o.admissionId)?.status === 'admitted' &&
      db().mar.some((m) => m.orderId === o.id && m.status === 'pending' && m.scheduledAt.startsWith(T) && m.scheduledAt > nowS))
    ok(!!old, '有一筆今天稍後還有待給劑量的長期給藥醫囑')
    const drug = db().drugs.find((d) => d.id === old.drugId)
    await as('nurse01')
    await api.nursingApi.queryOrder(old.id, '劑量好像偏低')
    await expectError(() => I.reviseOrder(old.id, { dose: old.dose * 2, freq: old.freq, route: old.route, reason: '依體重' }), '護理師修改醫囑')
    await as('dr02')
    try {
      await I.reviseOrder(old.id, { dose: old.dose, freq: old.freq, route: old.route, reason: ' ' })
      ok(false, '沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'reason', '修改要寫原因')
    }
    await expectError(() => I.reviseOrder(old.id, { dose: old.dose, freq: old.freq, route: old.route, ...(old.timingSet ? { timing: old.timing } : {}), reason: '沒改' }), '沒有任何變更')
    await expectError(() => I.reviseOrder(old.id, { dose: old.dose * 100, freq: old.freq, route: old.route, reason: '打錯' }), '劑量不合理（開立的檢查同一份）')
    try {
      await I.reviseOrder(old.id, { dose: old.dose * 4, freq: old.freq, route: old.route, reason: '加量' })
      ok(false, '劑量偏高應先確認')
    } catch (e) {
      ok(e.code === 'CONFLICT' && e.message.startsWith('劑量偏高'), `劑量偏高沒確認 → 「${e.message}」`)
    }
    ok(db().ipdOrders.find((o) => o.id === old.id).status === 'active', '被擋下時舊醫囑不動（同一筆交易）')
    const nonMed = db().ipdOrders.find((o) => o.status === 'active' && o.category !== 'medication')
    if (nonMed) await expectError(() => I.reviseOrder(nonMed.id, { dose: 1, freq: 'QD', route: 'PO', reason: 'x' }), '修改護理／飲食醫囑（停止後另開）')
    const stat = db().ipdOrders.find((o) => o.status === 'active' && o.type === 'stat')
    if (stat) await expectError(() => I.reviseOrder(stat.id, { dose: 1, freq: 'STAT', route: 'PO', reason: 'x' }), '修改臨時醫囑')

    // 下一劑已經提早給了：新醫囑不能在同一時間再排一劑
    const next = db().mar.filter((m) => m.orderId === old.id && m.status === 'pending' && m.scheduledAt > nowS).sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))[0]
    next.status = 'given'
    next.executedAt = nowS
    next.nurseId = 'U201'
    const nv = await I.reviseOrder(old.id, { dose: old.dose * 2, freq: old.freq, route: old.route, reason: '依腎功能調整' })
    const o1 = db().ipdOrders.find((o) => o.id === old.id)
    const o2 = db().ipdOrders.find((o) => o.id === nv.id)
    ok(o1.status === 'stopped' && o1.replacedBy === o2.id && o2.replaces === o1.id && o2.drugId === o1.drugId && o2.dose === old.dose * 2 && o2.reviseReason === '依腎功能調整',
      '資料上是兩筆：舊的停止、新的接手，互相標記（以前的給藥紀錄仍掛在舊醫囑上）')
    ok(o2.startAt === addMinutes(next.scheduledAt, 1) && !db().mar.some((m) => m.orderId === o2.id && m.scheduledAt === next.scheduledAt) && db().mar.some((m) => m.orderId === o2.id && m.scheduledAt > next.scheduledAt),
      `從下一劑開始：${next.scheduledAt.slice(11)} 那劑已提早給，新醫囑從 ${o2.startAt.slice(11)} 起算，不會再排一劑`)
    const q = o1.queries.at(-1)
    ok(q.resolution === 'modified' && q.reply.includes('→') && q.reply.includes('依腎功能調整') && !o2.ackAt && db().auditLogs[0].action === '修改住院醫囑',
      `疑問記為「已修改」並寫出改了什麼（「${q.reply}」）；新醫囑要護理師核對；寫稽核`)
    ok(nv.replacesText?.startsWith(`每次 ${old.dose} `) && (await I.listOrders(old.admissionId)).find((o) => o.id === old.id).replacedByText?.startsWith(`每次 ${old.dose * 2} `), '醫囑清單：新的標「修改自」、舊的標「已修改為」')
    await expectError(() => I.reviseOrder(old.id, { dose: old.dose, freq: old.freq, route: old.route, reason: '再改' }), '修改已停止的醫囑')
    await as('nurse01')
    const ng = (await api.nursingApi.listNursingOrders(old.admissionId)).flatMap((g) => g.orders)
    ok(ng.find((o) => o.id === o2.id)?.needsAck && ng.find((o) => o.id === o1.id)?.lastReply?.resolution === 'modified', '護理站：新醫囑待核對、舊醫囑看得到醫師的修改回覆')
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/services/ipd.ts', 'utf8')
    ok((src.match(/doseLevel\(drug,/g) ?? []).length === 1 && (src.match(/createOrder\(user, a,/g) ?? []).length === 3, '開立、修改、依營養師建議開管灌共用 createOrder：劑量、重複、服用時機、管灌的檢查只有一份')
  }

  // 門診退藥：已發出的藥整張收回，退回發出時的批號；之後櫃台才能作廢或退費
  console.log('\n[門診退藥]')
  {
    const PH = api.pharmacyApi
    const db = () => dbm.db
    const lotSum = (drugId, loc) => db().drugLots.filter((l) => l.drugId === drugId && l.locationId === loc).reduce((n, l) => n + l.qty, 0)
    // 舊資料（種子發的藥沒記 txnIds）：用「領藥號＋發藥日」找回發藥異動
    // 種子：帳本期間內發的藥都記著發藥異動，異動上的領藥號＝最後編好的領藥號（以前種子重編領藥號後沒跟著改，帳上的單號指到別人的處方）
    const ledgerStart = (await load('/src/utils/date.ts')).addDays(T, -30)
    const inLedger = db().dispenses.filter((d) => d.status === 'dispensed' && d.dispensedAt >= ledgerStart)
    ok(inLedger.length > 0 && inLedger.every((d) => d.txnIds?.length === db().encounters.find((e) => e.id === d.encounterId).medications.length && d.txnIds.every((id) => db().stockTxns.find((x) => x.id === id)?.ref === `領藥號 ${d.pickupNo}`)),
      `種子：帳本期間內 ${inLedger.length} 張已發藥的單都記著發藥異動，異動單號＝領藥號`)
    const pre = db().dispenses.find((d) => d.status === 'dispensed' && !d.txnIds)
    if (pre) {
      await as('ph01')
      try {
        await returnAll(pre.id, '測試')
        ok(false, '開帳前發的藥應不能退藥')
      } catch (e) {
        ok(e.message.includes('開帳前'), `帳本開帳前發的藥 → 「${e.message}」（不猜批號）`)
      }
    }
    const old = db().dispenses.find((d) => d.status === 'dispensed' && d.txnIds?.length &&
      db().encounters.find((e) => e.id === d.encounterId).medications.every((m) => !db().stocktakes.some((st) => (st.status === 'counting' || st.status === 'submitted') && st.lines.some((l) => l.drugId === m.drugId))))
    ok(!!old, '有一張種子資料裡已發藥的調劑單')
    const meds = db().encounters.find((e) => e.id === old.encounterId).medications
    const loc = db().stockTxns.find((x) => x.id === old.txnIds[0]).locationId
    const before = Object.fromEntries(meds.map((m) => [m.drugId, lotSum(m.drugId, loc)]))
    await as('clerk01')
    const ch = db().charges.find((c) => c.visitId === old.visitId && !c.voided)
    try {
      await api.chargeApi.voidCharge(ch.id, '測試')
      ok(false, '已發藥的收據應先退藥')
    } catch (e) {
      ok(e.message.includes('請先到藥局辦理退藥'), `已發藥的收據作廢 → 「${e.message}」（指向退藥，不再說沒有這功能）`)
    }
    await expectError(() => returnAll(old.id, '病人過敏'), '櫃台退藥')
    await as('ph01')
    try {
      await returnAll(old.id, ' ')
      ok(false, '沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'reason', '退藥要寫原因')
    }
    const pend = db().dispenses.find((d) => d.status === 'pending')
    if (pend) await expectError(() => returnAll(pend.id, 'x'), '還沒發藥就退藥')
    const r = await returnAll(old.id, '病人過敏回診')
    ok(r.status === 'returned' && r.returnReason === '病人過敏回診' && db().visits.find((v) => v.id === old.visitId).status === 'charged' && db().auditLogs[0].action === '門診退藥',
      '退藥：調劑單標「已退藥」、掛號回到「已批價」、寫稽核')
    ok(meds.every((m) => lotSum(m.drugId, loc) === before[m.drugId] + m.qty), `藥退回原地點（${meds.map((m) => `${m.drugId} +${m.qty}`).join('、')}）`)
    const backTx = db().stockTxns.filter((x) => x.type === 'return' && x.reason?.startsWith('門診退藥'))
    const outTx = old.txnIds.map((id) => db().stockTxns.find((x) => x.id === id))
    ok(outTx.every((o) => o.lots.every((m) => backTx.some((b) => b.drugId === o.drugId && b.lots.some((x) => x.lotNo === m.lotNo && x.qty === -m.qty)))), '退回發出時的同幾個批號（效期跟著回來）')
    ok(ledgerBroken(db()).length === 0, '退藥後帳本仍對得起來')
    await expectError(() => returnAll(old.id, '再退一次'), '已退藥的再退一次')
    ok(!(await PH.listDispenses({ date: old.dispensedAt.slice(0, 10) })).some((x) => x.id === old.id && x.status !== 'returned'), '已退藥不算待領（不是「還沒發藥」）')
    await as('clerk01')
    await expectError(() => api.chargeApi.voidCharge(ch.id, '病人過敏'), '作廢以前的收據（已算進那天的日結）')
    await api.chargeApi.refundCharge(ch.id, '病人過敏，醫師改處方')
    ok(db().charges.find((c) => c.id === ch.id).refund && db().visits.find((v) => v.id === old.visitId).status === 'consulted', '退藥後以前的收據可以退費，回到待批價')
    // 新發的藥記下發藥異動
    await as('ph01')
    const ver = db().dispenses.find((d) => d.status === 'verified' && db().encounters.find((e) => e.id === d.encounterId).medications.every((m) => db().drugLots.filter((l) => l.drugId === m.drugId && l.locationId === db().stockLocations.find((x) => x.dispensesOpd).id && l.expiry >= T).reduce((n, l) => n + l.qty, 0) >= m.qty))
    if (ver) {
      const pt = db().patients.find((x) => x.id === ver.patientId)
      await PH.dispense(ver.id, { birthMMDD: pt.birthDate.slice(5).replace('-', '') })
      const dd = db().dispenses.find((x) => x.id === ver.id)
      ok(dd.txnIds?.length === db().encounters.find((e) => e.id === dd.encounterId).medications.length && dd.txnIds.every((id) => db().stockTxns.find((x) => x.id === id)?.type === 'dispense'), '新發藥：調劑單記下扣庫存的那幾筆異動（退藥時用）')
    }
    const { readFileSync } = await import('node:fs')
    const usesOpen = ['src/services/inventory.ts', 'src/services/purchase.ts', 'src/services/transfer.ts', 'src/services/pharmacy.ts', 'src/pages/pharmacy/PharmacyPage.vue'].map((f) => readFileSync(f, 'utf8'))
    ok(usesOpen.every((t) => !t.includes("!== 'dispensed'")), '「還在等領藥」一律用 dispenseOpen（已退藥不能被當成還沒發藥）')
  }

  // 退費：隔天以後、或收回過欠款的收據不能作廢，只能退費。原收據照算在原本那天，退款算在退款那天
  console.log('\n[退費]')
  {
    const C = api.chargeApi
    const db = () => dbm.db
    const chOf = (id) => db().charges.find((c) => c.id === id)
    // 以前欠款的收據（種子：林俊傑 100005）：藥已發出要先退藥
    const pt = db().patients.find((x) => x.chartNo === '100005')
    let debt = db().charges.find((c) => c.patientId === pt.id && !c.voided && (c.owed ?? 0) > 0 && c.paidAt.slice(0, 10) < T)
    ok(!!debt, '有一張以前記欠款的收據')
    const day = debt.paidAt.slice(0, 10)
    await as('clerk01')
    const dayBefore = await C.dailyReport(day)
    const dp = db().dispenses.find((d) => d.visitId === debt.visitId && d.status === 'dispensed')
    if (dp) {
      const r0 = await C.getReceipt(debt.id)
      ok(!!r0.cancel?.blocked && r0.cancel.mode === 'refund', `藥已發出：收據標「${r0.cancel?.blocked}」`)
      await expectError(() => C.refundCharge(debt.id, '測試'), '藥已發出就退費')
      await as('ph01')
      await returnAll(dp.id, '醫師改處方')
      await as('clerk01')
    }
    // 今天收回一部分欠款（現金 50）
    const repaid0 = (debt.repayments ?? []).reduce((n, r) => n + r.amount, 0)
    if (debt.owed - repaid0 > 0) await C.repayDebt(debt.id, { payMethod: 'cash', amount: Math.min(50, debt.owed - repaid0) })
    debt = chOf(debt.id)
    const rc = await C.getReceipt(debt.id)
    ok(rc.cancel?.mode === 'refund' && !rc.cancel.blocked, '以前的收據：只能退費（不能作廢）')
    try {
      await C.voidCharge(debt.id, '測試')
      ok(false, '以前的收據作廢應被擋下')
    } catch (e) {
      ok(e.message.includes('退費'), `作廢以前的收據 → 「${e.message}」`)
    }
    try {
      await C.refundCharge(debt.id, ' ')
      ok(false, '退費沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'reason', '退費要寫原因')
    }
    const paid = debt.patientTotal - debt.owed + (debt.repayments ?? []).reduce((n, r) => n + r.amount, 0)
    ok(rc.cancel.refundAmount === paid, `退多少：實收 ${debt.patientTotal - debt.owed} ＋ 收回 ${paid - (debt.patientTotal - debt.owed)} ＝ ${paid}`)
    const todayBefore = await C.dailyReport(T)
    const done = await C.refundCharge(debt.id, '醫師改處方，重新批價')
    const rf = done.refund
    ok(rf.amount === paid && rf.receiptNo.startsWith('RF' + T.replace(/-/g, '')) && rf.parts.reduce((n, x) => n + x.amount, 0) === paid && rf.parts.length === new Set([...(debt.patientTotal - debt.owed > 0 ? [debt.payMethod] : []), ...(debt.repayments ?? []).map((x) => x.payMethod)]).size && rf.amount > 0,
      `退款單 ${rf.receiptNo}：退 ${rf.amount}，依原付款方式（${rf.parts.map((x) => x.payMethod + ' ' + x.amount).join('、')}）`)
    ok(chOf(debt.id).voided && db().visits.find((v) => v.id === debt.visitId).status === 'consulted' && !(await C.listDebts(pt.id)).some((d) => d.chargeId === debt.id) && db().auditLogs[0].action === '退費',
      '退費後：病人回到待批價、未收回的欠款一併取消、寫稽核')
    const dayAfter = await C.dailyReport(day)
    ok(dayAfter.collected === dayBefore.collected && dayAfter.count === dayBefore.count && dayAfter.patientTotal === dayBefore.patientTotal, `原本那天（${day}）的日結完全不變：實收 ${dayAfter.collected}`)
    const todayAfter = await C.dailyReport(T)
    ok(todayAfter.refunded === todayBefore.refunded + paid && todayAfter.collected === todayBefore.collected - paid && todayAfter.refunds.some((x) => x.receiptNo === rf.receiptNo && x.originalDate === day),
      `今天的日結：退款 −${paid}，實收跟著少 ${paid}`)
    ok(Object.values(todayAfter.byPayMethod).reduce((n, x) => n + x, 0) === todayAfter.collected && todayAfter.byCashier.reduce((n, x) => n + x.collected, 0) === todayAfter.collected && todayAfter.byDay.reduce((n, x) => n + x.collected, 0) === todayAfter.collected,
      '依付款方式、收費人員、日期加總都＝實收（退款從原付款方式扣）')
    const csv = (await load('/src/services/report-csv.ts')).dailyReportCsv(todayAfter)
    ok(csv.includes(`退款,${rf.receiptNo}`) && csv.includes(`退款合計,${-todayAfter.refunded}`), '匯出 CSV：退款列（負數）與退款合計')
    await expectError(() => C.refundCharge(debt.id, '再退一次'), '已退費的再退一次')
    // 當天的收據：作廢就好，不開退款單
    const todayCh = db().charges.find((c) => !c.voided && !c.admissionId && c.paidAt.startsWith(T) && !c.repayments?.length && !db().dispenses.some((d) => d.visitId === c.visitId && d.status === 'dispensed'))
    if (todayCh) {
      ok((await C.getReceipt(todayCh.id)).cancel?.mode === 'void', '當天的收據：作廢')
      await expectError(() => C.refundCharge(todayCh.id, '測試'), '當天的收據退費（請用作廢）')
    }
    const { readFileSync } = await import('node:fs')
    const page = readFileSync('src/pages/charge/ChargePage.vue', 'utf8')
    ok(page.includes("receipt.cancel?.mode === 'void'") && !/paidAt\.slice\(0, 10\) [!=]== todayStr \?/.test(page.replace(/receipt\.paidAt\.slice\(0, 10\) === todayStr \? '收回過欠款的收據'/, '')), '作廢還是退費由服務層決定（receipt.cancel），頁面不自己比日期')
  }

  // 掛號預收：掛號時先收（選填），批價扣抵、多退少補；退掛退還；停診待退；收據作廢後預收款還在
  console.log('\n[掛號預收]')
  {
    const { addDays } = await load('/src/utils/date.ts')
    const B = api.bookingApi
    const C = api.chargeApi
    const db = () => dbm.db
    const vOf = (id) => db().visits.find((v) => v.id === id)
    const openSession = async (date) => (await api.scheduleApi.listSessions({ date })).find((x) => !x.full && !x.closed && !x.suspended)
    const freePatient = (date) => db().patients.find((x) => !x.allergies.length && !x.deceasedAt && !db().visits.some((v) => v.date === date && v.patientId === x.id))
    const see = async (visitId) => {
      const v = vOf(visitId)
      await as(db().users.find((u) => u.doctorId === v.doctorId).username)
      const e = await api.opdApi.startConsult(visitId, { allowParallel: true, allowNotCheckedIn: true })
      await api.opdApi.completeEncounter(e.id, { subjective: '測試', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'J06.9', name: '急性上呼吸道感染', primary: true }], medications: [], procedures: [], refillTimes: 0, admissionRequested: false })
      await as('clerk01')
    }
    const sessT = await openSession(T)
    ok(!!sessT, '今天還有可掛的診次')
    const base = { sessionId: sessT.id, identityCode: '01', caseType: '01' }

    await as('nurse01')
    await expectError(() => B.register({ ...base, patientId: freePatient(T).id, prepay: { amount: 300, payMethod: 'cash' } }), '護理師掛號時收預收款')
    await as('clerk01')
    try {
      await B.register({ ...base, patientId: freePatient(T).id, prepay: { amount: 0, payMethod: 'cash' } })
      ok(false, '預收 0 元應被擋下')
    } catch (e) {
      ok(e.field === 'prepay', `預收金額要正整數 → 「${e.message}」`)
    }
    // A：預收 500，應收比較少 → 結帳不用再收，差額當場退還
    const before = await C.dailyReport(T)
    const vA = await B.register({ ...base, patientId: freePatient(T).id, prepay: { amount: 500, payMethod: 'cash' } })
    ok(vA.prepaid?.amount === 500 && vA.prepaid.receiptNo.startsWith('R' + T.replace(/-/g, '')) && vA.prepaid.available === 500 && db().auditLogs[0].detail.includes('預收 500'), `掛號預收 500：開預收收據 ${vA.prepaid?.receiptNo}，寫稽核`)
    await see(vA.id)
    const pvA = await C.previewCharge(vA.id)
    ok(pvA.prepaid?.applied === pvA.patientTotal && pvA.prepaid.due === 0 && pvA.prepaid.excess === 500 - pvA.patientTotal, `試算：應收 ${pvA.patientTotal}，預收扣抵 ${pvA.prepaid?.applied}，本次應收 0，多收 ${pvA.prepaid?.excess} 要退還`)
    const chA = await C.pay(vA.id, { payMethod: 'cash', received: 0 })
    const ppA = vOf(vA.id).prepay
    ok(chA.prepaidApplied === pvA.patientTotal && chA.received === 0 && ppA.refunds.length === 1 && ppA.refunds[0].amount === pvA.prepaid.excess && ppA.refunds[0].receiptNo.startsWith('RF'),
      `結帳：扣抵 ${chA.prepaidApplied}、不再收錢；差額 ${ppA.refunds[0]?.amount} 開退款單 ${ppA.refunds[0]?.receiptNo} 當場退還`)
    const afterA = await C.dailyReport(T)
    ok(afterA.prepaidIn === before.prepaidIn + 500 && afterA.prepaidApplied === before.prepaidApplied + pvA.patientTotal && afterA.refunds.some((x) => x.kind === '退預收' && x.amount === pvA.prepaid.excess) && afterA.collected === before.collected + 500 - pvA.prepaid.excess,
      `日結：預收 +500、扣抵不重算、退還差額 −${pvA.prepaid.excess}：今天實收淨增 ${500 - pvA.prepaid.excess}（＝這位病人實際付的）`)
    const sum = (r) => Object.values(r.byPayMethod).reduce((n, x) => n + x, 0)
    ok(sum(afterA) === afterA.collected && afterA.byCashier.reduce((n, x) => n + x.collected, 0) === afterA.collected && afterA.byDay.reduce((n, x) => n + x.collected, 0) === afterA.collected, '依付款方式、收費人員、日期加總都＝實收')

    // B：預收 50，不夠 → 補收差額；當天作廢後預收款還在，重新批價再扣抵
    const vB = await B.register({ ...base, patientId: freePatient(T).id, prepay: { amount: 50, payMethod: 'card' } })
    await see(vB.id)
    const pvB = await C.previewCharge(vB.id)
    ok(pvB.prepaid.applied === 50 && pvB.prepaid.due === pvB.patientTotal - 50 && !pvB.prepaid.excess, `預收不夠：應收 ${pvB.patientTotal} − 預收 50 ＝ 本次應收 ${pvB.prepaid.due}`)
    await expectError(() => C.pay(vB.id, { payMethod: 'cash', received: pvB.prepaid.due - 1 }), '少收（現金沒到本次應收）')
    const chB = await C.pay(vB.id, { payMethod: 'cash', received: pvB.prepaid.due })
    ok(chB.received === pvB.prepaid.due && chB.change === 0 && chB.prepaidApplied === 50, '補收差額，收據記下扣抵 50')
    await C.voidCharge(chB.id, '身分選錯')
    ok(vOf(vB.id).prepay.refunds.length === 0 && (await C.previewCharge(vB.id)).prepaid?.applied === 50, '當天作廢：預收款還在這次就醫（沒退），重新批價再扣抵')
    await C.pay(vB.id, { payMethod: 'cash', received: pvB.prepaid.due })

    // 改期帶著預收走；退掛當場退還（只限櫃台）
    const tm = addDays(T, 1)
    const sessTm = await openSession(tm)
    const vC = await B.register({ sessionId: sessTm.id, identityCode: '01', caseType: '01', patientId: freePatient(tm).id, prepay: { amount: 200, payMethod: 'mobile' } })
    const sessTm2 = (await api.scheduleApi.listSessions({ date: tm })).find((x) => !x.full && !x.closed && !x.suspended && x.id !== sessTm.id)
    let vC2 = vC
    if (sessTm2) {
      vC2 = await B.rescheduleVisit(vC.id, { sessionId: sessTm2.id, identityCode: '01', caseType: '01' })
      ok(vC2.prepaid?.amount === 200 && !vOf(vC.id).prepay, '改期：預收款跟著改到新的掛號（不必退了再收）')
    }
    await as('nurse01')
    await expectError(() => B.cancelVisit(vC2.id), '護理師退掛有預收款的掛號（要退錢）')
    await as('clerk01')
    await B.cancelVisit(vC2.id)
    const ppC = vOf(vC2.id).prepay
    ok(ppC.refunds.length === 1 && ppC.refunds[0].amount === 200 && db().auditLogs[0].detail.includes('退還預收 200'), '退掛：當場退還預收 200（開退款單、寫稽核）')

    // 停診：病人不在現場 → 待退；名單上看得到、櫃台退還
    const sessS = (await api.scheduleApi.listSessions({ date: addDays(T, 2) })).find((x) => !x.full && !x.closed && !x.suspended) ?? (await openSession(addDays(T, 3)))
    const vS = await B.register({ sessionId: sessS.id, identityCode: '01', caseType: '01', patientId: freePatient(sessS.date).id, prepay: { amount: 150, payMethod: 'cash' } })
    await as('admin')
    await api.scheduleApi.suspendSession(sessS.id, '醫師開會')
    ok(db().auditLogs[0].detail.includes('有預收款待退'), '停診稽核寫出有預收款待退')
    await as('clerk01')
    const nt = (await api.scheduleApi.listSuspendNotices()).find((x) => x.visitId === vS.id)
    ok(nt?.prepayDue === 150, '停診通知名單：標「待退預收 150」')
    await as('nurse01')
    await expectError(() => api.scheduleApi.refundSuspendedPrepay(vS.id), '護理師退還預收款')
    await as('clerk01')
    const rr = await api.scheduleApi.refundSuspendedPrepay(vS.id)
    ok(rr.amount === 150 && rr.receiptNo.startsWith('RF') && !(await api.scheduleApi.listSuspendNotices()).find((x) => x.visitId === vS.id)?.prepayDue, '退還後名單不再標待退')
    await expectError(() => api.scheduleApi.refundSuspendedPrepay(vS.id), '已退還的再退一次')
    const fin = await C.dailyReport(T)
    ok(sum(fin) === fin.collected && fin.collected === fin.patientTotal - fin.newDebt - fin.prepaidApplied + fin.repaid + fin.prepaidIn - fin.refunded, '全部做完：實收公式與依付款方式加總一致')
    const csv = (await load('/src/services/report-csv.ts')).dailyReportCsv(fin)
    ok(csv.includes('掛號預收,') && csv.includes('退還預收,') && csv.includes(`預收扣抵合計,${-fin.prepaidApplied}`), '匯出 CSV：掛號預收、退還預收、預收扣抵合計')
  }

  // 權限可設定：只能在權限目錄的範圍內調整；服務層、設定畫面、說明都讀同一份目錄
  console.log('\n[權限可設定]')
  {
    const PR = await load('/src/services/permission-rules.ts')
    const PM = api.permissionApi
    const db = () => dbm.db
    const def = PR.permDef('purchase.approve')
    ok(PR.checkPermissionRoles(PR.permDef('order.write'), ['doctor', 'clerk'])?.includes('固定') && PR.checkPermissionRoles(def, ['clerk'])?.includes('只能給') && PR.checkPermissionRoles(def, [])?.includes('至少要留') && PR.checkPermissionRoles(PR.permDef('charge.approveDiscount'), ['clerk'])?.includes('只能指定給個人') && PR.checkPermissionRoles(def, ['pharmacist']) === null,
      '規則：固定的不能改、只能在法規範圍內、至少留一個角色、只指定個人的不能開給整個角色')
    ok(PR.permits(def, {}, 'admin') && !PR.permits(def, {}, 'pharmacist') && PR.permits(def, {}, 'pharmacist', ['purchase.approve']) && !PR.permits(def, {}, 'clerk', ['purchase.approve']),
      '指定個人：被指定的藥師可以；被指定但目前角色不在法規範圍（櫃台）仍不行')
    await as('clerk01')
    await expectError(() => PM.listPermissions(), '櫃台看權限設定')
    await as('admin')
    const rows = await PM.listPermissions()
    ok(rows.length === PR.PERMISSIONS.length && rows.find((r) => r.key === 'charge.approveDiscount').grantees.some((g) => g.username === 'clerk02') && rows.every((r) => !r.changed), `權限清單 ${rows.length} 項（含固定的），都是預設；優免核准指定給 clerk02`)
    try {
      await PM.savePermissionRoles('order.write', { roles: ['doctor', 'nurse'], reason: '測試' })
      ok(false, '固定的權限應不能改')
    } catch (e) {
      ok(e.fields?.roles?.includes('固定'), `改固定的權限 → 「${e.fields?.roles}」`)
    }
    try {
      await PM.savePermissionRoles('visit.register', { roles: ['clerk', 'doctor'], reason: '' })
      ok(false, '超出範圍、沒寫原因應被擋下')
    } catch (e) {
      ok(e.fields?.roles && e.fields?.reason, '超出法規範圍（醫師掛號）、沒寫原因：一次標出')
    }
    // 掛號只留給櫃台：護理師會失去權限 → 先列出受影響的帳號
    try {
      await PM.savePermissionRoles('visit.register', { roles: ['clerk'], reason: '大醫院掛號集中在櫃台' })
      ok(false, '有人會失去權限應先確認')
    } catch (e) {
      ok(e.code === 'CONFLICT' && e.message.includes('nurse01') && e.message.includes('staff01') === false, `列出會失去權限的帳號 → 「${e.message}」（護理兼櫃台的 staff01 不受影響）`)
    }
    await PM.savePermissionRoles('visit.register', { roles: ['clerk'], reason: '大醫院掛號集中在櫃台', confirm: true })
    ok(db().permissionSettings['visit.register'].join() === 'clerk' && db().auditLogs[0].detail === '掛號、退掛、改期：掛號批價、護理師 → 掛號批價（大醫院掛號集中在櫃台）', '調整後存下設定、稽核寫出前後與原因')
    await as('nurse01')
    const sess = (await api.scheduleApi.listSessions({ date: T })).find((x) => !x.full && !x.closed && !x.suspended)
    const pt = db().patients.find((x) => !x.deceasedAt && !db().visits.some((v) => v.date === T && v.patientId === x.id))
    try {
      await api.bookingApi.register({ patientId: pt.id, sessionId: sess.id, identityCode: '01', caseType: '01' })
      ok(false, '護理師應不能掛號')
    } catch (e) {
      ok(e.code === 'FORBIDDEN' && e.message.includes('掛號、退掛、改期'), `服務層照設定把關：護理師掛號 → 「${e.message}」`)
    }
    ok(!api.authApi.currentUser().can.includes('visit.register'), '登入資料的 can 跟著變（頁面據此不顯示按鈕）')
    await api.authApi.login('staff01', '1234', 'nurse')
    try {
      await api.bookingApi.register({ patientId: pt.id, sessionId: sess.id, identityCode: '01', caseType: '01' })
      ok(false, '用護理師角色應被擋')
    } catch (e) {
      ok(e.message.includes('請切換為「掛號批價」角色'), '護理兼櫃台的帳號用護理師角色時：提示切換角色，不是說沒權限')
    }
    await as('admin')
    await PM.savePermissionRoles('visit.register', { roles: ['clerk', 'nurse'], reason: '還原' })
    ok(!db().permissionSettings['visit.register'], '改回預設：不留設定（只存和預設不同的）')

    // 採購核准指定給藥劑部主管 ph02
    const ph02 = db().users.find((u) => u.username === 'ph02')
    await expectError(() => PM.setPermissionGrant('purchase.approve', ph02.id, { on: true, reason: '' }), '指定個人沒寫原因')
    await expectError(() => PM.setPermissionGrant('purchase.approve', db().users.find((u) => u.username === 'clerk01').id, { on: true, reason: 'x' }), '採購核准指定給櫃台（不在法規範圍）')
    await expectError(() => PM.setPermissionGrant('order.write', ph02.id, { on: true, reason: 'x' }), '固定的權限指定給個人')
    await PM.setPermissionGrant('purchase.approve', ph02.id, { on: true, reason: '升任藥劑部主管' })
    ok(db().users.find((u) => u.username === 'ph02').grants.includes('purchase.approve') && db().auditLogs[0].detail.includes('指定給 林雅婷'), '採購核准指定給 ph02（寫稽核）')
    // ph01 開單送出，ph02 核准；ph01 自己不能核准
    await as('ph01')
    const cand = (await api.purchaseApi.purchaseCandidates())[0]
    const sup = (await api.purchaseApi.listSuppliers())[0]
    const po = await api.purchaseApi.savePurchaseDraft({ supplierId: sup.id, lines: [{ drugId: cand.drugId, qty: 10, unitCost: 1 }] })
    await api.purchaseApi.submitPurchase(po.id)
    await expectError(() => api.purchaseApi.approvePurchase(po.id), 'ph01（沒被指定）核准採購單')
    await as('ph02')
    ok(api.authApi.currentUser().can.includes('purchase.approve'), 'ph02 登入資料有「採購核准」')
    ok((await api.purchaseApi.approvePurchase(po.id)).status === 'ordered', '被指定的藥師核准採購單')
    await as('admin')
    await PM.setPermissionGrant('purchase.approve', ph02.id, { on: false, reason: '測試結束' })
    await api.purchaseApi.cancelPurchase(po.id, '測試結束').catch(() => {})

    // 盤點覆核只留給管理員：藥師看得到送出的盤點單，但標「沒有權限」、服務層也擋
    await PM.savePermissionRoles('stocktake.review', { roles: ['admin'], reason: '覆核集中由管理員', confirm: true })
    await as('ph01')
    const st = await api.stocktakeApi.createStocktake({ scope: { kind: 'drugs', drugIds: ['M001'] } })
    for (const l of st.lines) await api.stocktakeApi.countLine(st.id, l.id, db().drugLots.find((x) => x.id === l.lotId).qty)
    await api.stocktakeApi.submitStocktake(st.id)
    await as('ph02')
    const stv = await api.stocktakeApi.getStocktake(st.id)
    ok(stv.reviewBlocked?.includes('沒有「盤點覆核」的權限'), `沒權限的藥師：盤點單標「${stv.reviewBlocked}」（不出現覆核按鈕）`)
    await expectError(() => api.stocktakeApi.postStocktake(st.id), '沒權限的藥師覆核過帳')
    await as('admin')
    ok((await api.stocktakeApi.postStocktake(st.id)).status === 'posted', '管理員覆核過帳')
    await PM.savePermissionRoles('stocktake.review', { roles: ['admin', 'pharmacist'], reason: '還原' })

    // 原始碼：受控的動作都走 requirePermission（不能繞過目錄自己寫角色）
    const { readFileSync } = await import('node:fs')
    const keysInCode = new Set()
    // 掃全部服務模組（新增的模組不會漏掉）
    const { readdirSync } = await import('node:fs')
    for (const f of readdirSync('src/services').filter((x) => x.endsWith('.ts')).map((x) => x.slice(0, -3))) {
      for (const m of readFileSync(`src/services/${f}.ts`, 'utf8').matchAll(/requirePermission\('([a-zA-Z.]+)'\)/g)) keysInCode.add(m[1])
    }
    const unused = PR.PERMISSIONS.filter((d) => !d.grantOnly && !keysInCode.has(d.key)).map((d) => d.key)
    ok(!unused.length && [...keysInCode].every((k) => PR.PERMISSIONS.some((d) => d.key === k)), `目錄裡每一項都有服務層在檢查、服務層檢查的都在目錄裡（${keysInCode.size} 項）`)
    const bk = readFileSync('src/services/purchase.ts', 'utf8')
    ok(!/export function approvePurchase[\s\S]{0,120}requireUser\(/.test(bk), '採購核准不再寫死 requireUser')
    const panel = readFileSync('src/pages/admin/components/PermissionsPanel.vue', 'utf8')
    ok(!panel.includes('const actions:'), '權限頁不再有手寫的操作權限摘要（改從目錄產生）')
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
    const other = db.patients.find((p) => !p.deceasedAt && p.id !== e0.patientId)
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
    ok(fee.reg + fee.basicCopay + fee.drugCopay + fee.ipdCopay + fee.selfPay + fee.discount === rep.patientTotal, '日結依費用類別（含優免負數）加總＝應收合計')

    // 優免主管核准：主管當場輸入自己的帳密；核准一次性、綁這次掛號＋類別＋櫃台；失敗的嘗試留稽核
    {
      const C = api.chargeApi
      ok(dbm.db.discounts.find((d) => d.code === 'DC05').needsApproval && dbm.db.users.find((u) => u.username === 'clerk02').grants?.includes('charge.approveDiscount'), '種子：專案減免需主管核准；櫃台組長 clerk02 可核准優免')
      // 自己掛兩位、看完診（前面的測試已把待批價的病人結完）：不依賴種子當天剩下多少
      const { addDays } = await load('/src/utils/date.ts')
      const makeConsulted = async () => {
        await as('clerk01')
        const ss = [...(await api.scheduleApi.listSessions({ date: T })), ...(await api.scheduleApi.listSessions({ date: addDays(T, 1) }))]
        const sess = ss.find((x) => !x.full && !x.closed && !x.suspended)
        const pt = dbm.db.patients.find((x) => !x.allergies.length && !x.deceasedAt && !dbm.db.visits.some((v) => v.date === sess.date && v.patientId === x.id))
        const v = await api.bookingApi.register({ patientId: pt.id, sessionId: sess.id, identityCode: '01', caseType: '01' })
        await as(dbm.db.users.find((u) => u.doctorId === sess.doctorId).username)
        const e = await api.opdApi.startConsult(v.id, { allowParallel: true, allowNotCheckedIn: true })
        await api.opdApi.completeEncounter(e.id, { subjective: '測試', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'J06.9', name: '急性上呼吸道感染', primary: true }], medications: [], procedures: [], refillTimes: 0, admissionRequested: false })
        return dbm.db.visits.find((x) => x.id === v.id)
      }
      const pend = [await makeConsulted(), await makeConsulted()]
      const [vA, vB] = pend
      ok(vA.status === 'consulted' && vB.status === 'consulted', '兩位待批價的病人')
      await as('clerk01')
      const DC05 = { code: 'DC05', reason: '院長特准' }
      try {
        await C.pay(vA.id, { payMethod: 'cash', received: 9999, discount: DC05 })
        ok(false, '沒有主管核准應被擋下')
      } catch (e) {
        ok(e.field === 'approval' && e.message.includes('需主管核准'), `沒有主管核准就結帳 → 「${e.message}」`)
      }
      await expectError(() => C.approveDiscount({ visitId: vA.id, code: 'DC01', username: 'clerk02', password: '1234' }), '不需核准的類別要求核准')
      const bad = await C.approveDiscount({ visitId: vA.id, code: 'DC05', username: 'clerk02', password: 'wrong' })
      ok(bad.ok === false && bad.field === 'password' && dbm.db.auditLogs[0].action === '優免核准失敗' && dbm.db.auditLogs[0].detail.includes('clerk02'), '密碼錯誤：回傳失敗（不丟錯），失敗的嘗試留在稽核')
      const noRight = await C.approveDiscount({ visitId: vA.id, code: 'DC05', username: 'staff01', password: '1234' })
      ok(noRight.ok === false && noRight.message.includes('沒有核准優免的權限'), `沒有權限的人核准 → 「${noRight.message}」`)
      try {
        await C.approveDiscount({ visitId: vA.id, code: 'DC05', username: '', password: '' })
        ok(false, '空白帳密應被擋下')
      } catch (e) {
        ok(e.fields?.username && e.fields?.password, '帳號、密碼空白一次標出')
      }
      await as('clerk02')
      const self = await C.approveDiscount({ visitId: vA.id, code: 'DC05', username: 'clerk02', password: '1234' })
      ok(self.ok === false && self.message.includes('不能核准自己'), '主管自己結帳時不能核准自己')
      await as('clerk01')
      const ap = await C.approveDiscount({ visitId: vA.id, code: 'DC05', username: 'CLERK02 ', password: '1234' })
      ok(ap.ok && ap.approverName === '鄭淑芬' && dbm.db.auditLogs[0].action === '優免核准' && dbm.db.auditLogs[0].detail.includes('馬文琪'), '主管核准：回傳一次性的核准、稽核記下主管與櫃台（帳號不分大小寫）')
      try {
        await C.pay(vB.id, { payMethod: 'cash', received: 9999, discount: { ...DC05, approval: ap.token } })
        ok(false, '核准不能拿去別的病人用')
      } catch (e) {
        ok(e.field === 'approval', '核准綁這一次掛號：拿去別的病人結帳 → 擋下')
      }
      await as('clerk02')
      await expectError(async () => {
        try {
          await C.pay(vA.id, { payMethod: 'cash', received: 9999, discount: { ...DC05, approval: ap.token } })
        } catch (e) {
          if (e.field === 'approval') throw e
          throw new Error('應該是 approval 欄位的錯誤')
        }
      }, '別的櫃台拿這張核准結帳')
      await as('clerk01')
      clockBase += 11 * 60_000 // 過了 11 分鐘（失敗會回滾，不留任何紀錄，再撥回來）
      try {
        await C.pay(vA.id, { payMethod: 'cash', received: 9999, discount: { ...DC05, approval: ap.token } })
        ok(false, '過期的核准應被擋下')
      } catch (e) {
        ok(e.field === 'approval' && e.message.includes('重新核准'), `核准超過 10 分鐘 → 「${e.message}」`)
      } finally {
        clockBase -= 11 * 60_000
      }
      const pvA = await C.previewCharge(vA.id, 'DC05')
      const chA = await C.pay(vA.id, { payMethod: 'cash', received: pvA.patientTotal, discount: { ...DC05, approval: ap.token } })
      ok(chA.discount?.approvedBy === 'U402' && chA.discount.approverName === '鄭淑芬' && dbm.db.auditLogs[0].detail.includes('鄭淑芬 核准'), '結帳：收據記下核准的主管（id 與當時的姓名），稽核也寫出來')
      // 一次性：同一張核准不能再用（作廢後重新結帳要重新核准）
      await C.voidCharge(chA.id, '測試：重新結帳')
      try {
        await C.pay(vA.id, { payMethod: 'cash', received: 9999, discount: { ...DC05, approval: ap.token } })
        ok(false, '用過的核准應被擋下')
      } catch (e) {
        ok(e.field === 'approval', '核准用過就失效：作廢後重新結帳要重新核准')
      }
      // 管理：類別可設需核准、帳號可設可核准
      await as('admin')
      const dc1 = dbm.db.discounts.find((d) => d.code === 'DC01')
      await api.adminApi.saveDiscount({ ...dc1, needsApproval: true })
      ok(dc1.needsApproval === true && dbm.db.auditLogs[0].detail.includes('（需主管核准）'), '管理員把「員工」設成需主管核准（寫稽核）')
      await api.adminApi.saveDiscount({ ...dc1, needsApproval: false })
      ok(!('needsApproval' in dc1), '取消需核准')
      const s1 = dbm.db.users.find((u) => u.username === 'staff01')
      await api.permissionApi.setPermissionGrant('charge.approveDiscount', s1.id, { on: true, reason: '代理組長' })
      ok(s1.grants?.includes('charge.approveDiscount') && dbm.db.auditLogs[0].detail.includes('優免核准：指定給'), '權限設定把「優免核准」指定給 staff01（寫稽核）')
      await api.permissionApi.setPermissionGrant('charge.approveDiscount', s1.id, { on: false, reason: '代理結束' })
      ok(!('grants' in s1) && dbm.db.auditLogs[0].detail.includes('收回'), '收回優免核准')
      ok(!Object.keys(api.chargeApi).includes('approvalFor'), '核准檢查是服務層內部函式，不對外')
      await as('clerk01')
    }
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
      const rcBad = groupBy(db.charges, (c) => (c.admissionId ? c.paidAt.slice(0, 10) : vById.get(c.visitId).date)).flatMap((l) => ordered(l.sort((a, b) => a.receiptNo.localeCompare(b.receiptNo)), (c) => c.paidAt, (c) => c.receiptNo))
      const pkBad = groupBy(db.dispenses, (d) => vById.get(d.visitId).date).flatMap((l) => ordered(l.sort((a, b) => a.pickupNo - b.pickupNo), (d) => d.createdAt, (d) => d.pickupNo))
      const csBad = groupBy(db.visits, (v) => v.patientId).flatMap((l) => ordered(l.sort((a, b) => a.cardSeq.localeCompare(b.cardSeq)), (v) => v.createdAt, (v) => v.cardSeq))
      ok(!future.length && !flowBad.length, `${label} 重建：沒有未來的時間（${future.length}）、掛號≤叫號≤完成≤批價≤發藥（違規 ${flowBad.length}）`)
      ok(!seqBad.length && !rcBad.length && !pkBad.length && !csBad.length,
        `${label} 重建：看診號、收據號、領藥號、就醫序號都依時間先後${[...seqBad, ...rcBad, ...pkBad, ...csBad].slice(0, 2).join('；')}`)
      // 4. 今天：看過診的人數、下午診的掛號
      // 急診（檢傷時才掛號）不算：這裡檢查的是門診的預約與看診順序
      const todayV = db.visits.filter((v) => v.date === Td && !v.refillOf && !v.er)
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
    resetDb('small')
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
    await expectError(() => A.requestDeptTransfer(stroke.id, { toDeptId: 'D03', reason: '再申請一次', course: '入院後抗血小板治療，生命徵象穩定', problems: '右側肌力 3 分', pending: '追蹤血脂' }), '已有申請中的轉科又申請')
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
      await A.requestDeptTransfer(stroke.id, { toDeptId: 'D02', toDoctorId: 'DR04', reason: '', course: '', problems: ' ' })
      ok(false, '申請欄位錯誤應被擋下')
    } catch (e) {
      ok(e.fields?.toDeptId && e.fields?.reason && e.fields?.toDoctorId && e.fields?.course && e.fields?.problems, `申請轉科欄位錯誤一次標出（含轉出摘要必填）：${Object.values(e.fields ?? {}).join('／')}`)
    }
    await as('dr04')
    await expectError(() => A.requestDeptTransfer(stroke.id, { toDeptId: 'D08', reason: '外科代申請', course: '入院後抗血小板治療，生命徵象穩定', problems: '右側肌力 3 分', pending: '追蹤血脂' }), '別科醫師替這位病人申請轉科')
    await as(userOf(fromDoc))
    await A.requestDeptTransfer(stroke.id, { toDeptId: 'D08', toDoctorId: 'DR09', reason: '急性期穩定，轉復健科', course: '入院後抗血小板治療，生命徵象穩定', problems: '右側肌力 3 分', pending: '追蹤血脂' })
    v = await A.cancelDeptTransfer(stroke.id)
    ok(v.lastTransfer?.status === 'cancelled', '原科可以撤回申請')
    await A.requestDeptTransfer(stroke.id, { toDeptId: 'D08', toDoctorId: 'DR09', reason: '急性期穩定，轉復健科', course: '入院後抗血小板治療，生命徵象穩定', problems: '右側肌力 3 分', pending: '追蹤血脂' })
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
    try {
      await A.acceptDeptTransfer(stroke.id, { shownOrderIds: [...shown, late.id], stopOrderIds: [], acceptNote: ' ' })
      ok(false, '沒寫接收評估應被擋下')
    } catch (e) {
      ok(e.field === 'acceptNote', '接受轉科要寫接收評估')
    }
    ok(item.transfer.summary?.problems === '右側肌力 3 分', '新科的轉入申請看得到轉出摘要（決定接不接之前）')
    await expectError(() => A.acceptDeptTransfer(stroke.id, { shownOrderIds: shown, stopOrderIds: [], acceptNote: '接手' }), '原科剛又開的醫囑新主治沒看過就接受')
    const bed = db().beds.find((b) => b.status === 'empty' && b.ward !== db().beds.find((x) => x.id === stroke.bedId).ward)
    const oldBed = stroke.bedId
    v = await A.acceptDeptTransfer(stroke.id, { shownOrderIds: [...shown, late.id], stopOrderIds: [med.id, late.id], bedId: bed.id, acceptNote: '意識清楚，右側肌力 3 分；開始物理與職能治療' })
    const notesNow = db().progressNotes.filter((n) => n.admissionId === stroke.id && n.kind)
    ok(notesNow.some((n) => n.kind === 'transferOut' && n.items.some((i) => i.label === '目前問題' && i.text === '右側肌力 3 分')) && notesNow.some((n) => n.kind === 'transferIn' && n.doctorId === 'DR09' && n.items.some((i) => i.text.includes('開始物理'))), '轉出摘要、接收評估都寫進病程紀錄（病歷看得到交接）')
    const a2 = db().admissions.find((a) => a.id === stroke.id)
    const x = a2.deptTransfers.at(-1)
    ok(v.deptId === 'D08' && v.doctorId === 'DR09' && a2.attendingHistory.at(-1).reason.startsWith('轉科：內科 → 復健科') && x.status === 'accepted' && db().auditLogs[0].action === '接受轉科',
      '接受：科別、主治改為復健科與接手醫師；主治變更紀錄註明轉科；寫入稽核')
    const kept = shown.filter((id) => id !== med.id)
    ok(db().ipdOrders.find((o) => o.id === med.id).status === 'stopped' && kept.every((id) => db().ipdOrders.find((o) => o.id === id).status === 'active') && !db().mar.some((m) => m.orderId === med.id && m.status === 'pending'),
      `醫囑：停止勾選的 2 筆（排程一併刪除），其餘 ${kept.length} 筆延續（仍記原開立者）`)
    ok(v.bed?.id === bed.id && db().beds.find((b) => b.id === oldBed).status === 'cleaning' && x.fromBedId === oldBed && x.toBedId === bed.id, `一併轉床：${db().beds.find((b) => b.id === oldBed).bedNo} → ${bed.bedNo}（原床清潔中）`)
    await as('ph01')
    ok((await api.udApi.getUdWork()).awaitingWard.some((r) => r.admissionId === stroke.id && r.causes.includes('醫囑停止')), '停止的給藥醫囑已調劑沒給的，自動列入待退藥（等病房送回）')
    await as('nurse01')
    ok((await api.nursingApi.listNursingOrders(stroke.id)).flatMap((g) => g.orders).some((o) => o.id === med.id && o.needsAck), '護理站：轉科停止的醫囑要核對')
    await as('dr09')
    ok((await api.dashboardApi.getDashboard()).transferIncoming === 0 && (await A.listAdmissions({ status: ['admitted'] })).some((a) => a.id === stroke.id && a.doctorId === 'DR09'), '接受後：待辦清空，病人出現在新主治的住院病人清單')
    await expectError(() => A.acceptDeptTransfer(stroke.id, { shownOrderIds: [], stopOrderIds: [], acceptNote: 'x' }), '已接受的轉科再接受一次')
  }

  // 住院會診：主治開單 → 會診科回覆（看摘要）→ 建議轉科 → 一鍵帶入轉科申請；申請與回覆寫進病程紀錄
  console.log('\n[住院會診]')
  {
    resetDb('small')
    const CS = api.consultApi
    const db = () => dbm.db
    const seed1 = db().consults.find((c) => c.id === 'CS-SEED-1')
    const seed2 = db().consults.find((c) => c.id === 'CS-SEED-2')
    ok(seed1?.status === 'pending' && seed1.toDeptId === 'D03' && seed2?.status === 'answered' && db().progressNotes.some((n) => n.id === 'PN-SEED-CS2R' && n.kind === 'consultReply'), '種子：一張待外科回覆的會診、一張耳鼻喉科已回覆（病程紀錄有回覆）')
    ok(db().admissions.some((a) => a.deptTransfers?.[0]?.summary?.course), '種子：申請中的轉科有轉出摘要')
    await as('dr04')
    const inc = await CS.listIncomingConsults()
    const it = inc.find((x) => x.consult.id === 'CS-SEED-1')
    ok(it && it.summary.admission.diagnosis.startsWith('E11.65') && it.summary.orders.length > 0 && it.consult.waitingHours >= 0 && (await api.dashboardApi.getDashboard()).consultIncoming >= 1,
      `外科 dr04：待回覆會診（附病人摘要：${it?.summary.orders.length} 筆執行中醫囑、最近病程），首頁待辦也有`)
    await as('dr05')
    ok(!(await CS.listIncomingConsults()).some((x) => x.consult.id === 'CS-SEED-1'), '別科（小兒科）看不到外科的會診')
    await expectError(() => CS.answerConsult('CS-SEED-1', { findings: 'x', recommendation: 'y' }), '別科醫師回覆')
    // 主治開會診：欄位與規則
    const dm = db().admissions.find((a) => a.id === seed1.admissionId)
    const fromUser = db().users.find((u) => u.doctorId === dm.doctorId).username
    await as('dr04')
    await expectError(() => CS.requestConsult(dm.id, { toDeptId: 'D06', question: '外科代開' }), '別科醫師替這位病人開會診')
    await as(fromUser)
    try {
      await CS.requestConsult(dm.id, { toDeptId: dm.deptId, question: '' })
      ok(false, '欄位錯誤應被擋下')
    } catch (e) {
      ok(e.fields?.toDeptId && e.fields?.question, '會診欄位一次標出：同科不能會診、要寫目的')
    }
    await expectError(() => CS.requestConsult(dm.id, { toDeptId: 'D03', question: '再問一次' }), '同一科還有待回覆的會診又開一張')
    const urgent = await CS.requestConsult(dm.id, { toDeptId: 'D06', toDoctorId: 'DR07', question: '右膝腫痛，請評估是否痛風', urgent: true })
    ok(urgent.urgent && db().progressNotes.some((n) => n.admissionId === dm.id && n.kind === 'consult' && n.items.some((i) => i.text.includes('急會診'))) && db().auditLogs[0].action === '會診申請', '急會診：寫進病程紀錄、稽核')
    await as('dr07')
    const inc7 = await CS.listIncomingConsults()
    ok(inc7[0]?.consult.id === urgent.id && (await api.dashboardApi.getDashboard()).consultUrgent >= 1, '急會診排最前面，首頁待辦標急')
    await as('dr04')
    try {
      await CS.answerConsult('CS-SEED-1', { findings: '', recommendation: '' })
      ok(false, '回覆空白應被擋下')
    } catch (e) {
      ok(e.fields?.findings && e.fields?.recommendation, '回覆要寫評估與建議（一次標出）')
    }
    const ans = await CS.answerConsult('CS-SEED-1', { findings: '左足大拇趾蜂窩性組織炎合併局部膿瘍', recommendation: '需清創，建議轉外科處理', suggestTransfer: true })
    ok(ans.status === 'answered' && ans.answeredBy === 'DR04' && db().progressNotes.some((n) => n.admissionId === dm.id && n.kind === 'consultReply' && n.doctorId === 'DR04' && n.items.some((i) => i.text === '建議轉入外科')), '回覆：寫進病程紀錄（記在會診醫師名下），建議轉本科')
    await expectError(() => CS.answerConsult('CS-SEED-1', { findings: 'x', recommendation: 'y' }), '已回覆的再回覆')
    // 主治依會診申請轉科：會診單號帶進申請；科別不符擋下
    await as(fromUser)
    const mine = await CS.listConsults(dm.id)
    ok(mine.find((c) => c.id === 'CS-SEED-1')?.suggestTransfer && mine[0].requestedAt >= mine.at(-1).requestedAt, '主治看得到回覆與「建議轉科」（新到舊）')
    const sum = { course: '血糖控制不佳入院，胰島素調整中', problems: '左足傷口感染需清創' }
    await expectError(() => api.admissionApi.requestDeptTransfer(dm.id, { toDeptId: 'D06', reason: '依會診', ...sum, consultId: 'CS-SEED-1' }), '依外科會診卻申請轉骨科')
    const v = await api.admissionApi.requestDeptTransfer(dm.id, { toDeptId: 'D03', toDoctorId: 'DR04', reason: '依外科會診建議清創', ...sum, consultId: 'CS-SEED-1' })
    ok(v.lastTransfer?.consultId === 'CS-SEED-1' && v.lastTransfer.summary?.problems === '左足傷口感染需清創', '依會診申請轉科：記下會診單號與轉出摘要')
    // 撤回：只能撤回待回覆的、要寫原因
    try {
      await CS.cancelConsult(urgent.id, ' ')
      ok(false, '撤回沒寫原因應被擋下')
    } catch (e) {
      ok(e.fields?.reason, '撤回會診要寫原因')
    }
    await CS.cancelConsult(urgent.id, '病情已改善')
    ok(db().consults.find((c) => c.id === urgent.id).status === 'cancelled', '撤回待回覆的會診')
    await expectError(() => CS.cancelConsult('CS-SEED-1', '改主意'), '撤回已回覆的會診')
    await as('dr07')
    ok(!(await CS.listIncomingConsults()).some((x) => x.consult.id === urgent.id), '撤回後骨科清單不再有這張')
    await as('clerk01')
  }

  // 部分退藥 → 差額退費：藥局逐項退、可分次；櫃台用病人實際拿走的藥重算，退差額（先抵欠款），收據不作廢
  console.log('\n[部分退藥、部分退費]')
  {
    resetDb('small')
    const db = () => dbm.db
    const PH = api.pharmacyApi
    const C = api.chargeApi
    const B = await load('/src/services/billing.ts')
    const V = await load('/src/services/views.ts')
    const R = await load('/src/services/rx-rules.ts')
    const encOf = (d) => db().encounters.find((e) => e.id === d.encounterId)
    const chargeOf = (d) => db().charges.find((c) => c.visitId === d.visitId && !c.voided)
    const lotSum = (drugId, loc) => db().drugLots.filter((l) => l.drugId === drugId && l.locationId === loc).reduce((n, l) => n + l.qty, 0)
    const counting = (drugId) => db().stocktakes.some((st) => (st.status === 'counting' || st.status === 'submitted') && st.lines.some((l) => l.drugId === drugId))
    // 測試自己用同一組計算重算：病人實際拿走的藥（處方 − 退的）
    const totalAfter = (d, back) => {
      const v = db().visits.find((x) => x.id === d.visitId)
      const e = encOf(d)
      const meds = e.medications.map((m, i) => ({ ...m, qty: m.qty - (back[i] ?? 0) })).filter((m) => m.qty > 0)
      const ch = chargeOf(d)
      const base = B.calcChargeLines(v, { ...e, medications: meds }, V.billingLookup(v.identityCode))
      const rule = ch.discount ? db().discounts.find((x) => x.code === ch.discount.code) : undefined
      return B.summarize(rule ? B.applyDiscount(base, rule) : base)
    }
    const candidates = db().dispenses.filter((d) => d.status === 'dispensed' && d.txnIds?.length && d.dispensedAt.slice(0, 10) < T && encOf(d).medications.length >= 2 && encOf(d).medications.every((m) => !counting(m.drugId)) && chargeOf(d))
    // 退掉第一項會讓應付變少的（藥品部分負擔降一級）、沒有欠款
    const d1 = candidates.find((d) => !chargeOf(d).owed && chargeOf(d).patientTotal > totalAfter(d, { 0: encOf(d).medications[0].qty }).patientTotal)
    ok(!!d1, '種子有一張以前發的藥、退掉一項應付會變少的調劑單')
    const m0 = encOf(d1).medications[0]
    const tx0 = db().stockTxns.find((x) => x.id === d1.txnIds[0])
    await as('clerk01')
    await expectError(() => PH.returnDispense(d1.id, { reason: 'x', lines: [{ idx: 0, qty: 1 }] }), '櫃台退藥')
    await as('ph01')
    const errs = async (input) => {
      try {
        await PH.returnDispense(d1.id, input)
        return {}
      } catch (e) {
        return e.fields ?? { [e.field]: e.message }
      }
    }
    let e1 = await errs({ reason: '', lines: [{ idx: 0, qty: m0.qty + 1 }, { idx: 1, qty: 1.5 }] })
    ok(e1['qty.0']?.includes(`最多退 ${m0.qty}`) && e1['qty.1']?.includes('整數') && e1.reason, '超過發出的量、不是整數、沒寫原因：一次標在各欄')
    e1 = await errs({ reason: '病人不需要了', lines: [{ idx: 0, qty: 0 }] })
    ok(!!e1.lines, '每一項都是 0 → 「請填要退的數量」')
    // 第一次：退第一項的一部分（留 1 個）
    const loc = tx0.locationId
    const before0 = lotSum(m0.drugId, loc)
    const part = m0.qty - 1
    const v1 = await PH.returnDispense(d1.id, { reason: '病人不需要了', lines: [{ idx: 0, qty: part }] })
    ok(v1.status === 'dispensed' && v1.items[0].returned === part && db().visits.find((v) => v.id === d1.visitId).status === 'dispensed', `部分退藥：${m0.drugId} 退 ${part}，調劑單仍是已發藥、掛號狀態不變，品項標「已退 ${part}」`)
    const lastLot = tx0.lots.at(-1)
    ok(lotSum(m0.drugId, loc) === before0 + part && db().dispenses.find((x) => x.id === d1.id).returns[0].lines[0].lots[0].lotNo === lastLot.lotNo, '退回發出時的批號（從效期晚的那批先退），庫存加回')
    ok(ledgerBroken(db()).length === 0 && db().auditLogs[0].action === '門診退藥' && !db().auditLogs[0].detail.includes('全部退完'), '帳本對得起來；稽核寫退了什麼')
    e1 = await errs({ reason: '再退', lines: [{ idx: 0, qty: 2 }] })
    ok(e1['qty.0'] === '最多退 1', '分次退：第二次最多只能退剩下的（1）')

    // 櫃台：待退費＝原收據 − 用拿走的藥重算
    await as('clerk01')
    const ch1 = chargeOf(d1)
    let exp = totalAfter(d1, { 0: part })
    let rc = await C.getReceipt(ch1.id)
    ok(rc.pendingRefund && rc.pendingRefund.amount === ch1.patientTotal - exp.patientTotal && rc.pendingRefund.nhiPoints === ch1.nhiPoints - exp.nhiPoints && rc.pendingRefund.items[0].includes(`${part}`),
      `待退費 ${rc.pendingRefund?.amount} 元＝原應付 ${ch1.patientTotal} − 重算 ${exp.patientTotal}；申報點數 −${rc.pendingRefund?.nhiPoints}`)
    ok(!!rc.cancel?.blocked, '還有藥在病人手上：整張作廢、退費照樣擋（要退藥退完）')
    ok((await C.listPendingRefunds()).some((x) => x.chargeId === ch1.id) && (await api.dashboardApi.getDashboard()).pendingRefunds >= 1, '待退費清單（不限哪天看的診）與首頁待辦都看得到')
    const dayRep0 = await C.dailyReport(ch1.paidAt.slice(0, 10))
    const todayRep0 = await C.dailyReport(T)
    const pr = await C.refundReturnedDrugs(ch1.id)
    const last = pr.partialRefunds.at(-1)
    const pending1 = rc.pendingRefund
    ok(last.receiptNo?.startsWith('RF') && last.amount === pending1.amount && last.parts.reduce((n, x) => n + x.amount, 0) === pending1.cash && !pr.voided && db().auditLogs[0].action === '部分退費',
      `部分退費 ${last.receiptNo}：退 ${pending1.cash} 元，收據不作廢，寫稽核`)
    await expectError(() => C.refundReturnedDrugs(ch1.id), '同一筆差額再退一次')
    rc = await C.getReceipt(ch1.id)
    ok(!rc.pendingRefund && !(await C.listPendingRefunds()).some((x) => x.chargeId === ch1.id), '退完差額：待退費消失')
    const dayRep1 = await C.dailyReport(ch1.paidAt.slice(0, 10))
    const todayRep1 = await C.dailyReport(T)
    ok(dayRep1.patientTotal === dayRep0.patientTotal && dayRep1.collected === dayRep0.collected && dayRep1.nhiPoints === dayRep0.nhiPoints - pending1.nhiPoints,
      '原本那天的日結：收入不變（已交帳的不改），申報點數扣掉退掉的藥')
    ok(todayRep1.refunds.some((x) => x.kind === '部分退費' && x.receiptNo === last.receiptNo && x.amount === pending1.cash) && todayRep1.collected === todayRep0.collected - pending1.cash,
      '今天的日結：退款列出「部分退費」，實收少了退的錢')

    // 剩下的也退完 → 調劑單「已退藥」，整張退費扣掉已經部分退過的
    await as('ph01')
    const v2 = await returnAll(d1.id, '醫師改處方')
    ok(v2.status === 'returned' && db().visits.find((v) => v.id === d1.visitId).status === 'charged' && db().auditLogs[0].detail.includes('全部退完'), '剩下的全部退完：調劑單「已退藥」、掛號回到已批價')
    await as('clerk01')
    rc = await C.getReceipt(ch1.id)
    ok(!rc.pendingRefund && rc.cancel?.mode === 'refund' && rc.cancel.refundAmount === ch1.patientTotal - (ch1.prepaidApplied ?? 0) - pending1.cash, `全部退完改整張退費：退 ${rc.cancel?.refundAmount}（扣掉已部分退的 ${pending1.cash}）`)
    await C.refundCharge(ch1.id, '醫師改處方')
    ok(db().visits.find((v) => v.id === d1.visitId).status === 'consulted', '整張退費後回到待批價')

    // 有欠款的收據：差額先抵欠款（測試直接把一張收據改成結帳時記了欠款，模擬病人當時只付一部分）
    await as('ph01')
    const d2 = candidates.find((d) => d.id !== d1.id && chargeOf(d).patientTotal > totalAfter(d, { 0: encOf(d).medications[0].qty }).patientTotal)
    if (d2) {
      const c2 = chargeOf(d2)
      c2.owed = 10
      c2.oweReason = '測試：只帶部分現金'
      const out0 = B.outstandingOf(c2)
      await PH.returnDispense(d2.id, { reason: '病人過敏回診', lines: [{ idx: 0, qty: encOf(d2).medications[0].qty }] })
      await as('clerk01')
      const p2 = (await C.getReceipt(c2.id)).pendingRefund
      ok(p2.owedOffset === Math.min(out0, p2.amount) && p2.owedOffset > 0 && p2.cash === p2.amount - p2.owedOffset, `有欠款 ${out0} 元：差額 ${p2.amount} 先抵欠款 ${p2.owedOffset}，退還 ${p2.cash}`)
      await C.refundReturnedDrugs(c2.id)
      const c2b = db().charges.find((c) => c.id === c2.id)
      ok(B.outstandingOf(c2b) === out0 - p2.owedOffset && (await C.dailyReport(T)).refunds.some((x) => x.originalReceiptNo === c2.receiptNo && x.amount === p2.cash && x.payMethods.includes('抵欠款')), '欠款跟著減少；日結退款只算退出去的錢，註明抵欠款')
      await as('ph01')
    } else ok(false, '應有第二張退一項會變少的調劑單')

    // 部分負擔沒變：只更正申報點數、不開退款單
    const d3 = db().dispenses.find((d) => d.status === 'dispensed' && d.txnIds?.length && encOf(d).medications.length >= 2 && encOf(d).medications.every((m) => !counting(m.drugId)) && chargeOf(d) && !chargeOf(d).partialRefunds &&
      encOf(d).medications.some((m) => m.qty > 1 && totalAfter(d, { [encOf(d).medications.indexOf(m)]: 1 }).patientTotal === chargeOf(d).patientTotal))
    if (d3) {
      const k = encOf(d3).medications.findIndex((m, i) => m.qty > 1 && totalAfter(d3, { [i]: 1 }).patientTotal === chargeOf(d3).patientTotal)
      await PH.returnDispense(d3.id, { reason: '未拆封退回', lines: [{ idx: k, qty: 1 }] })
      await as('clerk01')
      const p3 = (await C.getReceipt(chargeOf(d3).id)).pendingRefund
      ok(p3 && p3.amount === 0 && p3.nhiPoints > 0, `退 1 個、部分負擔沒變：待退 0 元，只有申報點數 −${p3?.nhiPoints}`)
      const r3 = await C.refundReturnedDrugs(chargeOf(d3).id)
      ok(!r3.partialRefunds.at(-1).receiptNo && !(await C.dailyReport(T)).refunds.some((x) => x.originalReceiptNo === r3.receiptNo), '不退錢就不開退款單、日結也不列')
      await as('ph01')
    } else ok(true, '今天的種子沒有「退 1 個部分負擔不變」的單')

    // 不可再用：退回後直接報廢，要另一位藥師覆核
    const d4 = db().dispenses.find((d) => d.status === 'dispensed' && d.txnIds?.length && !d.returns?.length && encOf(d).medications.every((m) => !counting(m.drugId)) && encOf(d).medications[0].qty >= 2)
    const m4 = encOf(d4).medications[0]
    const loc4 = db().stockTxns.find((x) => x.id === d4.txnIds[0]).locationId
    const s4 = lotSum(m4.drugId, loc4)
    try {
      await PH.returnDispense(d4.id, { reason: '已拆封', lines: [{ idx: 0, qty: 1, scrap: true }] })
      ok(false, '不可再用沒有覆核應被擋下')
    } catch (e) {
      ok(e.field === 'witness', `不可再用沒有覆核 → 「${e.message}」`)
    }
    const w4 = await witnessOf({ purpose: 'scrapReturn', dispenseId: d4.id, items: `${m4.drugId} 1` }, 'ph02')
    await PH.returnDispense(d4.id, { reason: '已拆封', lines: [{ idx: 0, qty: 1, scrap: true }], witness: w4 })
    const scrapTx = db().stockTxns.filter((x) => x.drugId === m4.drugId && x.reason?.includes('不可再用'))
    ok(lotSum(m4.drugId, loc4) === s4 && scrapTx.length === 1 && scrapTx[0].reason.includes('覆核 林雅婷') && db().auditLogs[0].detail.includes('覆核 林雅婷'), '不可再用：退回後同時報廢（庫存不變），異動與稽核寫覆核人')
    ok(ledgerBroken(db()).length === 0, '部分退藥、報廢後帳本仍對得起來')
    ok(typeof R.keptMedications === 'function' && R.keptMedications([{ qty: 3 }, { qty: 2 }], { returns: [{ lines: [{ idx: 1, qty: 2 }] }] }).length === 1, 'keptMedications：退完的品項拿掉（批價重算只算病人拿走的）')
    const { readFileSync } = await import('node:fs')
    ok(!readFileSync('src/pages/charge/ChargePage.vue', 'utf8').match(/calcChargeLines|summarize\(/), '差額由服務層算，批價頁不自己算')
    await as('clerk01')
  }

  // 停診搬到掛號頁＋可設定；藥庫作業（撥發、審核退回）可限定給個人；日結報表只限櫃台與管理員
  console.log('\n[停診權限、藥庫作業權限、日結報表]')
  {
    resetDb('large')
    const db = () => dbm.db
    const PM = api.permissionApi
    const S = api.scheduleApi
    const uid = (name) => db().users.find((u) => u.username === name).id
    const { addDays } = await load('/src/utils/date.ts')
    const future = async () => {
      for (let i = 1; i < 10; i++) {
        const ss = (await S.listSessions({ date: addDays(T, i) })).filter((x) => !x.suspended && !x.closed)
        if (ss.length) return ss[0]
      }
    }
    await as('clerk01')
    const s1 = await future()
    await expectError(() => S.getSessionImpact(s1.id), '櫃台預設不能停診（只有管理員）')
    await as('admin')
    await expectError(() => PM.savePermissionRoles('schedule.suspend', { roles: ['admin', 'nurse'], reason: 'x' }), '停診給護理師（不在範圍）')
    await PM.setPermissionGrant('schedule.suspend', uid('clerk02'), { on: true, reason: '櫃台組長' })
    await as('clerk02')
    const imp = await S.getSessionImpact(s1.id)
    const list = await S.suspendSession(s1.id, '醫師病假')
    ok(imp.session.id === s1.id && Array.isArray(list) && !!(await S.listSessions({ date: s1.date })).find((x) => x.id === s1.id).suspended, '指定給櫃台組長（clerk02）：在掛號頁可以停診')
    await as('clerk01')
    const s3 = await future()
    await expectError(() => S.substituteSession(s3.id, 'x', '請假'), '沒被指定的櫃台還是不能代診')
    await as('admin')
    await PM.savePermissionRoles('schedule.suspend', { roles: ['admin', 'clerk'], reason: '櫃台都能停診' })
    await as('clerk01')
    const s2 = await future()
    ok((await S.getSessionImpact(s2.id)).session.id === s2.id, '整個櫃台角色打開後，clerk01 也可以')
    const { readFileSync } = await import('node:fs')
    const bp = readFileSync('src/pages/booking/BookingPage.vue', 'utf8')
    ok(bp.includes("can('schedule.suspend')") && bp.includes('<DailyAdjust') && readFileSync('src/pages/admin/components/SchedulePanel.vue', 'utf8').includes("@/components/DailyAdjust.vue"), '掛號頁與系統管理用同一個停診元件，按鈕跟權限走')

    // 藥庫作業：只指定給 ph02
    await as('admin')
    const PR2 = await load('/src/services/permission-rules.ts')
    try {
      await PM.savePermissionRoles('transfer.warehouse', { roles: [], reason: '只給藥庫藥師', confirm: true })
      ok(false, '還沒指定給任何人就取消全部角色應被擋下')
    } catch (e) {
      ok(e.fields?.roles?.includes('先指定給個人'), `還沒指定給任何人就取消全部角色 → 「${e.fields?.roles}」`)
    }
    await PM.setPermissionGrant('transfer.warehouse', uid('ph02'), { on: true, reason: '藥庫藥師' })
    await PM.savePermissionRoles('transfer.warehouse', { roles: [], reason: '只給藥庫藥師', confirm: true })
    await expectError(() => PM.setPermissionGrant('transfer.warehouse', uid('ph02'), { on: false, reason: '調職' }), '收回最後一位（沒有角色時）')
    const ph2 = db().users.find((u) => u.username === 'ph02')
    await expectError(() => api.adminApi.saveUser({ id: ph2.id, username: 'ph02', name: ph2.name, roles: ['pharmacist'], active: false }), '停用最後一位被指定藥庫作業的帳號')
    ok(PR2.checkPermissionRoles(PR2.permDef('schedule.suspend'), ['nurse'])?.includes('系統管理員、掛號批價'), '「只能給」的訊息寫角色名稱（不是英文代碼）')
    const reqT = db().transfers.find((x) => x.status === 'requested' && x.kind !== 'return')
    const issued = Object.fromEntries(reqT.lines.map((l) => [l.id, 0]))
    issued[reqT.lines.find((l) => l.drugId === 'M001')?.id ?? reqT.lines[0].id] = 1
    await as('ph01')
    await expectError(() => api.transferApi.issueTransfer(reqT.id, issued), '沒被指定的藥師撥發')
    const cand = (await api.transferApi.returnCandidates('LOC-OPD')).find((c) => c.qty >= 2 && c.flag !== 'expired')
    const rq = await api.transferApi.returnToWarehouse({ fromLocationId: 'LOC-OPD', reason: '請領過多', lines: [{ lotId: cand.lotId, qty: 1 }] })
    ok(rq.status === 'requested', '藥局端申請退回不受影響（ph01 照樣可以）')
    await expectError(() => api.transferApi.approveReturn(rq.id, { approved: { [rq.lines[0].id]: [1] } }), '沒被指定的藥師審核退回')
    await as('ph02')
    const ap = await api.transferApi.approveReturn(rq.id, { approved: { [rq.lines[0].id]: [1] } })
    const it = await api.transferApi.issueTransfer(reqT.id, issued)
    ok(ap.status === 'approved' && it.status === 'issued', '指定的藥庫藥師（ph02）可以撥發、審核退回')
    await as('ph01')
    ok((await api.transferApi.shipReturn(rq.id)).status === 'issued', '核准後的送出仍由藥局（ph01）')

    // 日結報表：只有櫃台與管理員
    await as('nurse01')
    await expectError(() => api.chargeApi.dailyReport(T), '護理師直接呼叫日結報表')
    await as('ph01')
    await expectError(() => api.chargeApi.dailyReport(T), '藥師直接呼叫日結報表')
    await as('admin')
    ok(typeof (await api.chargeApi.dailyReport(T)).collected === 'number', '管理員可以看日結')
    await as('clerk01')
  }

  // 誰能寫住院病人（care-team）：本科（主治、同科值班代理）、會診醫師（範圍內、只能動自己開的）；會診醫囑主治要已閱
  console.log('\n[住院寫入權限、會診醫師開醫囑]')
  {
    resetDb('small')
    const db = () => dbm.db
    const I = api.ipdApi
    const userOf = (doctorId) => db().users.find((u) => u.doctorId === doctorId).username
    const deptOf = (doctorId) => db().doctors.find((d) => d.id === doctorId).deptId
    const c1 = db().consults.find((c) => c.id === 'CS-SEED-1')
    const a1 = db().admissions.find((a) => a.id === c1.admissionId)
    const attending = userOf(a1.doctorId)
    const sameDept = db().doctors.find((d) => d.deptId === a1.deptId && d.id !== a1.doctorId && d.active && db().users.some((u) => u.doctorId === d.id))
    const outsider = db().doctors.find((d) => d.deptId !== a1.deptId && d.deptId !== c1.toDeptId && d.active && db().users.some((u) => u.doctorId === d.id))
    const med = { admissionId: a1.id, type: 'long', category: 'medication', drugId: 'M001', content: '', dose: 1, freq: 'PRN', route: 'PO', allowDuplicate: true }
    // 別科醫師（不是會診）什麼都不能寫
    await as(userOf(outsider.id))
    try {
      await I.addOrder(med)
      ok(false, '別科醫師開醫囑應被擋下')
    } catch (e) {
      ok(e.code === 'FORBIDDEN' && e.message.includes('會診醫師'), `別科醫師（${outsider.name}）開醫囑 → 「${e.message}」`)
    }
    await expectError(() => I.addProgressNote({ admissionId: a1.id, subjective: 'x', objective: '', assessment: '', plan: '' }), '別科醫師寫病程紀錄')
    await expectError(() => I.saveDischargeSummary(a1.id, { diagnosis: 'x', course: '', condition: '', followUp: '', dischargeType: '' }, false), '別科醫師寫出院病摘')
    const someOrder = db().ipdOrders.find((o) => o.admissionId === a1.id && o.status === 'active')
    await expectError(() => I.stopOrder(someOrder.id), '別科醫師停醫囑')
    // 同科醫師（值班、代理）可以
    await as(userOf(sameDept.id))
    const so = await I.addOrder(med)
    ok(so.doctorId === sameDept.id && !so.consultLabel, `同科醫師（${sameDept.name}，不是主治）可以開醫囑——值班代理`)
    await I.stopOrder(so.id)
    // 會診醫師（CS-SEED-1：沒指定醫師、待回覆——被會診那科的醫師都算）
    const consultant = userOf(c1.toDoctorId ?? db().doctors.find((d) => d.deptId === c1.toDeptId && d.active && db().users.some((u) => u.doctorId === d.id)).id)
    // 有指定醫師的會診：同科其他醫師不算
    const twoDoc = db().departments.find((dp) => dp.id !== a1.deptId && dp.id !== c1.toDeptId && db().doctors.filter((d) => d.deptId === dp.id && d.active && db().users.some((u) => u.doctorId === d.id)).length >= 2)
    if (twoDoc) {
      const [docA, docB] = db().doctors.filter((d) => d.deptId === twoDoc.id && d.active && db().users.some((u) => u.doctorId === d.id))
      await as(attending)
      await api.consultApi.requestConsult(a1.id, { toDeptId: twoDoc.id, toDoctorId: docA.id, question: '請評估' })
      await as(userOf(docB.id))
      await expectError(() => I.addOrder(med), '會診指定了別人：同科其他醫師開醫囑')
      await as(userOf(docA.id))
      ok((await I.addOrder({ ...med, drugId: 'M026' })).consultId, '被指定的會診醫師可以開')
    }
    // 指定醫師的規則（純函式；示範資料除了病人本科，沒有兩位醫師的科）：內科兩位醫師，指定 DR02 時 DR03 不算
    {
      const CT = await load('/src/services/care-team.ts')
      const fake = { id: 'X', admissionId: 'X', fromDeptId: 'D01', fromDoctorId: 'DR01', toDeptId: 'D02', toDoctorId: 'DR02', question: 'x', urgent: false, requestedAt: nowStr(), status: 'pending' }
      ok(CT.consultOpenFor(fake, 'DR02') && !CT.consultOpenFor(fake, 'DR03') && CT.consultOpenFor({ ...fake, toDoctorId: undefined }, 'DR03'), '指定了會診醫師：只有他；沒指定：該科醫師都算')
      ok(!CT.consultOpenFor({ ...fake, status: 'answered', answeredBy: 'DR03', answeredAt: nowStr() }, 'DR02') && CT.consultOpenFor({ ...fake, status: 'answered', answeredBy: 'DR02', answeredAt: nowStr() }, 'DR02'), '已回覆的：只有回覆的那位醫師')
    }
    await as(consultant)
    const inc = (await api.consultApi.listIncomingConsults()).find((x) => x.consult.id === c1.id)
    ok(inc?.canOrder, '待回覆的會診：會診醫師看得到「可以開醫囑」')
    const co = await I.addOrder({ ...med, drugId: 'M010', freq: 'TID' })
    ok(co.consultId === c1.id && co.consultLabel?.startsWith('會診：') && co.consultUnseen && db().auditLogs[0].detail.includes('會診'), `會診醫師開醫囑：標「${co.consultLabel}」、待主治已閱、稽核寫出會診`)
    await expectError(() => I.stopOrder(someOrder.id), '會診醫師停主治開的醫囑')
    await expectError(() => I.saveDischargeSummary(a1.id, { diagnosis: 'x', course: '', condition: '', followUp: '', dischargeType: '' }, false), '會診醫師寫出院病摘')
    await expectError(() => I.ackConsultOrders(a1.id), '會診醫師自己按已閱')
    ok(!!(await I.addProgressNote({ admissionId: a1.id, subjective: '', objective: '傷口癒合良好', assessment: '', plan: '' })).id, '會診醫師可以寫病程紀錄（追蹤）')
    const co2 = await I.addOrder({ ...med, drugId: 'M022', freq: 'QD' })
    ok((await I.stopOrder(co2.id)).status === 'stopped', '會診醫師可以停止自己開的醫囑')
    // 主治：首頁待辦、已閱
    await as(attending)
    let d = await api.dashboardApi.getDashboard()
    ok(d.consultOrdersUnseen >= 1, `主治首頁：會診醫師新開的醫囑（${d.consultOrdersUnseen} 位病人）`)
    const ack = await I.ackConsultOrders(a1.id)
    ok(ack.count === 2 && !(await I.listOrders(a1.id)).some((o) => o.consultUnseen) && db().auditLogs[0].action === '已閱會診醫囑', '主治按已閱：會診醫師開的（含已停止的）都標已閱，寫稽核')
    d = await api.dashboardApi.getDashboard()
    ok(!d.consultOrdersUnseen, '已閱後首頁待辦消失')
    await expectError(() => I.ackConsultOrders(a1.id), '沒有待確認的再按已閱')

    // 已回覆的會診：回覆的醫師 72 小時內還能開，之後不行
    const c2 = db().consults.find((c) => c.id === 'CS-SEED-2')
    const a2 = db().admissions.find((a) => a.id === c2.admissionId)
    await as(userOf(c2.answeredBy))
    const hrs = (Date.parse(nowStr().replace(' ', 'T')) - Date.parse(c2.answeredAt.replace(' ', 'T'))) / 3_600_000
    const med2 = { ...med, admissionId: a2.id }
    if (hrs <= 72) {
      ok((await api.consultApi.listIncomingConsults()).some((x) => x.consult.id === c2.id && x.canOrder), '已回覆 72 小時內：會診追蹤清單看得到、可以開醫囑')
      const o2 = await I.addOrder(med2)
      ok(o2.consultId === c2.id, '回覆後 72 小時內：會診醫師還能開醫囑')
    }
    clockBase += (73 - Math.min(hrs, 0)) * 3_600_000
    try {
      await expectError(() => I.addOrder(med2), '會診回覆超過 72 小時再開醫囑')
      ok(!(await api.consultApi.listIncomingConsults()).some((x) => x.consult.id === c2.id), '超過 72 小時：會診追蹤清單不再列')
    } finally {
      clockBase -= (73 - Math.min(hrs, 0)) * 3_600_000
    }
    const { readFileSync } = await import('node:fs')
    ok(!readFileSync('src/services/index.ts', 'utf8').includes('care-team'), 'care-team 是內部模組（不是 API）')
    await as('clerk01')
  }

  // 檢驗、處置未執行：櫃台標記（醫令照留）→ 同一個待退費流程退差額；退費前可撤銷
  console.log('\n[檢驗處置未執行、部分退費]')
  {
    resetDb('small')
    const db = () => dbm.db
    const C = api.chargeApi
    const B = await load('/src/services/billing.ts')
    const V = await load('/src/services/views.ts')
    const encOf = (c) => db().encounters.find((e) => e.visitId === c.visitId)
    const chargeOf = (id) => db().charges.find((c) => c.id === id)
    // 用同一組計算：拿掉沒做的處置重算
    const totalWithout = (c, idxs) => {
      const v = db().visits.find((x) => x.id === c.visitId)
      const e = encOf(c)
      const base = B.calcChargeLines(v, { ...e, procedures: e.procedures.filter((_, i) => !idxs.includes(i)) }, V.billingLookup(v.identityCode))
      const rule = c.discount ? db().discounts.find((x) => x.code === c.discount.code) : undefined
      return B.summarize(rule ? B.applyDiscount(base, rule) : base)
    }
    const withProc = db().charges.filter((c) => !c.voided && !c.partialRefunds && encOf(c)?.procedures.length && db().dispenses.find((d) => d.visitId === c.visitId)?.status !== 'returned')
    // 已經發出檢驗、影像報告的不能標未執行（做過了）：挑還沒有報告的處置
    const reported = (c, x) => [...db().labReports, ...db().imagingReports].some((r) => r.encounterId === encOf(c).id && r.procId === x.procId)
    const c1 = withProc.find((c) => encOf(c).procedures.some((x) => !x.selfPay && !reported(c, x)))
    ok(!!c1, '種子有開了檢驗處置的收據')
    const k = encOf(c1).procedures.findIndex((x) => !x.selfPay && !reported(c1, x))
    await as('nurse01')
    await expectError(() => C.markProcedureNotDone(c1.id, k, '病人未抽血'), '護理師標未執行（只有批價）')
    await as('clerk01')
    try {
      await C.markProcedureNotDone(c1.id, k, ' ')
      ok(false, '沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'reason', '標未執行要寫原因')
    }
    let r = await C.markProcedureNotDone(c1.id, k, '病人未抽血即離開')
    const exp = totalWithout(c1, [k])
    ok(r.procedures[k].notDone?.reason === '病人未抽血即離開' && r.pendingRefund?.nhiPoints === c1.nhiPoints - exp.nhiPoints && r.pendingRefund.amount === c1.patientTotal - exp.patientTotal && r.pendingRefund.items.some((x) => x.includes('（未執行）')),
      `標未執行（健保項目）：待退 ${r.pendingRefund?.amount} 元、申報點數 −${r.pendingRefund?.nhiPoints}（用做了的重算）`)
    ok(encOf(c1).procedures[k].procId && db().auditLogs[0].action === '標記未執行', '醫令照留（只標執行狀態），寫稽核')
    await expectError(() => C.markProcedureNotDone(c1.id, k, '再標'), '同一項標兩次')
    r = await C.unmarkProcedureNotDone(c1.id, k)
    ok(!r.procedures[k].notDone && !r.pendingRefund, '退費前可以撤銷：待退費消失')
    await C.markProcedureNotDone(c1.id, k, '病人未抽血即離開')
    ok((await C.listPendingRefunds()).some((x) => x.chargeId === c1.id), '列在批價頁「待退費」（不限哪天）')
    const done = await C.refundReturnedDrugs(c1.id)
    const last = done.partialRefunds.at(-1)
    ok(last.reason.startsWith('部分退費：') && last.reason.includes('未執行') && encOf(c1).procedures[k].notDone.settledAt, '退差額：退費紀錄寫出未執行的項目，該項標「已退費」')
    await expectError(() => C.unmarkProcedureNotDone(c1.id, k), '已退費的未執行撤銷')
    ok((await C.getReceipt(c1.id)).procedures[k].notDone.settled && !(await C.getReceipt(c1.id)).pendingRefund, '收據上該項標已退費、沒有待退費了')
    // 醫師的就診紀錄看得到未執行
    await as(db().users.find((u) => u.doctorId === encOf(c1).doctorId)?.username ?? 'dr01')
    const pt = db().visits.find((v) => v.id === c1.visitId).patientId
    const hist = await api.opdApi.patientHistory(pt)
    ok(hist.some((h) => h.procedureNames.some((n) => n.includes('未執行：病人未抽血即離開'))), '醫師看就診紀錄：處置標「未執行：原因」')
    // 自費項目：自己掛號、看診開一項自費流感快篩、結帳 → 標未執行 → 退錢、開退款單
    {
      const { addDays } = await load('/src/utils/date.ts')
      await as('clerk01')
      const ss = [...(await api.scheduleApi.listSessions({ date: T })), ...(await api.scheduleApi.listSessions({ date: addDays(T, 1) }))]
      const sess = ss.find((x) => !x.full && !x.closed && !x.suspended)
      const pt2 = db().patients.find((x) => !x.allergies.length && !x.deceasedAt && !db().visits.some((v) => v.date === sess.date && v.patientId === x.id))
      const v2 = await api.bookingApi.register({ patientId: pt2.id, sessionId: sess.id, identityCode: '01', caseType: '01' })
      await as(db().users.find((u) => u.doctorId === sess.doctorId).username)
      const e2 = await api.opdApi.startConsult(v2.id, { allowParallel: true, allowNotCheckedIn: true })
      await api.opdApi.completeEncounter(e2.id, { subjective: '測試', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'J06.9', name: '急性上呼吸道感染', primary: true }], medications: [], procedures: [{ procId: 'P012', qty: 1, selfPay: true, notDone: { reason: '偷塞', by: 'x', at: T } }], refillTimes: 0, admissionRequested: false })
      ok(!db().encounters.find((x) => x.id === e2.id).procedures[0].notDone, '醫師送來的病歷帶「未執行」：存的時候拿掉')
      await as('clerk01')
      const pv = await C.previewCharge(v2.id)
      const c2 = await C.pay(v2.id, { payMethod: 'cash', received: pv.patientTotal })
      const r2 = await C.markProcedureNotDone(c2.id, 0, '病人不做快篩了')
      const ex2 = totalWithout(chargeOf(c2.id), [0])
      ok(r2.pendingRefund?.amount === c2.patientTotal - ex2.patientTotal && r2.pendingRefund.amount === 500, `自費項目未執行：退 ${r2.pendingRefund?.amount} 元（自費價）`)
      const d2 = await C.refundReturnedDrugs(c2.id)
      ok(d2.partialRefunds.at(-1).receiptNo?.startsWith('RF') && d2.partialRefunds.at(-1).parts[0].amount === 500 && (await C.dailyReport(T)).refunds.some((x) => x.receiptNo === d2.partialRefunds.at(-1).receiptNo), '自費退錢：開退款單、日結列出')
    }
    // 整張作廢或退費後重新批價：未執行清掉（由醫師決定醫令）
    const c3 = db().charges.find((c) => !c.voided && !c.partialRefunds && encOf(c)?.procedures.length && c.paidAt.slice(0, 10) === T && !c.repayments?.length && !db().dispenses.some((d) => d.visitId === c.visitId && d.status === 'dispensed'))
    if (c3) {
      await C.markProcedureNotDone(c3.id, 0, '醫師取消')
      await C.voidCharge(c3.id, '重新批價')
      ok(!encOf(c3).procedures[0].notDone, '收據作廢、重新批價：未執行清掉（醫師改醫令再批價）')
    } else ok(true, '今天沒有可作廢、有處置的收據（不測重新批價）')
    const { readFileSync } = await import('node:fs')
    ok(readFileSync('src/services/opd.ts', 'utf8').includes('Object.assign(e, cleanDraft(draft))') && !readFileSync('src/services/opd.ts', 'utf8').includes('Object.assign(e, structuredClone(draft))') && readFileSync('src/pages/opd/OpdPage.vue', 'utf8').includes('const { notDone: _, ...rest } = p'),
      '「未執行」只能由批價標：存病歷、同前次、組套都拿掉')
  }

  // 管制藥簿冊與殘餘量：Morphine 0.5 AMP——整支扣、殘餘見證銷毀；簿冊逐筆收支結存、病人、醫師、見證，期初＋收−支＝期末＝帳上
  console.log('\n[管制藥簿冊、殘餘量銷毀]')
  {
    resetDb('small')
    const db = () => dbm.db
    const DR = await load('/src/services/drug-rules.ts')
    const CSV = await load('/src/services/report-csv.ts')
    const morphine = db().drugs.find((d) => d.id === 'M039')
    ok(DR.residualOf(morphine, 0.5)?.take === 1 && DR.residualOf(morphine, 0.5)?.residual === 0.5 && !DR.residualOf(morphine, 1) && !DR.residualOf(db().drugs.find((d) => d.id === 'M001'), 0.5), '殘餘量規則：管制藥不是整數的劑量才有（0.5 AMP → 扣 1、殘餘 0.5）；整數或非管制藥沒有')
    ok(DR.doseStrengthText(morphine, 0.5) === '5 mg' && DR.doseStrengthText(morphine, 0.25) === '2.5 mg', '劑量換算含量：0.5 AMP ＝ 5 mg')
    const w5 = db().stockLocations.find((l) => l.kind === 'ward' && l.ward.startsWith('5A'))
    const a = db().admissions.find((x) => x.status === 'admitted' && db().beds.find((b) => b.id === x.bedId)?.ward === w5.ward)
    const docUser = db().users.find((u) => u.doctorId === a.doctorId).username
    const qty = () => db().drugLots.filter((l) => l.drugId === 'M039' && l.locationId === w5.id).reduce((n, l) => n + l.qty, 0)
    await as(docUser)
    const o = await api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'medication', drugId: 'M039', content: '', dose: 0.5, freq: 'PRN', route: 'IM', allowDuplicate: true })
    ok(o.doseStrength === '5 mg' && o.residualQty === 0.5, `醫囑「Morphine 每次 0.5 AMP（${o.doseStrength}）」標出每次殘餘 0.5 要見證銷毀`)
    await as('nurse01')
    const before = qty()
    try {
      await api.nursingApi.givePrn(o.id, '疼痛分數 8 分')
      ok(false, '沒有見證應被擋下')
    } catch (e) {
      ok(e.field === 'witness' && e.message.includes('殘餘 0.5'), `沒有見證就給 → 「${e.message}」`)
    }
    const self = await api.witnessApi.approveWitness({ purpose: 'residual', orderId: o.id, username: 'nurse01', password: '1234' })
    ok(!self.ok && self.message.includes('自己'), '見證人不能是自己')
    const tok = await witnessOf({ purpose: 'residual', orderId: o.id }, 'nurse02')
    const m = await api.nursingApi.givePrn(o.id, '疼痛分數 8 分', undefined, tok)
    const txn = db().stockTxns.at(-1)
    ok(qty() === before - 1 && m.residual?.qty === 0.5 && m.residual.witnessBy === 'U202' && txn.witnessBy === 'U202' && txn.patientId === a.patientId && txn.doctorId === a.doctorId && txn.reason.includes('殘餘 0.5'),
      '給 0.5 AMP：病房常備扣整支（−1）；給藥紀錄與異動記下殘餘 0.5 銷毀、見證人、病人、開立醫師')
    await expectError(() => api.nursingApi.givePrn(o.id, '再痛', undefined, tok), '同一張見證再用一次')
    ok(ledgerBroken(db()).length === 0, '殘餘量不動帳：帳本對得起來')

    // 簿冊
    await expectError(() => api.controlledApi.controlledLedger({ drugId: 'M039', locationId: w5.id, from: addDaysT(-30), to: T }), '護理師查管制藥簿冊')
    await as('ph01')
    await expectError(() => api.controlledApi.controlledLedger({ drugId: 'M001', locationId: w5.id, from: addDaysT(-30), to: T }), '非管制藥查簿冊')
    const L = await api.controlledApi.controlledLedger({ drugId: 'M039', locationId: w5.id, from: addDaysT(-30), to: T })
    const sumIn = L.rows.filter((r) => r.kind === 'in').reduce((n, r) => n + r.qty, 0)
    const sumOut = L.rows.filter((r) => r.kind === 'out').reduce((n, r) => n + r.qty, 0)
    ok(L.opening + sumIn - sumOut === L.closing && L.closing === qty(), `簿冊：期初 ${L.opening} ＋收入 ${sumIn} −支出 ${sumOut} ＝期末 ${L.closing}＝帳上`)
    const give = L.rows.find((r) => r.kind === 'out' && r.reason?.includes('殘餘'))
    const res = L.rows.find((r) => r.kind === 'residual')
    const pt = db().patients.find((x) => x.id === a.patientId)
    ok(give?.patientName === pt.name && give.doctorName && give.witnessName === '孫佩君' && res?.qty === 0.5 && res.witnessName === '孫佩君' && res.balance === give.balance && L.rows.indexOf(res) === L.rows.indexOf(give) + 1,
      '給藥那一筆列病人、開立醫師、見證；殘餘量銷毀緊接著另列一行（不動結存）')
    ok(L.rows.some((r) => r.typeLabel === '撥入' || r.typeLabel === '調整'), '病房常備的補充（撥入）、點班（調整）也在簿冊上')
    // 門診藥局的 Tramadol（第四級）：舊的發藥異動沒記病人，從調劑單回推
    const opd = db().stockLocations.find((l) => l.dispensesOpd).id
    const LT = await api.controlledApi.controlledLedger({ drugId: 'M031', locationId: opd, from: addDaysT(-30), to: T })
    // 種子的「門診調劑（每日彙總）」是示範用的整天用量（不是某張處方），列不出病人。
    // 自己開一張 Tramadol 門診處方、發藥，再把那筆異動的病人與醫師拿掉（模擬舊資料）：簿冊要從調劑單回推
    {
      const { addDays } = await load('/src/utils/date.ts')
      await as('clerk01')
      const ss = [...(await api.scheduleApi.listSessions({ date: T })), ...(await api.scheduleApi.listSessions({ date: addDays(T, 1) }))]
      const sess = ss.find((x) => !x.full && !x.closed && !x.suspended && x.date === T) ?? ss.find((x) => !x.full && !x.closed && !x.suspended)
      const ptx = db().patients.find((x) => !x.allergies.length && !x.deceasedAt && !db().visits.some((v) => v.date === sess.date && v.patientId === x.id))
      const vv = await api.bookingApi.register({ patientId: ptx.id, sessionId: sess.id, identityCode: '01', caseType: '01' })
      const drUser = db().users.find((u) => u.doctorId === sess.doctorId).username
      await as(drUser)
      const ee = await api.opdApi.startConsult(vv.id, { allowParallel: true, allowNotCheckedIn: true })
      await api.opdApi.completeEncounter(ee.id, { subjective: '腰痛', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'M54.5', name: '下背痛', primary: true }], medications: [{ drugId: 'M031', dose: 1, freq: 'TID', route: 'PO', days: 3, qty: 9, selfPay: false }], procedures: [], refillTimes: 0, admissionRequested: false })
      await as('clerk01')
      const pv = await api.chargeApi.previewCharge(vv.id)
      await api.chargeApi.pay(vv.id, { payMethod: 'cash', received: pv.patientTotal })
      await as('ph01')
      const dpx = db().dispenses.find((x) => x.visitId === vv.id)
      await api.pharmacyApi.verifyDispense(dpx.id)
      await api.pharmacyApi.dispense(dpx.id, { birthMMDD: ptx.birthDate.slice(5).replace('-', '') })
      const tx = db().stockTxns.find((x) => x.id === db().dispenses.find((d) => d.id === dpx.id).txnIds[0])
      ok(tx.patientId === ptx.id && tx.doctorId === sess.doctorId, '新的門診發藥異動直接記下病人與開立醫師')
      delete tx.patientId
      delete tx.doctorId
      const LX = await api.controlledApi.controlledLedger({ drugId: 'M031', locationId: opd, from: addDaysT(-30), to: addDays(T, 1) })
      const row = LX.rows.find((r) => r.ref === tx.ref && r.kind === 'out')
      ok(row?.patientName === ptx.name && row.doctorName === db().doctors.find((d) => d.id === sess.doctorId).name, '舊資料（異動沒記病人）：簿冊從調劑單回推出病人與開立醫師')
    }
    ok(LT.opening + LT.totalIn - LT.totalOut === LT.closing, '門診藥局的 Tramadol 簿冊：期初＋收−支＝期末')
    const csv = CSV.controlledLedgerCsv(L)
    ok(csv.startsWith('\uFEFF') && csv.includes('管制藥品收支結存簿冊') && csv.includes('殘餘量銷毀') && csv.includes('孫佩君') && csv.includes(`期末結存,${L.closing}`), '匯出 CSV：表頭、逐筆（含殘餘量、見證人）、期末')
    const opts = await api.controlledApi.controlledLedgerOptions()
    ok(opts.drugs.every((d) => d.controlled) && opts.drugs.length === 6 && opts.locations.some((l) => l.kind === 'ward'), '簿冊選項：只有管制藥（含 PCA 藥袋共 6 種）；地點含病房常備')
    // STAT 也一樣
    await as(docUser)
    const st = await api.ipdApi.addOrder({ admissionId: a.id, type: 'stat', category: 'medication', drugId: 'M039', content: '', dose: 0.5, freq: 'STAT', route: 'IM', allowDuplicate: true })
    await as('nurse01')
    const sm = db().mar.find((x) => x.orderId === st.id && x.status === 'pending')
    await expectError(() => api.nursingApi.executeMar(sm.id, 'given'), 'STAT 管制藥 0.5 AMP 沒有見證就給')
    const tok2 = await witnessOf({ purpose: 'residual', orderId: st.id }, 'nurse02')
    const sg = await api.nursingApi.executeMar(sm.id, 'given', '', undefined, undefined, tok2)
    ok(sg.residual?.qty === 0.5 && sg.stockFrom, 'STAT 給藥同樣：見證後給、記下殘餘量')
    await as('clerk01')
  }

  // 優免送簽：櫃台送簽、主管在首頁核准或退回；核准綁掛號＋類別＋櫃台、當天有效、結帳用掉
  console.log('\n[優免送簽]')
  {
    resetDb('small')
    const db = () => dbm.db
    const C = api.chargeApi
    const makeConsulted = async () => {
      await as('clerk01')
      const ss = [...(await api.scheduleApi.listSessions({ date: T })), ...(await api.scheduleApi.listSessions({ date: addDaysT(1) }))]
      const sess = ss.find((x) => !x.full && !x.closed && !x.suspended)
      const pt = db().patients.find((x) => !x.allergies.length && !x.deceasedAt && !db().visits.some((v) => v.date === sess.date && v.patientId === x.id))
      const v = await api.bookingApi.register({ patientId: pt.id, sessionId: sess.id, identityCode: '01', caseType: '01' })
      await as(db().users.find((u) => u.doctorId === sess.doctorId).username)
      const e = await api.opdApi.startConsult(v.id, { allowParallel: true, allowNotCheckedIn: true })
      await api.opdApi.completeEncounter(e.id, { subjective: '測試', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'J06.9', name: '急性上呼吸道感染', primary: true }], medications: [], procedures: [], refillTimes: 0, admissionRequested: false })
      await as('clerk01')
      return v
    }
    const v1 = await makeConsulted()
    try {
      await C.requestDiscountApproval({ visitId: v1.id, code: 'DC05' })
      ok(false, '沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'discountReason', '送簽也要寫優免原因（需註明原因的類別）')
    }
    await expectError(() => C.requestDiscountApproval({ visitId: v1.id, code: 'DC01', reason: 'x' }), '不需核准的類別送簽')
    let r1 = await C.requestDiscountApproval({ visitId: v1.id, code: 'DC05', reason: '院長特准' })
    ok(r1.status === 'pending' && r1.amount > 0 && db().auditLogs[0].action === '優免送簽', `送簽：待核准、減免 ${r1.amount} 元，寫稽核`)
    const pv = await C.previewCharge(v1.id, 'DC05')
    const payWith = (extra) => C.pay(v1.id, { payMethod: 'cash', received: 9999, discount: { code: 'DC05', reason: '院長特准', ...extra } })
    try {
      await payWith({ requestId: r1.id })
      ok(false, '送簽中結帳應被擋下')
    } catch (e) {
      ok(e.field === 'approval' && e.message.includes('還沒核准'), `送簽中就結帳 → 「${e.message}」`)
    }
    await expectError(() => C.listDiscountRequests(), '沒有核准權限的櫃台看待核准清單')
    await as('clerk02')
    ok((await C.listDiscountRequests()).some((x) => x.id === r1.id && x.patientName && x.ruleName && x.cashierName === '馬文琪'), '主管（clerk02）首頁看得到待核准：病人、類別、金額、送簽的櫃台')
    try {
      await C.decideDiscountRequest(r1.id, { approve: false })
      ok(false, '退回沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'reason', '退回要寫原因')
    }
    await C.decideDiscountRequest(r1.id, { approve: false, reason: '請補充說明' })
    await as('clerk01')
    try {
      await payWith({ requestId: r1.id })
      ok(false, '退回的送簽結帳應被擋下')
    } catch (e) {
      ok(e.message.includes('退回：請補充說明'), `被退回 → 「${e.message}」`)
    }
    ok((await C.getChargeDetail(v1.id, 'DC05')).discountRequest?.status === 'rejected', '批價頁看得到被退回與原因')
    r1 = await C.requestDiscountApproval({ visitId: v1.id, code: 'DC05', reason: '院長特准，已附公文' })
    await as('clerk02')
    const ap = await C.decideDiscountRequest(r1.id, { approve: true })
    ok(ap.status === 'approved' && ap.decidedByName === '鄭淑芬' && db().auditLogs[0].detail.includes('（送簽）'), '主管核准（寫稽核，標「送簽」）')
    // 核准綁送簽的櫃台：別的櫃台（clerk02 也能批價）拿來結帳不行
    try {
      await payWith({ requestId: r1.id })
      ok(false, '別的櫃台用這張核准應被擋下')
    } catch (e) {
      ok(e.field === 'approval' && e.message.includes('櫃台不同'), `別的櫃台拿這張送簽結帳 → 「${e.message}」`)
    }
    await as('clerk01')
    clockBase += 86_400_000
    try {
      await payWith({ requestId: r1.id })
      ok(false, '隔天用應被擋下')
    } catch (e) {
      ok(e.message.includes('只限當天'), `隔天才結帳 → 「${e.message}」`)
    } finally {
      clockBase -= 86_400_000
    }
    const ch = await C.pay(v1.id, { payMethod: 'cash', received: pv.patientTotal, discount: { code: 'DC05', reason: '院長特准', requestId: r1.id } })
    ok(ch.discount?.approverName === '鄭淑芬' && ch.discount.approvedBy === 'U402' && db().discountRequests.find((x) => x.id === r1.id).status === 'used', '結帳：收據記下核准的主管，送簽單用掉')
    // 撤回、不能核准自己送簽的、病人已批價不必處理
    const v2 = await makeConsulted()
    const r2 = await C.requestDiscountApproval({ visitId: v2.id, code: 'DC05', reason: '專案' })
    await C.cancelDiscountRequest(r2.id)
    await as('clerk02')
    await expectError(() => C.decideDiscountRequest(r2.id, { approve: true }), '核准已撤回的送簽')
    const r3 = await C.requestDiscountApproval({ visitId: v2.id, code: 'DC05', reason: '專案' })
    await expectError(() => C.decideDiscountRequest(r3.id, { approve: true }), '核准自己送簽的優免')
    await as('clerk01')
    const r4 = await C.requestDiscountApproval({ visitId: v2.id, code: 'DC05', reason: '專案' })
    ok(db().discountRequests.find((x) => x.id === r3.id).status === 'cancelled', '同一次掛號重送：舊的待核准自動撤回')
    await C.pay(v2.id, { payMethod: 'cash', received: 9999 })
    await as('clerk02')
    await expectError(() => C.decideDiscountRequest(r4.id, { approve: true }), '病人已批價（沒用優免）還去核准')
    ok(!(await C.listDiscountRequests()).some((x) => x.visitId === v2.id && x.status !== 'pending'), '待核准清單只列待核准的')
    await as('clerk01')
  }

  // 門診會診：看診中請別科書面會診（病人不必另外掛號、不收費）；回覆留在這次就醫，申請的醫師看過按已閱
  console.log('\n[門診會診]')
  {
    resetDb('small')
    const db = () => dbm.db
    const CS = api.consultApi
    const userOf = (doctorId) => db().users.find((u) => u.doctorId === doctorId)?.username
    // 今天、別科（不是內科）的診次：看完診的病人
    await as('clerk01')
    const sess = (await api.scheduleApi.listSessions({ date: T })).find((x) => !x.full && !x.closed && !x.suspended && x.deptId !== 'D02' && userOf(x.doctorId))
    const pt = db().patients.find((x) => !x.allergies.length && !x.deceasedAt && !db().visits.some((v) => v.date === T && v.patientId === x.id))
    const v = await api.bookingApi.register({ patientId: pt.id, sessionId: sess.id, identityCode: '01', caseType: '01' })
    const requester = userOf(sess.doctorId)
    await as(requester)
    await expectError(() => CS.requestOpdConsult(v.id, { toDeptId: 'D02', question: '請評估' }), '還沒看診就會診')
    const e = await api.opdApi.startConsult(v.id, { allowParallel: true, allowNotCheckedIn: true })
    await api.opdApi.saveDraft(e.id, { subjective: '血糖控制不佳三個月', objective: '', assessment: '第二型糖尿病', plan: '', vitals: { sbp: 142, dbp: 88 }, diagnoses: [{ icd: 'E11.9', name: '第二型糖尿病', primary: true }], medications: [], procedures: [], refillTimes: 0, admissionRequested: false })
    try {
      await CS.requestOpdConsult(v.id, { toDeptId: sess.deptId, question: '' })
      ok(false, '同科、沒寫目的應被擋下')
    } catch (e2) {
      ok(e2.fields?.toDeptId && e2.fields?.question, '同科會診、沒寫目的：一次標出')
    }
    await as('dr02')
    await expectError(() => CS.requestOpdConsult(v.id, { toDeptId: 'D03', question: 'x' }), '別科醫師替這位病人開會診')
    await as(requester)
    const c = await CS.requestOpdConsult(v.id, { toDeptId: 'D02', question: '血糖控制不佳，請評估是否調整用藥' })
    ok(c.visitId === v.id && !c.admissionId && c.status === 'pending' && db().auditLogs[0].action === '門診會診申請', '看診中開門診會診（掛在這次掛號上，不是住院）')
    await expectError(() => CS.requestOpdConsult(v.id, { toDeptId: 'D02', question: '再一張' }), '同一科還沒回覆又開一張')
    ok(!db().charges.some((x) => x.visitId === v.id) && !db().visits.some((x) => x.patientId === pt.id && x.deptId === 'D02' && x.date === T), '不收費、不替病人掛號（書面會診）')
    // 會診科（內科）
    await as('dr02')
    const d0 = await api.dashboardApi.getDashboard()
    const inc = (await CS.listIncomingOpdConsults()).find((x) => x.consult.id === c.id)
    ok(d0.opdConsultIncoming >= 1 && inc && inc.summary.diagnoses[0].includes('E11.9') && inc.summary.subjective.includes('血糖') && inc.summary.vitals === 'BP 142/88' && !inc.overdue, '內科醫師：首頁待辦、待回覆清單看得到這次看診的摘要（主訴、診斷、生命徵象「BP 142/88」）')
    ok(!(await CS.listIncomingConsults()).some((x) => x.consult.id === c.id), '門診會診不混進住院會診清單')
    const notes0 = db().progressNotes.length
    const ans = await CS.answerConsult(c.id, { findings: 'HbA1c 偏高，無低血糖', recommendation: '加 Metformin，三個月後內科追蹤', suggestVisit: true })
    ok(ans.status === 'answered' && ans.suggestVisit && !ans.suggestTransfer && db().progressNotes.length === notes0 && db().auditLogs[0].action === '門診會診回覆', '回覆：建議掛本科門診；不寫住院病程')
    // 申請的醫師：已回覆、已閱
    await as(requester)
    let d1 = await api.dashboardApi.getDashboard()
    ok(d1.consultReplies === 1 && (await CS.listOpdConsultReplies()).some((x) => x.id === c.id && x.findings), '申請的醫師：首頁待辦「會診已回覆」、看得到回覆')
    ok((await CS.listVisitConsults(v.id)).some((x) => x.id === c.id && x.status === 'answered'), '看診頁這次掛號的會診看得到回覆')
    await as('dr03')
    await expectError(() => CS.ackConsultReply(c.id), '不是申請的醫師按已閱')
    await as(requester)
    await CS.ackConsultReply(c.id)
    d1 = await api.dashboardApi.getDashboard()
    ok(!d1.consultReplies && !(await CS.listOpdConsultReplies()).length, '按已閱後待辦消失')
    // 完成看診後，就診紀錄看得到會診與回覆
    await api.opdApi.completeEncounter(e.id, { subjective: '血糖控制不佳三個月', objective: '', assessment: '第二型糖尿病', plan: '', vitals: {}, diagnoses: [{ icd: 'E11.9', name: '第二型糖尿病', primary: true }], medications: [], procedures: [], refillTimes: 0, admissionRequested: false })
    const hist = await api.opdApi.patientHistory(pt.id)
    ok(hist.some((h) => h.consults.some((x) => x.findings?.includes('HbA1c') && x.suggestVisit)), '就診紀錄：這次看診的會診與回覆')
    // 逾期：當天沒回覆的隔天標逾期，不會消失；撤回
    const c2 = await CS.requestOpdConsult(v.id, { toDeptId: 'D02', question: '血脂請一併評估' })
    clockBase += 86_400_000
    try {
      await as('dr02')
      ok((await CS.listIncomingOpdConsults()).find((x) => x.consult.id === c2.id)?.overdue, '當天沒回覆：隔天仍在清單上，標逾期')
      await as(requester)
      await expectError(() => CS.requestOpdConsult(v.id, { toDeptId: 'D02', question: 'x' }), '隔天才對昨天的看診開會診')
    } finally {
      clockBase -= 86_400_000
    }
    await as(requester)
    await CS.cancelConsult(c2.id, '已在門診當面討論')
    ok(db().consults.find((x) => x.id === c2.id).status === 'cancelled', '門診會診可以撤回')
    await as('clerk01')
  }

  // 匯出 Excel：自己產生的 xlsx（不壓縮的 zip＋XML）。拆開檢查 zip 結構與 CRC、工作表、數字／文字型別、轉義；內容和 CSV 同一份報表表格
  console.log('\n[匯出 Excel]')
  {
    resetDb('small')
    const db = () => dbm.db
    const XL = await load('/src/services/xlsx.ts')
    const RX = await load('/src/services/report-xlsx.ts')
    const CSV = await load('/src/services/report-csv.ts')
    // 自己寫一個最小的 zip 讀取：照中央目錄找每個檔，核對本地檔頭、大小與 CRC
    const unzip = (u8) => {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength)
      const eocd = u8.length - 22
      if (dv.getUint32(eocd, true) !== 0x06054b50) throw new Error('沒有 EOCD')
      const count = dv.getUint16(eocd + 10, true)
      let p = dv.getUint32(eocd + 16, true)
      const files = new Map()
      const dec = new TextDecoder('utf-8', { fatal: true })
      for (let i = 0; i < count; i++) {
        if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('中央目錄壞了')
        const crc = dv.getUint32(p + 16, true), size = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true)
        const name = dec.decode(u8.subarray(p + 46, p + 46 + nl))
        if (dv.getUint32(off, true) !== 0x04034b50 || dv.getUint16(off + 8, true) !== 0 || dv.getUint32(off + 14, true) !== crc) throw new Error('本地檔頭不符：' + name)
        const start = off + 30 + dv.getUint16(off + 26, true)
        const data = u8.subarray(start, start + size)
        if (XL.crc32(data) !== crc) throw new Error('CRC 不符：' + name)
        files.set(name, dec.decode(data))
        p += 46 + nl
      }
      return files
    }
    const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    const cellsOf = (xml) => {
      const m = new Map()
      for (const x of xml.matchAll(/<c r="([A-Z]+)(\d+)"( s="1")?( t="inlineStr")?>(?:<v>([^<]*)<\/v>|<is><t xml:space="preserve">([^<]*)<\/t><\/is>)<\/c>/g)) {
        m.set(x[1] + x[2], { bold: !!x[3], num: x[5] !== undefined ? Number(x[5]) : undefined, str: x[6] !== undefined ? unesc(x[6]) : undefined })
      }
      return m
    }
    const book = (u8) => {
      const f = unzip(u8)
      const names = [...f.get('xl/workbook.xml').matchAll(/<sheet name="([^"]*)"/g)].map((x) => unesc(x[1]))
      return { f, names, sheet: (i) => f.get(`xl/worksheets/sheet${i + 1}.xml`) }
    }
    const rowOf = (k) => Number(k.match(/\d+$/)[0])
    const colOf = (cells, col, from = 2) => [...cells].filter(([k]) => k.match(/^[A-Z]+/)[0] === col && rowOf(k) >= from).map(([, v]) => v)

    ok(XL.crc32(new TextEncoder().encode('123456789')) === 0xcbf43926, 'CRC32 標準測試值（"123456789" → CBF43926）')
    ok(XL.colName(0) === 'A' && XL.colName(25) === 'Z' && XL.colName(26) === 'AA' && XL.colName(701) === 'ZZ' && XL.colName(702) === 'AAA', '欄名：A、Z、AA、ZZ、AAA')

    const tricky = XL.buildXlsx([
      { name: 'a/b:c', rows: [['<林&"王>', '=1+1', '000123', -50, 1.5, NaN, 'x\u0001y', '', null]], bold: [0] },
      { name: 'a/b:c', rows: [[1]] },
    ])
    const tb = book(tricky)
    ok(tb.f.has('[Content_Types].xml') && tb.f.has('_rels/.rels') && tb.f.has('xl/styles.xml') && tb.f.has('xl/_rels/workbook.xml.rels') && tb.f.has('xl/worksheets/sheet2.xml'),
      'zip 拆得開、每個檔 CRC 對：內容型別、關聯、活頁簿、樣式、兩張工作表都在')
    ok(tb.names.join() === 'a_b_c,a_b_c_2', '工作表名稱的非法字元換掉、同名自動加序號')
    const tc = cellsOf(tb.sheet(0))
    ok(tc.get('A1').str === '<林&"王>' && tb.sheet(0).includes('&lt;林&amp;&quot;王&gt;'), '文字裡的 < & " > 有轉義（病人姓名有這些字元也打得開）')
    ok(tc.get('B1').str === '=1+1' && !tb.sheet(0).includes('<f>'), '「=1+1」存成文字、不是公式（不需要 CSV 那種加 \'）')
    ok(tc.get('C1').str === '000123' && tc.get('D1').num === -50 && tc.get('E1').num === 1.5, '000123 是文字（0 不會掉）；-50、1.5 是數字')
    ok(!tc.has('F1') && tc.get('G1').str === 'xy' && !tc.has('H1') && !tc.has('I1'), 'NaN、空字串、null 留空；XML 不允許的控制字元拿掉')
    ok(tc.get('A1').bold && tb.sheet(0).includes('<col min="1" max="1" width="'), '粗體列、欄寬有設')
    ok(Buffer.from(XL.buildXlsx([{ name: 'x', rows: [['a', 1]] }])).equals(Buffer.from(XL.buildXlsx([{ name: 'x', rows: [['a', 1]] }]))), '同樣內容產生一模一樣的檔（日期固定，不含現在時間）')

    // 收費報表（區間 7 天）
    await as('clerk01')
    const R = await api.chargeApi.dailyReport(addDaysT(-6), T)
    const rb = book(RX.dailyReportXlsx(R))
    ok(rb.names.join() === '明細,合計,每日小計', '區間報表：明細、合計、每日小計三張工作表')
    const det = cellsOf(rb.sheet(0))
    const tbl = CSV.dailyReportTable(R)
    ok(det.get('A1').str === '類別' && det.get('A1').bold && rb.sheet(0).includes('ySplit="1"') && colOf(det, 'A').length === tbl.rows.length,
      `明細：表頭粗體並凍結，${tbl.rows.length} 列＝CSV 同一份明細`)
    let valid = 0
    for (let i = 2; i <= tbl.rows.length + 1; i++) if (det.get('A' + i)?.str === '收費' && det.get('M' + i)?.str === '有效') valid += det.get('I' + i).num
    ok(tbl.rows.length > 0 && valid === R.patientTotal, `金額欄是數字：有效收據加總 ${valid} ＝ 應收合計 ${R.patientTotal}`)
    ok(['B', 'C', 'E'].every((c) => colOf(det, c).every((x) => x.str !== undefined)), '收據號、日期、病歷號存成文字（不會變成數字或日期）')
    const tot = cellsOf(rb.sheet(1))
    ok(tot.get('B1').str === R.date + ' ~ ' + R.to && [...tot.values()].some((c) => c.num === R.collected) && tot.get('A3').bold, '合計：期間、實收合計（數字）')
    const byDay = cellsOf(rb.sheet(2))
    ok(colOf(byDay, 'A').length === 7 && colOf(byDay, 'I').reduce((n, c) => n + c.num, 0) === R.collected, '每日小計 7 列、實收加總＝實收合計')
    const day = await api.chargeApi.dailyReport(T)
    ok(RX.reportXlsxFileName(R) === `收費報表_${R.date}_${R.to}.xlsx` && RX.reportXlsxFileName(day) === `日結_${T}.xlsx`, '檔名和 CSV 一樣，只換副檔名')
    ok(book(RX.dailyReportXlsx(day)).names.join() === '明細,合計', '單日日結沒有每日小計')

    // 管制藥簿冊
    await as('ph01')
    const opdLoc = db().stockLocations.find((l) => l.dispensesOpd).id
    const L = await api.controlledApi.controlledLedger({ drugId: 'M031', locationId: opdLoc, from: addDaysT(-30), to: T })
    const lb = book(RX.controlledLedgerXlsx(L))
    const lc = cellsOf(lb.sheet(0))
    const last = Math.max(...[...lc.keys()].map(rowOf))
    ok(lb.names.join() === '收支結存簿冊' && lc.get('A1').str === '管制藥品收支結存簿冊' && lc.get('A5').str === '日期時間' && lc.get('A5').bold && lb.sheet(0).includes('ySplit="5"'),
      '管制藥簿冊：一張，抬頭在上、表頭粗體並凍結')
    ok(lc.get('A' + last).str === '期末結存' && lc.get('B' + last).num === L.closing && lc.get('F6').num === L.opening, `期初 ${L.opening}、期末 ${L.closing} 是數字`)
    ok(colOf(lc, 'F', 7).length === L.rows.length, `逐筆 ${L.rows.length} 列（每列都有結存）`)
    ok(RX.controlledLedgerXlsxFileName(L).endsWith('.xlsx') && RX.controlledLedgerXlsxFileName(L).startsWith('管制藥簿冊_'), '簿冊檔名')
    await as('clerk01')
  }

  // 管制藥專用處方箋、醫師使用執照、領藥人身分證號、定期申報（申報表的每一格＝簿冊的數字）
  console.log('\n[管制藥專用處方箋、使用執照、申報]')
  {
    resetDb('small')
    const db = () => dbm.db
    const CR = await load('/src/services/controlled-rules.ts')
    const CSV = await load('/src/services/report-csv.ts')
    const XL = await load('/src/services/report-xlsx.ts')
    const { addDays } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    ok([1, 2, 3].every((n) => CR.needsSpecialRx(n)) && !CR.needsSpecialRx(4) && !CR.needsSpecialRx(undefined), '第一～三級要專用處方箋與使用執照；第四級、非管制藥不用')
    ok(CR.licenseProblem(undefined, T)?.includes('沒有') && CR.licenseProblem({ no: 'X', validUntil: addDaysT(-1) }, T)?.includes('到期') && !CR.licenseProblem({ no: 'X', validUntil: T }, T), '使用執照：沒有、昨天到期都不能開；到期當天仍可開')
    const up = [[9, '玖'], [10, '壹拾'], [14, '壹拾肆'], [20, '貳拾'], [60, '陸拾'], [105, '壹佰零伍'], [1000, '壹仟'], [1010, '壹仟零壹拾'], [0.5, '零點伍']]
    ok(up.every(([n, s]) => CR.chineseUpper(n) === s), `總量國字大寫：${up.map(([n]) => `${n}→${CR.chineseUpper(n)}`).join('、')}`)
    ok(CR.ID_NO_PATTERN.test('A123456789') && !CR.ID_NO_PATTERN.test('A323456789') && !CR.ID_NO_PATTERN.test('a123456789') && !CR.ID_NO_PATTERN.test('A12345678'), '身分證號格式：1 個大寫英文字母＋1 或 2＋8 個數字')

    const drug = (id) => db().drugs.find((d) => d.id === id)
    const doc = (id) => db().doctors.find((d) => d.id === id)
    const opd = db().stockLocations.find((l) => l.dispensesOpd).id
    const m41Lots = db().drugLots.filter((l) => l.drugId === 'M041' && l.qty > 0)
    ok(drug('M041').controlled === 2 && drug('M041').category === '口服' && m41Lots.length > 0 && m41Lots.every((l) => l.locationId === opd), '種子：Morphine 15mg 錠是第二級管制藥、只放門診藥局')
    ok(!doc('DR08').controlledLicense && doc('DR09').controlledLicense.validUntil < T && db().doctors.filter((d) => !['DR08', 'DR09'].includes(d.id)).every((d) => d.controlledLicense?.validUntil >= T), '種子：DR08 沒有使用執照、DR09 已過期，其他醫師有效')

    // 開一張門診：掛號 → 看診（醫師固定給有效執照，再依測試改）
    const newVisit = async () => {
      await as('clerk01')
      const ss = [...(await api.scheduleApi.listSessions({ date: T })), ...(await api.scheduleApi.listSessions({ date: addDaysT(1) }))]
      const sess = ss.find((x) => !x.full && !x.closed && !x.suspended && x.date === T) ?? ss.find((x) => !x.full && !x.closed && !x.suspended)
      const pt = db().patients.find((x) => !x.allergies.length && !x.deceasedAt && !db().visits.some((v) => v.date === sess.date && v.patientId === x.id))
      const vv = await api.bookingApi.register({ patientId: pt.id, sessionId: sess.id, identityCode: '01', caseType: '01' })
      doc(sess.doctorId).controlledLicense = { no: 'C99-TEST', validUntil: addDaysT(365) }
      await as(db().users.find((u) => u.doctorId === sess.doctorId).username)
      const ee = await api.opdApi.startConsult(vv.id, { allowParallel: true, allowNotCheckedIn: true })
      return { vv, ee, ptId: pt.id, docId: sess.doctorId }
    }
    const draftOf = (meds, extra = {}) => ({ subjective: '癌症疼痛', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'M54.5', name: '下背痛', primary: true }], medications: meds, procedures: [], refillTimes: 0, admissionRequested: false, ...extra })
    const m41 = { drugId: 'M041', dose: 1, freq: 'Q12H', route: 'PO', days: 7, qty: 14, selfPay: false }
    const m01 = { drugId: 'M001', dose: 1, freq: 'TID', route: 'PO', days: 3, qty: 9, selfPay: false }
    const m31 = { drugId: 'M031', dose: 1, freq: 'TID', route: 'PO', days: 3, qty: 9, selfPay: false }

    const A = await newVisit()
    const pat = () => db().patients.find((p) => p.id === A.ptId)
    ok(CR.ID_NO_PATTERN.test(pat().idNo) && !!pat().address, `示範病人有身分證號（${pat().idNo}）與地址`)
    delete doc(A.docId).controlledLicense
    let msg = await errOf(() => api.opdApi.completeEncounter(A.ee.id, draftOf([m41])))
    ok(msg.includes('沒有管制藥品使用執照') && msg.includes('Morphine 15mg Tab'), `沒有使用執照開第二級 → 「${msg}」`)
    doc(A.docId).controlledLicense = { no: 'C99-OLD', validUntil: addDaysT(-1) }
    msg = await errOf(() => api.opdApi.completeEncounter(A.ee.id, draftOf([m41])))
    ok(msg.includes('到期'), `使用執照已過期 → 「${msg}」`)
    doc(A.docId).controlledLicense = { no: 'C99-TEST', validUntil: T }
    const addr = pat().address
    pat().address = ' '
    msg = await errOf(() => api.opdApi.completeEncounter(A.ee.id, draftOf([m41])))
    ok(msg.includes('地址') && msg.includes('專用處方箋'), `病人沒有地址 → 「${msg}」`)
    pat().address = addr
    const idNo = pat().idNo
    pat().idNo = ''
    msg = await errOf(() => api.opdApi.completeEncounter(A.ee.id, draftOf([m41])))
    ok(msg.includes('身分證號'), `病人沒有身分證號 → 「${msg}」`)
    pat().idNo = idNo
    msg = await errOf(() => api.opdApi.completeEncounter(A.ee.id, draftOf([m41], { refillTimes: 2 })))
    ok(msg.includes('一次調劑'), `第二級開成連續處方箋 → 「${msg}」`)
    ok(db().encounters.find((e) => e.id === A.ee.id).status !== 'completed', '被擋下的都沒有完成看診')
    // 這位病人還在吃前次開的 Acetaminophen（成分重複提醒）：確認後才完成
    const rxOk = Object.fromEntries((await api.opdApi.rxAlerts(A.ee.id, [m41.drugId, m01.drugId])).map((x) => [x.key, '']))
    await api.opdApi.completeEncounter(A.ee.id, draftOf([m41, m01]), { rxAlertReasons: rxOk })
    ok(db().encounters.find((e) => e.id === A.ee.id).status === 'completed', '執照到期當天、病人資料齊全：可以開第二級')

    // 專用處方箋
    const S = await api.controlledApi.specialRxSheet(A.ee.id)
    ok(S.items.length === 1 && S.items[0].drugName === 'Morphine 15mg Tab' && S.items[0].controlled === 2 && S.items[0].qty === 14 && S.items[0].qtyUpper === '壹拾肆', '專用處方箋只列第一～三級的藥（Acetaminophen 照一般處方），總量 14 附國字大寫「壹拾肆」')
    ok(S.patient.idNo === idNo && S.patient.address === addr && S.doctor.controlledLicenseNo === 'C99-TEST' && !!S.doctor.licenseNo && S.diagnoses[0].startsWith('M54.5'), '專用處方箋：病人身分證號、地址、診斷、醫師使用執照號碼')
    await as('nurse01')
    await expectError(() => api.controlledApi.specialRxSheet(A.ee.id), '護理師印專用處方箋')

    // 第四級（Tramadol）：不用使用執照、不用專用處方箋
    const B = await newVisit()
    delete doc(B.docId).controlledLicense
    await api.opdApi.completeEncounter(B.ee.id, draftOf([m31]))
    ok(db().encounters.find((e) => e.id === B.ee.id).status === 'completed', '第四級管制藥（Tramadol）沒有使用執照也能開')
    msg = await errOf(() => api.controlledApi.specialRxSheet(B.ee.id))
    ok(msg.includes('不需要專用處方箋'), `只有第四級的處方不印專用處方箋 → 「${msg}」`)
    doc(B.docId).controlledLicense = { no: 'C99-TEST', validUntil: addDaysT(365) }

    // 藥局：領藥人身分證號
    await as('clerk01')
    const pv = await api.chargeApi.previewCharge(A.vv.id)
    await api.chargeApi.pay(A.vv.id, { payMethod: 'cash', received: pv.patientTotal })
    await as('ph01')
    const dpA = () => db().dispenses.find((x) => x.visitId === A.vv.id)
    const view = await api.pharmacyApi.verifyDispense(dpA().id)
    ok(view.specialRx && view.items.find((i) => i.drugId === 'M041').controlled === 2 && !view.items.find((i) => i.drugId === 'M001').controlled, '調劑單標「要專用處方箋」，品項標出管制級別')
    ok((await api.controlledApi.specialRxSheet(A.ee.id)).pickupNo === dpA().pickupNo, '藥師也能印（看）專用處方箋，批價後印出領藥號')
    const birth = pat().birthDate.slice(5).replace('-', '')
    let e = await (async () => { try { await api.pharmacyApi.dispense(dpA().id, { birthMMDD: birth }) } catch (x) { return x } })()
    ok(e?.fields?.idNo?.includes('身分證號'), `第二級發藥沒填身分證號 → 「${e?.fields?.idNo}」`)
    const wrong = idNo.slice(0, 9) + String((Number(idNo.at(-1)) + 1) % 10)
    e = await (async () => { try { await api.pharmacyApi.dispense(dpA().id, { birthMMDD: birth, idNo: wrong }) } catch (x) { return x } })()
    ok(e?.fields?.idNo?.includes('不符'), `本人的身分證號和病人資料不同 → 「${e?.fields?.idNo}」`)
    e = await (async () => { try { await api.pharmacyApi.dispense(dpA().id, { proxy: true, proxyName: '王小明', relation: '兒子', idNo }) } catch (x) { return x } })()
    ok(e?.fields?.idNo?.includes('本人'), `代領卻填病人自己的身分證號 → 「${e?.fields?.idNo}」`)
    e = await (async () => { try { await api.pharmacyApi.dispense(dpA().id, { proxy: true, proxyName: '王小明', relation: '兒子', idNo: 'X12' }) } catch (x) { return x } })()
    ok(e?.fields?.idNo?.includes('格式'), `代領人身分證號格式錯 → 「${e?.fields?.idNo}」`)
    ok(dpA().status === 'verified', '被擋下的都沒有發藥')
    await api.pharmacyApi.dispense(dpA().id, { proxy: true, proxyName: '王小明', relation: '兒子', idNo: 'b123456780' })
    ok(dpA().status === 'dispensed' && dpA().pickupCheck.idNo === 'B123456780' && dpA().pickupCheck.proxyName === '王小明', '代領：登記代領人姓名、關係、身分證號（轉成大寫）')
    const L = await api.controlledApi.controlledLedger({ drugId: 'M041', locationId: opd, from: addDaysT(-30), to: T })
    const lr = L.rows.find((r) => r.kind === 'out')
    ok(lr?.qty === 14 && lr.patientName === pat().name && lr.receiver === '代領：王小明（兒子）' && lr.receiverIdNo === 'B123456780' && L.closing === drug('M041').stock, '簿冊那一列：病人、開立醫師、領藥人與身分證號；期末＝帳上')
    const csv = CSV.controlledLedgerCsv(L)
    ok(csv.includes(',領藥人,') && csv.includes('代領：王小明（兒子） B123456780'), '簿冊 CSV 多一欄「領藥人」')
    // 第四級的發藥：不用身分證號（簿冊記本人）
    await as('clerk01')
    const pvB = await api.chargeApi.previewCharge(B.vv.id)
    await api.chargeApi.pay(B.vv.id, { payMethod: 'cash', received: pvB.patientTotal })
    await as('ph01')
    const dpB = db().dispenses.find((x) => x.visitId === B.vv.id)
    await api.pharmacyApi.verifyDispense(dpB.id)
    const vB = await api.pharmacyApi.dispense(dpB.id, { birthMMDD: db().patients.find((p) => p.id === B.ptId).birthDate.slice(5).replace('-', '') })
    ok(!vB.specialRx && !db().dispenses.find((x) => x.id === dpB.id).pickupCheck.idNo, '第四級發藥照一般流程（只核對生日，不登記身分證號）')
    const LB = await api.controlledApi.controlledLedger({ drugId: 'M031', locationId: opd, from: T, to: T })
    ok(LB.rows.some((r) => r.receiver === '本人' && !r.receiverIdNo), '第四級的簿冊：領藥人記「本人」')

    // 住院醫囑：第一～三級也檢查開立醫師的使用執照
    const adm = db().admissions.find((x) => x.status === 'admitted')
    const docUser = db().users.find((u) => u.doctorId === adm.doctorId).username
    const keep = structuredClone(doc(adm.doctorId).controlledLicense)
    delete doc(adm.doctorId).controlledLicense
    await as(docUser)
    msg = await errOf(() => api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'medication', drugId: 'M039', content: '', dose: 1, freq: 'STAT', route: 'IM', allowDuplicate: true }))
    ok(msg.includes('使用執照') && msg.includes('第二級'), `住院：沒有使用執照開 Morphine 注射 → 「${msg}」`)
    const o4 = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'medication', drugId: 'M031', content: '', dose: 1, freq: 'STAT', route: 'PO', allowDuplicate: true })
    ok(!!o4.id, '住院：第四級不需要使用執照')
    doc(adm.doctorId).controlledLicense = keep ?? { no: 'C99-TEST', validUntil: addDaysT(365) }
    // 剛開了 Tramadol（同屬鴉片類止痛，同類重複提醒）：確認後才開
    const rxOk2 = Object.fromEntries((await api.ipdApi.orderRxAlerts(adm.id, 'M039')).map((x) => [x.key, '']))
    const o2 = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'medication', drugId: 'M039', content: '', dose: 1, freq: 'STAT', route: 'IM', allowDuplicate: true, rxAlertReasons: rxOk2 })
    ok(!!o2.id, '住院：有使用執照就能開')

    // 系統管理：醫師的使用執照
    await as('admin')
    const d7 = structuredClone(doc('DR07'))
    msg = await errOf(() => api.adminApi.saveDoctor({ ...d7, controlledLicense: { no: 'C11-NEW', validUntil: '' } }))
    ok(!!msg, `使用執照有號碼沒有有效期限 → 「${msg}」`)
    msg = await errOf(() => api.adminApi.saveDoctor({ ...d7, controlledLicense: { no: doc('DR01').controlledLicense.no, validUntil: addDaysT(100) } }))
    ok(msg.includes('重複'), `使用執照號碼和別人重複 → 「${msg}」`)
    await api.adminApi.saveDoctor({ ...d7, controlledLicense: { no: 'C11-NEW', validUntil: addDaysT(100) } })
    ok(doc('DR07').controlledLicense.no === 'C11-NEW' && doc('DR07').controlledLicense.validUntil === addDaysT(100), '管理員更新使用執照')
    const { controlledLicense: _x, ...noLic } = structuredClone(doc('DR07'))
    await api.adminApi.saveDoctor(noLic)
    ok(!doc('DR07').controlledLicense, '清空使用執照（之後不能開第一～三級）')
    await api.adminApi.saveDoctor(d7)

    // 定期申報
    await as('ph01')
    const R = await api.controlledApi.controlledReport({ from: addDaysT(-30), to: T })
    const ctrl = db().drugs.filter((d) => d.controlled).map((d) => d.id)
    ok(R.rows.length > 0 && R.rows.every((r) => ctrl.includes(r.drugId)) && ctrl.every((id) => R.rows.some((r) => r.drugId === id && !r.locationId)), `申報表：只有管制藥，每一種都有全院合計（${R.rows.length} 列）`)
    ok(R.rows.every((r, i) => i === 0 || R.rows[i - 1].controlled <= r.controlled), '依級別排列')
    ok(R.rows.every((r) => Math.abs(r.opening + r.totalIn - r.totalOut - r.closing) < 1e-9), '每一列：期初＋收入－支出＝期末')
    let same = true
    for (const r of R.rows.filter((x) => x.locationId)) {
      const x = await api.controlledApi.controlledLedger({ drugId: r.drugId, locationId: r.locationId, from: R.from, to: R.to })
      if (x.opening !== r.opening || x.totalIn !== r.totalIn || x.totalOut !== r.totalOut || x.closing !== r.closing || x.residualTotal !== r.residualTotal) same = false
    }
    ok(same, '各地點那一列＝同一期間那本簿冊的期初、收入、支出、殘餘量、期末')
    const tot = (id) => R.rows.find((r) => r.drugId === id && !r.locationId)
    ok(ctrl.every((id) => tot(id).closing === db().drugLots.filter((l) => l.drugId === id).reduce((n, l) => n + l.qty, 0)), '全院合計的期末＝全院帳上（所有批號加總）')
    const locSum = (id, k) => R.rows.filter((r) => r.drugId === id && r.locationId).reduce((n, r) => n + r[k], 0)
    ok(ctrl.some((id) => locSum(id, 'totalIn') > tot(id).totalIn) && ctrl.every((id) => tot(id).totalIn <= locSum(id, 'totalIn')), '全院合計不含院內撥補（病房常備補充只是換地點）')
    ok(tot('M041').totalOut === 14, '全院支出含今天發的 Morphine 錠 14 顆')
    const R2 = await api.controlledApi.controlledReport({ from: T, to: T })
    ok(R2.rows.find((r) => r.drugId === 'M041' && !r.locationId).opening === tot('M041').closing + 14, '只看今天：期初是昨天的期末')
    await expectError(() => api.controlledApi.controlledReport({ from: addDaysT(-400), to: T }), '申報期間超過一年')
    await expectError(() => api.controlledApi.controlledReport({ from: T, to: addDaysT(-1) }), '結束日期早於起始日期')
    await as('nurse01')
    await expectError(() => api.controlledApi.controlledReport({ from: T, to: T }), '護理師看申報表')
    await as('ph01')
    const rcsv = CSV.controlledReportCsv(R)
    ok(rcsv.startsWith('﻿') && rcsv.includes('管制藥品收支結存申報表') && rcsv.includes('全院合計') && rcsv.split('\r\n').length > R.rows.length + 4, '申報表 CSV：表頭、每一列、全院合計')
    const bin = XL.controlledReportXlsx(R)
    ok(bin[0] === 0x50 && bin[1] === 0x4b && XL.controlledReportXlsxFileName(R) === `管制藥申報_${R.from}_${R.to}.xlsx` && CSV.controlledReportFileName(R).endsWith('.csv'), '申報表匯出 Excel（zip 檔頭 PK）、檔名')
    const ttab = CSV.controlledReportTable(R)
    ok(ttab.totalRows.length === ctrl.length && ttab.totalRows.every((i) => ttab.rows[i][5] === '全院合計') && typeof ttab.rows[ttab.headRow + 1][6] === 'number', '申報表的全院合計列標粗體、數量是數字')


    // 第四級口服：Zolpidem、Alprazolam。半顆也算殘餘量（整顆扣、剩半顆見證銷毀），和注射劑同一條規則
    ok(drug('M028').controlled === 4 && drug('M029').controlled === 4 && !CR.needsSpecialRx(drug('M028').controlled), '種子：Zolpidem、Alprazolam 是第四級管制藥（不需專用處方箋與使用執照）')
    {
      const DR = await load('/src/services/drug-rules.ts')
      ok(DR.residualOf(drug('M028'), 0.5)?.take === 1 && DR.residualOf(drug('M028'), 0.5)?.residual === 0.5 && !DR.residualOf(drug('M028'), 1), 'Zolpidem 半顆：整顆扣、殘餘半顆；整顆沒有殘餘')
      const a5 = db().admissions.find((x) => x.status === 'admitted' && db().beds.find((b) => b.id === x.bedId))
      const keepZ = structuredClone(doc(a5.doctorId).controlledLicense)
      delete doc(a5.doctorId).controlledLicense
      await as(db().users.find((u) => u.doctorId === a5.doctorId).username)
      const z = await api.ipdApi.addOrder(await withRxOk({ admissionId: a5.id, type: 'long', category: 'medication', drugId: 'M028', content: '', dose: 0.5, freq: 'PRN', route: 'PO', allowDuplicate: true }))
      ok(z.residualQty === 0.5, '第四級不需要使用執照；醫囑標出每次殘餘半顆')
      doc(a5.doctorId).controlledLicense = keepZ
      await as('nurse01')
      msg = await errOf(() => api.nursingApi.givePrn(z.id, '失眠'))
      ok(msg.includes('見證'), `Zolpidem 半顆沒有見證 → 「${msg}」`)
      const zt = await witnessOf({ purpose: 'residual', orderId: z.id }, 'nurse02')
      const zm = await api.nursingApi.givePrn(z.id, '失眠', undefined, zt)
      ok(zm.residual?.qty === 0.5 && !!zm.residual.witnessBy, '有見證：給半顆、殘餘半顆銷毀記在給藥紀錄')
      await as('ph01')
      const zloc = db().stockTxns.filter((x) => x.drugId === 'M028').at(-1).locationId
      const ZL = await api.controlledApi.controlledLedger({ drugId: 'M028', locationId: zloc, from: T, to: T })
      ok(ZL.rows.some((r) => r.kind === 'out' && r.qty === 1 && r.witnessName) && ZL.rows.some((r) => r.kind === 'residual' && r.qty === 0.5) && ZL.closing === db().drugLots.filter((l) => l.drugId === 'M028' && l.locationId === zloc).reduce((n, l) => n + l.qty, 0), 'Zolpidem 簿冊：扣 1 顆、殘餘 0.5 銷毀另列，期末＝帳上')
      const ZR = await api.controlledApi.controlledReport({ from: T, to: T })
      ok(['M028', 'M029'].every((id) => ZR.rows.some((r) => r.drugId === id && !r.locationId)), '申報表含 Zolpidem、Alprazolam')
    }
    // 規則只在服務層：頁面不得自己判斷級別要不要專用處方箋
    const { readFileSync } = await import('node:fs')
    const pages = ['src/pages/opd/OpdPage.vue', 'src/pages/pharmacy/PharmacyPage.vue'].map((p) => readFileSync(p, 'utf8'))
    ok(pages.every((s) => !/controlled\s*<=?\s*3/.test(s)) && pages[0].includes('needsSpecialRx'), '頁面用 needsSpecialRx（不自己寫「級別 ≤ 3」）')
  }

  // 檢驗：醫檢師登打、判讀（參考範圍、危急值、性別）、發報告、更正、醫師確認危急值；門診先批價、住院先採檢
  console.log('\n[檢驗報告]')
  {
    resetDb('small')
    const db = () => dbm.db
    const LR = await load('/src/services/lab-rules.ts')
    const L = api.labApi
    let msg = ''
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const proc = (id) => db().procedures.find((p) => p.id === id)
    const def = (procId, code) => proc(procId).labItems.find((d) => d.code === code)
    const hb = def('P003', 'Hb')
    ok(LR.labRefText(hb, 'M') === '13.5–17.5' && LR.labRefText(hb, 'F') === '12–16' && LR.labRefText(def('P006', 'T-CHO'), 'M') === '≤ 199' && LR.labRefText(def('P010', 'U-PRO'), 'F') === '陰性', '參考範圍文字：血色素依性別、只有上限的寫「≤」、文字型寫正常值')
    const j = (procId, code, v, g = 'M') => LR.judgeLab(def(procId, code), v, g)
    ok(j('P004', 'GLU-AC', '85').flag === '' && j('P004', 'GLU-AC', '130').flag === 'H' && j('P004', 'GLU-AC', '65').flag === 'L' && !j('P004', 'GLU-AC', '130').critical, '數值判讀：範圍內正常、高於 H、低於 L')
    ok(j('P004', 'GLU-AC', '401').critical && j('P004', 'GLU-AC', '39').critical && !j('P004', 'GLU-AC', '400').critical && !j('P004', 'GLU-AC', '40').critical, '危急值：超過危急界線才算（界線本身不算）')
    ok(j('P003', 'Hb', '12.5', 'F').flag === '' && j('P003', 'Hb', '12.5', 'M').flag === 'L', '血色素 12.5：女性正常、男性偏低（依病人性別）')
    ok(j('P010', 'U-PRO', '陰性').flag === '' && j('P010', 'U-PRO', '2+').flag === 'A' && 'error' in j('P010', 'U-PRO', '很多'), '文字型：正常值以外標「異常」，不在選項裡的不收')
    ok(['', ' ', 'abc', '1,2', '-3', '1.2.3'].every((v) => 'error' in j('P004', 'GLU-AC', v)), '數值型：空白、文字、逗號、負數、格式錯都不收')
    const bv = LR.buildLabValues(proc('P003').labItems, { WBC: '5.1', Hb: '' }, 'M')
    ok(Object.keys(bv.errors).sort().join() === 'HCT,Hb,PLT' && bv.values.length === 1, '一次標出所有沒填好的項目（不是一次一個）')
    ok(LR.labNeedsAck({ values: [{ critical: true }] }) && !LR.labNeedsAck({ values: [{ critical: true }], ackAt: 'x' }) && LR.labNeedsAck({ values: [{}], corrections: [{}] }) && !LR.labNeedsAck({ values: [{ flag: 'H' }] }), '要醫師確認：有危急值或更正過、還沒確認；只是偏高不用')

    // 種子
    ok(db().users.find((u) => u.username === 'lab01')?.roles.join() === 'lab', '種子：醫檢師帳號 lab01')
    // 交叉試驗（輸血計費項目）由血庫做、不經檢驗工作清單
    ok(db().procedures.filter((p) => p.category === '檢驗' && !p.blood).every((p) => p.labItems?.length), '每個檢驗醫令都有檢驗項目（交叉試驗除外）')
    const pastLab = db().encounters.filter((e) => e.status === 'completed' && e.date < T && ['charged', 'dispensed'].includes(db().visits.find((v) => v.id === e.visitId)?.status)).flatMap((e) => e.procedures.filter((x) => proc(x.procId)?.labItems && !x.notDone).map((x) => ({ e, x })))
    ok(pastLab.length > 0 && pastLab.every(({ e, x }) => db().labReports.some((r) => r.encounterId === e.id && r.procId === x.procId)), `種子：以前已批價的門診檢驗都有報告（${pastLab.length} 份）`)
    const pastIpd = db().ipdOrders.filter((o) => o.type === 'stat' && o.status === 'done' && proc(o.procId ?? '')?.labItems && o.stopAt.slice(0, 10) < T)
    ok(pastIpd.length > 0 && pastIpd.every((o) => db().labReports.some((r) => r.orderId === o.id)), `種子：今天以前採檢的住院檢驗都有報告（${pastIpd.length} 份）`)
    ok(db().labReports.every((r) => { const g = db().patients.find((p) => p.id === r.patientId).gender; const re = LR.buildLabValues(proc(r.procId).labItems, Object.fromEntries(r.values.map((v) => [v.code, v.value])), g).values; return JSON.stringify(re) === JSON.stringify(r.values) }), '種子報告的判讀和規則一致（重算一樣）')
    const seedAcks = db().labReports.filter((r) => LR.labNeedsAck(r))
    ok(seedAcks.some((r) => r.orderId === 'IO-SEED-LAB1' && r.values.find((v) => v.code === 'Hb').critical) && seedAcks.some((r) => r.encounterId && (r.doctorId === 'DR01' || !db().labReports.some((x) => x.encounterId && x.doctorId === 'DR01' && ['P003', 'P004'].includes(x.procId)))) && seedAcks.length === 2, `種子：兩份危急值待確認（${seedAcks.map((r) => r.id).join(',')}；門診 ${seedAcks.find((r) => r.encounterId)?.doctorId}，優先 dr01；一位住院病人昨天的 CBC 血色素 6.8）`)

    // 門診：完成看診 → 批價後才出現在待檢驗
    await as('clerk01')
    const ss = [...(await api.scheduleApi.listSessions({ date: T })), ...(await api.scheduleApi.listSessions({ date: addDaysT(1) }))]
    const sess = ss.find((x) => !x.full && !x.closed && !x.suspended && x.date === T) ?? ss.find((x) => !x.full && !x.closed && !x.suspended)
    const pt = db().patients.find((x) => !x.deceasedAt && x.gender === 'F' && !x.allergies.length && !db().visits.some((v) => v.date === sess.date && v.patientId === x.id))
    const vv = await api.bookingApi.register({ patientId: pt.id, sessionId: sess.id, identityCode: '01', caseType: '01' })
    const drUser = db().users.find((u) => u.doctorId === sess.doctorId).username
    await as(drUser)
    const ee = await api.opdApi.startConsult(vv.id, { allowParallel: true, allowNotCheckedIn: true })
    await api.opdApi.completeEncounter(ee.id, { subjective: '口渴多尿', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'E11.9', name: '第二型糖尿病', primary: true }], medications: [], procedures: [{ procId: 'P004', qty: 1, selfPay: false }, { procId: 'P003', qty: 1, selfPay: false }, { procId: 'P013', qty: 1, selfPay: false }], refillTimes: 0, admissionRequested: false })
    await as('lab01')
    const keyOf = (procId) => `E:${ee.id}:${procId}`
    ok(!(await L.listLabWork()).some((w) => w.key.startsWith(`E:${ee.id}`)), '還沒批價：不在待檢驗清單（先批價再檢驗）')
    await as('clerk01')
    const pv = await api.chargeApi.previewCharge(vv.id)
    await api.chargeApi.pay(vv.id, { payMethod: 'cash', received: pv.patientTotal })
    await as('lab01')
    let work = await L.listLabWork()
    const mine = work.filter((w) => w.key.startsWith(`E:${ee.id}`))
    ok(mine.map((w) => w.procId).sort().join() === 'P003,P004' && mine[0].source === 'opd' && mine.find((w) => w.procId === 'P003').items.find((i) => i.code === 'Hb').ref === '12–16', '批價後出現：只有檢驗（X 光不列）；女性病人的血色素參考範圍 12–16')
    await as(drUser)
    await expectError(() => L.reportLab({ key: keyOf('P004'), values: { 'GLU-AC': '100' } }), '醫師發檢驗報告')
    await expectError(() => L.listLabWork(), '醫師看待檢驗清單')
    await as('lab01')
    const f1 = await fieldsOf(() => L.reportLab({ key: keyOf('P003'), values: { WBC: '5', Hb: 'abc' } }))
    ok(f1.Hb?.includes('數字') && f1.PLT && !f1.WBC, `沒填好的一次標出：${Object.entries(f1).map(([k, v]) => `${k}「${v}」`).join('、')}`)
    const r1 = await L.reportLab({ key: keyOf('P004'), values: { 'GLU-AC': ' 455 ' } })
    ok(/^L\d{8}\d{4}$/.test(r1.no) && r1.values[0].value === '455' && r1.values[0].flag === 'H' && r1.values[0].critical && r1.needsAck && r1.hasCritical, `發報告 ${r1.no}：血糖 455 偏高且危急，要醫師確認`)
    ok(db().auditLogs[0].action.includes('危急值') && db().auditLogs[0].detail.includes('飯前血糖 455'), '稽核寫明危急值')
    ok(!(await L.listLabWork()).some((w) => w.key === keyOf('P004')), '發了就從待檢驗拿掉')
    msg = await errOf(() => L.reportLab({ key: keyOf('P004'), values: { 'GLU-AC': '100' } }))
    ok(msg.includes('更正'), `同一項再發一次 → 「${msg}」`)

    // 批價「未執行」：已發報告的不能標；沒發的可以，標了就不列、不能發
    await as('clerk01')
    const ch = db().charges.find((c) => c.visitId === vv.id && !c.voided)
    const enc = () => db().encounters.find((e) => e.id === ee.id)
    msg = await errOf(() => api.chargeApi.markProcedureNotDone(ch.id, enc().procedures.findIndex((x) => x.procId === 'P004'), '病人說沒抽'))
    ok(msg.includes('已經發出報告'), `已發報告的標未執行 → 「${msg}」`)
    await api.chargeApi.markProcedureNotDone(ch.id, enc().procedures.findIndex((x) => x.procId === 'P003'), '病人未抽血即離開')
    await as('lab01')
    ok(!(await L.listLabWork()).some((w) => w.key === keyOf('P003')), '櫃台標「未執行」的檢驗不列在待檢驗')
    msg = await errOf(() => L.reportLab({ key: keyOf('P003'), values: { WBC: '5', Hb: '13', HCT: '40', PLT: '200' } }))
    ok(msg.includes('未執行'), `未執行的發報告 → 「${msg}」`)
    await as('clerk01')
    await api.chargeApi.unmarkProcedureNotDone(ch.id, enc().procedures.findIndex((x) => x.procId === 'P003'))
    await as('lab01')
    const r2 = await L.reportLab({ key: keyOf('P003'), values: { WBC: '6.2', Hb: '12.5', HCT: '38', PLT: '180' } })
    ok(r2.values.every((v) => !v.flag && !v.critical) && !r2.needsAck, '撤銷未執行後可以發；女性血色素 12.5 正常、不需確認')

    // 醫師確認危急值
    const otherDr = db().users.find((u) => u.doctorId && u.doctorId !== sess.doctorId).username
    await as(otherDr)
    msg = await errOf(() => L.ackLab(r1.id))
    ok(msg.includes('開立醫師'), `別的醫師按已知悉 → 「${msg}」`)
    ok(!(await L.patientLabs(pt.id)).reports.find((r) => r.id === r1.id).canAck, '別的醫師的畫面上沒有「已知悉」按鈕（canAck）')
    await as('nurse01')
    await expectError(() => L.ackLab(r1.id), '護理師按已知悉')
    const nurseView = await L.patientLabs(pt.id)
    ok(nurseView.reports.length >= 2, '護理師可以看檢驗報告')
    await as('clerk01')
    await expectError(() => L.patientLabs(pt.id), '櫃台看檢驗報告')
    await as(drUser)
    ok((await api.dashboardApi.getDashboard()).labAcks >= 1 && (await L.myLabAcks()).some((r) => r.id === r1.id), '開立醫師：首頁「待確認檢驗」與清單有這份')
    const pl = await L.patientLabs(pt.id)
    ok(pl.reports[0].reportedAt >= pl.reports.at(-1).reportedAt && pl.reports.find((r) => r.id === r1.id).canAck && pl.trends.find((t) => t.code === 'GLU-AC').points.at(-1).value === '455' && pl.trends.every((t) => t.points.length <= 6), '病人的報告新的在前、開立醫師可確認；趨勢最後一筆是 455、最多 6 筆')
    const a1 = await L.ackLab(r1.id)
    ok(!a1.needsAck && a1.ackAt && db().labReports.find((r) => r.id === r1.id).ackBy === db().users.find((u) => u.username === drUser).id, '按「已知悉」：記下誰、何時，不再待確認')
    msg = await errOf(() => L.ackLab(r1.id))
    ok(msg.includes('已經確認'), `再按一次 → 「${msg}」`)

    // 更正
    await as('lab01')
    let ff = await fieldsOf(() => L.correctLab(r1.id, { values: { 'GLU-AC': '145' }, reason: '' }))
    ok(!!ff.reason, `更正沒寫原因 → 「${ff.reason}」`)
    ff = await fieldsOf(() => L.correctLab(r1.id, { values: { 'GLU-AC': '455' }, reason: '重驗' }))
    ok(ff.reason?.includes('沒有改變'), `數值沒變 → 「${ff.reason}」`)
    const c1 = await L.correctLab(r1.id, { values: { 'GLU-AC': '145' }, reason: '登打錯誤（多打一個 5）' })
    ok(c1.values[0].value === '145' && c1.values[0].flag === 'H' && !c1.hasCritical && c1.corrections.length === 1 && c1.corrections[0].before[0].value === '455' && c1.needsAck && !c1.ackAt, '更正：新值重新判讀、舊值留著、醫師要重新確認')
    ok(db().auditLogs[0].detail.includes('455 → 145') && db().auditLogs[0].detail.includes('登打錯誤'), '稽核寫明更正前後與原因')
    ok((await L.listLabReports({ date: T })).some((r) => r.id === r1.id), '今天的「已報告」有這份')
    await as(drUser)
    ok((await L.myLabAcks()).some((r) => r.id === r1.id && r.corrections.length), '更正後回到醫師的待確認')
    await L.ackLab(r1.id)

    // 住院：臨時醫囑 → 護理師採檢（執行）→ 才能發報告
    const adm = db().admissions.find((a) => a.status === 'admitted' && a.id !== db().ipdOrders.find((o) => o.id === 'IO-SEED-LAB1')?.admissionId)
    const attendingUser = db().users.find((u) => u.doctorId === adm.doctorId).username
    await as(attendingUser)
    const io = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P011', content: '' })
    await as('lab01')
    let w = (await L.listLabWork()).find((x) => x.key === `O:${io.id}`)
    const cntBefore = (await api.dashboardApi.getDashboard()).labWork
    ok(w?.awaitingCollection && w.source === 'ipd' && /\d/.test(w.where), `住院檢驗：還沒採檢列在清單（${w?.where}）但標「待採檢」`)
    msg = await errOf(() => L.reportLab({ key: `O:${io.id}`, values: { CRP: '3.2' } }))
    ok(msg.includes('採檢'), `還沒採檢就發報告 → 「${msg}」`)
    await as('nurse01')
    await api.nursingApi.completeStatOrder(io.id)
    await as('lab01')
    w = (await L.listLabWork()).find((x) => x.key === `O:${io.id}`)
    ok(w && !w.awaitingCollection && (await api.dashboardApi.getDashboard()).labWork === cntBefore + 1, '護理師執行（採檢）後可以登打；首頁待檢驗數 +1')
    const r3 = await L.reportLab({ key: `O:${io.id}`, values: { CRP: '3.2' } })
    ok(r3.source === 'ipd' && r3.admissionId === adm.id && r3.values[0].flag === 'H' && !r3.needsAck, '住院報告：CRP 3.2 偏高（沒有危急值，不需確認）')
    await as(attendingUser)
    const io2 = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P004', content: '' })
    await api.ipdApi.stopOrder(io2.id, '重複開立')
    await as('lab01')
    ok(!(await L.listLabWork()).some((x) => x.key === `O:${io2.id}`), '停止的檢驗醫囑不列')
    // 種子的住院危急值：主治確認
    const seedIpd = db().labReports.find((r) => r.id === 'LR-SEED-IPD1')
    const att = db().users.find((u) => u.doctorId === db().admissions.find((a) => a.id === seedIpd.admissionId).doctorId).username
    await as(att)
    ok((await L.myLabAcks()).some((r) => r.id === seedIpd.id), '住院危急值出現在主治醫師的待確認')
    await L.ackLab(seedIpd.id)
    ok(!LR.labNeedsAck(db().labReports.find((r) => r.id === seedIpd.id)), '主治醫師確認住院危急值')

    // 規則只在 lab-rules：頁面不自己比參考範圍
    const { readFileSync } = await import('node:fs')
    const pg = ['src/pages/lab/LabPage.vue', 'src/components/LabReportList.vue', 'src/components/LabAcksCard.vue'].map((p) => readFileSync(p, 'utf8'))
    ok(pg.every((s) => !/critHigh|critLow|\.high\b|\.low\b/.test(s)) && pg[0].includes('judgeLab'), '頁面用 judgeLab 判讀（不自己比參考範圍、危急值）')
  }

  // 影像報告：放射科判讀 X 光、超音波、電腦斷層，心電圖由開立醫師判讀；重要發現要確認；發出後只能補充
  console.log('\n[影像報告]')
  {
    resetDb('small')
    const db = () => dbm.db
    const IM = api.imagingApi
    let msg = ''
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const proc = (id) => db().procedures.find((p) => p.id === id)
    ok(db().procedures.filter((p) => p.category === '影像').every((p) => p.imaging?.normal.findings && p.imaging.normal.impression) && proc('P017').imaging.reader === 'orderer' && proc('P013').imaging.reader === 'radiology', '每個影像醫令都有判讀者與正常範本；心電圖由開立醫師判讀')
    const rad = db().doctors.find((d) => d.id === 'DR10')
    ok(rad && db().departments.find((x) => x.id === rad.deptId)?.code === 'RAD' && db().users.find((u) => u.doctorId === 'DR10')?.username === 'dr10', '種子：放射科醫師 dr10')
    ok(!db().sessions.some((s) => s.doctorId === 'DR10') && !db().weeklySlots.some((s) => s.doctorId === 'DR10'), '放射科醫師不排門診')
    const pastOpd = db().encounters.filter((e) => e.status === 'completed' && e.date < T && ['charged', 'dispensed'].includes(db().visits.find((v) => v.id === e.visitId)?.status)).flatMap((e) => e.procedures.filter((x) => proc(x.procId)?.imaging && !x.notDone).map((x) => ({ e, x })))
    const pastIpd = db().ipdOrders.filter((o) => o.type === 'stat' && o.status === 'done' && proc(o.procId ?? '')?.imaging && o.stopAt.slice(0, 10) < T)
    ok(pastOpd.every(({ e, x }) => db().imagingReports.some((r) => r.encounterId === e.id && r.procId === x.procId)) && pastIpd.length > 0 && pastIpd.every((o) => db().imagingReports.some((r) => r.orderId === o.id)), `種子：以前的門診（${pastOpd.length}）、住院（${pastIpd.length}）影像都已判讀`)
    ok(db().imagingReports.every((r) => (proc(r.procId).imaging.reader === 'orderer' ? r.readerId === r.doctorId : r.readerId === 'DR10')), '種子：心電圖由開立醫師、其他由放射科判讀')
    const sig = db().imagingReports.filter((r) => r.significant && !r.ackAt)
    ok(sig.length === 1 && sig[0].orderId === 'IO-SEED-IMG1' && sig[0].impression.includes('氣胸'), '種子：一份重要發現待確認（住院胸部 X 光：左側氣胸）')

    // 門診：胸部 X 光（放射科）＋心電圖（開立醫師）
    await as('clerk01')
    const ss = [...(await api.scheduleApi.listSessions({ date: T })), ...(await api.scheduleApi.listSessions({ date: addDaysT(1) }))]
    const sess = ss.find((x) => !x.full && !x.closed && !x.suspended && x.date === T) ?? ss.find((x) => !x.full && !x.closed && !x.suspended)
    const pt = db().patients.find((x) => !x.allergies.length && !x.deceasedAt && !db().visits.some((v) => v.date === sess.date && v.patientId === x.id))
    const vv = await api.bookingApi.register({ patientId: pt.id, sessionId: sess.id, identityCode: '01', caseType: '01' })
    const drUser = db().users.find((u) => u.doctorId === sess.doctorId).username
    await as(drUser)
    const ee = await api.opdApi.startConsult(vv.id, { allowParallel: true, allowNotCheckedIn: true })
    await api.opdApi.completeEncounter(ee.id, { subjective: '胸痛', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'J18.9', name: '肺炎', primary: true }], medications: [], procedures: [{ procId: 'P013', qty: 1, selfPay: false }, { procId: 'P017', qty: 1, selfPay: false }], refillTimes: 0, admissionRequested: false })
    const keyOf = (p) => `E:${ee.id}:${p}`
    await as('dr10')
    ok(!(await IM.listImagingWork()).some((w) => w.key.startsWith(`E:${ee.id}`)), '還沒批價：不在待判讀')
    await as('clerk01')
    const pv = await api.chargeApi.previewCharge(vv.id)
    await api.chargeApi.pay(vv.id, { payMethod: 'cash', received: pv.patientTotal })
    await as('dr10')
    let work = await IM.listImagingWork()
    const cxr = work.find((w) => w.key === keyOf('P013'))
    ok(cxr && cxr.clinical.includes('J18.9') && cxr.normal.impression.includes('無明顯異常') && !work.some((w) => w.key === keyOf('P017')), '放射科的待判讀：有胸部 X 光（附診斷、正常範本），沒有心電圖')
    ok((await api.dashboardApi.getDashboard()).imagingWork === work.filter((w) => !w.awaitingExam).length, '放射科首頁「待判讀影像」數量＝清單')
    await as(drUser)
    work = await IM.listImagingWork()
    ok(work.some((w) => w.key === keyOf('P017')) && !work.some((w) => w.key === keyOf('P013')), '開立醫師的待判讀：只有自己開的心電圖')
    msg = await errOf(() => IM.reportImaging({ key: keyOf('P013'), findings: 'x', impression: 'y' }))
    ok(msg.includes('放射科'), `開立醫師判讀 X 光 → 「${msg}」`)
    const other = db().users.find((u) => u.doctorId && u.doctorId !== sess.doctorId && u.doctorId !== 'DR10').username
    await as(other)
    msg = await errOf(() => IM.reportImaging({ key: keyOf('P017'), findings: 'x', impression: 'y' }))
    ok(msg.includes('開立醫師'), `別的醫師判讀心電圖 → 「${msg}」`)
    await as('nurse01')
    await expectError(() => IM.reportImaging({ key: keyOf('P013'), findings: 'x', impression: 'y' }), '護理師發影像報告')
    await as(drUser)
    const ekg = await IM.reportImaging({ key: keyOf('P017'), findings: proc('P017').imaging.normal.findings, impression: '正常心電圖。' })
    ok(ekg.readerId === sess.doctorId && !ekg.needsAck && /^R\d{12}$/.test(ekg.no), `開立醫師判讀心電圖 ${ekg.no}：沒有重要發現，不需確認`)
    await as('dr10')
    const f1 = await fieldsOf(() => IM.reportImaging({ key: keyOf('P013'), findings: ' ', impression: '' }))
    ok(f1.findings && f1.impression, '所見、結論都要寫（一次標出）')
    const r1 = await IM.reportImaging({ key: keyOf('P013'), findings: '右側肺尖無肺紋理區，估計氣胸約 30%。', impression: '右側氣胸。', significant: true })
    ok(r1.readerId === 'DR10' && r1.significant && r1.needsAck && db().auditLogs[0].action.includes('重要發現'), '放射科發報告：重要發現要醫師確認、稽核標明')
    msg = await errOf(() => IM.reportImaging({ key: keyOf('P013'), findings: 'x', impression: 'y' }))
    ok(msg.includes('補充'), `同一項再發一次 → 「${msg}」`)
    await as('clerk01')
    const ch = db().charges.find((c) => c.visitId === vv.id && !c.voided)
    msg = await errOf(() => api.chargeApi.markProcedureNotDone(ch.id, db().encounters.find((e) => e.id === ee.id).procedures.findIndex((x) => x.procId === 'P013'), '病人沒照'))
    ok(msg.includes('已經發出報告'), `已判讀的影像標未執行 → 「${msg}」`)

    // 確認重要發現
    await as(other)
    msg = await errOf(() => IM.ackImaging(r1.id))
    ok(msg.includes('開立醫師'), `別的醫師確認 → 「${msg}」`)
    await as('nurse01')
    const nv = await IM.patientImaging(pt.id)
    ok(nv.reports.filter((r) => r.encounterId === ee.id).length === 2 && nv.reports.every((r) => !r.canAck && !r.canAddendum), '護理師可以看影像報告（不能確認、不能補充）')
    await as('clerk01')
    await expectError(() => IM.patientImaging(pt.id), '櫃台看影像報告')
    await as(drUser)
    ok((await api.dashboardApi.getDashboard()).imagingAcks >= 1 && (await IM.myImagingAcks()).some((r) => r.id === r1.id), '開立醫師首頁有待確認的影像')
    const pv2 = await IM.patientImaging(pt.id)
    ok(pv2.reports.find((r) => r.id === r1.id).canAck && !pv2.reports.find((r) => r.id === r1.id).canAddendum && pv2.reports.find((r) => r.id === ekg.id).canAddendum, '開立醫師：X 光可確認不能補充；自己判讀的心電圖可以補充')
    await IM.ackImaging(r1.id)
    ok(db().imagingReports.find((r) => r.id === r1.id).significant && db().imagingReports.find((r) => r.id === r1.id).ackAt, '確認後記下時間')
    msg = await errOf(() => IM.ackImaging(r1.id))
    ok(msg.includes('已經確認'), `再確認一次 → 「${msg}」`)

    // 補充報告：原文不改、醫師要重新確認
    await as(drUser)
    msg = await errOf(() => IM.addImagingAddendum(r1.id, { text: '改看' }))
    ok(msg.includes('判讀醫師'), `開立醫師補充放射科的報告 → 「${msg}」`)
    await as('dr10')
    let ff = await fieldsOf(() => IM.addImagingAddendum(r1.id, { text: ' ' }))
    ok(!!ff.text, '補充要寫內容')
    const ad = await IM.addImagingAddendum(r1.id, { text: '與追蹤片比較，氣胸範圍縮小至約 10%。' })
    ok(ad.findings.includes('約 30%') && ad.impression === '右側氣胸。' && ad.addenda.length === 1 && ad.needsAck && !ad.ackAt, '補充：原文不變、加一段、醫師要重新確認')
    ok((await IM.listImagingReports({ date: T })).some((r) => r.id === r1.id), '放射科今天的「已報告」有這份')
    await as(drUser)
    ok((await IM.myImagingAcks()).some((r) => r.id === r1.id && r.addenda.length), '補充後回到開立醫師的待確認')

    // 住院：入院胸部 X 光（今天以前的已判讀）；新的臨時醫囑要護理師執行後才能判讀
    const adm = db().admissions.find((a) => a.status === 'admitted')
    const att = db().users.find((u) => u.doctorId === adm.doctorId).username
    await as(att)
    const io = await api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P016', content: '' })
    await as('dr10')
    const w1 = (await IM.listImagingWork()).find((w) => w.key === `O:${io.id}`)
    ok(w1?.awaitingExam && w1.clinical === adm.diagnosis, '住院影像：還沒做列出「待檢查」，臨床資訊是入院診斷')
    msg = await errOf(() => IM.reportImaging({ key: `O:${io.id}`, findings: 'x', impression: 'y' }))
    ok(msg.includes('還沒做檢查'), `還沒做就判讀 → 「${msg}」`)
    await as('nurse01')
    await api.nursingApi.completeStatOrder(io.id)
    await as('dr10')
    const r3 = await IM.reportImaging({ key: `O:${io.id}`, ...proc('P016').imaging.normal })
    ok(r3.admissionId === adm.id && r3.source === 'ipd' && !r3.needsAck, '護理師執行後可判讀；住院報告記在這次住院')
    // 種子的重要發現：主治確認
    const seedSig = db().imagingReports.find((r) => r.id === 'IR-SEED-IPD1')
    const sAtt = db().users.find((u) => u.doctorId === db().admissions.find((a) => a.id === seedSig.admissionId).doctorId).username
    await as(sAtt)
    ok((await IM.patientImaging(seedSig.patientId)).reports.find((r) => r.id === seedSig.id).canAck, '主治醫師的畫面上可確認住院重要發現')
    await IM.ackImaging(seedSig.id)
    ok(!!db().imagingReports.find((r) => r.id === seedSig.id).ackAt, '主治醫師確認氣胸')

    const { readFileSync } = await import('node:fs')
    const pg = readFileSync('src/pages/imaging/ImagingPage.vue', 'utf8')
    ok(!/isRadiologist|reader === 'radiology' \?/.test(pg), '判讀頁不自己判斷誰能判讀（服務層篩好清單）')
  }

  // 密碼過期太久鎖帳號（寬限天數、管理員重設解鎖、最後一位管理員不鎖）；藥車簽收單
  console.log('\n[密碼過期鎖帳號、藥車簽收單]')
  {
    resetDb('small')
    const db = () => dbm.db
    const PR = await load('/src/services/password-rules.ts')
    const A = api.authApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const age = (daysLeft) => ({ expiresOn: '', daysLeft, expired: daysLeft <= 0, warn: false })
    ok(PR.passwordLocked(age(-31), 30) && !PR.passwordLocked(age(-30), 30) && !PR.passwordLocked(age(-500), 0) && !PR.passwordLocked(age(5), 30) && !PR.passwordLocked(null, 30), '鎖定規則：過期天數超過寬限才鎖（剛好 30 天還沒鎖）；寬限 0＝不鎖；沒過期不鎖')
    ok(['-1', '366', '1.5'].every((g) => PR.checkPasswordPolicy({ maxDays: 90, history: 3, graceDays: Number(g) }).graceDays) && !PR.checkPasswordPolicy({ maxDays: 90, history: 3, graceDays: 0 }).graceDays && PR.PASSWORD_GRACE_DEFAULT === 30, '寬限天數：0–365 的整數，預設 30')
    const user = (n) => db().users.find((u) => u.username === n)
    ok(user('clerk03').passwordSetOn === addDaysT(-130), '種子：clerk03 的密碼 130 天前設定（90 天到期，已過期 40 天）')
    let msg = await errOf(() => A.login('clerk03', 'wrong'))
    ok(msg === '帳號或密碼錯誤', '密碼錯的不說帳號鎖了（不能拿來試帳號）')
    msg = await errOf(() => A.login('clerk03', '1234'))
    ok(msg.includes('已過期 40 天') && msg.includes('鎖定') && msg.includes('管理員'), `鎖定的帳號登入 → 「${msg}」`)
    await as('admin')
    const row = (await api.adminApi.listUsers()).find((u) => u.username === 'clerk03')
    ok(row.passwordState?.locked === 40 && !(await api.adminApi.listUsers()).find((u) => u.username === 'nurse02').passwordState?.locked, '帳號列表標出鎖定（過期 40 天）；快到期的 nurse02 沒有')
    const pol = await A.passwordPolicy()
    ok(pol.graceDays === 30, '密碼原則讀得到寬限天數')
    msg = await errOf(() => A.savePasswordPolicy({ maxDays: 90, history: 3, graceDays: 400 }))
    ok(!!msg, `寬限 400 天 → 「${msg}」`)
    let saved = await A.savePasswordPolicy({ maxDays: 90, history: 3, graceDays: 0 })
    ok(saved.graceDays === 0 && saved.lockedUsers === 0 && saved.expiredUsers >= 1, '寬限設 0：沒有鎖定的帳號（clerk03 改算「已過期」）')
    const g0 = await A.login('clerk03', '1234')
    ok(g0.passwordExpired, '寬限 0：clerk03 可以登入，但要先改密碼')
    await as('admin')
    saved = await A.savePasswordPolicy({ maxDays: 90, history: 3 })
    ok(saved.graceDays === 0, '沒送寬限天數＝不改（舊的呼叫方式照用）')
    saved = await A.savePasswordPolicy({ maxDays: 90, history: 3, graceDays: 30 })
    ok(saved.lockedUsers === 1 && db().auditLogs[0].detail.includes('寬限 0→30'), '改回 30 天：回報 1 個帳號鎖定，稽核寫明')
    // 管理員重設密碼＝解鎖
    await api.adminApi.resetPassword(user('clerk03').id, 'Temp1234')
    const r1 = await A.login('clerk03', 'Temp1234')
    ok(!!r1 && user('clerk03').mustChangePassword, '管理員重設密碼後可以登入（要先改密碼）')
    await expectError(() => api.chargeApi.dailyReport(T), '重設後還沒改密碼就要用')
    await A.changeOwnPassword({ current: 'Temp1234', next: 'NewPass88' })
    ok(!!(await api.chargeApi.dailyReport(T)), '改完密碼就正常使用')
    // 已登入的分頁：密碼放到過期太久，下一個動作就被擋
    await as('nurse01')
    user('nurse01').passwordSetOn = addDaysT(-200)
    msg = await errOf(() => api.nursingApi.listWardTasks('5A 內科病房'))
    ok(msg.includes('鎖定'), `已登入的人過期太久，下一個動作 → 「${msg}」`)
    user('nurse01').passwordSetOn = T
    // 最後一位管理員不鎖；有其他可用的管理員就會鎖
    user('admin').passwordSetOn = addDaysT(-200)
    const ad = await A.login('admin', '1234')
    ok(ad.passwordExpired, '唯一的管理員過期太久：不鎖，只要求改密碼（不然沒人能解鎖）')
    user('clerk02').roles = ['clerk', 'admin']
    msg = await errOf(() => A.login('admin', '1234'))
    ok(msg.includes('鎖定'), `另有可用的管理員（clerk02）時，管理員一樣會鎖 → 「${msg}」`)
    user('clerk02').passwordSetOn = addDaysT(-200)
    ok((await A.login('admin', '1234')).passwordExpired, '兩位管理員都過期太久：都不鎖（總要留人能解鎖）')
    user('clerk02').roles = ['clerk']
    user('clerk02').passwordSetOn = T
    user('admin').passwordSetOn = T

    // 藥車簽收單
    const ud = db().udDispenses.find((d) => d.id === 'UD-SEED-1')
    await as('ph01')
    const sh = await api.udApi.udCartSheet(ud.id)
    const boxes = sh.wards.flatMap((w) => w.boxes)
    ok(sh.no === ud.no && sh.wards.length >= 1 && sh.wards.every((w, i) => i === 0 || sh.wards[i - 1].ward <= w.ward) && sh.wards.every((w) => w.boxes.every((b, i) => i === 0 || w.boxes[i - 1].bedNo <= b.bedNo)), `簽收單：依病房分張（${sh.wards.map((w) => w.ward).join('、')}）、依床號排`)
    ok(boxes.length === ud.boxes.filter((b) => b.status === 'verified' && ud.lines.some((l) => l.admissionId === b.admissionId && l.qty > 0)).length && boxes.every((b) => b.lines.every((l) => l.qty > 0 && l.doses > 0)), '只印已核對送出的藥盒；床邊已有（數量 0）的不印')
    ok(boxes.every((b) => b.receivedByName === '孫佩君' && b.receivedAt && b.verifiedByName), '已點收的印出系統記錄的點收人與時間、核對藥師')
    await as('nurse01')
    await expectError(() => api.udApi.udCartSheet(ud.id), '護理師印藥車簽收單')
  }

  // 住院結帳：每日計費 × 天數、藥依扣帳量、已執行的檢驗處置、差額床費、分段部分負擔＋上限；准出院才能結、結清才能出院
  console.log('\n[住院結帳]')
  {
    resetDb('small')
    const db = () => dbm.db
    const B = await load('/src/services/billing.ts')
    const IC = api.ipdChargeApi
    let msg = ''
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    // 規則
    ok(B.ipdDays('2026-11-10 14:00', '2026-11-13 10:00') === 3 && B.ipdDays('2026-11-10 09:00', '2026-11-10 17:00') === 1, '住院天數：入院當天算、出院當天不算；當天入院當天出院算 1 天')
    const S = { rates: [10, 20, 30], cap: 57000 }
    const c10 = B.ipdCopay(10000, 10, S)
    ok(c10.amount === 1000 && c10.tiers.length === 1 && !c10.capped, '10 天、健保 10,000 點：部分負擔 10% ＝ 1,000')
    const c45 = B.ipdCopay(45000, 45, S)
    ok(c45.tiers.length === 2 && c45.tiers[0].amount === 3000 && c45.tiers[1].amount === 3000 && c45.amount === 6000, '45 天：第 1–30 天 10%、第 31–45 天 20%（費用平均到每天）')
    const c70 = B.ipdCopay(70000, 70, S)
    ok(c70.tiers.map((t) => t.rate).join() === '10,20,30' && c70.tiers[2].fromDay === 61 && c70.tiers[2].toDay === 70 && c70.amount === 3000 + 6000 + 3000, '70 天：三段 10%／20%／30%')
    const big = B.ipdCopay(1000000, 10, S)
    ok(big.amount === 57000 && big.capped === 100000 - 57000, '超過每次住院上限：收上限，記下減了多少')
    ok(B.ipdCopay(1000000, 10, { rates: [10, 20, 30], cap: 0 }).amount === 100000, '上限 0＝不設上限')
    const P = (id) => db().procedures.find((p) => p.id === id)
    const ident = (code) => db().identities.find((i) => i.code === code)
    const daily = db().procedures.filter((p) => p.dailyFee)
    ok(daily.map((p) => p.id).sort().join() === 'P002,P029,P030,P050,P051' && daily.filter((p) => p.icu).map((p) => p.id).join() === 'P050,P051', '每日計費：住院診察費、病房費、護理費（加護病床的病房費、護理費另一組）')
    const drug = db().drugs.find((d) => d.id === 'M036')
    const base = { from: '2026-11-01', to: '2026-11-04', beds: [{ bedNo: '501-1', bedClass: '健保床', days: 2, extraFee: 0 }, { bedNo: '601-1', bedClass: '雙人房', days: 1, extraFee: 1500 }], daily, drugs: [{ drug, qty: 2, date: '2026-11-01' }, { drug, qty: 3, date: '2026-11-02' }], procedures: [{ proc: P('P003'), qty: 1, date: '2026-11-01' }], copay: S }
    const r1 = B.calcIpdChargeLines({ ...base, identity: ident('01') })
    const l = (k) => r1.lines.filter((x) => x.kind === k)
    ok(l('ward').length === 3 && l('ward').every((x) => x.qty === 3) && l('drug').length === 1 && l('drug')[0].qty === 5 && l('procedure')[0].name.includes('CBC'), '帳單：每日計費 × 3 天；同一種藥同價合併（2＋3）；已執行的檢驗')
    ok(l('self').length === 1 && l('self')[0].name.includes('雙人房') && l('self')[0].amount === 1500 && r1.meta.days === 3, '差額床費：雙人房住 1 天 × 1,500（自費）；健保床不收')
    const nhi1 = r1.lines.filter((x) => !x.patientPay).reduce((n, x) => n + x.amount, 0)
    const sum1 = B.summarize(r1.lines)
    ok(l('copay-ipd')[0].amount === Math.round(nhi1 * 0.1) && sum1.nhiPoints === Math.round(nhi1 - l('copay-ipd')[0].amount) && sum1.patientTotal === 1500 + l('copay-ipd')[0].amount, '部分負擔 10% 由病人付、從申報點數扣掉；應付＝差額床費＋部分負擔')
    const r4 = B.calcIpdChargeLines({ ...base, identity: ident('04') })
    ok(!r4.lines.some((x) => x.kind === 'copay-ipd') && r4.meta.copay.length === 0, '重大傷病（免部分負擔）：沒有部分負擔')
    const r9 = B.calcIpdChargeLines({ ...base, identity: ident('09') })
    ok(r9.lines.every((x) => x.patientPay) && B.summarize(r9.lines).nhiPoints === 0, '自費身分：全部自費價、不申報健保')

    // 種子
    // 死亡出院的帳單之後由家屬結（不在出院前結帳）：另外測
    const disc = db().admissions.filter((a) => a.status === 'discharged' && a.dischargeType !== '死亡')
    const ipdCharges = db().charges.filter((c) => c.admissionId)
    ok(disc.length > 0 && disc.every((a) => ipdCharges.some((c) => c.admissionId === a.id && !c.voided && c.ipd.days === B.ipdDays(a.admittedAt, a.dischargedAt) && c.paidAt < a.dischargedAt)), `種子：已出院的 ${disc.length} 位都有住院收據（出院前結帳、天數正確）`)
    const nos = db().charges.map((c) => c.receiptNo)
    ok(new Set(nos).size === nos.length, '收據號碼不重複（住院收據依結帳日編）')
    ok(db().procedures.find((p) => p.id === 'P029').dailyFee && !(await api.masterApi.listProcedures({ keyword: '病房費' })).length && (await api.masterApi.listProcedures({ keyword: '病房費', includeInactive: true })).length === 2, '病房費（一般、加護）不在開立選單（主檔管理看得到）')

    // 准出院才能結帳
    const ready = db().admissions.find((a) => a.status === 'admitted' && a.dischargeSummary?.signedAt)
    const notReady = db().admissions.find((a) => a.status === 'admitted' && !a.dischargeSummary?.signedAt)
    ok(!!ready && !!notReady, '種子：一位已准出院、其他住院中')
    db().patients.find((x) => x.id === ready.patientId).defaultIdentity = '01' // 測試部分負擔、現金不足：用一般健保身分
    await as('nurse01')
    await expectError(() => IC.listIpdBilling(), '護理師看住院結帳')
    await as('clerk01')
    const lst = await IC.listIpdBilling()
    ok(lst.filter((x) => !x.death)[0].admissionId === ready.id && lst.filter((x) => !x.death)[0].dischargeReady && lst.some((x) => x.admissionId === notReady.id && !x.dischargeReady), '住院結帳清單：准出院的排最前面（死亡出院待家屬結帳的另外標）')
    ok((await api.dashboardApi.getDashboard()).ipdToBill === db().admissions.filter((x) => (x.status === 'admitted' && x.dischargeSummary?.signedAt) || (x.dischargeType === '死亡' && !db().charges.some((c) => c.admissionId === x.id && !c.voided))).length, '櫃台首頁「住院待結帳」＝准出院還沒結帳＋死亡出院待家屬結帳的人數')
    const nv = await IC.getIpdBill(notReady.id)
    ok(nv.bill && nv.blocked?.includes('簽准出院'), '還沒准出院：可看試算、標出不能結帳')
    msg = await errOf(() => IC.payIpd(notReady.id, { payMethod: 'card', received: 0 }))
    ok(msg.includes('簽准出院'), `沒准出院就結帳 → 「${msg}」`)
    msg = await errOf(() => api.admissionApi.discharge(ready.id, { confirmUnfinished: true }))
    ok(msg.includes('還沒結帳'), `還沒結帳就辦出院 → 「${msg}」`)
    // 出院帶藥要先由住院藥局調劑（扣帳）才能結帳
    msg = await errOf(() => IC.payIpd(ready.id, { payMethod: 'card', received: 0 }))
    ok(msg.includes('出院帶藥還沒調劑') && (await IC.getIpdBill(ready.id)).blocked?.includes('出院帶藥'), `出院帶藥還沒調劑就結帳 → 「${msg}」`)
    await as('ph01')
    await api.dischargeRxApi.dispenseDischargeRx(ready.id)
    await as('clerk01')
    // 帳單內容（獨立核對：藥＝UD 調劑扣帳減退回＋出院帶藥；檢驗處置＝已執行的臨時醫囑）
    const rv = await IC.getIpdBill(ready.id)
    const bill = rv.bill
    const days = B.ipdDays(ready.admittedAt, T)
    ok(bill.meta.days === days && bill.lines.filter((x) => x.kind === 'ward').every((x) => x.qty === days), `准出院的病人：住院 ${days} 天，每日計費 × ${days}`)
    const udQty = db().udDispenses.flatMap((d) => d.lines).filter((x) => x.admissionId === ready.id && x.txnId).reduce((n, x) => n + x.qty - (x.returns ?? []).reduce((s, r) => s + r.qty, 0), 0) + (db().admissions.find((x) => x.id === ready.id).dischargeSummary.meds ?? []).reduce((n, m) => n + m.qty, 0)
    const billDrugQty = bill.lines.filter((x) => x.kind === 'drug').reduce((n, x) => n + x.qty, 0)
    ok(Math.abs(udQty - billDrugQty) < 1e-9, `藥費依扣帳量：UD 調劑扣帳減退回＋出院帶藥 ${udQty}＝帳單 ${billDrugQty}`)
    const doneProcs = db().ipdOrders.filter((o) => o.admissionId === ready.id && o.category === 'procedure' && o.status === 'done' && o.procId)
    ok(doneProcs.every((o) => bill.lines.some((x) => x.name.startsWith(P(o.procId).name))), `已執行的檢驗處置都在帳單上（${doneProcs.length} 項）`)
    ok(bill.patientTotal === B.summarize(bill.lines).patientTotal && bill.lines.some((x) => x.kind === 'copay-ipd'), '應付＝明細加總；有部分負擔')
    // 收款
    msg = await errOf(() => IC.payIpd(ready.id, { payMethod: 'cash', received: 10 }))
    ok(msg.includes('不足'), `現金不足沒勾欠款 → 「${msg}」`)
    const ch = await IC.payIpd(ready.id, { payMethod: 'cash', received: 100, owe: { reason: '家屬下午補繳' } })
    ok(ch.admissionId === ready.id && ch.owed === bill.patientTotal - 100 && ch.ipd.days === days && db().auditLogs[0].action === '住院結帳', `結帳：開收據 ${ch.receiptNo}、記欠款 ${ch.owed} 元、寫稽核`)
    msg = await errOf(() => IC.payIpd(ready.id, { payMethod: 'card', received: 0 }))
    ok(msg.includes('已經結帳'), `重複結帳 → 「${msg}」`)
    const debts = await api.chargeApi.listDebts(ready.patientId)
    ok(debts.some((d) => d.chargeId === ch.id && d.deptName.includes('住院') && d.outstanding === ch.owed), '欠款清單列出住院收據（標住院），批價頁照樣可收回')
    const rep = await api.chargeApi.dailyReport(T)
    const f = rep.byFeeType
    ok(f.ipdCopay === ch.lines.filter((x) => x.kind === 'copay-ipd').reduce((n, x) => n + x.amount, 0) && f.reg + f.basicCopay + f.drugCopay + f.ipdCopay + f.selfPay + f.discount === rep.patientTotal && rep.byDept.some((d) => d.deptName.includes('（住院）')), '日結：住院部分負擔另列；費用類別加總＝應收；依科別標住院')
    await expectError(() => api.chargeApi.getReceipt(ch.id), '用門診收據查住院收據')
    await expectError(() => api.chargeApi.markProcedureNotDone(ch.id, 0, '測試'), '住院收據標未執行')
    ok(!!(await api.dashboardApi.getDashboard()), '首頁（待退費計算）遇到住院收據不出錯')
    // 結帳後又有新費用：出院被擋，作廢重結
    await as(db().users.find((u) => u.doctorId === ready.doctorId).username)
    const extra = await api.ipdApi.addOrder({ admissionId: ready.id, type: 'stat', category: 'procedure', procId: 'P011', content: '' })
    await as('nurse01')
    await api.nursingApi.completeStatOrder(extra.id)
    msg = await errOf(() => api.admissionApi.discharge(ready.id, { confirmUnfinished: true }))
    ok(msg.includes('費用有變動') && msg.includes(String(ch.patientTotal)), `結帳後又做了 CRP → 出院被擋 「${msg}」`)
    await as('clerk01')
    const view2 = await IC.getIpdBill(ready.id)
    ok(!view2.charge.canVoid, '當天、還沒出院：可以作廢重結')
    await api.chargeApi.voidCharge(ch.id, '結帳後又做了檢驗')
    const ch2 = await IC.payIpd(ready.id, { payMethod: 'card', received: 0 })
    ok(ch2.lines.some((x) => x.name.includes('CRP')) && ch2.patientTotal >= ch.patientTotal, '作廢後重新結帳：帳單含新的 CRP')
    await as('nurse01')
    await api.admissionApi.discharge(ready.id, { confirmUnfinished: true })
    ok(db().admissions.find((a) => a.id === ready.id).status === 'discharged', '結清後可以出院')
    await as('clerk01')
    msg = await errOf(() => api.chargeApi.voidCharge(ch2.id, '測試'))
    ok(msg.includes('已出院'), `出院後作廢住院收據 → 「${msg}」`)
    ok((await IC.getIpdBill(ready.id)).charge.canVoid?.includes('出院') && (await IC.listIpdBilling()).some((x) => x.admissionId === ready.id && x.status === 'discharged' && x.receiptNo === ch2.receiptNo), '今天出院的仍在清單（看收據、重印）')

    // 轉床：差額床費依住的天數
    const tb = db().admissions.find((a) => a.status === 'admitted' && !db().isolations.some((i) => i.patientId === a.patientId && !i.ended) && db().beds.find((b) => b.id === a.bedId)?.ward !== '3I 加護病房') // 隔離中的排床另有規則（空氣隔離只排單人房）；加護病房轉出要摘要
    const dbl = db().beds.find((b) => b.status === 'empty' && b.extraFee > 0)
    await api.admissionApi.transferBed(tb.id, dbl.id)
    const a2 = db().admissions.find((a) => a.id === tb.id)
    ok(a2.bedHistory?.length >= 1 && a2.bedHistory.at(-1).bedId === dbl.id, '轉床寫床位紀錄')
    a2.bedHistory = [{ bedId: a2.bedHistory.length > 1 ? a2.bedHistory[0].bedId : db().beds.find((b) => b.extraFee === 0).id, from: a2.admittedAt }, { bedId: dbl.id, from: `${addDaysT(-1)} 10:00` }]
    const tbBill = (await IC.getIpdBill(tb.id)).bill
    const diff = tbBill.lines.find((x) => x.name.includes(dbl.bedNo))
    ok(tbBill.meta.beds.reduce((n, b) => n + b.days, 0) === tbBill.meta.days && diff?.qty === 1 && diff.amount === dbl.extraFee, `轉到 ${dbl.bedClass} 住 1 天：差額床費 ${dbl.extraFee} × 1；各床天數加總＝住院天數`)
    // 住很久：部分負擔分三段
    a2.admittedAt = `${addDaysT(-70)} 10:00`
    a2.bedHistory = [{ bedId: a2.bedHistory[0].bedId, from: a2.admittedAt }]
    const longBill = (await IC.getIpdBill(tb.id)).bill
    ok(longBill.meta.days === 70 && longBill.meta.copay.map((c) => c.rate).join() === '10,20,30', '住院 70 天：部分負擔分 10%／20%／30% 三段')

    // 每日計費項目不能開成醫令；住院部分負擔設定
    await as(db().users.find((u) => u.doctorId === tb.doctorId).username)
    msg = await errOf(() => api.ipdApi.addOrder({ admissionId: tb.id, type: 'stat', category: 'procedure', procId: 'P029', content: '' }))
    ok(msg.includes('每日計費'), `把病房費開成醫令 → 「${msg}」`)
    await as('clerk01')
    await expectError(() => IC.saveIpdCopay({ rates: [10, 20, 30], cap: 50000 }), '櫃台改住院部分負擔')
    await as('admin')
    msg = await errOf(() => IC.saveIpdCopay({ rates: [10, 120, 30], cap: 50000 }))
    ok(!!msg, `比率 120% → 「${msg}」`)
    await IC.saveIpdCopay({ rates: [5, 10, 15], cap: 30000 })
    const bs = await api.adminApi.getBillingSettings()
    await api.adminApi.saveBillingSettings({ basicCopay: bs.basicCopay, basicCopayReferred: bs.basicCopayReferred, drugCopayFreeUpTo: bs.drugCopayFreeUpTo, drugCopayStep: bs.drugCopayStep, drugCopayPerStep: bs.drugCopayPerStep, drugCopayMax: bs.drugCopayMax + 1, from: '' })
    ok(db().billingSettings.ipdCopay?.rates.join() === '5,10,15' && db().billingSettings.ipdCopay.cap === 30000, '存門診部分負擔參數不會洗掉住院部分負擔設定')
    await as('clerk01')
    ok((await IC.getIpdBill(tb.id)).bill.meta.copay[0].rate === 5, '新設定用於之後的結帳試算')
  }

  // 出院帶藥：醫師在出院病摘開（一般 7 天、慢性病 30 天）、住院藥局調劑扣帳、列入住院帳單；調好後要改先退回
  console.log('\n[出院帶藥]')
  {
    resetDb('small')
    const db = () => dbm.db
    const DR = await load('/src/services/dose-rules.ts')
    const RX = api.dischargeRxApi
    let msg = ''
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message + (e.fields ? JSON.stringify(e.fields) : '') : `（非預期的錯誤）${e.message}`
      }
    }
    ok(!DR.dischargeRxDaysProblem(7, false) && DR.dischargeRxDaysProblem(8, false)?.includes('慢性病') && !DR.dischargeRxDaysProblem(30, true) && DR.dischargeRxDaysProblem(31, true) && DR.dischargeRxDaysProblem(0, false), '天數：一般最多 7 天（超過提示勾慢性病）、慢性病最多 30 天、至少 1 天')
    // 種子：已准出院那位有出院帶藥、還沒調劑
    const ready = db().admissions.find((a) => a.status === 'admitted' && a.dischargeSummary?.signedAt)
    ok(ready.dischargeSummary.meds?.length === 2 && !ready.dischargeRx, '種子：已准出院的病人有 2 項出院帶藥、還沒調劑')
    await as('ph01')
    ok((await api.dashboardApi.getDashboard()).dischargeRxToDispense === 1, '藥局首頁「出院帶藥待調劑」1 位')
    let lst = await RX.listDischargeRx()
    ok(lst[0].admissionId === ready.id && lst[0].status === 'pending' && lst[0].items.every((i) => i.indication && i.warning && i.stock >= i.qty), '出院帶藥清單：待調劑、品項帶作用與警語（藥袋用）、庫存夠')
    await as('nurse01')
    await expectError(() => RX.listDischargeRx(), '護理師看出院帶藥清單')

    // 醫師開立：另一位住院病人
    const a = db().admissions.find((x) => x.status === 'admitted' && !x.dischargeSummary?.signedAt && x.id !== ready.id)
    const docU = db().users.find((u) => u.doctorId === a.doctorId).username
    await as(docU)
    const base = { diagnosis: a.diagnosis, course: '治療後改善', condition: '穩定', followUp: '一週後門診', dischargeType: '改善出院' }
    const m = (o) => ({ drugId: 'M004', dose: 1, freq: 'TID', route: 'PO', days: 5, qty: 0, selfPay: false, ...o })
    await api.ipdApi.saveDischargeSummary(a.id, { ...base, meds: [m({ days: 10 })] }, false)
    ok(db().admissions.find((x) => x.id === a.id).dischargeSummary.meds[0].qty === 30, '存草稿：10 天先存著（簽署才擋天數）；總量自動算 1×3×10＝30')
    msg = await errOf(() => api.ipdApi.saveDischargeSummary(a.id, { ...base, meds: [m({ days: 10 })] }, true))
    ok(msg.includes('7 天') && !db().admissions.find((x) => x.id === a.id).dischargeSummary.signedAt, `簽署時一般出院帶藥 10 天 → 「${msg}」`)
    msg = await errOf(() => api.ipdApi.saveDischargeSummary(a.id, { ...base, meds: [m({ dose: 50 })] }, true))
    ok(msg.includes('打錯'), `劑量明顯打錯 → 「${msg}」`)
    const hi = db().drugs.find((d) => d.id === 'M004')
    const highDose = [2, 3, 4].find((x) => DR.doseLevel(hi, x) === 'high')
    if (highDose) {
      msg = await errOf(() => api.ipdApi.saveDischargeSummary(a.id, { ...base, meds: [m({ dose: highDose })] }, true))
      ok(msg.includes('偏高'), `劑量偏高沒確認 → 「${msg}」`)
    } else ok(true, '（M004 沒有偏高的劑量可測）')
    msg = await errOf(() => api.ipdApi.saveDischargeSummary(a.id, { ...base, meds: [m({ drugId: 'M038', dose: 10, freq: 'HS', route: 'SC' })] }, true))
    ok(msg.includes('總量'), `換算不了的藥沒填總量 → 「${msg}」`)
    await api.ipdApi.saveDischargeSummary(a.id, { ...base, chronicRx: true, meds: [m({ days: 28 }), m({ drugId: 'M001', freq: 'QID', days: 3, qty: 0 })] }, true)
    const ds = db().admissions.find((x) => x.id === a.id).dischargeSummary
    ok(ds.signedAt && ds.chronicRx && ds.meds.map((x) => x.qty).join() === '84,12' && ds.meds.every((x) => !('_manual' in x)), '慢性病 28 天可以簽署；總量自動算（84、12）')
    const av = await api.admissionApi.getAdmission(a.id)
    ok(av.dischargeMedTexts?.length === 2 && av.dischargeMedTexts[0].includes('共 84') && av.dischargeRxStatus === 'pending', '病摘顯示出院帶藥（一行一項）與「待調劑」')

    // 住院藥局調劑
    const ipdLoc = db().stockLocations.find((l) => l.dispensesIpd).id
    const qtyAt = (drugId) => db().drugLots.filter((l) => l.drugId === drugId && l.locationId === ipdLoc).reduce((n, l) => n + l.qty, 0)
    const before = qtyAt('M004')
    await as(docU)
    await expectError(() => RX.dispenseDischargeRx(a.id), '醫師調劑出院帶藥')
    await as('ph01')
    const r = await RX.dispenseDischargeRx(a.id)
    const adm = () => db().admissions.find((x) => x.id === a.id)
    ok(r.status === 'dispensed' && r.pharmacistName === '方建志' && qtyAt('M004') === before - 84 && adm().dischargeRx.txnIds.length === 2, '調劑完成：從住院藥局扣帳（M004 −84）、記調劑藥師')
    ok(db().stockTxns.filter((t) => adm().dischargeRx.txnIds.includes(t.id)).every((t) => t.ref === `出院帶藥 ${a.admitNo}` && t.patientId === a.patientId), '扣帳異動單號「出院帶藥 住院號」、記病人')
    msg = await errOf(() => RX.dispenseDischargeRx(a.id))
    ok(msg.includes('已經調劑'), `重複調劑 → 「${msg}」`)
    await as('clerk01')
    const bill1 = (await api.ipdChargeApi.getIpdBill(a.id)).bill
    ok(bill1.lines.some((x) => x.kind === 'drug' && x.name === hi.name && x.qty >= 84) && !(await api.ipdChargeApi.getIpdBill(a.id)).blocked, '調好後：住院帳單有出院帶藥的藥費，可以結帳')
    // 醫師要改：先退回
    await as(docU)
    msg = await errOf(() => api.ipdApi.cancelDischargeOrder(a.id, '病人又發燒'))
    ok(msg.includes('退回'), `藥已調好就取消准出院 → 「${msg}」`)
    await as('ph01')
    msg = await errOf(() => RX.returnDischargeRx(a.id, ' '))
    ok(msg.includes('原因'), '退回要寫原因')
    await RX.returnDischargeRx(a.id, '醫師要改處方')
    ok(qtyAt('M004') === before && !adm().dischargeRx && db().stockTxns.some((t) => t.type === 'return' && t.ref === `出院帶藥退回 ${a.admitNo}`), '退回：藥回到住院藥局（原批號）、可以重新調劑')
    await as('clerk01')
    const bill2 = (await api.ipdChargeApi.getIpdBill(a.id))
    ok(!bill2.bill.lines.some((x) => x.kind === 'drug' && x.qty >= 84) && bill2.blocked?.includes('出院帶藥'), '退回後：帳單不含出院帶藥、又要等調劑才能結帳')
    await as(docU)
    await api.ipdApi.cancelDischargeOrder(a.id, '要改出院帶藥')
    ok(!adm().dischargeSummary.signedAt && adm().dischargeSummary.meds.length === 2, '退回後醫師可以取消准出院（處方留在草稿）')

    // 種子那位走完：調劑 → 結帳 → 出院；出院後不能退回
    await as('ph01')
    await RX.dispenseDischargeRx(ready.id)
    await as('clerk01')
    await api.ipdChargeApi.payIpd(ready.id, { payMethod: 'card', received: 0 })
    await as('nurse01')
    await api.admissionApi.discharge(ready.id, { confirmUnfinished: true })
    await as('ph01')
    lst = await RX.listDischargeRx()
    ok(lst.some((x) => x.admissionId === ready.id && x.discharged && x.status === 'dispensed'), '今天出院的仍在清單（重印藥袋）')
    msg = await errOf(() => RX.returnDischargeRx(ready.id, '測試'))
    ok(msg.includes('已出院'), `出院後退回 → 「${msg}」`)
    const { readFileSync } = await import('node:fs')
    ok(!/DISCHARGE_RX_DAYS\s*[<>]|days\s*>\s*7/.test(readFileSync('src/pages/ipd/IpdPage.vue', 'utf8')), '頁面不自己判斷天數上限（服務層 dischargeRxDaysProblem）')
  }

  // 預約回診：醫師看診時約下次門診（同科、自己的為主）；正式掛號、醫師預約標記；重複要確認；慢性病依處方建議
  console.log('\n[預約回診]')
  {
    resetDb('small')
    const db = () => dbm.db
    const FR = await load('/src/services/followup-rules.ts')
    const BK = api.bookingApi
    let msg = ''
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    ok(FR.refillFollowUpDays(28, 3) === 81 && FR.refillFollowUpDays(28, 0) === undefined && FR.refillFollowUpDays(0, 2) === undefined && FR.FOLLOW_UP_PICKS.map((p) => p.days).join() === '7,14,28', '建議：1／2／4 週；慢性病連續處方 28 天 × 3 次 → 用完前 3 天（81 天後）')
    // 掛一位今天的病人
    // avoidDrug：這位病人以前沒開過這個藥（不然開藥時會跳「重複用藥」要確認；哪位病人有吃什麼藥隨日期抽，不能碰運氣）
    const newVisit = async (caseType = '01', avoidDrug = '') => {
      await as('clerk01')
      const ss = await api.scheduleApi.listSessions({ date: T })
      const sess = ss.find((x) => !x.full && !x.closed && !x.suspended)
      const usedDrug = (pid) => !!avoidDrug && db().encounters.some((e) => db().visits.find((v) => v.id === e.visitId)?.patientId === pid && e.medications.some((m) => m.drugId === avoidDrug))
      const pt = db().patients.find((x) => !x.allergies.length && !x.deceasedAt && !db().visits.some((v) => v.date >= T && v.patientId === x.id) && !usedDrug(x.id))
      const vv = await api.bookingApi.register({ patientId: pt.id, sessionId: sess.id, identityCode: pt.defaultIdentity, caseType })
      return { vv, sess, pt, drUser: db().users.find((u) => u.doctorId === sess.doctorId).username }
    }
    const A = await newVisit()
    await as(A.drUser)
    msg = await errOf(() => BK.followUpOptions(A.vv.id))
    ok(msg.includes('叫號看診後'), `還沒叫號就約回診 → 「${msg}」`)
    await api.opdApi.startConsult(A.vv.id, { allowParallel: true, allowNotCheckedIn: true })
    const other = db().users.find((u) => u.doctorId && u.doctorId !== A.sess.doctorId).username
    await as(other)
    msg = await errOf(() => BK.followUpOptions(A.vv.id))
    ok(msg.includes('自己今天看的'), `別的醫師替這位病人約 → 「${msg}」`)
    await as('nurse01')
    await expectError(() => BK.bookFollowUp(A.vv.id, { sessionId: A.sess.id }), '護理師用醫師預約')
    await as(A.drUser)
    const o = await BK.followUpOptions(A.vv.id)
    ok(o.suggestions.length === 3 && o.suggestions.every((s) => s.session && s.session.mine && !s.session.blocked && s.session.date >= s.date && s.session.date <= dateUtil.addDays(s.date, FR.FOLLOW_UP_SEARCH_DAYS)) && !o.existing.length, '快速選項：1／2／4 週後各找好最近一個可掛的自己的診')
    msg = await errOf(() => BK.followUpSessions(A.vv.id, T))
    ok(msg.includes('明天以後'), `選今天 → 「${msg}」`)
    const d7 = o.suggestions[0].session.date
    const ses = await BK.followUpSessions(A.vv.id, d7)
    ok(ses.length > 0 && ses[0].mine && ses.every((s) => db().sessions.find((x) => x.id === s.id).deptId === A.vv.deptId), '選日期：同科的診次，自己的在前')
    const otherDept = db().sessions.find((s) => s.date > T && s.deptId !== A.vv.deptId)
    msg = await errOf(() => BK.bookFollowUp(A.vv.id, { sessionId: otherDept.id }))
    ok(msg.includes('同一科'), `約別科 → 「${msg}」`)
    const v1 = await BK.bookFollowUp(A.vv.id, { sessionId: o.suggestions[1].session.id })
    const nv = db().visits.find((x) => x.id === v1.id)
    ok(nv.status === 'registered' && nv.date === o.suggestions[1].session.date && nv.patientId === A.pt.id && nv.identityCode === A.vv.identityCode && nv.caseType === A.vv.caseType && nv.followUpOf?.visitId === A.vv.id && nv.followUpOf.doctorId === A.sess.doctorId && v1.seqNo > 0, `預約成功：正式掛號（${v1.date} #${v1.seqNo}）、身分與案件類別沿用、記下哪次看診約的`)
    ok(v1.followUpByName === db().doctors.find((d) => d.id === A.sess.doctorId).name && db().auditLogs[0].action === '預約回診', '掛號顯示「醫師預約」（預約醫師）、寫稽核')
    const o2 = await BK.followUpOptions(A.vv.id)
    ok(o2.existing.length === 1 && o2.existing[0].byFollowUp && o2.existing[0].seqNo === v1.seqNo, '看診頁列出已約的回診')
    let e = await (async () => { try { await BK.bookFollowUp(A.vv.id, { sessionId: o.suggestions[2].session.id }) } catch (x) { return x } })()
    ok(e?.code === 'CONFLICT' && e.field === 'confirmDuplicate' && e.message.includes('已經預約'), `已約過又約 → 「${e?.message}」（要確認）`)
    const v2 = await BK.bookFollowUp(A.vv.id, { sessionId: o.suggestions[2].session.id, confirmDuplicate: true })
    ok(!!v2.id && (await BK.followUpOptions(A.vv.id)).existing.length === 2, '確認後可以再約一次（一週後看報告、一個月後追蹤）')
    msg = await errOf(() => BK.bookFollowUp(A.vv.id, { sessionId: o.suggestions[2].session.id, confirmDuplicate: true }))
    ok(msg.includes('已掛過此診'), `同一個診次約兩次 → 「${msg}」（和掛號同一套檢查）`)
    // 看完診（已批價）也可以約；櫃台掛號清單看得到
    await api.opdApi.completeEncounter(db().encounters.find((x) => x.visitId === A.vv.id).id, { subjective: '頭痛', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'R51', name: '頭痛', primary: true }], medications: [], procedures: [], refillTimes: 0, admissionRequested: false }).catch(() => null)
    ok(!!(await BK.followUpOptions(A.vv.id)), '看完診（同一天）仍可預約回診')
    await as('clerk01')
    const lst = await api.bookingApi.listVisits({ date: v1.date })
    ok(lst.some((x) => x.id === v1.id && x.followUpByName), '櫃台掛號清單：這筆標「醫師預約」')
    // 慢性病連續處方：依處方建議回診日
    const B = await newVisit('04', 'M012')
    await as(B.drUser)
    const eb = await api.opdApi.startConsult(B.vv.id, { allowParallel: true, allowNotCheckedIn: true })
    await api.opdApi.completeEncounter(eb.id, { subjective: '血壓追蹤', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'I10', name: '本態性高血壓', primary: true }], medications: [{ drugId: 'M012', dose: 1, freq: 'QD', route: 'PO', days: 28, qty: 28, selfPay: false }], procedures: [], refillTimes: 3, admissionRequested: false })
    const ob = await BK.followUpOptions(B.vv.id)
    ok(ob.suggestions[0].label.includes('81 天後') && ob.suggestions[0].date === addDaysT(81) && ob.suggestions.length === 4, '慢性病連續處方（28 天 × 3 次）：第一個建議是 81 天後（藥用完前）')
    const vb = await BK.bookFollowUp(B.vv.id, { sessionId: ob.suggestions[0].session.id })
    ok(db().visits.find((x) => x.id === vb.id).caseType === '04', '慢性病回診沿用 04 案件')
  }

  // 跌倒（Morse）、壓傷（Braden）風險評估：分數與等級、該評的時程、高風險預防措施、護理紀錄、作廢、切點設定
  console.log('\n[跌倒、壓傷風險評估]')
  {
    resetDb('small')
    const db = () => dbm.db
    const R = api.riskApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const { addMinutes } = await load('/src/utils/date.ts')
    // 規則
    const fall = (o = {}) => ({ history: 0, secondary: 0, aid: 0, iv: 0, gait: 0, mental: 0, ...o })
    const pres = (o = {}) => ({ sensory: 4, moisture: 4, activity: 4, mobility: 4, nutrition: 4, friction: 3, ...o })
    ok(api.riskScore('fall', fall({ history: 25, iv: 20 })).score === 45 && api.riskScore('pressure', pres()).score === 23 && api.riskScore('pressure', pres({ sensory: 1, moisture: 1, activity: 1, mobility: 1, nutrition: 1, friction: 1 })).score === 6, 'Morse 加總、Braden 6–23 分')
    ok(api.riskScore('fall', { history: 25 }).missing.length === 5 && api.riskScore('fall', fall({ aid: 7 })).missing.length === 1, '沒答的題、不是選項的分數都算沒答')
    ok(api.riskLevel('fall', 45) === 'high' && api.riskLevel('fall', 44) === 'moderate' && api.riskLevel('fall', 25) === 'moderate' && api.riskLevel('fall', 24) === 'low', 'Morse：≥45 高、25–44 中、<25 低')
    ok(api.riskLevel('pressure', 16) === 'high' && api.riskLevel('pressure', 17) === 'moderate' && api.riskLevel('pressure', 18) === 'moderate' && api.riskLevel('pressure', 19) === 'low', 'Braden：≤16 高、17–18 中、≥19 低（越低越危險）')
    ok(api.riskLevel('fall', 45, { ...api.RISK_DEFAULT, fallHigh: 50 }) === 'moderate', '切點可調')
    const ce = api.checkRiskSettings({ fallHigh: 40, fallModerate: 40, pressureHigh: 18, pressureModerate: 16 })
    ok(!!ce.fallModerate && !!ce.pressureModerate && !Object.keys(api.checkRiskSettings(api.RISK_DEFAULT)).length, '切點檢查：Morse 中度要低於高、Braden 中度要高於高')
    const A0 = '2026-11-10 14:00'
    let d = api.riskDue({ admittedAt: A0 }, '2026-11-11 11:00')
    ok(d.reason === 'admission' && d.dueAt === '2026-11-11 14:00' && d.status === 'ok', '沒評過：入院後 24 小時內')
    ok(api.riskDue({ admittedAt: A0 }, '2026-11-11 12:00').status === 'due' && api.riskDue({ admittedAt: A0 }, '2026-11-11 14:01').status === 'overdue', '到期前 2 小時列「該評了」、過了列逾時')
    ok(api.riskDue({ admittedAt: A0, lastAt: '2026-11-10 15:00', lastLevel: 'high' }, '2026-11-10 20:00').dueAt === '2026-11-11 15:00' && api.riskDue({ admittedAt: A0, lastAt: '2026-11-10 15:00', lastLevel: 'low' }, '2026-11-10 20:00').dueAt === '2026-11-17 15:00', '高風險 24 小時重評、其他 7 天')
    d = api.riskDue({ admittedAt: A0, lastAt: '2026-11-10 15:00', lastLevel: 'low', movedAt: '2026-11-12 09:00' }, '2026-11-12 10:00')
    ok(d.reason === 'transfer' && d.dueAt === '2026-11-13 09:00', '評估後轉床或轉科：24 小時內重評（比例行的早）')
    ok(api.riskFactors('pressure', pres({ activity: 1, mobility: 2 })).length === 2 && api.riskFactors('fall', fall({ iv: 20 }))[0].startsWith('靜脈輸液'), '高風險因子：Morse 有分的題、Braden 1–2 分的題')

    // 種子
    const inpt = db().admissions.filter((a) => a.status === 'admitted')
    ok(inpt.every((a) => db().riskAssessments.some((r) => r.admissionId === a.id && r.scale === 'fall')), '種子：住院中的病人都評過跌倒')
    const stroke = inpt.find((a) => a.diagnosis.startsWith('I63'))
    const strokeView = (await api.admissionApi.getAdmission(stroke.id))
    ok(strokeView.riskLevels.fall === 'high' && strokeView.riskLevels.pressure === 'high', '腦梗塞：跌倒、壓傷都高風險（病人資料帶等級，醫師也看得到）')
    await as('nurse01')
    const ov = await R.getRiskOverview(stroke.id)
    ok(ov.scales.fall.due.status === 'due' && ov.scales.fall.due.reason === 'routine' && ov.scales.fall.history.length === 4, '腦梗塞：每天重評，最近一次 23 小時前 → 該評了（例行重評）')
    const missP = inpt.find((a) => !db().riskAssessments.some((r) => r.admissionId === a.id && r.scale === 'pressure'))
    const ovM = await R.getRiskOverview(missP.id)
    ok(ovM.scales.pressure.due.status === 'overdue' && ovM.scales.pressure.due.reason === 'admission', '漏評壓傷（入院超過 24 小時）：逾時')
    const ward = db().beds.find((b) => b.id === missP.bedId).ward
    const wp = (await api.nursingApi.listWardPatients(ward)).find((p) => p.id === missP.id)
    const tasks = await api.nursingApi.listWardTasks(ward)
    ok(wp.riskOverdue === 1 && tasks.some((t) => t.kind === 'risk' && t.admissionId === missP.id && t.urgency === 'overdue' && t.text.includes('Braden')), '護理站：病人清單標評估逾時、本班待辦列出')
    const dash0 = (await api.dashboardApi.getDashboard()).riskOverdue
    ok(dash0 >= 1, `護理師首頁「風險評估逾時」${dash0} 份`)
    // 存檔
    await as('dr02')
    await expectError(() => R.saveRiskAssessment({ admissionId: missP.id, scale: 'pressure', answers: pres() }), '醫師填風險評估')
    await as('nurse01')
    let f = await fieldsOf(() => R.saveRiskAssessment({ admissionId: missP.id, scale: 'pressure', answers: { sensory: 4 } }))
    ok(f.answers?.includes('還有 5 題'), `沒答完 → 「${f.answers}」`)
    const highP = pres({ sensory: 2, moisture: 2, activity: 2, mobility: 2, nutrition: 2, friction: 1 })
    f = await fieldsOf(() => R.saveRiskAssessment({ admissionId: missP.id, scale: 'pressure', answers: highP }))
    ok(f.measures?.includes('至少一項'), `高風險沒勾預防措施 → 「${f.measures}」`)
    f = await fieldsOf(() => R.saveRiskAssessment({ admissionId: missP.id, scale: 'pressure', answers: highP, measures: ['rails'] }))
    ok(!!f.measures, '跌倒的措施不能用在壓傷')
    const notes0 = db().nursingNotes.length
    const r1 = await R.saveRiskAssessment({ admissionId: missP.id, scale: 'pressure', answers: highP, measures: ['turn', 'mattress'], writeNote: true, score: 99 })
    const note = db().nursingNotes.find((n) => n.id === r1.noteId)
    ok(r1.score === 11 && r1.level === 'high' && r1.reason === 'admission' && db().auditLogs[0].action === '風險評估', '存檔：分數由服務層重算（不收畫面的分數）、高風險、入院評估、寫稽核')
    ok(db().nursingNotes.length === notes0 + 1 && note.focus === '皮膚完整性受損的危險' && note.data.includes('Braden 壓傷量表 11 分（高風險）') && note.action.includes('每 2 小時翻身、使用氣墊床'), '一併寫護理紀錄：焦點、分數與因子、措施')
    ok((await R.getRiskOverview(missP.id)).scales.pressure.due.status === 'ok' && (await api.dashboardApi.getDashboard()).riskOverdue === dash0 - 1 && (await api.admissionApi.getAdmission(missP.id)).riskLevels.pressure === 'high', '評完：不再逾時、首頁少 1、病人標壓傷高風險')
    const r2 = await R.saveRiskAssessment({ admissionId: missP.id, scale: 'fall', answers: fall({ history: 25 }), change: true })
    ok(r2.reason === 'change' && r2.level === 'moderate' && !r2.noteId && !r2.measures, '病情變化加評；中度不用勾措施、沒勾就不寫護理紀錄')
    // 作廢
    await as('nurse02')
    const ovN2 = await R.getRiskOverview(missP.id)
    ok(ovN2.scales.pressure.latest.cantVoid?.includes('本人'), '別的護理師不能作廢')
    let msg = await errOf(() => R.voidRiskAssessment(r1.id, '測試'))
    ok(msg.includes('本人'), `別人作廢 → 「${msg}」`)
    await as('nurse01')
    f = await fieldsOf(() => R.voidRiskAssessment(r1.id, ' '))
    ok(!!f.reason, '作廢要原因')
    await R.voidRiskAssessment(r1.id, '評錯病人')
    const ovV = await R.getRiskOverview(missP.id)
    ok(!ovV.scales.pressure.latest && ovV.scales.pressure.history[0].voided?.reason === '評錯病人' && ovV.scales.pressure.due.status === 'overdue' && db().nursingNotes.some((n) => n.id === r1.noteId), '作廢：紀錄留著、最新一次回到沒評（又逾時）、護理紀錄不動')
    const old = db().riskAssessments.find((r) => r.admissionId === stroke.id && r.scale === 'fall' && r.at < T)
    msg = await errOf(() => R.voidRiskAssessment(old.id, '測試'))
    ok(msg.includes('不能作廢'), '前幾天的評估不能作廢（請再評一次）')
    // 轉床後要重評
    await as('clerk01')
    // 依隔離能排的空床（漏評的這位可能在隔離中：空氣隔離只排單人房）
    const blk = await api.admissionApi.bedBlocks(missP.id)
    const okBed = (b) => b.status === 'empty' && !blk[b.id]
    const empty = db().beds.find((b) => okBed(b) && b.ward === db().beds.find((x) => x.id === missP.bedId).ward) ?? db().beds.find(okBed)
    await api.admissionApi.transferBed(missP.id, empty.id)
    await as('nurse01')
    const ovT = await R.getRiskOverview(missP.id)
    ok(ovT.scales.fall.due.reason === 'transfer' && ovT.scales.fall.due.dueAt === addMinutes(db().admissions.find((a) => a.id === missP.id).bedHistory.at(-1).from, 24 * 60), '轉床後：跌倒評估改成轉床後 24 小時內')
    // 切點
    await expectError(() => R.saveRiskSettings({ ...api.RISK_DEFAULT, fallHigh: 50 }), '護理師改切點')
    await as('admin')
    f = await fieldsOf(() => R.saveRiskSettings({ fallHigh: 40, fallModerate: 45, pressureHigh: 16, pressureModerate: 18 }))
    ok(!!f.fallModerate, '切點不合理 → 擋')
    await R.saveRiskSettings({ ...api.RISK_DEFAULT, fallHigh: 50 })
    ok(db().riskSettings.fallHigh === 50 && db().auditLogs[0].detail.includes('Morse 高 ≥45') , '管理員改 Morse 高風險切點 50（寫稽核）')
    await as('nurse01')
    const r3 = await R.saveRiskAssessment({ admissionId: missP.id, scale: 'fall', answers: fall({ history: 25, iv: 20 }) })
    ok(r3.score === 45 && r3.level === 'moderate' && db().riskAssessments.find((r) => r.id === r2.id).level === 'moderate', '新切點：45 分變中度；舊紀錄的等級不變')
  }

  // 病人重要標記：隔離（類別、排床規則、檢討、解除、差額免收）與 DNR／預立醫療決定（文件要件、部分 DNR、取代、撤回）
  console.log('\n[隔離與 DNR]')
  {
    resetDb('small')
    const db = () => dbm.db
    const F = api.flagApi
    const A = api.admissionApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const userOf = (doctorId) => db().users.find((u) => u.doctorId === doctorId).username
    // 規則
    const C = (o) => ({ kind: 'contact', organism: o })
    ok(api.placementProblem({ isolations: [{ kind: 'airborne', organism: '肺結核' }], bedClass: '健保床', roommates: [] })?.includes('負壓隔離室') && !api.placementProblem({ isolations: [{ kind: 'airborne', organism: '肺結核' }], bedClass: '單人房', roommates: [] }), '空氣隔離要排負壓隔離室（沒有負壓床時可排單人房）')
    ok(!api.placementProblem({ isolations: [C('MRSA')], bedClass: '健保床', roommates: [] }) && !api.placementProblem({ isolations: [C('MRSA')], bedClass: '健保床', roommates: [{ bedNo: 'x', name: '甲', isolations: [C(' mrsa ')] }] }), '接觸隔離：同房沒人可以；同類同原因可以同房（大小寫、空白不計）')
    ok(api.placementProblem({ isolations: [C('MRSA')], bedClass: '健保床', roommates: [{ bedNo: '601-2', name: '甲', isolations: [] }] })?.includes('沒有隔離') && api.placementProblem({ isolations: [], bedClass: '健保床', roommates: [{ bedNo: '601-1', name: '乙', isolations: [C('MRSA')] }] })?.includes('沒有隔離的病人不能同房'), '隔離病人不能和沒隔離的同房，反過來也一樣')
    ok(!!api.placementProblem({ isolations: [C('MRSA')], bedClass: '健保床', roommates: [{ bedNo: 'x', name: '甲', isolations: [C('VRE')] }] }) && !!api.placementProblem({ isolations: [C('流感')], bedClass: '健保床', roommates: [{ bedNo: 'x', name: '甲', isolations: [{ kind: 'droplet', organism: '流感' }] }] }), '不同菌種、不同類別都不能同房')
    ok(api.isolationReviewDue({ startedAt: '2026-10-01 10:00' }, '2026-11-01 09:00', '2026-11-01 10:00') === 'carried' && !api.isolationReviewDue({ startedAt: '2026-10-01 10:00', reviewedAt: '2026-11-01 11:00' }, '2026-11-01 09:00', '2026-11-02 10:00'), '這次入院前開的要確認延續；確認過就不再提醒')
    ok(api.isolationReviewDue({ startedAt: '2026-11-01 10:00' }, '2026-11-01 08:00', '2026-11-15 10:00') === 'long' && !api.isolationReviewDue({ startedAt: '2026-11-01 10:00' }, '2026-11-01 08:00', '2026-11-15 09:59'), '滿 14 天要檢討')
    ok(api.dnrText(api.DNR_CPR_ITEMS).label === 'DNR' && api.dnrText(['intubation', 'defib']).label === 'DNR（不插管、不電擊）' && api.dnrText(['intubation']).title.includes('照常施行：胸外按壓'), '完整 DNR 顯示「DNR」；部分 DNR 寫出不做哪些、照常施行哪些')
    let ce = api.checkDnrInput({ doc: 'self', signedAt: addDaysT(1), witnesses: ['王', '王'], withhold: [] }, T)
    ok(ce.signedAt && ce.witnesses && ce.withhold, '本人：未來日期、見證人重複、沒勾項目都擋')
    ce = api.checkDnrInput({ doc: 'family', signedAt: T, withhold: ['feeding'], doctorIds: ['DR02', 'DR02'] }, T)
    ok(ce.signerName && ce.relation && ce.doctorIds && ce.withhold?.includes('只有預立醫療決定書'), '家屬：要簽署人、關係、兩位不同醫師；人工營養只有預立醫療決定可選')
    ce = api.checkDnrInput({ doc: 'ad', signedAt: T, acpDate: addDaysT(1), witnesses: ['甲', '乙'], withhold: ['feeding'] }, T)
    ok(ce.acpDate?.includes('之前') && !ce.withhold && !Object.keys(api.checkDnrInput({ doc: 'ad', signedAt: T, acpDate: addDaysT(-7), witnesses: ['甲', '乙'], withhold: ['feeding', 'intubation'] }, T)).length, '預立醫療決定：諮商要在簽署之前；齊全就通過')

    // 種子
    const inpt = db().admissions.filter((a) => a.status === 'admitted')
    const pneu = inpt.find((a) => a.diagnosis.startsWith('J18'))
    const cell = inpt.find((a) => a.diagnosis.startsWith('L03'))
    const sepsis = inpt.find((a) => a.diagnosis.startsWith('A41'))
    const stroke = inpt.find((a) => a.diagnosis.startsWith('I63'))
    const carrier = db().admissions.find((a) => a.status === 'reserved' && a.diagnosis.startsWith('M17'))
    const bedOf = (a) => db().beds.find((b) => b.id === db().admissions.find((x) => x.id === a.id).bedId)
    const pv = await A.getAdmission(pneu.id)
    ok(bedOf(pneu).bedClass === '單人房' && pv.flags.isolations[0]?.kind === 'airborne', `種子：肺炎（疑似肺結核）空氣隔離、住單人房 ${bedOf(pneu).bedNo}`)
    const cellBed = bedOf(cell)
    const mate = db().beds.find((b) => b.id !== cellBed.id && b.roomNo === cellBed.roomNo && b.ward === cellBed.ward)
    ok((await A.getAdmission(cell.id)).flags.isolations[0]?.organism === 'MRSA' && cellBed.bedClass === '健保床' && mate.status === 'cleaning', `種子：蜂窩性組織炎 MRSA 接觸隔離，同房 ${mate.bedNo} 清潔中`)
    ok((await A.getAdmission(sepsis.id)).flags.dnr?.label === 'DNR（不按壓、不電擊）' && (await A.getAdmission(sepsis.id)).flags.dnr.title.includes('氣管內插管') && (await A.getAdmission(sepsis.id)).flags.dnr.title.includes('急救藥物'), '種子：敗血症家屬簽的部分 DNR（同意插管、呼吸器；急救藥物照常）')
    ok(db().isolations.some((i) => i.patientId === carrier.patientId && i.organism === 'CRE' && !i.admissionId && !i.ended), '種子：待報到的膝關節置換病人是 CRE 帶菌者（門診驗出、沒解除）')
    // 差額床費：隔離期間的單人房免收
    await as('clerk01')
    let bill = (await api.ipdChargeApi.getIpdBill(pneu.id)).bill
    const waived = bill.lines.find((l) => l.name.includes('隔離期間免收'))
    ok(waived && waived.amount === 0 && waived.qty === bill.meta.days && !bill.lines.some((l) => l.name.startsWith('差額床費') && l.amount > 0) && bill.meta.beds[0].waivedDays === bill.meta.days, `肺炎住單人房 ${bill.meta.days} 天都在隔離中：差額床費免收（列 0 元一行）`)

    // 開隔離
    await expectError(() => F.startIsolation({ patientId: stroke.patientId, kind: 'contact', organism: 'MRSA' }), '櫃台開隔離')
    await as('nurse01')
    let f = await fieldsOf(() => F.startIsolation({ patientId: stroke.patientId, kind: 'contact', organism: ' ' }))
    ok(!!f.organism, '沒寫原因或菌種 → 擋')
    let msg = await errOf(() => F.startIsolation({ patientId: cell.patientId, kind: 'contact', organism: 'mrsa' }))
    ok(msg.includes('已經在接觸隔離'), `同類同原因重複開 → 「${msg}」`)
    // 腦梗塞住雙人房，同房另一床：保留或住人時才算同房；先找一位沒隔離的住院病人和他同房
    const strokeBed = bedOf(stroke)
    const r1 = await F.startIsolation({ patientId: stroke.patientId, kind: 'contact', organism: 'VRE', note: '肛門拭子' })
    ok(r1.isolation.startedByName && r1.isolation.admissionId === stroke.id && db().auditLogs[0].action === '開始隔離', '護理師開接觸隔離（VRE）：記在這次住院、寫稽核')
    ok((await A.getAdmission(stroke.id)).flags.isolations.some((i) => i.organism === 'VRE'), '病人資訊列帶隔離標記')
    // 同房有沒隔離的人：找同房的床讓別人住進去（直接改資料模擬已經同房）
    const strokeMate = db().beds.find((b) => b.id !== strokeBed.id && b.roomNo === strokeBed.roomNo && b.ward === strokeBed.ward)
    const other = inpt.find((a) => a !== stroke && !db().isolations.some((i) => i.patientId === a.patientId && !i.ended))
    const otherOld = other.bedId
    Object.assign(db().beds.find((b) => b.id === otherOld), { status: 'empty', admissionId: undefined })
    Object.assign(strokeMate, { status: 'occupied', admissionId: other.id })
    db().admissions.find((a) => a.id === other.id).bedId = strokeMate.id
    const det = await F.getPatientFlags(stroke.patientId)
    ok(det.placementWarning?.includes('沒有隔離'), `住進來之後才開的隔離、同房有沒隔離的人 → 提醒「${det.placementWarning}」`)
    const ward = strokeBed.ward
    let tasks = await api.nursingApi.listWardTasks(ward)
    ok(tasks.some((t) => t.kind === 'isolation' && t.admissionId === stroke.id && t.text.startsWith('請安排轉床')) && tasks.some((t) => t.kind === 'isolation' && t.admissionId === other.id), '本班待辦：兩位都列「請安排轉床」')
    const wf = await F.wardFlags(ward)
    ok(wf.some((r) => r.admissionId === stroke.id && r.placementWarning) && (await api.nursingApi.listWardPatients(ward)).find((p) => p.id === stroke.id).isolationTodo === 1, '病房總覽標出床不合；病人清單隔離待處理 1')
    // 轉床：沒隔離的那位轉回健保床（服務層 takeBed 檢查）
    await as('clerk01')
    const blkO = await A.bedBlocks(other.id)
    const freeFor = (blk) => db().beds.find((b) => b.status === 'empty' && !blk[b.id] && b.bedClass === '健保床')
    await A.transferBed(other.id, freeFor(blkO).id)
    await as('nurse01')
    ok(!(await F.getPatientFlags(stroke.patientId)).placementWarning, '轉走後提醒消失')

    // 排床：MRSA 同房那一床清潔完成後，沒隔離的病人排不進去
    await as('clerk01')
    await A.setBedStatus(mate.id, 'empty')
    const resv = db().admissions.find((a) => a.status === 'reserved' && a.id !== carrier.id)
    const blkR = await A.bedBlocks(resv.id)
    ok(blkR[mate.id]?.includes('MRSA') && !blkR[db().beds.find((b) => b.status === 'empty' && b.bedClass === '單人房').id], `選床畫面：${mate.bedNo} 標不能排（同房 MRSA）、單人房可以`)
    msg = await errOf(() => A.checkIn(resv.id, mate.id))
    ok(msg.includes('不能排') && msg.includes('MRSA'), `沒隔離的病人報到在 MRSA 同房 → 「${msg}」`)
    msg = await errOf(() => A.setBedStatus(mate.id, 'reserved', resv.id))
    ok(msg.includes('不能保留'), `保留給他也擋 → 「${msg}」`)
    // 帶菌者（CRE）：有沒隔離病人的房間、MRSA 同房都不行；整間空的、單人房可以
    const blkC = await A.bedBlocks(carrier.id)
    const occupiedRoom = (b) => db().beds.some((x) => x.id !== b.id && x.ward === b.ward && x.roomNo === b.roomNo && x.status === 'occupied')
    const emptyMulti = db().beds.filter((b) => b.status === 'empty' && b.bedClass !== '單人房' && b.ward !== '急診留觀區' && b.ward !== '3I 加護病房') // 留觀床另有規則（只給留觀病人）；加護病房不收預約住院
    ok(blkC[mate.id]?.includes('MRSA') && emptyMulti.every((b) => !!blkC[b.id] === occupiedRoom(b)), 'CRE 帶菌者：有人住的房間（沒隔離或不同菌種）都不能排，整間空的可以')
    const single = db().beds.find((b) => b.status === 'empty' && b.bedClass === '單人房')
    await A.checkIn(carrier.id, single.id)
    await as('nurse01')
    tasks = await api.nursingApi.listWardTasks(single.ward)
    const carriedTask = tasks.find((t) => t.kind === 'isolation' && t.admissionId === carrier.id)
    ok(carriedTask?.text.includes('前次就醫開的隔離'), `帶菌者住院：待辦「${carriedTask?.text}」`)
    const ci = (await F.getPatientFlags(carrier.patientId)).isolations[0]
    ok(ci.review === 'carried', '隔離標「這次住院請確認是否延續」')
    await F.reviewIsolation(ci.id, '仍為帶菌者，延續接觸隔離')
    const ci2 = (await F.getPatientFlags(carrier.patientId)).isolations[0]
    ok(!ci2.review && ci2.reviewedByName && ci2.note.includes('延續') && !(await api.nursingApi.listWardTasks(single.ward)).some((t) => t.id === `iso-${ci.id}`), '確認延續：待辦消失、記下誰檢討')
    // 單人房差額：帶菌者隔離中，免收
    await as('clerk01')
    bill = (await api.ipdChargeApi.getIpdBill(carrier.id)).bill
    ok(bill.lines.some((l) => l.name.includes('隔離期間免收')) && !bill.lines.some((l) => l.name.startsWith('差額床費') && l.amount > 0), '帶菌者住單人房：差額免收')
    // 集中照護：另一位 MRSA 可以排進 MRSA 同房
    await as('nurse01')
    const third = db().admissions.find((a) => a.status === 'admitted' && !db().isolations.some((i) => i.patientId === a.patientId && !i.ended) && db().beds.find((b) => b.id === a.bedId).bedClass === '健保床')
    const r3 = await F.startIsolation({ patientId: third.patientId, kind: 'contact', organism: 'MRSA' })
    await as('clerk01')
    const blk3 = await A.bedBlocks(third.id)
    ok(!blk3[mate.id], `另一位 MRSA：可以排到 ${mate.bedNo}（同類同原因，集中照護）`)
    await A.transferBed(third.id, mate.id)
    ok(!(await F.wardFlags(mate.ward)).some((r) => r.placementWarning), 'MRSA 同房：沒有床不合的提醒')
    // 空氣隔離不能轉到健保床
    const ward0Free = db().beds.find((b) => b.status === 'empty' && b.bedClass === '健保床')
    msg = await errOf(() => A.transferBed(pneu.id, ward0Free.id))
    ok(msg.includes('負壓隔離室'), `空氣隔離轉到健保床 → 「${msg}」`)
    // 轉科接受時選床也檢查（腦梗塞現在 VRE 隔離；復健科醫師接受轉科、選 MRSA 同房的床）
    await as('dr09')
    const inc = (await A.listIncomingTransfers()).find((x) => x.admission.id === stroke.id)
    // 剛轉出的床（清潔中）旁邊住著沒隔離的病人：當作清潔完成，給新科選
    const isoP = (pid) => db().isolations.some((i) => i.patientId === pid && !i.ended)
    const halfRoom = db().beds.find((b) => b.status === 'cleaning' && db().beds.some((x) => x.id !== b.id && x.ward === b.ward && x.roomNo === b.roomNo && x.status === 'occupied' && !isoP(db().admissions.find((a) => a.id === x.admissionId).patientId)))
    halfRoom.status = 'empty'
    const blkS = await A.bedBlocks(stroke.id)
    const badBed = db().beds.find((b) => b.status === 'empty' && blkS[b.id]?.includes('沒有隔離'))
    msg = await errOf(() => A.acceptDeptTransfer(stroke.id, { shownOrderIds: inc.orders.map((o) => o.id), stopOrderIds: [], bedId: badBed.id, acceptNote: '接手復健' }))
    ok(msg.includes('不能排') && msg.includes('VRE'), `接受轉科選了沒隔離病人的房間 → 「${msg}」`)

    // 解除
    await as('nurse01')
    await expectError(() => F.endIsolation(r3.isolation.id, '培養陰性'), '護理師解除隔離')
    await as(userOf(pneu.doctorId))
    f = await fieldsOf(() => F.endIsolation(pv.flags.isolations.length && db().isolations.find((i) => i.patientId === pneu.patientId).id, ' '))
    ok(!!f.reason, '解除要寫原因')
    const pIso = db().isolations.find((i) => i.patientId === pneu.patientId)
    // 種子只有兩套陰性（第三套還沒採檢）：解除條件還沒到，這裡用例外解除（解除條件另外測）
    await F.endIsolation(pIso.id, '感染科會診排除肺結核', { exception: true })
    const pd = await F.getPatientFlags(pneu.patientId)
    ok(!pd.isolations.length && pd.ended[0]?.ended.reason.includes('排除肺結核') && pd.ended[0].ended.exception && pd.ended[0].endedByName && !(await A.getAdmission(pneu.id)).flags.isolations.length, '醫師解除：紀錄留在「已解除」、病人資訊列不再標')
    msg = await errOf(() => F.endIsolation(pIso.id, '再一次'))
    ok(msg.includes('已經解除'), '已解除的不能再解除')
    // 解除後還住單人房：解除那天起收差額（把解除時間改成昨天來看）
    db().isolations.find((i) => i.id === pIso.id).ended.at = `${addDaysT(-1)} 10:00`
    await as('clerk01')
    bill = (await api.ipdChargeApi.getIpdBill(pneu.id)).bill
    const charged = bill.lines.find((l) => l.name.startsWith('差額床費') && l.amount > 0)
    const free = bill.lines.find((l) => l.name.includes('隔離期間免收'))
    if (bill.meta.days >= 2) ok(charged?.qty === 1 && charged.amount === bedOf(pneu).extraFee && free?.qty === bill.meta.days - 1, `昨天解除隔離、還住單人房：昨天起收差額（1 天 ${charged?.amount} 元），之前 ${free?.qty} 天免收`)
    else ok(charged?.qty === 1 && !free, '昨天解除隔離（住 1 天）：收差額')

    // DNR
    await as('nurse01')
    await expectError(() => F.saveDnr({ patientId: stroke.patientId, doc: 'self', signedAt: T, witnesses: ['甲', '乙'], withhold: ['intubation'] }), '護理師登錄 DNR')
    await as(userOf(stroke.doctorId))
    f = await fieldsOf(() => F.saveDnr({ patientId: stroke.patientId, doc: 'family', signedAt: T, withhold: [] }))
    ok(f.signerName && f.relation && f.doctorIds && f.withhold, '家屬同意書：要件一次標出')
    const d1 = await F.saveDnr({ patientId: stroke.patientId, doc: 'self', signedAt: T, witnesses: ['陳小美', '林大同'], withhold: api.DNR_CPR_ITEMS, nhiCard: true })
    ok(d1.label === 'DNR' && (await A.getAdmission(stroke.id)).flags.dnr?.label === 'DNR' && db().auditLogs[0].action === '登錄 DNR', '本人意願書（完整 DNR）：病人資訊列標「DNR」、寫稽核')
    const d2 = await F.saveDnr({ patientId: stroke.patientId, doc: 'ad', signedAt: T, acpDate: addDaysT(-3), witnesses: ['陳小美', '林大同'], withhold: [...api.DNR_CPR_ITEMS, 'feeding'] })
    const sd = await F.getPatientFlags(stroke.patientId)
    ok(sd.dnr.id === d2.id && sd.dnr.label.includes('不管灌') && sd.dnrHistory[0].id === d1.id && sd.dnrHistory[0].revoked.reason === '新文件取代' && db().auditLogs[0].action === '更新 DNR', '登錄預立醫療決定：取代舊的（舊的記「新文件取代」，留著）')
    f = await fieldsOf(() => F.revokeDnr(d2.id, ''))
    ok(!!f.reason, '撤回要寫原因')
    await F.revokeDnr(d2.id, '病人本人撤回意願')
    ok(!(await A.getAdmission(stroke.id)).flags.dnr && (await F.getPatientFlags(stroke.patientId)).dnrHistory.length === 2, '撤回：病人資訊列不再標 DNR，兩份紀錄都留著')
    msg = await errOf(() => F.revokeDnr(d2.id, '再一次'))
    ok(msg.includes('已經撤回'), '撤回過的不能再撤回')
    // 出院不會解除隔離（帶菌者下次住院要確認）
    ok(db().isolations.filter((i) => i.patientId === carrier.patientId && !i.ended).length === 1, '隔離掛在病人身上（不是這次住院）')
  }

  // 管制性抗生素審核：開立要理由（先用後審）、感染科核准／不核准、48 小時逾時、使用第 N 天、修改沿用、續用申請、申覆、首頁待辦
  console.log('\n[管制性抗生素審核]')
  {
    resetDb('small')
    const db = () => dbm.db
    const X = api.abxApi
    const I = api.ipdApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const { addMinutes } = await load('/src/utils/date.ts')
    const userOf = (doctorId) => db().users.find((u) => u.doctorId === doctorId).username
    // 規則
    const ce = api.checkAbxInput({ reason: 'culture', site: ' ' })
    ok(ce.abxSite && ce.abxOrganism && api.checkAbxInput(undefined).abxReason && !Object.keys(api.checkAbxInput({ reason: 'empiric', site: '肺部' })).length, '理由、感染部位必填；依培養結果要寫菌種')
    ok(api.abxDay('2026-11-10 23:50', '2026-11-10 23:59') === 1 && api.abxDay('2026-11-10 23:50', '2026-11-11 00:10') === 2, '療程第幾天：開始那天是第 1 天、過午夜就是第 2 天')
    const P0 = { courseStart: '2026-11-10 10:00', status: 'pending', requestedAt: '2026-11-10 10:00' }
    ok(!api.abxState(P0, '2026-11-12 10:00').overdue && api.abxState(P0, '2026-11-12 10:01').overdue, '送審後 48 小時內要審，超過算逾時')
    const A0 = { ...P0, status: 'approved', approvedDays: 7 }
    ok(!api.abxState(A0, '2026-11-14 23:59').extend && api.abxState(A0, '2026-11-15 00:01').extend === 'soon' && api.abxState(A0, '2026-11-16 08:00').extend === 'soon' && api.abxState(A0, '2026-11-17 08:00').extend === 'over', '核准 7 天：第 6、7 天提醒續用，第 8 天起算超過')
    ok(api.abxText(A0, '2026-11-12 08:00') === '使用第 3 天（核准至第 7 天）' && api.abxText(P0, '2026-11-13 08:00') === '使用第 4 天・待感染科審核（逾時）', `顯示：「${api.abxText(A0, '2026-11-12 08:00')}」「${api.abxText(P0, '2026-11-13 08:00')}」`)

    // 種子
    ok(['M042', 'M043', 'M044'].every((id) => db().drugs.find((d) => d.id === id)?.restrictedAbx) && !db().drugs.find((d) => d.id === 'M036').restrictedAbx, '主檔：Vancomycin、Meropenem、Piperacillin/Tazobactam 是管制性抗生素；Ceftriaxone 不是')
    ok(db().departments.some((d) => d.code === 'INF') && db().users.some((u) => u.username === 'dr11' && u.doctorId === 'DR11'), '感染科 dr11')
    const seeded = db().ipdOrders.filter((o) => o.abx)
    ok(seeded.length >= 1 && seeded.every((o) => db().mar.some((m) => m.orderId === o.id && m.scheduledAt.startsWith(T) && m.udLineId)), `種子：${seeded.length} 筆管制性抗生素，今天的劑量都在昨天的每日調劑裡`)
    ok(seeded.every((o) => { const l = db().udDispenses[0].lines.find((x) => x.orderId === o.id); return l && db().stockTxns.some((x) => x.id === l.txnId && x.qty === -l.qty) }), '種子：管制性抗生素的調劑有扣住院藥局的帳')
    await as('dr11')
    let list = await X.listAbxReviews()
    const dash0 = await api.dashboardApi.getDashboard()
    ok(list.canReview && dash0.abxPending === list.pending.length && dash0.abxOverdue === list.pending.filter((x) => x.abx.overdue).length, `感染科首頁：待審核 ${dash0.abxPending}（逾時 ${dash0.abxOverdue}），和審核頁一樣`)
    const sMero = seeded.find((o) => o.drugId === 'M043')
    if (sMero) ok(list.pending[0].order.id === sMero.id && list.pending[0].abx.overdue && list.pending[0].antibiotics.some((s) => s.startsWith('Ceftriaxone')), '種子：敗血症 Meropenem 50 小時前開立沒審（逾時，排最前）；審核頁列出病人其他的抗生素')
    const sPip = seeded.find((o) => o.drugId === 'M044')
    if (sPip) ok(sPip.abx.status === 'rejected' && list.decided.some((x) => x.order.id === sPip.id && x.decision.action === 'reject'), '種子：肺炎 Piperacillin/Tazobactam 不核准（最近審核列得到）')

    // 開立
    const stroke = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    await as(userOf(stroke.doctorId))
    const base = { admissionId: stroke.id, type: 'long', category: 'medication', drugId: 'M043', content: '', dose: 1, freq: 'Q8H', route: 'IV' }
    let f = await fieldsOf(async () => I.addOrder(await withRxOk(base)))
    ok(f.abxReason && f.abxSite, '管制性抗生素沒填理由、部位 → 擋')
    f = await fieldsOf(async () => I.addOrder(await withRxOk({ ...base, abx: { reason: 'culture', site: '泌尿道' } })))
    ok(f.abxOrganism && !f.abxReason, '依培養結果沒寫菌種 → 擋')
    const o1 = await I.addOrder(await withRxOk({ ...base, abx: { reason: 'culture', site: '泌尿道', organism: 'ESBL 大腸桿菌', note: '尿液培養' } }))
    ok(o1.abx.status === 'pending' && o1.abxInfo.text === '使用第 1 天・待感染科審核' && o1.abxInfo.reasonText === '依培養結果（ESBL 大腸桿菌）・泌尿道' && db().mar.some((m) => m.orderId === o1.id), `開立：先用後審（有給藥排程）、${o1.abxInfo.text}`)
    const plain = await I.addOrder(await withRxOk({ ...base, drugId: 'M036', freq: 'Q12H' }))
    ok(!plain.abx && !plain.abxInfo, '一般抗生素（Ceftriaxone）不用審')
    await as('nurse01')
    const mar1 = await I.listMar(stroke.id, db().mar.find((m) => m.orderId === o1.id).scheduledAt.slice(0, 10))
    ok(mar1.some((m) => m.orderId === o1.id && m.abxText?.startsWith('使用第 1 天') && !m.abxRejected), '護理站給藥列標「使用第 1 天」')
    // 審核
    await as(userOf(stroke.doctorId))
    let msg = await errOf(() => X.reviewAbx(o1.id, { approve: true }))
    ok(msg.includes('感染科'), `非感染科醫師審核 → 「${msg}」`)
    list = await X.listAbxReviews()
    ok(!list.canReview && list.pending.some((x) => x.order.id === o1.id), '非感染科看得到待審核（不能審）')
    await as('dr11')
    f = await fieldsOf(() => X.reviewAbx(o1.id, { approve: false, note: ' ' }))
    ok(!!f.note, '不核准要寫建議')
    f = await fieldsOf(() => X.reviewAbx(o1.id, { approve: true, days: 0 }))
    ok(!!f.days, '核准天數 0 → 擋')
    const r1 = await X.reviewAbx(o1.id, { approve: true, days: 5, note: '同意，培養敏感' })
    ok(r1.abx.status === 'approved' && r1.abx.approvedDays === 5 && r1.abxInfo.text === '使用第 1 天（核准至第 5 天）' && db().auditLogs[0].action === '核准管制性抗生素', '核准 5 天、寫稽核')
    msg = await errOf(() => X.reviewAbx(o1.id, { approve: false, note: 'x' }))
    ok(msg.includes('已經審核過'), '審過的不能再審（申覆、續用才會再送審）')
    // 修改醫囑沿用
    await as(userOf(stroke.doctorId))
    const o2 = await I.reviseOrder(o1.id, { dose: 2, freq: 'Q8H', route: 'IV', reason: '依腎功能調整' })
    ok(o2.abx.status === 'approved' && o2.abx.approvedDays === 5 && o2.abx.courseStart === r1.abx.courseStart && o2.abx.steps.length === 2, '修改劑量：沿用療程與核准（不必重審、天數接著算）')
    // 續用申請
    msg = await errOf(() => X.requestAbxExtension(o2.id, '需完成療程'))
    ok(msg.includes('最後一天前後'), `第 1 天就申請續用 → 「${msg}」`)
    const oo = () => db().ipdOrders.find((o) => o.id === o2.id)
    oo().abx.courseStart = `${addDaysT(-4)} 09:00`
    const v2 = (await I.listOrders(stroke.id)).find((o) => o.id === o2.id)
    ok(v2.abxInfo.day === 5 && v2.abxInfo.extend === 'soon' && (await api.dashboardApi.getDashboard()).abxExtend >= 1, '第 5 天（核准至第 5 天）：醫囑列提醒續用、主治首頁「核准天數將到」')
    f = await fieldsOf(() => X.requestAbxExtension(o2.id, ''))
    ok(!!f.note, '續用要寫理由')
    const e2 = await X.requestAbxExtension(o2.id, '腎盂腎炎需 10–14 天')
    ok(e2.abx.status === 'pending' && e2.abx.approvedDays === 5 && e2.abxInfo.text.includes('續用申請'), '申請續用：回到待審核，原核准天數保留')
    await as('dr11')
    msg = (await fieldsOf(() => X.reviewAbx(o2.id, { approve: true, days: 4 }))).days
    ok(msg?.includes('不能比今天少'), `核准天數比今天少 → 「${msg}」`)
    await X.reviewAbx(o2.id, { approve: true, days: 14 })
    ok(oo().abx.approvedDays === 14 && !(await I.listOrders(stroke.id)).find((o) => o.id === o2.id).abxInfo.extend, '續用核准到第 14 天：不再提醒')
    // 不核准、申覆
    await as(userOf(stroke.doctorId))
    const o3 = await I.addOrder(await withRxOk({ ...base, drugId: 'M044', abx: { reason: 'empiric', site: '肺部' }, allowDuplicate: true }))
    await as('dr11')
    await X.reviewAbx(o3.id, { approve: false, note: '建議改用 Ceftriaxone' })
    await as(userOf(stroke.doctorId))
    const dash = await api.dashboardApi.getDashboard()
    const v3 = (await I.listOrders(stroke.id)).find((o) => o.id === o3.id)
    ok(dash.abxRejected >= 1 && v3.abxInfo.text.endsWith('審核未通過') && v3.abxInfo.steps.at(-1).text === '建議改用 Ceftriaxone', '不核准：主治首頁「抗生素審核未通過」、醫囑列標示與建議')
    await as('nurse01')
    const mar3 = await I.listMar(stroke.id, db().mar.find((m) => m.orderId === o3.id).scheduledAt.slice(0, 10))
    ok(mar3.some((m) => m.orderId === o3.id && m.abxRejected), '護理站給藥列標「審核未通過」（不擋給藥）')
    const other = db().users.find((u) => u.doctorId && db().doctors.find((d) => d.id === u.doctorId).deptId !== stroke.deptId && u.doctorId !== 'DR11').username
    await as(other)
    msg = await errOf(() => X.appealAbx(o3.id, '我覺得要用'))
    ok(!!msg, `別科醫師申覆 → 「${msg}」`)
    await as(userOf(stroke.doctorId))
    f = await fieldsOf(() => X.appealAbx(o3.id, ' '))
    ok(!!f.note, '申覆要寫說明')
    const ap = await X.appealAbx(o3.id, '病人對 Ceftriaxone 過敏')
    ok(ap.abx.status === 'pending' && ap.abx.steps.at(-1).action === 'appeal' && db().auditLogs[0].action === '申覆管制性抗生素', '申覆：回到待審核、寫稽核')
    // 48 小時逾時
    db().ipdOrders.find((o) => o.id === o3.id).abx.requestedAt = addMinutes(nowStr(), -49 * 60)
    await as('dr11')
    list = await X.listAbxReviews()
    ok(list.pending[0].order.id === o3.id || list.pending[0].abx.overdue, '超過 48 小時：逾時、排在前面')
    ok((await api.dashboardApi.getDashboard()).abxOverdue >= 1, '感染科首頁算逾時')
    // 停藥：不用再審
    await as(userOf(stroke.doctorId))
    await I.stopOrder(o3.id)
    await as('dr11')
    ok(!(await X.listAbxReviews()).pending.some((x) => x.order.id === o3.id), '停藥後不在待審核')
    msg = await errOf(() => X.reviewAbx(o3.id, { approve: true }))
    ok(msg.includes('已停止'), '停了的不能審')
    // 感染科醫師自己開的：直接核准
    const frac = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('S52'))
    Object.assign(db().admissions.find((a) => a.id === frac.id), { deptId: 'D10', doctorId: 'DR11' })
    const o4 = await I.addOrder(await withRxOk({ ...base, admissionId: frac.id, drugId: 'M042', freq: 'Q12H', abx: { reason: 'prophylaxis', site: '手術部位' } }))
    ok(o4.abx.status === 'approved' && o4.abx.approvedDays === 7 && o4.abx.steps.at(-1).text.includes('免審'), '感染科醫師自己開的：直接核准 7 天')
  }

  // 輸血備血：相容規則、輸血門檻、驗血型（和上次不同擋下）、交叉試驗配血、發血與 30 分鐘退回、床邊掃描與雙人核對、
  // 15 分鐘生命徵象、結束、輸血反應與醫師確認、取消、出院把關、住院帳單、入庫報廢、首頁待辦
  console.log('\n[輸血備血]')
  {
    resetDb('small')
    const db = () => dbm.db
    const B = api.bloodApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const { addMinutes } = dateUtil
    const userOf = (doctorId) => db().users.find((u) => u.doctorId === doctorId).username
    const V = { temp: 36.8, pulse: 88, sbp: 120, dbp: 70 }

    // 規則
    const C = (prod, p, u) => api.bloodCompatible(prod, { abo: p[0], rh: p[1] }, { abo: u[0], rh: u[1] }).ok
    ok(C('rbc', ['A', '+'], ['O', '+']) && !C('rbc', ['O', '+'], ['A', '+']) && C('rbc', ['AB', '+'], ['B', '+']) && !C('rbc', ['B', '+'], ['AB', '+']), '紅血球：O 給所有人、AB 只給 AB')
    ok(!C('rbc', ['O', '-'], ['O', '+']) && C('rbc', ['O', '+'], ['O', '-']), '紅血球：Rh 陰性的病人只能輸 Rh 陰性')
    ok(C('ffp', ['O', '+'], ['AB', '+']) && !C('ffp', ['A', '+'], ['O', '+']) && C('ffp', ['O', '+'], ['A', '+']) && C('plt', ['O', '-'], ['O', '+']), '血漿、血小板反過來：AB 給所有人、O 只給 O；Rh 不限')
    const t0 = '2026-11-17 10:00'
    ok(api.thresholdProblem('rbc', { value: '6.8', at: '2026-11-17 07:00' }, t0) === '' && api.thresholdProblem('rbc', { value: '9.1', at: '2026-11-17 07:00' }, t0).includes('高於輸血門檻 8'), '紅血球：Hb ≤ 8 不用寫理由、> 8 要寫')
    ok(api.thresholdProblem('rbc', undefined, t0).includes('72 小時') && api.thresholdProblem('plt', { value: '20', at: '2026-11-13 09:00' }, t0).includes('72 小時') && api.thresholdProblem('ffp', undefined, t0) === '', '沒有 72 小時內的檢驗也要寫理由；血漿沒有檢驗門檻')

    // 種子
    ok(db().bloodUnits.length >= 40 && db().bloodUnits.some((u) => u.product === 'rbc' && u.expiresOn < T && u.status === 'available'), `種子：${db().bloodUnits.length} 袋血，有一袋過期待報廢`)
    ok(db().procedures.filter((p) => p.blood).map((p) => p.blood).sort().join() === 'crossmatch,ffp,plt,rbc', '主檔：交叉試驗與三種血品的計費項目')
    const s1 = db().bloodRequests.find((r) => r.id === 'BR-SEED-1')
    if (s1) {
      const v = await (await as(userOf(s1.doctorId)), B.patientBlood(s1.admissionId))
      const r = v.requests.find((x) => x.id === s1.id)
      ok(r.status === 'ready' && r.rows.length === 2 && r.rows.filter((x) => x.state === 'done').length === 1 && r.rows.some((x) => x.state === 'reserved'), '種子一：紅血球 2 單位，一袋昨天輸完、一袋配好待發血')
      const done = r.rows.find((x) => x.state === 'done')
      ok(done.issue.transfusion.vitals.map((x) => x.kind).join() === 'pre,15min,end' && done.issue.witnessName && v.typingText, '種子一：雙人核對、三次生命徵象、本院血型都有')
    }
    const s2 = db().bloodRequests.find((r) => r.id === 'BR-SEED-2')
    if (s2) ok(s2.product === 'ffp' && !s2.typing && s2.orderedAt <= nowStr(), '種子二：新鮮冷凍血漿待驗血型')

    // 不能當一般醫令開
    ok(!(await api.masterApi.listProcedures({})).some((p) => p.blood), '開立選單沒有輸血計費項目')

    // 情境：找一位住院病人、主治開備血單
    const adm = db().admissions.find((a) => a.status === 'admitted' && !a.deptTransfers?.some((x) => x.status === 'pending') && !db().bloodRequests.some((r) => r.admissionId === a.id))
    const pt = () => db().patients.find((p) => p.id === adm.patientId)
    db().patients.find((p) => p.id === adm.patientId).bloodType = 'A'
    db().labReports = db().labReports.filter((r) => r.patientId !== adm.patientId)
    const attending = userOf(adm.doctorId)
    await as(attending)
    await expectError(() => api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P032', content: '' }), '血品不能當醫令開')
    await as('nurse01')
    await expectError(() => B.orderBlood({ admissionId: adm.id, product: 'rbc', units: 2, indication: '貧血' }), '護理師不能開備血單')
    const other = db().doctors.find((d) => d.deptId !== adm.deptId && db().users.some((u) => u.doctorId === d.id))
    await as(userOf(other.id))
    let msg = await errOf(() => B.orderBlood({ admissionId: adm.id, product: 'rbc', units: 2, indication: '貧血' }))
    ok(msg.includes('醫師'), `別科醫師不能開：「${msg}」`)
    await as(attending)
    let f = await fieldsOf(() => B.orderBlood({ admissionId: adm.id, product: 'rbc', units: 5, indication: ' ' }))
    ok(f.units && f.indication && f.overReason?.includes('72 小時'), `欄位一次標出：單位數「${f.units}」、適應症、沒有近期 Hb「${f.overReason}」`)
    // 補一份 Hb 7.2 的檢驗
    const tmpl = db().labReports.find((r) => r.values.some((v) => v.code === 'Hb'))
    db().labReports.push({ ...structuredClone(tmpl), id: 'LR-T-BLD', patientId: adm.patientId, reportedAt: addMinutes(nowStr(), -60), values: tmpl.values.map((v) => (v.code === 'Hb' ? { ...v, value: '7.2' } : v)) })
    const r1 = await B.orderBlood({ admissionId: adm.id, product: 'rbc', units: 2, indication: '貧血，Hb < 8 g/dL' })
    ok(r1.status === 'typing' && r1.labText.startsWith('Hb 7.2') && !r1.overReason && /^BR\d{8}\d{3}$/.test(r1.no), `開立：${r1.no} 待驗血型，記下開立時 ${r1.labText}`)
    db().labReports.find((r) => r.id === 'LR-T-BLD').values.find((v) => v.code === 'Hb').value = '9.4'
    f = await fieldsOf(() => B.orderBlood({ admissionId: adm.id, product: 'rbc', units: 1, indication: '貧血' }))
    ok(f.overReason?.includes('9.4'), `Hb 9.4 沒寫理由 → 「${f.overReason}」`)
    const rOver = await B.orderBlood({ admissionId: adm.id, product: 'rbc', units: 1, indication: '心肺疾病病人 Hb < 10 g/dL', overReason: '急性心肌梗塞' })
    ok(rOver.overReason === '急性心肌梗塞', '寫了理由就能開（只提醒不擋），理由存在單上')

    // 血庫
    await as('lab01')
    const dash0 = await api.dashboardApi.getDashboard()
    ok(dash0.bloodWork >= 2, `首頁血庫待辦 ${dash0.bloodWork}`)
    ok((await B.bloodCandidates(r1.id)).length === 0, '還沒驗血型：沒有可配的血袋')
    msg = await errOf(() => B.crossmatchBlood(r1.id, [db().bloodUnits[0].id]))
    ok(msg.includes('請先驗血型'), '沒驗血型不能配血')
    f = await fieldsOf(() => B.recordBloodTyping(r1.id, { abo: 'X', rh: '' }))
    ok(f.abo && f.rh, '血型欄位檢查')
    const typed = await B.recordBloodTyping(r1.id, { abo: 'A', rh: '+' })
    ok(typed.typingText === 'A Rh+' && !typed.warning && pt().bloodTypings.length === 1, '驗血型 A Rh+，記到病人身上（本院第一次）')
    msg = await errOf(() => B.recordBloodTyping(r1.id, { abo: 'A', rh: '+' }))
    ok(msg.includes('已經驗過'), '同一張單不能驗兩次')
    // 同一位病人另一張單驗出不同血型 → 擋下（可能抽錯人）
    f = await fieldsOf(() => B.recordBloodTyping(rOver.id, { abo: 'B', rh: '+' }))
    ok(f.abo?.includes('抽錯人') && pt().bloodTypings.length === 1, `和上次不同：「${f.abo}」，不登錄`)
    await B.recordBloodTyping(rOver.id, { abo: 'A', rh: '+' })
    const cands = await B.bloodCandidates(r1.id)
    const today0 = T
    ok(cands.length > 0 && cands.every((u) => u.product === 'rbc' && !u.expired && api.bloodCompatible('rbc', { abo: 'A', rh: '+' }, u).ok) && cands[0].typeText === 'A Rh+', `候選 ${cands.length} 袋：都相容、沒過期，同型在前`)
    ok(cands.filter((u) => u.typeText === 'A Rh+').every((u, i, a) => i === 0 || a[i - 1].expiresOn <= u.expiresOn), '同型的先到期的在前')
    const expired = db().bloodUnits.find((u) => u.product === 'rbc' && u.expiresOn < today0 && u.status === 'available')
    const bad = db().bloodUnits.find((u) => u.product === 'rbc' && u.abo === 'B' && u.status === 'available')
    msg = await errOf(() => B.crossmatchBlood(r1.id, [bad.id]))
    ok(msg.includes('ABO 不相容'), `配 B 型給 A 型病人：「${msg}」`)
    if (expired) {
      msg = await errOf(() => B.crossmatchBlood(r1.id, [expired.id]))
      ok(msg.includes('過期'), '過期的血袋不能配')
    }
    f = await fieldsOf(() => B.crossmatchBlood(r1.id, cands.slice(0, 3).map((u) => u.id)))
    ok(f.units?.includes('還差 2'), `選太多：「${f.units}」`)
    const m1 = await B.crossmatchBlood(r1.id, cands.slice(0, 2).map((u) => u.id))
    const [u1, u2] = m1.rows.map((x) => x.unit.id)
    ok(m1.status === 'ready' && [u1, u2].every((id) => db().bloodUnits.find((u) => u.id === id).status === 'reserved'), '配好 2 袋：可發血，血袋標已配血')
    msg = await errOf(() => B.crossmatchBlood(r1.id, [cands[2].id]))
    ok(msg.includes('配滿'), '配滿了不能再配')

    // 發血、退回
    let v1 = await B.issueBlood(r1.id, u1)
    ok(v1.status === 'transfusing' && v1.rows.find((x) => x.unit.id === u1).state === 'issued' && v1.rows.find((x) => x.unit.id === u1).canReturn, '發血：這袋已發血待輸、30 分鐘內可退回')
    msg = await errOf(() => B.issueBlood(r1.id, u1))
    ok(msg.includes('已經發出'), '不能重複發血')
    v1 = await B.returnBlood(r1.id, u1, '病人外出檢查')
    ok(v1.status === 'ready' && db().bloodUnits.find((u) => u.id === u1).status === 'reserved', '退回血庫：回到已配血（仍配給這位病人）')
    await B.issueBlood(r1.id, u1)
    const iss = () => db().bloodRequests.find((r) => r.id === r1.id).issues.filter((i) => i.unitId === u1).at(-1)
    iss().issuedAt = addMinutes(nowStr(), -31)
    msg = await errOf(() => B.returnBlood(r1.id, u1, '不輸了'))
    ok(msg.includes('超過 30 分鐘'), `發血超過 30 分鐘不能退回：「${msg}」`)
    iss().issuedAt = addMinutes(nowStr(), -5)

    // 護理師：床邊核對
    await as('nurse01')
    const nurseDash = await api.dashboardApi.getDashboard()
    ok(nurseDash.transfusionTodo >= 1, `護理站首頁：輸血待處理 ${nurseDash.transfusionTodo}`)
    msg = await errOf(() => B.startTransfusion(r1.id, u1, { vitals: V }))
    ok(msg.includes('另一位護理師或醫師'), `沒有第二人核對不能開始：「${msg}」`)
    const W = (username, unitId = u1) => api.witnessApi.approveWitness({ purpose: 'transfusion', requestId: r1.id, unitId, username, password: '1234' })
    ok((await W('nurse01')).ok === false, '核對人不能是自己')
    ok((await W('clerk01')).ok === false, '核對人要是護理師或醫師')
    const wrongUnitToken = (await (async () => { try { return await W('nurse02', u2) } catch { return { ok: false } } })())
    ok(wrongUnitToken.ok === false, '還沒發血的那袋不能核對')
    let w = await W('nurse02')
    ok(w.ok && w.witnessName, `核對：${w.witnessName}`)
    f = await fieldsOf(() => B.startTransfusion(r1.id, u1, { witness: w.token, vitals: { temp: 36.5 } }))
    ok(f.pulse && f.sbp && f.dbp, '輸血前生命徵象四項必填')
    // 掃描（打開設定）
    db().securitySettings = { ...db().securitySettings, requireScan: true }
    msg = await errOf(() => B.startTransfusion(r1.id, u1, { witness: w.token, vitals: V }))
    ok(msg.includes('掃描'), '掃描設定開著：沒掃不能開始')
    const otherAdm = db().admissions.find((a) => a.status === 'admitted' && a.id !== adm.id)
    msg = await errOf(() => B.startTransfusion(r1.id, u1, { witness: w.token, vitals: V, scan: { patientCode: otherAdm.admitNo, unitCode: db().bloodUnits.find((u) => u.id === u1).unitNo } }))
    ok(msg.includes('病人不對'), `腕帶掃到別人：「${msg}」`)
    const unitNo2 = db().bloodUnits.find((u) => u.id === u2).unitNo
    const sc = await B.bloodScanCheck({ requestId: r1.id, unitId: u1, kind: 'unit', code: unitNo2 })
    ok(!sc.ok && sc.message.includes('配給') && db().auditLogs.some((l) => l.action === '輸血掃描不符'), `血袋掃到別袋：「${sc.message}」，記稽核`)
    msg = await errOf(() => B.startTransfusion(r1.id, u1, { witness: w.token, vitals: V, scan: { patientCode: adm.admitNo, unitCode: unitNo2 } }))
    ok(msg.includes('血袋不對'), '服務層開始時再核對血袋')
    const vitalsBefore = db().vitals.length
    let s = await B.startTransfusion(r1.id, u1, { witness: w.token, vitals: V, scan: { patientCode: ` ${adm.admitNo.toLowerCase()} `, unitCode: db().bloodUnits.find((u) => u.id === u1).unitNo } })
    let row = s.rows.find((x) => x.unit.id === u1)
    ok(row.state === 'transfusing' && row.issue.witnessName === w.witnessName && row.issue.transfusion.scan.mode === 'scanned' && db().vitals.length === vitalsBefore + 1, '開始輸血：記核對人、已掃描，生命徵象也寫進病人的紀錄')
    db().securitySettings = { ...db().securitySettings, requireScan: false }
    msg = await errOf(() => B.startTransfusion(r1.id, u1, { witness: w.token, vitals: V }))
    ok(msg.includes('已經開始'), '不能重複開始')

    // 15 分鐘、結束
    const tr = () => db().bloodRequests.find((r) => r.id === r1.id).issues.filter((i) => i.unitId === u1).at(-1).transfusion
    ok(!row.todo.check, '剛開始：還不用量')
    tr().startAt = addMinutes(nowStr(), -16)
    let pb = await B.patientBlood(adm.id)
    ok(pb.requests.find((r) => r.id === r1.id).rows.find((x) => x.unit.id === u1).todo.check === 'due' && (await api.dashboardApi.getDashboard()).transfusionTodo >= 1, '開始 15 分鐘：該量生命徵象（首頁也算）')
    tr().startAt = addMinutes(nowStr(), -31)
    pb = await B.patientBlood(adm.id)
    ok(pb.requests.find((r) => r.id === r1.id).rows.find((x) => x.unit.id === u1).todo.check === 'overdue', '超過 30 分鐘還沒量：逾時')
    msg = await errOf(() => B.endTransfusion(r1.id, u1, { volume: 250, vitals: V }))
    ok(msg.includes('15 分鐘'), '沒量 15 分鐘的不能結束')
    await B.recordTransfusionCheck(r1.id, u1, V)
    msg = await errOf(() => B.recordTransfusionCheck(r1.id, u1, V))
    ok(msg.includes('記過'), '15 分鐘只記一次')
    f = await fieldsOf(() => B.endTransfusion(r1.id, u1, { volume: 0, vitals: V }))
    ok(f.volume, '輸入量要大於 0')
    s = await B.endTransfusion(r1.id, u1, { volume: 240, vitals: V })
    ok(s.rows.find((x) => x.unit.id === u1).state === 'done' && db().bloodUnits.find((u) => u.id === u1).status === 'transfused', '結束輸血：這袋已輸完')

    // 第二袋：輸血反應
    await as('lab01')
    await B.issueBlood(r1.id, u2)
    await as('nurse01')
    w = await W('nurse02', u2)
    await B.startTransfusion(r1.id, u2, { witness: w.token, vitals: V })
    f = await fieldsOf(() => B.reportTransfusionReaction(r1.id, u2, { symptoms: [] }))
    ok(f.symptoms, '輸血反應要勾症狀')
    s = await B.reportTransfusionReaction(r1.id, u2, { symptoms: ['發燒（上升 ≥ 1°C）', '畏寒、發抖'], note: '體溫 38.6', volume: 80 })
    row = s.rows.find((x) => x.unit.id === u2)
    ok(row.state === 'stopped' && row.reactionUnacked && s.status === 'done', '輸血反應：立刻停止，待醫師確認（這張單沒有要輸的了）')
    await as(attending)
    ok((await api.dashboardApi.getDashboard()).bloodReactions >= 1 && (await B.patientBlood(adm.id)).reactionsUnacked === 1, '主治首頁與病人頁：輸血反應待確認')
    await as(userOf(other.id))
    msg = await errOf(() => B.ackTransfusionReaction(r1.id, u2, '已處理'))
    ok(msg.includes('醫師'), '別科醫師不能確認')
    await as(attending)
    f = await fieldsOf(() => B.ackTransfusionReaction(r1.id, u2, ' '))
    ok(f.note, '確認要寫處置')
    s = await B.ackTransfusionReaction(r1.id, u2, '送輸血反應檢查，給退燒藥')
    ok(!s.rows.find((x) => x.unit.id === u2).reactionUnacked && (await B.patientBlood(adm.id)).reactionsUnacked === 0, '確認後不再提醒')

    // 取消
    const rC = await B.orderBlood({ admissionId: adm.id, product: 'ffp', units: 2, indication: '侵入性處置前矯正凝血功能' })
    await as('lab01')
    await B.recordBloodTyping(rC.id, { abo: 'A', rh: '+' })
    const ffp = await B.bloodCandidates(rC.id)
    ok(ffp.every((u) => ['A', 'AB'].includes(u.abo)), '血漿：A 型病人只列 A、AB 型')
    await B.crossmatchBlood(rC.id, [ffp[0].id])
    await B.issueBlood(rC.id, ffp[0].id)
    await as(attending)
    msg = await errOf(() => B.cancelBloodRequest(rC.id, '不需要了'))
    ok(msg.includes('已發出'), '有血袋發出了不能取消')
    // 出院把關：已發血還沒輸完不能辦出院
    db().admissions.find((a) => a.id === adm.id).dischargeSummary = { ...(db().admissions.find((a) => a.id === adm.id).dischargeSummary ?? {}), signedAt: nowStr(), dischargeType: '改善出院' }
    await as('nurse01')
    msg = await errOf(() => api.admissionApi.discharge(adm.id))
    ok(msg.includes('血袋已發出'), `出院前要輸完或退回：「${msg}」`)
    delete db().admissions.find((a) => a.id === adm.id).dischargeSummary.signedAt
    await as('lab01')
    await B.returnBlood(rC.id, ffp[0].id, '醫師改變治療計畫')
    await as(attending)
    f = await fieldsOf(() => B.cancelBloodRequest(rC.id, ' '))
    ok(f.reason, '取消要原因')
    s = await B.cancelBloodRequest(rC.id, '病情改善，不需輸血')
    ok(s.status === 'cancelled' && db().bloodUnits.find((u) => u.id === ffp[0].id).status === 'available' && s.released.length === 1, '取消：配好的血袋釋出回可用（留釋出紀錄）')

    // 住院帳單：交叉試驗每袋（含釋出的）、血品發出才算（退回的不算）
    await as('clerk01')
    const bill = (await api.ipdChargeApi.getIpdBill(adm.id)).bill
    const qtyOf = (name) => bill.lines.filter((l) => l.name.startsWith(name)).reduce((n, l) => n + l.qty, 0)
    ok(qtyOf('交叉配合試驗') === 3 && qtyOf('減除白血球紅血球濃厚液') === 2 && qtyOf('新鮮冷凍血漿') === 0, `帳單：交叉試驗 ${qtyOf('交叉配合試驗')}、紅血球 ${qtyOf('減除白血球紅血球濃厚液')}（退回的那次不算）、血漿 ${qtyOf('新鮮冷凍血漿')}（退回後取消）`)

    // 自述血型和檢驗不同：提醒
    const adm2 = db().admissions.find((a) => a.status === 'admitted' && a.id !== adm.id && !db().bloodRequests.some((r) => r.admissionId === a.id) && !db().patients.find((p) => p.id === a.patientId).bloodTypings?.length)
    if (adm2) {
      db().patients.find((p) => p.id === adm2.patientId).bloodType = 'B'
      await as(userOf(adm2.doctorId))
      const rr = await B.orderBlood({ admissionId: adm2.id, product: 'ffp', units: 1, indication: '大量輸血' })
      await as('lab01')
      const tw = await B.recordBloodTyping(rr.id, { abo: 'AB', rh: '-' })
      ok(tw.warning?.includes('自述'), `自述 B 型、驗出 AB 型：提醒「${tw.warning}」`)
      const abFfp = await B.bloodCandidates(rr.id)
      ok(abFfp.length > 0 && abFfp.every((u) => u.abo === 'AB'), '血漿：AB 型病人只能輸 AB 型血漿（Rh 陰性也可輸 Rh 陽性的血漿）')
    }

    // 入庫、報廢
    await as('lab01')
    f = await fieldsOf(() => B.receiveBloodUnits({ product: 'plt', abo: 'A', rh: '+', count: 0, expiresOn: addDaysT(-1) }))
    ok(f.count && f.expiresOn, '入庫：袋數、已過期的不能入')
    const got = await B.receiveBloodUnits({ product: 'plt', abo: 'A', rh: '+', count: 3, expiresOn: addDaysT(5) })
    ok(got.length === 3 && new Set(got.map((u) => u.unitNo)).size === 3 && got.every((u) => u.unitNo.startsWith('TB') && u.volume === 250), `入庫 3 袋：${got.map((u) => u.unitNo).join('、')}`)
    if (expired) {
      const sv = await B.scrapBloodUnit(expired.id, '過期')
      ok(sv.status === 'scrapped' && !(await B.listBloodWork()).units.some((u) => u.id === expired.id), '過期血袋報廢，不再列在庫存')
    }
    msg = await errOf(() => B.scrapBloodUnit(u1, '過期'))
    ok(msg.includes('用掉'), '輸過的不能報廢')
    const work = await B.listBloodWork()
    ok(work.stock.some((x) => x.product === 'plt' && x.abo === 'A' && x.available >= 3) && !work.requests.some((r) => r.id === rC.id), '庫存表：可用量；取消的單不在待處理')

    // 規則只在服務層
    const fs = await import('node:fs')
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]))
    const ui = [...walk('src/pages'), ...walk('src/components')].filter((p) => p.endsWith('.vue'))
    ok(ui.every((p) => !/Rh 陰性|ABO 不相容|includes\('A'\)/.test(fs.readFileSync(p, 'utf8'))), '頁面沒有自己判斷血型相容（只在 blood-rules）')
  }

  // 病歷影本申請：申請人核對（本人、代理人）、範圍、費用（主檔單價與生效日）、收據進日結、列印與補印、當天作廢、權限
  console.log('\n[病歷影本申請]')
  {
    resetDb('small')
    const db = () => dbm.db
    const C = api.copyApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    const P = { name: '王小明', idNo: 'A123456789' }
    ok(!Object.keys(api.checkCopyApplicant({ kind: 'self', name: '王小明', idNo: 'a123456789 ' }, P)).length, '本人：姓名與身分證號相符（大小寫、空白不影響）')
    let e = api.checkCopyApplicant({ kind: 'self', name: '王大明', idNo: 'A223456789' }, P)
    ok(e.name?.includes('代理人') && e.idNo?.includes('不符'), `本人不符：「${e.name}」「${e.idNo}」`)
    e = api.checkCopyApplicant({ kind: 'agent', name: '王太太', idNo: 'A123456789' }, P)
    ok(e.idNo?.includes('本人') && e.relation && e.authorizationChecked, '代理人：不能用病人自己的證號、要關係、要勾委託書')
    ok(!Object.keys(api.checkCopyApplicant({ kind: 'agent', name: '王太太', idNo: 'A223456789', relation: '配偶', authorizationChecked: true }, P)).length, '代理人資料齊全')
    ok(api.checkCopyApplicant({ kind: 'agent', name: 'x', idNo: '12345' }, P).idNo?.includes('格式'), '身分證號格式')
    ok(api.copyFee(100, 10, 3) === 130, '費用：基本費＋每頁×頁數')

    // 主檔：不能當醫令開
    ok(db().procedures.filter((p) => p.recordCopy).length === 2 && !(await api.masterApi.listProcedures({})).some((p) => p.recordCopy), '主檔有基本費、每頁兩項；開立選單沒有')

    // 找一位有完成門診、有檢驗報告的病人
    const pt = db().patients.find((p) => !p.deceasedAt && db().encounters.some((x) => x.patientId === p.id && x.status === 'completed') && db().labReports.some((r) => r.patientId === p.id))
    await as('nurse01')
    let msg = await errOf(() => C.copySources(pt.id))
    ok(msg.includes('權限'), `護理師預設沒有病歷影本權限：「${msg}」`)
    await as('clerk01')
    const src = await C.copySources(pt.id)
    ok(src.sources.some((s) => s.kind === 'opd') && src.sources.some((s) => s.kind === 'lab') && src.fee.base === 100 && src.fee.perPage === 10, `可申請 ${src.sources.length} 項（門診、檢驗…），基本費 100、每頁 10`)
    ok(src.sources.every((s, i, a) => i === 0 || a[i - 1].date >= s.date), '新的在前')
    ok(!src.sources.some((s) => s.kind === 'opd' && db().encounters.find((x) => x.id === s.refId).status !== 'completed'), '沒完成的門診不能申請')
    // 一定挑到一份門診、一份檢驗（列印頁兩種版面都要測到），再補一項
    const o1 = src.sources.find((s) => s.kind === 'opd')
    const l1 = src.sources.find((s) => s.kind === 'lab')
    const pick = [o1, l1, src.sources.find((s) => s !== o1 && s !== l1)].map((s) => ({ kind: s.kind, refId: s.refId }))
    const self = { kind: 'self', name: pt.name, idNo: pt.idNo }

    let f = await fieldsOf(() => C.createRecordCopy({ patientId: pt.id, applicant: { kind: 'self', name: '別人', idNo: 'Z199999999' }, purpose: '', items: [], payMethod: 'cash', received: 1000 }))
    ok(f.name && f.idNo && f.purpose && f.items, '欄位一次標出：姓名、證號、用途、項目')
    const other = db().encounters.find((x) => x.patientId !== pt.id && x.status === 'completed')
    f = await fieldsOf(() => C.createRecordCopy({ patientId: pt.id, applicant: self, purpose: '保險理賠', items: [{ kind: 'opd', refId: other.id }], payMethod: 'card' }))
    ok(f.items?.includes('不是這位病人'), '別的病人的病歷不能印')
    f = await fieldsOf(() => C.createRecordCopy({ patientId: pt.id, applicant: self, purpose: '保險理賠', items: pick, payMethod: 'cash', received: 100 }))
    ok(f.received?.includes('不足'), `現金不足：「${f.received}」`)
    const before = db().charges.length
    const r1 = await C.createRecordCopy({ patientId: pt.id, applicant: self, purpose: '保險理賠', items: [...pick, pick[0]], payMethod: 'cash', received: 200 })
    const c1 = db().charges.find((c) => c.id === r1.chargeId)
    ok(r1.pages === 3 && r1.amount === 130 && r1.change === 70 && /^MR\d{11}$/.test(r1.no), `申請 ${r1.no}：3 項 3 頁（重複的只算一次）130 元，找零 70`)
    ok(db().charges.length === before + 1 && c1.copyRequestId === r1.id && c1.visitId === '' && c1.nhiPoints === 0 && c1.lines.every((l) => l.patientPay && l.kind === 'self') && c1.receiptNo.startsWith('R'), `收據 ${c1.receiptNo}：自費，不申報健保`)
    ok(db().auditLogs.some((l) => l.action === '病歷影本申請' && l.detail.includes(r1.no)), '稽核')

    // 日結
    const rep = await api.chargeApi.dailyReport(T)
    const row = rep.charges.find((c) => c.id === c1.id)
    ok(row && row.deptName === '病歷影本' && rep.byDept.some((d) => d.deptName === '病歷影本' && d.patientTotal >= 130), '日結：收據列在「病歷影本」')
    const sum = (o) => Object.values(o).reduce((n, x) => n + x, 0)
    ok(sum(rep.byPayMethod) === rep.collected && sum(rep.byFeeType) === rep.patientTotal, '日結各分項加總仍等於合計')

    // 一般收據的作廢、退費、查詢都擋
    msg = await errOf(() => api.chargeApi.voidCharge(c1.id, '測試'))
    ok(msg.includes('病歷影本'), `批價頁不能作廢影本收據：「${msg}」`)
    msg = await errOf(() => api.chargeApi.getReceipt(c1.id))
    ok(msg.includes('病歷影本'), '批價頁查不到（請到病患資料）')

    // 列印、補印
    const pr = await C.printRecordCopy(r1.id)
    ok(pr.pages.length === 3 && pr.times === 1 && pr.pages.every((p) => p.title && p.meta) && pr.applicantText.startsWith('本人'), `列印 ${pr.pages.length} 頁：${pr.pages.map((p) => p.title).join('、')}`)
    const opdPage = pr.pages.find((p) => p.kind === 'opd')
    ok(opdPage && opdPage.sections.some((s) => s.heading === '診斷') && !/\b(sbp|dbp|temp)\b/.test(JSON.stringify(opdPage)), '門診病歷頁：診斷、SOAP，生命徵象用中文')
    const labPage = pr.pages.find((p) => p.kind === 'lab')
    ok(labPage && labPage.table.rows.length > 0, '檢驗報告頁：結果表')
    const pr2 = await C.printRecordCopy(r1.id)
    ok(pr2.times === 2 && db().auditLogs.some((l) => l.action === '列印病歷影本' && l.detail.includes('補印')), '補印記第 2 次、寫稽核')

    // 代理人
    const agent = { kind: 'agent', name: '代理人甲', idNo: 'B223456789', relation: '配偶', authorizationChecked: true }
    f = await fieldsOf(() => C.createRecordCopy({ patientId: pt.id, applicant: { ...agent, authorizationChecked: false }, purpose: '轉院、他院就醫', items: pick.slice(0, 1), payMethod: 'card' }))
    ok(f.authorizationChecked, '代理人沒勾委託書 → 擋')
    const r2 = await C.createRecordCopy({ patientId: pt.id, applicant: agent, purpose: '轉院、他院就醫', items: pick.slice(0, 1), payMethod: 'card' })
    ok(r2.applicantText === '代理人 代理人甲（配偶）' && r2.amount === 110 && r2.payMethod === 'card', `代理人申請：${r2.applicantText}，刷卡 ${r2.amount} 元`)

    // 主檔調價（排生效日）：今天起改價，新申請用新價；已收的收據不變
    const base = db().procedures.find((p) => p.recordCopy === 'base')
    base.priceChanges = [{ from: T, points: 0, selfPrice: 200, by: 'U001', at: nowStr() }]
    const src2 = await C.copySources(pt.id)
    ok(src2.fee.base === 200 && db().charges.find((c) => c.id === r1.chargeId).patientTotal === 130, '主檔改價後：新申請用新價，已收的不變')
    delete base.priceChanges

    // 作廢
    f = await fieldsOf(() => C.voidRecordCopy(r2.id, ' '))
    ok(f.reason, '作廢要原因')
    const v2 = await C.voidRecordCopy(r2.id, '選錯項目，重新申請')
    ok(v2.voided && db().charges.find((c) => c.id === r2.chargeId).voided && !v2.canVoid, '作廢：收據一起作廢')
    msg = await errOf(() => C.printRecordCopy(r2.id))
    ok(msg.includes('作廢'), '作廢的不能印')
    const rep2 = await api.chargeApi.dailyReport(T)
    ok(!rep2.byDept.some((d) => d.deptName === '病歷影本' && d.patientTotal >= 240) && rep2.voidedCount >= 1, '作廢的不算進日結')
    // 隔天以後不能作廢
    db().recordCopies.find((x) => x.id === r1.id).createdAt = `${addDaysT(-1)} 10:00`
    msg = await errOf(() => C.voidRecordCopy(r1.id, '測試'))
    ok(msg.includes('不能作廢'), `隔天不能作廢：「${msg}」`)
    const list = await C.listRecordCopies(pt.id)
    ok(list.length === 2 && list[0].id === r2.id && !list.find((x) => x.id === r1.id).canVoid, '申請紀錄：新的在前、昨天的不能作廢')

    // 權限：指定給個人後取消櫃台角色
    await as('admin')
    await api.permissionApi.setPermissionGrant('record.copy', 'U402', { on: true, reason: '病歷組' })
    await api.permissionApi.savePermissionRoles('record.copy', { roles: [], reason: '只給病歷組', confirm: true })
    await as('clerk01')
    msg = await errOf(() => C.listRecordCopies(pt.id))
    ok(msg.includes('權限'), '角色取消後一般櫃台不能申請')
    await as('clerk02')
    ok((await C.listRecordCopies(pt.id)).length === 2, '被指定的櫃台（病歷組）可以')
  }

  // 經營月報：月份期間、比較文字、權限、和日結同一份收入、門診住院數字對得起來、沒有資料顯示 null、Excel
  console.log('\n[經營月報]')
  {
    resetDb('small')
    const db = () => dbm.db
    const M = api.managementApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    // 規則
    ok(JSON.stringify(api.monthRange('2028-02', '2028-11-17')) === JSON.stringify({ from: '2028-02-01', to: '2028-02-29', partial: false }) && api.monthRange('2026-11', '2026-11-17').to === '2026-11-17' && api.monthRange('2026-11', '2026-11-17').partial, '月份期間：閏年二月到 29 日；本月只算到今天')
    ok(api.shiftMonth('2026-01', -1) === '2025-12' && api.shiftMonth('2026-11', -12) === '2025-11' && api.shiftMonth('2026-12', 1) === '2027-01', '前後月份跨年')
    ok(api.mgmtChangeText(110, 100, '人次') === '+10.0%' && api.mgmtChangeText(90, 100, '元') === '−10.0%' && api.mgmtChangeText(72.5, 70, '%') === '+2.5 百分點' && api.mgmtChangeText(5, 0, '人') === '+5' && api.mgmtChangeText(5, null, '人') === '—', '比較：一般用 %、比率用百分點、基準 0 寫差多少、沒資料「—」')
    ok(api.mgmtValueText(null, '元') === '—' && api.mgmtValueText(1234567, '元') === '1,234,567' && api.mgmtValueText(72.456, '%') === '72.5%', '數值顯示')

    // 權限
    const month = T.slice(0, 7)
    await as('clerk01')
    let msg = await errOf(() => M.managementReport(month))
    ok(msg.includes('權限'), `櫃台預設不能看：「${msg}」`)
    await as('admin')
    msg = await errOf(() => M.managementReport(api.shiftMonth(month, 1)))
    ok(msg.includes('還沒到'), '未來的月份擋')
    msg = await errOf(() => M.managementReport('2026-13'))
    ok(msg.includes('月份'), '月份格式')
    const r = await M.managementReport(month)
    const c = r.current
    ok(r.partial && r.to === T && c.hasData, `本月（算到 ${r.to}）有資料`)

    // 收入和日結同一份
    const rep = await api.chargeApi.dailyReport(r.from, r.to)
    ok(c.collected === rep.collected && c.nhiPoints === rep.nhiPoints && c.revenueOpd + c.revenueIpd + c.revenueOther === rep.patientTotal, `實收 ${c.collected}＝日結；門診 ${c.revenueOpd}＋住院 ${c.revenueIpd}＋其他 ${c.revenueOther}＝應收 ${rep.patientTotal}`)
    ok(c.drugShare === null || (c.drugShare > 0 && c.drugShare < 100), `藥費占比 ${c.drugShare}%`)

    // 門診、住院
    const seen = db().visits.filter((v) => v.date >= r.from && v.date <= r.to && ['consulted', 'charged', 'dispensed'].includes(v.status))
    ok(c.opdVisits === seen.length && c.opdFirst + c.opdRevisit === c.opdVisits, `門診 ${c.opdVisits} 人次（初診 ${c.opdFirst}、複診 ${c.opdRevisit}）：只算看過診的`)
    ok(r.opdByDept.reduce((n, d) => n + d.visits, 0) === c.opdVisits && r.opdByDoctor.reduce((n, d) => n + d.visits, 0) === c.opdVisits && r.opdByDept.every((d, i, a) => i === 0 || a[i - 1].visits >= d.visits), '科別、醫師加總＝門診人次，多的在前')
    const days = dateUtil.diffDays(r.from, r.to) + 1
    ok(c.occupancy === Math.round((c.patientDays / (r.beds * days)) * 1000) / 10 && r.ipdByDept.reduce((n, d) => n + d.patientDays, 0) === c.patientDays, `佔床率 ${c.occupancy}%＝住院人日 ${c.patientDays}÷（${r.beds} 床 × ${days} 天）；科別加總一致`)
    const todayCensus = db().admissions.filter((a) => a.status === 'admitted' && a.admittedAt && a.admittedAt.slice(0, 10) <= T).length
    ok(c.patientDays >= todayCensus, `今天在院 ${todayCensus} 人有算進住院人日`)
    ok(c.labReports === db().labReports.filter((x) => x.reportedAt.slice(0, 10) >= r.from && x.reportedAt.slice(0, 10) <= r.to).length, `檢驗報告 ${c.labReports} 份、影像 ${c.imagingReports} 份、門診處方 ${c.prescriptions} 張`)

    // 新的收入會反映：病歷影本算「其他」
    await as('clerk01')
    const pt = db().patients.find((p) => !p.deceasedAt && db().labReports.some((x) => x.patientId === p.id))
    const src = await api.copyApi.copySources(pt.id)
    await api.copyApi.createRecordCopy({ patientId: pt.id, applicant: { kind: 'self', name: pt.name, idNo: pt.idNo }, purpose: '個人保存', items: [{ kind: src.sources[0].kind, refId: src.sources[0].refId }], payMethod: 'card' })
    await as('admin')
    const r2 = await M.managementReport(month)
    ok(r2.current.revenueOther === c.revenueOther + 110 && r2.current.collected === c.collected + 110, '病歷影本 110 元算進「其他收入」與實收')

    // 沒有資料的月份
    const old = api.shiftMonth(month, -24)
    const r3 = await M.managementReport(old)
    ok(!r3.current.hasData && r3.current.opdVisits === null && r3.current.collected === null && api.mgmtChangeText(r3.current.opdVisits, r3.prev.opdVisits, '人次') === '—', `${old} 沒有資料：值是 null（畫面「—」），不是 0`)
    ok(r.trend.length === 12 && r.trend[11].month === month && r.trend[0].month === api.shiftMonth(month, -11) && r.trend.some((x) => !x.hasData && x.opdVisits === null), '近 12 個月：舊的在前，沒資料的月份是 null')
    ok(r.lastYear.month === api.shiftMonth(month, -12) && !r.lastYear.hasData, '去年同月（示範資料沒有）')

    // 指定給個人
    await api.permissionApi.setPermissionGrant('report.management', db().users.find((u) => u.username === 'dr02').id, { on: true, reason: '院長' })
    await as('dr02')
    ok((await M.managementReport(month)).current.hasData, '指定給院長（dr02）就能看')
    await as('dr01')
    ok((await errOf(() => M.managementReport(month))).includes('權限'), '其他醫師不行')

    // Excel
    const bytes = api.managementXlsx(r)
    ok(bytes[0] === 0x50 && bytes[1] === 0x4b && api.managementXlsxFileName(r) === `經營月報_${month}.xlsx`, `匯出 Excel（${bytes.length} bytes，${api.managementXlsxFileName(r)}）`)
  }

  // 第五輪小項目：護理站病房清單與本班待辦的輸血標記、示範資料的初診病人、存好後的對話框可以 Esc 關閉
  console.log('\n[小項目：輸血標記、初診、對話框]')
  {
    resetDb('small')
    const db = () => dbm.db
    const B = api.bloodApi
    const N = api.nursingApi
    const { addMinutes } = dateUtil
    const userOf = (doctorId) => db().users.find((u) => u.doctorId === doctorId).username

    // 初診
    const first = db().visits.filter((v) => v.firstVisit)
    const today = first.filter((v) => v.date === T)
    ok(first.length >= 2 && today.length <= 3 && first.every((v) => v.date >= addDaysT(-60)), `種子初診 ${first.length} 位（今天 ${today.length} 位）`)
    ok(first.every((v) => !db().visits.some((x) => x.patientId === v.patientId && x.status !== 'cancelled' && x.createdAt < v.createdAt) && db().patients.find((p) => p.id === v.patientId).createdAt <= v.createdAt && !db().admissions.some((a) => a.patientId === v.patientId && (a.admittedAt ?? a.reservedAt) < v.createdAt)), '初診病人：之前沒有任何掛號、建檔在掛號之前、之前沒住過院')
    const weeks = new Map()
    for (const v of first.filter((x) => x.date !== T)) {
      const w = Math.floor(dateUtil.diffDays(v.date, T) / 7)
      weeks.set(w, (weeks.get(w) ?? 0) + 1)
    }
    ok([...weeks.values()].every((n) => n <= 2), '之前每週最多 2 位')
    await as('admin')
    const mr = await api.managementApi.managementReport(T.slice(0, 7))
    ok(mr.current.opdFirst > 0 || !first.some((v) => v.date.slice(0, 7) === T.slice(0, 7) && ['consulted', 'charged', 'dispensed'].includes(v.status)), `經營月報的初診：${mr.current.opdFirst}`)

    // 輸血標記：自己造一袋發血
    const adm = db().admissions.find((a) => a.status === 'admitted' && !a.deptTransfers?.some((x) => x.status === 'pending') && !db().bloodRequests.some((r) => r.admissionId === a.id))
    const ward = db().beds.find((b) => b.id === adm.bedId).ward
    await as(userOf(adm.doctorId))
    const req = await B.orderBlood({ admissionId: adm.id, product: 'ffp', units: 1, indication: '大量輸血' })
    await as('lab01')
    await B.recordBloodTyping(req.id, { abo: 'AB', rh: '+' })
    const unit = (await B.bloodCandidates(req.id))[0]
    await B.crossmatchBlood(req.id, [unit.id])
    await as('nurse01')
    const wp = async () => (await N.listWardPatients(ward)).find((p) => p.id === adm.id)
    const bt = async () => (await N.listWardTasks(ward)).filter((x) => x.kind === 'blood' && x.admissionId === adm.id)
    ok((await wp()).bloodIssued === 0 && !(await bt()).length, '配好還沒發血：護理站沒有標記')
    await as('lab01')
    await B.issueBlood(req.id, unit.id)
    await as('nurse01')
    let p = await wp()
    let tasks = await bt()
    ok(p.bloodIssued === 1 && p.bloodUrgency === 'due' && tasks.length === 1 && tasks[0].urgency === 'due' && tasks[0].text.includes('已發血'), `發血後：病房清單「已發血」、本班待辦「${tasks[0]?.text}」`)
    const dash = async () => (await api.dashboardApi.getDashboard()).transfusionTodo
    const d1 = await dash()
    ok(d1 >= 1, `首頁輸血待處理 ${d1}`)
    const iss = () => db().bloodRequests.find((r) => r.id === req.id).issues.at(-1)
    iss().issuedAt = addMinutes(nowStr(), -31)
    ok((await wp()).bloodUrgency === 'overdue' && (await bt())[0].text.includes('超過 30 分鐘'), '發血超過 30 分鐘：標逾時')
    iss().issuedAt = addMinutes(nowStr(), -2)
    const w = await api.witnessApi.approveWitness({ purpose: 'transfusion', requestId: req.id, unitId: unit.id, username: 'nurse02', password: '1234' })
    await B.startTransfusion(req.id, unit.id, { witness: w.token, vitals: { temp: 36.6, pulse: 80, sbp: 120, dbp: 70 } })
    p = await wp()
    tasks = await bt()
    ok(p.bloodTransfusing === 1 && p.bloodIssued === 0 && !p.bloodUrgency && tasks[0].urgency === 'todo' && (await dash()) === d1 - 1, '剛開始輸血：標「輸血中」，還不用量（首頁不算待處理）')
    iss().transfusion.startAt = addMinutes(nowStr(), -16)
    p = await wp()
    tasks = await bt()
    ok(p.bloodUrgency === 'due' && tasks[0].urgency === 'due' && tasks[0].text.includes('15 分鐘') && (await dash()) === d1, '開始 15 分鐘：清單、待辦、首頁都提醒量生命徵象')
    iss().transfusion.startAt = addMinutes(nowStr(), -31)
    ok((await wp()).bloodUrgency === 'overdue' && (await bt())[0].urgency === 'overdue', '超過 30 分鐘還沒量：逾時')
    await B.recordTransfusionCheck(req.id, unit.id, { temp: 36.7, pulse: 82, sbp: 118, dbp: 70 })
    await B.endTransfusion(req.id, unit.id, { volume: 200, vitals: { temp: 36.7, pulse: 80, sbp: 120, dbp: 72 } })
    p = await wp()
    ok(!p.bloodTransfusing && !p.bloodIssued && !(await bt()).length, '輸完：標記與待辦消失')

    // 存好後 Esc 可以關
    const fs = await import('node:fs')
    const dlg = fs.readFileSync('src/components/ui/UDialog.vue', 'utf8')
    const rr = fs.readFileSync('src/components/ReferralReplyDialog.vue', 'utf8')
    ok(dlg.includes('defineExpose({ markSaved })') && /saved\.value = r\s*\n\s*dlg\.value\?\.markSaved\(\)/.test(rr), '轉診回覆單存好切到預覽後清掉「改過」狀態（Esc、× 可以直接關）')
  }

  // 手術排程與術前核對：規則、種子、申請、排程（權限、撞期、時段）、術前準備（不需要要原因、備血與抗生素要連這次住院的）、
  // 送手術室把關、三段查核順序（沒暫停確認不能開始）、計數不符要原因、出院把關、帳單、手術紀錄、首頁待辦
  console.log('\n[手術排程與術前核對]')
  {
    resetDb('small')
    const db = () => dbm.db
    const S = api.surgeryApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const userOf = (doctorId) => db().users.find((u) => u.doctorId === doctorId).username
    const tomorrow = addDaysT(1)

    // 規則
    ok(api.overlaps('2026-11-18 09:00', 120, '2026-11-18 10:30', 60) && !api.overlaps('2026-11-18 09:00', 90, '2026-11-18 10:30', 60), '同房時段：重疊的擋，接著排的可以')
    ok(api.prepMissing({ prep: { consent: {} } }).length === 4, '術前準備：還差幾項')
    const cp = api.countsProblem({ spongeBefore: 10, spongeAfter: 9, instrumentBefore: 30, instrumentAfter: 30 })
    ok(cp.mismatch.length === 1 && cp.mismatch[0].includes('紗布') && Object.keys(api.countsProblem({ spongeBefore: 10 }).fields).length === 3, '計數：紗布不符；沒填的一次標出')
    const ce = api.checkSurgeryInput({ requestedDate: addDaysT(-1), estMinutes: 5 }, T)
    ok(ce.procId && ce.side && ce.anesthesia && ce.requestedDate && ce.estMinutes && ce.diagnosis, '申請欄位一次標出（日期不能早於今天、時間 15–720 分）')
    ok(!(await api.masterApi.listProcedures({})).some((p) => p.surgery || p.anesthesiaFee), '開立選單沒有手術與麻醉費')

    // 種子
    const sg1 = db().surgeries.find((s) => s.id === 'SG-SEED-1')
    if (sg1) ok(sg1.status === 'scheduled' && sg1.schedule.room === 'OR1' && sg1.schedule.start === `${tomorrow} 09:00` && api.prepMissing(sg1).length === 3, '種子一：骨折明天 09:00 OR1，術前準備還差 3 項')
    const sg2 = db().surgeries.find((s) => s.id === 'SG-SEED-2')
    if (sg2) ok(sg2.status === 'scheduled' && !api.prepMissing(sg2).length && sg2.schedule.start > nowStr(), `種子二：闌尾炎 ${sg2.schedule.start} OR2，術前準備都好了`)
    ok(db().users.find((u) => u.username === 'nurse02').grants.includes('surgery.schedule'), '種子：nurse02 被指定手術排程')

    // 申請
    const adm = db().admissions.find((a) => a.status === 'admitted' && !a.deptTransfers?.some((x) => x.status === 'pending') && !db().surgeries.some((s) => s.admissionId === a.id))
    const doc = userOf(adm.doctorId)
    const input = { admissionId: adm.id, procId: 'P039', side: 'left', anesthesia: 'spinal', requestedDate: tomorrow, estMinutes: 60, diagnosis: '左側腹股溝疝氣' }
    await as('nurse01')
    await expectError(() => S.requestSurgery(input), '護理師不能申請手術')
    await as(userOf(db().doctors.find((d) => d.deptId !== adm.deptId).id))
    let msg = await errOf(() => S.requestSurgery(input))
    ok(msg.includes('醫師'), `別科不能申請：「${msg}」`)
    await as(doc)
    let f = await fieldsOf(() => S.requestSurgery({ ...input, procId: 'P003' }))
    ok(f.procId, '檢驗醫令不是術式')
    await expectError(() => api.ipdApi.addOrder({ admissionId: adm.id, type: 'stat', category: 'procedure', procId: 'P039', content: '' }), '術式不能當醫令開')
    const s1 = await S.requestSurgery(input)
    ok(s1.status === 'requested' && /^OR\d{11}$/.test(s1.no) && s1.prepMissing.length === 5, `申請 ${s1.no}：待排程，術前準備 5 項都還沒`)

    // 排程
    await as('clerk01')
    await expectError(() => S.scheduleSurgery(s1.id, { room: 'OR3', start: `${tomorrow} 09:00` }), '櫃台不能排程')
    await as('nurse01')
    const board = await S.orBoard(tomorrow)
    ok(board.canSchedule && board.requested.some((x) => x.id === s1.id), '護理師（預設有排程權限）看得到待排程')
    ok((await api.dashboardApi.getDashboard()).surgeryToSchedule >= 1, '首頁：手術待排程')
    f = await fieldsOf(() => S.scheduleSurgery(s1.id, { room: 'OR3', start: `${addDaysT(-1)} 09:00` }))
    ok(f.start?.includes('過去'), '不能排在過去')
    f = await fieldsOf(() => S.scheduleSurgery(s1.id, { room: 'OR3', start: `${tomorrow} 19:30` }))
    ok(f.start?.includes('20:00'), `超過開放時段：「${f.start}」`)
    if (sg1) {
      f = await fieldsOf(() => S.scheduleSurgery(s1.id, { room: 'OR1', start: `${tomorrow} 10:30` }))
      ok(f.start?.includes(sg1.no), `和種子一撞期：「${f.start}」`)
    }
    let v = await S.scheduleSurgery(s1.id, { room: 'OR3', start: `${tomorrow} 09:00` })
    ok(v.status === 'scheduled' && v.scheduleText === `OR3 ${tomorrow.slice(5)} 09:00–10:00`, `排程：${v.scheduleText}`)
    v = await S.scheduleSurgery(s1.id, { room: 'OR3', start: `${tomorrow} 10:00` })
    ok(v.schedule.start.endsWith('10:00') && db().auditLogs[0].action === '手術改期', '改期寫稽核')
    // 只交給手術室護理長
    await as('admin')
    await api.permissionApi.savePermissionRoles('surgery.schedule', { roles: [], reason: '只給手術室護理長', confirm: true })
    await as('nurse01')
    ok(!(await S.orBoard(tomorrow)).canSchedule && (await errOf(() => S.scheduleSurgery(s1.id, { room: 'OR3', start: `${tomorrow} 10:00` }))).includes('權限'), '取消角色後一般護理師不能排程')
    await as('nurse02')
    ok((await S.orBoard(tomorrow)).canSchedule, '被指定的 nurse02 可以')
    await as('admin')
    await api.permissionApi.savePermissionRoles('surgery.schedule', { roles: ['nurse'], reason: '恢復', confirm: true })

    // 術前準備
    await as('nurse01')
    msg = await errOf(() => S.sendToOr(s1.id))
    ok(msg.includes('術前準備還沒完成') && msg.includes('同意書'), `準備沒完成不能送：「${msg}」`)
    msg = await errOf(() => S.markPrep(s1.id, 'consent', { notNeeded: '急' }))
    ok(msg.includes('一定要有'), '同意書不能「不需要」')
    f = await fieldsOf(() => S.markPrep(s1.id, 'npo', { notNeeded: ' ' }))
    ok(f.notNeeded, '不需要要寫原因')
    f = await fieldsOf(() => S.markPrep(s1.id, 'blood', {}))
    ok(f.refId?.includes('備血單'), '備血要選備血單')
    const otherBlood = db().bloodRequests.find((r) => r.admissionId !== adm.id)
    if (otherBlood) {
      f = await fieldsOf(() => S.markPrep(s1.id, 'blood', { refId: otherBlood.id }))
      ok(f.refId?.includes('不是這次住院'), '別人的備血單不行')
    }
    const nonAbx = db().ipdOrders.find((o) => o.admissionId === adm.id && o.category === 'medication' && o.status === 'active' && !db().drugs.find((d) => d.id === o.drugId)?.indication.includes('抗生素') && !db().drugs.find((d) => d.id === o.drugId)?.restrictedAbx)
    if (nonAbx) {
      f = await fieldsOf(() => S.markPrep(s1.id, 'abx', { refId: nonAbx.id }))
      ok(f.refId?.includes('抗生素'), '不是抗生素的醫囑不行')
    }
    await S.markPrep(s1.id, 'consent')
    await S.markPrep(s1.id, 'npo')
    await S.markPrep(s1.id, 'siteMark')
    await S.markPrep(s1.id, 'blood', { notNeeded: '疝氣修補出血少' })
    v = await S.markPrep(s1.id, 'abx', { notNeeded: '乾淨手術不需預防性抗生素' })
    ok(!v.prepMissing.length && v.prepRows.find((r) => r.key === 'blood').text.startsWith('不需要'), '術前準備完成（備血、抗生素寫不需要的原因）')
    v = await S.unmarkPrep(s1.id, 'npo')
    ok(v.prepMissing.includes('禁食'), '可以取消勾選')
    await S.markPrep(s1.id, 'npo')
    // 檢查順序
    msg = await errOf(() => S.recordCheck(s1.id, 'signIn', api.CHECK_ITEMS.signIn.items))
    ok(msg.includes('送到手術室後'), '還沒送來不能查核')
    v = await S.sendToOr(s1.id)
    ok(v.status === 'sent', '送手術室')
    msg = await errOf(() => S.markPrep(s1.id, 'npo'))
    ok(msg.includes('已經送手術室'), '送了之後術前準備不能再改')
    await as(doc)
    msg = await errOf(() => S.cancelSurgery(s1.id, '不開了'))
    ok(msg.includes('送手術室'), '送了之後不能取消')
    // 出院把關
    db().admissions.find((a) => a.id === adm.id).dischargeSummary = { ...(db().admissions.find((a) => a.id === adm.id).dischargeSummary ?? {}), signedAt: nowStr(), dischargeType: '改善出院' }
    await as('nurse01')
    msg = await errOf(() => api.admissionApi.discharge(adm.id))
    ok(msg.includes('手術室'), `在手術室不能出院：「${msg}」`)
    delete db().admissions.find((a) => a.id === adm.id).dischargeSummary.signedAt

    msg = await errOf(() => S.recordCheck(s1.id, 'timeOut', api.CHECK_ITEMS.timeOut.items))
    ok(msg.includes('麻醉前'), '先麻醉前查核')
    f = await fieldsOf(() => S.recordCheck(s1.id, 'signIn', api.CHECK_ITEMS.signIn.items.slice(1)))
    ok(f.items?.includes('1 項'), `少勾一項：「${f.items}」`)
    await S.recordCheck(s1.id, 'signIn', api.CHECK_ITEMS.signIn.items)
    msg = await errOf(() => S.startSurgery(s1.id))
    ok(msg.includes('暫停確認'), `沒做劃刀前暫停確認不能開始：「${msg}」`)
    await S.recordCheck(s1.id, 'timeOut', api.CHECK_ITEMS.timeOut.items)
    v = await S.startSurgery(s1.id)
    ok(v.status === 'in-progress' && v.startAt, '開始手術')
    const counts = { spongeBefore: 20, spongeAfter: 19, instrumentBefore: 35, instrumentAfter: 35 }
    f = await fieldsOf(() => S.finishSurgery(s1.id, { items: api.CHECK_ITEMS.signOut.items.slice(2), ...counts }))
    ok(f.items && f.mismatchReason?.includes('紗布'), '離開前：項目沒勾完、紗布不符沒寫原因，一次標出')
    v = await S.finishSurgery(s1.id, { items: api.CHECK_ITEMS.signOut.items, ...counts, mismatchReason: '已照 X 光確認無遺留，已告知主刀' })
    ok(v.status === 'done' && v.countMismatch && v.counts.mismatchReason.includes('紗布 術前 20、術後 19'), '完成：計數不符留紀錄（主刀看得到）')

    // 帳單
    await as('clerk01')
    const bill = (await api.ipdChargeApi.getIpdBill(adm.id)).bill
    ok(bill.lines.some((l) => l.name.startsWith('腹股溝疝氣修補術')) && bill.lines.some((l) => l.name.startsWith('脊髓麻醉費')), '住院帳單：術式＋麻醉費（依麻醉方式）')

    // 手術紀錄
    await as('nurse01')
    await expectError(() => S.writeOpRecord(s1.id, { performed: 'x', findings: 'x', bloodLoss: 10, complications: '', specimen: '' }), '護理師不能寫手術紀錄')
    await as(doc)
    ok((await api.dashboardApi.getDashboard()).opRecordsDue >= 1, '主刀首頁：手術紀錄待寫')
    f = await fieldsOf(() => S.writeOpRecord(s1.id, { performed: '', findings: '', bloodLoss: -1, complications: '', specimen: '' }))
    ok(f.performed && f.findings && f.bloodLoss, '手術紀錄欄位一次標出')
    v = await S.writeOpRecord(s1.id, { performed: '左側腹股溝疝氣修補術（無張力補片）', findings: '間接型疝氣，疝囊約 3 cm', bloodLoss: 20, complications: '', specimen: '' })
    ok(v.record.complications === '無' && (await api.dashboardApi.getDashboard()).opRecordsDue === 0, '寫好後不再提醒')
    msg = await errOf(() => S.writeOpRecord(s1.id, { performed: 'x', findings: 'x', bloodLoss: 0, complications: '', specimen: '' }))
    ok(msg.includes('寫過'), '只寫一次')

    // 取消、出院自動取消
    const s2 = await S.requestSurgery({ ...input, procId: 'P040', side: 'na', anesthesia: 'local', diagnosis: '傷口感染', estMinutes: 45 })
    f = await fieldsOf(() => S.cancelSurgery(s2.id, ' '))
    ok(f.reason, '取消要原因')
    ok((await S.cancelSurgery(s2.id, '改保守治療')).status === 'cancelled', '進手術室前可以取消')
    if (sg1) {
      await as('nurse01')
      ok((await api.dashboardApi.getDashboard()).surgeryPrepDue >= 1, '首頁：明天要開、術前準備沒完成')
    }
    // 頁面不自己判斷
    const fs = await import('node:fs')
    const ui = ['src/components/surgery/SurgeryPanel.vue', 'src/pages/or/OrPage.vue'].map((p) => fs.readFileSync(p, 'utf8')).join('\n')
    ok(!/overlaps\(|countsProblem\(|prepMissing\(/.test(ui), '頁面不自己判斷撞期、計數、準備（服務層算好）')
  }

  // 急診：檢傷規則（主訴、生命徵象、不能比建議輕、調升要原因）、急診診次、依級數叫號、重新檢傷、去向（離院、收住院待床、轉院）、
  // 費用（急診診察費、急診部分負擔依級數、觀察床費）、收費設定、首頁待辦
  console.log('\n[急診]')
  {
    resetDb('small')
    const db = () => dbm.db
    const E = api.erApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const { addMinutes } = dateUtil
    const N = { temp: 36.8, pulse: 80, resp: 16, sbp: 120, dbp: 75, spo2: 98 }

    // 規則
    ok(api.vitalsLevel({ ...N, spo2: 85 }).level === 2 && api.vitalsLevel({ ...N, sbp: 65 }).level === 1 && api.vitalsLevel({ ...N, temp: 39.2 }).level === 3 && api.vitalsLevel(N).level === 5, '生命徵象判級：血氧 85 → 2 級、收縮壓 65 → 1 級、發燒 39.2 → 3 級、正常 → 5 級')
    ok(api.suggestLevel('胸痛', N).level === 2 && api.suggestLevel('喉嚨痛、咳嗽', { ...N, spo2: 88 }).level === 2 && api.suggestLevel('自己寫的主訴', N).level === 3, '建議級數：主訴與生命徵象取嚴重的；清單外的主訴預設 3 級')
    let e = api.checkTriageInput({ complaint: '胸痛', vitals: N, level: 3 })
    ok(e.level?.includes('不能比建議輕'), `不能比建議輕：「${e.level}」`)
    e = api.checkTriageInput({ complaint: '腹痛', vitals: N, level: 2 })
    ok(e.reason && !e.level, '比建議嚴重（調升）要寫原因')
    e = api.checkTriageInput({ complaint: '腹痛', vitals: {}, level: 3 })
    ok(e.pulse && e.sbp && e.spo2 && !Object.keys(api.checkTriageInput({ complaint: '心跳或呼吸停止', vitals: {}, level: 1 })).length, '脈搏、血壓、血氧必填（1 級急救中可以先不填）')
    ok(api.waitState(2, '2026-11-17 10:00', undefined, '2026-11-17 10:11').overdue && !api.waitState(3, '2026-11-17 10:00', '2026-11-17 10:20', '2026-11-17 12:00').overdue, '等候：2 級超過 10 分鐘逾時；叫號後就停止計算')
    ok(api.erObsBlocks('2026-11-17 08:00', '2026-11-17 13:59') === 0 && api.erObsBlocks('2026-11-17 08:00', '2026-11-17 14:00') === 1 && api.erObsBlocks('2026-11-17 08:00', '2026-11-17 21:30') === 2, '觀察床費：滿 6 小時一單位')
    ok(!api.isNoShow({ status: 'registered', date: addDaysT(-1), er: {} }, T) && api.isNoShow({ status: 'registered', date: addDaysT(-1) }, T), '急診沒等到看診不算預約未到')

    // 種子
    const seeded = db().visits.filter((v) => v.er && v.date === T)
    ok(seeded.length === 4 && seeded.every((v) => v.sessionId === `ER-${T}` && v.caseType === 'E1' && v.checkedInAt) && db().sessions.find((s) => s.id === `ER-${T}`)?.period === 'ER', '種子：今天急診 4 位候診（急診診次、案件 E1、已報到）')
    ok(!(await api.scheduleApi.listSessions({ date: T })).some((s) => s.period === 'ER'), '掛號頁的診次清單沒有急診')
    await as('nurse01')
    let d = await api.dashboardApi.getDashboard()
    ok(d.erWaiting >= 4 && d.erOverdue >= 1, `首頁：急診待看診 ${d.erWaiting}（逾時 ${d.erOverdue}）`)
    let board = await E.erBoard()
    const waiting = board.items.filter((i) => i.stage === 'waiting')
    ok(board.canTriage && !board.canDispose && waiting.every((x, i, a) => i === 0 || a[i - 1].level <= x.level), '看板：待看診依級數排')

    // 檢傷掛號
    const busy = new Set([...db().visits.filter((v) => v.date === T).map((v) => v.patientId), ...db().admissions.filter((a) => ['admitted', 'reserved'].includes(a.status)).map((a) => a.patientId)])
    // 健保一般身分（榮民等免部分負擔的不收急診部分負擔，另外測）
    // 種子剩下的空閒病人不夠時自己建（不依賴種子剛好剩幾位）
    const [p1, p2, p3] = await topUpPatients(db().patients.filter((p) => !busy.has(p.id) && !p.deceasedAt && p.defaultIdentity === '01'), 3, 'nurse01')
    await as('clerk01')
    await expectError(() => E.triageAndRegister({ patientId: p1.id, complaint: '胸痛', vitals: N, level: 2 }), '櫃台不能檢傷')
    await as('nurse01')
    const inpt = db().admissions.find((a) => a.status === 'admitted')
    let msg = await errOf(() => E.triageAndRegister({ patientId: inpt.patientId, complaint: '腹痛', vitals: N, level: 3 }))
    ok(msg.includes('住院中'), '住院中的病人不能掛急診')
    let f = await fieldsOf(() => E.triageAndRegister({ patientId: p1.id, complaint: '胸痛', vitals: N, level: 4 }))
    ok(f.level?.includes('不能比建議輕'), '服務層：不能比建議輕')
    const v1 = await E.triageAndRegister({ patientId: p1.id, complaint: '呼吸困難', vitals: { ...N, spo2: 86, pulse: 126 }, level: 1, reason: '冒冷汗、意識變差' })
    ok(v1.er.level === 1 && v1.er.suggested === 2 && v1.er.reason && v1.caseType === 'E1' && v1.checkedInAt && v1.period === 'ER', '檢傷掛號：建議 2 級、調升 1 級（有原因），急診案件、已報到')
    msg = await errOf(() => E.triageAndRegister({ patientId: p1.id, complaint: '胸痛', vitals: N, level: 2 }))
    ok(msg.includes('已經在急診'), '同一位病人在急診中不能重複掛')
    const v2 = await E.triageAndRegister({ patientId: p2.id, complaint: '外傷：撕裂傷', vitals: N, level: 4 })
    const v3 = await E.triageAndRegister({ patientId: p3.id, complaint: '腹痛', vitals: { ...N, temp: 38.2 }, level: 3 })

    // 重新檢傷
    await as('dr12')
    await expectError(() => E.retriage(v2.id, { level: 3, reason: '出血變多' }), '醫師不能重新檢傷（護理師做）')
    await as('nurse01')
    f = await fieldsOf(() => E.retriage(v2.id, { level: 4, reason: '' }))
    ok(f.level, '級數沒變擋')
    const r2 = await E.retriage(v2.id, { level: 3, reason: '傷口持續出血' })
    ok(r2.level === 3 && r2.history.length === 1 && r2.history[0].level === 4, '重新檢傷 4 → 3 級，舊的留在紀錄')

    // 醫師：依級數叫號
    await as('dr12')
    const q = await api.opdApi.listQueue({ date: T, doctorId: 'DR12' })
    const next = api.nextInQueue(q)
    ok(next.id === v1.id && q.every((x, i, a) => i === 0 || !x.er || !a[i - 1].er || a[i - 1].er.level <= x.er.level), '門診看診的急診診次：依級數排，「下一位」是 1 級')
    msg = await errOf(() => E.setDisposition(v1.id, { kind: 'home' }))
    ok(msg.includes('先完成看診'), '還沒看完不能決定去向')
    const see = async (v, dx = { icd: 'I25.10', name: '冠狀動脈粥狀硬化心臟病', primary: true }) => {
      const enc = await api.opdApi.startConsult(v.id, { allowParallel: true, allowNotCheckedIn: true })
      await api.opdApi.completeEncounter(enc.id, { subjective: v.er.complaint, objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [dx], medications: [], procedures: [], refillTimes: 0, admissionRequested: false })
    }
    await see(v1)
    board = await E.erBoard()
    ok(board.canDispose && board.items.find((i) => i.visitId === v1.id).stage === 'deciding' && (await api.dashboardApi.getDashboard()).erDeciding >= 1, '看完：待決定去向（急診醫師首頁）')
    await as('dr01')
    msg = await errOf(() => E.setDisposition(v1.id, { kind: 'home' }))
    ok(msg.includes('急診醫師'), '非急診醫師不能決定去向')
    await as('dr12')
    // 收住院
    f = await fieldsOf(() => E.setDisposition(v1.id, { kind: 'admit' }))
    ok(f.deptId && f.doctorId && f.diagnosis, '收住院：科別、主治、入院診斷一次標出')
    const med = db().departments.find((x) => x.code === 'MED')
    const medDoc = db().doctors.find((x) => x.deptId === med.id)
    f = await fieldsOf(() => E.setDisposition(v1.id, { kind: 'admit', deptId: med.id, doctorId: 'DR04', diagnosis: '急性冠心症' }))
    ok(f.doctorId?.includes('不是'), '主治要是那一科的醫師')
    let it = await E.setDisposition(v1.id, { kind: 'admit', deptId: med.id, doctorId: medDoc.id, diagnosis: '急性冠心症' })
    const adm = db().admissions.find((a) => a.id === it.admissionId)
    ok(it.stage === 'bed' && adm.status === 'reserved' && adm.fromVisitId === v1.id && adm.expectedDate === T, `收住院：建住院預約（今天、來自急診），看板「待床」`)
    msg = await errOf(() => E.setDisposition(v1.id, { kind: 'home' }))
    ok(msg.includes('已經決定'), '去向只決定一次')
    await as('clerk01')
    const res = await api.admissionApi.listAdmissions({ status: ['reserved'] })
    ok(res.find((a) => a.id === adm.id).fromEr && (await api.dashboardApi.getDashboard()).erBed >= 1, '住院中心：標「急診」、首頁急診待床')
    const bed = db().beds.find((b) => b.status === 'empty' && db().admissions.every((a) => a.bedId !== b.id))
    await api.admissionApi.checkIn(adm.id, bed.id)
    ok((await E.erBoard()).items.find((i) => i.visitId === v1.id).stage === 'admitted', '報到後：看板「已住院」')

    // 費用：急診診察費、急診部分負擔依級數、觀察床費
    await as('clerk01')
    let pv = await api.chargeApi.previewCharge(v1.id)
    const nm = (k) => pv.lines.filter((l) => l.name.startsWith(k))
    const s0 = db().billingSettings
    ok(nm('急診診察費').length === 1 && !nm('一般門診診察費').length && nm('急診部分負擔（檢傷 1 級）')[0]?.amount === s0.erCopayUrgent && !nm('門診基本部分負擔').length, `批價：急診診察費、急診部分負擔 1 級 ${s0.erCopayUrgent} 元（不收門診基本部分負擔）`)
    await as('dr12')
    await see(v3, { icd: 'K29.70', name: '胃炎', primary: true })
    db().visits.find((v) => v.id === v3.id).er.arrivedAt = addMinutes(nowStr(), -7 * 60)
    await E.setDisposition(v3.id, { kind: 'home', note: '症狀緩解' })
    await as('clerk01')
    pv = await api.chargeApi.previewCharge(v3.id)
    ok(pv.lines.find((l) => l.name.startsWith('急診部分負擔')).amount === s0.erCopay && pv.lines.find((l) => l.name.startsWith('急診觀察床費'))?.qty === 1, `3 級收 ${s0.erCopay} 元；在急診 7 小時收 1 單位觀察床費`)
    await api.chargeApi.pay(v3.id, { payMethod: 'card' })
    ok((await E.erBoard()).items.find((i) => i.visitId === v3.id).stage === 'left', '離院批價後：已離院')

    // 轉院
    await as('dr12')
    await see(v2, { icd: 'J06.9', name: '急性上呼吸道感染', primary: true })
    f = await fieldsOf(() => E.setDisposition(v2.id, { kind: 'transfer' }))
    ok(f.hospital, '轉院要寫醫院')
    it = await E.setDisposition(v2.id, { kind: 'transfer', hospital: '區域醫學中心', note: '需整形外科處理' })
    ok(it.stage === 'billing' && it.dispositionText.includes('區域醫學中心'), '轉院：待批價')

    // 收費設定
    await as('admin')
    f = await fieldsOf(() => api.adminApi.saveBillingSettings({ ...api.pickCopay(db().billingSettings), erCopayUrgent: 900, erCopay: 300 }))
    ok(f.erCopayUrgent, '急診部分負擔：1、2 級不能比 3–5 級高')
    db().billingSettings.ipdInterim = { days: 9, amount: 30000 }
    const old = api.pickCopay(db().billingSettings)
    delete old.erCopay
    delete old.erCopayUrgent
    await api.adminApi.saveBillingSettings({ ...old, basicCopay: old.basicCopay })
    ok(db().billingSettings.ipdInterim?.days === 9 && db().billingSettings.erCopay === s0.erCopay, '存門診部分負擔：期中繳款提醒設定沒被洗掉；沒送的急診欄位沿用原值')
  }

  // 急診留觀：留觀＝特別的住院（急診留觀區 OB1–OB6、護理師排床、住院號與腕帶、沿用住院醫囑與護理）；結束時離院（批價含留觀期間的藥與檢驗）、
  // 收住院（同一筆轉一般住院，不重新報到；急診費用併入住院帳單「急診」段）、轉院；超過 24 小時標紅、48 小時首頁待辦
  console.log('\n[急診留觀]')
  {
    resetDb('small')
    const db = () => dbm.db
    const E = api.erApi
    const A = api.admissionApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const N = { temp: 36.8, pulse: 80, resp: 16, sbp: 120, dbp: 75, spo2: 98 }
    const OBS = '急診留觀區'

    // 規則
    ok(api.obsHours('2026-11-16 08:00', '2026-11-17 08:59') === 24 && api.erBillMode({ disposition: { kind: 'obs' } }) === 'obs-open' && api.erBillMode({ disposition: { kind: 'obs' }, obsEnd: { kind: 'admit' } }) === 'ipd' && api.erBillMode({ disposition: { kind: 'obs' }, obsEnd: { kind: 'home' } }) === 'opd' && api.erBillMode({ disposition: { kind: 'admit' } }) === 'ipd', '規則：留觀時數；留觀中不能結、收住院併入住院帳單、離院轉院在批價結')
    ok(api.erStage('consulted', { disposition: { kind: 'obs' } }, { status: 'reserved' }) === 'obs-bed' && api.erStage('consulted', { disposition: { kind: 'obs' } }, { status: 'admitted' }) === 'obs' && api.erStage('consulted', { disposition: { kind: 'obs' }, obsEnd: { kind: 'admit' } }, { status: 'admitted', inObsBed: true }) === 'bed', '看板階段：待排留觀床 → 留觀中 → 收住院還在留觀床＝待床')

    // 種子
    await as('nurse01')
    let board = await E.erBoard()
    const so = board.items.find((i) => i.visitId === 'V-ER-OBS')
    ok(so?.stage === 'obs' && so.obs.bedNo === 'OB1' && so.obs.long && !so.obs.overdue && board.obsBeds.length === 6 && board.obsBeds[0].patientName, `種子：留觀 OB1 ${so?.obs?.hours} 小時（超過 24 小時標紅、還沒到 48 小時）；留觀區 6 床`)
    ok((await api.nursingApi.listWardPatients(OBS)).some((p) => p.id === 'A-ER-OBS'), '護理站選「急診留觀區」照住院流程照顧留觀病人')
    let dash = await api.dashboardApi.getDashboard()
    const totalBeds = db().beds.filter((b) => b.ward !== OBS).length
    ok(dash.ipd.totalBeds === totalBeds && dash.ipd.admitted === db().admissions.filter((a) => a.status === 'admitted' && !a.obs).length, '首頁病床數、住院人數不含留觀')

    // 決定留觀 → 排床
    const busy = new Set([...db().visits.filter((v) => v.date === T || (v.er && v.status !== 'cancelled')).map((v) => v.patientId), ...db().admissions.filter((a) => ['admitted', 'reserved'].includes(a.status)).map((a) => a.patientId)])
    const [p1, p2] = await topUpPatients(db().patients.filter((p) => !p.deceasedAt && !busy.has(p.id) && p.defaultIdentity === '01' && !p.allergies.length), 2, 'nurse01')
    const v1 = await E.triageAndRegister({ patientId: p1.id, complaint: '腹痛', vitals: N, level: 3 })
    const v2 = await E.triageAndRegister({ patientId: p2.id, complaint: '頭暈', vitals: N, level: 3 })
    await as('dr12')
    const see = async (v) => {
      const enc = await api.opdApi.startConsult(v.id, { allowParallel: true, allowNotCheckedIn: true })
      await api.opdApi.completeEncounter(enc.id, { subjective: v.er.complaint, objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'R10.9', name: '腹痛', primary: true }], medications: [], procedures: [], refillTimes: 0, admissionRequested: false })
    }
    await see(v1)
    await see(v2)
    let it = await E.setDisposition(v1.id, { kind: 'obs', note: '觀察腹痛' })
    const o1 = db().admissions.find((a) => a.id === it.admissionId)
    ok(it.stage === 'obs-bed' && o1.obs?.visitId === v1.id && o1.status === 'reserved' && o1.doctorId === 'DR12' && o1.diagnosis === '腹痛' && o1.fromVisitId === v1.id, '決定留觀：建留觀住院（急診科、這位急診醫師、診斷帶主診斷），看板「待排留觀床」')
    await E.setDisposition(v2.id, { kind: 'obs' })
    await as('clerk01')
    ok(!(await A.listAdmissions({ status: ['reserved'] })).some((a) => a.obs), '住院中心待報到不列留觀')
    let msg = await errOf(() => A.checkIn(o1.id, db().beds.find((b) => b.ward !== OBS && b.status === 'empty').id))
    ok(msg.includes('急診'), `住院中心不能幫留觀報到 → 「${msg}」`)
    msg = await errOf(() => api.chargeApi.pay(v1.id, { payMethod: 'card' }))
    ok(msg.includes('留觀中') && !(await api.chargeApi.listChargeQueue(T)).some((x) => x.id === v1.id), `留觀中不能批價、批價清單不列 → 「${msg}」`)
    const normal = db().admissions.find((a) => a.status === 'reserved' && !a.obs)
    msg = await errOf(() => A.checkIn(normal.id, 'BOB3'))
    ok(msg.includes('只給急診留觀病人'), `一般住院不能排留觀床 → 「${msg}」`)
    await as('nurse01')
    ok((await api.dashboardApi.getDashboard()).erObsBed >= 2, '護理師首頁：急診待排留觀床')
    msg = await errOf(() => E.assignObsBed(o1.id, db().beds.find((b) => b.ward !== OBS && b.status === 'empty').id))
    ok(msg.includes('不是急診留觀床'), '留觀只能排留觀床')
    msg = await errOf(() => E.assignObsBed(o1.id, 'BOB1'))
    ok(msg.includes('無法使用'), '有人的留觀床不能排')
    const a1 = await E.assignObsBed(o1.id, 'BOB2')
    ok(a1.status === 'admitted' && a1.admitNo && a1.bed.bedNo === 'OB2' && a1.obsStage === 'open' && (await E.erBoard()).items.find((i) => i.visitId === v1.id).stage === 'obs', `排 OB2：住院號 ${a1.admitNo}、看板「留觀中」`)
    await E.assignObsBed(db().admissions.find((a) => a.obs?.visitId === v2.id).id, 'BOB3')

    // 留觀中：沿用住院醫囑（急診醫師開、護理師執行）；不能寫出院病摘、不能辦出院
    await as('dr12')
    const io = await api.ipdApi.addOrder({ admissionId: o1.id, type: 'stat', category: 'procedure', procId: 'P003', content: '' })
    msg = await errOf(() => api.ipdApi.saveDischargeSummary(o1.id, { diagnosis: 'x', course: 'x', condition: 'x', followUp: 'x', dischargeType: '治癒出院' }, false))
    ok(msg.includes('急診留觀'), `留觀不寫出院病摘 → 「${msg}」`)
    await as('nurse01')
    await api.nursingApi.completeStatOrder(io.id)
    msg = await errOf(() => A.discharge(o1.id))
    ok(msg.includes('結束留觀'), `留觀不能辦出院 → 「${msg}」`)

    // 結束留觀：離院 → 批價含留觀期間的檢驗、觀察床費
    await as('dr01')
    msg = await errOf(() => E.endObservation(o1.id, { kind: 'home' }))
    ok(msg.includes('急診醫師'), '結束留觀限急診醫師')
    await as('dr12')
    db().visits.find((v) => v.id === v1.id).er.arrivedAt = dateUtil.addMinutes(nowStr(), -13 * 60)
    it = await E.endObservation(o1.id, { kind: 'home', note: '腹痛緩解' })
    const o1b = db().admissions.find((a) => a.id === o1.id)
    ok(it.stage === 'billing' && o1b.status === 'discharged' && o1b.obs.outcome === 'home' && db().beds.find((b) => b.id === 'BOB2').status === 'cleaning' && it.obs.endText.includes('離院'), `離院：留觀住院結束、OB2 清潔中、看板「待批價」（${it.obs.endText}）`)
    msg = await errOf(() => E.endObservation(o1.id, { kind: 'home' }))
    ok(msg.includes('已經結束'), '只能結束一次')
    await as('clerk01')
    ok((await api.chargeApi.listChargeQueue(T)).some((x) => x.id === v1.id), '結束留觀後出現在批價清單')
    const pv = await api.chargeApi.previewCharge(v1.id)
    ok(pv.lines.some((l) => l.name === '全套血液檢查 CBC（留觀）' || l.name.includes('（留觀）')) && pv.lines.find((l) => l.name.startsWith('急診觀察床費'))?.qty === 2 && pv.lines.some((l) => l.name.startsWith('急診部分負擔')), '批價：急診診察費、急診部分負擔＋留觀期間的檢驗（標留觀）、在急診 13 小時收 2 單位觀察床費')
    await api.chargeApi.pay(v1.id, { payMethod: 'card' })
    ok((await E.erBoard()).items.find((i) => i.visitId === v1.id).stage === 'left', '批價後：已離院')
    await as('nurse01')
    await E.cleanObsBed('BOB2')
    ok(db().beds.find((b) => b.id === 'BOB2').status === 'empty', '護理師在急診看板按留觀床清潔完成')

    // 結束留觀：收住院（一併轉床）→ 同一筆住院、住院號不變；急診費用併入住院帳單
    const o2 = db().admissions.find((a) => a.obs?.visitId === v2.id)
    const admitNo2 = o2.admitNo
    const med = db().departments.find((x) => x.code === 'MED')
    const medDoc = db().doctors.find((x) => x.deptId === med.id)
    const wardBed = db().beds.find((b) => b.ward !== OBS && b.status === 'empty' && b.bedClass === '健保床')
    await as('dr12')
    const blocks = await A.bedBlocks(o2.id)
    const after = await A.bedBlocks(o2.id, { afterObs: true })
    ok(blocks[wardBed.id]?.includes('留觀') && !after[wardBed.id], '選床：留觀中標病房的床不能排；結束留觀收住院時可以選')
    it = await E.endObservation(o2.id, { kind: 'admit', deptId: med.id, doctorId: medDoc.id, diagnosis: '眩暈待查', bedId: wardBed.id })
    const o2b = db().admissions.find((a) => a.id === o2.id)
    ok(it.stage === 'admitted' && o2b.status === 'admitted' && o2b.admitNo === admitNo2 && o2b.deptId === med.id && o2b.doctorId === medDoc.id && o2b.bedId === wardBed.id && o2b.attendingHistory?.at(-1)?.reason === '急診留觀收住院' && db().beds.find((b) => b.id === 'BOB3').status === 'cleaning', `收住院：同一筆住院（住院號 ${admitNo2} 不變）、改科別主治、轉到 ${wardBed.bedNo}、OB3 清潔中`)
    await as('clerk01')
    msg = await errOf(() => api.chargeApi.pay(v2.id, { payMethod: 'card' }))
    ok(msg.includes('住院帳單') && !(await api.chargeApi.listChargeQueue(T)).some((x) => x.id === v2.id), `收住院：急診不在批價結 → 「${msg}」`)
    const bill = (await api.ipdChargeApi.getIpdBill(o2.id)).bill
    ok(bill.lines.some((l) => l.name === '急診：急診診察費') && bill.lines.some((l) => l.name.startsWith('急診：掛號費')) && !bill.lines.some((l) => l.name.includes('急診部分負擔')) && bill.meta.from === o2b.obs.endAt.slice(0, 10), '住院帳單：急診一段（急診診察費、掛號費；不收急診部分負擔），住院從結束留觀那天起算')
    ok((await api.ipdChargeApi.listIpdBilling()).some((x) => x.admissionId === o2.id) && !(await api.ipdChargeApi.listIpdBilling()).some((x) => x.admissionId === o1.id), '住院結帳清單：留觀轉住院的列、留觀離院的不列')

    // 直接收住院的急診也併入住院帳單
    await as('nurse01')
    const busy2 = new Set([...db().visits.filter((v) => v.date === T || v.er).map((v) => v.patientId), ...db().admissions.filter((a) => ['admitted', 'reserved'].includes(a.status)).map((a) => a.patientId)])
    const [p3] = await topUpPatients(db().patients.filter((p) => !p.deceasedAt && !busy2.has(p.id) && p.defaultIdentity === '01').slice(0, 1), 1, 'nurse01')
    const v3 = await E.triageAndRegister({ patientId: p3.id, complaint: '胸痛', vitals: N, level: 2 })
    await as('dr12')
    await see(v3)
    it = await E.setDisposition(v3.id, { kind: 'admit', deptId: med.id, doctorId: medDoc.id, diagnosis: '胸痛待查' })
    await as('clerk01')
    await A.checkIn(it.admissionId, db().beds.find((b) => b.ward !== OBS && b.status === 'empty').id)
    msg = await errOf(() => api.chargeApi.pay(v3.id, { payMethod: 'card' }))
    const bill3 = (await api.ipdChargeApi.getIpdBill(it.admissionId)).bill
    ok(msg.includes('住院帳單') && bill3.lines.some((l) => l.name === '急診：急診診察費'), '直接收住院：急診費用一樣併入住院帳單')

    // 種子那位：收住院不選床 → 留在留觀床「待床」→ 住院中心轉床
    await as('dr12')
    db().visits.find((v) => v.id === 'V-ER-OBS').er.disposition.at = dateUtil.addMinutes(nowStr(), -49 * 60)
    ok((await api.dashboardApi.getDashboard()).erObsOverdue >= 1 && (await E.erBoard()).items.find((i) => i.visitId === 'V-ER-OBS').obs.overdue, '留觀超過 48 小時：急診醫師首頁待辦')
    const surg = db().departments.find((x) => x.code === 'SUR')
    const surgDoc = db().doctors.find((x) => x.deptId === surg.id)
    it = await E.endObservation('A-ER-OBS', { kind: 'admit', deptId: surg.id, doctorId: surgDoc.id, diagnosis: '急性闌尾炎' })
    ok(it.stage === 'bed' && db().admissions.find((a) => a.id === 'A-ER-OBS').bedId === 'BOB1' && (await api.dashboardApi.getDashboard()).erBed >= 1, '收住院沒選床：留在 OB1，看板「待床」')
    await as('clerk01')
    const av = await A.getAdmission('A-ER-OBS')
    ok(av.obsStage === 'waiting-bed', '住院中心：標留觀收住院待轉床')
    await A.transferBed('A-ER-OBS', db().beds.find((b) => b.ward !== OBS && b.status === 'empty').id)
    ok((await E.erBoard()).items.find((i) => i.visitId === 'V-ER-OBS')?.stage === 'admitted' || !(await E.erBoard()).items.some((i) => i.visitId === 'V-ER-OBS' && i.stage !== 'admitted'), '轉到病房後：已住院')
  }

  // 疼痛與管路：疼痛 ≥4 要處置、1 小時重評（逾時列本班待辦與首頁）、每班要評；管路登錄、每天還需要嗎、滿 7 天提醒主治、
  // 留置針滿 96 小時、移除要原因、出院自動移除、病房管路日
  console.log('\n[疼痛與管路]')
  {
    resetDb('small')
    const db = () => dbm.db
    const L = api.lineApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.painActionProblem(4, '') && !api.painActionProblem(3, '') && !api.painActionProblem(6, '給止痛藥'), '疼痛 ≥4 要寫處置')
    let ps = api.painState([{ at: '2026-11-17 08:00', pain: 6 }], '2026-11-17 09:01', '2026-11-17 08:00')
    ok(ps.reassess?.status === 'overdue' && ps.reassess.dueAt === '2026-11-17 09:00' && ps.thisShift, '≥4 一小時後沒重評：逾時')
    ps = api.painState([{ at: '2026-11-17 08:00', pain: 6 }, { at: '2026-11-17 08:50', pain: 5 }], '2026-11-17 09:01', '2026-11-17 08:00')
    ok(ps.reassess?.status === 'upcoming' && ps.last.score === 5, '重評還是 ≥4：再等下一次重評（從這次起算）')
    ps = api.painState([{ at: '2026-11-17 07:00', pain: 2 }], '2026-11-17 09:00', '2026-11-17 08:00')
    ok(!ps.reassess && !ps.thisShift, '上一班評的：本班還沒評')
    let s = api.lineState({ kind: 'foley', insertedAt: '2026-11-10 08:00', needChecks: [{ date: '2026-11-16', needed: true }] }, '2026-11-17 09:00')
    ok(s.attendingAlert && s.needCheckDue && s.day === 8, '導尿管滿 7 天提醒主治、今天還沒評估')
    s = api.lineState({ kind: 'pivc', insertedAt: '2026-11-13 08:00' }, '2026-11-17 08:00')
    ok(s.replaceDue && !s.needCheckDue && !s.attendingAlert, '留置針滿 96 小時提醒更換，不用每天評估')
    ok(api.lineDays({ insertedAt: '2026-11-10 08:00', removedAt: '2026-11-12 10:00' }, '2026-11-11', '2026-11-30') === 2 && api.lineDays({ insertedAt: '2026-11-15 08:00' }, '2026-11-01', '2026-11-17') === 3, '管路日：放置、移除當天都算；只算期間內')

    // 種子
    await as('nurse01')
    const frac = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('S52'))
    const stroke = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    const ward = (a) => db().beds.find((b) => b.id === a.bedId).ward
    if (frac && db().vitals.some((v) => v.id === 'VS-PAIN-SEED')) {
      const wp = (await api.nursingApi.listWardPatients(ward(frac))).find((p) => p.id === frac.id)
      const tk = (await api.nursingApi.listWardTasks(ward(frac))).find((t) => t.kind === 'pain' && t.admissionId === frac.id)
      ok(wp.painReassess === 'overdue' && wp.painScore === 6 && tk?.urgency === 'overdue', '種子：骨折疼痛 6 分處置後 75 分鐘沒重評 → 清單標「疼痛重評逾時」、本班待辦逾時')
      ok((await api.dashboardApi.getDashboard()).painReassessOverdue >= 1, '護理師首頁：疼痛重評逾時')
    }
    if (stroke) {
      const wp = (await api.nursingApi.listWardPatients(ward(stroke))).find((p) => p.id === stroke.id)
      ok(wp.lines.includes('Foley') && wp.lines.includes('NG') && wp.lineTodo >= 1, `種子：腦梗塞有導尿管、鼻胃管，今天還沒評估（清單 ${wp.lines.join(' ')}）`)
      await as(db().users.find((u) => u.doctorId === stroke.doctorId).username)
      ok((await api.dashboardApi.getDashboard()).lineAttending >= 1, '主治首頁：管路滿 7 天')
      await as('nurse01')
    }

    // 疼痛：生命徵象 ≥4 沒寫處置擋；寫了之後重評
    const a = db().admissions.find((x) => x.status === 'admitted' && !x.obs && x.id !== frac?.id)
    let f = await fieldsOf(() => api.nursingApi.addVitals({ admissionId: a.id, pain: 5 }))
    ok(f.painAction?.includes('處置'), `疼痛 5 分沒寫處置 → 「${f.painAction}」`)
    const v = await api.nursingApi.addVitals({ admissionId: a.id, pain: 5, painAction: '依醫囑給予止痛藥' })
    ok(v.painAction === '依醫囑給予止痛藥', '記下處置')
    let tk = (await api.nursingApi.listWardTasks(ward(a))).find((t) => t.kind === 'pain' && t.admissionId === a.id)
    ok(tk?.urgency === 'upcoming', '1 小時內：本班待辦「稍後」重評')
    await api.nursingApi.addVitals({ admissionId: a.id, pain: 2 })
    tk = (await api.nursingApi.listWardTasks(ward(a))).find((t) => t.kind === 'pain' && t.admissionId === a.id)
    ok(!tk, '重評 2 分：待辦消失（本班也算評過）')

    // 管路
    await as('clerk01')
    await expectError(() => L.addLine({ admissionId: a.id, kind: 'pivc', site: '右手背', size: '20G', insertedAt: nowStr().slice(0, 16), placedBy: 'x' }), '櫃台登錄管路')
    await as('nurse01')
    f = await fieldsOf(() => L.addLine({ admissionId: a.id, kind: 'foley', site: '', size: '', insertedAt: '2099-01-01 00:00', placedBy: '' }))
    ok(f.site && f.size && f.placedBy && f.insertedAt, '部位、尺寸、放置者、時間（不能晚於現在）一次標出')
    const at = dateUtil.addMinutes(nowStr(), -3 * 60)
    const foley = await L.addLine({ admissionId: a.id, kind: 'foley', site: '尿道', size: '16Fr', insertedAt: at, placedBy: '周怡萱' })
    ok(foley.state.needCheckDue && !foley.state.attendingAlert && foley.label === '導尿管', '登錄導尿管：今天要評估')
    let msg = await errOf(() => L.addLine({ admissionId: a.id, kind: 'foley', site: '尿道', size: '14Fr', insertedAt: at, placedBy: 'x' }))
    ok(msg.includes('已經有一條'), `同一種（留置針以外）同時只能一條 → 「${msg}」`)
    const ivBefore = (await L.listLines(a.id)).active.filter((l) => l.kind === 'pivc').length
    await L.addLine({ admissionId: a.id, kind: 'pivc', site: '右手背', size: '20G', insertedAt: at, placedBy: 'x' })
    await L.addLine({ admissionId: a.id, kind: 'pivc', site: '左前臂', size: '22G', insertedAt: at, placedBy: 'x' })
    ok((await L.listLines(a.id)).active.filter((l) => l.kind === 'pivc').length === ivBefore + 2, '留置針可以多條')
    f = await fieldsOf(() => L.checkLineNeed(foley.id, false, ''))
    ok(f.note, '評估可以移除要寫依據')
    let lv = await L.checkLineNeed(foley.id, true)
    ok(!lv.state.needCheckDue && !lv.state.removable, '評估還需要：今天不用再評')
    lv = await L.checkLineNeed(foley.id, false, '已可自解')
    ok(lv.state.removable && (await api.nursingApi.listWardTasks(ward(a))).some((t) => t.kind === 'line' && t.text.includes('請移除')), '同一天改評估可移除：本班待辦提醒移除')
    const iv1 = (await L.listLines(a.id)).active.find((l) => l.kind === 'pivc')
    msg = await errOf(() => L.checkLineNeed(iv1.id, true))
    ok(msg.includes('不用每天評估'), '留置針不用每天評估')
    f = await fieldsOf(() => L.removeLine(foley.id, ''))
    ok(f.reason, '移除要選原因')
    f = await fieldsOf(() => L.removeLine(foley.id, '其他', ''))
    ok(f.note, '「其他」要寫說明')
    lv = await L.removeLine(foley.id, '不需要了')
    ok(lv.removedAt && lv.removeReason === '不需要了' && (await L.listLines(a.id)).removed.length === 1, '移除：記原因，移到已移除')
    msg = await errOf(() => L.removeLine(foley.id, '不需要了'))
    ok(msg.includes('已經移除'), '不能重複移除')
    // 醫師也能登錄、評估
    await as(db().users.find((u) => u.doctorId === a.doctorId).username)
    const cvc = await L.addLine({ admissionId: a.id, kind: 'cvc', site: '右內頸靜脈', size: '7Fr 三腔', insertedAt: at, placedBy: '主治醫師' })
    ok(cvc.recordedBy && cvc.state.needCheckDue, '醫師可以登錄 CVC')

    // 病房管路日
    await as('nurse01')
    const st = await L.wardLineStats(ward(a), 30)
    const row = (k) => st.rows.find((r) => r.kind === k)
    ok(row('foley').lineDays >= 1 && row('pivc').active >= 2 && row('foley').removed['不需要了'] >= 1 && st.patientDays > 0, `病房管路日：導尿管 ${row('foley').lineDays}、留置針目前 ${row('pivc').active} 條、移除原因統計`)

    // 出院：還在身上的自動移除
    // 挑一位單純的病人（沒有轉科、備血、手術、出院帶藥），醫師簽准出院 → 結帳 → 出院
    const b = db().admissions.find((x) => x.status === 'admitted' && !x.obs && !x.deptTransfers?.some((t) => t.status === 'pending') && !db().bloodRequests.some((r) => r.admissionId === x.id) && !db().surgeries.some((g) => g.admissionId === x.id) && !x.dischargeSummary?.meds?.length && !x.dischargeSummary?.signedAt)
    if (b) {
      await as(db().users.find((u) => u.doctorId === b.doctorId).username)
      await api.ipdApi.saveDischargeSummary(b.id, { diagnosis: b.diagnosis, course: '病況改善', condition: '穩定', followUp: '門診追蹤', dischargeType: '改善出院' }, true)
      await as('nurse01')
      await L.addLine({ admissionId: b.id, kind: 'pivc', site: '右手背', size: '20G', insertedAt: at, placedBy: 'x' })
      await as('clerk01')
      if (!db().charges.some((c) => c.admissionId === b.id && !c.voided)) await api.ipdChargeApi.payIpd(b.id, { payMethod: 'card', received: 0 })
      await api.admissionApi.discharge(b.id, { confirmUnfinished: true })
      ok(db().lines.filter((l) => l.admissionId === b.id).length && db().lines.filter((l) => l.admissionId === b.id).every((l) => l.removedAt && l.removeReason === '出院'), '出院：管路自動記移除（原因「出院」）')
    }
  }

  // 飲食與營養：飲食醫囑選種類（舊文字推斷）、取代舊的；伙食費依每天飲食醫囑（禁食不收、主檔生效日）進住院帳單；術前禁食連禁食醫囑；
  // 營養篩檢（48 小時、簡化 NRS-2002、70 歲加 1）→ ≥3 分營養師待評估 → 評估（不開醫囑）→ 主治已閱；送餐清單
  console.log('\n[飲食與營養]')
  {
    resetDb('small')
    const db = () => dbm.db
    const NA = api.nutritionApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.dietKindOfText('糖尿病飲食 1800 kcal') === 'diabetic' && api.dietKindOfText('吞嚥困難軟質飲食') === 'soft' && api.dietKindOfText('禁食') === 'npo' && api.dietKindOfText('普通飲食，鼓勵多喝水') === 'regular', '舊飲食醫囑文字推斷種類')
    const os = [
      { category: 'diet', type: 'long', startAt: '2026-11-15 10:00', stopAt: '2026-11-16 18:00', status: 'stopped', content: '普通飲食' },
      { category: 'diet', type: 'long', startAt: '2026-11-16 18:00', status: 'active', diet: { kind: 'npo' }, content: '禁食' },
    ]
    ok(api.dietOfDay(os, '2026-11-15').kind === 'regular' && api.dietOfDay(os, '2026-11-16').kind === 'regular' && api.dietOfDay(os, '2026-11-17').kind === 'npo' && !api.dietOfDay(os, '2026-11-14'), '每天的伙食以午餐時間有效的飲食醫囑為準（入院前一天沒有）')
    ok(api.nutritionScore({ impaired: 1, severity: 1, age70: true }) === 3 && api.screenDue('2026-11-15 08:00', undefined, '2026-11-17 08:01').status === 'overdue' && api.screenDue('2026-11-15 08:00', undefined, '2026-11-17 03:00').status === 'due' && api.screenDue('2026-11-15 08:00', '2026-11-15 09:00', '2026-11-18 00:00').status === 'done', '篩檢分數（70 歲加 1）、48 小時期限（最後 6 小時快到期）')

    // 種子
    const stroke = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    const sepsis = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('A41'))
    ok(db().ipdOrders.filter((o) => o.category === 'diet').every((o) => o.diet?.kind), '種子：飲食醫囑都有種類')
    await as('diet01')
    let work = await NA.listNutritionWork()
    ok(!sepsis || work.toAssess.some((x) => x.admissionId === sepsis.id), '種子：敗血症篩檢 ≥3 分，營養師待評估')
    ok((await api.dashboardApi.getDashboard()).nutritionToAssess === work.toAssess.length, `營養師首頁：待評估 ${work.toAssess.length}`)
    if (stroke) {
      await as(db().users.find((u) => u.doctorId === stroke.doctorId).username)
      ok((await api.dashboardApi.getDashboard()).nutritionUnseen >= 1, '主治首頁：營養評估待已閱（腦梗塞昨天的建議）')
    }

    // 飲食醫囑
    const a = db().admissions.find((x) => x.status === 'admitted' && !x.obs && x.id !== stroke?.id && x.id !== sepsis?.id)
    const doc = db().users.find((u) => u.doctorId === a.doctorId).username
    await as(doc)
    let f = await fieldsOf(() => api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'diet', content: '', diet: { kind: 'xx' } }))
    ok(f.diet, '飲食種類要選對')
    const o1 = await api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'diet', content: '', diet: { kind: 'diabetic', note: '1800 kcal' } })
    ok(o1.content === '糖尿病飲食・1800 kcal' && o1.diet.kind === 'diabetic' && db().ipdOrders.filter((o) => o.admissionId === a.id && o.category === 'diet' && o.status === 'active').length === 1, '選種類＋備註：內容「糖尿病飲食・1800 kcal」，舊的飲食醫囑自動停止')
    const o2 = await api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'diet', content: '流質飲食' })
    ok(o2.diet.kind === 'liquid', '只寫文字（舊呼叫方式）依關鍵字推斷種類')
    await as('clerk01')
    await expectError(() => api.ipdApi.addOrder({ admissionId: a.id, type: 'stat', category: 'procedure', procId: 'P046', content: '' }), '櫃台開醫令')
    await as(doc)
    let msg = await errOf(() => api.ipdApi.addOrder({ admissionId: a.id, type: 'stat', category: 'procedure', procId: 'P046', content: '' }))
    ok(msg.includes('伙食費'), `伙食費不能當醫令開 → 「${msg}」`)

    // 伙食費：依每天的飲食醫囑、禁食不收、自費
    await as('clerk01')
    const mealLines = async (id) => (await api.ipdChargeApi.getIpdBill(id)).bill.lines.filter((l) => l.name.startsWith('伙食費'))
    let ml = await mealLines(a.id)
    ok(ml.length >= 1 && ml.every((l) => l.patientPay && l.kind === 'self'), `住院帳單有伙食費（自費）：${ml.map((l) => `${l.name}×${l.qty}`).join('、')}`)
    const bill = (await api.ipdChargeApi.getIpdBill(a.id)).bill
    const days = bill.meta.days
    ok(ml.reduce((n, l) => n + l.qty, 0) <= days, `伙食天數不超過住院天數（${days}）`)
    await as(doc)
    await api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'diet', content: '', diet: { kind: 'npo' } })
    // 今天（午餐時間）以後禁食：今天的伙食看午餐時間的醫囑——中午前改禁食，今天不收
    db().ipdOrders.find((o) => o.admissionId === a.id && o.diet?.kind === 'npo' && o.status === 'active').startAt = `${T} 06:00`
    db().ipdOrders.filter((o) => o.admissionId === a.id && o.category === 'diet' && o.status === 'stopped' && o.stopAt >= `${T} 00:00`).forEach((o) => (o.stopAt = `${T} 06:00`))
    await as('clerk01')
    const before = ml.reduce((n, l) => n + l.qty, 0)
    ml = await mealLines(a.id)
    ok(ml.reduce((n, l) => n + l.qty, 0) <= before, '改禁食：禁食那天不收伙食費')
    // 主檔調價有生效日
    await as('admin')
    const p46 = db().procedures.find((p) => p.id === 'P046')
    ok(p46.selfPrice === 210 && p46.meal?.includes('regular') && !(await api.masterApi.listProcedures()).some((p) => p.meal), '伙食費在主檔（醫令清單不列，不能開）')

    // 術前禁食連禁食醫囑
    const sg = db().surgeries.find((s) => ['requested', 'scheduled'].includes(s.status) && !s.prep.npo)
    if (sg) {
      await as(db().users.find((u) => u.doctorId === db().admissions.find((x) => x.id === sg.admissionId).doctorId).username)
      const npo = await api.ipdApi.addOrder({ admissionId: sg.admissionId, type: 'long', category: 'diet', content: '', diet: { kind: 'npo', note: '術前 8 小時' } })
      await as('nurse02')
      const ps = await api.surgeryApi.patientSurgeries(sg.admissionId)
      ok(ps.npoOptions.some((x) => x.id === npo.id), '術前準備：禁食可以選這次住院的禁食醫囑')
      f = await fieldsOf(() => api.surgeryApi.markPrep(sg.id, 'npo', { refId: o1.id }))
      ok(f.refId, '連的不是禁食醫囑擋')
      await api.surgeryApi.markPrep(sg.id, 'npo', { refId: npo.id })
      ok(db().surgeries.find((s) => s.id === sg.id).prep.npo.refId === npo.id, '禁食連到禁食醫囑')
    }

    // 營養篩檢 → 營養師 → 主治已閱
    await as('diet01')
    await expectError(() => NA.saveNutritionScreen(a.id, { impaired: 1, severity: 1 }), '營養師做篩檢（護理師做）')
    await as('nurse01')
    f = await fieldsOf(() => NA.saveNutritionScreen(a.id, { impaired: 5, severity: undefined, heightCm: 300 }))
    ok(f.impaired && f.severity && f.heightCm, '篩檢欄位一次標出')
    const age = (await NA.patientNutrition(a.id)).age
    const s1 = await NA.saveNutritionScreen(a.id, { impaired: 2, severity: 1, heightCm: 160, weightKg: 45 })
    ok(s1.score === 3 + (age >= 70 ? 1 : 0) && s1.risk && s1.bmi === 17.6, `篩檢 ${s1.score} 分（${age} 歲）、BMI ${s1.bmi}：有營養風險`)
    await as('diet01')
    work = await NA.listNutritionWork()
    ok(work.toAssess.some((x) => x.admissionId === a.id), '列營養師待評估')
    f = await fieldsOf(() => NA.saveNutritionAssessment(a.id, { assessment: '', recommendation: '', kcal: 9000 }))
    ok(f.assessment && f.recommendation && f.kcal, '評估、建議必填；熱量範圍')
    const x1 = await NA.saveNutritionAssessment(a.id, { kcal: 1600, protein: 70, assessment: '進食量少、體重下降', recommendation: '加一份營養補充品' })
    ok(!(await NA.listNutritionWork()).toAssess.some((x) => x.admissionId === a.id) && db().ipdOrders.filter((o) => o.admissionId === a.id && o.category === 'diet' && o.status === 'active').length === 1, '寫好評估：不在待評估；營養師不開醫囑（飲食醫囑沒變）')
    await as('nurse01')
    await expectError(() => NA.ackNutritionAssessment(x1.id), '護理師按已閱')
    const other = db().users.find((u) => u.doctorId && db().doctors.find((d) => d.id === u.doctorId)?.deptId !== a.deptId && u.roles.includes('doctor'))
    await as(other.username)
    msg = await errOf(() => NA.ackNutritionAssessment(x1.id))
    ok(msg.includes('醫師'), `別科醫師不能已閱 → 「${msg}」`)
    await as(doc)
    const nv = await NA.patientNutrition(a.id)
    ok(nv.canAck && !nv.canScreen && !nv.canAssess && nv.assessments[0].id === x1.id, '主治看得到評估、可以已閱')
    const ackd = await NA.ackNutritionAssessment(x1.id)
    ok(ackd.seenAt && ackd.seenByName, '主治已閱')
    // 重篩又 ≥3：再列待評估（評估是一小時前寫的）
    db().nutritionAssessments.find((x) => x.id === x1.id).at = dateUtil.addMinutes(nowStr(), -60)
    await as('nurse01')
    await NA.saveNutritionScreen(a.id, { impaired: 3, severity: 1 })
    await as('diet01')
    ok((await NA.listNutritionWork()).toAssess.find((x) => x.admissionId === a.id)?.reassess, '重篩又 ≥3：再列待評估（標重評）')

    // 護理站：篩檢期限、本班待辦
    const fresh = db().admissions.find((x) => x.status === 'admitted' && !x.obs && !db().nutritionScreens.some((s) => s.admissionId === x.id))
    if (fresh) {
      await as('nurse01')
      const ward = db().beds.find((b) => b.id === fresh.bedId).ward
      const wp = (await api.nursingApi.listWardPatients(ward)).find((p) => p.id === fresh.id)
      ok(wp.nutritionDue && (await api.nursingApi.listWardTasks(ward)).some((t) => t.kind === 'nutrition' && t.admissionId === fresh.id), `還沒篩檢的病人：護理站標「${wp.nutritionDue}」、本班待辦有營養篩檢`)
    }
    // 留觀不篩
    await as('nurse01')
    msg = await errOf(() => NA.saveNutritionScreen('A-ER-OBS', { impaired: 0, severity: 0 }))
    ok(msg.includes('留觀'), `急診留觀不篩 → 「${msg}」`)

    // 送餐清單
    const w0 = db().beds.find((b) => b.id === a.bedId).ward
    const list = await NA.mealList(w0, T, 'dinner')
    const row = list.rows.find((r) => r.bedNo === db().beds.find((b) => b.id === a.bedId).bedNo)
    ok(row?.npo && row.dietText.startsWith('禁食') && list.counts['禁食'] >= 1 && list.rows.every((r, i, xs) => i === 0 || xs[i - 1].bedNo <= r.bedNo), '送餐清單：依床號、禁食標出、各種飲食份數')
    const tomorrow = dateUtil.addDays(T, 1)
    ok((await NA.mealList(w0, tomorrow, 'breakfast')).rows.length >= 1, '明天早餐也能先列')
    await as('clerk01')
    await expectError(() => NA.mealList(w0, T, 'lunch'), '櫃台看送餐清單')
  }

  // 管灌：配方主檔、管灌醫囑（要有鼻胃管或胃造口、分次或連續）、營養師建議一鍵帶入、伙食費、每餐記灌入與反抽量（>200 提醒）、
  // 本班待辦、今日輸入量、送餐清單
  console.log('\n[管灌]')
  {
    resetDb('small')
    const db = () => dbm.db
    const T2 = api.tubeApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    let e = api.checkTubePlan({ formulaId: 'TF01', totalMl: 1500, mode: 'bolus', feeds: 2 })
    ok(e.feeds?.includes('500'), '每餐超過 500 ml 擋')
    e = api.checkTubePlan({ formulaId: '', totalMl: 50, mode: 'continuous', rateMlH: 500 })
    ok(e.formulaId && e.totalMl && e.rateMlH, '配方、總量、速度範圍')
    const sl = api.feedSlots({ formulaId: 'TF01', totalMl: 1500, mode: 'bolus', feeds: 6 }, '2026-11-17')
    ok(sl.map((x) => x.slot.slice(11)).join(',') === '06:00,09:00,12:00,15:00,18:00,21:00' && sl[0].ml === 250, '分 6 餐：06–21 每 3 小時、每餐 250 ml')
    ok(api.feedSlots({ formulaId: 'TF01', totalMl: 1440, mode: 'continuous', rateMlH: 60 }, '2026-11-17').every((x) => x.ml === 480), '連續 60 ml/h：每班 480 ml')
    ok(api.slotState({ mode: 'bolus' }, '2026-11-17 09:00', false, '2026-11-17 08:10') === 'due' && api.slotState({ mode: 'bolus' }, '2026-11-17 09:00', false, '2026-11-17 10:01') === 'overdue' && api.slotState({ mode: 'bolus' }, '2026-11-17 09:00', false, '2026-11-17 07:59') === 'upcoming', '分次前後 1 小時「現在」、超過逾時')
    ok(api.tubeNutrients({ totalMl: 1500 }, { kcalPerMl: 1.2, proteinPerMl: 0.063 }).kcal === 1800, '熱量依配方')

    // 營養師建議 → 主治一鍵帶入（種子：腦梗塞昨天的建議，有鼻胃管）
    const stroke = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    const na = db().nutritionAssessments.find((x) => x.id === 'NA-SEED-2')
    if (stroke && na) {
      await as(db().users.find((u) => u.doctorId === stroke.doctorId).username)
      const pn = await api.nutritionApi.patientNutrition(stroke.id)
      ok(pn.assessments.find((x) => x.id === na.id)?.tubeText?.includes('分 6 餐'), '種子：營養師的管灌建議（均衡配方 1500 ml，分 6 餐）')
      const o = await api.ipdApi.orderTubeFromAssessment(na.id)
      ok(o.diet.kind === 'tube' && o.content.startsWith('管灌飲食・均衡配方') && db().nutritionAssessments.find((x) => x.id === na.id).tubeOrderId === o.id && db().nutritionAssessments.find((x) => x.id === na.id).seenAt, `依建議開管灌醫囑「${o.content}」，建議記為已帶入、已閱；開的人是醫師`)
      ok(db().ipdOrders.filter((x) => x.admissionId === stroke.id && x.category === 'diet' && x.status === 'active').length === 1, '取代原本的軟質飲食')
      const msg = await errOf(() => api.ipdApi.orderTubeFromAssessment(na.id))
      ok(msg.includes('帶入過'), '同一份建議只能帶一次')
      await as('nurse01')
      await expectError(() => api.ipdApi.orderTubeFromAssessment(na.id), '護理師帶入管灌建議')
    }

    // 沒有管路不能開
    const a = db().admissions.find((x) => x.status === 'admitted' && !x.obs && !db().lines.some((l) => l.admissionId === x.id && ['ngt', 'peg'].includes(l.kind) && !l.removedAt))
    const doc = db().users.find((u) => u.doctorId === a.doctorId).username
    await as(doc)
    const plan = { formulaId: 'TF03', totalMl: 1200, mode: 'bolus', feeds: 6 }
    let f = await fieldsOf(() => api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'diet', content: '', diet: { kind: 'tube', tube: plan } }))
    ok(f.diet?.includes('鼻胃管'), `沒有鼻胃管或胃造口不能開管灌 → 「${f.diet}」`)
    f = await fieldsOf(() => api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'diet', content: '', diet: { kind: 'tube', tube: { ...plan, formulaId: '' } } }))
    ok(f.formulaId, '要選配方')
    await as('nurse01')
    await api.lineApi.addLine({ admissionId: a.id, kind: 'peg', site: '左上腹', size: '20Fr', insertedAt: dateUtil.addMinutes(nowStr(), -24 * 60), placedBy: '外科醫師' })
    await as(doc)
    const o = await api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'diet', content: '', diet: { kind: 'tube', tube: plan } })
    ok(o.diet.tube.feeds === 6 && o.content.includes('高蛋白配方') && o.content.includes('每餐 200 ml'), `胃造口也可以：「${o.content}」`)
    // 開立時間往前到昨天（住院帳單和病房費一樣算到昨天；今天的排程也都算）
    db().ipdOrders.find((x) => x.id === o.id).startAt = `${dateUtil.addDays(T, -1)} 00:00`

    // 伙食費：管灌那天收管灌伙食費
    await as('clerk01')
    const bill = (await api.ipdChargeApi.getIpdBill(a.id)).bill
    ok(bill.lines.some((l) => l.name.startsWith('伙食費（管灌飲食')), '住院帳單：管灌那天收管灌伙食費（和病房費一樣算到昨天）')

    // 護理站記錄
    await as('nurse01')
    let v = await T2.getTubeFeeding(a.id)
    ok(v.plan?.kcal === 1440 && v.slots.length === 6 && v.canRecord, `管灌分頁：6 餐、約 ${v.plan?.kcal} kcal`)
    const now0 = nowStr()
    const due = v.slots.find((s) => s.state === 'due' || s.state === 'overdue')
    const ward = db().beds.find((b) => b.id === a.bedId).ward
    if (due) {
      ok((await api.nursingApi.listWardTasks(ward)).some((t) => t.kind === 'tube' && t.admissionId === a.id), '本班待辦：該灌的管灌')
      f = await fieldsOf(() => T2.recordTubeFeed(a.id, { slot: due.slot, givenMl: 0 }))
      ok(f.givenMl, '灌 0 ml 要寫沒灌的原因')
      const r = await T2.recordTubeFeed(a.id, { slot: due.slot, givenMl: 200, residualMl: 250 })
      ok(r.warning?.includes('通知醫師') && r.record.givenMl === 200, `反抽 250 ml：提醒「${r.warning}」，照樣記錄`)
      const wp = (await api.nursingApi.listWardPatients(ward)).find((p) => p.id === a.id)
      ok(wp.tube?.highResidual, '護理站清單標「反抽過多」')
      const msg = await errOf(() => T2.recordTubeFeed(a.id, { slot: due.slot, givenMl: 200 }))
      ok(msg.includes('記過'), '同一餐不能記兩次')
      const io = await api.nursingApi.ioToday(a.id)
      ok(io.tubeMl >= 200 && io.intake >= io.tubeMl, `今日輸入量含管灌 ${io.tubeMl} ml`)
    }
    const up = v.slots.find((s) => s.state === 'upcoming')
    if (up) {
      const msg = await errOf(() => T2.recordTubeFeed(a.id, { slot: up.slot, givenMl: 200 }))
      ok(msg.includes('還沒到時間'), '還沒到時間不能記')
    }
    await as('dr01')
    await expectError(() => T2.recordTubeFeed(a.id, { slot: v.slots[0].slot, givenMl: 200 }), '醫師記管灌')

    // 送餐清單：管灌送配方
    await as('nurse01')
    const ml = await api.nutritionApi.mealList(ward, T, 'dinner')
    ok(ml.rows.find((r) => r.bedNo === db().beds.find((b) => b.id === a.bedId).bedNo)?.tube && ml.counts['管灌飲食'] >= 1, '送餐清單：管灌標出（送配方）')
    void now0
  }

  // 譫妄與約束：CAM 判定、誰要每班評、陽性主治確認；約束醫囑 24 小時、緊急約束 1 小時內補醫囑、每 2 小時查核、解除原因、出院解除；品質指標
  console.log('\n[譫妄與約束]')
  {
    resetDb('small')
    const db = () => dbm.db
    const D = api.deliriumApi
    const { addMinutes } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.camPositive({ acute: true, inattention: true, consciousness: true }) && !api.camPositive({ acute: true, disorganized: true, consciousness: true }) && !api.camPositive({ acute: true, inattention: true }), 'CAM：1＋2＋（3 或 4）才陽性')
    ok(api.deliriumTarget(70, undefined, '2026-11-17 10:00') && api.deliriumTarget(40, '2026-11-15 10:00', '2026-11-17 10:00') && !api.deliriumTarget(40, '2026-11-13 10:00', '2026-11-17 10:00'), '65 歲以上、術後 72 小時內要每班評')
    let st = api.restraintState({ startedAt: '2026-11-17 08:00', emergency: true, orders: [], checks: [] }, '2026-11-17 08:30')
    ok(st.order === 'pending' && st.check === 'ok' && st.checkDueAt === '2026-11-17 10:00', '緊急約束：1 小時內等補醫囑；2 小時後查核')
    st = api.restraintState({ startedAt: '2026-11-17 08:00', emergency: true, orders: [], checks: [] }, '2026-11-17 10:01')
    ok(st.order === 'missing' && st.check === 'overdue', '超過 1 小時沒醫囑、超過 2 小時沒查核')
    st = api.restraintState({ startedAt: '2026-11-16 08:00', emergency: false, orders: [{ at: '2026-11-16 08:00', until: '2026-11-17 08:00' }], checks: [{ at: '2026-11-17 07:50' }] }, '2026-11-17 09:00')
    ok(st.order === 'expired' && st.check === 'ok' && st.hours === 25, '醫囑 24 小時到期')

    // 種子
    const seedR = db().restraints.find((r) => r.id === 'RS-SEED-1')
    if (seedR) {
      const a0 = db().admissions.find((a) => a.id === seedR.admissionId)
      const ward = db().beds.find((b) => b.id === a0.bedId).ward
      await as('nurse01')
      const wp = (await api.nursingApi.listWardPatients(ward)).find((p) => p.id === a0.id)
      ok(wp.restraint?.check === 'overdue' && wp.deliriumPositive, '種子：約束查核逾時（清單標約束中）、譫妄陽性')
      ok((await api.nursingApi.listWardTasks(ward)).some((t) => t.kind === 'restraint' && t.admissionId === a0.id && t.urgency === 'overdue') && (await api.dashboardApi.getDashboard()).restraintCheckOverdue >= 1, '本班待辦與護理師首頁：約束查核逾時')
      await as(db().users.find((u) => u.doctorId === a0.doctorId).username)
      ok((await api.dashboardApi.getDashboard()).deliriumPositive >= 1, '主治首頁：譫妄陽性待確認')
    }

    // CAM
    const a = db().admissions.find((x) => x.status === 'admitted' && !x.obs && !db().restraints.some((r) => r.admissionId === x.id))
    const docU = db().users.find((u) => u.doctorId === a.doctorId).username
    await as(docU)
    await expectError(() => D.saveDelirium(a.id, { acute: true, inattention: true, disorganized: true, consciousness: false }), '醫師做 CAM（護理師做）')
    await as('nurse01')
    let f = await fieldsOf(() => D.saveDelirium(a.id, { acute: true, inattention: true, disorganized: true, consciousness: false }))
    ok(f.note, '陽性要寫觀察到的表現')
    const pos = await D.saveDelirium(a.id, { acute: true, inattention: true, disorganized: false, consciousness: true, note: '嗜睡、叫醒後答非所問' })
    ok(pos.positive, 'CAM 陽性')
    const neg = await D.saveDelirium(a.id, { acute: true, inattention: false, disorganized: true, consciousness: true })
    ok(!neg.positive, '沒有注意力不集中：陰性')
    await expectError(() => D.ackDelirium(pos.id), '護理師確認譫妄')
    await as(docU)
    let msg = await errOf(() => D.ackDelirium(neg.id))
    ok(msg.includes('陰性'), '陰性不用確認')
    const ak = await D.ackDelirium(pos.id)
    ok(ak.ackAt && ak.ackByName, '主治確認陽性')

    // 約束：護理師緊急約束 → 醫師補醫囑 → 查核 → 解除
    await as('nurse01')
    f = await fieldsOf(() => D.startRestraint(a.id, { reason: '', sites: [], method: '' }))
    ok(f.reason && f.sites && f.method, '原因、部位、方式一次標出')
    let r = await D.startRestraint(a.id, { reason: '自拔管路風險', sites: ['左手', '右手'], method: '約束手套' })
    ok(r.emergency && r.state.order === 'pending' && !r.orders.length, '護理師只能緊急約束：等醫師補醫囑')
    msg = await errOf(() => D.startRestraint(a.id, { reason: 'x', sites: ['左腳'], method: '約束帶' }))
    ok(msg.includes('已經在約束中'), '同時只有一筆約束')
    // 1 小時沒補 → 醫師首頁、本班待辦
    db().restraints.find((x) => x.id === r.id).startedAt = addMinutes(nowStr(), -70)
    const ward = db().beds.find((b) => b.id === a.bedId).ward
    ok((await api.nursingApi.listWardTasks(ward)).some((t) => t.kind === 'restraint' && t.text.includes('沒有醫囑')), '超過 1 小時沒醫囑：本班待辦')
    await as(docU)
    ok((await api.dashboardApi.getDashboard()).restraintOrder >= 1, '醫師首頁：約束醫囑待補')
    r = await D.orderRestraint(r.id)
    ok(r.state.order === 'ok' && r.orders.length === 1 && r.state.orderUntil > nowStr(), '醫師補醫囑：有效 24 小時')
    await as('nurse01')
    await expectError(() => D.orderRestraint(r.id), '護理師開約束醫囑')
    f = await fieldsOf(() => D.checkRestraint(r.id, { circulationOk: false, skinOk: true, stillNeeded: true }))
    ok(f.note, '末梢循環異常要寫處置')
    r = await D.checkRestraint(r.id, { circulationOk: true, skinOk: true, stillNeeded: false })
    ok(r.state.check === 'ok' && r.checks.length === 1 && r.state.checkDueAt > nowStr(), '查核後：下次 2 小時後')
    f = await fieldsOf(() => D.endRestraint(r.id, ''))
    ok(f.reason, '解除要選原因')
    r = await D.endRestraint(r.id, '已不需要（意識清楚、配合）')
    ok(r.endedAt && r.endReason.startsWith('已不需要'), '解除記原因')
    msg = await errOf(() => D.checkRestraint(r.id, { circulationOk: true, skinOk: true, stillNeeded: true }))
    ok(msg.includes('已經解除'), '解除後不能查核')
    // 醫師直接開醫囑
    await as(docU)
    const r2 = await D.startRestraint(a.id, { reason: '跌倒風險（躁動下床）', sites: ['軀幹'], method: '約束背心' })
    ok(!r2.emergency && r2.state.order === 'ok', '醫師開約束醫囑：不是緊急約束')

    // 品質指標
    await as('nurse01')
    const q = await D.wardSafetyStats(ward, 30)
    ok(q.restraints >= 2 && q.emergency >= 1 && q.restraintActive >= 1 && q.camCount >= 2 && q.camPositive >= 1 && q.camRate > 0, `品質指標：約束 ${q.restraints} 次（緊急 ${q.emergency}）、約束日 ${q.restraintDays}、CAM 陽性 ${q.camPositive}／${q.camCount}`)
  }

  // 護理排班與分床：班表（權限、同一天一人一班、過去不能改、複製上個月）、護病比（超過標紅不擋、管理員調上限）、
  // 這一班分床（只能分給上班的人）、護理站「我的病人」、首頁只算自己的病人、交班帶出接班人
  console.log('\n[護理排班與分床]')
  {
    dbm.resetDatabase('small') // 這一段要用種子的分床：不用 resetDb（它會清掉分床）
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const S = api.staffingApi
    const W = '5A 內科病房'
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.ratioState(14, 2, 7).text === '1：7（上限 1：7）' && !api.ratioState(14, 2, 7).over && api.ratioState(15, 2, 7).over && api.ratioState(3, 0, 7).over && !api.ratioState(0, 0, 7).over, '護病比：剛好不超過、超過、有病人沒排人')
    const sg = api.suggestAssign(['a', 'b', 'c', 'd', 'e'], ['n1', 'n2'])
    ok(sg.a === 'n1' && sg.c === 'n1' && sg.d === 'n2' && sg.e === 'n2', '分床建議：依床號連續平均分')
    ok(api.monthDates('2026-02').length === 28 && api.copySourceOf('2026-11-30') === '2026-11-02', '月份日期、複製上個月照 4 週前')
    ok(api.checkRatio({ 白班: 0, 小夜: 11, 大夜: 15 }).白班, '上限 1–30')

    // 種子
    const today0 = T
    const shiftNow = Number(nowStr().slice(11, 13)) >= 16 ? '小夜' : Number(nowStr().slice(11, 13)) >= 8 ? '白班' : '大夜'
    ok(db().users.filter((u) => /^nurse[0-9]+$/.test(u.username)).length === 16 && db().nurseShifts.filter((x) => x.date === today0 && x.ward === W && x.shift === '白班').map((x) => x.nurseId).sort().join() === 'U201,U202', '種子：16 位護理師（nurse01–12 一般病房、nurse13–16 加護病房）；今天 5A 白班 nurse01、nurse02')
    await as('nurse03')
    let sch = await S.getSchedule('6B 外科病房', today0.slice(0, 7))
    const tomorrow = sch.days.find((d) => d.date === dateUtil.addDays(today0, 1))
    ok(!sch.canEdit && sch.days.length >= 28 && (!tomorrow || (tomorrow.cells.find((c) => c.shift === '小夜').nurses.length === 0 && tomorrow.cells.find((c) => c.shift === '小夜').ratio.over === db().admissions.some((a) => a.status === 'admitted' && db().beds.find((b) => b.id === a.bedId)?.ward === '6B 外科病房'))), '一般護理師看得到班表、不能改；明天 6B 小夜沒排（有病人就標紅）')
    await expectError(() => S.setShiftNurses(W, dateUtil.addDays(today0, 2), '白班', ['U203']), '一般護理師排班')

    // 護理長排班
    await as('nurse02')
    const d2 = dateUtil.addDays(today0, 2)
    const busyOn = (d) => new Set(db().nurseShifts.filter((x) => x.date === d).map((x) => x.nurseId))
    const free = db().users.filter((u) => u.roles.includes('nurse') && !busyOn(d2).has(u.id)).map((u) => u.id)
    const takenElsewhere = db().nurseShifts.find((x) => x.date === d2 && x.ward !== W).nurseId
    let f = await fieldsOf(() => S.setShiftNurses(W, d2, '大夜', [takenElsewhere]))
    ok(f.nurseIds?.includes('已經排了'), `同一天一人一班 → 「${f.nurseIds}」`)
    let msg = await errOf(() => S.setShiftNurses(W, dateUtil.addDays(today0, -1), '白班', ['U203']))
    ok(msg.includes('過去'), '過去的班不能改')
    const cell = await S.setShiftNurses(W, d2, '大夜', free.slice(0, 1))
    ok(cell.nurses.length === 1 && db().nurseShifts.filter((x) => x.date === d2 && x.ward === W && x.shift === '大夜').length === 1, '整班取代：大夜改成 1 人')
    const cell0 = await S.setShiftNurses(W, d2, '大夜', [])
    ok(cell0.ratio.over === db().admissions.some((a) => a.status === 'admitted' && db().beds.find((b) => b.id === a.bedId)?.ward === W), '不排人：有病人就標紅（不擋）')
    const r = await S.copyPreviousMonth(W, today0.slice(0, 7))
    ok(r.copied >= 1 && db().nurseShifts.some((x) => x.date === d2 && x.ward === W && x.shift === '大夜'), `複製上個月：補上沒排的班（${r.copied} 人次）`)
    // 護病比上限
    await expectError(() => S.saveRatio({ 白班: 3, 小夜: 11, 大夜: 15 }), '護理長改護病比上限（管理員）')
    await as('admin')
    f = await fieldsOf(() => S.saveRatio({ 白班: 0, 小夜: 11, 大夜: 15 }))
    ok(f.白班, '上限不合理擋')
    await S.saveRatio({ 白班: 1, 小夜: 11, 大夜: 15 })
    sch = await S.getSchedule(W, today0.slice(0, 7))
    ok(sch.canEdit && sch.canEditRatio && sch.days.find((d) => d.date === today0).cells.find((c) => c.shift === '白班').ratio.over, '上限改成 1:1 後今天 5A 白班超過（標紅）')
    await S.saveRatio({ 白班: 7, 小夜: 11, 大夜: 15 })

    // 分床（現在這一班）
    const duty = db().nurseShifts.filter((x) => x.ward === W && x.date === today0 && x.shift === shiftNow).map((x) => x.nurseId)
    const dutyUser = db().users.find((u) => u.id === duty[0])
    const offUser = db().users.find((u) => u.roles.includes('nurse') && !duty.includes(u.id) && !u.grants?.includes('nursing.schedule'))
    await as(dutyUser.username)
    let v = await S.getAssignments(W)
    ok(v.canAssign && v.shift === shiftNow && v.patients.length && v.patients.every((p) => p.nurseId && duty.includes(p.nurseId)), `種子：${shiftNow} 5A 病人都分給上班的護理師`)
    const myIds = v.patients.filter((p) => !p.deceasedAt && p.nurseId === dutyUser.id).map((p) => p.admissionId)
    const wp = await api.nursingApi.listWardPatients(W)
    ok(wp.filter((p) => p.nurseId === dutyUser.id).length === myIds.length && wp.every((p) => p.nurseName), '護理站清單：每位病人標責任護理師')
    // 首頁只算自己的病人：造一個別人病人的約束查核逾時
    const other = v.patients.find((p) => !p.deceasedAt && p.nurseId !== dutyUser.id)
    if (other) {
      db().restraints.push({ id: 'RS-T1', admissionId: other.admissionId, reason: 'x', sites: ['左手'], method: '約束帶', startedAt: dateUtil.addMinutes(nowStr(), -300), startedBy: 'U201', emergency: false, orders: [{ by: 'U201', at: dateUtil.addMinutes(nowStr(), -300), until: dateUtil.addMinutes(nowStr(), 600) }], checks: [] })
      const mine = (await api.dashboardApi.getDashboard()).restraintCheckOverdue
      await as(offUser.username)
      const all = (await api.dashboardApi.getDashboard()).restraintCheckOverdue
      ok(all === mine + 1, `首頁只算自己的病人：分床的人 ${mine}、這班沒分到病人的看全院 ${all}`)
      msg = await errOf(() => S.assignPatients(W, { [other.admissionId]: offUser.id }))
      ok(msg.includes('上班的護理師'), `這班沒上班（也不是護理長）不能分床 → 「${msg}」`)
      await as(dutyUser.username)
      f = await fieldsOf(() => S.assignPatients(W, { [other.admissionId]: offUser.id }))
      ok(f.nurseId?.includes('沒有排'), '只能分給這班在這個病房上班的人')
      v = await S.assignPatients(W, { [other.admissionId]: dutyUser.id })
      ok(v.patients.find((p) => !p.deceasedAt && p.admissionId === other.admissionId).nurseId === dutyUser.id, '重分：改由我照顧')
      v = await S.assignPatients(W, { [other.admissionId]: '' })
      ok(!v.patients.find((p) => !p.deceasedAt && p.admissionId === other.admissionId).nurseId && !(await api.nursingApi.listWardPatients(W)).find((p) => p.id === other.admissionId).nurseId, '取消：未分床')
    }

    // 交班帶出接班人
    const a0 = v.patients[0]
    await as(dutyUser.username)
    await api.nursingApi.addHandover({ ward: W, shift: shiftNow, admissionId: a0.admissionId, content: '交班測試' })
    const hv = (await api.nursingApi.listHandovers(W)).flatMap((g) => g.items).find((h) => h.content === '交班測試')
    ok(hv && (hv.receiverName === undefined || hv.receiverName.length > 0), `交班帶出接班的人：${hv?.receiverName ?? '（下一班沒排）'}`)
  }

  // 傷口與壓傷：分級必填、面積、院內壓傷（入院 24 小時後）、病情變化加評提醒、換藥、2 週沒變小提醒主治、結案、品質指標
  console.log('\n[傷口與壓傷]')
  {
    resetDb('small')
    const db = () => dbm.db
    const W = api.woundApi
    const { addMinutes } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.areaOf({ lengthCm: 3.2, widthCm: 2.5 }) === 8 && api.hospitalAcquired('pressure', '2026-11-17 10:00', '2026-11-16 08:00') && !api.hospitalAcquired('pressure', '2026-11-16 20:00', '2026-11-16 08:00') && !api.hospitalAcquired('surgical', '2026-11-17 10:00', '2026-11-10 08:00'), '面積；入院 24 小時後才發現的壓傷算院內壓傷（手術傷口不算）')
    const cs = [{ at: '2026-11-01 10:00', lengthCm: 3, widthCm: 2 }, { at: '2026-11-15 10:00', lengthCm: 3, widthCm: 2.2 }]
    ok(api.stalled(cs, '2026-11-17 10:00')?.to.area === 6.6 && !api.stalled([...cs, { at: '2026-11-17 09:00', lengthCm: 2, widthCm: 2 }], '2026-11-17 10:00') && !api.stalled([cs[1]], '2026-11-17 10:00'), '連續 2 週沒變小（變小了就不提醒；不到 2 週不判斷）')
    ok(api.checkWoundCare({ dressing: 'x', exudate: 'small', lengthCm: 1, widthCm: 1, depthCm: 0 }, 'pressure').stage && !api.checkWoundCare({ dressing: 'x', exudate: 'small', lengthCm: 1, widthCm: 1, depthCm: 0 }, 'surgical').stage, '壓傷要分級（其他傷口不用）')

    // 種子
    const seedW = db().wounds.find((w) => w.id === 'WD-SEED-1')
    if (seedW) {
      const a0 = db().admissions.find((a) => a.id === seedW.admissionId)
      await as(db().users.find((u) => u.doctorId === a0.doctorId).username)
      ok((await api.dashboardApi.getDashboard()).woundStall >= 1, '種子：薦骨壓傷 2 週沒變小（主治首頁）')
      const pw = await W.patientWounds(a0.id)
      ok(pw.open[0].stall && pw.open[0].hospitalAcquired && pw.riskChangeDue, '院內壓傷、沒變小、待病情變化加評')
    }

    // 登錄
    const a = db().admissions.find((x) => x.status === 'admitted' && !x.obs && x.admittedAt < addMinutes(nowStr(), -48 * 60) && !db().wounds.some((w) => w.admissionId === x.id))
    await as('nurse01')
    let f = await fieldsOf(() => W.addWound(a.id, { kind: 'pressure', site: '', foundAt: '2099-01-01 00:00', dressing: '', exudate: '', lengthCm: 0, widthCm: 1, depthCm: 0 }))
    ok(f.site && f.foundAt && f.dressing && f.exudate && f.lengthCm && f.stage, '部位、時間、敷料、滲液、大小、分級一次標出')
    const r = await W.addWound(a.id, { kind: 'pressure', site: '右足跟', foundAt: nowStr(), dressing: '泡棉敷料', exudate: 'none', lengthCm: 2, widthCm: 1.5, depthCm: 0, stage: '1' })
    ok(r.wound.hospitalAcquired && r.riskReminder?.includes('病情變化加評'), `院內壓傷：提醒「${r.riskReminder}」`)
    const ward = db().beds.find((b) => b.id === a.bedId).ward
    ok((await api.nursingApi.listWardTasks(ward)).some((t) => t.kind === 'wound' && t.admissionId === a.id && t.text.includes('病情變化加評')), '本班待辦：院內壓傷待病情變化加評')
    // 做了病情變化加評 → 待辦消失
    const B = { sensory: 3, moisture: 3, activity: 2, mobility: 2, nutrition: 3, friction: 2 }
    await api.riskApi.saveRiskAssessment({ admissionId: a.id, scale: 'pressure', answers: B, change: true, measures: ['turn', 'mattress'] })
    ok(!(await W.patientWounds(a.id)).riskChangeDue && !(await api.nursingApi.listWardTasks(ward)).some((t) => t.kind === 'wound' && t.admissionId === a.id), '做了壓傷病情變化加評：提醒消失')
    // 入院當天的手術傷口不算院內壓傷
    const s2 = await W.addWound(a.id, { kind: 'surgical', site: '右下腹', foundAt: addMinutes(nowStr(), -60), dressing: '紗布乾敷', exudate: 'small', lengthCm: 4, widthCm: 0.5, depthCm: 0 })
    ok(!s2.wound.hospitalAcquired && !s2.riskReminder && !s2.wound.stageText, '手術傷口：不分級、不算院內壓傷')

    // 換藥、2 週沒變小、結案
    await as(db().users.find((u) => u.doctorId === a.doctorId).username)
    await expectError(() => W.recordCare(r.wound.id, { dressing: 'x', exudate: 'none', lengthCm: 1, widthCm: 1, depthCm: 0, stage: '1' }), '醫師換藥')
    await as('nurse01')
    db().wounds.find((w) => w.id === r.wound.id).cares[0].at = addMinutes(nowStr(), -15 * 24 * 60)
    let v = await W.recordCare(r.wound.id, { dressing: '泡棉敷料', exudate: 'small', lengthCm: 2.5, widthCm: 1.5, depthCm: 0.2, stage: '2' })
    ok(v.stall && v.stageText === '第 2 級' && v.careViews.length === 2, '15 天前 3 cm² → 現在 3.75 cm²：沒變小提醒、分級改第 2 級')
    v = await W.recordCare(r.wound.id, { dressing: '泡棉敷料', exudate: 'small', lengthCm: 1.5, widthCm: 1, depthCm: 0, stage: '2' })
    ok(!v.stall, '變小了：提醒消失')
    f = await fieldsOf(() => W.closeWound(r.wound.id, ''))
    ok(f.reason, '結案要原因')
    v = await W.closeWound(r.wound.id, '已癒合，上皮化完整')
    ok(v.closedAt && (await W.patientWounds(a.id)).closed.length === 1, '結案')
    let msg = await errOf(() => W.recordCare(r.wound.id, { dressing: 'x', exudate: 'none', lengthCm: 1, widthCm: 1, depthCm: 0, stage: '1' }))
    ok(msg.includes('結案'), '結案後不能換藥')

    // 品質指標
    const q = await W.wardPressureStats(ward, 30)
    ok(q.hapi >= 1 && q.rate === api.per1000(q.hapi, q.patientDays), `品質指標：院內壓傷 ${q.hapi} 例、每千住院人日 ${q.rate}`)
  }

  // 點滴：醫囑（容量、流速、加藥、只長期注射）、不排給藥時間、接上（留置針、通暢、扣帳進帳單）、流速與換瓶時間、調流速、換瓶（實際量）、
  // 今日輸入量、醫囑停了還在滴、停止
  console.log('\n[點滴]')
  {
    resetDb('small')
    const db = () => dbm.db
    const V = api.infusionApi
    const { addMinutes } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    const run = { startAt: '2026-11-17 08:00', rateMlH: 100, rateChanges: [] }
    ok(api.hoursPerBag(500, 80) === 6.3 && api.expectedEnd(run, 500) === '2026-11-17 13:00' && api.infusedMl(run, 500, '2026-11-17 10:30') === 250, '一瓶滴多久、預計滴完、已滴入')
    const run2 = { startAt: '2026-11-17 08:00', rateMlH: 50, rateChanges: [{ at: '2026-11-17 10:00', from: 100, to: 50 }] }
    ok(api.infusedMl(run2, 500, '2026-11-17 12:00') === 300 && api.expectedEnd(run2, 500) === '2026-11-17 16:00', '調流速後：之前 100 ml/h、之後 50 ml/h，重算滴完時間')
    ok(api.infusedBetween(run, 500, '2026-11-17 09:00', '2026-11-17 10:00', '2026-11-17 12:00') === 100 && api.changeState('2026-11-17 13:00', '2026-11-17 12:40') === 'due' && api.changeState('2026-11-17 13:00', '2026-11-17 13:01') === 'overdue', '一段時間的輸入量；快滴完、已滴完')

    // 種子
    const badDoc = db().ipdOrders.filter((x) => !db().doctors.some((d) => d.id === x.doctorId))
    ok(!badDoc.length, `種子：住院醫囑的 doctorId 都是醫師代碼（不是帳號）${badDoc.length ? `：${badDoc.map((x) => x.id).join('、')}` : ''}`)
    const seedRun = db().infusions.find((r) => r.id === 'INFU-SEED-1')
    if (seedRun) {
      await as('nurse01')
      const ward = db().beds.find((b) => b.id === db().admissions.find((a) => a.id === seedRun.admissionId).bedId).ward
      ok((await api.nursingApi.listWardTasks(ward)).some((t) => t.kind === 'infusion' && t.text.includes('快滴完')), '種子：肺炎病人點滴快滴完（本班待辦換瓶）')
      ok(!db().mar.some((m) => m.orderId === 'IO-IV-SEED-1'), '點滴醫囑不排給藥時間')
    }

    // 醫囑
    const a = db().admissions.find((x) => x.status === 'admitted' && !x.obs && !db().ipdOrders.some((o) => o.admissionId === x.id && o.infusion))
    const docU = db().users.find((u) => u.doctorId === a.doctorId).username
    await as(docU)
    let f = await fieldsOf(() => api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'medication', drugId: 'M037', content: '', dose: 1, freq: 'QD', route: 'IV', infusion: { volumeMl: 5000, rateMlH: 2 } }))
    ok(f.volumeMl && f.rateMlH, '容量、流速範圍')
    f = await fieldsOf(() => api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'medication', drugId: 'M001', content: '', dose: 1, freq: 'QD', route: 'PO', infusion: { volumeMl: 500, rateMlH: 80 } }))
    ok(f.drugId?.includes('注射'), '點滴要選注射用的輸液')
    const o = await api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'medication', drugId: 'M037', content: '', dose: 1, freq: 'QD', route: 'IV', infusion: { volumeMl: 500, rateMlH: 100, additives: [{ drugId: 'M040', dose: 1 }] }, allowDuplicate: true, rxAlertReasons: Object.fromEntries((await api.ipdApi.orderRxAlerts(a.id, 'M037')).map((x) => [x.key, '測試'])) })
    ok(o.content.includes('500 ml @ 100 ml/h') && o.content.includes('Potassium') && !db().mar.some((m) => m.orderId === o.id), `點滴醫囑「${o.content}」，不排給藥時間`)

    // 接上：要有留置針、要勾通暢
    await as('nurse01')
    for (const l of db().lines.filter((x) => x.admissionId === a.id && ['pivc', 'cvc'].includes(x.kind) && !x.removedAt)) l.removedAt = nowStr()
    let msg = await errOf(() => V.startInfusion(o.id, { patency: true }))
    ok(msg.includes('留置針'), `沒有留置針不能接 → 「${msg}」`)
    await api.lineApi.addLine({ admissionId: a.id, kind: 'pivc', site: '右手背', size: '20G', insertedAt: addMinutes(nowStr(), -10), placedBy: 'x' })
    f = await fieldsOf(() => V.startInfusion(o.id, { patency: false }))
    ok(f.patency, '要確認通暢')
    const txBefore = db().stockTxns.length
    let v = await V.startInfusion(o.id, { patency: true })
    ok(v.running?.bagNo === 1 && db().stockTxns.length === txBefore + 2, '接上第 1 瓶：扣輸液與加藥')
    msg = await errOf(() => V.startInfusion(o.id, { patency: true }))
    ok(msg.includes('換瓶'), '已經在滴：要接下一瓶用換瓶')
    await as('clerk01')
    const bill = (await api.ipdChargeApi.getIpdBill(a.id)).bill
    ok(bill.lines.some((l) => l.name.startsWith('Normal Saline')) && bill.lines.some((l) => l.name.startsWith('Potassium')), '住院帳單有點滴與加藥')

    // 3 小時前接上、1 小時前調慢 → 換瓶時間重算；今日輸入量
    await as('nurse01')
    const r0 = db().infusions.find((r) => r.orderId === o.id && !r.endAt)
    r0.startAt = addMinutes(nowStr(), -180)
    f = await fieldsOf(() => V.adjustRate(o.id, { rateMlH: 50, reason: '' }))
    ok(f.reason, '調流速要原因')
    v = await V.adjustRate(o.id, { rateMlH: 50, reason: '病人心衰竭／水腫，減慢' })
    ok(v.running.rateMlH === 50 && v.running.changes.length === 1 && v.running.infused === 300, `調流速：已滴入 ${v.running.infused} ml、預計 ${v.running.endAt.slice(11)} 滴完`)
    const io = await api.nursingApi.ioToday(a.id)
    ok(io.ivMl >= (nowStr().slice(0, 10) === addMinutes(nowStr(), -180).slice(0, 10) ? 300 : 1) && io.intake >= io.ivMl, `今日輸入量含點滴 ${io.ivMl} ml`)
    // 換瓶：實際量可修正；新的一瓶沿用調過的流速
    f = await fieldsOf(() => V.changeBag(o.id, { patency: true, infusedMl: 900 }))
    ok(f.infusedMl, '實際量不能超過一瓶')
    v = await V.changeBag(o.id, { patency: true, infusedMl: 320 })
    ok(v.running.bagNo === 2 && v.running.rateMlH === 50 && v.history[0].infused === 320, '換瓶：第 1 瓶記實際 320 ml、第 2 瓶沿用 50 ml/h')

    // 醫囑停了還在滴 → 待辦 → 停止
    await as(docU)
    await api.ipdApi.stopOrder(o.id)
    await as('nurse01')
    const ward = db().beds.find((b) => b.id === a.bedId).ward
    ok((await api.nursingApi.listWardTasks(ward)).some((t) => t.kind === 'infusion' && t.text.includes('醫囑已停止')), '醫囑停了還在滴：本班待辦請停止')
    msg = await errOf(() => V.changeBag(o.id, { patency: true }))
    ok(msg.includes('醫囑已停止'), '醫囑停了不能換瓶')
    f = await fieldsOf(() => V.stopInfusion(o.id, { reason: '' }))
    ok(f.reason, '停止要原因')
    await V.stopInfusion(o.id, { reason: '醫囑停止' })
    ok(!db().infusions.some((r) => r.orderId === o.id && !r.endAt) && !(await api.nursingApi.listWardTasks(ward)).some((t) => t.kind === 'infusion' && t.admissionId === a.id), '停止後待辦消失')
  }

  // 院內感染：管路相關要放超過 2 天、通報欄位、手術部位要選手術、判定（權限、原因）、隔離提醒、每千管路日感染率
  console.log('\n[院內感染]')
  {
    resetDb('small')
    const db = () => dbm.db
    const I = api.infectionApi
    const L = api.lineApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.lineDayAt('2026-11-15 10:00', '2026-11-17') === 3 && api.lineRelated('2026-11-15 10:00', '2026-11-17') && !api.lineRelated('2026-11-16 10:00', '2026-11-17'), '管路放超過 2 天（第 3 天起）才算管路相關')
    ok(api.lineRelated('2026-11-10 10:00', '2026-11-17', '2026-11-16 09:00') && !api.lineRelated('2026-11-10 10:00', '2026-11-17', '2026-11-14 09:00'), '移除隔天發生仍算；移除兩天以上不算')
    ok(api.per1000(2, 400) === 5 && api.per1000(1, 0) === null, '每千管路日感染率')

    // 種子
    const seed = db().infectionCases.find((c) => c.id === 'INF-SEED-1')
    await as('dr11')
    let work = await I.listInfectionWork()
    if (seed) ok(work.pending.some((c) => c.id === seed.id && c.lineText?.includes('導尿管')) && (await api.dashboardApi.getDashboard()).infectionToDecide >= 1, '種子：導尿管相關泌尿道感染待感染管制（dr11）判定（首頁）')
    await as('nurse01')
    await expectError(() => I.listInfectionWork(), '一般護理師看感染管制清單')

    // 通報：導尿管放 1 天不算
    const a = db().admissions.find((x) => x.status === 'admitted' && !x.obs && !db().lines.some((l) => l.admissionId === x.id && l.kind === 'foley' && !l.removedAt))
    const fresh = await L.addLine({ admissionId: a.id, kind: 'foley', site: '尿道', size: '16Fr', insertedAt: dateUtil.addMinutes(nowStr(), -60), placedBy: 'x' })
    let f = await fieldsOf(() => I.reportInfection(a.id, { kind: 'cauti', lineId: fresh.id, onsetAt: T, symptoms: '發燒', culture: '待報告' }))
    ok(f.lineId?.includes('不算管路相關'), `導尿管放不到 3 天 → 「${f.lineId}」`)
    f = await fieldsOf(() => I.reportInfection(a.id, { kind: 'cauti', onsetAt: T, symptoms: '', culture: '' }))
    ok(f.symptoms && f.culture, '症狀、培養必填')
    db().lines.find((l) => l.id === fresh.id).insertedAt = dateUtil.addMinutes(nowStr(), -4 * 24 * 60)
    f = await fieldsOf(() => I.reportInfection(a.id, { kind: 'clabsi', lineId: fresh.id, onsetAt: T, symptoms: 'x', culture: 'x' }))
    ok(f.lineId?.includes('中心靜脈導管'), 'CLABSI 要選 CVC（不能選導尿管）')
    f = await fieldsOf(() => I.reportInfection(a.id, { kind: 'ssi', onsetAt: T, symptoms: 'x', culture: 'x' }))
    ok(f.surgeryId, '手術部位感染要選手術')
    const c = await I.reportInfection(a.id, { kind: 'cauti', lineId: fresh.id, onsetAt: T, symptoms: '發燒、恥骨上壓痛', culture: '尿液培養 Klebsiella ≥10⁵' })
    ok(c.status === 'reported' && c.lineText.includes('第 5 天'), `通報成立：${c.lineText}`)

    // 判定
    await expectError(() => I.decideInfection(c.id, true, 'x'), '一般護理師判定')
    await as('dr11')
    f = await fieldsOf(() => I.decideInfection(c.id, true, ''))
    ok(f.reason, '判定要寫依據')
    const hasContact = db().isolations?.some((i) => i.patientId === a.patientId && i.kind === 'contact' && !i.endedAt)
    const d = await I.decideInfection(c.id, true, '符合收案定義')
    ok(d.status === 'confirmed' && d.suggestIsolation === !hasContact, `判定成立${d.suggestIsolation ? '，提醒可以開接觸隔離（不自動開）' : ''}`)
    let msg = await errOf(() => I.decideInfection(c.id, false, 'x'))
    ok(msg.includes('已經判定'), '只能判定一次')
    if (seed) {
      const r = await I.decideInfection(seed.id, false, '入院時已有症狀')
      ok(r.status === 'rejected', '不成立')
    }

    // 品質指標：每千管路日
    await as('nurse01')
    const ward = db().beds.find((b) => b.id === a.bedId).ward
    const st = await L.wardLineStats(ward, 30)
    const foley = st.rows.find((r) => r.kind === 'foley')
    ok(foley.infections === 1 && foley.infectionRate === api.per1000(1, foley.lineDays) && st.rows.find((r) => r.kind === 'pivc').infections === undefined, `品質指標：導尿管感染 ${foley.infections} 例、${foley.infectionRate}‰（不成立的不算）`)
  }

  // PCA：醫囑範圍與執照、雙人核對架設（扣住院藥局、進帳單與簿冊）、每 4 小時紀錄（警示、處置）、疼痛評估、醫師處理警示、
  // 結束剩餘量雙人銷毀（簿冊殘餘量）、出院擋、PCA 藥袋不能當一般醫囑
  console.log('\n[PCA]')
  {
    resetDb('small')
    const db = () => dbm.db
    const P = api.pcaApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.checkPcaInput({ bolusMg: 5, lockoutMin: 3, hourLimitMg: 30, basalMgH: 3 }).bolusMg && api.checkPcaInput({ bolusMg: 2, lockoutMin: 10, hourLimitMg: 2, basalMgH: 1 }).hourLimitMg?.includes('不能低於') && !Object.keys(api.checkPcaInput({ bolusMg: 1, lockoutMin: 10, hourLimitMg: 6, basalMgH: 0 })).length, '醫囑範圍：單次、鎖定、上限不能低於單次＋基礎')
    ok(api.pcaMaxPerHour({ bolusMg: 1, lockoutMin: 10, hourLimitMg: 6, basalMgH: 0.5 }) === 6 && api.pcaMaxPerHour({ bolusMg: 1, lockoutMin: 15, hourLimitMg: 10, basalMgH: 0 }) === 4, '每小時理論最多：受鎖定與上限限制')
    ok(api.pcaAlert({ sedation: 3, resp: 14 }) && api.pcaAlert({ sedation: 1, resp: 9 }) && !api.pcaAlert({ sedation: 2, resp: 10 }), '警示：鎮靜 ≥3 或呼吸 <10')
    ok(api.pcaRecordDue('2026-11-17 08:00', '2026-11-17 11:45').status === 'due' && api.pcaRecordDue('2026-11-17 08:00', '2026-11-17 12:01').status === 'overdue', '每 4 小時紀錄（到期前 30 分鐘提醒）')
    ok(api.checkPcaRecord({ demands: 3, delivered: 5, usedMl: 10, pain: 3, sedation: 1, resp: 14 }, 20, 100).delivered && api.checkPcaRecord({ demands: 3, delivered: 2, usedMl: 10, pain: 3, sedation: 1, resp: 14 }, 20, 100).usedMl, '紀錄：給藥不能多於按壓、累計用量只增不減')

    // 種子
    const seed = db().pcas.find((p) => p.id === 'PCA-SEED-1')
    if (seed) {
      const a0 = db().admissions.find((a) => a.id === seed.admissionId)
      await as(db().users.find((u) => u.doctorId === a0.doctorId).username)
      ok((await api.dashboardApi.getDashboard()).pcaAlerts >= 1, '種子：PCA 鎮靜 3、呼吸 9 → 主治首頁「PCA 警示待處理」')
      await as('nurse01')
      const wp = (await api.nursingApi.listWardPatients(db().beds.find((b) => b.id === a0.bedId).ward)).find((p) => p.id === a0.id)
      ok(wp.pca?.alert && wp.pca.status === 'running', '護理站清單標 PCA（警示）')
      ok(db().stockTxns.some((t) => t.id === seed.setup.txnId && t.ref === `PCA ${a0.admitNo}` && t.witnessBy === 'U202'), '種子：架設時住院藥局扣一袋（簿冊有見證人）')
    }

    // 開 PCA：藥袋不能當一般醫囑；範圍；執照
    const a = db().admissions.find((x) => x.status === 'admitted' && !x.obs && !db().pcas.some((p) => p.admissionId === x.id))
    const docU = db().users.find((u) => u.doctorId === a.doctorId)
    await as(docU.username)
    let msg = await errOf(() => api.ipdApi.addOrder({ admissionId: a.id, type: 'long', category: 'medication', drugId: 'M045', content: '', dose: 1, freq: 'PRN', route: 'IV' }))
    ok(msg.includes('PCA'), `PCA 藥袋不能當一般醫囑 → 「${msg}」`)
    let f = await fieldsOf(() => P.orderPca(a.id, { drugId: 'M045', bolusMg: 5, lockoutMin: 10, hourLimitMg: 6, basalMgH: 0 }))
    ok(f.bolusMg, '單次劑量超過範圍擋')
    const doc = db().doctors.find((d) => d.id === a.doctorId)
    const lic = doc.controlledLicense
    doc.controlledLicense = { no: lic?.no ?? 'x', validUntil: '2020-01-01' }
    f = await fieldsOf(() => P.orderPca(a.id, { drugId: 'M045', bolusMg: 1, lockoutMin: 10, hourLimitMg: 6, basalMgH: 0 }))
    ok(f.drugId?.includes('管制藥'), `管制藥執照過期不能開 → 「${f.drugId}」`)
    db().doctors.find((d) => d.id === a.doctorId).controlledLicense = lic // 失敗的 mutate 會回滾換新物件：重新 find 再改回
    let p = await P.orderPca(a.id, { drugId: 'M045', bolusMg: 1, lockoutMin: 10, hourLimitMg: 6, basalMgH: 0 })
    ok(p.status === 'ordered' && p.maxPerHour === 6, '開 PCA：待架設（每小時最多 6 mg）')
    msg = await errOf(() => P.orderPca(a.id, { drugId: 'M045', bolusMg: 1, lockoutMin: 10, hourLimitMg: 6, basalMgH: 0 }))
    ok(msg.includes('已經有一筆'), '同時只能一筆')
    await as('nurse01')
    await expectError(() => P.orderPca(a.id, { drugId: 'M045', bolusMg: 1, lockoutMin: 10, hourLimitMg: 6, basalMgH: 0 }), '護理師開 PCA')
    const ward = db().beds.find((b) => b.id === a.bedId).ward
    ok((await api.nursingApi.listWardTasks(ward)).some((t) => t.kind === 'pca' && t.text.includes('架設')), '本班待辦：新開的 PCA 待架設')

    // 架設：要雙人
    f = await fieldsOf(() => P.setupPca(p.id))
    ok(f.witness, '沒有第二位護理師核對不能架設')
    const w1 = await api.witnessApi.approveWitness({ purpose: 'pca', pcaId: p.id, stage: 'setup', username: 'nurse01', password: '1234' })
    ok(!w1.ok, '不能自己核對自己')
    const w2 = await api.witnessApi.approveWitness({ purpose: 'pca', pcaId: p.id, stage: 'setup', username: 'nurse02', password: '1234' })
    const stockBefore = db().drugLots.filter((l) => l.drugId === 'M045').reduce((n, l) => n + l.qty, 0)
    p = await P.setupPca(p.id, w2.token)
    ok(p.status === 'running' && p.setupWitnessName === '孫佩君' && db().drugLots.filter((l) => l.drugId === 'M045').reduce((n, l) => n + l.qty, 0) === stockBefore - 1, '雙人核對架設：使用中、住院藥局扣一袋')
    await as('clerk01')
    ok((await api.ipdChargeApi.getIpdBill(a.id)).bill.lines.some((l) => l.name.startsWith('Morphine PCA')), '住院帳單有 PCA 藥袋')

    // 紀錄：疼痛算疼痛評估；警示要處置
    await as('nurse01')
    f = await fieldsOf(() => P.recordPca(p.id, { demands: 4, delivered: 2, usedMl: 3, pain: 3, sedation: 3, resp: 12 }))
    ok(f.note, '有警示要寫處置')
    let r = await P.recordPca(p.id, { demands: 4, delivered: 2, usedMl: 3, pain: 5, sedation: 1, resp: 14 })
    ok(!r.warning && r.pca.usedMl === 3, '紀錄：沒有警示')
    const wp2 = (await api.nursingApi.listWardPatients(ward)).find((x) => x.id === a.id)
    ok(wp2.painScore === 5 && wp2.painReassess === 'upcoming' && wp2.painThisShift, 'PCA 紀錄的疼痛算疼痛評估（本班已評、≥4 要重評）')
    r = await P.recordPca(p.id, { demands: 9, delivered: 5, usedMl: 8, pain: 2, sedation: 3, resp: 9, note: '暫停 PCA、給氧' })
    ok(r.warning?.includes('通知醫師') && r.pca.openAlert, `警示：「${r.warning}」`)
    await as(docU.username)
    ok((await api.dashboardApi.getDashboard()).pcaAlerts >= 1, '主治首頁：PCA 警示待處理')
    f = await fieldsOf(() => P.ackPcaAlert(p.id, ''))
    ok(f.note, '處理警示要寫處置')
    p = await P.ackPcaAlert(p.id, '停止 PCA、改口服止痛')
    ok(!p.openAlert && p.alertAck, '醫師處理後警示解除')

    // 出院擋
    await as('clerk01')
    db().admissions.find((x) => x.id === a.id).dischargeSummary = { ...(db().admissions.find((x) => x.id === a.id).dischargeSummary ?? {}), signedAt: nowStr(), dischargeType: '改善出院', doctorId: a.doctorId }
    msg = await errOf(() => api.admissionApi.discharge(a.id, { confirmUnfinished: true }))
    ok(msg.includes('PCA'), `PCA 還沒結束不能出院 → 「${msg}」`)

    // 結束：剩餘量雙人銷毀 → 管制藥簿冊殘餘量
    await as('nurse01')
    f = await fieldsOf(() => P.endPca(p.id, { reason: '醫師停止（改口服止痛）', residualMl: 92 }))
    ok(f.witness, '剩餘量銷毀要見證')
    const w3 = await api.witnessApi.approveWitness({ purpose: 'pca', pcaId: p.id, stage: 'end', username: 'nurse02', password: '1234' })
    f = await fieldsOf(() => P.endPca(p.id, { reason: '醫師停止（改口服止痛）', residualMl: 150, witness: w3.token }))
    ok(f.residualMl, '剩餘量不能超過一袋')
    p = await P.endPca(p.id, { reason: '醫師停止（改口服止痛）', residualMl: 92, witness: w3.token })
    ok(p.status === 'ended' && p.end.residualMl === 92 && p.endWitnessName === '孫佩君', '結束：剩餘 92 ml 雙人銷毀')
    await as('ph01')
    const L = await api.controlledApi.controlledLedger({ drugId: 'M045', locationId: db().stockLocations.find((l) => l.dispensesIpd).id, from: dateUtil.addDays(T, -1), to: T })
    const res = L.rows.find((x) => x.kind === 'residual' && x.reason.includes('92 ml'))
    ok(res && res.qty === 0.92 && res.witnessName === '孫佩君' && L.rows.some((x) => x.kind === 'out' && x.ref === `PCA ${a.admitNo}`), `管制藥簿冊：架設那袋支出、殘餘量 0.92 袋銷毀（見證人）`)
  }

  // 換班與請假：請假（自己的班、假別、原因、護理長核准後從班表拿掉）、換班（對方同意 → 核准 → 交換；同一天兩班擋、休息不足提醒）、撤回、首頁
  console.log('\n[換班與請假]')
  {
    resetDb('small')
    const db = () => dbm.db
    const R = api.shiftRequestApi
    const { addDays } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.restProblems([{ date: '2026-11-17', shift: '小夜' }, { date: '2026-11-18', shift: '大夜' }])[0]?.includes('0 小時') && !api.restProblems([{ date: '2026-11-17', shift: '小夜' }, { date: '2026-11-18', shift: '白班' }]).length, '休息：小夜接隔天大夜 0 小時（提醒）、小夜接隔天白班 8 小時（不提醒）')

    // 種子
    await as('nurse01')
    let L = await R.listShiftRequests()
    const seedSwap = L.toRespond.find((r) => r.id === 'SRQ-SEED-1')
    ok(seedSwap && (await api.dashboardApi.getDashboard()).swapToRespond >= 1, '種子：nurse04 請 nurse01 換班（nurse01 首頁「別人請我換班」）')
    await as('nurse02')
    L = await R.listShiftRequests()
    ok(L.canApprove && L.toApprove.some((r) => r.id === 'SRQ-SEED-2') && (await api.dashboardApi.getDashboard()).shiftRequestsToApprove >= 1, '種子：nurse05 特休待護理長（nurse02）核准')

    // 請假
    await as('nurse06')
    const mine = await R.myUpcomingShifts()
    const s1 = mine.find((x) => x.date >= addDays(T, 2))
    let f = await fieldsOf(() => R.requestLeave({ shiftId: s1.id, leaveType: '', reason: '' }))
    ok(f.leaveType, '假別要選')
    const other = db().nurseShifts.find((x) => x.nurseId !== db().users.find((u) => u.username === 'nurse06').id && x.date >= T)
    let msg = await errOf(() => R.requestLeave({ shiftId: other.id, leaveType: '特休', reason: 'x' }))
    ok(msg.includes('自己的班'), '只能申請自己的班')
    const past = db().nurseShifts.find((x) => x.nurseId === db().users.find((u) => u.username === 'nurse06').id && x.date < T)
    msg = await errOf(() => R.requestLeave({ shiftId: past.id, leaveType: '特休', reason: 'x' }))
    ok(msg.includes('過去'), '過去的班不能申請')
    const lv = await R.requestLeave({ shiftId: s1.id, leaveType: '病假', reason: '發燒' })
    ok(lv.status === 'pending' && lv.text.includes('病假'), '請假申請：等護理長核准')
    msg = await errOf(() => R.requestLeave({ shiftId: s1.id, leaveType: '特休', reason: 'x' }))
    ok(msg.includes('申請中'), '同一班不能重複申請')
    await expectError(() => R.decideShiftRequest(lv.id, true), '一般護理師核准')
    await as('nurse02')
    f = await fieldsOf(() => R.decideShiftRequest(lv.id, false, ''))
    ok(f.note, '退回要寫原因')
    const okLv = await R.decideShiftRequest(lv.id, true)
    ok(okLv.status === 'approved' && !db().nurseShifts.some((x) => x.id === s1.id), '核准請假：從班表拿掉')
    await as('nurse06')
    ok((await api.dashboardApi.getDashboard()).myRequestResults >= 1 && (await R.listShiftRequests()).mine.find((r) => r.id === lv.id).status === 'approved', '申請人首頁：申請有結果')

    // 換班：nurse07 和 nurse08 同一天的班互換
    const id7 = db().users.find((u) => u.username === 'nurse07').id
    const id8 = db().users.find((u) => u.username === 'nurse08').id
    const day = [2, 3, 4, 5, 6, 8, 9].map((k) => addDays(T, k)).find((d) => db().nurseShifts.some((x) => x.nurseId === id7 && x.date === d) && db().nurseShifts.some((x) => x.nurseId === id8 && x.date === d))
    const a7 = db().nurseShifts.find((x) => x.nurseId === id7 && x.date === day)
    const b8 = db().nurseShifts.find((x) => x.nurseId === id8 && x.date === day)
    await as('nurse07')
    const cands = await R.swapCandidates(a7.id, day)
    ok(cands.some((c) => c.id === b8.id && !c.block), '換班對象：同一天別人的班')
    // 換到別天：自己那天已經有班 → 擋
    const dayOther = addDays(day, 1)
    const c7 = db().nurseShifts.find((x) => x.nurseId === id7 && x.date === dayOther)
    const x8 = db().nurseShifts.find((x) => x.nurseId !== id7 && x.date === dayOther && !db().shiftRequests.some((r) => ['pending', 'pending-peer'].includes(r.status) && (r.shiftId === x.id || r.targetShiftId === x.id)))
    if (c7 && x8) {
      f = await fieldsOf(() => R.requestSwap({ shiftId: a7.id, targetShiftId: x8.id, reason: 'x' }))
      ok(f.targetShiftId?.includes('兩班'), `換完同一天兩班擋 → 「${f.targetShiftId}」`)
    }
    const sw = await R.requestSwap({ shiftId: a7.id, targetShiftId: b8.id, reason: '家裡有事' })
    ok(sw.status === 'pending-peer', '換班申請：等對方同意')
    await as('nurse02')
    msg = await errOf(() => R.decideShiftRequest(sw.id, true))
    ok(msg.includes('還沒同意'), '對方還沒同意，護理長不能核准')
    await as('nurse09')
    await expectError(() => R.respondSwap(sw.id, true), '別人回覆換班')
    await as('nurse08')
    f = await fieldsOf(() => R.respondSwap(sw.id, false, ''))
    ok(f.note, '不同意要寫原因')
    const resp = await R.respondSwap(sw.id, true)
    ok(resp.status === 'pending', '對方同意：等護理長核准')
    await as('nurse02')
    const ap = await R.decideShiftRequest(sw.id, true)
    ok(ap.status === 'approved' && db().nurseShifts.find((x) => x.id === a7.id).nurseId === id8 && db().nurseShifts.find((x) => x.id === b8.id).nurseId === id7, '核准換班：兩班交換')
    // 撤回
    await as('nurse07')
    const mine7 = (await R.myUpcomingShifts()).find((x) => x.date > day)
    const lv2 = await R.requestLeave({ shiftId: mine7.id, leaveType: '事假', reason: 'x' })
    const cc = await R.cancelShiftRequest(lv2.id)
    ok(cc.status === 'cancelled', '處理前可以撤回')
    msg = await errOf(() => R.cancelShiftRequest(sw.id))
    ok(msg.includes('已經處理'), '處理過的不能撤回')
    // 核准前班表被改：要退回
    const lv3 = await R.requestLeave({ shiftId: mine7.id, leaveType: '事假', reason: 'y' })
    await as('nurse02')
    await api.staffingApi.setShiftNurses(mine7.ward, mine7.date, mine7.shift, [])
    msg = await errOf(() => R.decideShiftRequest(lv3.id, true))
    ok(msg.includes('班表已經改過'), `核准前班表被改過 → 「${msg}」`)
  }

  // 出院準備：篩選（系統自動勾、兩項收案、72 小時）→ 需求評估 → 轉介（送出、回覆）→ 出院後 7 天追蹤；權限；簽准出院提醒不擋
  console.log('\n[出院準備]')
  {
    resetDb('small')
    const db = () => dbm.db
    const P = api.dischargePlanApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.planScreenDue('2026-11-14 08:00', false, '2026-11-17 08:01').status === 'overdue' && api.planScreenDue('2026-11-14 08:00', false, '2026-11-16 21:00').status === 'due' && api.planScreenDue('2026-11-14 08:00', false, '2026-11-15 08:00').status === 'todo', '篩選 72 小時：最後 12 小時快到期、過了逾時')
    ok(api.followUpDue('2026-11-10 10:00', false, '2026-11-17 10:01').status === 'overdue' && api.followUpDue('2026-11-10 10:00', false, '2026-11-16 10:00').status === 'due', '出院後 7 天追蹤')
    ok(api.planUnreferred({ enrolled: true, needs: ['ltc'], referrals: [] }) && !api.planUnreferred({ enrolled: true, needs: ['teach'], referrals: [] }) && !api.planUnreferred({ enrolled: true, needs: ['ltc'], referrals: [{ sentAt: 'x' }] }), '收案有需求沒送轉介才提醒（只有照顧技巧指導不用轉介）')

    // 種子
    const ready = db().admissions.find((a) => a.status === 'admitted' && a.dischargeSummary?.signedAt)
    await as('nurse03')
    let work = await P.listPlanWork()
    if (ready && db().dischargePlans.some((p) => p.admissionId === ready.id)) {
      ok(work.some((x) => x.admissionId === ready.id && x.stage === 'refer' && x.dischargeReady && x.overdue), '種子：准出院的病人收案未轉介（排最前、標逾時）')
      ok((await api.admissionApi.getAdmission(ready.id)).planUnreferred, '住院資訊標「未轉介」（醫師、住院中心看得到）')
    }
    ok(work.some((x) => x.stage === 'screen'), '種子：最近入院的病人待篩選')
    const followSeed = db().dischargePlans.find((p) => p.referrals.some((r) => r.id === 'DRF-SEED-3'))
    if (followSeed) ok(work.some((x) => x.admissionId === followSeed.admissionId && x.stage === 'follow') && (await api.dashboardApi.getDashboard()).planFollowUp >= 1, '種子：出院後待電話追蹤（逾時，首頁）')

    // 權限：預設所有護理師；醫師只看
    const a = db().admissions.find((x) => x.status === 'admitted' && !x.obs && !db().dischargePlans.some((p) => p.admissionId === x.id))
    const docU = db().users.find((u) => u.doctorId === a.doctorId).username
    await as(docU)
    ok(!(await P.patientPlan(a.id)).canEdit, '醫師只看')
    await expectError(() => P.screenPlan(a.id, ['alone']), '醫師篩選')
    await as('nurse01')
    const pp = await P.patientPlan(a.id)
    ok(pp.canEdit && pp.plannable && pp.screen.status !== 'done', '護理師（預設有權限）可以篩選')

    // 篩選：一項不收、兩項收（系統自動勾的一定算）
    let v = await P.screenPlan(a.id, [])
    ok(v.enrolled === (pp.auto.length >= 2) && v.criteria.every((c) => pp.auto.includes(c)), `只有系統判斷的 ${pp.auto.length} 項：${v.enrolled ? '收案' : '不收案'}`)
    v = await P.screenPlan(a.id, ['alone', 'adl', 'age65'])
    ok(v.enrolled && v.criteria.includes('alone') && v.criteria.includes('adl') && (v.criteria.includes('age65') === pp.auto.includes('age65')), '重篩：獨居＋日常生活需協助 → 收案；系統判斷的條件不能手動勾')
    let msg = await errOf(() => P.addPlanReferral(a.id, { kind: 'ltc', agency: '市長期照顧管理中心' }))
    ok(msg.includes('需求評估'), '先評估需求才能轉介')
    let f = await fieldsOf(() => P.saveNeeds(a.id, { needs: [], assessment: '' }))
    ok(f.needs, '需求至少一項')
    v = await P.saveNeeds(a.id, { needs: ['ltc', 'aids'], assessment: '獨居，行動需助行器' })
    ok(v.needsText.length === 2 && v.unreferred, '需求評估：長照、輔具 → 還沒轉介（提醒）')
    ok((await api.admissionApi.getAdmission(a.id)).planUnreferred, '醫師簽准出院時看得到提醒')
    f = await fieldsOf(() => P.addPlanReferral(a.id, { kind: 'ltc', agency: '' }))
    ok(f.agency, '轉介單位必填')
    v = await P.addPlanReferral(a.id, { kind: 'ltc', agency: '市長期照顧管理中心' })
    const rid = v.referrals[0].id
    msg = await errOf(() => P.addPlanReferral(a.id, { kind: 'ltc', agency: 'x' }))
    ok(msg.includes('還沒回覆'), '同一種轉介同時一張')
    msg = await errOf(() => P.replyPlanReferral(a.id, rid, { status: 'approved' }))
    ok(msg.includes('還沒送出'), '還沒送出不能記回覆')
    v = await P.sendPlanReferral(a.id, rid)
    const sentAt = v.referrals[0].sentAt
    ok(sentAt && !v.unreferred, '列印送出：記送出時間，不再提醒')
    v = await P.sendPlanReferral(a.id, rid)
    ok(v.referrals[0].sentAt === sentAt, '重印不改送出時間')
    f = await fieldsOf(() => P.replyPlanReferral(a.id, rid, { status: 'denied' }))
    ok(f.note, '未核定要寫原因')
    v = await P.replyPlanReferral(a.id, rid, { status: 'approved', note: '居家服務每週 8 小時' })
    ok(v.referralViews[0].reply.status === 'approved', '記核定')
    msg = await errOf(() => P.screenPlan(a.id, []))
    ok(msg.includes('已經有轉介單'), '有轉介不能改成不收案')
    msg = await errOf(() => P.recordFollowUp(a.id, { reached: true, result: 'x' }))
    ok(msg.includes('還沒出院'), '還沒出院不能追蹤')

    // 出院後追蹤
    db().admissions.find((x) => x.id === a.id).status = 'discharged'
    db().admissions.find((x) => x.id === a.id).dischargedAt = dateUtil.addMinutes(nowStr(), -24 * 60)
    work = await P.listPlanWork()
    ok(work.some((x) => x.admissionId === a.id && x.stage === 'follow' && !x.overdue), '出院後：待電話追蹤')
    f = await fieldsOf(() => P.recordFollowUp(a.id, { reached: false, result: '' }))
    ok(f.result?.includes('聯絡不到'), '聯絡不到也要寫情形')
    v = await P.recordFollowUp(a.id, { reached: true, result: '居服員已到府，案女照顧中' })
    ok(v.followUp.reached && !(await P.listPlanWork()).some((x) => x.admissionId === a.id), '追蹤完成：不在清單')

    // 只交給個管師：取消護理師角色後，只有 nurse03
    await as('admin')
    await api.permissionApi.savePermissionRoles('discharge.plan', { roles: [], reason: '交給出院準備個管師', confirm: true })
    await as('nurse01')
    const b = db().admissions.find((x) => x.status === 'admitted' && !x.obs && x.id !== a.id && !db().dischargePlans.find((p) => p.admissionId === x.id)?.referrals.length)
    db().dischargePlans = db().dischargePlans.filter((p) => p.admissionId !== b?.id)
    if (b) {
      await expectError(() => P.screenPlan(b.id, ['alone']), '角色取消後一般護理師篩選')
      await as('nurse03')
      ok((await P.screenPlan(b.id, ['alone'])).screenedByName === '林佳穎', '被指定的個管師（nurse03）照樣可以')
    }
  }

  // 加護病房：床位（預約住院不能直接報到、急診收住院可以、轉床可以）、重症流程表（每小時；GCS、瞳孔、MAP；生命徵象同一套檢查）、
  // 漏記 75 分鐘（待辦、首頁、看板）、每小時輸入輸出（點滴自動算）與 24 小時平衡、護病比 1:2、加護病房的每日計費
  console.log('\n[加護病房]')
  {
    dbm.resetDatabase('small') // 要用種子的分床（加護病房這一班的責任護理師）：不用 resetDb（它會清掉分床）
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const I = api.icuApi
    const ICU = '3I 加護病房'
    const { addMinutes } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.mapOf(90, 50) === 63 && api.mapLow(63) && !api.mapLow(65) && api.mapOf(90, undefined) === undefined, 'MAP＝（收縮壓＋2×舒張壓）÷3；<65 偏低')
    ok(api.gcsTotal({ e: 3, v: 4, m: 6 }) === 13 && api.gcsLow({ e: 1, v: 2, m: 5 }) && !api.gcsLow({ e: 3, v: 4, m: 6 }), 'GCS 總分、≤8 昏迷')
    let e = api.checkNeuro({ gcs: { e: 3 }, pupils: { l: 3 } })
    ok(e.gcsV && e.gcsM && !e.gcsE && e.pupilR && e.lightL && e.lightR, 'GCS 三項、瞳孔兩側與光反射要一起記')
    e = api.checkNeuro({ gcs: { e: 5, v: 0, m: 6 }, pupils: { l: 3.3, r: 10, lightL: 'brisk', lightR: 'none' } })
    ok(e.gcsE && e.gcsV && !e.gcsM && e.pupilL && e.pupilR && !e.lightL, 'GCS 範圍（E 1–4、V 1–5、M 1–6）、瞳孔 1–9 mm 以 0.5 為單位')
    ok(Object.keys(api.checkNeuro({})).length === 0, '都不記也可以（只記生命徵象）')
    const hs = api.hourlyState('2026-11-17 08:00', '2026-11-16 20:00', '2026-11-17 09:16')
    ok(hs.late && hs.minutes === 76 && hs.dueAt === '2026-11-17 09:15' && !api.hourlyState('2026-11-17 08:00', '2026-11-16 20:00', '2026-11-17 09:15').late && api.hourlyState(undefined, '2026-11-17 09:00', '2026-11-17 09:30').minutes === 30, '超過 75 分鐘沒記＝漏記；還沒記過從轉入時間算')
    ok(api.icuCheckInProblem(false)?.includes('預約住院') && !api.icuCheckInProblem(true), '預約住院不能直接排加護病房、急診收住院可以')

    // 種子：8 床、敗血症病人住加護病房，流程表最後一筆在 80 分鐘以前（漏記）
    const icuBeds = db().beds.filter((b) => b.ward === ICU)
    ok(icuBeds.length === 9 && icuBeds.every((b) => b.bedClass === '健保床' && b.extraFee === 0) && icuBeds.filter((b) => b.negativePressure).map((b) => b.bedNo).join() === 'ICU9', '種子：加護病房 ICU1–ICU9（健保床；ICU9 是負壓床）')
    const sep = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('A41'))
    const sepBed = db().beds.find((b) => b.id === sep.bedId)
    ok(sepBed.ward === ICU && db().admissions.filter((a) => a.status === 'admitted' && db().beds.find((b) => b.id === a.bedId)?.ward === ICU).length === 2, `種子：敗血症病人住 ${sepBed.bedNo}（另一位是申請轉入的糖尿病酮酸中毒）`)
    const hourly = db().vitals.filter((v) => v.admissionId === sep.id && v.hourly)
    const lastAt = hourly.map((v) => v.at).sort().pop()
    ok(hourly.length >= 10 && lastAt <= addMinutes(nowStr(), -80) && hourly.some((v) => v.gcs && v.pupils) && hourly.some((v) => api.mapLow(api.mapOf(v.sbp, v.dbp))), `種子：流程表 ${hourly.length} 筆（有 GCS、瞳孔、MAP 偏低），最後一筆 ${lastAt.slice(11)}`)
    const hourlyFrom = hourly.map((v) => v.at).sort()[0]
    ok(!db().vitals.some((v) => v.admissionId === sep.id && !v.hourly && v.at >= hourlyFrom && v.at <= lastAt), '流程表那段時間沒有重複的一般生命徵象')
    const dutyNurse = db().nurseAssignments.find((x) => x.admissionId === sep.id)?.nurseId
    const dutyUser = db().users.find((u) => u.id === dutyNurse)
    ok(!!dutyUser && /^nurse1[3-6]$/.test(dutyUser.username), `種子：這一班分給加護病房的護理師（${dutyUser?.name}）`)
    await as(dutyUser.username)
    const asg = await api.staffingApi.getAssignments(ICU)
    ok(asg.nurses.length === 1 && asg.ratio.text.includes('上限 1：2') && !asg.ratio.over, `加護病房護病比 ${asg.ratio.text}`)
    let wp = (await api.nursingApi.listWardPatients(ICU)).find((p) => p.id === sep.id)
    ok(wp.icu?.late && wp.icu.minutes >= 80, `護理站病人清單：流程表 ${wp.icu?.minutes} 分鐘沒記`)
    ok((await api.nursingApi.listWardTasks(ICU)).some((t) => t.kind === 'icu' && t.admissionId === sep.id && t.urgency === 'overdue'), '本班待辦：重症流程表漏記（逾時）')
    ok((await api.dashboardApi.getDashboard()).icuHourlyLate === 1, '護理師首頁：重症流程表漏記 1 位')
    let board = await I.icuBoard()
    ok(board.length === 9 && board.find((b) => b.admissionId === sep.id)?.late && board.find((b) => b.admissionId === sep.id)?.nurseName === dutyUser.name && board.filter((b) => !b.admissionId).length === 7, '床邊看板：9 床（2 床有人）、敗血症紅框（漏記）、責任護理師')
    const sb = board.find((b) => b.admissionId === sep.id)
    ok(sb.neuro?.gcs && sb.neuro.pupils && !sb.last.gcs ? sb.neuro.gcs.at < sb.last.at : !!sb.neuro?.gcs, '看板：最新一筆沒評意識時，顯示最近一次的 GCS、瞳孔（附時間）')
    let fs = await I.getFlowsheet(sep.id)
    ok(fs.inIcu && fs.canRecord && fs.hours.length === 24 && fs.state?.late && fs.since === sep.admittedAt, '流程表：今天 24 欄、轉入時間、漏記')
    ok(fs.day.intake === fs.shifts.reduce((n, s) => n + s.intake, 0) && fs.day.balance === fs.day.intake - fs.day.output, '三班加起來＝24 小時；平衡＝輸入－輸出')

    // 記一筆：錯誤一次標出（生命徵象範圍、GCS、瞳孔、疼痛處置）
    let f = await fieldsOf(() => I.addFlowsheetEntry({ admissionId: sep.id, sbp: 300, pain: 6, gcs: { e: 3 }, pupils: { l: 3 } }))
    ok(f.sbp && f.gcsV && f.gcsM && f.pupilR && f.lightL, '收縮壓不合理、GCS 缺項、瞳孔缺項一次標出')
    f = await fieldsOf(() => I.addFlowsheetEntry({ admissionId: sep.id, pain: 6 }))
    ok(f.painAction, '疼痛 ≥4 要寫處置（和生命徵象同一條）')
    let msg = await errOf(() => I.addFlowsheetEntry({ admissionId: sep.id }))
    ok(msg.includes('至少輸入一項'), `什麼都沒記 → 「${msg}」`)
    const before = db().vitals.length
    const c = await I.addFlowsheetEntry({ admissionId: sep.id, temp: 37.9, pulse: 104, resp: 22, sbp: 88, dbp: 50, spo2: 95, intake: 200, output: 80, gcs: { e: 3, v: 4, m: 6 }, pupils: { l: 3, r: 4, lightL: 'brisk', lightR: 'sluggish' } })
    ok(c.map === 63 && c.gcsSum === 13 && c.abnormal.includes('MAP') && c.abnormal.includes('瞳孔不等大') && c.abnormal.includes('脈搏') && db().vitals.length === before + 1 && db().vitals.at(-1).hourly, '記一筆：MAP 63、GCS 13、瞳孔不等大都標異常；寫進生命徵象')
    ok((await api.nursingApi.listVitals(sep.id)).some((v) => v.id === c.id), '一般的生命徵象紀錄看得到（不用記兩次）')
    wp = (await api.nursingApi.listWardPatients(ICU)).find((p) => p.id === sep.id)
    ok(!wp.icu.late && wp.latestVitals.id === c.id && wp.measuredThisShift, '記了之後：不再漏記、最新生命徵象就是這筆、本班已量')
    ok(!(await api.nursingApi.listWardTasks(ICU)).some((t) => t.kind === 'icu') && (await api.dashboardApi.getDashboard()).icuHourlyLate === 0, '待辦、首頁的漏記消失')
    fs = await I.getFlowsheet(sep.id)
    const h = fs.hours.find((x) => x.hour === c.at.slice(11, 13))
    ok(h.cell?.id === c.id && h.io.manual >= 200 && h.io.output >= 80 && !fs.state.late && fs.state.lastAt === c.at, '這一小時的欄位：最新一筆、輸入輸出')
    const old = db().vitals.filter((v) => v.admissionId === sep.id && v.hourly && v.at < c.at.slice(0, 10)).map((v) => v.at.slice(0, 10))
    if (old.length) {
      const y = await I.getFlowsheet(sep.id, old[0])
      ok(y.hours.some((x) => x.cell) && !y.state, '前一天的流程表看得到（沒有漏記狀態）')
    }
    // 點滴依流速自動算進每小時輸入量（不用再記）
    const run = { id: 'IVR-ICU-T', admissionId: sep.id, orderId: 'IO-ICU-T', bagNo: 1, startAt: `${c.at.slice(0, 13)}:00`, startBy: dutyNurse, rateMlH: 60, rateChanges: [], txnIds: [] }
    db().ipdOrders.push({ id: 'IO-ICU-T', admissionId: sep.id, type: 'long', category: 'medication', content: '生理食鹽水', infusion: { volumeMl: 500, rateMlH: 60, additives: [] }, startAt: run.startAt, status: 'active', doctorId: sep.doctorId, createdAt: run.startAt })
    db().infusions.push(run)
    fs = await I.getFlowsheet(sep.id)
    const h2 = fs.hours.find((x) => x.hour === c.at.slice(11, 13))
    ok(h2.io.iv > 0 && h2.io.intake === h2.io.manual + h2.io.iv + h2.io.tube, `點滴依流速自動算進輸入量（這一小時 ${h2.io.iv} ml）`)
    db().infusions = db().infusions.filter((r) => r.id !== run.id)
    db().ipdOrders = db().ipdOrders.filter((o) => o.id !== 'IO-ICU-T')

    // 誰能記、記給誰
    // 沒有隔離的（空氣隔離只能排單人房：加護病房的床不是單人房）
    const gen = db().admissions.find((a) => a.status === 'admitted' && !a.obs && !db().isolations.some((i) => i.patientId === a.patientId) && db().beds.find((b) => b.id === a.bedId)?.ward !== ICU && db().beds.find((b) => b.id === a.bedId)?.ward !== '急診留觀區')
    msg = await errOf(() => I.addFlowsheetEntry({ admissionId: gen.id, pulse: 80 }))
    ok(msg.includes('只給加護病房'), `一般病房的病人 → 「${msg}」`)
    ok(!(await api.nursingApi.listWardPatients(db().beds.find((b) => b.id === gen.bedId).ward)).find((p) => p.id === gen.id).icu, '一般病房的病人沒有流程表狀態')
    await as(db().users.find((u) => u.doctorId === sep.doctorId).username)
    await expectError(() => I.addFlowsheetEntry({ admissionId: sep.id, pulse: 80 }), '醫師記流程表')
    fs = await I.getFlowsheet(sep.id)
    ok(fs.hours.some((x) => x.cell) && !fs.canRecord, '醫師看得到流程表（唯讀）')

    // 床位：預約住院不能直接報到進加護病房；急診收住院可以；住院中轉床可以（轉入時間重新算）
    await as('clerk01')
    const resv = db().admissions.find((a) => a.status === 'reserved' && !a.obs && !(a.fromVisitId && db().visits.find((v) => v.id === a.fromVisitId)?.er))
    const icu2 = db().beds.find((b) => b.ward === ICU && b.status === 'empty')
    const blk = await api.admissionApi.bedBlocks(resv.id)
    ok(blk[icu2.id]?.includes('預約住院') && db().beds.filter((b) => b.ward === ICU && b.status === 'empty').every((b) => blk[b.id]), '選床畫面：加護病房的床標「不收預約住院」')
    msg = await errOf(() => api.admissionApi.checkIn(resv.id, icu2.id))
    ok(msg.includes('加護病房不收預約住院'), `預約住院報到進加護病房 → 「${msg}」`)
    const erV = db().visits.find((v) => v.er)
    if (erV) {
      db().admissions.find((a) => a.id === resv.id).fromVisitId = erV.id
      ok(!(await api.admissionApi.bedBlocks(resv.id))[icu2.id], '急診收住院：加護病房的床可以選')
      const av = await api.admissionApi.checkIn(resv.id, icu2.id)
      ok(av.bed?.ward === ICU, `急診收住院報到進 ${icu2.bedNo}`)
      await as(dutyUser.username)
      fs = await I.getFlowsheet(resv.id)
      ok(fs.inIcu && fs.canRecord && !fs.state.late && fs.state.minutes <= 1 && !fs.state.lastAt, '剛住進來：還沒記、從報到時間算')
      // 轉出要先寫轉出摘要（③）
      await as(db().users.find((u) => u.doctorId === db().admissions.find((a) => a.id === resv.id).doctorId).username)
      await api.icuMoveApi.writeIcuSummary(resv.id, { diagnosis: '測試', course: '測試', lines: '', todo: '測試' })
      await as('clerk01')
      await api.admissionApi.transferBed(resv.id, db().beds.find((b) => b.ward !== ICU && b.ward !== '急診留觀區' && b.status === 'empty' && b.bedClass === '健保床').id)
    }
    // 一般病房轉進加護病房（③：要主治申請、加護病房主治同意並選床）、再轉出
    const icu3 = db().beds.find((b) => b.ward === ICU && b.status === 'empty')
    msg = await errOf(() => api.admissionApi.transferBed(gen.id, icu3.id))
    ok(msg.includes('主治申請'), `沒有申請就轉床進加護病房 → 「${msg}」`)
    await as(db().users.find((u) => u.doctorId === gen.doctorId).username)
    const greq = await api.icuMoveApi.requestIcu(gen.id, { category: 'other', reason: '測試' })
    await as('dr03')
    await api.icuMoveApi.decideIcuRequest(greq.id, { accept: true, bedId: icu3.id })
    await as(dutyUser.username)
    fs = await I.getFlowsheet(gen.id)
    ok(fs.inIcu && fs.since >= addMinutes(nowStr(), -1) && !fs.state.late, '一般病房轉進加護病房：從轉入那一刻開始算')
    await I.addFlowsheetEntry({ admissionId: gen.id, pulse: 88, sbp: 120, dbp: 70 })
    const two = await api.staffingApi.getAssignments(ICU)
    ok(two.ratio.text.includes('1：3') && two.ratio.over, `加護病房 3 位病人、1 位護理師：${two.ratio.text} 標紅（不擋）`)
    await as('admin')
    f = await fieldsOf(() => api.staffingApi.saveRatio({ 白班: 7, 小夜: 11, 大夜: 15 }, 0))
    ok(f.icuRatio, '加護病房護病比 1–30')
    await api.staffingApi.saveRatio({ 白班: 7, 小夜: 11, 大夜: 15 }, 3)
    await as(dutyUser.username)
    ok(!(await api.staffingApi.getAssignments(ICU)).ratio.over && !(await api.staffingApi.getAssignments('5A 內科病房')).ratio.text.includes('上限 1：3'), '加護病房上限改 1:3：不再標紅；一般病房不受影響')
    await as('admin')
    await api.staffingApi.saveRatio({ 白班: 7, 小夜: 11, 大夜: 15 })
    ok(db().staffingSettings.icuRatio === 3, '只改一般病房時，加護病房的上限保留')
    await as(db().users.find((u) => u.doctorId === gen.doctorId).username)
    await api.icuMoveApi.writeIcuSummary(gen.id, { diagnosis: '測試', course: '測試', lines: '', todo: '測試' })
    await as('clerk01')
    const back = db().beds.find((b) => b.ward !== ICU && b.ward !== '急診留觀區' && b.status === 'empty' && b.bedClass === '健保床')
    await api.admissionApi.transferBed(gen.id, back.id)
    await as(dutyUser.username)
    fs = await I.getFlowsheet(gen.id)
    ok(!fs.inIcu && !fs.canRecord && fs.hours.some((x) => x.cell), '轉出後：流程表留著看，不能再記')
    msg = await errOf(() => I.addFlowsheetEntry({ admissionId: gen.id, pulse: 80 }))
    ok(msg.includes('只給加護病房'), '轉出後不能再記')

    // 計費：住加護病房的天數收加護病床的病房費、護理費，其他天收一般病床的
    const B = await load('/src/services/billing.ts')
    const daily = db().procedures.filter((p) => p.dailyFee)
    const S = db().billingSettings.ipdCopay ?? B.IPD_COPAY_DEFAULT
    const ident = db().identities.find((i) => !i.selfPay && !i.exempt) ?? db().identities[0]
    const bill = B.calcIpdChargeLines({ identity: ident, from: '2026-11-01', to: '2026-11-05', beds: [{ bedNo: 'ICU1', bedClass: '健保床', days: 3, extraFee: 0, icu: true }, { bedNo: '501-1', bedClass: '健保床', days: 1, extraFee: 0 }], daily, drugs: [], procedures: [], copay: S })
    const ln = (name) => bill.lines.find((l) => l.name === name)
    ok(ln('病房費（加護病床，每日）')?.qty === 3 && ln('護理費（加護病床，每日）')?.qty === 3 && ln('病房費（急性一般病床，每日）')?.qty === 1 && ln('護理費（急性一般病床，每日）')?.qty === 1 && bill.lines.find((l) => l.name.includes('住院診察費'))?.qty === 4, '帳單：加護病床 3 天、一般病床 1 天；住院診察費每天都收（4 天）')
    await as('clerk01')
    const st = await api.ipdChargeApi.getIpdStatement(sep.id)
    ok(st.bill.lines.some((l) => l.name === '病房費（加護病床，每日）') && !st.bill.lines.some((l) => l.name === '病房費（急性一般病床，每日）') && st.bill.lines.some((l) => l.name === '住院診察費（每日）'), '敗血症病人（一直住加護病房）的費用明細：只有加護病床的病房費、護理費，住院診察費照收')
  }

  // 呼吸器與鎮靜：呼吸器醫囑（模式欄位、要插管、限加護病房、DNR 擋）、改設定要原因（停舊開新、護理師核對）、停止可一起拔管、
  // 實測與 RASS 記在流程表（每 4 小時待辦）、鎮靜目標（超出列主治首頁）、每日脫離評估 SAT → SBT、GCS 插管記 T、CAM-ICU、VAP 與呼吸器日
  console.log('\n[呼吸器與鎮靜]')
  {
    dbm.resetDatabase('small') // 要用種子的分床
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const V = api.ventApi
    const I = api.icuApi
    const ICU = '3I 加護病房'
    const { addMinutes } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    let e = api.checkVentSetting({ mode: 'AC/VC', fio2: 20, peep: 8 })
    ok(e.fio2 && e.vt && e.rr && !e.peep, 'AC/VC 要潮氣量、呼吸次數；FiO2 21–100')
    e = api.checkVentSetting({ mode: 'PSV', fio2: 35, peep: 5 })
    ok(e.ps && !e.vt && !e.rr && !Object.keys(api.checkVentSetting({ mode: 'CPAP', fio2: 30, peep: 5 })).length && api.checkVentSetting({}).mode, 'PSV 要壓力支持；CPAP 只要 FiO2、PEEP；沒選模式')
    ok(api.checkVentSetting({ mode: 'AC/VC', fio2: 40.5, peep: 8, vt: 420, rr: 16 }).fio2, '設定要整數')
    const cl = api.cleanVentSetting({ mode: 'AC/VC', fio2: 40, peep: 8, vt: 420, rr: 16, ps: 10, pinsp: 20 })
    ok(cl.ps === undefined && cl.pinsp === undefined && api.ventText(cl) === 'AC/VC FiO2 40% PEEP 8 VT 420 RR 16', `只留這個模式的欄位：${api.ventText(cl)}`)
    ok(api.checkRassTarget(1, -1).max && !Object.keys(api.checkRassTarget(-2, 0)).length && api.checkRassTarget(-6, 0).min, 'RASS 目標：−5～+4、上限不能比下限低')
    ok(api.rassVsTarget(-3, { min: -2, max: 0 }) === 'deep' && api.rassVsTarget(1, { min: -2, max: 0 }) === 'light' && api.rassVsTarget(-1, { min: -2, max: 0 }) === 'in', 'RASS 比目標：太深、太淺、範圍內')
    const ev = (t) => api.everyHours('2026-11-17 08:00', '2026-11-17 06:00', 4, t).status
    ok(ev('2026-11-17 11:29') === 'ok' && ev('2026-11-17 11:30') === 'due' && ev('2026-11-17 12:01') === 'overdue', '每 4 小時：到期前 30 分鐘「現在」、過了「逾時」')
    ok(api.checkWean({ sat: 'fail', sbt: 'pass', note: 'x' }).sbt && api.checkWean({ sat: 'fail', sbt: 'na' }).note && !Object.keys(api.checkWean({ sat: 'pass', sbt: 'pass' })).length, 'SAT 沒過不做 SBT；沒過或不適合要寫原因')
    ok(api.intubationDnrProblem(['intubation']) && !api.intubationDnrProblem(['compress']) && api.ventDnrProblem(['ventilation']) && !api.ventDnrProblem(['intubation']), 'DNR：不插管擋氣管內管、不施行人工呼吸擋呼吸器')
    e = api.checkVentMeasure({ ppeak: 28 })
    ok(e.ventVt && e.ventRr && !e.ventPpeak && api.checkVentMeasure({ ppeak: 90, vt: 420, rr: 16 }).ventPpeak, '呼吸器實測三項一起記、範圍')
    ok(api.gcsText({ e: 3, v: 1, m: 6, vt: true }) === '10T E3VTM6' && !api.gcsLow({ e: 1, v: 1, m: 4, vt: true }), 'GCS 插管記 T（10T），插管的不判斷 ≤8')

    // 種子
    const sep = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('A41'))
    const docUser = db().users.find((u) => u.doctorId === sep.doctorId).username
    const dutyUser = db().users.find((u) => u.id === db().nurseAssignments.find((x) => x.admissionId === sep.id)?.nurseId)
    const ett = db().lines.find((l) => l.admissionId === sep.id && l.kind === 'ett' && !l.removedAt)
    const vos = db().ipdOrders.filter((o) => o.admissionId === sep.id && o.vent)
    ok(ett && vos.length === 2 && vos.filter((o) => o.status === 'active').length === 1 && vos.find((o) => o.status === 'active').vent.changeReason, '種子：敗血症插管（經口 7.5）、呼吸器兩筆（第二筆降氧、有原因）')
    ok(db().vitals.some((v) => v.admissionId === sep.id && v.hourly && v.gcs?.vt) && db().vitals.some((v) => v.admissionId === sep.id && v.rass !== undefined && v.vent), '種子：流程表插管後 GCS 記 T、有 RASS 與呼吸器實測')
    await as(docUser)
    let pv = await V.patientVent(sep.id)
    ok(pv.order?.text === 'AC/VC FiO2 40% PEEP 8 VT 420 RR 16' && pv.history.length === 1 && pv.intubation?.text === '經口 7.5' && pv.rass?.target?.min === -2 && pv.rass.last?.score === -3 && pv.rass.vs === 'deep' && pv.canDoctor, `呼吸器與鎮靜：${pv.order?.text}、RASS ${pv.rass?.last?.score} 比目標深`)
    let dash = await api.dashboardApi.getDashboard()
    ok(dash.rassOut === 1 && dash.weanDue === 1, '主治首頁：鎮靜超出目標 1、今日脫離評估 1')
    ok(pv.wean.due && pv.wean.recent.length <= 1, '今天還沒做脫離評估（昨天 SAT 沒過的紀錄留著）')
    await as(dutyUser.username)
    let safety = await api.deliriumApi.patientSafety(sep.id)
    ok(safety.target === '加護病房（CAM-ICU）', '加護病房的病人每班評 CAM-ICU（RASS −3 可以評）')
    let board = (await I.icuBoard()).find((b) => b.admissionId === sep.id)
    ok(board.vent === pv.order.text && board.rass?.score === -3 && board.rass.out && board.neuro?.gcs?.text.includes('T'), `看板：呼吸器設定、RASS 超出目標、GCS ${board.neuro?.gcs?.text}`)

    // 護理師：流程表記實測與 RASS
    let f = await fieldsOf(() => I.addFlowsheetEntry({ admissionId: sep.id, rass: 5, vent: { ppeak: 28 } }))
    ok(f.rass && f.ventVt && f.ventRr, 'RASS −5～+4、呼吸器三項一起記：一次標出')
    const c = await I.addFlowsheetEntry({ admissionId: sep.id, pulse: 96, sbp: 110, dbp: 62, rass: -4, vent: { ppeak: 38, vt: 410, rr: 18 }, gcs: { e: 2, vt: true, m: 5 } })
    ok(c.abnormal.includes('RASS') && c.abnormal.includes('尖峰壓') && c.gcsText === '8T E2VTM5' && !c.abnormal.includes('GCS'), '記一筆：RASS 超出目標、尖峰壓 >35 標異常；GCS 8T 不判斷 ≤8')
    safety = await api.deliriumApi.patientSafety(sep.id)
    ok(!safety.target && safety.rassSkip?.includes('−4'), `RASS −4：這一班先不評 CAM（${safety.rassSkip}）`)
    pv = await V.patientVent(sep.id)
    ok(pv.check?.status === 'ok' && pv.check.last?.ppeak === 38 && pv.rass?.status === 'ok' && pv.rass.last?.score === -4, '記了之後：實測、RASS 下次 4 小時後')
    ok(!pv.canDoctor && pv.canNurse, '護理師看得到、不能開醫囑')
    await expectError(() => V.orderVent(sep.id, { mode: 'AC/VC', fio2: 35, peep: 8, vt: 420, rr: 16 }), '護理師開呼吸器')
    // 拔管前要先停呼吸器（自拔照實記）
    let msg = await errOf(() => api.lineApi.removeLine(ett.id, '不需要了'))
    ok(msg.includes('還接著呼吸器'), `接著呼吸器移除氣管內管 → 「${msg}」`)

    // 醫師：改設定、鎮靜目標、脫離評估、停止
    await as(docUser)
    msg = await errOf(() => V.orderVent(sep.id, { mode: 'AC/VC', fio2: 40, peep: 8, vt: 420, rr: 16 }))
    ok(msg.includes('沒有要改'), `設定一樣 → 「${msg}」`)
    f = await fieldsOf(() => V.orderVent(sep.id, { mode: 'AC/VC', fio2: 35, peep: 8, vt: 420, rr: 16 }))
    ok(f.changeReason, '改設定要原因')
    f = await fieldsOf(() => V.orderVent(sep.id, { mode: 'PSV', fio2: 35, peep: 5, changeReason: '改脫離模式' }))
    ok(f.ps, '改 PSV 沒填壓力支持：欄位標出')
    const o2 = await V.orderVent(sep.id, { mode: 'AC/VC', fio2: 35, peep: 8, vt: 420, rr: 16, changeReason: '血氧穩定，降氧（脫離）' })
    const old = db().ipdOrders.find((o) => o.admissionId === sep.id && o.vent && o.status === 'stopped' && o.stopAt >= addMinutes(nowStr(), -1))
    ok(o2.text.includes('FiO2 35%') && !o2.acked && old && db().ipdOrders.filter((o) => o.admissionId === sep.id && o.vent && o.status === 'active').length === 1 && db().ipdOrders.find((o) => o.id === o2.id).doctorId === sep.doctorId, '改設定：舊的停止、開新的（醫師代碼），等護理師核對')
    await as(dutyUser.username)
    ok((await api.nursingApi.listWardPatients(ICU)).find((p) => p.id === sep.id).unackedCount >= 2, '護理站：新開與停止的呼吸器醫囑都要核對')
    await as(docUser)
    f = await fieldsOf(() => V.setRassTarget(sep.id, 0, -2))
    ok(f.max, '目標上限比下限低')
    pv = await V.setRassTarget(sep.id, -4, -1)
    ok(pv.rass.vs === 'in' && (await api.dashboardApi.getDashboard()).rassOut === 0, '目標改 −4～−1：RASS −4 在範圍內，首頁提醒消失')
    f = await fieldsOf(() => V.recordWean(sep.id, { sat: 'fail', sbt: 'pass' }))
    ok(f.sbt && f.note, 'SAT 沒過還做 SBT、沒寫原因：一次標出')
    pv = await V.recordWean(sep.id, { sat: 'pass', sbt: 'pass', note: '30 分鐘 PS 5 / PEEP 5，RR 18、SpO2 96%' })
    ok(!pv.wean.due && pv.wean.today?.text === 'SAT 通過・SBT 通過' && (await api.dashboardApi.getDashboard()).weanDue === 0, '記了脫離評估：今天不再提醒')
    f = await fieldsOf(() => V.stopVent(sep.id, { reason: '', extubate: true }))
    ok(f.reason, '停止要原因')
    pv = await V.stopVent(sep.id, { reason: 'SBT 通過，拔管改鼻導管 3 L/min', extubate: true })
    const ettAfter = db().lines.find((l) => l.id === ett.id)
    ok(!pv.order && !pv.intubation && ettAfter.removedAt && ettAfter.removeReason.includes('拔管') && !pv.wean.due, '停止呼吸器並拔管：氣管內管記移除（拔管）、不再要脫離評估')
    msg = await errOf(() => V.recordWean(sep.id, { sat: 'pass', sbt: 'pass' }))
    ok(msg.includes('沒有插管'), '拔管後不用脫離評估')
    await as(dutyUser.username)
    msg = await errOf(() => I.addFlowsheetEntry({ admissionId: sep.id, vent: { ppeak: 20, vt: 400, rr: 16 } }))
    ok(msg.includes('沒有使用中的呼吸器'), '停了呼吸器：不能再記呼吸器實測')
    f = await fieldsOf(() => I.addFlowsheetEntry({ admissionId: sep.id, gcs: { e: 4, vt: true, m: 6 } }))
    ok(f.gcsV?.includes('沒有插管'), '拔管後 GCS 言語不能記 T')

    // 開呼吸器的條件：限加護病房、要插管、DNR
    const gen = db().admissions.find((a) => a.status === 'admitted' && !a.obs && !db().isolations.some((i) => i.patientId === a.patientId) && !db().dnrRecords.some((d) => d.patientId === a.patientId) && db().beds.find((b) => b.id === a.bedId)?.ward !== ICU && db().beds.find((b) => b.id === a.bedId)?.ward !== '急診留觀區')
    const genDoc = db().users.find((u) => u.doctorId === gen.doctorId).username
    await as(genDoc)
    msg = await errOf(() => V.orderVent(gen.id, { mode: 'AC/VC', fio2: 50, peep: 8, vt: 420, rr: 16 }))
    ok(msg.includes('限加護病房'), `一般病房 → 「${msg}」`)
    // 轉入加護病房：主治申請、加護病房主治同意並選床
    const gq = await api.icuMoveApi.requestIcu(gen.id, { category: 'resp', reason: '測試' })
    await as('dr03')
    await api.icuMoveApi.decideIcuRequest(gq.id, { accept: true, bedId: db().beds.find((b) => b.ward === ICU && b.status === 'empty').id })
    await as(genDoc)
    msg = await errOf(() => V.orderVent(gen.id, { mode: 'AC/VC', fio2: 50, peep: 8, vt: 420, rr: 16 }))
    ok(msg.includes('沒有氣管內管'), `沒插管 → 「${msg}」`)
    // DNR 不插管、不施行人工呼吸
    db().dnrRecords.push({ id: 'DNR-T-VENT', patientId: gen.patientId, doc: 'self', signedAt: nowStr().slice(0, 10), witnesses: ['甲', '乙'], withhold: ['intubation', 'ventilation'], nhiCard: false, recordedBy: db().users.find((u) => u.username === genDoc).id, recordedAt: nowStr() })
    msg = await errOf(() => api.lineApi.addLine({ admissionId: gen.id, kind: 'ett', site: '經口', size: '7.5', insertedAt: nowStr(), placedBy: '醫師' }))
    ok(msg.includes('DNR 不施行氣管內插管'), `DNR 不插管 → 「${msg}」`)
    msg = await errOf(() => V.orderVent(gen.id, { mode: 'AC/VC', fio2: 50, peep: 8, vt: 420, rr: 16 }))
    ok(msg.includes('DNR 不施行人工呼吸'), `DNR 不施行人工呼吸 → 「${msg}」`)
    ok((await V.patientVent(gen.id)).dnrProblem, '分頁上先講 DNR')
    db().dnrRecords = db().dnrRecords.filter((d) => d.id !== 'DNR-T-VENT')
    await api.lineApi.addLine({ admissionId: gen.id, kind: 'ett', site: '經口', size: '7.5', insertedAt: nowStr(), placedBy: '醫師' })
    const og = await V.orderVent(gen.id, { mode: 'SIMV', fio2: 50, peep: 8, vt: 450, rr: 12, ps: 10, pinsp: 25 })
    ok(og.text === 'SIMV FiO2 50% PEEP 8 VT 450 RR 12 PS 10', `插管後開 SIMV（不要的吸氣壓力不收）：${og.text}`)
    // 每 4 小時待辦：轉入 5 小時前、開醫囑 5 小時前 → RASS、呼吸器實測都逾時
    const g = db().admissions.find((a) => a.id === gen.id)
    g.bedHistory.at(-1).from = addMinutes(nowStr(), -300)
    db().ipdOrders.find((o) => o.id === og.id).startAt = addMinutes(nowStr(), -300)
    await as(dutyUser.username)
    const tasks = (await api.nursingApi.listWardTasks(ICU)).filter((t) => t.admissionId === gen.id && t.kind === 'vent')
    ok(tasks.length === 2 && tasks.every((t) => t.urgency === 'overdue') && tasks.some((t) => t.text.includes('RASS')) && tasks.some((t) => t.text.includes('呼吸器實測')), '本班待辦：呼吸器實測、RASS 逾時（點了到流程表）')
    const wp = (await api.nursingApi.listWardPatients(ICU)).find((p) => p.id === gen.id)
    ok(wp.vent?.on && wp.vent.todo === 2 && wp.vent.overdue, '病人清單：呼吸器、實測／RASS 2')
    await I.addFlowsheetEntry({ admissionId: gen.id, rass: 0, vent: { ppeak: 24, vt: 440, rr: 14 } })
    ok(!(await api.nursingApi.listWardTasks(ICU)).some((t) => t.admissionId === gen.id && t.kind === 'vent'), '記了就消失')

    // VAP：氣管內管放超過 2 天才算；品質指標的氣管內管管路日＝呼吸器日
    const ettG = db().lines.find((l) => l.admissionId === gen.id && l.kind === 'ett')
    ettG.insertedAt = addMinutes(nowStr(), -4 * 24 * 60)
    const vap = await api.infectionApi.reportInfection(gen.id, { kind: 'vap', lineId: ettG.id, onsetAt: nowStr().slice(0, 10), symptoms: '發燒 38.6、膿痰增加、FiO2 需求上升', culture: '痰液培養：Klebsiella pneumoniae' })
    ok(vap.lineText?.includes('氣管內管') && vap.lineText.includes('第 5 天'), `通報 VAP：${vap.lineText}`)
    await as('dr11')
    await api.infectionApi.decideInfection(vap.id, true, '符合 VAP 定義')
    await as(dutyUser.username)
    const st = await api.lineApi.wardLineStats(ICU, 30)
    const row = st.rows.find((r) => r.kind === 'ett')
    ok(row && row.lineDays >= 5 && row.infections === 1 && row.infectionRate === api.per1000(1, row.lineDays), `品質指標：氣管內管（呼吸器日）${row?.lineDays} 天、VAP ${row?.infections} 例、每千 ${row?.infectionRate}`)
  }

  // 加護病房轉入轉出與嚴重度：申請（類別、原因、不重複）→ 加護病房主治同意（選床直接轉入、或候床）／不同意（寫原因）、排床；
  // 轉床進加護病房要有同意的申請；轉出要摘要、接著呼吸器不能轉出；交班帶出轉出摘要；SOFA、APACHE II；再轉回與品質指標
  console.log('\n[加護病房轉入轉出與嚴重度]')
  {
    dbm.resetDatabase('small')
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const M = api.icuMoveApi
    const ICU = '3I 加護病房'
    const { addMinutes } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.checkIcuRequest({}).category && api.checkIcuRequest({}).reason && !Object.keys(api.checkIcuRequest({ category: 'shock', reason: 'x' })).length, '轉入申請：類別、原因')
    let e = api.checkIcuSummary({ lines: '' })
    ok(e.diagnosis && e.course && e.todo && !e.lines, '轉出摘要：診斷、經過、待追蹤必填（管路可以空）')
    let so = api.sofaScore({ pf: { ratio: 180, vent: true }, plt: 92, bili: 2.4, map: 64, gcs: 12, cre: 1.8, urine: 450 })
    ok(so.total === 3 + 2 + 2 + 1 + 2 + 3 && !so.missing.length, `SOFA：呼吸 3、凝血 2、肝 2、心血管 1、神經 2、腎 3（尿量 450 比肌酸酐差）＝${so.total}`)
    so = api.sofaScore({ pf: { ratio: 80, vent: false }, plt: 200 })
    ok(so.parts.resp === 2 && so.parts.coag === 0 && so.missing.length === 4 && so.total === 2, '沒接呼吸器呼吸最多 2 分；缺的項目 null、不算進總分')
    const ap = api.apacheScore({ temp: [38.6, 37.2], map: [61, 75], hr: [118], rr: [26], oxy: [{ fio2: 0.6, pao2: 68, paco2: 34 }], ph: [7.24], na: [], k: [], cre: [2.1], hct: [], wbc: [18.6], gcs: [13], age: 60, chronic: true, surgery: 'none' })
    ok(ap.parts.temp === 1 && ap.parts.map === 2 && ap.parts.hr === 2 && ap.parts.rr === 1 && ap.parts.oxy === 2 && ap.parts.ph === 3 && ap.parts.cre === 3 && ap.parts.wbc === 1 && ap.parts.gcs === 2 && ap.aps === 17 && ap.agePts === 3 && ap.chronicPts === 5 && ap.total === 25, `APACHE II：生理 ${ap.aps}＋年齡 3＋慢性病 5＝${ap.total}（各項取最差）`)
    ok(ap.missing.join() === 'na,k,hct' && api.aaGradient(0.6, 68, 34) === 317 && api.oxyPoints({ fio2: 0.4, pao2: 58, paco2: 40 }) === 3, '缺鈉、鉀、血比容；FiO2 ≥0.5 看 A-a（317→2 分）、<0.5 看 PaO2')
    ok(api.agePoints(44) === 0 && api.agePoints(75) === 6 && api.chronicPoints(true, 'elective') === 2 && api.chronicPoints(false, 'none') === 0, '年齡、慢性病分數')
    const st = api.icuStays([{ from: '2026-11-01 10:00', icu: false }, { from: '2026-11-02 10:00', icu: true }, { from: '2026-11-03 08:00', icu: true }, { from: '2026-11-05 10:00', icu: false }, { from: '2026-11-06 09:00', icu: true }], '2026-11-08 10:00')
    ok(st.length === 2 && st[0].to === '2026-11-05 10:00' && st[1].to === '2026-11-08 10:00' && api.bounceBacks(st).length === 1 && !api.bounceBacks([st[0], { from: '2026-11-08 11:00' }]).length, '加護病房裡換床算同一段；轉出 48 小時內再轉回、超過不算')

    // 種子
    const sep = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('A41'))
    const dka = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('E11'))
    const uti = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63')) // 吸入性肺炎併敗血性休克（以前是泌尿道感染，但他是准出院的示範）
    ok(db().beds.find((b) => b.id === dka.bedId).ward === ICU && db().icuRequests.find((r) => r.admissionId === dka.id)?.status === 'placed' && db().icuRequests.find((r) => r.admissionId === uti.id)?.status === 'pending', '種子：糖尿病酮酸中毒申請轉入、已在加護病房；腦梗塞病人吸入性肺炎併休克申請轉入待同意')
    ok(db().users.find((u) => u.username === 'dr03').grants?.includes('icu.attending'), '種子：dr03 被指定加護病房主治')
    { const since = db().admissions.find((a) => a.id === dka.id).bedHistory.at(-1).from
      ok(!db().handovers.some((h) => h.admissionId === dka.id && h.createdAt >= since) && !db().vitals.some((v) => v.admissionId === dka.id && !v.hourly && v.at > since && v.at <= db().vitals.filter((x) => x.admissionId === dka.id && x.hourly).map((x) => x.at).sort().pop()), '種子：轉入加護病房之後沒有原病房的交班、流程表那段沒有重複的生命徵象') }
    await as('dr03')
    ok((await api.dashboardApi.getDashboard()).icuRequestsPending === 1, '加護病房主治首頁：轉入待處理 1')
    let work = await M.listIcuWork()
    ok(work.pending.length === 1 && work.pending[0].patientName && work.pending[0].categoryLabel === '休克' && work.canDecide && work.emptyBeds.length === 7, '加護病房頁：待同意 1（休克）、空床 7（含負壓 ICU9）、可以處理')
    let pi = await M.patientIcu(sep.id)
    const y = pi.sofa.find((s) => !s.partial && s.parts.liver !== null)
    ok(pi.inIcu && pi.sofa.length >= 2 && (!y || (y.parts.resp >= 2 && y.parts.coag === 2 && y.parts.liver === 2 && y.parts.renal >= 1 && y.parts.cns === null)), `敗血症 SOFA（膽紅素 2.4→肝 2、血小板 92→凝血 2、插管的 GCS T 不算神經項）：${pi.sofa.map((s) => `${s.date.slice(5)} ${s.total}${s.missing.length ? '+' : ''}`).join('、')}`)
    { // 轉入那天只住半天：就算尿量很少也不看（沒修之前會變 4 分），腎臟只看肌酸酐 2.1 → 2
      const d0 = sep.admittedAt.slice(0, 10)
      for (const v of db().vitals.filter((x) => x.admissionId === sep.id && x.at.startsWith(d0) && x.output !== undefined)) v.output = 0
      const first = (await M.patientIcu(sep.id)).sofa.find((s) => s.date === d0)
      ok(!first || first.parts.renal === 2, `轉入那一天不滿一整天：不看尿量（腎臟 ${first?.parts.renal}：只看肌酸酐 2.1，沒變成 4）`) }
    ok(pi.apache && pi.apache.parts.oxy === 2 && pi.apache.parts.ph === 3 && pi.apache.parts.wbc === 1 && pi.apache.parts.cre === 3 && !pi.apache.missing.includes('na') && !pi.apache.input.set, `敗血症 APACHE II ${pi.apache?.total}（缺 ${pi.apache?.missing.length} 項以 0 分計）`)

    // 申請：已經有一筆不能再申請；護理師不能申請
    await as(db().users.find((u) => u.doctorId === 'DR02').username)
    let msg = await errOf(() => M.requestIcu(uti.id, { category: 'shock', reason: 'x' }))
    ok(msg.includes('已經有一筆'), `重複申請 → 「${msg}」`)
    msg = await errOf(() => M.decideIcuRequest(db().icuRequests.find((r) => r.admissionId === uti.id).id, { accept: true }))
    ok(msg.includes('權限'), `不是加護病房主治的醫師同意 → 「${msg}」`)
    await as('nurse01')
    await expectError(() => M.requestIcu(uti.id, { category: 'shock', reason: 'x' }), '護理師申請轉入')
    await as('admin')
    msg = await errOf(() => M.decideIcuRequest(db().icuRequests.find((r) => r.admissionId === uti.id).id, { accept: true }))
    ok(msg.includes('加護病房主治醫師'), `管理員同意 → 「${msg}」`)
    // 同意（先候床）→ 住院中心轉床（有同意的申請就可以）
    await as('dr03')
    const ureq = db().icuRequests.find((r) => r.admissionId === uti.id)
    let f = await fieldsOf(() => M.decideIcuRequest(ureq.id, { accept: false }))
    ok(f.note, '不同意要寫原因')
    let rv = await M.decideIcuRequest(ureq.id, { accept: true, note: '先候床' })
    ok(rv.status === 'accepted' && (await M.listIcuWork()).waiting.length === 1 && (await api.dashboardApi.getDashboard()).icuRequestsPending === 1, '同意、沒選床：候床中（首頁照樣算）')
    await as('clerk01')
    f = await fieldsOf(() => M.placeIcuRequest(ureq.id, db().beds.find((b) => b.ward !== ICU && b.status === 'empty').id))
    ok(f.bedId, '排床要選加護病房的床')
    const utiBed = db().beds.find((b) => b.ward === ICU && b.status === 'empty')
    rv = await M.placeIcuRequest(ureq.id, utiBed.id)
    ok(rv.status === 'placed' && rv.bedId === utiBed.id && db().admissions.find((a) => a.id === uti.id).bedId === utiBed.id, `住院中心排床：轉入 ${utiBed.bedNo}、申請標已轉入`)

    // 轉出：要摘要；接著呼吸器不能轉出
    const gen = db().beds.find((b) => b.ward !== ICU && b.ward !== '急診留觀區' && b.status === 'empty' && b.bedClass === '健保床')
    msg = await errOf(() => api.admissionApi.transferBed(dka.id, gen.id))
    ok(msg.includes('轉出摘要'), `沒寫摘要就轉出 → 「${msg}」`)
    ok((await api.admissionApi.bedBlocks(dka.id))[gen.id]?.includes('轉出摘要'), '選床畫面：一般病房的床標「先寫轉出摘要」')
    await as(db().users.find((u) => u.doctorId === dka.doctorId).username)
    await M.setApacheInput(dka.id, { chronic: false, surgery: 'none' })
    f = await fieldsOf(() => M.writeIcuSummary(dka.id, { diagnosis: '', course: '', lines: '', todo: '' }))
    ok(f.diagnosis && f.course && f.todo, '摘要欄位一次標出')
    await api.ventApi.setRassTarget(dka.id, -1, 0)
    pi = await M.writeIcuSummary(dka.id, { diagnosis: '糖尿病酮酸中毒，已緩解', course: '胰島素點滴 30 小時，酸中毒改善後改皮下注射', lines: '周邊靜脈留置針', todo: '每餐前驗血糖；糖尿病衛教' })
    ok(pi.summary?.items.length === 4 && pi.summary.items[0].text.includes('酮酸'), '寫了轉出摘要')
    await as('dr02')
    const sepSum = await M.writeIcuSummary(sep.id, { diagnosis: 'x', course: 'x', lines: '', todo: 'x' })
    await as('clerk01')
    msg = await errOf(() => api.admissionApi.transferBed(sep.id, gen.id))
    ok(sepSum.summary && msg.includes('還接著呼吸器'), `接著呼吸器轉出 → 「${msg}」`)
    await api.admissionApi.transferBed(dka.id, gen.id)
    const dkaA = db().admissions.find((a) => a.id === dka.id)
    ok(db().beds.find((b) => b.id === dkaA.bedId).ward === gen.ward && !dkaA.rassTarget, `寫了摘要就能轉出（轉到 ${gen.ward}）、鎮靜目標清掉`)
    await as('nurse01')
    const wp = (await api.nursingApi.listWardPatients(gen.ward)).find((p) => p.id === dka.id)
    ok(wp.icuOut?.items.some((x) => x.text.includes('驗血糖')), '接手病房：48 小時內從加護病房轉來，交班帶出轉出摘要')
    pi = await M.patientIcu(dka.id)
    ok(!pi.inIcu && pi.stays.length === 1 && pi.stays[0].to && !pi.sofa.length, '轉出後：住加護病房的紀錄一段、沒有 SOFA')

    // 48 小時內再轉回
    await as(db().users.find((u) => u.doctorId === dka.doctorId).username)
    const r2 = await M.requestIcu(dka.id, { category: 'other', reason: '血糖又升到 480、酮體陽性' })
    await as('dr03')
    await M.decideIcuRequest(r2.id, { accept: true, bedId: db().beds.find((b) => b.ward === ICU && b.status === 'empty').id })
    pi = await M.patientIcu(dka.id)
    ok(pi.inIcu && pi.stays.length === 2 && pi.stays[1].bounce && !pi.summary, '轉出 48 小時內又轉回：標「再轉回」，上一段的摘要不算這一段')
    const qs = await M.icuStats(30)
    ok(qs.stays >= 3 && qs.bounce === 1 && qs.patientDays > 0 && qs.avgDays !== null && qs.bounceRate === Math.round((1 / qs.stays) * 1000) / 10, `品質指標：轉入 ${qs.stays} 次、住院人日 ${qs.patientDays}、平均 ${qs.avgDays} 天、再轉回 ${qs.bounce}（${qs.bounceRate}%）`)

    // APACHE II 手動欄位
    await as('dr02')
    f = await fieldsOf(() => M.setApacheInput(sep.id, { chronic: true, surgery: 'x' }))
    ok(f.surgery, '手術要選')
    pi = await M.setApacheInput(sep.id, { chronic: true, surgery: 'none' })
    ok(pi.apache.chronicPts === 5 && pi.apache.input.set, '有嚴重慢性病、非手術：慢性病 +5')
  }

  // 早期預警 NEWS2 與快速反應小組：七項計分與分級、缺項不算、給氧與意識的輸入檢查；中 1 小時內再量、高自動呼叫（不重複叫、
  // 有轉入申請不叫、加護病房不算）；手動呼叫；小組評估（欄位一次標出、留原病房、申請轉加護病房建申請或接上已有的）；權限；品質指標
  console.log('\n[早期預警 NEWS2 與快速反應小組]')
  {
    dbm.resetDatabase('small')
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const R = api.rrtApi
    const N = api.nursingApi
    const ICU = '3I 加護病房'
    const { addMinutes, now } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    const base = { id: 'x', admissionId: 'x', at: '2026-11-18 10:00', nurseId: 'x', resp: 16, spo2: 97, o2: 0, sbp: 124, pulse: 80, avpu: 'A', temp: 36.8 }
    const sc = (x) => api.newsScore({ ...base, ...x })
    let s = sc({ resp: 22, spo2: 94, o2: 2, sbp: 112, pulse: 104, temp: 37.9 })
    ok(s.total === 6 && s.level === 'medium' && !s.red && s.parts.length === 7, `NEWS2：呼吸 22→2、血氧 94→1、給氧→2、心跳 104→1 ＝ ${s.total}（中）`)
    ok(sc({}).total === 0 && sc({}).level === 'low', '全部正常 0 分（低）')
    const pts = (k, v) => sc({ [k]: v }).parts.find((p) => p.key === k).points
    ok(pts('resp', 8) === 3 && pts('resp', 9) === 1 && pts('resp', 20) === 0 && pts('resp', 21) === 2 && pts('resp', 25) === 3, '呼吸邊界：≤8→3、9→1、20→0、21→2、≥25→3')
    ok(pts('spo2', 91) === 3 && pts('spo2', 93) === 2 && pts('spo2', 95) === 1 && pts('spo2', 96) === 0, '血氧邊界：≤91→3、93→2、95→1、≥96→0')
    ok(pts('sbp', 90) === 3 && pts('sbp', 100) === 2 && pts('sbp', 110) === 1 && pts('sbp', 219) === 0 && pts('sbp', 220) === 3, '收縮壓邊界：≤90→3、100→2、110→1、219→0、≥220→3')
    ok(pts('pulse', 40) === 3 && pts('pulse', 50) === 1 && pts('pulse', 90) === 0 && pts('pulse', 110) === 1 && pts('pulse', 130) === 2 && pts('pulse', 131) === 3, '心跳邊界：≤40→3、50→1、90→0、110→1、130→2、≥131→3')
    ok(pts('temp', 35) === 3 && pts('temp', 36) === 1 && pts('temp', 38) === 0 && pts('temp', 39) === 1 && pts('temp', 39.1) === 2, '體溫邊界：≤35→3、36→1、38→0、39→1、≥39.1→2')
    s = sc({ avpu: 'C' })
    ok(s.total === 3 && s.red && s.level === 'medium', '新出現的混亂（C）3 分：單項 3 分就算「中」（要通知、再量）')
    ok(sc({ resp: 25, sbp: 100, pulse: 111 }).level === 'high' && sc({ resp: 25, sbp: 100, pulse: 111 }).total === 7, '≥7 分「高」')
    const miss = api.newsScore({ ...base, o2: undefined, avpu: undefined })
    ok(!api.isNews(miss) && miss.missing.join() === '給氧,意識', '缺給氧、意識：算不出分數（列出缺哪幾項）')
    let e = api.checkNewsExtra({ o2: 16, avpu: 'X' })
    ok(e.o2 && e.avpu && !Object.keys(api.checkNewsExtra({ o2: 0, avpu: 'U' })).length, '給氧 0–15 L/min、意識只能 A C V P U')
    e = api.checkRrtAssessment({})
    ok(e.findings && e.actions && e.disposition, '快速反應評估：發現、處置、去向必填')

    // 種子
    const pn = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('J18'))
    const uti = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63')) // 吸入性肺炎併敗血性休克（以前是泌尿道感染，但他是准出院的示範）
    const sep = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('A41'))
    const pnWard = db().beds.find((b) => b.id === pn.bedId).ward
    await as('nurse01')
    let pv = await R.patientNews(pn.id)
    ok(pv.last?.total === 6 && pv.last.level === 'medium' && pv.recheck?.status === 'upcoming' && pv.trend.map((x) => x.total).join() === (pv.trend.length === 3 ? '2,4,6' : pv.trend.map((x) => x.total).join()) && !pv.open && pv.canCall, `種子：肺炎 NEWS2 ${pv.trend.map((x) => x.total).join(' → ')}（中，1 小時內再量）`)
    const uc = db().rrtCalls.find((c) => c.admissionId === uti.id)
    const ur = db().icuRequests.find((r) => r.admissionId === uti.id)
    ok(uc?.status === 'done' && uc.disposition === 'icu' && uc.icuRequestId === ur.id && ur.rrtCallId === uc.id && ur.status === 'pending' && db().users.find((u) => u.id === ur.requestedBy).username === 'dr03', '種子：腦梗塞病人 NEWS2 11 自動呼叫 → dr03 評估、申請轉入（休克）待同意')
    pv = await R.patientNews(uti.id)
    ok(pv.last.total === 11 && pv.last.level === 'high' && !pv.open && pv.calls.length === 1 && pv.calls[0].responseMin === 20, '休克的病人再量仍 11 分：已有轉入申請在走，沒有重複呼叫；20 分鐘到場')
    ok(db().users.find((u) => u.username === 'dr03').grants?.includes('rrt'), '種子：dr03 被指定快速反應小組')
    let wp = (await N.listWardPatients(pnWard)).find((p) => p.id === pn.id)
    ok(wp.news?.score === 6 && wp.news.level === 'medium' && wp.news.recheck === 'upcoming' && !wp.rrtPending, '護理站病人清單：NEWS 6（等再量）')
    let tasks = await N.listWardTasks(pnWard)
    ok(tasks.some((t) => t.id === `news-${pn.id}` && t.kind === 'news' && t.urgency === 'due'), '本班待辦：NEWS2 1 小時內再量')

    // 存檔：輸入檢查一次標出；部分紀錄不算再量
    let f = await fieldsOf(() => N.addVitals({ admissionId: pn.id, temp: 52, o2: 16, avpu: 'X' }))
    ok(f.temp && f.o2 && f.avpu, '體溫、給氧、意識的錯誤一次標出')
    await N.addVitals({ admissionId: pn.id, pain: 1 })
    ok((await R.patientNews(pn.id)).recheck, '只記疼痛：算不出分數，不算再量')
    // 再量逾時
    const last = db().vitals.find((v) => v.id === 'VS-NEWS-PN-3')
    if (last) last.at = addMinutes(now(), -61)
    tasks = await N.listWardTasks(pnWard)
    ok(!last || tasks.some((t) => t.id === `news-${pn.id}` && t.urgency === 'overdue'), '超過 1 小時沒再量：本班待辦逾時')
    let v = await N.addVitals({ admissionId: pn.id, temp: 37.2, pulse: 88, resp: 18, sbp: 122, dbp: 74, spo2: 96, o2: 2, avpu: 'A', pain: 1 })
    pv = await R.patientNews(pn.id)
    ok(!v.rrtCalled && pv.last.total === 2 && pv.last.level === 'low' && !pv.recheck, '再量 2 分（低）：不用再量')
    // 高：自動呼叫，不重複叫
    v = await N.addVitals({ admissionId: pn.id, temp: 38.9, pulse: 124, resp: 26, sbp: 98, dbp: 60, spo2: 91, o2: 4, avpu: 'A', pain: 2 })
    const pc = db().rrtCalls.find((c) => c.admissionId === pn.id && c.status === 'pending')
    ok(v.rrtCalled && pc?.trigger === 'auto' && pc.vitalId === v.id && pc.score === 13 && db().auditLogs[0].action === '呼叫快速反應小組', 'NEWS2 13（≥7）：自動呼叫快速反應小組、寫稽核')
    v = await N.addVitals({ admissionId: pn.id, temp: 38.9, pulse: 126, resp: 28, sbp: 96, dbp: 58, spo2: 90, o2: 6, avpu: 'A' })
    ok(!v.rrtCalled && db().rrtCalls.filter((c) => c.admissionId === pn.id).length === 1, '還在等的時候又高：不重複呼叫')
    wp = (await N.listWardPatients(pnWard)).find((p) => p.id === pn.id)
    tasks = await N.listWardTasks(pnWard)
    ok(wp.rrtPending && wp.news.level === 'high' && tasks.some((t) => t.id === `rrt-${pn.id}`), '護理站：標「快速反應」、本班待辦「等到場評估」')
    let msg = await errOf(() => R.callRrt(pn.id, { reason: 'x' }))
    ok(msg.includes('已經呼叫'), `已經在等又手動呼叫 → 「${msg}」`)
    // 加護病房不算
    v = await N.addVitals({ admissionId: sep.id, temp: 38.9, pulse: 130, resp: 28, sbp: 88, dbp: 50, spo2: 90, o2: 6, avpu: 'P' })
    pv = await R.patientNews(sep.id)
    ok(!v.rrtCalled && pv.inIcu && !pv.last && !pv.trend.length && !pv.canCall, '加護病房的病人：不算 NEWS2、不自動呼叫')
    msg = await errOf(() => R.callRrt(sep.id, { reason: 'x' }))
    ok(msg.includes('加護病房'), `加護病房的病人手動呼叫 → 「${msg}」`)
    // 手動呼叫
    const other = db().admissions.find((a) => a.status === 'admitted' && ![pn.id, uti.id].includes(a.id) && !['3I 加護病房', '急診留觀區'].includes(db().beds.find((b) => b.id === a.bedId)?.ward) && !db().icuRequests.some((r) => r.admissionId === a.id && ['pending', 'accepted'].includes(r.status)))
    f = await fieldsOf(() => R.callRrt(other.id, { reason: ' ' }))
    ok(f.reason, '手動呼叫要寫原因')
    const mc = await R.callRrt(other.id, { reason: '突然躁動、說話不清楚，覺得不對勁' })
    ok(mc.trigger === 'manual' && mc.status === 'pending' && mc.calledByName, '護理師擔心病人：手動呼叫（分數不高也可以）')

    // 小組評估
    await as('dr02')
    ok((await api.dashboardApi.getDashboard()).newsAlerts >= 1, `主治首頁：NEWS2 警示 ${(await api.dashboardApi.getDashboard()).newsAlerts}（肺炎、休克的腦梗塞病人）`)
    msg = await errOf(() => R.listRrt())
    ok(msg.includes('快速反應小組'), `沒有權限的醫師看快速反應 → 「${msg}」`)
    msg = await errOf(() => R.assessRrt(pc.id, { findings: 'x', actions: 'x', disposition: 'stay' }))
    ok(msg.includes('快速反應小組'), '沒有權限的醫師評估擋下')
    await as('admin')
    let w = await R.listRrt()
    msg = await errOf(() => R.assessRrt(pc.id, { findings: 'x', actions: 'x', disposition: 'stay' }))
    ok(!w.canAssess && w.pending.length === 2 && msg.includes('小組醫師'), `管理員只能看：評估 → 「${msg}」`)
    await as('dr03')
    ok((await api.dashboardApi.getDashboard()).rrtPending === 2, '快速反應小組首頁：待到場 2')
    w = await R.listRrt()
    ok(w.canAssess && w.pending[0].id === pc.id && w.pending[0].news?.total === 13 && w.pending[0].latest?.total >= 7 && w.pending[0].waitedMin >= 0 && w.recent.some((c) => c.id === uc.id && c.icuRequestStatus === 'pending'), '快速反應頁：等最久的在上面（觸發的分數、目前分數、等了幾分鐘）、最近評估過的（轉入申請狀態）')
    f = await fieldsOf(() => R.assessRrt(pc.id, { findings: '', actions: '', disposition: 'icu' }))
    ok(f.findings && f.actions && f.category && f.reason && !f.disposition, '評估：發現、處置、轉入類別與原因一次標出')
    let a1 = await R.assessRrt(pc.id, { findings: '呼吸喘、右下肺囉音增加', actions: '氧氣面罩 6 L、抽動脈血液氣體分析、加抗生素', disposition: 'stay' })
    ok(a1.status === 'done' && a1.disposition === 'stay' && a1.responseMin >= 0 && !a1.icuRequestId && !db().icuRequests.some((r) => r.admissionId === pn.id && r.status === 'pending'), '留原病房：評估完成、沒有轉入申請')
    msg = await errOf(() => R.assessRrt(pc.id, { findings: 'x', actions: 'x', disposition: 'stay' }))
    ok(msg.includes('已經評估'), `評估過的再評估 → 「${msg}」`)
    const a2 = await R.assessRrt(mc.id, { findings: '左側肢體無力、口齒不清', actions: '通知神經科、安排電腦斷層', disposition: 'icu', category: 'other', reason: '疑似急性中風，需密切監測' })
    const nr = db().icuRequests.find((r) => r.id === a2.icuRequestId)
    ok(nr?.status === 'pending' && nr.rrtCallId === mc.id && nr.category === 'other' && nr.requestedBy === db().users.find((u) => u.username === 'dr03').id && (await api.icuMoveApi.listIcuWork()).pending.some((r) => r.id === nr.id), '申請轉加護病房：建一筆轉入申請（申請人是小組醫師），加護病房頁待同意')
    await as('nurse01')
    v = await N.addVitals({ admissionId: other.id, temp: 38.9, pulse: 130, resp: 28, sbp: 88, dbp: 50, spo2: 90, o2: 6, avpu: 'V' })
    ok(!v.rrtCalled && !db().rrtCalls.some((c) => c.admissionId === other.id && c.status === 'pending'), '已經申請轉加護病房：分數再高也不重複呼叫')
    // 已有轉入申請：接上那一筆
    const uc2 = await R.callRrt(uti.id, { reason: '血壓又掉到 78/40' })
    await as('dr03')
    const n0 = db().icuRequests.length
    const a3 = await R.assessRrt(uc2.id, { findings: '血壓 78/40、意識變差', actions: '再輸液 500 ml', disposition: 'icu' })
    ok(a3.icuRequestId === ur.id && db().icuRequests.length === n0, '已經有轉入申請在走：接上那一筆，不重複申請（也不用再填類別）')
    const st = (await R.listRrt()).stats
    ok(st.calls === 4 && st.auto === 2 && st.done === 4 && st.toIcu === 3 && st.avgResponseMin !== null, `品質指標：呼叫 ${st.calls}（自動 ${st.auto}）、平均 ${st.avgResponseMin} 分鐘到場、轉加護病房 ${st.toIcu}/${st.done}`)
  }

  // 急救（Code Blue）：事件檢查、DNR 硬擋、醫師帶領才能給藥電擊、腎上腺素 3–5 分鐘、Amiodarone 兩劑、藥自動開醫囑扣帳、
  // CPR 處置費、結束（ROSC、宣告死亡要醫師、依 DNR 不施行）、ROSC 後申請轉加護病房、全院橫幅、品質指標
  console.log('\n[急救 Code Blue]')
  {
    dbm.resetDatabase('small')
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const C = api.codeApi
    const { addMinutes, now } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    const ev = (kind, x = {}) => ({ id: 'e', at: '2026-11-18 10:00', by: 'u', kind, ...x })
    ok(api.checkCodeEvent({ events: [] }, { kind: 'rhythm' }).rhythm && api.checkCodeEvent({ events: [] }, { kind: 'shock', joules: 200 }).kind?.includes('先判讀心律'), '心律要選；沒判讀心律不能電擊')
    let e = api.checkCodeEvent({ events: [ev('rhythm', { rhythm: 'vf' })] }, { kind: 'shock', joules: 50 })
    ok(e.joules && !e.kind, '電擊能量 120–360 J')
    e = api.checkCodeEvent({ events: [ev('rhythm', { rhythm: 'asystole' })] }, { kind: 'shock', joules: 200 })
    ok(e.kind?.includes('不可電擊') && !Object.keys(api.checkCodeEvent({ events: [ev('rhythm', { rhythm: 'pvt' })] }, { kind: 'shock', joules: 200 })).length, 'Asystole 不可電擊、pVT 可以')
    ok(api.checkCodeEvent({ events: [ev('cpr')] }, { kind: 'cpr' }).kind && api.checkCodeEvent({ events: [ev('rhythm', { rhythm: 'vf' }), ev('amio'), ev('amio')] }, { kind: 'amio' }).kind?.includes('兩劑') && api.checkCodeEvent({ events: [] }, { kind: 'note', note: ' ' }).note, 'CPR 只開始一次、Amiodarone 最多兩劑、備註要寫')
    ok(api.nextAmioDose({ events: [] }) === 300 && api.nextAmioDose({ events: [ev('amio')] }) === 150, 'Amiodarone 300 → 150 mg')
    const t0 = '2026-11-18 10:00'
    ok(api.epiState({ status: 'active', events: [] }, t0) === undefined && api.epiState({ status: 'active', events: [ev('cpr')] }, t0).status === 'none', '還沒 CPR 不提示；CPR 中還沒給腎上腺素')
    const withEpi = { status: 'active', events: [ev('cpr'), { ...ev('epi'), at: t0 }] }
    ok(api.epiState(withEpi, '2026-11-18 10:02').status === 'wait' && api.epiState(withEpi, '2026-11-18 10:03').status === 'due' && api.epiState(withEpi, '2026-11-18 10:05').status === 'due' && api.epiState(withEpi, '2026-11-18 10:06').status === 'overdue', '腎上腺素：未滿 3 分鐘等、3–5 分鐘可以給、超過 5 分鐘提示')
    ok(api.dnrBlockText('cpr', ['compress'])?.includes('胸外按壓') && api.dnrBlockText('epi', ['drugs']) && !api.dnrBlockText('epi', ['compress']) && !api.dnrBlockText('rhythm', ['compress', 'defib', 'drugs']), 'DNR：不按壓擋 CPR、不給急救藥擋腎上腺素；心律判讀不擋')
    ok(api.checkCodeEnd({ events: [] }, 'rosc', []).includes('CPR') && api.checkCodeEnd({ events: [] }, 'dnr', []).includes('要急救') && api.checkCodeEnd({ events: [ev('cpr')] }, 'dnr', ['compress']) && !api.checkCodeEnd({ events: [] }, 'dnr', ['compress']), '結束：沒 CPR 不能 ROSC；沒有不按壓的 DNR 不能「依 DNR 不施行」；開始 CPR 後也不行')
    const qs = api.codeStats([{ status: 'ended', outcome: 'rosc' }, { status: 'ended', outcome: 'death' }, { status: 'ended', outcome: 'dnr' }, { status: 'active' }])
    ok(qs.codes === 4 && qs.resus === 2 && qs.rosc === 1 && qs.roscRate === 50 && qs.dnr === 1, '品質指標：ROSC 率不算依 DNR 不施行的')

    // 種子
    const dka = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('E11'))
    const sep = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('A41'))
    const cell = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('L03'))
    const seed = db().codeBlues.find((c) => c.id === 'CB-SEED-1')
    ok(seed?.admissionId === dka.id && seed.outcome === 'rosc' && db().icuRequests.find((r) => r.id === seed.icuRequestId)?.codeBlueId === seed.id && db().ipdOrders.some((o) => o.codeBlueId === seed.id && o.procId === 'P054' && o.status === 'done'), '種子：酮酸中毒病人低血鉀 VF 急救 → ROSC → 申請轉入（已轉 ICU2），CPR 處置費')
    await as('nurse01')
    let pc = await C.patientCode(dka.id)
    ok(pc.history.length === 1 && pc.history[0].events.length === 7 && pc.history[0].minutes === 10 && pc.history[0].icuRequestStatus === 'placed' && !pc.icuAfter && !pc.active && pc.canStart, '急救分頁：以前的急救（10 分鐘、7 個事件、已轉入加護病房）')
    ok(!(await C.activeCodes()).length, '沒有進行中的急救：沒有橫幅')

    // 一般醫囑不能開急救藥、CPR 費
    await as(db().users.find((u) => u.doctorId === cell.doctorId).username)
    let msg = await errOf(() => api.ipdApi.addOrder({ admissionId: cell.id, type: 'stat', category: 'medication', drugId: 'M046', content: '', dose: 1, freq: 'STAT', route: 'IV' }))
    ok(msg.includes('急救車用藥'), `一般醫囑開腎上腺素 → 「${msg}」`)
    msg = await errOf(() => api.ipdApi.addOrder({ admissionId: cell.id, type: 'stat', category: 'procedure', procId: 'P054', content: '' }))
    ok(msg.includes('急救計費項目'), `一般醫囑開 CPR 處置費 → 「${msg}」`)

    // 啟動（護理師）
    await as('admin')
    await expectError(() => C.startCode(cell.id), '管理員啟動急救')
    await as('nurse01')
    let c = await C.startCode(cell.id)
    ok(c.status === 'active' && !c.leaderId && db().auditLogs[0].action === '啟動急救', '護理師啟動急救：還沒有醫師帶領、寫稽核')
    let banner = await C.activeCodes()
    ok(banner.length === 1 && banner[0].patientName && banner[0].bedNo, `全院橫幅：${banner[0].ward} ${banner[0].bedNo} ${banner[0].patientName}`)
    msg = await errOf(() => C.startCode(cell.id))
    ok(msg.includes('已經在進行中'), `重複啟動 → 「${msg}」`)
    c = await C.addCodeEvent(c.id, { kind: 'cpr' })
    let f = await fieldsOf(() => C.addCodeEvent(c.id, { kind: 'cpr' }))
    ok(c.events.length === 1 && f.kind, 'CPR 開始（只能一次）')
    c = await C.addCodeEvent(c.id, { kind: 'rhythm', rhythm: 'vf' })
    msg = await errOf(() => C.addCodeEvent(c.id, { kind: 'epi' }))
    ok(c.rhythm === 'vf' && msg.includes('帶領'), `沒有醫師帶領給腎上腺素 → 「${msg}」`)
    pc = await C.patientCode(cell.id)
    ok(pc.active?.epi?.status === 'none' && !pc.canStart, '急救中：提示還沒給腎上腺素、不能再啟動')
    // 醫師帶領
    const doc = db().users.find((u) => u.doctorId === 'DR01')
    await as(doc.username)
    c = await C.leadCode(c.id)
    ok(c.leaderId === doc.id, '醫師帶領')
    f = await fieldsOf(() => C.addCodeEvent(c.id, { kind: 'shock', joules: 50 }))
    ok(f.joules, '電擊能量不合理')
    c = await C.addCodeEvent(c.id, { kind: 'shock', joules: 200 })
    const stock0 = db().stockTxns.length
    c = await C.addCodeEvent(c.id, { kind: 'epi' })
    const eo = db().ipdOrders.find((o) => o.id === c.events.at(-1).orderId)
    const etx = db().stockTxns.slice(stock0).find((t) => t.drugId === 'M046')
    ok(eo?.codeBlueId === c.id && eo.status === 'done' && eo.doctorId === doc.doctorId && eo.ackAt && eo.drugId === 'M046' && etx?.type === 'dispense' && etx.ref.endsWith(cell.admitNo), `腎上腺素：自動開臨時醫囑（已執行、帶領醫師名下、不用再核對）、扣帳（${etx?.ref}）`)
    c = await C.addCodeEvent(c.id, { kind: 'amio' })
    ok(c.events.at(-1).doseMg === 300 && db().ipdOrders.find((o) => o.id === c.events.at(-1).orderId)?.dose === 2 && c.nextAmioMg === 150, 'Amiodarone 第一劑 300 mg（2 支）、下一劑 150 mg')
    c = await C.addCodeEvent(c.id, { kind: 'amio' })
    f = await fieldsOf(() => C.addCodeEvent(c.id, { kind: 'amio' }))
    ok(c.events.at(-1).doseMg === 150 && f.kind?.includes('兩劑'), '第二劑 150 mg；第三劑擋')
    c = await C.addCodeEvent(c.id, { kind: 'rhythm', rhythm: 'pea' })
    f = await fieldsOf(() => C.addCodeEvent(c.id, { kind: 'shock', joules: 200 }))
    ok(f.kind?.includes('不可電擊'), `PEA 電擊 → 「${f.kind}」`)
    // 腎上腺素超過 5 分鐘
    const lastEpi = db().codeBlues.find((x) => x.id === c.id).events.find((x) => x.kind === 'epi')
    lastEpi.at = addMinutes(now(), -6)
    pc = await C.patientCode(cell.id)
    ok(pc.active.epi.status === 'overdue', '腎上腺素超過 5 分鐘：提示')
    c = await C.addCodeEvent(c.id, { kind: 'intubate' })
    c = await C.addCodeEvent(c.id, { kind: 'note', note: '家屬已通知' })
    ok(c.events.length === 9 && c.events.at(-1).text.includes('家屬'), `時間軸 ${c.events.length} 筆`)
    // 結束
    await as('nurse01')
    msg = await errOf(() => C.endCode(c.id, { outcome: 'death' }))
    ok(msg.includes('醫師'), `護理師宣告死亡 → 「${msg}」`)
    msg = await errOf(() => C.endCode(c.id, { outcome: 'dnr' }))
    ok(msg.includes('沒有'), `沒有 DNR 的病人「依 DNR 不施行」 → 「${msg}」`)
    c = await C.endCode(c.id, { outcome: 'rosc' })
    ok(c.status === 'ended' && c.outcome === 'rosc' && db().ipdOrders.filter((o) => o.codeBlueId === c.id && o.procId === 'P054').length === 1 && !(await C.activeCodes()).length, 'ROSC：結束、帶入一次 CPR 處置費、橫幅消失')
    msg = await errOf(() => C.addCodeEvent(c.id, { kind: 'note', note: 'x' }))
    ok(msg.includes('已經結束'), '結束後不能再記')
    // ROSC 後申請轉加護病房
    pc = await C.patientCode(cell.id)
    ok(!pc.icuAfter, '護理師看不到申請按鈕')
    await expectError(() => C.requestIcuAfterCode(c.id), '護理師申請轉入')
    await as(doc.username)
    pc = await C.patientCode(cell.id)
    ok(pc.icuAfter === c.id, '醫師：ROSC 後可以申請轉加護病房')
    c = await C.requestIcuAfterCode(c.id, { note: '血壓靠輸液維持' })
    const r = db().icuRequests.find((x) => x.id === c.icuRequestId)
    ok(r?.status === 'pending' && r.category === 'other' && r.codeBlueId === c.id && r.reason.includes('ROSC') && r.reason.includes('VF') && r.reason.includes('電擊 1 次') && r.reason.includes('腎上腺素 1 劑') && r.reason.includes('血壓靠輸液'), `轉入申請（類別其他）：${r?.reason}`)
    msg = await errOf(() => C.requestIcuAfterCode(c.id))
    ok(msg.includes('已經申請過'), '同一次急救不能申請兩次')

    // DNR：不按壓、不電擊
    await as('nurse01')
    let d = await C.startCode(sep.id)
    msg = await errOf(() => C.addCodeEvent(d.id, { kind: 'cpr' }))
    ok(msg.includes('DNR') && msg.includes('胸外按壓'), `DNR 不按壓開始 CPR → 「${msg}」`)
    d = await C.addCodeEvent(d.id, { kind: 'rhythm', rhythm: 'vf' })
    msg = await errOf(() => C.addCodeEvent(d.id, { kind: 'shock', joules: 200 }))
    ok(msg.includes('電擊'), `DNR 不電擊 → 「${msg}」`)
    msg = await errOf(() => C.endCode(d.id, { outcome: 'rosc' }))
    ok(msg.includes('CPR'), '沒 CPR 不能記 ROSC')
    d = await C.endCode(d.id, { outcome: 'dnr' })
    ok(d.outcome === 'dnr' && !db().ipdOrders.some((o) => o.codeBlueId === d.id), '依 DNR 不施行急救：結束、沒有 CPR 處置費')
    const q = await C.codeQuality(30)
    // 種子兩次急救（酮酸中毒 ROSC、心肌梗塞死亡）＋這裡兩次（ROSC、依 DNR 不施行）
    ok(q.codes === 4 && q.dnr === 1 && q.resus === 3 && q.rosc === 2 && q.roscRate === 66.7, `品質指標：急救 ${q.codes}（依 DNR 不施行 ${q.dnr}）、ROSC ${q.rosc}/${q.resus}（${q.roscRate}%）`)
  }

  // 升壓劑與電解質：劑量 ↔ 流速換算、開立檢查（限加護病房、要 CVC、DNR、不重複、欄位）、護理師調流速在上限內、
  // 停藥劑量還高要原因、一般醫囑開不出也停不了、還在用不能轉出、SOFA 心血管依劑量、APACHE II 有鈉鉀血比容
  console.log('\n[升壓劑與電解質]')
  {
    dbm.resetDatabase('small')
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const V = api.vasoApi
    const ICU = '3I 加護病房'
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    const ne = db().drugs.find((d) => d.id === 'M048').vaso
    const dopa = db().drugs.find((d) => d.id === 'M049').vaso
    const vp = db().drugs.find((d) => d.id === 'M050').vaso
    ok(api.vasoRate(ne, 0.08, 60) === 18 && api.vasoDose(ne, 18, 60) === 0.08 && api.vasoRate(dopa, 5, 70) === 13.1 && api.vasoRate(vp, 0.03, 60) === 9, '換算：Norepinephrine 0.08 × 60 kg → 18 ml/h（反算 0.08）、Dopamine 5 × 70 kg → 13.1、Vasopressin 0.03 U/min → 9')
    let e = api.checkVasoOrder(ne, {})
    ok(e.dose && e.max && e.weightKg && e.target, '開立：起始劑量、上限、體重、目標都要')
    e = api.checkVasoOrder(ne, { dose: 0.2, max: 0.1, weightKg: 60, target: 'x' })
    ok(e.max?.includes('不能小於') && !e.dose, '上限不能小於起始劑量')
    e = api.checkVasoOrder(ne, { dose: 1, max: 1, weightKg: 200, target: 'x' })
    ok(e.dose?.includes('超出幫浦範圍'), `換算流速超出範圍 → 「${e.dose}」`)
    const ord = { max: 0.3, weightKg: 60 }
    ok(!api.vasoRateProblem(ne, ord, 60) && api.vasoRateProblem(ne, ord, 70)?.includes('超過醫囑上限') && api.vasoRateProblem(ne, ord, 2)?.includes('低於最低劑量') && api.vasoRateProblem(ne, ord, 0.2)?.includes('0.5'), '調流速：上限內可以、超過上限、低於最低劑量、流速範圍')
    ok(api.vasoStopNeedsReason(ne, 0.08) && !api.vasoStopNeedsReason(ne, 0.05) && !api.vasoStopNeedsReason(ne, undefined), '停藥：0.08 高於 0.05 要原因；已調降或沒在滴不用')
    ok(api.sofaCardioByVaso({ ne: 0.08 }) === 3 && api.sofaCardioByVaso({ ne: 0.12 }) === 4 && api.sofaCardioByVaso({ dopa: 4 }) === 2 && api.sofaCardioByVaso({ dopa: 8 }) === 3 && api.sofaCardioByVaso({ dopa: 16 }) === 4 && api.sofaCardioByVaso({ vasopressin: true }) === 3, 'SOFA 心血管：NE ≤0.1 → 3、>0.1 → 4；Dopamine ≤5 → 2、>5 → 3、>15 → 4；Vasopressin → 3')
    ok(api.sofaScore({ map: 80, vaso: { ne: 0.05 } }).parts.cardio === 3 && api.sofaScore({ map: 60 }).parts.cardio === 1, '用升壓劑就不看 MAP')

    // 種子
    const sep = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('A41'))
    const dka = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('E11'))
    const cell = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('L03'))
    await as('dr02')
    let pv = await V.patientVaso(sep.id)
    ok(pv.inIcu && pv.hasCvc && !pv.dnrBlocked && pv.items.length === 1 && pv.items[0].current?.dose === 0.08 && pv.items[0].current.rateMlH === 18 && pv.items[0].stopNeedsReason && pv.canOrder, `種子：敗血症 Norepinephrine 目前 ${pv.items[0]?.current?.dose} mcg/kg/min（18 ml/h）`)
    let pi = await api.icuMoveApi.patientIcu(sep.id)
    const today = pi.sofa.at(-1)
    // 今天 0 點以後還在 0.12 的那段（清晨跑測試時）就是 4 分：依當天最高劑量
    ok(today.parts.cardio >= 3 && !pi.apache.missing.includes('na') && !pi.apache.missing.includes('k') && !pi.apache.missing.includes('hct') && pi.apache.parts.na !== null, `SOFA 今天心血管 ${today.parts.cardio}（升壓劑，依當天最高劑量）；APACHE II 有鈉、鉀、血比容（缺 ${pi.apache.missing.length} 項）`)
    { // 轉入那天只住半天：區間要到那天結束，不能把之後幾天的資料算進來（以前算到「現在」，升壓劑開始前的日子也被算成 4 分）
      const vStart = db().infusions.find((x) => x.id === 'INFU-VASO-SEED-1').startAt.slice(0, 10)
      const before = pi.sofa.filter((x) => x.date < vStart)
      ok(before.every((x) => (x.parts.cardio ?? 0) <= 1), `升壓劑開始前的日子心血管只看 MAP：${before.map((x) => `${x.date.slice(5)} ${x.parts.cardio}`).join('、') || '（轉入當天就開始）'}`) }
    // 一般醫囑開不出、停不了
    let msg = await errOf(() => api.ipdApi.addOrder({ admissionId: sep.id, type: 'long', category: 'medication', drugId: 'M048', content: '', dose: 1, freq: 'QD', route: 'IV', infusion: { volumeMl: 250, rateMlH: 18 } }))
    ok(msg.includes('升壓劑'), `一般醫囑開升壓劑 → 「${msg}」`)
    msg = await errOf(() => api.ipdApi.stopOrder('IO-VASO-SEED-1'))
    ok(msg.includes('加護病房」分頁'), `一般醫囑停止升壓劑 → 「${msg}」`)
    // 開立的限制
    msg = await errOf(() => V.orderVaso(sep.id, { drugId: 'M048', dose: 0.05, max: 0.2, weightKg: 60, target: 'MAP ≥65' }))
    ok(msg.includes('已經有執行中'), `同一種重複開 → 「${msg}」`)
    let f = await fieldsOf(() => V.orderVaso(sep.id, { drugId: 'M050' }))
    ok(f.dose && f.max && f.weightKg && f.target, '欄位錯誤一次標出')
    await as(db().users.find((u) => u.doctorId === cell.doctorId).username)
    msg = await errOf(() => V.orderVaso(cell.id, { drugId: 'M048', dose: 0.05, max: 0.2, weightKg: 60, target: 'x' }))
    ok(msg.includes('只能在加護病房'), `一般病房開升壓劑 → 「${msg}」`)
    await as(db().users.find((u) => u.doctorId === dka.doctorId).username)
    const dkaCvc = db().lines.some((l) => l.admissionId === dka.id && l.kind === 'cvc' && !l.removedAt)
    msg = await errOf(() => V.orderVaso(dka.id, { drugId: 'M048', dose: 0.05, max: 0.2, weightKg: 60, target: 'x' }))
    ok(dkaCvc || msg.includes('中心靜脈導管'), `沒有 CVC 開升壓劑 → 「${msg}」`)
    const dnr = db().dnrRecords.find((d) => d.patientId === sep.patientId && !d.revoked)
    dnr.withhold.push('drugs')
    await as('dr02')
    msg = await errOf(() => V.orderVaso(sep.id, { drugId: 'M050', dose: 0.03, max: 0.04, weightKg: 60, target: 'MAP ≥65' }))
    ok(msg.includes('DNR') && (await V.patientVaso(sep.id)).dnrBlocked, `DNR 不施行急救藥物 → 「${msg}」`)
    // 服務失敗時交易回滾會換掉整個資料物件：要重新抓一次再還原
    const dnr2 = db().dnrRecords.find((d) => d.patientId === sep.patientId && !d.revoked)
    dnr2.withhold = dnr2.withhold.filter((x) => x !== 'drugs')
    const vpItem = await V.orderVaso(sep.id, { drugId: 'M050', dose: 0.03, max: 0.04, weightKg: 60, target: 'MAP ≥65 mmHg' })
    ok(vpItem.order.infusion.rateMlH === 9 && vpItem.order.infusion.volumeMl === 100 && !vpItem.current && !vpItem.stopNeedsReason && db().auditLogs[0].action === '開立升壓劑', 'Vasopressin 0.03 U/min → 9 ml/h（一袋 100 ml，還沒接上）、寫稽核')
    // 護理師：接上要 CVC、調流速在上限內
    await as('nurse01')
    let inf = await api.infusionApi.patientInfusions(sep.id)
    const neView = inf.items.find((x) => x.order.id === 'IO-VASO-SEED-1')
    ok(neView.vaso?.dose === 0.08 && neView.vaso.max === 0.3, '點滴分頁：升壓劑顯示換算劑量與上限')
    f = await fieldsOf(() => api.infusionApi.adjustRate('IO-VASO-SEED-1', { rateMlH: 70, reason: 'MAP 低於目標，調升' }))
    ok(f.rateMlH?.includes('超過醫囑上限'), `調到 70 ml/h → 「${f.rateMlH}」`)
    f = await fieldsOf(() => api.infusionApi.adjustRate('IO-VASO-SEED-1', { rateMlH: 2, reason: 'x' }))
    ok(f.rateMlH?.includes('低於最低劑量'), '調太低：要停藥請醫師停')
    inf = await api.infusionApi.adjustRate('IO-VASO-SEED-1', { rateMlH: 60, reason: 'MAP 低於目標，調升' })
    ok(inf.vaso.dose === 0.267 && inf.running.rateMlH === 60, '調到 60 ml/h（0.267 mcg/kg/min，上限內；升壓劑流速可以低於 5 ml/h 的一般下限）')
    pi = await api.icuMoveApi.patientIcu(sep.id)
    ok(pi.sofa.at(-1).parts.cardio === 4, 'SOFA 今天心血管變 4（最高 0.267 > 0.1）')
    // 還在用升壓劑不能轉出（用酮酸中毒病人：沒接呼吸器）
    db().lines.push({ id: 'LN-TEST-CVC', admissionId: dka.id, kind: 'cvc', site: '右鎖骨下', size: '7Fr', insertedAt: dateUtil.now(), placedBy: 'x', recordedBy: 'U201', recordedAt: dateUtil.now() })
    await as(db().users.find((u) => u.doctorId === dka.doctorId).username)
    await V.orderVaso(dka.id, { drugId: 'M049', dose: 5, max: 10, weightKg: 70, target: 'MAP ≥65' })
    await as('clerk01')
    const gen = db().beds.find((b) => b.ward !== ICU && b.ward !== '急診留觀區' && b.status === 'empty' && b.bedClass === '健保床')
    msg = await errOf(() => api.admissionApi.transferBed(dka.id, gen.id))
    ok(msg.includes('升壓劑'), `還在用升壓劑轉出加護病房 → 「${msg}」`)
    // 停止：劑量還高要原因
    await as('dr02')
    f = await fieldsOf(() => V.stopVaso('IO-VASO-SEED-1'))
    ok(f.reason?.includes('逐步調降'), `目前 0.267 直接停 → 「${f.reason}」`)
    await V.stopVaso('IO-VASO-SEED-1', { reason: '血壓穩定，改用 Vasopressin 維持' })
    const neo = db().ipdOrders.find((o) => o.id === 'IO-VASO-SEED-1')
    ok(neo.status === 'stopped' && neo.stopReason?.includes('Vasopressin') && db().auditLogs[0].action === '停止升壓劑', '寫原因就能停：醫囑停止、記原因、寫稽核')
    await V.stopVaso(vpItem.order.id)
    ok(db().ipdOrders.find((o) => o.id === vpItem.order.id).status === 'stopped', '沒在滴的直接停（不用原因）')
    await as('nurse01')
    inf = await api.infusionApi.patientInfusions(sep.id)
    ok(inf.orphans.some((x) => x.order.id === 'IO-VASO-SEED-1'), '護理站：醫囑停了還在滴，請停止點滴')
  }

  // 死亡出院：宣告（死因、死亡方式、權限、急救中不能宣告、急救後帶入時間）→ 醫囑停止、病摘帶入 → 遺體護理 → 死亡證明書
  // （非自然死不開）→ 送太平間（出院、床位釋放）→ 家屬結帳；死亡後不能掛號、預約住院；一般出院流程擋
  console.log('\n[死亡出院]')
  {
    dbm.resetDatabase('small')
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const D = api.deathApi
    const { now } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    const t0 = '2026-11-18 10:00'
    let e = api.checkDeathInput({}, '2026-11-10 10:00', t0)
    ok(e.cause0 && e.manner && e.course, '宣告：死因甲、死亡方式、住院經過')
    e = api.checkDeathInput({ causes: ['a', '', 'c'], manner: 'natural', course: 'x' }, '2026-11-10 10:00', t0)
    ok(e.cause1 && !e.cause0, '死因不能跳層（甲、丙有寫，乙空白）')
    e = api.checkDeathInput({ causes: ['a'], manner: 'natural', course: 'x', declaredAt: '2026-11-09 10:00' }, '2026-11-10 10:00', t0)
    ok(e.declaredAt?.includes('早於入院') && api.checkDeathInput({ causes: ['a'], manner: 'natural', course: 'x', declaredAt: '2026-11-19 10:00' }, '2026-11-10 10:00', t0).declaredAt?.includes('未來'), '死亡時間：不能早於入院、不能是未來')
    ok(api.needsProsecutor('accident') && api.needsProsecutor('pending') && !api.needsProsecutor('natural'), '非自然死要報請檢察官相驗')
    e = api.checkBodyCare({ items: ['lines', 'clean'] })
    ok(e.items?.includes('家屬告別') && e.valuables && !Object.keys(api.checkBodyCare({ items: ['lines', 'clean', 'family', 'valuables', 'tag'], valuables: '無' })).length, '遺體護理：五項都要勾、寫點交物品')
    ok(api.isExpectedDeath(['compress'], false) && !api.isExpectedDeath(['feeding'], false) && !api.isExpectedDeath(undefined, false) && api.isExpectedDeath(undefined, true), '預期死亡：有 DNR（不施行心肺復甦術的項目）或安寧收案')
    ok(api.morgueProblem({ manner: 'natural' })?.includes('遺體護理') && api.morgueProblem({ care: {}, manner: 'natural' })?.includes('死亡證明書') && !api.morgueProblem({ care: {}, manner: 'accident' }), '送太平間前：遺體護理、死亡證明書（非自然死不用）')

    // 種子
    const dead = db().admissions.find((a) => a.id === 'A-DEATH-1')
    const dp = db().patients.find((p) => p.id === dead?.patientId)
    ok(dead?.status === 'discharged' && dead.dischargeType === '死亡' && dead.death.expected && dead.death.cert && dead.death.morgueAt && dp.deceasedAt && db().beds.every((b) => b.admissionId !== dead.id), '種子：肺癌末期 DNR 病人預期死亡、遺體護理、死亡證明書、已送太平間（床位釋放）')
    await as('clerk01')
    let list = await api.ipdChargeApi.listIpdBilling()
    const di = list.find((x) => x.admissionId === dead.id)
    ok(di?.death && di.dischargeReady && !di.receiptNo && (await api.dashboardApi.getDashboard()).ipdToBill >= 1, '住院結帳清單：死亡出院、可結帳（櫃台待辦）')
    let bill = await api.ipdChargeApi.getIpdBill(dead.id)
    ok(bill.bill && !bill.blocked && bill.bill.meta.to === dead.dischargedAt.slice(0, 10), `死亡出院帳單算到出院那天（${bill.bill?.meta.days} 天，自付 ${bill.bill?.patientTotal} 元）`)
    let msg = await errOf(() => api.bookingApi.register({ patientId: dp.id, sessionId: db().sessions.find((s) => s.date > dateUtil.today() && s.period !== 'ER').id, identityCode: dp.defaultIdentity, caseType: '01' }))
    ok(msg.includes('死亡'), `死亡的病人掛號 → 「${msg}」`)
    const ch = await api.ipdChargeApi.payIpd(dead.id, { payMethod: 'card', received: 0 })
    ok(ch.receiptNo && !(await api.ipdChargeApi.listIpdBilling()).some((x) => x.admissionId === dead.id && !x.receiptNo), `家屬結帳：${ch.receiptNo}（${ch.patientTotal} 元）`)
    await as('nurse01')
    const pdv = await D.printDeathCertificate(dead.id)
    ok(pdv.cert.printed.length === 2 && pdv.print.name === dp.name && pdv.causesText[0].text === '呼吸衰竭', '家屬來拿：再印一次死亡證明書')

    // 宣告（蜂窩性組織炎病人：沒有 DNR → 非預期）
    const cell = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('L03'))
    const cellBed = cell.bedId
    await as('nurse01')
    await expectError(() => D.declareDeath(cell.id, { causes: ['x'], manner: 'natural', course: 'x' }), '護理師宣告死亡')
    let pd = await D.patientDeath(cell.id)
    ok(!pd.expected && !pd.canDeclare && !pd.death, '護理師看：非預期（沒有 DNR）、不能宣告')
    await as('dr02')
    msg = await errOf(() => D.declareDeath(cell.id, { causes: ['x'], manner: 'natural', course: 'x' }))
    ok(msg.includes('只有') && msg.includes('醫師'), `別科醫師宣告 → 「${msg}」`)
    // 急救中不能宣告；急救以宣告死亡結束 → 帶入時間、帶領醫師可以宣告
    await as('nurse01')
    const cb = await api.codeApi.startCode(cell.id)
    await as('dr02')
    await api.codeApi.leadCode(cb.id)
    msg = await errOf(() => D.declareDeath(cell.id, { causes: ['x'], manner: 'natural', course: 'x' }))
    ok(msg.includes('急救進行中'), `急救中宣告 → 「${msg}」`)
    await api.codeApi.addCodeEvent(cb.id, { kind: 'cpr' })
    await api.codeApi.endCode(cb.id, { outcome: 'death' })
    pd = await D.patientDeath(cell.id)
    ok(pd.fromCode?.id === cb.id && pd.canDeclare, '急救以宣告死亡結束：帶入那次急救（帶領的醫師可以宣告）')
    let f = await fieldsOf(() => D.declareDeath(cell.id, { causes: ['', 'b'], manner: '', course: '', codeBlueId: cb.id }))
    ok(f.cause0 && f.manner && f.course, '欄位錯誤一次標出')
    const ds0 = db().ipdOrders.filter((o) => o.admissionId === cell.id && o.status === 'active').length
    let dv = await D.declareDeath(cell.id, { causes: ['敗血性休克', '壞死性筋膜炎', '右下肢蜂窩性組織炎'], manner: 'natural', course: '蜂窩性組織炎惡化為壞死性筋膜炎，敗血性休克，急救無效', codeBlueId: cb.id })
    const ca = db().admissions.find((a) => a.id === cell.id)
    ok(dv.declaredAt === db().codeBlues.find((c) => c.id === cb.id).endedAt && dv.codeBlueId === cb.id && !dv.expected && ds0 > 0 && !db().ipdOrders.some((o) => o.admissionId === cell.id && o.status === 'active') && ca.dischargeSummary.dischargeType === '死亡' && ca.dischargeSummary.signedAt && ca.dischargeSummary.diagnosis.includes('原始死因：右下肢蜂窩性組織炎') && db().patients.find((p) => p.id === cell.patientId).deceasedAt, '帶領急救的醫師宣告：時間＝急救結束、非預期、醫囑全部停止、病摘帶入（死亡、原始死因）、病人標死亡')
    msg = await errOf(() => D.declareDeath(cell.id, { causes: ['x'], manner: 'natural', course: 'x' }))
    ok(msg.includes('已經宣告'), '不能重複宣告')
    // 一般出院、病摘、結帳都擋
    await as('clerk01')
    msg = await errOf(() => api.admissionApi.discharge(cell.id, { confirmUnfinished: true }))
    ok(msg.includes('送太平間'), `一般辦理出院 → 「${msg}」`)
    msg = await errOf(() => api.ipdChargeApi.payIpd(cell.id, { payMethod: 'card', received: 0 }))
    ok(msg.includes('送太平間後'), `送太平間前結帳 → 「${msg}」`)
    await as(db().users.find((u) => u.doctorId === cell.doctorId).username)
    msg = await errOf(() => api.ipdApi.cancelDischargeOrder(cell.id, 'x'))
    ok(msg.includes('死亡'), '不能取消准予出院')
    // 送太平間前要遺體護理、死亡證明書
    await as('nurse01')
    pd = await D.patientDeath(cell.id)
    ok(!pd.canMorgue && pd.morgueBlocked?.includes('遺體護理') && pd.canCare, '還沒遺體護理：不能送太平間')
    f = await fieldsOf(() => D.recordBodyCare(cell.id, { items: ['lines'], valuables: '' }))
    ok(f.items && f.valuables, '遺體護理：沒勾完、沒寫點交，一次標出')
    await D.recordBodyCare(cell.id, { items: ['lines', 'clean', 'family', 'valuables', 'tag'], valuables: '手機、皮夾，交配偶' })
    msg = await errOf(() => D.sendToMorgue(cell.id))
    ok(msg.includes('死亡證明書'), `沒開死亡證明書送太平間 → 「${msg}」`)
    await as(db().users.find((u) => u.doctorId === cell.doctorId).username)
    dv = await D.issueDeathCertificate(cell.id, { copies: 3 })
    ok(/死字第 \d{6} 號/.test(dv.cert.no) && dv.cert.copies === 3, `本科醫師開死亡證明書：${dv.cert.no}`)
    msg = await errOf(() => D.issueDeathCertificate(cell.id, { copies: 1 }))
    ok(msg.includes('已經開了'), '不能重複開')
    await as('nurse01')
    dv = await D.sendToMorgue(cell.id)
    const cb2 = db().admissions.find((a) => a.id === cell.id)
    await as('clerk01')
    ok(cb2.status === 'discharged' && cb2.dischargeType === '死亡' && dv.morgueAt && db().beds.find((b) => b.id === cellBed).admissionId !== cell.id && !db().lines.some((l) => l.admissionId === cell.id && !l.removedAt), '送太平間：死亡出院、床位釋放、管路記移除')
    ok((await api.ipdChargeApi.getIpdBill(cell.id)).bill, '帳單：等家屬結帳')
    // 非自然死：不開證明書、不用證明書就能送
    const frac = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('S52'))
    await as(db().users.find((u) => u.doctorId === frac.doctorId).username)
    dv = await D.declareDeath(frac.id, { causes: ['頭部外傷'], manner: 'accident', course: '病房內跌倒頭部外傷' })
    msg = await errOf(() => D.issueDeathCertificate(frac.id, { copies: 1 }))
    ok(msg.includes('檢察官'), `意外死開死亡證明書 → 「${msg}」`)
    await as('nurse01')
    await D.recordBodyCare(frac.id, { items: ['lines', 'clean', 'family', 'valuables', 'tag'], valuables: '無' })
    ok((await D.patientDeath(frac.id)).canMorgue, '非自然死：遺體護理完成就能送（相驗由檢察官）')
    // 死亡後不能預約住院
    await as('clerk01')
    msg = await errOf(() => api.admissionApi.reserve({ patientId: cell.patientId, deptId: cell.deptId, doctorId: cell.doctorId, diagnosis: 'x', reason: 'x', expectedDate: dateUtil.today(), preferBedClass: '健保床' }))
    ok(msg.includes('死亡'), `死亡的病人預約住院 → 「${msg}」`)
  }

  // 安寧共同照護：照會（主治、不重複）→ 安寧醫師收案（末期疾病別、兩位專科醫師、照護目標）或婉拒；訪視（症狀 0–10、共照費）、
  // 每週訪視到期、家屬會議；權限；收案的 NEWS2 高分不自動呼叫快速反應、死亡算預期
  console.log('\n[安寧共同照護]')
  {
    dbm.resetDatabase('small')
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const P = api.palliativeApi
    const { addMinutes, now } = dateUtil
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.checkPalliativeRequest({}).reason && !Object.keys(api.checkPalliativeRequest({ reason: 'x' })).length, '照會要寫原因')
    let e = api.checkPalliativeDecision({ accept: true })
    ok(e.disease && e.doctorIds && e.goals, '收案：末期疾病別、兩位專科醫師、照護目標')
    ok(api.checkPalliativeDecision({ accept: true, disease: '癌症', doctorIds: ['DR01', 'DR01'], goals: 'x' }).doctorIds && api.checkPalliativeDecision({ accept: false }).declineReason, '兩位要不同的醫師；婉拒要原因')
    e = api.checkPalliativeVisit({ symptoms: { pain: 11, dyspnea: 3, nausea: 0, anxiety: 0 }, note: '' })
    ok(e.pain && e.delirium && e.note && !e.dyspnea, '訪視：五項症狀 0–10、要寫評估與處置')
    ok(api.checkFamilyMeeting({ date: '2099-01-01', participants: 'x', conclusion: 'x' }, '2026-11-18').date?.includes('未來') && api.checkFamilyMeeting({}, '2026-11-18').participants, '家屬會議：日期不能是未來、參與者與結論')
    const base = { status: 'enrolled', decidedAt: '2026-11-10 10:00', visits: [] }
    ok(api.visitDueOf(base, '2026-11-12 10:00').status === 'ok' && api.visitDueOf(base, '2026-11-16 12:00').status === 'due' && api.visitDueOf(base, '2026-11-17 10:01').status === 'overdue' && api.visitDueOf({ ...base, visits: [{ at: '2026-11-16 09:00' }] }, '2026-11-17 10:01').status === 'ok' && !api.visitDueOf({ ...base, status: 'requested' }, '2026-11-17 10:00'), '每週訪視：7 天內、最後一天到期、過了逾時；訪視後重算')

    // 種子
    const pal = db().admissions.find((a) => a.id === 'A-PAL-1')
    const sep = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('A41'))
    const cell = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('L03'))
    ok(pal?.status === 'admitted' && db().palliativeCases.find((c) => c.id === 'PAL-SEED-1')?.status === 'enrolled' && db().palliativeCases.find((c) => c.id === 'PAL-SEED-2')?.admissionId === sep.id && db().users.find((u) => u.username === 'dr01').grants.join() === 'phrase.hospital,palliative', '種子：大腸癌末期收案中、敗血症待收案；dr01 被指定安寧（原本的全院片語保留）')
    await as('dr01')
    const dash = await api.dashboardApi.getDashboard()
    ok(dash.palliativeRequests === 1 && dash.palliativeVisitDue === 1, '安寧醫師首頁：照會待收案 1、訪視到期 1')
    let w = await P.listPalliative()
    ok(w.canAct && w.requested.length === 1 && w.enrolled.length === 1 && w.enrolled[0].visitDue.status === 'due' && w.enrolled[0].latest.pain === 6 && w.stats.visits30 === 2 && w.stats.meetings30 === 1, '安寧頁：待收案 1、收案中 1（訪視到期、最近疼痛 6）、30 天訪視 2 次、家屬會議 1')
    // 收案的病人：NEWS2 高分不自動呼叫
    await as('nurse01')
    ok((await api.rrtApi.patientNews(pal.id)).palliative, '生命徵象頁標出安寧收案')
    let v = await api.nursingApi.addVitals({ admissionId: pal.id, temp: 38.2, pulse: 124, resp: 28, sbp: 92, dbp: 56, spo2: 88, o2: 4, avpu: 'V' })
    ok(!v.rrtCalled && !db().rrtCalls.some((c) => c.admissionId === pal.id), '安寧收案：NEWS2 很高也不自動呼叫快速反應小組')
    await expectError(() => P.requestPalliative(cell.id, { reason: 'x' }), '護理師提出安寧照會')
    // 照會、權限
    await as('dr02')
    let msg = await errOf(() => P.requestPalliative(sep.id, { reason: 'x' }))
    ok(msg.includes('已經有'), `重複照會 → 「${msg}」`)
    msg = await errOf(() => P.decidePalliative('PAL-SEED-2', { accept: false, declineReason: 'x' }))
    ok(msg.includes('安寧共同照護'), `沒有安寧權限的醫師收案 → 「${msg}」`)
    await as('admin')
    msg = await errOf(() => P.decidePalliative('PAL-SEED-2', { accept: false, declineReason: 'x' }))
    ok(msg.includes('安寧醫師'), `管理員收案 → 「${msg}」`)
    await as('dr01')
    let f = await fieldsOf(() => P.decidePalliative('PAL-SEED-2', { accept: true }))
    ok(f.disease && f.doctorIds && f.goals, '收案欄位一次標出')
    let c = await P.decidePalliative('PAL-SEED-2', { accept: false, declineReason: '病人仍在積極治療，休克改善中；家屬會議後再評估' })
    ok(c.status === 'declined' && db().auditLogs[0].action === '安寧婉拒', '婉拒（寫原因、稽核）')
    await as('dr02')
    c = await P.requestPalliative(sep.id, { reason: '家屬會議後希望以舒適為主' })
    ok(c.status === 'requested' && (await P.patientPalliative(sep.id)).past.length === 1, '婉拒後可以再照會（以前的列在下面）')
    await as('dr01')
    c = await P.decidePalliative(c.id, { accept: true, disease: '慢性腎衰竭', doctorIds: ['DR02', 'DR03'], goals: '減少不必要的侵入性處置，家屬陪伴' })
    ok(c.status === 'enrolled' && c.terminalDoctorNames.length === 2 && c.visitDue.status === 'ok', '收案：末期評估、照護目標、下次訪視 7 天內')
    // 訪視
    f = await fieldsOf(() => P.addPalliativeVisit('PAL-SEED-1', { symptoms: { pain: 11 }, note: '' }))
    ok(f.pain && f.dyspnea && f.note, '訪視欄位一次標出')
    const o0 = db().ipdOrders.length
    c = await P.addPalliativeVisit('PAL-SEED-1', { symptoms: { pain: 4, dyspnea: 7, nausea: 1, anxiety: 3, delirium: 0 }, note: '呼吸困難 7：嗎啡皮下 2 mg Q4H PRN', spiritual: '想見孫子', goals: '控制呼吸困難；安排孫子探視' })
    const fee = db().ipdOrders.slice(o0).find((o) => o.procId === 'P056')
    ok(fee?.status === 'done' && fee.doctorId === 'DR01' && c.visitDue.status === 'ok' && c.visitsView.at(-1).severe.join() === '呼吸困難' && c.goals.includes('孫子'), '訪視：帶入共照費（安寧醫師名下）、訪視到期解除、標出嚴重症狀、更新照護目標')
    await as('dr02')
    msg = await errOf(() => api.ipdApi.addOrder({ admissionId: pal.id, type: 'stat', category: 'procedure', procId: 'P056', content: '' }))
    ok(msg.includes('安寧共同照護計費項目'), `一般醫囑開共照費 → 「${msg}」`)
    msg = await errOf(() => P.addPalliativeVisit('PAL-SEED-1', { symptoms: { pain: 1, dyspnea: 1, nausea: 1, anxiety: 1, delirium: 1 }, note: 'x' }))
    ok(msg.includes('安寧共同照護'), '主治不能記安寧訪視')
    // 家屬會議：主治可以記；別科醫師不行
    f = await fieldsOf(() => P.addFamilyMeeting('PAL-SEED-1', { date: '2099-01-01', participants: '', conclusion: '' }))
    ok(f.date && f.participants && f.conclusion, '家屬會議欄位一次標出')
    c = await P.addFamilyMeeting('PAL-SEED-1', { date: dateUtil.today(), participants: '配偶、長子、主治、社工', conclusion: '同意返家安寧，安排居家安寧轉介' })
    ok(c.meetingsView.length === 2, '主治記家屬會議')
    await as('dr07')
    msg = await errOf(() => P.addFamilyMeeting('PAL-SEED-1', { date: dateUtil.today(), participants: 'x', conclusion: 'x' }))
    ok(msg.includes('安寧醫師或主治'), `別科醫師記家屬會議 → 「${msg}」`)
    // 撤回：只有待收案的
    await as('dr01')
    c = await P.requestPalliative(cell.id, { reason: 'MRSA 蜂窩性組織炎合併多重器官衰竭，家屬希望舒適照護' })
    await P.decidePalliative(c.id, { accept: true, disease: '其他大腦變質', doctorIds: ['DR01', 'DR02'], goals: '舒適照護' })
    msg = await errOf(() => P.cancelPalliative(c.id))
    ok(msg.includes('已經處理過'), '收案後不能撤回')
    ok((await api.deathApi.patientDeath(cell.id)).expected, '沒有 DNR、但安寧收案：死亡算預期')
  }

  // 死亡病例審查與品質指標：觸發條件（非預期、48 小時內、術後 30 天、急救後、加護病房轉出 48 小時）、審查欄位與權限、
  // APACHE II 預估死亡率（診斷類別、急診手術）、院內死亡率、加護病房死亡率與 SMR
  console.log('\n[死亡病例審查]')
  {
    dbm.resetDatabase('small')
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const M = api.mortalityApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    const base = { expected: true, admittedAt: '2026-11-10 10:00', declaredAt: '2026-11-15 10:00', codeBlue: false }
    ok(!api.mortalityTriggers(base).length, '有 DNR、住 5 天、沒手術沒急救：預期死亡，不用審')
    ok(api.mortalityTriggers({ ...base, expected: false }).join() === 'noDnr' && api.mortalityTriggers({ ...base, declaredAt: '2026-11-12 09:59' }).join() === 'early' && api.mortalityTriggers({ ...base, declaredAt: '2026-11-12 10:01' }).length === 0, '非預期；入院 48 小時內（剛好 48 小時算、多 1 分鐘不算）')
    ok(api.mortalityTriggers({ ...base, lastSurgeryAt: '2026-10-17 10:00' }).join() === 'postop' && !api.mortalityTriggers({ ...base, lastSurgeryAt: '2026-10-15 09:00' }).length && api.mortalityTriggers({ ...base, codeBlue: true }).join() === 'afterCode' && api.mortalityTriggers({ ...base, lastIcuOutAt: '2026-11-14 12:00' }).join() === 'icuOut', '術後 30 天內、急救後、加護病房轉出 48 小時內')
    let e = api.checkMortalityReview({}, '2026-11-18')
    ok(e.grade && e.findings && !e.improvement, '審查：結論、檢討')
    e = api.checkMortalityReview({ grade: 'avoidable', findings: 'x' }, '2026-11-18')
    ok(e.improvement && !Object.keys(api.checkMortalityReview({ grade: 'unavoidable', findings: 'x' }, '2026-11-18')).length, '不是無可避免要寫改善事項；無可避免不用')
    e = api.checkMortalityReview({ grade: 'discuss', findings: 'x', improvement: 'x', conferenceDate: '2026-11-17' }, '2026-11-18')
    ok(e.conferenceDate?.includes('過去') && e.presenter, '需提病例討論：日期不能是過去、要報告人')
    ok(api.apacheMortality(25, 'sepsis', false) === 56.1 && api.apacheMortality(25, undefined, false) === 53.3 && api.apacheMortality(25, 'sepsis', true) > 56.1 && api.apacheMortality(10, 'dka', false) < 3, `APACHE II 預估死亡率：25 分敗血症 ${api.apacheMortality(25, 'sepsis', false)}%、沒選類別 ${api.apacheMortality(25, undefined, false)}%、急診手術再加、酮酸中毒 10 分 ${api.apacheMortality(10, 'dka', false)}%`)
    ok(api.ratePct(1, 3) === 33.3 && api.ratePct(1, 0) === null && api.smrOf(2, 1.6) === 1.25 && api.smrOf(1, 0) === null, '死亡率、SMR 的計算與沒有分母')

    // 種子
    const d2 = db().admissions.find((a) => a.id === 'A-DEATH-2')
    ok(d2?.death && !d2.death.expected && d2.death.codeBlueId === 'CB-SEED-2' && !d2.mortalityReview && db().users.find((u) => u.username === 'dr02').grants?.includes('mortality.review'), '種子：急性心肌梗塞入院 28 小時急救無效（非預期、待審查）；dr02 被指定死亡病例審查')
    await as('dr02')
    ok((await api.dashboardApi.getDashboard()).mortalityToReview === 1, '審查者首頁：死亡病例待審查 1')
    let w = await M.listMortality(30)
    const c2 = w.cases.find((c) => c.admissionId === d2.id)
    const c1 = w.cases.find((c) => c.admissionId === 'A-DEATH-1')
    ok(w.canReview && w.toReview === 1 && w.cases[0].admissionId === d2.id && c2.triggers.map((t) => t.key).join() === 'noDnr,early,afterCode' && c2.hoursInHospital === 28 && c1 && !c1.needsReview && c1.expected, '死亡審查頁：待審查的在前（非預期、48 小時內、急救後；住院 28 小時）；肺癌 DNR 的不用審')
    ok(w.stats.deaths === 2 && w.stats.discharges >= 2 && w.stats.mortalityRate === Math.round((2 / w.stats.discharges) * 1000) / 10 && w.stats.early === 1 && w.stats.unexpected === 1, `品質指標：院內死亡 ${w.stats.deaths} / 出院 ${w.stats.discharges}（${w.stats.mortalityRate}%）、48 小時內 1、非預期 1`)
    // 權限
    await as('dr03')
    let msg = await errOf(() => M.listMortality(30))
    ok(msg.includes('死亡病例審查'), `沒權限的醫師看死亡審查 → 「${msg}」`)
    await as('admin')
    w = await M.listMortality(30)
    msg = await errOf(() => M.reviewDeath(d2.id, { grade: 'unavoidable', findings: 'x' }))
    ok(!w.canReview && msg.includes('醫師'), `管理員只能看：審查 → 「${msg}」`)
    // 審查
    await as('dr02')
    msg = await errOf(() => M.reviewDeath('A-DEATH-1', { grade: 'unavoidable', findings: 'x' }))
    ok(msg.includes('不用審查'), `預期死亡審查 → 「${msg}」`)
    let f = await fieldsOf(() => M.reviewDeath(d2.id, { grade: 'discuss', findings: '' }))
    ok(f.findings && f.improvement && f.conferenceDate && f.presenter, '審查欄位一次標出')
    const conf = dateUtil.addDays(dateUtil.today(), 7)
    const rv = await M.reviewDeath(d2.id, { grade: 'discuss', findings: '入院後心導管排到隔天；夜班心電圖監視警報 3 分鐘才有人到', improvement: '急性心肌梗塞 90 分鐘內心導管；監視器警報分級與回應時間', conferenceDate: conf, presenter: '黃柏翰' })
    ok(rv.review.gradeLabel === '需提病例討論' && db().auditLogs[0].action === '死亡病例審查', '審查：需提病例討論、寫稽核')
    w = await M.listMortality(30)
    ok(w.toReview === 0 && w.conferences.some((x) => x.date === conf && x.presenter === '黃柏翰') && (await api.dashboardApi.getDashboard()).mortalityToReview === 0, '審查後：待審查 0、列入即將召開的病例討論')
    msg = await errOf(() => M.reviewDeath(d2.id, { grade: 'unavoidable', findings: 'x' }))
    ok(msg.includes('已經審查'), '不能重複審查')

    // APACHE II 預估死亡率：加護病房分頁選診斷類別
    const sep = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('A41'))
    let pi = await api.icuMoveApi.patientIcu(sep.id)
    const m0 = pi.apache.mortality
    f = await fieldsOf(() => api.icuMoveApi.setApacheInput(sep.id, { chronic: false, surgery: 'none', category: 'xx' }))
    ok(f.category, '診斷類別不正確擋')
    pi = await api.icuMoveApi.setApacheInput(sep.id, { chronic: false, surgery: 'none', category: 'septicShock' })
    ok(pi.apache.input.category === 'septicShock' && pi.apache.mortality === api.apacheMortality(pi.apache.total, 'septicShock', false) && pi.apache.mortality > m0, `敗血症 APACHE II ${pi.apache.total} 分：選「敗血性休克」預估死亡率 ${m0}% → ${pi.apache.mortality}%`)
    // 加護病房死亡率與 SMR：敗血症宣告死亡、送太平間
    await as(db().users.find((u) => u.doctorId === sep.doctorId).username)
    await api.deathApi.declareDeath(sep.id, { causes: ['敗血性休克', '肺炎'], manner: 'natural', course: '敗血性休克插管、升壓劑，多重器官衰竭' })
    await api.deathApi.issueDeathCertificate(sep.id, { copies: 1 })
    await as('nurse01')
    await api.deathApi.recordBodyCare(sep.id, { items: ['lines', 'clean', 'family', 'valuables', 'tag'], valuables: '無' })
    msg = await errOf(() => api.deathApi.sendToMorgue(sep.id))
    await as('dr02')
    w = await M.listMortality(30)
    const cs = w.cases.find((c) => c.admissionId === sep.id)
    ok(cs && cs.expected && cs.icuPredicted === pi.apache.mortality && w.stats.icuStays >= 1 && w.stats.icuDeaths === 1 && w.stats.icuExpected > 0 && w.stats.smr === Math.round((1 / w.stats.icuExpected) * 100) / 100, `加護病房：死亡 ${w.stats.icuDeaths} / ${w.stats.icuStays}（${w.stats.icuMortality}%）、預估 ${w.stats.icuExpected}、SMR ${w.stats.smr}（${msg ? `送太平間：${msg}` : '已送太平間'}）`)
  }

  // 負壓隔離室：壓差輸入與異常、這一班的狀態、空氣隔離排床（負壓優先、單人房可、加護病房只能負壓）、
  // 這一班沒記錄或負壓不足不能新收、排床建議、記錄權限、首頁待辦
  console.log('\n[負壓隔離室]')
  {
    dbm.resetDatabase('small')
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const NP = api.pressureApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.checkPressure({}).pa && api.checkPressure({ pa: -80 }).pa?.includes('不合理') && api.checkPressure({ pa: -1.8 }).note && !Object.keys(api.checkPressure({ pa: -1.8, note: '已通知工務' })).length && !Object.keys(api.checkPressure({ pa: -10 })).length, '壓差：要填、範圍、負壓不足要寫處理')
    ok(api.pressureAbnormal(-2.4) && !api.pressureAbnormal(-2.6) && api.pressureState([]).state === 'missing' && api.pressureState([{ at: '2026-11-18 08:30', pa: -10 }, { at: '2026-11-18 10:00', pa: -1 }]).state === 'abnormal' && api.pressureState([{ at: '2026-11-18 10:00', pa: -1 }, { at: '2026-11-18 11:00', pa: -9 }]).state === 'ok', '高於 −2.5 是負壓不足；這一班看最後一筆（處理後再記正常就恢復）')
    const air = [{ kind: 'airborne', organism: '疑似肺結核' }]
    ok(api.placementProblem({ isolations: air, bedClass: '健保床', roommates: [], icu: true })?.includes('加護病房只有負壓') && !api.placementProblem({ isolations: air, bedClass: '健保床', roommates: [], icu: true, negative: true }) && api.placementProblem({ isolations: air, bedClass: '雙人房', roommates: [] })?.includes('負壓隔離室') && !api.placementProblem({ isolations: air, bedClass: '單人房', roommates: [] }), '空氣隔離：負壓室可以、單人房可以、雙人房不行、加護病房只有負壓床')

    // 種子
    const ICU = '3I 加護病房'
    const pn = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('J18'))
    const neg705 = db().beds.find((b) => b.negativePressure && b.ward !== ICU)
    const icu9 = db().beds.find((b) => b.id === 'BICU9')
    ok(neg705?.bedClass === '單人房' && pn.bedId === neg705.id && icu9?.negativePressure && icu9.status === 'empty', `種子：${neg705?.ward} ${neg705?.bedNo} 改成負壓（疑似肺結核的肺炎病人住這間）、加護病房多一床 ICU9（負壓、空床）`)
    await as('nurse01')
    let rooms = await NP.listNegativeRooms()
    const r705 = rooms.find((r) => r.bedId === neg705.id)
    const r9 = rooms.find((r) => r.bedId === 'BICU9')
    ok(rooms.length === 2 && r705.occupied && r705.isolation?.includes('空氣') && r705.logs.length > 0 && r9.state !== 'ok' && !r9.occupied, `負壓室清單：705（${r705.stateLabel}，住肺炎病人、空氣隔離）、ICU9（${r9.stateLabel}${r9.last ? ` ${r9.last.pa} Pa` : ''}）`)
    let dash = await api.dashboardApi.getDashboard()
    ok(dash.negativeRoomTodo >= 1, `首頁：負壓室待處理 ${dash.negativeRoomTodo}`)
    // 排床建議與把關（加護病房：同意轉入選 ICU9）
    let hint = await NP.bedHints(pn.id)
    ok(hint.airborne && !hint.recommend.some((b) => b.id === 'BICU9'), '排床建議：ICU9 這一班負壓不足（或未記錄），不列為可收')
    await as('dr02')
    const req = await api.icuMoveApi.requestIcu(pn.id, { category: 'other', reason: '疑似肺結核，呼吸衰竭惡化' })
    await as('dr03')
    let msg = await errOf(() => api.icuMoveApi.decideIcuRequest(req.id, { accept: true, bedId: db().beds.find((b) => b.ward === ICU && b.status === 'empty' && !b.negativePressure).id }))
    ok(msg.includes('加護病房只有負壓'), `空氣隔離排加護病房一般床 → 「${msg}」`)
    msg = await errOf(() => api.icuMoveApi.decideIcuRequest(req.id, { accept: true, bedId: 'BICU9' }))
    ok(msg.includes('負壓') && db().icuRequests.find((r) => r.id === req.id).status === 'pending', `ICU9 這一班沒有正常的壓差 → 「${msg}」（申請還在待同意）`)
    // 記錄壓差
    msg = await errOf(() => NP.recordPressure('BICU9', { pa: -9 }))
    ok(msg.includes('權限') || msg.includes('護理師'), '醫師不能記壓差')
    await as('nurse01')
    let f = await fieldsOf(() => NP.recordPressure('BICU9', { pa: -2 }))
    ok(f.note, '負壓不足要寫處理')
    msg = await errOf(() => NP.recordPressure(db().beds.find((b) => !b.negativePressure).id, { pa: -9 }))
    ok(msg.includes('不是負壓'), '一般床不能記壓差')
    const rr = await NP.recordPressure('BICU9', { pa: -9 })
    ok(rr.state === 'ok' && rr.last.pa === -9 && db().auditLogs[0].action === '負壓壓差', '記錄 −9 Pa：恢復正常、寫稽核')
    hint = await NP.bedHints(pn.id)
    ok(hint.recommend.some((b) => b.id === 'BICU9'), '排床建議：ICU9 可收')
    await as('dr03')
    const placed = await api.icuMoveApi.decideIcuRequest(req.id, { accept: true, bedId: 'BICU9' })
    ok(placed.status === 'placed' && db().admissions.find((a) => a.id === pn.id).bedId === 'BICU9' && db().beds.find((b) => b.id === neg705.id).status !== 'occupied', '同意並排 ICU9：空氣隔離的病人進加護病房（以前排不進去）、705 空出來')
    await as('nurse01')
    rooms = await NP.listNegativeRooms(ICU)
    ok(rooms.length === 1 && rooms[0].occupied && rooms[0].patientName, '加護病房的負壓室：住進去了')
  }

  // 隔離連動醫囑與解除條件：建議醫囑（勾選開立、不重複、權限）、防護用品、解除條件（抗酸菌三套、快篩或症狀 24 小時、MDRO 培養兩套）、例外解除
  console.log('\n[隔離連動醫囑與解除條件]')
  {
    dbm.resetDatabase('small')
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const F = api.flagApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    // 規則
    const L = (vals) => vals.map((v, i) => ({ at: `2026-11-1${i} 06:00`, value: v }))
    ok(api.ISO_BUNDLES.airborne.some((b) => b.procId === 'P057' && b.count === 3) && api.ppeOf(['airborne', 'contact']).join() === 'N95,手套,隔離衣' && api.isMdro('MRSA（傷口）') && !api.isMdro('疥瘡'), '建議醫囑（空氣：抗酸菌三套）、防護用品、多重抗藥性菌')
    const empty = { afb: [], rapid: [], culture: [] }
    let r = api.releaseCheck('airborne', '疑似肺結核', { ...empty, afb: L(['陰性', '陰性']) })
    ok(!r.met && r.text.includes('2 套'), `空氣隔離：兩套陰性還不行（${r.text}）`)
    ok(api.releaseCheck('airborne', 'x', { ...empty, afb: L(['1+', '陰性', '陰性', '陰性']) }).met && !api.releaseCheck('airborne', 'x', { ...empty, afb: L(['陰性', '陰性', '1+']) }).met, '最近連續三套陰性才可以（之前陽性不影響、最後一套陽性不行）')
    ok(api.releaseCheck('droplet', '流感', { ...empty, rapid: L(['陰性']) }).met && api.releaseCheck('droplet', '流感', { ...empty, symptomFree24h: true }).met && !api.releaseCheck('droplet', '流感', empty).met, '飛沫隔離：快篩陰性或症狀緩解 24 小時')
    ok(!api.releaseCheck('contact', 'MRSA', { ...empty, culture: L(['無菌生長']) }).met && api.releaseCheck('contact', 'MRSA', { ...empty, culture: L(['MRSA', '無菌生長', '無菌生長']) }).met && api.releaseCheck('contact', '疥瘡', empty).met, '接觸隔離：MRSA 連續兩套無菌生長；非多重抗藥性菌沒有檢驗條件')

    // 種子
    const pn = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('J18'))
    const cell = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('L03'))
    await as('nurse01')
    let fl = await F.getPatientFlags(pn.patientId)
    const pnIso = fl.isolations.find((i) => i.kind === 'airborne')
    ok(pnIso.ppe.join() === 'N95' && !pnIso.release.met && pnIso.bundle.every((b) => b.ordered) && db().ipdOrders.filter((o) => o.isolationId === pnIso.id && o.procId === 'P057').length === 3, `種子：肺炎空氣隔離（N95）、抗酸菌三套已開，解除條件未達到（${pnIso.release.text}）`)
    const cfl = await F.getPatientFlags(cell.patientId)
    const cellIso = cfl.isolations.find((i) => i.kind === 'contact')
    ok(cellIso.ppe.join() === '手套,隔離衣' && !cellIso.release.met && cellIso.release.text.includes('1 套'), `種子：MRSA 接觸隔離，培養一套無菌生長（${cellIso.release.text}）`)
    const wp = await api.nursingApi.listWardPatients(db().beds.find((b) => b.id === pn.bedId).ward)
    ok(wp.find((p) => p.id === pn.id).ppe.join() === 'N95' && wp.find((p) => p.id === cell.id)?.ppe.join() === '手套,隔離衣', '護理站病人清單：防護用品')
    // 解除條件
    await as(db().users.find((u) => u.doctorId === pn.doctorId).username)
    let msg = await errOf(() => F.endIsolation(pnIso.id, '三套陰性'))
    ok(msg.includes('還沒達到解除條件') && msg.includes('例外解除'), `抗酸菌兩套陰性就解除 → 「${msg}」`)
    // 第三套陰性（檢驗發報告）
    const proto = db().labReports.find((x) => x.patientId === pn.patientId && x.procId === 'P057')
    db().labReports.push({ ...structuredClone(proto), id: 'LR-TEST-AFB3', no: 'LTEST0003', orderId: 'IO-AFB-3', reportedAt: dateUtil.now() })
    fl = await F.getPatientFlags(pn.patientId)
    ok(fl.isolations.find((i) => i.id === pnIso.id).release.met, '第三套陰性：解除條件達到')
    const ended = await F.endIsolation(pnIso.id, '痰液抗酸菌塗片三套陰性')
    ok(ended.ended && !ended.ended.exception && db().auditLogs[0].action === '解除隔離', '解除（不是例外）')
    // 例外解除
    await as(db().users.find((u) => u.doctorId === cell.doctorId).username)
    msg = await errOf(() => F.endIsolation(cellIso.id, '傷口癒合'))
    ok(msg.includes('連續兩套'), `MRSA 一套陰性就解除 → 「${msg}」`)
    const ex = await F.endIsolation(cellIso.id, '傷口已癒合、轉長照機構前感染科同意解除', { exception: true })
    ok(ex.ended.exception && db().auditLogs[0].action === '例外解除隔離', '勾例外解除、寫原因：可以解除（標例外、稽核）')
    // 飛沫隔離：建議醫囑開立
    const st = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    await as('nurse01')
    const sr = await F.startIsolation({ patientId: st.patientId, kind: 'droplet', organism: '流感' })
    const did = sr.isolation.id
    msg = await errOf(() => F.orderIsolationBundle(did, ['flu']))
    ok(msg.includes('權限') || msg.includes('醫師'), '護理師不能開隔離連動醫囑')
    await as(db().users.find((u) => u.doctorId === st.doctorId).username)
    msg = await errOf(() => F.orderIsolationBundle(did, []))
    ok(msg.includes('勾選'), '沒勾不能開')
    let v = await F.orderIsolationBundle(did, ['flu', 'mask'])
    const os = db().ipdOrders.filter((o) => o.isolationId === did)
    ok(os.length === 2 && os.some((o) => o.procId === 'P012' && o.type === 'stat' && o.status === 'active') && os.some((o) => o.category === 'nursing' && o.content.includes('外科口罩')) && v.bundle.filter((b) => b.ordered).map((b) => b.key).join() === 'flu,mask' && db().auditLogs[0].action === '隔離連動醫囑', '勾流感快篩、外科口罩：開臨時檢驗與護理醫囑（標記已開、稽核）')
    msg = await errOf(() => F.orderIsolationBundle(did, ['flu']))
    ok(msg.includes('已經開過'), '同一項不重複開')
    msg = await errOf(() => F.endIsolation(did, '退燒'))
    ok(msg.includes('快篩陰性'), '飛沫隔離沒有快篩陰性、沒確認症狀：擋')
    v = await F.endIsolation(did, '退燒 24 小時、咳嗽改善', { symptomFree24h: true })
    ok(v.ended && !v.ended.exception, '醫師確認症狀緩解 24 小時：可以解除（不是例外）')
  }

  // 感染管制統計、群聚、法定傳染病：菌種辨識、群聚規則（同病房 14 天、同菌種優先）、通報比對與時限；
  // 指標、群聚確認與排除、待通報與通報（權限、單號）、開隔離提醒、逾時
  console.log('\n[感染管制統計、群聚與法定傳染病]')
  {
    dbm.resetDatabase('small')
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const I = api.ipcApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    ok(api.organismOf('E. coli ≥10⁵ CFU/ml') === '大腸桿菌' && api.organismOf('MRSA（傷口）') === 'MRSA' && !api.organismOf('待報告'), '菌種辨識（英文學名對應、認不得的不算）')
    const c = (id, ward, kind, culture, onsetAt) => ({ id, ward, kind, culture, onsetAt })
    let cl = api.findClusters([c('a', '5A', 'cauti', 'E. coli', '2026-11-01'), c('b', '5A', 'cauti', '大腸桿菌', '2026-11-14')])
    ok(cl.length === 1 && cl[0].by === 'organism' && cl[0].label === '大腸桿菌' && cl[0].caseIds.join() === 'a,b', '同病房 14 天內兩例同菌種：一群（同一批不再依部位重複列）')
    ok(!api.findClusters([c('a', '5A', 'cauti', 'E. coli', '2026-11-01'), c('b', '5A', 'other', 'E. coli', '2026-11-16')]).length && !api.findClusters([c('a', '5A', 'cauti', 'E. coli', '2026-11-01'), c('b', '6B', 'cauti', 'E. coli', '2026-11-02')]).length, '相差超過 14 天、不同病房：不算')
    cl = api.findClusters([c('a', '5A', 'ssi', '待報告', '2026-11-01'), c('b', '5A', 'ssi', '綠膿桿菌', '2026-11-05')])
    ok(cl.length === 1 && cl[0].by === 'site' && cl[0].label === '手術部位感染', '菌種不同（或還沒報告）但同感染部位：依部位成群')
    ok(api.notifiableOf('疑似肺結核（待痰液抗酸菌報告）', false)?.key === 'tb' && api.notifiableOf('開放性肺結核', false)?.key === 'tb-open' && !api.notifiableOf('流感', false) && api.notifiableOf('流感', true)?.key === 'flu-severe', '法定傳染病比對：結核病、開放性肺結核（24 小時）、流感要在加護病房才算重症')
    ok(api.notifyState('2026-11-20 10:00', '2026-11-18 10:00') === 'ok' && api.notifyState('2026-11-20 10:00', '2026-11-19 11:00') === 'soon' && api.notifyState('2026-11-20 10:00', '2026-11-20 10:01') === 'overdue' && api.checkClusterDecision({ confirm: true }).note, '通報時限：時限內、前 24 小時快到期、逾時；群聚判定要寫')

    // 種子與指標
    const pn = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('J18'))
    const hasSecond = db().infectionCases.some((x) => x.id === 'INF-SEED-2')
    ok(hasSecond, '種子：5A 第二例 E. coli 泌尿道感染（安寧病人的導尿管，已判定成立）')
    await as('dr11')
    const st = await I.infectionStats(30)
    const w5 = st.rows.find((r) => r.ward === '5A 內科病房')
    ok(st.rows.length === 4 && st.total.patientDays > 0 && (!hasSecond || (st.total.hai >= 1 && w5.devices.find((d) => d.kind === 'cauti').cases >= 1 && w5.devices.find((d) => d.kind === 'cauti').lineDays > 0)), `指標：4 個病房＋全院（全院住院人日 ${st.total.patientDays}、院內感染 ${st.total.hai}、密度 ${st.total.density}）`)
    let lc = await I.listClusters()
    const cl5 = lc.clusters.find((x) => x.ward === '5A 內科病房')
    ok(!hasSecond || (cl5 && !cl5.decision && cl5.label === '大腸桿菌' && cl5.caseIds.includes('INF-SEED-1') && cl5.caseIds.includes('INF-SEED-2') && lc.canDecide), '種子：5A 兩例 E. coli 泌尿道感染＝疑似群聚待判定')
    let dash = await api.dashboardApi.getDashboard()
    ok(!hasSecond || dash.clustersOpen === 1, `感染管制首頁：疑似群聚待判定 ${dash.clustersOpen}`)
    if (cl5) {
      const f = await fieldsOf(() => I.decideCluster(cl5.key, { confirm: true, note: '' }))
      ok(f.note, '確認群聚要寫處置')
      await I.decideCluster(cl5.key, { confirm: true, note: '5A 導尿管照護查核、加強手部衛生稽核' })
      lc = await I.listClusters()
      const msg = await errOf(() => I.decideCluster(cl5.key, { confirm: false, note: 'x' }))
      ok(lc.clusters.find((x) => x.key === cl5.key)?.decision?.status === 'confirmed' && msg.includes('已經判定') && db().auditLogs[0].action === '確認群聚' && (await api.dashboardApi.getDashboard()).clustersOpen === 0, '確認群聚（稽核）；不能重複判定；首頁待判定歸零')
    }
    await as('admin')
    const msgA = await errOf(() => I.decideCluster('x', { confirm: true, note: 'x' }))
    ok(msgA.includes('感染管制醫師或護理師'), '管理員不能判定群聚')
    // 法定傳染病
    await as('dr11')
    let nfl = await I.listNotifiable()
    const tb = nfl.pending.find((p) => p.patientId === pn.patientId)
    ok(tb?.disease === 'tb' && tb.basis.includes('肺結核') && tb.state !== 'overdue', `待通報：肺炎病人疑似肺結核（${tb?.label}，時限 ${tb?.dueAt}）`)
    await as('dr02')
    ok((await api.dashboardApi.getDashboard()).notifiablePending >= 1 && (await I.patientNotifiable(pn.patientId)).canReport, '主治首頁：法定傳染病待通報；隔離分頁可以通報')
    await as('dr07')
    let msg = await errOf(() => I.reportNotifiable(pn.patientId, 'tb'))
    ok(msg.includes('主治') || msg.includes('感染管制'), `別科醫師通報 → 「${msg}」`)
    await as('dr02')
    const rep = await I.reportNotifiable(pn.patientId, 'tb', { note: '胸部 X 光右上肺葉空洞' })
    ok(/^CDC\d{12}$/.test(rep.cdcNo) && !(await I.patientNotifiable(pn.patientId)).pending.length && db().auditLogs[0].action === '法定傳染病通報', `通報：單號 ${rep.cdcNo}、待通報消失、稽核`)
    msg = await errOf(() => I.reportNotifiable(pn.patientId, 'tb'))
    ok(msg.includes('沒有待通報'), '不能重複通報')
    // 開隔離時提醒；逾時
    const sep = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('A41'))
    await as('nurse01')
    const sr = await api.flagApi.startIsolation({ patientId: sep.patientId, kind: 'droplet', organism: '流感' })
    ok(sr.notifiable?.label === '流感併發重症', '加護病房的病人開流感隔離：提醒法定傳染病（流感併發重症）')
    db().isolations.find((x) => x.id === sr.isolation.id).startedAt = dateUtil.addMinutes(dateUtil.now(), -8 * 24 * 60)
    await as('dr11')
    nfl = await I.listNotifiable()
    ok(nfl.pending[0]?.patientId === sep.patientId && nfl.pending[0].state === 'overdue' && (await api.dashboardApi.getDashboard()).notifiableOverdue >= 1 && nfl.reported.some((r) => r.id === rep.id && !r.late), '超過 7 天沒通報：逾時排最前、首頁通報逾時；剛才那筆列在已通報（準時）')
  }

  // 細菌培養與藥敏：輸入檢查、多重抗藥判斷、培養結果值；檢驗科登打（一般報告擋、欄位一次標出、血液培養陽性危急值）、
  // 抗藥菌提醒開接觸隔離（醫師首頁）、開了就消失；種子（MRSA、E. coli 藥敏）
  console.log('\n[細菌培養與藥敏]')
  {
    dbm.resetDatabase('small')
    dbm.db.securitySettings = { ...dbm.db.securitySettings, requireScan: false }
    const db = () => dbm.db
    const L = api.labApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    let e = api.checkCulture({ isolates: [{ organism: 'ECO', ast: { AMP: 'S' } }, { organism: 'ECO', ast: {} }, { organism: 'XX' }] })
    ok(e.specimen && e.ast0?.includes('Ceftriaxone') && e.organism1?.includes('重複') && e.organism2, '培養：檢體、藥敏組合沒填完、菌種重複、菌種不正確一次標出')
    ok(!Object.keys(api.checkCulture({ specimen: 'urine', isolates: [] })).length && !Object.keys(api.checkCulture({ specimen: 'sputum', isolates: [{ organism: 'CAN', ast: {} }] })).length, '無菌生長；念珠菌不做細菌藥敏')
    ok(api.mdroOf({ organism: 'ECO', ast: { MEM: 'R' } }) === 'CRE' && !api.mdroOf({ organism: 'ECO', ast: { MEM: 'S' } }) && api.mdroOf({ organism: 'MRSA', ast: {} }) === 'MRSA' && api.cultureValue([]) === '無菌生長' && api.cultureValue([{ organism: 'SAU', ast: {} }]) === '其他細菌' && api.cultureValue([{ organism: 'SAU', ast: {} }, { organism: 'VRE', ast: {} }]) === 'VRE', '多重抗藥（Meropenem 抗藥的腸道菌＝CRE）、培養結果值')
    ok(api.astKeyOfDrug('M036') === 'CRO' && api.astKeyOfDrug('M042') === 'VAN' && !api.astKeyOfDrug('M001'), '院內的藥對應藥敏項目')

    // 種子
    const cell = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('L03'))
    const st = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    const mrsa = db().labReports.find((r) => r.patientId === cell.patientId && r.culture?.isolates.some((x) => x.organism === 'MRSA'))
    const eco = db().labReports.find((r) => r.patientId === st.patientId && r.culture?.isolates.some((x) => x.organism === 'ECO'))
    ok(mrsa?.culture.isolates[0].ast.OXA === 'R' && mrsa.culture.isolates[0].ast.VAN === 'S' && mrsa.culture.specimen === 'wound', '種子：蜂窩性組織炎傷口培養 MRSA（Oxacillin 抗藥、Vancomycin 敏感）')
    ok(eco?.culture.isolates[0].ast.AMC === 'R' && eco.culture.isolates[0].ast.CRO === 'S' && eco.culture.specimen === 'urine', '種子：腦梗塞尿液培養 E. coli（Amoxicillin/Clavulanate 抗藥、Ceftriaxone 敏感）')
    await as('nurse01')
    ok(!(await api.flagApi.getPatientFlags(cell.patientId)).mdroAlerts.length, 'MRSA 已經在接觸隔離：沒有提醒')
    // 檢驗科登打
    const pd = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('S52'))
    await as(db().users.find((u) => u.doctorId === pd.doctorId).username)
    const ord = await api.ipdApi.addOrder({ admissionId: pd.id, type: 'stat', category: 'procedure', procId: 'P059', content: '' })
    await as('nurse01')
    await api.nursingApi.completeStatOrder(ord.id)
    await as('lab01')
    const key = `O:${ord.id}`
    let msg = await errOf(() => L.reportLab({ key, values: { CULT: '無菌生長' } }))
    ok(msg.includes('培養報告'), `細菌培養用一般報告 → 「${msg}」`)
    let f = await fieldsOf(() => L.reportCulture({ key, specimen: '', isolates: [{ organism: 'ECO', ast: {} }] }))
    ok(f.specimen && f.ast0, '培養報告：欄位一次標出')
    const rr = await L.reportCulture({ key, specimen: 'blood', isolates: [{ organism: 'KPN', ast: { AMC: 'R', CEX: 'R', CRO: 'R', TZP: 'R', MEM: 'R', AMP: 'S' } }] })
    ok(rr.culture.isolates[0].organism === 'KPN' && !('AMP' in rr.culture.isolates[0].ast) && rr.values[0].value === 'CRE' && rr.hasCritical && rr.needsAck && db().auditLogs[0].action === '發培養報告（危急值）', '血液培養克雷伯氏菌（Meropenem 抗藥＝CRE）：只存藥敏組合裡的、結果值 CRE、危急值待醫師確認')
    msg = await errOf(() => L.reportCulture({ key, specimen: 'blood', isolates: [] }))
    ok(msg.includes('已經發過'), '不能重複發')
    // 抗藥菌提醒
    await as(db().users.find((u) => u.doctorId === pd.doctorId).username)
    let fl = await api.flagApi.getPatientFlags(pd.patientId)
    ok(fl.mdroAlerts.length === 1 && fl.mdroAlerts[0].mdro === 'CRE' && (await api.dashboardApi.getDashboard()).mdroAlerts >= 1, '培養出 CRE、還沒隔離：隔離分頁提醒、醫師首頁「抗藥菌待隔離」')
    await api.flagApi.startIsolation({ patientId: pd.patientId, kind: 'contact', organism: 'CRE（血液）' })
    fl = await api.flagApi.getPatientFlags(pd.patientId)
    ok(!fl.mdroAlerts.length, '開了 CRE 接觸隔離：提醒消失')
    const labs = await L.patientLabs(st.patientId)
    ok(labs.reports.some((r) => r.culture?.isolates[0]?.organism === 'ECO'), '病歷的檢驗報告帶結構化培養結果')
  }

  // 抗生素管理介入（每日審視）：藥敏判讀（MRSA 對 β-lactam 天生抗藥）、療程接續（48 小時內再開、修改醫囑）、換同類提示、
  // 五條規則（無效、重疊、降階、改口服、超過 7 天）、種子示範、感染科發出建議／不用介入、主治停止或修改＝接受、不接受、首頁待辦
  console.log('\n[抗生素管理介入]')
  {
    resetDb('small')
    const db = () => dbm.db
    const S = api.abxStewardApi
    const I = api.ipdApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const userOf = (doctorId) => db().users.find((u) => u.doctorId === doctorId).username
    // 純函式：藥敏
    const ECO = { organism: 'ECO', ast: { AMP: 'R', AMC: 'R', CEX: 'S', CRO: 'S', TZP: 'S', MEM: 'S' } }
    const MRSA = { organism: 'MRSA', ast: { OXA: 'R', CEX: 'R', AMC: 'R', VAN: 'S' } }
    ok(api.sirOf(MRSA, 'M036') === 'R' && api.sirOf(MRSA, 'M042') === 'S' && api.sirOf(ECO, 'M004') === 'R' && api.sirOf(ECO, 'M006') === undefined, '藥敏：MRSA 對 Ceftriaxone 天生抗藥（沒測也算 R）、Azithromycin 沒測')
    ok(api.susceptibleDrugs([ECO]).join() === 'M005,M036,M044,M043' && api.susceptibleDrugs([ECO], (id) => api.ABX_PROFILE[id]?.oral).join() === 'M005' && api.susceptibleDrugs([MRSA]).join() === 'M042', '敏感的藥依窄效到廣效排；只看口服；MRSA 只剩 Vancomycin')
    // 純函式：療程從哪天算
    const h1 = [
      { id: 'a', drugId: 'M004', startAt: '2026-11-01 09:00', stopAt: '2026-11-05 08:00', status: 'stopped' },
      { id: 'b', drugId: 'M004', startAt: '2026-11-06 20:00', stopAt: '2026-11-07 09:00', status: 'stopped' },
      { id: 'c', drugId: 'M004', startAt: '2026-11-07 09:00', status: 'active', replaces: 'b' },
      { id: 'd', drugId: 'M004', startAt: '2026-11-09 10:00', status: 'active' },
    ]
    ok(api.abxCourseStart(h1[2], h1) === '2026-11-01 09:00', '療程接續：修改醫囑的前身、停藥 36 小時又開，一路接到最早那筆')
    ok(api.abxCourseStart({ id: 'x', drugId: 'M004', startAt: '2026-11-07 08:00', status: 'active' }, [h1[0]]) === '2026-11-01 09:00', '停藥剛好 48 小時再開：接續')
    ok(api.abxCourseStart({ id: 'x', drugId: 'M004', startAt: '2026-11-07 08:01', status: 'active' }, [h1[0]]) === '2026-11-07 08:01', '超過 48 小時：重新算第 1 天')
    ok(api.abxCourseStart({ id: 'x', drugId: 'M005', startAt: '2026-11-05 09:00', status: 'active' }, [h1[0]]) === '2026-11-05 09:00', '不同的藥不接續')
    const nm = (id) => db().drugs.find((d) => d.id === id)?.generic ?? id
    const hs = api.abxCourseHint('M004', [{ id: 'a', drugId: 'M004', startAt: '2026-11-01 09:00', stopAt: '2026-11-05 08:00', status: 'stopped' }], '2026-11-06 10:00', nm)
    ok(hs?.day === 6 && hs.text.includes('接續原療程'), `同一支 48 小時內停過：「${hs?.text}」`)
    const hc = api.abxCourseHint('M005', [{ id: 'a', drugId: 'M036', startAt: '2026-11-01 09:00', status: 'active' }], '2026-11-04 10:00', nm)
    ok(hc?.day === 4 && hc.text.includes('β-lactam') && hc.text.includes('Ceftriaxone'), `換同類：「${hc?.text}」`)
    ok(!api.abxCourseHint('M042', [{ id: 'a', drugId: 'M036', startAt: '2026-11-01 09:00', status: 'active' }], '2026-11-04 10:00', nm) && !api.abxCourseHint('M001', [], '2026-11-04 10:00', nm), '不同類、不是抗生素：沒有提示')
    // 純函式：五條規則
    const F = (orders, isolates = [], diet = 'regular', t = '2026-11-10 10:00') => api.stewardFindings({ orders, isolates, diet, now: t, drugName: nm })
    const o = (id, drugId, courseStart, route = 'IV', extra = {}) => ({ id, drugId, route, startAt: courseStart, courseStart, ...extra })
    let fs = F([o('1', 'M004', '2026-11-01 09:00', 'PO')], [ECO])
    ok(fs.length === 1 && fs[0].kind === 'ineffective' && fs[0].drugIds[0] === 'M005' && fs[0].text.includes('Cephalexin、Ceftriaxone 等'), `藥敏無效（第 10 天也不另提天數）：「${fs[0]?.text}」`)
    fs = F([o('1', 'M043', '2026-11-09 09:00')], [ECO])
    ok(fs.length === 1 && fs[0].kind === 'deescalate' && fs[0].drugIds.join() === 'M005,M036,M044', `可降階：「${fs[0]?.text}」`)
    ok(!F([o('1', 'M042', '2026-11-09 09:00')], [MRSA]).length, 'MRSA 用 Vancomycin：沒有建議')
    fs = F([o('1', 'M036', '2026-11-07 09:00')], [], 'soft')
    ok(fs.length === 1 && fs[0].kind === 'ivpo' && fs[0].drugIds.join() === 'M004,M005', `靜脈注射滿 72 小時、能進食（沒有培養用經驗對照）：「${fs[0]?.text}」`)
    ok(!F([o('1', 'M036', '2026-11-07 09:00')], [], 'npo').length && !F([o('1', 'M036', '2026-11-07 11:00')], [], 'soft').length && !F([o('1', 'M036', '2026-11-07 09:00')], [], null).length && !F([o('1', 'M042', '2026-11-07 09:00')], [], 'soft').length, '禁食、未滿 72 小時、不知道飲食、沒有口服可換：不建議改口服')
    ok(F([o('1', 'M036', '2026-11-07 09:00')], [ECO], 'soft').find((f) => f.kind === 'ivpo')?.drugIds.join() === 'M005', '有培養：只建議藥敏敏感的口服藥')
    fs = F([o('1', 'M006', '2026-11-03 09:00', 'PO')])
    ok(fs.length === 1 && fs[0].kind === 'duration' && fs[0].text.includes('第 8 天'), `超過 7 天：「${fs[0]?.text}」`)
    ok(!F([o('1', 'M006', '2026-11-04 09:00', 'PO')]).length && !F([o('1', 'M042', '2026-11-03 09:00', 'IV', { approvedDays: 14 })]).length && F([o('1', 'M042', '2026-11-03 09:00', 'IV', { approvedDays: 7 })]).some((f) => f.kind === 'duration'), '第 7 天不提；感染科核准到第 14 天不提、只核准 7 天要提')
    fs = F([o('1', 'M036', '2026-11-09 09:00'), o('2', 'M043', '2026-11-09 20:00'), o('3', 'M042', '2026-11-09 20:00')])
    ok(fs.filter((f) => f.kind === 'overlap').map((f) => f.orderId).join() === '1,2' && fs.find((f) => f.orderId === '1').withOrderIds.join() === '2', '兩支 β-lactam 重疊：兩筆都標（Vancomycin 不同類）')

    // 種子
    const st = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63'))
    const cell = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('L03'))
    const aug = db().ipdOrders.find((x) => x.id === 'IO-ABX-ST')
    const vanco = db().ipdOrders.find((x) => x.admissionId === cell.id && x.drugId === 'M042' && x.status === 'active')
    const cro = db().ipdOrders.find((x) => x.admissionId === cell.id && x.drugId === 'M036' && x.status === 'active')
    ok(aug?.admissionId === st.id && aug.status === 'active' && db().mar.some((m) => m.orderId === aug.id && m.status === 'given'), '種子：腦梗塞昨天送尿液培養後經驗性用 Augmentin 口服（已給過）')
    await as('dr11')
    let list = await S.listAbxStewardship()
    const itemOf = (id) => list.items.find((x) => x.order.id === id)
    let it = itemOf(aug.id)
    ok(list.canReview && it?.findings.length === 1 && it.findings[0].kind === 'ineffective' && !it.findings[0].handled && it.findings[0].text.includes('Amoxicillin/Clavulanate') && it.culture?.culture.isolates[0].organism === 'ECO', `種子：腦梗塞 Augmentin「藥敏無效」待介入：「${it?.findings[0]?.text}」`)
    it = itemOf(vanco.id)
    ok(it?.courseDay === 8 && it.findings.some((f) => f.kind === 'duration' && !f.handled) && it.order.abxInfo?.extend === 'over', '種子：蜂窩性組織炎 Vancomycin 第 8 天「超過 7 天」（核准 7 天也已超過）')
    it = itemOf(cro.id)
    ok(it?.findings.length === 1 && it.findings[0].kind === 'ineffective' && it.findings[0].handled?.status === 'sent' && it.findings[0].handled.id === 'ABXI-SEED-1', '種子：蜂窩性組織炎 Ceftriaxone（MRSA 天生抗藥）已發出建議、等主治回覆（無效的藥不另提天數）')
    ok(list.interventions.some((x) => x.id === 'ABXI-SEED-1' && x.statusLabel === '待主治回覆' && x.patientName), '介入紀錄：待主治回覆列得到')
    ok(list.items.every((x) => x.findings.every((f) => f.text)) && list.items[0].open > 0, '有還沒處理的建議排前面')
    let dash = await api.dashboardApi.getDashboard()
    const todo0 = list.items.filter((x) => x.open > 0).length
    ok(dash.abxSteward === todo0 && todo0 >= 2, `感染科首頁「抗生素每日審視」${dash.abxSteward}，和審視頁待審視一樣`)
    await as(userOf(cell.doctorId))
    dash = await api.dashboardApi.getDashboard()
    let ords = await I.listOrders(cell.id)
    ok(dash.abxAdvice >= 1 && ords.find((x) => x.id === cro.id)?.abxAdvice?.[0].note.includes('建議停用 Ceftriaxone') && !ords.find((x) => x.id === vanco.id).abxAdvice, '主治首頁「抗生素建議待回覆」、住院醫囑那一筆列出建議')

    // 發出建議、不用介入
    await as(userOf(st.doctorId))
    let msg = await errOf(() => S.sendAbxAdvice(aug.id, 'ineffective', '建議改藥'))
    ok(msg.includes('感染科'), `不是感染科不能發建議 → 「${msg}」`)
    await as('dr11')
    let f = await fieldsOf(() => S.sendAbxAdvice(aug.id, 'ineffective', ' '))
    ok(f.note, '發出建議要寫說明')
    msg = await errOf(() => S.sendAbxAdvice(aug.id, 'duration', '療程已足'))
    ok(msg.includes('沒有「療程超過 7 天」'), `規則沒標的不能發 → 「${msg}」`)
    const adv = await S.sendAbxAdvice(aug.id, 'ineffective', 'E. coli 對 Augmentin 抗藥，建議改 Cephalexin 500mg QID')
    ok(adv.status === 'sent' && adv.finding.includes('Amoxicillin/Clavulanate') && db().auditLogs[0].action === '抗生素管理：發出建議', '發出建議：存當時的系統建議、寫稽核')
    msg = await errOf(() => S.sendAbxAdvice(aug.id, 'ineffective', '再一次'))
    ok(msg.includes('已經處理過'), '同一條不能重複發')
    f = await fieldsOf(() => S.dismissAbxFinding(vanco.id, 'duration', ''))
    ok(f.note, '不用介入要寫理由')
    const dis = await S.dismissAbxFinding(vanco.id, 'duration', '已和主治討論：MRSA 蜂窩性組織炎合併膿瘍，預計 14 天')
    ok(dis.status === 'dismissed' && db().auditLogs[0].action === '抗生素管理：不用介入', '不用介入：寫稽核')
    list = await S.listAbxStewardship()
    ok(!itemOf(aug.id).open && !itemOf(vanco.id).open && (await api.dashboardApi.getDashboard()).abxSteward === todo0 - 2, '處理過的不再算待審視（首頁跟著少）')

    // 主治：不接受、停止＝接受
    await as(userOf(st.doctorId))
    ok((await api.dashboardApi.getDashboard()).abxAdvice === 1, '腦梗塞主治首頁：抗生素建議待回覆 1')
    const other = db().doctors.find((d) => d.deptId !== st.deptId && d.id !== 'DR11' && db().users.some((u) => u.doctorId === d.id))
    await as(userOf(other.id))
    msg = await errOf(() => S.declineAbxAdvice(adv.id, '維持原用藥'))
    ok(msg.includes('醫師'), `不是這位病人的醫師不能回覆 → 「${msg}」`)
    await as(userOf(st.doctorId))
    f = await fieldsOf(() => S.declineAbxAdvice(adv.id, ''))
    ok(f.note, '不接受要寫原因')
    const dec = await S.declineAbxAdvice(adv.id, '病人臨床改善中，維持原用藥')
    ok(dec.status === 'declined' && dec.reply.text.includes('臨床改善') && (await api.dashboardApi.getDashboard()).abxAdvice === 0 && db().auditLogs[0].action === '抗生素管理：不接受建議', '不接受：記原因，主治待辦清掉')
    msg = await errOf(() => S.declineAbxAdvice(adv.id, '再一次'))
    ok(msg.includes('回覆過'), '回覆過的不能再回')
    await as(userOf(cell.doctorId))
    await I.stopOrder(cro.id)
    let iv = db().abxInterventions.find((x) => x.id === 'ABXI-SEED-1')
    ok(iv.status === 'accepted' && iv.reply.text === '停止醫囑' && !(await api.dashboardApi.getDashboard()).abxAdvice, '主治停止 Ceftriaxone＝接受（自動記），待辦清掉')

    // 修改＝接受；療程接續與換同類提示
    await as(userOf(st.doctorId))
    const cr2 = await I.addOrder(await withRxOk({ admissionId: st.id, type: 'long', category: 'medication', drugId: 'M036', content: '', dose: 1, freq: 'Q12H', route: 'IV' }))
    await as('dr11')
    list = await S.listAbxStewardship()
    ok(itemOf(cr2.id)?.findings.some((x) => x.kind === 'overlap' && !x.handled) && itemOf(aug.id).findings.some((x) => x.kind === 'overlap'), '腦梗塞加開 Ceftriaxone：和 Augmentin 重疊（兩筆都標）')
    const ov = await S.sendAbxAdvice(cr2.id, 'overlap', '尿液 E. coli 對 Ceftriaxone 敏感：請停 Augmentin，或改單用 Cephalexin')
    list = await S.listAbxStewardship()
    ok(itemOf(aug.id).findings.find((x) => x.kind === 'overlap')?.handled?.id === ov.id, '重疊對其中一筆發過建議：另一筆的重疊也算處理過')
    await as(userOf(st.doctorId))
    await I.reviseOrder(cr2.id, { dose: 1, freq: 'QD', route: 'IV', reason: '依感染科建議調整' })
    iv = db().abxInterventions.find((x) => x.id === ov.id)
    ok(iv.status === 'accepted' && iv.reply.text.startsWith('修改醫囑'), `主治修改醫囑＝接受：「${iv.reply.text}」`)
    await I.stopOrder(aug.id)
    let hint = await S.abxCourseHintOf(st.id, 'M004')
    ok(hint?.text.includes('接續原療程') && hint.day === 2, `剛停的 Augmentin 再開：提示「${hint?.text}」`)
    const aug2 = await I.addOrder(await withRxOk({ admissionId: st.id, type: 'long', category: 'medication', drugId: 'M004', content: '', dose: 1, freq: 'BID', route: 'PO' }))
    await as('dr11')
    list = await S.listAbxStewardship()
    ok(itemOf(aug2.id)?.courseStart === aug.startAt && itemOf(aug2.id).courseDay === 2, '48 小時內再開：療程接續（審視頁第 2 天，不是第 1 天）')
    await as(userOf(st.doctorId))
    hint = await S.abxCourseHintOf(st.id, 'M005')
    ok(hint?.text.includes('β-lactam') && hint.day >= 1, `換同類 Cephalexin：提示「${hint?.text}」`)
    ok(!(await S.abxCourseHintOf(st.id, 'M001')), '不是抗生素：沒有提示')
    // 管制性抗生素：停了 48 小時內再開，療程接續（還是要重新送審）
    await as(userOf(cell.doctorId))
    await I.stopOrder(vanco.id)
    const v2 = await I.addOrder(await withRxOk({ admissionId: cell.id, type: 'long', category: 'medication', drugId: 'M042', content: '', dose: 1, freq: 'Q12H', route: 'IV', abx: { reason: 'culture', site: '皮膚軟組織', organism: 'MRSA' } }))
    ok(v2.abx.courseStart === vanco.abx.courseStart && v2.abx.status === 'pending' && v2.abxInfo.day === 8, `管制性抗生素 48 小時內再開：療程接續（${v2.abxInfo.text}）、重新送審`)
  }

  // 抗生素用量與抗藥性指標：一劑幾個 DDD、DDD／DOT 每千住院人日（依給藥紀錄）、第一株規則與藥敏統計（株數不足）、
  // 建議接受率、種子、經營月報的抗生素 DDD、主檔 DDD 欄位
  console.log('\n[抗生素用量與抗藥性指標]')
  {
    resetDb('small')
    const db = () => dbm.db
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const drug = (id) => db().drugs.find((d) => d.id === id)
    // 純函式
    ok(api.dddOfDose(drug('M036'), 1) === 0.5 && Math.abs(api.dddOfDose(drug('M004'), 1) - 1 / 3) < 1e-9 && Math.abs(api.dddOfDose(drug('M044'), 1) - 4 / 14) < 1e-9 && api.dddOfDose(drug('M001'), 1) === 0, '一劑幾個 DDD：Ceftriaxone 1g＝0.5、Augmentin 一顆（Amoxicillin 0.5 g）＝1/3、Pip/Tazo 一支（4 g）＝4/14；沒設 DDD 的 0')
    ok(api.perThousand(5, 200) === 25 && api.perThousand(1, 3) === 333.3 && api.perThousand(3, 0) === null, '每千住院人日：一位小數、分母 0 回 null')
    const u = api.usageOf([
      { admissionId: 'A', drugId: 'M036', at: '2026-11-01 09:00', ddd: 0.5 },
      { admissionId: 'A', drugId: 'M036', at: '2026-11-01 21:00', ddd: 0.5 },
      { admissionId: 'A', drugId: 'M042', at: '2026-11-01 21:00', ddd: 0.5 },
      { admissionId: 'B', drugId: 'M036', at: '2026-11-01 09:00', ddd: 0.5 },
      { admissionId: 'A', drugId: 'M036', at: '2026-11-02 09:00', ddd: 0.5 },
    ], 10)
    ok(u.ddd === 2.5 && u.dot === 4 && u.dddRate === 250 && u.dotRate === 400, `DDD 加總、DOT 同一天同一支算 1 天（不同病人、不同藥、不同天分開）：DDD ${u.ddd}、DOT ${u.dot}`)
    const fi = api.firstIsolates([
      { patientId: 'P1', reportedAt: '2026-05-01 10:00', isolates: [{ organism: 'ECO', ast: { AMP: 'R' } }] },
      { patientId: 'P1', reportedAt: '2026-03-01 10:00', isolates: [{ organism: 'ECO', ast: { AMP: 'S' } }, { organism: 'KPN', ast: {} }] },
      { patientId: 'P2', reportedAt: '2026-04-01 10:00', isolates: [{ organism: 'ECO', ast: { AMP: 'R' } }] },
    ])
    ok(fi.length === 3 && fi.find((x) => x.patientId === 'P1' && x.organism === 'ECO').ast.AMP === 'S', '每位病人每種菌只算第一株（最早那份；同病人不同菌各算）')
    const ag = api.antibiogram([{ organism: 'ECO', ast: { AMP: 'S', MEM: 'S' } }, { organism: 'ECO', ast: { AMP: 'I', MEM: 'S' } }, { organism: 'ECO', ast: { AMP: 'R' } }, { organism: 'CAN', ast: {} }])
    const ec = ag.find((r) => r.organism === 'ECO')
    ok(ag.length === 1 && ec.isolates === 3 && ec.insufficient && ec.drugs.find((d) => d.key === 'AMP').pct === 33.3 && ec.drugs.find((d) => d.key === 'MEM').tested === 2 && ec.drugs.find((d) => d.key === 'MEM').pct === 100 && ec.drugs.find((d) => d.key === 'CRO').pct === null, '藥敏統計：中等不算敏感、沒測的不算分母、少於 30 株標株數不足、念珠菌不列')
    const st = api.adviceStats([{ kind: 'ivpo', status: 'accepted' }, { kind: 'ivpo', status: 'declined' }, { kind: 'ivpo', status: 'sent' }, { kind: 'ivpo', status: 'dismissed' }, { kind: 'duration', status: 'accepted' }])
    const iv = st.find((x) => x.kind === 'ivpo')
    const tot = st.at(-1)
    ok(iv.sent === 3 && iv.rate === 50 && iv.pending === 1 && iv.dismissed === 1 && tot.kind === 'total' && tot.sent === 4 && tot.rate === 66.7 && st.find((x) => x.kind === 'overlap').rate === null, '接受率＝接受÷（接受＋不接受）：待回覆不算分母、不用介入不算建議、沒有回覆的「—」')

    // 種子與服務
    await as('dr11')
    let m = await api.abxMetricsApi.abxMetrics()
    const inRange = (at) => at && at.slice(0, 10) >= m.from && at.slice(0, 10) <= m.to
    const abxIds = new Set(db().ipdOrders.filter((o) => ['M003', 'M004', 'M005', 'M006', 'M036', 'M042', 'M043', 'M044'].includes(o.drugId)).map((o) => o.id))
    const given = db().mar.filter((x) => abxIds.has(x.orderId) && x.status === 'given' && inRange(x.executedAt))
    const ddd = given.reduce((n, x) => { const o = db().ipdOrders.find((y) => y.id === x.orderId); return n + (o.dose * drug(o.drugId).dddUnitG) / drug(o.drugId).ddd }, 0)
    ok(Math.abs(m.total.ddd - ddd) < 0.01 && m.total.ddd > 0 && m.total.dddRate === api.perThousand(m.total.ddd, m.total.patientDays), `全院 DDD ${m.total.ddd}（${m.total.dddRate}／千住院人日）：和逐筆給藥紀錄重算一樣`)
    ok(Math.abs(m.byDrug.reduce((n, d) => n + d.ddd, 0) - m.total.ddd) < 0.01 && m.byWard.reduce((n, w) => n + w.ddd, 0) <= m.total.ddd + 0.01 && m.byWard.reduce((n, w) => n + w.patientDays, 0) <= m.total.patientDays, '依藥品加總＝全院；依病房不超過全院（出院時沒有床的算在全院）')
    ok(m.byDrug.find((d) => d.drugId === 'M042')?.restricted && !m.byDrug.find((d) => d.drugId === 'M036').restricted && m.byDrug[0].ddd >= m.byDrug.at(-1).ddd, '依藥品：管制性抗生素標出、DDD 多的在前')
    const pending = db().mar.find((x) => abxIds.has(x.orderId) && x.status === 'pending' && db().ipdOrders.find((o) => o.id === x.orderId).drugId === 'M036')
    Object.assign(pending, { status: 'held', executedAt: nowStr() })
    ok((await api.abxMetricsApi.abxMetrics()).total.ddd === m.total.ddd, '暫停（沒給）的不算')
    Object.assign(pending, { status: 'given' })
    const m2 = await api.abxMetricsApi.abxMetrics()
    ok(Math.abs(m2.total.ddd - m.total.ddd - 0.5) < 0.001, '多給一劑 Ceftriaxone 1g：DDD 多 0.5')
    const ecoli = m.antibiogram.rows.find((r) => r.organism === 'ECO')
    ok(ecoli?.isolates >= 30 && !ecoli.insufficient && ecoli.drugs.find((d) => d.key === 'MEM').pct === 100 && ecoli.drugs.find((d) => d.key === 'AMP').pct < 50 && m.antibiogram.rows[0].organism === 'ECO', `種子：過去一年大腸桿菌 ${ecoli?.isolates} 株（腦梗塞那株同一位病人只算第一株）、Ampicillin 敏感率 ${ecoli?.drugs.find((d) => d.key === 'AMP').pct}%`)
    ok(m.antibiogram.rows.filter((r) => r.organism !== 'ECO').every((r) => r.insufficient) && m.antibiogram.rows.some((r) => r.organism === 'MRSA'), '其他菌（含住院中的 MRSA）少於 30 株：株數不足')
    const adv = m.advice
    ok(adv.find((x) => x.kind === 'ivpo').accepted === 1 && adv.find((x) => x.kind === 'ineffective').pending === 1 && adv.at(-1).rate === 100, '種子：已出院肺炎「改口服」已接受、蜂窩性組織炎「無效」待回覆，接受率 100%')
    await as(db().users.find((u) => u.doctorId === db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('L03')).doctorId).username)
    await api.abxStewardApi.declineAbxAdvice('ABXI-SEED-1', '已會診討論，維持原用藥')
    await as('dr11')
    ok((await api.abxMetricsApi.abxMetrics()).advice.at(-1).rate === 50, '主治不接受一筆：接受率 50%')
    await as('nurse01')
    let msg = ''
    try { await api.abxMetricsApi.abxMetrics() } catch (e) { msg = e.message }
    ok(msg !== '', `護理師不能看抗生素指標 → 「${msg}」`)

    // 經營月報：全院抗生素 DDD
    await as('admin')
    const rep = await api.managementApi.managementReport(T.slice(0, 7))
    const mFrom = `${T.slice(0, 7)}-01`
    const mDdd = db().mar.filter((x) => abxIds.has(x.orderId) && x.status === 'given' && x.executedAt && x.executedAt.slice(0, 10) >= mFrom && x.executedAt.slice(0, 10) <= T).reduce((n, x) => { const o = db().ipdOrders.find((y) => y.id === x.orderId); return n + (o.dose * drug(o.drugId).dddUnitG) / drug(o.drugId).ddd }, 0)
    ok(api.MGMT_KPIS.some((k) => k.key === 'abxDdd' && k.group === '住院') && rep.current.abxDdd === api.perThousand(mDdd, rep.current.patientDays) && rep.current.abxDdd > 0 && api.mgmtValueText(12.34, 'DDD/千人日') === '12.3', `經營月報「抗生素用量」（DDD／千住院人日）本月 ${rep.current.abxDdd}（分母用月報的住院人日）`)
    // 主檔
    const base = { ...drug('M036') }
    let f = await fieldsOf(() => api.masterApi.saveDrug({ ...base, dddUnitG: undefined }))
    ok(f.dddUnitG, 'DDD 和每單位克數要一起填')
    f = await fieldsOf(() => api.masterApi.saveDrug({ ...base, ddd: -1 }))
    ok(f.ddd, 'DDD 要大於 0')
    const saved = await api.masterApi.saveDrug({ ...base, ddd: 2, dddUnitG: 1 })
    const cleared = await api.masterApi.saveDrug({ ...saved, ddd: undefined, dddUnitG: undefined })
    ok(saved.ddd === 2 && saved.dddUnitG === 1 && cleared.ddd === undefined, '主檔存 DDD；兩個都清空＝不列入用量統計')
  }

  // 病人辨識腕帶與給藥條碼核對：腕帶（住院號）、逐步掃描與不符紀錄、給藥前服務層再核對、略過原因、設定、統計
  console.log('\n[給藥條碼核對]')
  {
    dbm.resetDatabase('small') // 這一段要測掃描：不用 resetDb（它會關掉掃描）
    const db = () => dbm.db
    const NA = api.nursingApi
    const SA = api.scanApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    // 規則
    const A = (o) => ({ id: 'A1', admitNo: 'I261110001', patientId: 'P1', status: 'admitted', patientName: '甲', bedNo: '501-1', ...o })
    const me = A()
    const all = [me, A({ id: 'A2', admitNo: 'I261110002', patientId: 'P2', patientName: '乙', bedNo: '502-1' }), A({ id: 'A0', admitNo: 'I260901003', status: 'discharged' }), A({ id: 'A9', admitNo: 'I260801009', patientId: 'P9', patientName: '丙', status: 'discharged' })]
    ok(api.checkPatientScan(' i261110001\n', me, all).ok && api.normalizeCode(' ab1 ') === 'AB1', '腕帶：本人這次住院的住院號（掃描槍的空白、換行、大小寫不影響）')
    const r2 = api.checkPatientScan('I261110002', me, all)
    ok(!r2.ok && r2.message.includes('病人不對') && r2.message.includes('502-1 乙'), `別床病人的腕帶 → 「${r2.message}」`)
    const r0 = api.checkPatientScan('I260901003', me, all)
    ok(!r0.ok && r0.message.includes('舊腕帶'), `本人上次住院的舊腕帶 → 「${r0.message}」`)
    ok(api.checkPatientScan('I260801009', me, all).message.includes('已不在院') && api.checkPatientScan('XYZ', me, all).message.includes('不是本院') && !api.checkPatientScan('', me, all).ok, '已出院別人的腕帶、不認得的條碼、沒掃 → 擋')
    const D = [{ nhiCode: 'AC1', name: 'Amoxicillin 250mg' }, { nhiCode: 'AC2', name: 'Amoxicillin 500mg' }]
    const rd = api.checkDrugScan('AC2', D[0], D)
    ok(api.checkDrugScan('ac1', D[0], D).ok && !rd.ok && rd.message.includes('Amoxicillin 500mg') && api.checkDrugScan('ZZ', D[0], D).message.includes('不認得'), `藥品：健保碼要一樣；拿錯規格 → 「${rd.message}」`)
    ok(Object.keys(api.SCAN_SKIP_LABEL).length === 4, '略過原因：腕帶、藥品條碼、掃描器、緊急')

    // 種子
    const inpt = db().admissions.filter((a) => a.status === 'admitted')
    ok(inpt.every((a) => a.wristband?.printedAt === a.admittedAt), `種子：住院中的 ${inpt.length} 位報到時都印了腕帶`)
    ok(db().mar.filter((m) => m.status === 'given').every((m) => m.scan) && db().scanMismatches.length === 0, '種子：已給的藥都有掃描紀錄、沒有不符')
    const ward = db().beds.find((b) => b.id === inpt[0].bedId).ward
    await as('nurse01')
    const st0 = await SA.scanStats(ward, T)
    ok(st0.given === st0.scanned + st0.skipped + st0.notRequired && st0.skips.length === st0.skipped && st0.skips.every((x) => x.reason && x.nurseName), `掃描統計（${ward} 今天）：已給 ${st0.given}＝掃描 ${st0.scanned}＋略過 ${st0.skipped}＋不需要 ${st0.notRequired}`)
    ok((await SA.scanPolicy()).requireScan && (await SA.scanPolicy()).demoAssist, '預設：給藥要掃描、有示範用模擬掃描')

    // 給藥：臨時給藥（不必等藥局調劑）
    const adm = inpt.find((a) => db().beds.find((b) => b.id === a.bedId).ward === ward)
    const other = inpt.find((a) => a.id !== adm.id)
    const docUser = db().users.find((u) => u.doctorId === adm.doctorId).username
    const newStat = async (drugId = 'M001') => {
      await as(docUser)
      const o = await api.ipdApi.addOrder({ ...(await withRxOk({ admissionId: adm.id, type: 'stat', category: 'medication', drugId, content: '', dose: 1, freq: 'STAT', route: 'PO' })), allowDuplicate: true })
      await as('nurse01')
      return { o, m: db().mar.find((x) => x.orderId === o.id) }
    }
    const { o: o1, m: m1 } = await newStat()
    const drug = db().drugs.find((d) => d.id === 'M001')
    let msg = await errOf(() => NA.executeMar(m1.id, 'given'))
    ok(msg.includes('請先掃描'), `沒掃描就給藥 → 「${msg}」`)
    let r = await SA.scanCheck({ admissionId: adm.id, orderId: o1.id, kind: 'patient', code: other.admitNo })
    ok(!r.ok && r.message.includes(db().patients.find((p) => p.id === other.patientId).name) && db().scanMismatches.length === 1 && db().auditLogs[0].action === '掃描不符', `掃到別人的腕帶 → 「${r.message}」，記下這次差點給錯、寫稽核`)
    r = await SA.scanCheck({ admissionId: adm.id, orderId: o1.id, kind: 'patient', code: adm.admitNo })
    ok(r.ok && r.message.includes('病人正確'), `本人腕帶 → 「${r.message}」`)
    const wrong = db().drugs.find((d) => d.id !== 'M001' && d.active)
    r = await SA.scanCheck({ admissionId: adm.id, orderId: o1.id, kind: 'drug', code: wrong.nhiCode })
    ok(!r.ok && r.message.includes(wrong.name) && db().scanMismatches.length === 2 && db().scanMismatches[1].kind === 'drug', `拿錯藥 → 「${r.message}」`)
    r = await SA.scanCheck({ admissionId: adm.id, orderId: o1.id, kind: 'drug', code: drug.nhiCode })
    ok(r.ok, '正確的藥 → 通過')
    msg = await errOf(() => NA.executeMar(m1.id, 'given', '', undefined, undefined, undefined, { patientCode: other.admitNo, drugCode: drug.nhiCode }))
    ok(msg.includes('病人不對') && db().mar.find((x) => x.id === m1.id).status === 'pending', `直接呼叫 API 送別人的腕帶：服務層再核對、擋下 「${msg}」`)
    msg = await errOf(() => NA.executeMar(m1.id, 'given', '', undefined, undefined, undefined, { patientCode: adm.admitNo, drugCode: wrong.nhiCode }))
    ok(msg.includes('藥品不對'), '送錯的藥品條碼：服務層擋下')
    await NA.executeMar(m1.id, 'given', '', undefined, undefined, undefined, { patientCode: ` ${adm.admitNo.toLowerCase()}\n`, drugCode: drug.nhiCode })
    ok(db().mar.find((x) => x.id === m1.id).scan?.mode === 'scanned' && db().auditLogs[0].detail.includes('已掃描核對'), '兩個都對：給藥、記「已掃描」、稽核註明')
    // 暫停、拒絕不用掃
    const { m: m2 } = await newStat()
    await NA.executeMar(m2.id, 'held', '病人外出檢查')
    ok(db().mar.find((x) => x.id === m2.id).status === 'held' && !db().mar.find((x) => x.id === m2.id).scan, '暫停給藥不用掃描（沒有給）')
    // 略過
    const { m: m3 } = await newStat()
    let f = await fieldsOf(() => NA.executeMar(m3.id, 'given', '', undefined, undefined, undefined, { skip: 'lazy' }))
    ok(!!f.scan, '略過要選有效的原因')
    await NA.executeMar(m3.id, 'given', '', undefined, undefined, undefined, { skip: 'scanner', note: '掃描器沒電' })
    const rec3 = db().mar.find((x) => x.id === m3.id)
    ok(rec3.scan?.mode === 'skipped' && rec3.scan.reason === 'scanner' && rec3.scan.note === '掃描器沒電' && db().auditLogs[0].detail.includes('未掃描（掃描器故障：掃描器沒電）'), '略過掃描：記原因與說明、稽核註明未掃描')
    // PRN 也要掃
    await as(docUser)
    const prn = await api.ipdApi.addOrder({ ...(await withRxOk({ admissionId: adm.id, type: 'long', category: 'medication', drugId: 'M001', content: '', dose: 1, freq: 'PRN', route: 'PO' })), allowDuplicate: true })
    await as('nurse01')
    msg = await errOf(() => NA.givePrn(prn.id, '疼痛分數 6 分'))
    ok(msg.includes('請先掃描'), 'PRN 給藥也要掃描')
    const pm = await NA.givePrn(prn.id, '疼痛分數 6 分', undefined, undefined, { patientCode: adm.admitNo, drugCode: drug.nhiCode })
    ok(pm.scan?.mode === 'scanned', 'PRN 掃描通過後給藥')
    // 統計
    const st1 = await SA.scanStats(ward, T)
    ok(st1.mismatches.length === 2 && st1.mismatches.some((x) => x.kind === 'patient') && st1.skips.some((x) => x.note === '掃描器沒電') && st1.given === st1.scanned + st1.skipped + st1.notRequired && st1.scanned === st0.scanned + 2, '統計：掃描不符 2 筆（病人、藥品）、略過有原因、數字對得起來')
    await as('clerk01')
    await expectError(() => SA.scanStats(ward, T), '櫃台看掃描統計')
    // 示範用模擬掃描
    await as('nurse01')
    const { o: o4, m: m4 } = await newStat()
    const demo = await SA.scanDemoCodes(adm.id, o4.id)
    ok(demo.options.some((x) => x.kind === 'patient' && x.right && x.code === adm.admitNo) && demo.options.some((x) => x.kind === 'patient' && !x.right) && demo.options.some((x) => x.kind === 'drug' && x.right && x.code === drug.nhiCode) && demo.options.some((x) => x.kind === 'drug' && !x.right), '模擬掃描選單：本人、別床病人的腕帶、正確與拿錯的藥')
    // 設定
    await expectError(() => SA.saveScanPolicy({ requireScan: false, demoAssist: false }), '護理師改掃描設定')
    await as('admin')
    await SA.saveScanPolicy({ requireScan: false, demoAssist: false })
    ok(db().auditLogs[0].action === '修改安全設定' && db().auditLogs[0].detail.includes('給藥需掃描條碼 開 → 關'), '管理員關閉掃描（寫稽核）')
    await as('nurse01')
    msg = await errOf(() => SA.scanDemoCodes(adm.id, o4.id))
    ok(msg.includes('已關閉'), '關閉示範選單後不提供模擬條碼')
    await NA.executeMar(m4.id, 'given')
    ok(db().mar.find((x) => x.id === m4.id).status === 'given' && !db().mar.find((x) => x.id === m4.id).scan && (await SA.scanStats(ward, T)).notRequired === st1.notRequired + 1, '關閉後不用掃描就能給藥（統計列在「不需要掃描」）')
    // 腕帶
    await as('ph01')
    await expectError(() => SA.getWristband(adm.id), '藥師看腕帶')
    await as('nurse01')
    const wb = await SA.getWristband(adm.id)
    ok(wb.printed === 1 && wb.admitNo === adm.admitNo && wb.chartNo && wb.birthDate, '腕帶：住院號、病歷號、出生日期；已印 1 條')
    f = await fieldsOf(() => SA.printWristband(adm.id))
    ok(!!f.reason, '重印腕帶要寫原因')
    const wb2 = await SA.printWristband(adm.id, '腕帶弄濕無法掃描')
    ok(wb2.printed === 2 && wb2.reprints[0].reason === '腕帶弄濕無法掃描' && db().auditLogs[0].action === '重印腕帶', '重印：第 2 條、記原因與稽核')
    const dis = db().admissions.find((a) => a.status === 'discharged')
    msg = await errOf(() => SA.printWristband(dis.id))
    ok(msg.includes('住院中'), `出院的病人印腕帶 → 「${msg}」`)
    // 報到：住院中心報到後印第一條（不用原因）
    await as('clerk01')
    const rsv = db().admissions.find((a) => a.status === 'reserved')
    const bed = db().beds.find((b) => b.status === 'empty')
    const ci = await api.admissionApi.checkIn(rsv.id, bed.id)
    ok(!ci.wristband && (await SA.getWristband(rsv.id)).printed === 0, '剛報到：還沒印腕帶（護理站標「未印腕帶」）')
    const wb3 = await SA.printWristband(rsv.id)
    ok(wb3.printed === 1 && db().auditLogs[0].action === '列印腕帶', '報到後印第一條：不用原因')
  }

  // 預約未到追蹤（就醫日已過還沒報到、聯絡結果、改約）與出院後回診（醫師住院中預約、30 天內第一次回診比照經轉診）
  console.log('\n[預約未到與出院後回診]')
  {
    resetDb('small')
    const db = () => dbm.db
    const BK = api.bookingApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const asDoctor = (doctorId) => as(db().users.find((u) => u.doctorId === doctorId).username)
    const V = (id) => db().visits.find((v) => v.id === id)
    // 規則
    ok(api.isNoShow({ status: 'registered', date: addDaysT(-1) }, T) && !api.isNoShow({ status: 'registered', date: T }, T) && !api.isNoShow({ status: 'dispensed', date: addDaysT(-1) }, T) && !api.isNoShow({ status: 'registered', date: addDaysT(-1), refillOf: 'E1' }, T), '未到：就醫日已過、還是已掛號；今天的、看過診的、慢箋領藥不算')
    ok(api.noShowKind({ afterDischarge: {}, followUpOf: {}, caseType: '04' }) === 'afterDischarge' && api.noShowKind({ followUpOf: {}, caseType: '04' }) === 'followUp' && api.noShowKind({ caseType: '04' }) === 'chronic' && !api.isImportantNoShow({ caseType: '01' }), '類別：出院後回診 > 醫師約的回診 > 慢性病 > 一般（一般的不催）')
    ok(!api.noShowClosed({}) && !api.noShowClosed({ noShow: { contacts: [{ result: 'unreachable' }] } }) && api.noShowClosed({ noShow: { contacts: [{ result: 'unreachable' }, { result: 'declined' }] } }), '結案：最後一筆是改約或不需要；聯絡不到還沒結案')
    const ad = { afterDischarge: { admissionId: 'A' } }
    ok(api.afterDischargeCopayEligible({ ...ad, date: '2026-11-30' }, '2026-11-01', false) && !api.afterDischargeCopayEligible({ ...ad, date: '2026-12-02' }, '2026-11-01', false) && !api.afterDischargeCopayEligible({ ...ad, date: '2026-10-31' }, '2026-11-01', false), '出院後回診比照經轉診：出院後 30 天內（第 31 天起不算、出院前不算）')
    ok(!api.afterDischargeCopayEligible({ ...ad, date: '2026-11-10' }, '2026-11-01', true) && !api.afterDischargeCopayEligible({ ...ad, date: '2026-11-10' }, undefined, false) && !api.afterDischargeCopayEligible({ date: '2026-11-10' }, '2026-11-01', false), '更早的出院回診已看過診、沒有出院日、不是出院時約的 → 不算')
    const B = await load('/src/services/billing.ts')
    const Vw = await load('/src/services/views.ts')
    const lk = { ...Vw.billingLookup('01'), referredOf: () => '出院後回診' }
    const line = B.calcChargeLines({ id: 'x', date: T, caseType: '01', identityCode: '01' }, { medications: [], procedures: [] }, lk).find((l) => l.kind === 'copay-basic')
    ok(line?.name === '門診基本部分負擔（出院後回診）' && line.amount === db().billingSettings.basicCopayReferred, `批價明細：「${line?.name}」收經轉診的金額`)

    // 種子：四種未到
    await as('ph01')
    await expectError(() => BK.listNoShows(), '藥師看未到追蹤')
    await as('clerk01')
    const l0 = await BK.listNoShows()
    ok(l0.length >= 4 && l0.every((x) => x.date < T && x.date >= addDaysT(-14) && x.status === 'registered' && !x.closed), `未到清單：最近 14 天、就醫日已過的 ${l0.length} 筆`)
    ok(l0[0].kind === 'afterDischarge' && l0[0].afterDischargeAdmitNo && l0[0].copayReferred === '出院後回診' && l0[0].phone, `出院後回診沒來排第一（住院 ${l0[0].afterDischargeAdmitNo}，有電話）`)
    const fu = l0.find((x) => x.kind === 'followUp')
    ok(fu && fu.followUpByName && fu.contacts.length === 1 && fu.contacts[0].result === 'unreachable' && fu.contacts[0].byName && !fu.closed, '醫師約的回診沒來：昨天打過電話聯絡不到，還沒結案')
    const ch = l0.find((x) => x.kind === 'chronic')
    const nm = l0.find((x) => x.kind === 'normal')
    ok(!!ch && !!nm && !nm.important && ch.important, '慢性病（要追）與一般預約（列著不催）')
    ok(!l0.some((x) => x.date === T) && !(await BK.listNoShows()).some((x) => x.date > T), '今天、未來的預約不在清單')
    const dash = await api.dashboardApi.getDashboard()
    ok(dash.noShowsToFollow === l0.filter((x) => x.important).length, `櫃台首頁「預約未到待追蹤」${dash.noShowsToFollow}＝清單上要追的`)
    // 聯絡結果
    let f = await fieldsOf(() => BK.recordNoShowContact(ch.id, { result: 'declined', note: ' ' }))
    ok(!!f.note, '病人不需要：要寫原因')
    f = await fieldsOf(() => BK.recordNoShowContact(ch.id, { result: 'rebooked' }))
    ok(!!f.result, '「已改約」不能用記錄的（要用改約）')
    const r1 = await BK.recordNoShowContact(ch.id, { result: 'unreachable' })
    ok(!r1.closed && r1.contacts.length === 1 && db().auditLogs[0].action === '未到追蹤', '聯絡不到：還在清單、寫稽核')
    const r2 = await BK.recordNoShowContact(ch.id, { result: 'declined', note: '已在他院追蹤' })
    ok(r2.closed && r2.contacts.length === 2 && !(await BK.listNoShows()).some((x) => x.id === ch.id) && (await BK.listNoShows({ includeClosed: true })).some((x) => x.id === ch.id && x.closed), '病人不需要：結案，預設清單不列、含已結案才列')
    let msg = await errOf(() => BK.recordNoShowContact(ch.id, { result: 'unreachable' }))
    ok(msg.includes('已經結案'), `結案後再記錄 → 「${msg}」`)
    ok((await api.dashboardApi.getDashboard()).noShowsToFollow === dash.noShowsToFollow - 1, '結案後首頁待辦少 1')
    const todayReg = db().visits.find((v) => v.date === T && v.status === 'registered' && !v.refillOf)
    msg = await errOf(() => BK.recordNoShowContact(todayReg.id, { result: 'unreachable' }))
    ok(msg.includes('還沒過就醫日'), `今天的掛號記未到 → 「${msg}」`)
    // 改約：醫師約的回診 → 掛同科新的診次，原本那筆留著
    {
      const otherDept = (await api.scheduleApi.listSessions({ date: addDaysT(3) })).find((s) => s.deptId !== fu.deptId && s.bookable)
      msg = await errOf(() => BK.rebookNoShow(fu.id, { sessionId: otherDept.id }))
      ok(msg.includes('同一科'), `改約到別科 → 「${msg}」`)
    }
    let target
    for (let k = 1; k <= 7 && !target; k++) target = (await api.scheduleApi.listSessions({ date: addDaysT(k), deptId: fu.deptId })).find((s) => s.bookable)
    const nv = await BK.rebookNoShow(fu.id, { sessionId: target.id, note: '病人說忘記了' })
    const old = V(fu.id)
    ok(nv.rebookedFrom === fu.id && nv.followUpOf?.visitId === old.followUpOf.visitId && nv.date === target.date, `改約 → ${nv.date} ${nv.doctorName} #${nv.seqNo}：仍標醫師約的回診、記從哪筆改約`)
    ok(old.status === 'registered' && old.noShow.contacts.at(-1).result === 'rebooked' && old.noShow.contacts.at(-1).rebookedVisitId === nv.id && db().auditLogs[0].action === '未到改約', '原本那筆留著（查得到沒來）、記「已改約」結案、寫稽核')
    const fu2 = (await BK.listNoShows({ includeClosed: true })).find((x) => x.id === fu.id)
    ok(fu2.closed && fu2.contacts.at(-1).rebooked?.seqNo === nv.seqNo, '清單上顯示改約到哪一診')
    msg = await errOf(() => BK.rebookNoShow(fu.id, { sessionId: target.id }))
    ok(msg.includes('已經結案'), '已改約的不能再改約')
    // 標的是之後最早的一筆同科掛號：病人原本就有更早的同科掛號時是那一筆（依日期，例如 11/18 跑的時候）
    ok(!!fu2.laterVisit && fu2.laterVisit.date <= nv.date, '病人之後已有同科掛號：清單標出來（聯絡前先確認；之後最早的一筆）')

    // 出院後回診：種子的准出院病人已約好
    const ready = db().admissions.find((a) => a.status === 'admitted' && a.dischargeSummary?.signedAt)
    await as('nurse01')
    const al = await BK.listAfterDischarge(ready.id)
    ok(al.length === 1 && al[0].afterDischarge && al[0].date > T && al[0].copayReferred === '出院後回診' && al[0].afterDischargeByName, `種子：准出院的病人已約 ${al[0]?.date} ${al[0]?.doctorName}（護理站看得到；還在住院，以今天出院估比照經轉診）`)
    await expectError(() => BK.afterDischargeOptions(ready.id), '護理師預約出院後回診')
    const other = db().doctors.find((d) => d.deptId !== ready.deptId && d.active)
    await asDoctor(other.id)
    msg = await errOf(() => BK.afterDischargeOptions(ready.id))
    ok(msg.includes('醫師'), `別科醫師預約出院後回診 → 「${msg}」`)
    await asDoctor(ready.doctorId)
    const op = await BK.afterDischargeOptions(ready.id)
    ok(op.deptId === ready.deptId && op.suggestions.length === 3 && op.suggestions.every((s) => !s.session || (s.session.doctorId === ready.doctorId && s.session.date >= s.date)) && op.booked.length === 1, '預約選項：1／2／4 週後主治醫師的門診；列出已約的')
    msg = await errOf(() => BK.afterDischargeSessions(ready.id, T, ready.deptId))
    ok(msg.includes('明天以後'), '出院後回診不能約今天')
    const s14 = op.suggestions[1].session
    msg = await errOf(() => BK.bookAfterDischarge(ready.id, { sessionId: s14.id }))
    ok(msg.includes('確定要再約'), `同科已有未來掛號 → 「${msg}」`)
    const b2 = await BK.bookAfterDischarge(ready.id, { sessionId: s14.id, confirmDuplicate: true })
    const pt = db().patients.find((p) => p.id === ready.patientId)
    ok(b2.afterDischarge.admissionId === ready.id && b2.identityCode === pt.defaultIdentity && b2.caseType === '01' && db().auditLogs[0].action === '預約出院後回診', '確認後約好：病人的預設身分、01 案件、寫稽核')
    // 別科（例：住內科、約家醫科）
    const od = db().departments.find((d) => d.id !== ready.deptId && d.active && d.id !== 'D04' && d.id !== 'D05')
    let os
    for (let k = 7; k <= 14 && !os; k++) os = (await BK.afterDischargeSessions(ready.id, addDaysT(k), od.id)).find((s) => !s.blocked)
    const b3 = await BK.bookAfterDischarge(ready.id, { sessionId: os.id })
    ok(b3.deptId === od.id && b3.afterDischarge, `可以約別科（${od.name}）`)
    // 第一次實際就醫才比照經轉診
    const first = al[0]
    V(first.id).status = 'dispensed'
    const later = (await BK.listAfterDischarge(ready.id)).filter((v) => v.id !== first.id && v.date > first.date)
    ok(later.length && later.every((v) => !v.copayReferred), '最早那筆看過診後，之後的出院回診不再比照經轉診')
    V(first.id).status = 'registered'
    // 取消
    await as('clerk01')
    await expectError(() => BK.cancelAfterDischarge(b3.id), '櫃台用「取消出院後回診」')
    await asDoctor(ready.doctorId)
    await BK.cancelAfterDischarge(b3.id)
    ok(V(b3.id).status === 'cancelled' && !(await BK.listAfterDischarge(ready.id)).some((v) => v.id === b3.id) && db().auditLogs[0].action === '取消出院後回診', '醫師取消：退掛、不再列出、寫稽核')
    // 已出院的不能再約；種子出院 9 天、2 天前沒來的那筆比照經轉診
    const dis = db().admissions.find((a) => a.id === db().visits.find((v) => v.id === l0[0].id).afterDischarge.admissionId)
    await asDoctor(dis.doctorId)
    msg = await errOf(() => BK.afterDischargeOptions(dis.id))
    ok(dis.status === 'discharged' && msg.includes('只有住院中'), `出院後再預約 → 「${msg}」`)
    const nvAd = { ...V(l0[0].id), identityCode: '01' }
    const adLine = B.calcChargeLines(nvAd, { medications: [], procedures: [] }, Vw.billingLookup('01')).find((l) => l.kind === 'copay-basic')
    ok(adLine?.name.includes('出院後回診'), '出院 9 天後的回診（第一次就醫）：批價收比照經轉診')
    const far = { ...nvAd, id: 'tmp', date: addDaysT(25) }
    ok(!B.calcChargeLines(far, { medications: [], procedures: [] }, Vw.billingLookup('01')).find((l) => l.kind === 'copay-basic')?.name.includes('（'), '出院第 34 天：收一般的基本部分負擔')
    // 未到改約沿用出院後回診
    await as('clerk01')
    let t2
    for (let k = 1; k <= 7 && !t2; k++) t2 = (await api.scheduleApi.listSessions({ date: addDaysT(k), deptId: l0[0].deptId })).find((s) => s.bookable && !db().visits.some((v) => v.sessionId === s.id && v.patientId === l0[0].patientId))
    const nv2 = await BK.rebookNoShow(l0[0].id, { sessionId: t2.id })
    ok(nv2.afterDischarge?.admissionId === dis.id && nv2.copayReferred === '出院後回診', '出院回診沒來、改約：新的那筆仍是出院後回診（30 天內、還沒看過診，比照經轉診）')
  }

  // 住院中費用查詢與期中繳款：試算 − 已繳、提醒、收款與作廢、日結、出院結帳扣抵與退還多繳、費用明細表
  console.log('\n[期中繳款]')
  {
    resetDb('small')
    const db = () => dbm.db
    const IC = api.ipdChargeApi
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const adm = (id) => db().admissions.find((a) => a.id === id)
    // 種子：腦梗塞住了 32 天（滿 30 天提醒、部分負擔進第二段）；其他人住幾天、費用不多，不提醒
    const long = db().admissions.find((a) => a.status === 'admitted' && a.diagnosis.startsWith('I63.9'))
    ok(!!long && long.admittedAt.startsWith(addDaysT(-32)) && !long.dischargeSummary?.signedAt, '種子：腦梗塞住院 32 天、還沒准出院')
    await as('clerk01')
    const lst = await IC.listIpdBilling()
    const li = lst.find((x) => x.admissionId === long.id)
    ok(li.suggestInterim?.includes('住院第 33 天') && li.interimPaid === 0, `住院結帳清單標「${li.suggestInterim}」`)
    const others = lst.filter((x) => x.admissionId !== long.id && x.status === 'admitted' && !x.receiptNo)
    const bills = await Promise.all(others.map((x) => IC.getIpdBill(x.admissionId)))
    ok(others.every((x, i) => !x.suggestInterim === (x.dischargeReady || x.days < 30 && bills[i].bill.patientTotal < 30000)), '其他住院病人：沒滿 30 天、累計沒到 30,000 元（或已准出院）就不提醒')
    ok((await api.dashboardApi.getDashboard()).ipdInterim === lst.filter((x) => x.suggestInterim).length, '櫃台首頁「建議期中繳款」＝清單上標記的人數')
    const v0 = await IC.getIpdBill(long.id)
    ok(v0.bill.meta.days === 32 && v0.bill.meta.copay.length === 2 && v0.interim.held === 0 && v0.interim.due === v0.bill.patientTotal && v0.interim.max === v0.bill.patientTotal && !v0.interim.blocked, `試算 ${v0.bill.patientTotal} 元（32 天、部分負擔兩段）；最多可期中繳 ${v0.interim.max} 元`)
    // 權限
    await as('ph01')
    await expectError(() => IC.getIpdStatement(long.id), '藥師查住院費用明細')
    await as('nurse01')
    await expectError(() => IC.payInterim(long.id, { amount: 1000, payMethod: 'cash' }), '護理師收期中繳款')
    const st0 = await IC.getIpdStatement(long.id)
    ok(st0.bill.patientTotal === v0.bill.patientTotal && st0.stillDue === v0.bill.patientTotal && st0.interimPaid === 0 && !st0.receiptNo && st0.bill.lines.length === v0.bill.lines.length, '護理站查費用明細：和櫃台試算同一個數（只看、不能收款）')
    // 收款的檢查
    await as('clerk01')
    let f = await fieldsOf(() => IC.payInterim(long.id, { amount: 0, payMethod: 'cash' }))
    ok(f.amount?.includes('正整數'), `繳 0 元 → 「${f.amount}」`)
    f = await fieldsOf(() => IC.payInterim(long.id, { amount: 10.5, payMethod: 'cash' }))
    ok(f.amount?.includes('正整數'), '繳 10.5 元 → 擋')
    f = await fieldsOf(() => IC.payInterim(long.id, { amount: v0.interim.max + 1, payMethod: 'cash' }))
    ok(f.amount?.includes(`最多 ${v0.interim.max.toLocaleString()} 元`), `比目前的費用多 → 「${f.amount}」（不預收、不收保證金）`)
    f = await fieldsOf(() => IC.payInterim(long.id, { amount: 100, payMethod: 'check' }))
    ok(!!f.payMethod, '付款方式不正確 → 擋')
    // 收兩筆
    const p1 = await IC.payInterim(long.id, { amount: 10000, payMethod: 'cash' })
    ok(/^R\d{12}$/.test(p1.receiptNo) && p1.asOf === T && p1.billTotal === v0.bill.patientTotal && p1.paidBefore === 0 && db().auditLogs[0].action === '期中繳款', `期中繳款 ${p1.receiptNo}：記下截至今天的費用、之前已繳 0、寫稽核`)
    const p2 = await IC.payInterim(long.id, { amount: 5000, payMethod: 'card' })
    ok(p2.paidBefore === 10000 && p2.receiptNo > p1.receiptNo, '第二筆：之前已繳 10,000（收據和批價同一個序號）')
    const v1 = await IC.getIpdBill(long.id)
    ok(v1.interim.held === 15000 && v1.interim.due === v0.bill.patientTotal - 15000 && v1.interim.max === v1.interim.due && v1.interim.payments.every((p) => !p.canVoid && p.cashierName), '已繳 15,000：還要繳＝試算 − 已繳；當天的可以作廢')
    ok((await IC.listIpdBilling()).find((x) => x.admissionId === long.id).interimPaid === 15000, '清單顯示期中已繳')
    ok(!v1.interim.suggest || v1.interim.suggest.includes('還沒繳的自付'), '剛繳過：不再用天數提醒（距上次繳款 0 天），只剩金額條件')
    // 日結：算在收的那天
    let rep = await api.chargeApi.dailyReport(T)
    const ip = rep.prepays.filter((x) => x.kind === '期中繳款')
    ok(ip.length === 2 && ip.every((x) => x.admitNo === long.admitNo) && rep.prepaidIn >= 15000, '日結「預收與期中繳款」列出兩筆（標住院號）')
    const pmSum = (r) => r.byPayMethod.cash + r.byPayMethod.card + r.byPayMethod.mobile
    ok(pmSum(rep) === rep.collected && rep.byCashier.reduce((n, c) => n + c.collected, 0) === rep.collected, '日結：依付款方式、依收費人員加總都＝實收')
    const CSV = await load('/src/services/report-csv.ts')
    ok(CSV.dailyReportCsv(rep).includes('住院期中繳款'), '日結匯出：類別寫「住院期中繳款」')
    // 作廢
    f = await fieldsOf(() => IC.voidInterim(long.id, p2.id, ' '))
    ok(!!f.reason, '作廢要寫原因')
    await IC.voidInterim(long.id, p2.id, '刷錯卡')
    let msg = await errOf(() => IC.voidInterim(long.id, p2.id, '再一次'))
    ok(msg.includes('已作廢'), `重複作廢 → 「${msg}」`)
    rep = await api.chargeApi.dailyReport(T)
    ok(rep.prepays.filter((x) => x.kind === '期中繳款').length === 1 && (await IC.getIpdBill(long.id)).interim.held === 10000 && db().auditLogs[0].action === '作廢期中繳款', '作廢後：不算日結、已繳回到 10,000、寫稽核')
    adm(long.id).interim[0].at = `${addDaysT(-1)} 10:00`
    msg = await errOf(() => IC.voidInterim(long.id, p1.id, '收錯'))
    ok(msg.includes('不是今天'), `昨天收的作廢 → 「${msg}」`)
    adm(long.id).interim[0].at = `${T} 08:00`
    // 准出院後不收期中繳款（直接出院結帳）
    const ready = db().admissions.find((a) => a.status === 'admitted' && a.dischargeSummary?.signedAt)
    msg = await errOf(() => IC.payInterim(ready.id, { amount: 100, payMethod: 'cash' }))
    ok(msg.includes('簽准出院'), `准出院後期中繳款 → 「${msg}」`)
    // 出院結帳扣抵：期中 10,000 → 本次應收＝總帳 − 10,000
    const la = adm(long.id)
    la.dischargeSummary = { ...ready.dischargeSummary, meds: [], signedAt: `${T} 09:00` }
    const vb = await IC.getIpdBill(long.id)
    ok(vb.interim.blocked?.includes('簽准出院') && !vb.interim.suggest && vb.interim.max === 0, '准出院：期中繳款區改說「直接出院結帳」、不再提醒')
    const total = vb.bill.patientTotal
    msg = await errOf(() => IC.payIpd(long.id, { payMethod: 'cash', received: total - 10000 - 1 }))
    ok(msg.includes('不足'), '出院結帳的應收是扣抵後的：少 1 元也不足')
    const c1 = await IC.payIpd(long.id, { payMethod: 'cash', received: total - 10000 })
    ok(c1.patientTotal === total && c1.prepaidApplied === 10000 && c1.received === total - 10000 && c1.change === 0 && db().auditLogs[0].detail.includes('扣抵期中繳款 10000'), `出院結帳 ${c1.receiptNo}：總帳 ${total}、扣抵 10,000、本次收 ${total - 10000}`)
    rep = await api.chargeApi.dailyReport(T)
    ok(rep.prepaidApplied >= 10000 && pmSum(rep) === rep.collected, '日結：扣抵的從應收減掉（錢在繳款那天算過了）')
    const vc = await IC.getIpdBill(long.id)
    ok(vc.interim.blocked?.includes('已出院結帳') && vc.interim.payments[0].canVoid?.includes('不是今天') === false && !!vc.interim.payments[0].canVoid, '結帳後：期中繳款不能再收，也不能作廢（要先作廢結帳收據）')
    // 作廢出院結帳收據：期中繳款回到這次住院，重結再扣抵
    await api.chargeApi.voidCharge(c1.id, '測試重結')
    ok((await IC.getIpdBill(long.id)).interim.due === total - 10000, '作廢結帳收據：期中繳款回來，還要繳＝總帳 − 10,000')
    // 多繳：費用變少（例：改成住 3 天）→ 結帳時退還差額
    const la2 = adm(long.id) // 每次寫入後資料庫物件會換新：重新取
    la2.admittedAt = `${addDaysT(-3)} 10:00`
    la2.bedHistory = la2.bedHistory?.length ? [{ ...la2.bedHistory[0], from: la2.admittedAt }] : la2.bedHistory
    la2.deptTransfers = (la2.deptTransfers ?? []).filter((x) => x.status !== 'pending') // 種子有轉科申請中：這裡要測出院
    const small = (await IC.getIpdBill(long.id)).bill.patientTotal
    ok(small < 10000 && (await IC.getIpdBill(long.id)).interim.due === small - 10000, `費用變成 ${small} 元：還要繳是負數（多繳 ${10000 - small}）`)
    const c2 = await IC.payIpd(long.id, { payMethod: 'card', received: 0 })
    const rf = adm(long.id).interimRefunds?.[0]
    ok(c2.prepaidApplied === small && c2.received === 0 && rf?.amount === 10000 - small && rf.parts[0].payMethod === 'cash' && /^RF/.test(rf.receiptNo), `多繳 ${10000 - small}：開退款單 ${rf?.receiptNo} 依原付款方式（現金）退還`)
    rep = await api.chargeApi.dailyReport(T)
    ok(rep.refunds.some((x) => x.kind === '退期中繳款' && x.receiptNo === rf.receiptNo && x.originalReceiptNo.includes(p1.receiptNo)) && pmSum(rep) === rep.collected, '日結退款列「退期中繳款」（原收據是期中繳款那張）；付款方式加總＝實收')
    const st1 = await IC.getIpdStatement(long.id)
    ok(st1.receiptNo === c2.receiptNo && st1.stillDue === 0 && st1.refunded === 10000 - small && st1.interimPaid === small, '已結帳的費用明細：收據內容、已退還多繳')
    await as('nurse01')
    await api.admissionApi.discharge(long.id, { confirmUnfinished: true })
    ok(adm(long.id).status === 'discharged', '扣抵結清後可以出院')
    await as('clerk01')
    msg = await errOf(() => IC.payInterim(long.id, { amount: 100, payMethod: 'cash' }))
    ok(msg.includes('已出院'), `出院後期中繳款 → 「${msg}」`)
    // 提醒設定
    await expectError(() => IC.saveIpdInterim({ days: 10, amount: 0 }), '櫃台改期中繳款提醒')
    await as('admin')
    f = await fieldsOf(() => IC.saveIpdInterim({ days: -1, amount: 1.5 }))
    ok(!!f.days && !!f.amount, '提醒設定：天數、金額要是 0 以上的整數')
    await IC.saveIpdInterim({ days: 2, amount: 0 })
    ok(db().billingSettings.ipdInterim.days === 2 && db().auditLogs[0].detail.includes('2 天'), '管理員改成滿 2 天提醒、不看金額（寫稽核）')
    await as('clerk01')
    const l2 = await IC.listIpdBilling()
    ok(l2.filter((x) => x.status === 'admitted' && !x.receiptNo && !x.dischargeReady).every((x) => !!x.suggestInterim === (x.days >= 2)) && l2.some((x) => x.suggestInterim), '改成 2 天後：住滿 2 天的都提醒（只看天數）')
  }

  // 轉診：轉入（持外院轉診單掛號、經轉診部分負擔、同一療程回診沿用、轉診回覆單）與轉出（看完診開轉診單、列印、作廢）
  console.log('\n[轉診]')
  {
    resetDb('small')
    const db = () => dbm.db
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const RR = api
    /** 完成看診（用藥提醒照實確認，不是這段要測的） */
    const completeOk = async (eid, draft) => api.opdApi.completeEncounter(eid, draft, { rxAlertReasons: Object.fromEntries((await api.opdApi.rxAlerts(eid, draft.medications.map((m) => m.drugId))).map((x) => [x.key, '測試確認'])) })
    // 規則
    ok(RR.referralValidUntil('2026-01-01') === '2026-03-31' && !RR.referralInProblem('2026-01-01', '2026-03-31') && RR.referralInProblem('2026-01-01', '2026-04-01').includes('過期'), '轉診單 90 天內有效（含開單日）：1/1 開單到 3/31 還能用、4/1 過期')
    ok(RR.referralInProblem(addDaysT(1), T).includes('晚於') && RR.referralInProblem('', T).includes('開單日期'), '開單日不能晚於就醫日、要填')
    const ce = RR.checkReferralInInput({ fromHospital: ' ', issuedOn: '', diagnosis: '' }, T)
    ok(ce.fromHospital && ce.issuedOn && ce.diagnosis, '轉出院所、開單日期、診斷一次標出')
    const s0 = db().billingSettings
    ok(s0.basicCopayReferred === 50 && s0.basicCopay === 80, '預設：基本部分負擔未經轉診 80、經轉診 50')

    // 種子：dr01 今天第一位候診持康健診所的轉診單
    const seedV = db().visits.find((v) => v.referralIn && v.date === T)
    ok(seedV?.doctorId === 'DR01' && seedV.referralIn.fromHospital === '康健診所' && seedV.status === 'registered', `種子：${db().patients.find((p) => p.id === seedV.patientId).name} 持康健診所轉診單掛 dr01`)

    // 掛號時登錄
    await as('clerk01')
    const sess = (await api.scheduleApi.listSessions({ date: T })).filter((x) => !x.full && !x.closed && !x.suspended)
    const s1 = sess.find((x) => x.deptId === 'D01') ?? sess[0]
    const pt = db().patients.find((x) => !x.allergies.length && !x.deceasedAt && !db().visits.some((v) => v.patientId === x.id && v.date >= T) && db().identities.find((i) => i.code === x.defaultIdentity && !i.selfPay && !i.copayExempt))
    const est0 = await api.bookingApi.estimateFee('01', '01', false, T)
    const est1 = await api.bookingApi.estimateFee('01', '01', false, T, true)
    ok(est0.total - est1.total === 30 && est1.lines.some((l) => l.name.includes('經轉診')), `掛號預估：持轉診單少 30 元（${est0.total} → ${est1.total}）`)
    const f1 = await fieldsOf(() => api.bookingApi.register({ patientId: pt.id, sessionId: s1.id, identityCode: '01', caseType: '01', referralIn: { fromHospital: '康健診所', issuedOn: addDaysT(-91), diagnosis: 'x' } }))
    ok(f1.issuedOn?.includes('過期') && !db().visits.some((v) => v.patientId === pt.id && v.date === T), `轉診單過期 → 「${f1.issuedOn}」，沒有掛上`)
    const ref = { fromHospital: '康健診所', issuedOn: addDaysT(-10), diagnosis: 'I10 高血壓（控制不佳）', purpose: '進一步檢查' }
    const v1 = await api.bookingApi.register({ patientId: pt.id, sessionId: s1.id, identityCode: '01', caseType: '01', referralIn: ref })
    ok(v1.referralIn?.fromHospital === '康健診所' && v1.referralIn.recordedBy === db().users.find((u) => u.username === 'clerk01').id && db().auditLogs[0].action === '掛號', '掛號時登錄轉診單：記下誰登錄')

    // 看診：上方顯示轉診資訊
    const drUser = db().users.find((u) => u.doctorId === s1.doctorId).username
    await as(drUser)
    let iv = await api.referralApi.getReferralIn(v1.id)
    ok(iv.referral.diagnosis.startsWith('I10') && !iv.canReply, '看診頁看得到轉診單；還沒看完不能回覆')
    const ee = await api.opdApi.startConsult(v1.id, { allowParallel: true, allowNotCheckedIn: true })
    let msg = await errOf(() => api.referralApi.referralReplyDraft(v1.id))
    ok(msg.includes('完成看診後'), `看診中開回覆單 → 「${msg}」`)
    await completeOk(ee.id, { subjective: '頭暈', objective: 'BP 168/98', assessment: '高血壓控制不佳', plan: '調整降壓藥，兩週後回診', vitals: {}, diagnoses: [{ icd: 'I10', name: '高血壓', primary: true }], medications: [{ drugId: 'M012', dose: 1, freq: 'QD', route: 'PO', days: 14, qty: 0, selfPay: false }], procedures: [], refillTimes: 0, admissionRequested: false })
    await as('clerk01')
    const pv = await api.chargeApi.previewCharge(v1.id)
    const basic = pv.lines.find((l) => l.kind === 'copay-basic')
    ok(basic.amount === 50 && basic.name.includes('經轉診'), '批價：基本部分負擔收經轉診的 50 元')

    // 收費前補登／更正／取消
    msg = (await fieldsOf(() => api.referralApi.setReferralIn(v1.id, { ...ref, issuedOn: addDaysT(1) }))).issuedOn
    ok(msg?.includes('晚於'), `更正成未來的開單日 → 「${msg}」`)
    await api.referralApi.setReferralIn(v1.id, null)
    ok((await api.chargeApi.previewCharge(v1.id)).lines.find((l) => l.kind === 'copay-basic').amount === 80 && db().auditLogs[0].action === '取消轉診單', '收費前取消轉診單：改回 80 元、寫稽核')
    await api.referralApi.setReferralIn(v1.id, ref)
    ok(db().auditLogs[0].action === '補登轉診單' && (await api.chargeApi.previewCharge(v1.id)).lines.find((l) => l.kind === 'copay-basic').amount === 50, '收費前補登：又是 50 元')
    await as('ph01')
    await expectError(() => api.referralApi.setReferralIn(v1.id, null), '藥師改轉診單')

    // 回覆單
    await as(drUser)
    iv = await api.referralApi.getReferralIn(v1.id)
    ok(iv.canReply && (await api.referralApi.listPendingReferralReplies()).some((x) => x.visitId === v1.id) && (await api.dashboardApi.getDashboard()).referralReplies >= 1, '看完診：可以回覆，列在醫師待辦（首頁「轉診待回覆」）')
    const rd = await api.referralApi.referralReplyDraft(v1.id)
    ok(rd.diagnosis === 'I10 高血壓' && rd.treatment.includes('Amlodipine') && rd.advice.includes('兩週後回診'), '回覆單預設：本院診斷、這次用藥、計畫')
    const rf = await fieldsOf(() => api.referralApi.saveReferralReply(v1.id, { diagnosis: '', treatment: '', advice: '' }))
    ok(rf.diagnosis && rf.advice, '回覆單：診斷、建議必填')
    const other = db().users.find((u) => u.doctorId && u.doctorId !== s1.doctorId).username
    await as(other)
    msg = await errOf(() => api.referralApi.saveReferralReply(v1.id, rd))
    ok(msg.includes('看診的醫師'), `別的醫師回覆 → 「${msg}」`)
    await as(drUser)
    await api.referralApi.saveReferralReply(v1.id, { ...rd, advice: '血壓已調整，請回康健診所繼續追蹤' })
    ok(!(await api.referralApi.listPendingReferralReplies()).some((x) => x.visitId === v1.id) && db().auditLogs[0].action === '轉診回覆', '回覆後不在待辦、寫稽核')
    await as('clerk01')
    await api.referralApi.setReferralIn(v1.id, ref)
    ok(!!db().visits.find((v) => v.id === v1.id).referralIn.reply, '更正轉診單不會洗掉醫師的回覆')
    msg = await errOf(() => api.referralApi.setReferralIn(v1.id, null))
    ok(msg.includes('回覆'), `已回覆再取消轉診 → 「${msg}」`)
    iv = await api.referralApi.printReferralReply(v1.id)
    ok(iv.referral.reply.printed.length === 1 && iv.patient.name === pt.name && !!iv.doctorLicenseNo, '櫃台列印回覆單：記下列印、帶病人與醫師資料')

    // 批價後不能改
    const pv2 = await api.chargeApi.previewCharge(v1.id)
    await api.chargeApi.pay(v1.id, { payMethod: 'cash', received: pv2.patientTotal })
    msg = await errOf(() => api.referralApi.setReferralIn(v1.id, { ...ref, fromHospital: '別家' }))
    ok(msg.includes('已經批價'), `批價後更正轉診單 → 「${msg}」`)

    // 同一療程：醫師約的回診沿用
    await as(drUser)
    const opts = await api.bookingApi.followUpOptions(v1.id)
    const fu = await api.bookingApi.bookFollowUp(v1.id, { sessionId: opts.suggestions[0].session.id })
    const fv = db().visits.find((v) => v.id === fu.id)
    ok(fv.referralIn?.inheritedFrom === v1.id && !fv.referralIn.reply, '醫師約的回診沿用轉診身分（不帶回覆單）')
    const lk = { identity: db().identities.find((i) => i.code === fv.identityCode), settings: db().billingSettings, drug: (id) => db().drugs.find((d) => d.id === id), procedure: (id) => db().procedures.find((p) => p.id === id) }
    ok(api.calcChargeLines(fv, { medications: [], procedures: [] }, lk).find((l) => l.kind === 'copay-basic').amount === 50, '回診的基本部分負擔也是經轉診的 50 元')
    iv = await api.referralApi.getReferralIn(fv.id)
    ok(iv.inheritedText?.includes('同一療程') && !iv.canReply, '回診標「同一療程」、不必再回覆')
    // 自己另外掛的不算
    await as('clerk01')
    const sOther = (await api.scheduleApi.listSessions({ date: addDaysT(1) })).find((x) => !x.full && !x.closed && !x.suspended && x.deptId !== s1.deptId)
    if (sOther) {
      const v3 = await api.bookingApi.register({ patientId: pt.id, sessionId: sOther.id, identityCode: '01', caseType: '01' })
      ok(!v3.referralIn, '病人自己另外掛的不算轉診')
    }

    // 轉出
    // 要「別的醫師」看的診（下面測別的醫師不能開）：同一位醫師一天有兩個診時，以前會抽到他自己的另一診
    const s2 = sess.find((x) => x.doctorId !== s1.doctorId && x.deptId === s1.deptId) ?? sess.find((x) => x.doctorId !== s1.doctorId)
    const pt2 = db().patients.find((x) => !x.deceasedAt && x.id !== pt.id && !db().visits.some((v) => v.patientId === x.id && v.date >= T))
    const v2 = await api.bookingApi.register({ patientId: pt2.id, sessionId: s2.id, identityCode: '01', caseType: '01' })
    const dr2 = db().users.find((u) => u.doctorId === s2.doctorId).username
    await as(dr2)
    const e2 = await api.opdApi.startConsult(v2.id, { allowParallel: true, allowNotCheckedIn: true })
    msg = await errOf(() => api.referralApi.referralOutDraft(e2.id))
    ok(msg.includes('完成看診後'), `看診中開轉診單 → 「${msg}」`)
    await completeOk(e2.id, { subjective: '胸悶三天', objective: 'EKG ST 下降', assessment: '疑似心絞痛', plan: '轉心臟內科', vitals: {}, diagnoses: [{ icd: 'I25.10', name: '冠狀動脈粥狀硬化心臟病', primary: true }], medications: [{ drugId: 'M019', dose: 1, freq: 'QD', route: 'PO', days: 7, qty: 0, selfPay: false }], procedures: [], refillTimes: 0, admissionRequested: false })
    const od = await api.referralApi.referralOutDraft(e2.id)
    ok(od.summary.includes('胸悶三天') && od.summary.includes('EKG') && od.purpose === '進一步檢查', '轉診單預設：病情摘要帶主訴、檢查、評估')
    const of = await fieldsOf(() => api.referralApi.issueReferral(e2.id, { ...od, toHospital: '', toDept: '', purpose: 'x', summary: ' ' }))
    ok(of.toHospital && of.toDept && of.purpose && of.summary, '院所、科別、目的、摘要一次標出')
    const ro = await api.referralApi.issueReferral(e2.id, { ...od, toHospital: '展示醫學中心', toDept: '心臟內科', urgent: true })
    ok(/^\d+ 轉字第 \d{6} 號$/.test(ro.no) && ro.diagnoses[0].startsWith('I25.10') && ro.meds[0].includes('Aspirin') && ro.patient.allergies && !!ro.doctorLicenseNo, `開立 ${ro.no}：快照診斷、用藥、過敏，附醫師資料`)
    await as(drUser)
    msg = await errOf(() => api.referralApi.issueReferral(e2.id, { ...od, toHospital: 'x', toDept: 'y' }))
    ok(msg.includes('自己看的'), `別的醫師開 → 「${msg}」`)
    await as('clerk01')
    const pr = await api.referralApi.printReferral(ro.id)
    ok(pr.printed.length === 1 && (await api.referralApi.listReferralsOut({ patientId: pt2.id })).length === 1, '櫃台可以重印、查得到這位病人的轉診單')
    await as(dr2)
    const hist = await api.opdApi.patientHistory(pt2.id)
    ok(hist.find((h) => h.id === e2.id)?.referralsOut[0].includes('展示醫學中心 心臟內科'), '就診紀錄列出轉出')
    msg = (await fieldsOf(() => api.referralApi.voidReferral(ro.id, ''))).reason
    ok(!!msg, '作廢要寫原因')
    await api.referralApi.voidReferral(ro.id, '病人決定先在本院觀察')
    msg = await errOf(() => api.referralApi.printReferral(ro.id))
    ok(msg.includes('作廢'), `作廢後列印 → 「${msg}」`)
    ok(!(await api.opdApi.patientHistory(pt2.id)).find((h) => h.id === e2.id).referralsOut.length, '作廢的不列在就診紀錄')

    // 改期：轉診單跟著走（新日期還在有效期內）；過期就不沿用
    await as('clerk01')
    const tmr = (await api.scheduleApi.listSessions({ date: addDaysT(1) })).filter((x) => !x.full && !x.closed && !x.suspended)
    const sv = db().visits.find((v) => v.id === seedV.id)
    const rs1 = await api.bookingApi.rescheduleVisit(sv.id, { sessionId: tmr[0].id, identityCode: sv.identityCode, caseType: sv.caseType })
    ok(rs1.referralIn?.fromHospital === '康健診所', '改期到明天：轉診單跟著改過去')
    db().visits.find((v) => v.id === rs1.id).referralIn.issuedOn = addDaysT(-89)
    const rs2 = await api.bookingApi.rescheduleVisit(rs1.id, { sessionId: tmr[1].id, identityCode: sv.identityCode, caseType: sv.caseType })
    ok(!rs2.referralIn && db().auditLogs[0].detail.includes('已過期，沒有沿用'), '改期後超過 90 天：轉診單不沿用，稽核寫明')

    // 收費設定：經轉診不能比未經轉診高
    await as('admin')
    const bs = await api.adminApi.getBillingSettings()
    msg = (await fieldsOf(() => api.adminApi.saveBillingSettings({ ...bs, basicCopayReferred: bs.basicCopay + 1, from: '' }))).basicCopayReferred
    ok(msg?.includes('不能比'), `經轉診比未經轉診高 → 「${msg}」`)
  }

  // 交互作用與重複用藥：純函式規則；門診比對病人還在吃的本院藥（各科、慢箋、出院帶藥），住院比對執行中醫囑；
  // 注意的確認即可、嚴重的要寫原因；原因存病歷／醫囑，藥局看得到
  console.log('\n[交互作用與重複用藥]')
  {
    resetDb('small')
    const db = () => dbm.db
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? `${e.code}|${e.field ?? ''}|${e.message}` : `（非預期的錯誤）${e.message}`
      }
    }
    const R = api
    const dref = (id) => {
      const d = db().drugs.find((x) => x.id === id)
      return { id: d.id, name: d.name, generic: d.generic }
    }
    ok(R.ingredientsOf('Amoxicillin/Clavulanate').join() === 'amoxicillin,clavulanate' && R.ingredientsOf('Morphine sulfate').join() === 'morphine' && R.ingredientsOf('Acetylsalicylic acid').join() === 'acetylsalicylic', '成分：複方拆開、鹽類不算（Morphine sulfate＝morphine）')
    let al = R.checkRxAlerts([dref('M001'), dref('M021'), dref('M002')])
    ok(al.length === 1 && al[0].kind === 'interaction' && al[0].level === 'severe' && al[0].title.includes('Warfarin') && al[0].title.includes('Ibuprofen'), 'Warfarin＋Ibuprofen：嚴重交互作用（出血）；Acetaminophen 沒事')
    al = R.checkRxAlerts([dref('M020'), dref('M022')])
    ok(al.length === 1 && al[0].level === 'caution' && al[0].text.includes('Famotidine'), 'Clopidogrel＋Omeprazole：注意（建議改用 Famotidine）')
    al = R.checkRxAlerts([dref('M007'), dref('M008'), dref('M003'), dref('M004')])
    ok(al.length === 2 && al.some((a) => a.kind === 'class' && a.text.includes('抗組織胺')) && al.some((a) => a.kind === 'same' && a.text.includes('amoxicillin')), '同類重複（兩種抗組織胺）、成分重複（Amoxicillin＋Augmentin）都是注意')
    al = R.checkRxAlerts([dref('M002'), dref('M002')])
    ok(al.length === 0, '同一個藥在處方出現兩次不報（處方表自己的事）')
    al = R.checkRxAlerts([dref('M028'), dref('M029')], [{ drug: dref('M031'), source: '骨科 11/10 某醫師', until: addDaysT(4), remainDays: 5 }])
    ok(al[0].level === 'severe' && al[0].other.includes('骨科') && al[0].other.includes('還有 5 天') && al.some((a) => a.kind === 'class'), '和還在吃的藥比：寫出哪裡開的、還有幾天；嚴重的排前面')
    const pr = R.rxAlertProblems(R.checkRxAlerts([dref('M021'), dref('M002'), dref('M007'), dref('M008')]), {})
    ok(pr.missing.length === 2 && pr.needReason.length === 0, '沒有確認：兩則都算還沒確認')
    const keys = R.checkRxAlerts([dref('M021'), dref('M002'), dref('M007'), dref('M008')]).map((a) => a.key)
    const pr2 = R.rxAlertProblems(R.checkRxAlerts([dref('M021'), dref('M002'), dref('M007'), dref('M008')]), { [keys[0]]: ' ', [keys[1]]: '' })
    ok(pr2.missing.length === 0 && pr2.needReason.length === 1, '都確認了，但嚴重的原因空白 → 要寫原因；注意的可空白')

    // 門診：病人上午在內科拿了 Omeprazole 14 天，下午家醫科又開
    await as('clerk01')
    const sessions = (await api.scheduleApi.listSessions({ date: T })).filter((x) => !x.full && !x.closed && !x.suspended)
    const s1 = sessions[0]
    const s2 = sessions.find((x) => x.deptId !== s1.deptId)
    const pt = db().patients.find((x) => !x.allergies.length && !x.deceasedAt && !db().visits.some((v) => v.patientId === x.id) && !db().admissions.some((a) => a.patientId === x.id))
    const med = (drugId, days = 7, freq = 'QD') => ({ drugId, dose: 1, freq, route: 'PO', days, qty: 0, selfPay: false })
    const draftOf = (meds) => ({ subjective: 's', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'K21.9', name: '胃食道逆流', primary: true }], medications: meds, procedures: [], refillTimes: 0, admissionRequested: false })
    const userOf = (doctorId) => db().users.find((u) => u.doctorId === doctorId).username
    const v1 = await api.bookingApi.register({ patientId: pt.id, sessionId: s1.id, identityCode: '01', caseType: '01' })
    await as(userOf(s1.doctorId))
    const e1 = await api.opdApi.startConsult(v1.id, { allowParallel: true, allowNotCheckedIn: true })
    await api.opdApi.completeEncounter(e1.id, draftOf([med('M022', 14)]))
    ok(!db().encounters.find((e) => e.id === e1.id).rxAlerts, '沒有提醒：直接完成，病歷不存空的提醒')
    await as('clerk01')
    const v2 = await api.bookingApi.register({ patientId: pt.id, sessionId: s2.id, identityCode: '01', caseType: '01' })
    await as(userOf(s2.doctorId))
    const e2 = await api.opdApi.startConsult(v2.id, { allowParallel: true, allowNotCheckedIn: true })
    const meds2 = [med('M023'), med('M021'), med('M002', 3, 'TID')]
    al = await api.opdApi.rxAlerts(e2.id, meds2.map((m) => m.drugId))
    const famo = al.find((a) => a.title.includes('Famotidine'))
    ok(al.length === 2 && al[0].level === 'severe' && famo?.kind === 'class' && famo.other.includes(db().departments.find((d) => d.id === s1.deptId).name) && famo.other.includes('還有 14 天'), `處方表即時提醒：嚴重（Warfarin＋Ibuprofen）在前；Famotidine 和上午${db().departments.find((d) => d.id === s1.deptId).name}的 Omeprazole 同類（還有 14 天）`)
    let msg = await errOf(() => api.opdApi.completeEncounter(e2.id, draftOf(meds2)))
    ok(msg.startsWith('CONFLICT|rxAlerts|') && msg.includes('2 則'), `沒確認就完成 → 「${msg.split('|')[2]}」`)
    const rs = Object.fromEntries(al.map((a) => [a.key, '']))
    msg = await errOf(() => api.opdApi.completeEncounter(e2.id, draftOf(meds2), { rxAlertReasons: rs }))
    ok(msg.includes('要寫原因') && db().encounters.find((e) => e.id === e2.id).status !== 'completed', `嚴重的沒寫原因 → 「${msg.split('|')[2]}」，沒有完成`)
    rs[al[0].key] = '已評估，短期止痛並追蹤 INR'
    await api.opdApi.completeEncounter(e2.id, draftOf(meds2), { rxAlertReasons: rs })
    const ce = db().encounters.find((e) => e.id === e2.id)
    ok(ce.status === 'completed' && ce.rxAlerts.length === 2 && ce.rxAlerts[0].reason === '已評估，短期止痛並追蹤 INR' && ce.rxAlerts[1].reason === '', '確認後完成：提醒與原因存進病歷')
    ok(db().auditLogs[0].action === '完成看診' && db().auditLogs[0].detail.includes('嚴重交互作用仍開立') && db().auditLogs[0].detail.includes('追蹤 INR'), '稽核記下嚴重交互作用仍開立與原因')
    await as('clerk01')
    const pv = await api.chargeApi.previewCharge(v2.id)
    await api.chargeApi.pay(v2.id, { payMethod: 'cash', received: pv.patientTotal })
    await as('ph01')
    const dv = (await api.pharmacyApi.listDispenses({ date: T })).find((d) => d.visitId === v2.id)
    ok(dv?.rxAlerts.length === 2 && dv.rxAlerts[0].level === 'severe' && dv.rxAlerts[0].reason.includes('INR'), '藥局調劑畫面看得到提醒與醫師寫的原因')

    // 吃完的不算；慢性病連續處方依可調劑次數算
    const old = db().encounters.find((e) => e.id === e1.id)
    old.date = addDaysT(-20)
    await as('clerk01')
    const s3 = sessions.find((x) => x.deptId !== s1.deptId && x.deptId !== s2.deptId) ?? sessions.find((x) => x.id !== s1.id && x.id !== s2.id)
    const v3 = await api.bookingApi.register({ patientId: pt.id, sessionId: s3.id, identityCode: '01', caseType: '01' })
    await as(userOf(s3.doctorId))
    const e3 = await api.opdApi.startConsult(v3.id, { allowParallel: true, allowNotCheckedIn: true })
    al = await api.opdApi.rxAlerts(e3.id, ['M022'])
    ok(!al.some((a) => a.other?.includes(db().departments.find((d) => d.id === s1.deptId).name + ' ')), '20 天前開的 14 天 Omeprazole 已經吃完：不算重複')
    old.refillTimes = 2
    al = await api.opdApi.rxAlerts(e3.id, ['M022'])
    ok(al.some((a) => a.kind === 'same' && a.other.includes('還有 8 天')), '同一張是慢性病連續處方（14 天 × 2 次）：還有 8 天，開同成分要提醒')
    old.refillTimes = 0
    await api.opdApi.saveDraft(e3.id, { ...draftOf([]), rxAlerts: [{ key: 'x', level: 'caution', title: '偽造', text: '', reason: '' }] })
    ok(!db().encounters.find((e) => e.id === e3.id).rxAlerts, '畫面送來的提醒紀錄不收（只在完成看診時由服務層算）')
    await as('nurse01')
    await expectError(() => api.opdApi.completeEncounter(e3.id, draftOf([])), '護理師完成看診')

    // 住院：和執行中的給藥醫囑比
    const adm = db().admissions.find((a) => a.status === 'admitted' && !db().ipdOrders.some((o) => o.admissionId === a.id && o.status === 'active' && ['M021', 'M019', 'M002', 'M030', 'M032'].includes(o.drugId)))
    await as(userOf(adm.doctorId))
    const base = { admissionId: adm.id, type: 'long', category: 'medication', content: '', dose: 1, freq: 'QD', route: 'PO', allowDuplicate: true }
    await api.ipdApi.addOrder(await withRxOk({ ...base, drugId: 'M019' }))
    al = await api.ipdApi.orderRxAlerts(adm.id, 'M021')
    ok(al.length === 1 && al[0].level === 'severe' && al[0].title.includes('執行中') && al[0].other.includes('長期醫囑'), '住院：開 Warfarin 時，和執行中的 Aspirin 醫囑是嚴重交互作用')
    msg = await errOf(() => api.ipdApi.addOrder({ ...base, drugId: 'M021' }))
    ok(msg.startsWith('CONFLICT|rxAlerts|'), `沒確認就開 → 「${msg.split('|')[2]}」`)
    msg = await errOf(() => api.ipdApi.addOrder({ ...base, drugId: 'M021', rxAlertReasons: { [al[0].key]: '' } }))
    ok(msg.includes('要寫原因'), '嚴重的沒寫原因 → 擋下')
    const wf = await api.ipdApi.addOrder({ ...base, drugId: 'M021', rxAlertReasons: { [al[0].key]: '心房顫動合併支架，心臟科建議' } })
    ok(wf.rxAlerts?.[0].reason === '心房顫動合併支架，心臟科建議' && !('rxAlertReasons' in db().ipdOrders.find((o) => o.id === wf.id)), '確認後開立：提醒與原因存在醫囑上（確認本身不存）')
    ok((await api.ipdApi.orderRxAlerts(adm.id, 'M021')).length === 1, '同一種藥不重複報（同藥重複開立另有確認）')
    const rv = await api.ipdApi.reviseOrder(wf.id, { dose: 0.5, freq: 'QD', route: 'PO', reason: '依 INR 調整' })
    ok(rv.rxAlerts?.[0].reason.includes('心臟科'), '修改劑量：沿用開立時的確認，不必再問一次')
    await as('ph01')
    const work = await api.udApi.getUdWork()
    const line = [...work.extra, ...work.daily].flatMap((g) => g.lines).find((l) => l.orderId === rv.id)
    ok(line?.rxAlerts?.[0].level === 'severe', '住院藥局調劑清單看得到這筆醫囑的提醒與原因')
  }

  // 診斷證明書：醫師開立、費用跟著帳單（門診批價、住院結帳）、收費後才能印；收費前可改可作廢、收費後只能作廢重開（不另收費）
  console.log('\n[診斷證明書]')
  {
    resetDb('small')
    const db = () => dbm.db
    const CT = api.certificateApi
    let msg = ''
    const errOf = async (fn) => {
      try {
        await fn()
        return ''
      } catch (e) {
        return e.name === 'ServiceError' ? e.message : `（非預期的錯誤）${e.message}`
      }
    }
    const fieldsOf = async (fn) => {
      try {
        await fn()
        return {}
      } catch (e) {
        return e.fields ?? (e.field ? { [e.field]: e.message } : {})
      }
    }
    const price = db().procedures.find((p) => p.id === 'P027').selfPrice
    // 種子：已出院的病人有一張證明書，費用在住院收據裡、可以印
    const seed = db().certificates.find((c) => c.id === 'MC-SEED-1')
    const seedCharge = db().charges.find((c) => c.admissionId === seed.admissionId && !c.voided)
    ok(seed && seedCharge.lines.some((l) => l.name.includes(seed.no) && l.amount === price * 2) && seed.stayFrom && seed.stayTo, `種子：已出院病人的證明書 ${seed.no}（2 份），證明書費 ${price * 2} 在住院收據裡`)
    await as('clerk01')
    let sv = (await CT.listCertificates({ admissionId: seed.admissionId }))[0]
    ok(sv.feePaid && sv.printable && !sv.editable && sv.patient.idNo && sv.doctorLicenseNo, '種子證明書：已收費、可列印、不能直接改；列印資料有身分證號與醫事人員代碼')
    sv = await CT.printCertificate(seed.id)
    ok(sv.printed.length === 1 && db().auditLogs[0].action === '列印診斷證明書', '櫃台列印：記下誰、何時印、寫稽核')

    // 門診：看完診開立
    await as('clerk01')
    const sess = (await api.scheduleApi.listSessions({ date: T })).find((x) => !x.full && !x.closed && !x.suspended)
    const pt = db().patients.find((x) => !x.allergies.length && !x.deceasedAt && !db().visits.some((v) => v.date === T && v.patientId === x.id))
    const vv = await api.bookingApi.register({ patientId: pt.id, sessionId: sess.id, identityCode: '01', caseType: '01' })
    const drUser = db().users.find((u) => u.doctorId === sess.doctorId).username
    await as(drUser)
    const ee = await api.opdApi.startConsult(vv.id, { allowParallel: true, allowNotCheckedIn: true })
    await api.opdApi.completeEncounter(ee.id, { subjective: '腰痛', objective: '', assessment: '', plan: '', vitals: {}, diagnoses: [{ icd: 'M54.5', name: '下背痛', primary: true }], medications: [], procedures: [], refillTimes: 0, admissionRequested: false })
    ok((await CT.certificateIssuable({ encounterId: ee.id })).ok, '看完診、還沒批價：可以開')
    const draft = await CT.certificateDraft({ encounterId: ee.id })
    ok(draft.diagnoses.includes('M54.5 下背痛') && draft.visitDate === T, '開立預設：病名帶這次的診斷、應診日期')
    const f1 = await fieldsOf(() => CT.issueCertificate({ encounterId: ee.id, diagnoses: ' ', advice: '', purpose: '請假', copies: 0 }))
    ok(f1.diagnoses && f1.advice && f1.copies, '病名、醫師囑言、份數一次標出')
    msg = (await fieldsOf(() => CT.issueCertificate({ encounterId: ee.id, diagnoses: 'x', advice: 'y', purpose: '請假', copies: 11 }))).copies
    ok(!!msg, `份數超過上限 → 「${msg}」`)
    const other = db().users.find((u) => u.doctorId && u.doctorId !== sess.doctorId).username
    await as(other)
    msg = await errOf(() => CT.issueCertificate({ encounterId: ee.id, diagnoses: 'x', advice: 'y', purpose: '請假', copies: 1 }))
    ok(msg.includes('自己看的'), `別的醫師開 → 「${msg}」`)
    await as('clerk01')
    await expectError(() => CT.issueCertificate({ encounterId: ee.id, diagnoses: 'x', advice: 'y', purpose: '請假', copies: 1 }), '櫃台開證明書')
    const before = (await api.chargeApi.previewCharge(vv.id)).patientTotal
    await as(drUser)
    const c1 = await CT.issueCertificate({ encounterId: ee.id, diagnoses: draft.diagnoses, advice: '宜休養三日', purpose: '請假', copies: 2 })
    ok(/^\d+ 診字第 \d{6} 號$/.test(c1.no) && !c1.feePaid && c1.editable && !c1.printable, `開立 ${c1.no}：待批價收費、可改、還不能印`)
    msg = await errOf(() => CT.printCertificate(c1.id))
    ok(msg.includes('還沒收'), `還沒收費就印 → 「${msg}」`)
    await as('clerk01')
    let pv = await api.chargeApi.previewCharge(vv.id)
    ok(pv.patientTotal === before + price * 2 && pv.lines.some((l) => l.name.includes(c1.no) && l.qty === 2 && l.patientPay), `批價試算多了證明書費 ${price} × 2（明細寫證明書字號）`)
    await as(drUser)
    await CT.updateCertificate(c1.id, { diagnoses: draft.diagnoses, advice: '宜休養五日', purpose: '保險理賠', copies: 3 })
    await as('clerk01')
    ok((await api.chargeApi.previewCharge(vv.id)).patientTotal === before + price * 3, '收費前改成 3 份：試算跟著變')
    await as(drUser)
    msg = (await fieldsOf(() => CT.voidCertificate(c1.id, ''))).reason
    ok(!!msg, '作廢要寫原因')
    await CT.voidCertificate(c1.id, '病人不需要了')
    await as('clerk01')
    ok((await api.chargeApi.previewCharge(vv.id)).patientTotal === before, '收費前作廢：證明書費一併取消')
    await as(drUser)
    const c2 = await CT.issueCertificate({ encounterId: ee.id, diagnoses: '下背痛', advice: '宜休養三日', purpose: '請假', copies: 1 })
    // 批價
    await as('clerk01')
    pv = await api.chargeApi.previewCharge(vv.id)
    await api.chargeApi.pay(vv.id, { payMethod: 'cash', received: pv.patientTotal })
    const chId = db().charges.find((c) => c.visitId === vv.id && !c.voided).id
    const rc = await api.chargeApi.getReceipt(chId)
    ok(rc.lines.some((l) => l.name.includes(c2.no)) && rc.encounterId === ee.id && !rc.pendingRefund, '收據含證明書費、帶這次的病歷（批價頁列出證明書）；不會誤算出待退費')
    const printed = await CT.printCertificate(c2.id)
    ok(printed.printable && printed.feePaid, '批價後櫃台可以印')
    await as(drUser)
    const iss = await CT.certificateIssuable({ encounterId: ee.id })
    ok(!iss.ok && iss.reason.includes('已批價'), `批價後不能再開（費用收不到）：「${iss.reason}」`)
    msg = await errOf(() => CT.updateCertificate(c2.id, { diagnoses: '改', advice: '改', purpose: '請假', copies: 1 }))
    ok(msg.includes('作廢重開'), `收費後直接改 → 「${msg}」`)
    msg = await errOf(() => CT.voidCertificate(c2.id, '測試'))
    ok(msg.includes('作廢重開'), `收費後直接作廢 → 「${msg}」`)
    msg = (await fieldsOf(() => CT.reissueCertificate(c2.id, { diagnoses: '下背痛', advice: '宜休養三日', purpose: '請假', copies: 2, reason: '多一份' }))).copies
    ok(msg?.includes('不能超過'), `重開份數比原本多 → 「${msg}」`)
    const c3 = await CT.reissueCertificate(c2.id, { diagnoses: 'M54.5 下背痛（腰椎扭傷）', advice: '宜休養三日', purpose: '請假', copies: 1, reason: '病名寫得不完整' })
    const old = db().certificates.find((c) => c.id === c2.id)
    ok(c3.replaces === c2.id && c3.no !== c2.no && c3.printable && old.voided?.replacedBy === c3.id && c3.replacesNo === c2.no, `作廢重開：新字號 ${c3.no}、原本那張作廢並記下、新的不必再收費就能印`)
    await as('clerk01')
    ok(db().charges.filter((c) => c.visitId === vv.id && !c.voided).length === 1 && !(await api.chargeApi.getReceipt(chId)).pendingRefund, '重開不另收費、也不產生待退費')
    const paidTotal = db().charges.find((c) => c.id === chId).patientTotal
    await api.chargeApi.voidCharge(chId, '測試重新批價')
    const pv2 = await api.chargeApi.previewCharge(vv.id)
    ok(pv2.patientTotal === paidTotal && pv2.lines.some((l) => l.name.includes(c2.no)), '重開後收據作廢重新批價：證明書費照原本那張收（不會變免費）')
    ok(!(await CT.listCertificates({ encounterId: ee.id })).find((x) => x.id === c3.id).printable, '收據作廢、還沒重新批價：重開的那張也暫時不能印')
    await api.chargeApi.pay(vv.id, { payMethod: 'cash', received: pv2.patientTotal })
    const rep = await api.chargeApi.dailyReport(T)
    const f = rep.byFeeType
    ok(f.reg + f.basicCopay + f.drugCopay + f.ipdCopay + f.selfPay + f.discount === rep.patientTotal, '日結：證明書費算自費項目，分類加總＝應收')
    await as(drUser)
    const hist = await api.opdApi.patientHistory(pt.id)
    ok(hist.find((h) => h.id === ee.id)?.certificates.some((x) => x.startsWith(c3.no)) && !hist.find((h) => h.id === ee.id).certificates.some((x) => x.startsWith(c2.no)), '就診紀錄列出這次開的證明書（作廢的不列）')

    // 住院：證明書費進住院帳單；結帳後不能再開
    const ready = db().admissions.find((a) => a.status === 'admitted' && a.dischargeSummary?.signedAt)
    await as(db().users.find((u) => u.doctorId === ready.doctorId).username)
    const ipdDraft = await CT.certificateDraft({ admissionId: ready.id })
    ok(ipdDraft.stayFrom === ready.admittedAt.slice(0, 10) && ipdDraft.stayTo === T, '住院證明書預設住院期間（入院日到開立日）')
    const ic = await CT.issueCertificate({ admissionId: ready.id, diagnoses: ipdDraft.diagnoses, advice: '宜休養兩週', purpose: '保險理賠', copies: 1 })
    await as('clerk01')
    const bill = (await api.ipdChargeApi.getIpdBill(ready.id)).bill
    ok(bill.lines.some((l) => l.name.includes(ic.no) && l.amount === price), '住院帳單含證明書費（自費，不算部分負擔）')
    await as('ph01')
    await api.dischargeRxApi.dispenseDischargeRx(ready.id)
    await as('clerk01')
    await api.ipdChargeApi.payIpd(ready.id, { payMethod: 'card', received: 0 })
    ok((await CT.listCertificates({ admissionId: ready.id }))[0].printable, '住院結帳後可以印')
    await as(db().users.find((u) => u.doctorId === ready.doctorId).username)
    msg = await errOf(() => CT.issueCertificate({ admissionId: ready.id, diagnoses: 'x', advice: 'y', purpose: '請假', copies: 1 }))
    ok(msg.includes('已結帳'), `住院結帳後再開 → 「${msg}」`)
    await as('nurse01')
    await expectError(() => CT.printCertificate(ic.id), '護理師印證明書')
  }

  // 病房常備：每病房一個地點；藥師補充、PRN/STAT 扣病人所在病房（不足改藥局直送）、護理師每班點班
  console.log('\n[病房常備]')
  {
    resetDb('small')
    const W = api.wardStockApi
    const db = () => dbm.db
    const wards = db().stockLocations.filter((l) => l.kind === 'ward')
    const w1 = wards[0]
    const qtyAt = (drugId, loc) => db().drugLots.filter((l) => l.drugId === drugId && l.locationId === loc).reduce((n, l) => n + l.qty, 0)
    ok(wards.length === 3 && db().wardStockItems.filter((x) => x.ward === w1.ward).length === 4 && qtyAt('M001', w1.id) === 25 && db().wardCounts.length === 3, `種子：3 個病房常備、各 4 個品項；${w1.name} Acetaminophen 25（基準 40，待補充）；昨天小夜都點過班`)
    ok(ledgerBroken(db()).length === 0, '加上病房常備後帳本仍對得起來')
    await as('ph01')
    await expectError(() => api.inventoryApi.listInventory({ locationId: w1.id }), '把病房常備當一般地點查庫存')
    await expectError(() => api.inventoryApi.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId: 'M001', locationId: w1.id, qty: 1, lotNo: 'X', expiry: '2030-01-01' }), '進貨進病房常備')
    ok(!(await api.inventoryApi.listStockLocations()).locations.some((l) => l.kind === 'ward'), '庫存頁的地點選單沒有病房常備')
    ok((await api.dashboardApi.getDashboard()).wardRefillDue === 1, '首頁待辦（藥師）：病房常備待補充 1 項')
    await as('nurse01')
    let v = await W.getWardStock(w1.ward)
    ok(v.rows.find((r) => r.drugId === 'M001')?.below && !v.shift.counted && v.lastCount?.shift === '小夜', '護理站：看得到存量、低於基準量、本班還沒點班（上次是昨天小夜）')
    ok((await api.dashboardApi.getDashboard()).wardCountDue === 3, '首頁待辦（護理師）：3 個病房本班未點班')
    await expectError(() => W.refillWard(w1.ward, [{ drugId: 'M001', qty: 15 }]), '護理師補充病房常備')
    // 藥師補充：不能超過基準量；補到基準量
    await as('ph01')
    try {
      await W.refillWard(w1.ward, [{ drugId: 'M001', qty: 20 }])
      ok(false, '超過基準量應被擋下')
    } catch (e) {
      ok(e.fields?.['qty.M001']?.includes('超過基準量'), '補了會超過基準量 → 擋下')
    }
    const ipd = db().stockLocations.find((l) => l.dispensesIpd).id
    const ipdBefore = qtyAt('M001', ipd)
    const rf = await W.refillWard(w1.ward, [{ drugId: 'M001', qty: 15 }])
    ok(qtyAt('M001', w1.id) === 40 && qtyAt('M001', ipd) === ipdBefore - 15 && db().stockTxns.filter((x) => x.ref === rf.no).length === 2 && db().auditLogs[0].action === '病房常備補充',
      `補充 ${rf.no}：住院藥局 −15、${w1.name} +15（同批號），一步完成`)
    ok((await api.dashboardApi.getDashboard()).wardRefillDue === 0 && ledgerBroken(db()).length === 0, '補完：待補充歸零，帳本仍對得起來')
    // 常備品項維護
    await expectError(() => W.saveWardStockItem(w1.ward, 'M001', 0), '櫃子裡還有就移除常備品項')
    await expectError(() => W.saveWardStockItem(w1.ward, 'M010', 1.5), '基準量不是整數')
    await W.saveWardStockItem(w1.ward, 'M010', 12)
    ok(db().wardStockItems.some((x) => x.ward === w1.ward && x.drugId === 'M010' && x.par === 12) && (await W.getWardStock(w1.ward)).rows.find((r) => r.drugId === 'M010')?.below, '新增常備品項（還沒補，標低於基準量）')
    await W.saveWardStockItem(w1.ward, 'M010', 0)
    ok(!db().wardStockItems.some((x) => x.ward === w1.ward && x.drugId === 'M010'), '還沒放藥的品項可以移除')

    // 點班：每一項都要點；差異要原因；帳上在點的時候變了要重來
    await as('nurse01')
    v = await W.getWardStock(w1.ward)
    const all = (over = {}) => v.rows.map((r) => ({ drugId: r.drugId, book: r.onHand, counted: r.onHand, ...(over[r.drugId] ?? {}) }))
    await expectError(() => W.countWard(w1.ward, { lines: all().slice(1) }), '漏點一項')
    try {
      await W.countWard(w1.ward, { lines: all({ M031: { counted: v.rows.find((r) => r.drugId === 'M031').onHand - 2 } }) })
      ok(false, '差異沒寫原因應被擋下')
    } catch (e) {
      ok(e.fields?.['reason.M031']?.includes('差 -2'), '有差異要寫原因（標在那一項）')
    }
    await expectError(() => W.countWard(w1.ward, { lines: all({ M001: { book: 39, counted: 39 } }) }), '帳上數量在點的時候變了')
    const m31 = qtyAt('M031', w1.id)
    const m26 = qtyAt('M026', w1.id)
    const c = await W.countWard(w1.ward, { lines: all({ M031: { counted: m31 - 2, reason: '找不到，已通報' }, M026: { counted: m26 + 1, reason: '上一班補充未登打' } }), witness: await witnessOf({ purpose: 'wardCount', ward: w1.ward }, 'nurse02') })
    ok(qtyAt('M031', w1.id) === m31 - 2 && qtyAt('M026', w1.id) === m26 + 1 && c.lines.filter((l) => l.reason).length === 2 && db().auditLogs[0].detail.includes('找不到'), '點班差異自動調帳（盤虧 −2、盤盈 +1），原因寫進點班紀錄與稽核')
    ok((await W.getWardStock(w1.ward)).shift.counted && (await api.dashboardApi.getDashboard()).wardCountDue === 2 && ledgerBroken(db()).length === 0, '本班已點班：首頁未點班的病房少一個；帳本仍對得起來')

    // 給藥：扣病人所在病房；不夠改住院藥局直送（不擋給藥）
    const prn = db().ipdOrders.find((o) => o.freq === 'PRN' && o.status === 'active' && o.drugId === 'M001' && db().admissions.find((a) => a.id === o.admissionId)?.status === 'admitted')
    const pw = db().beds.find((b) => b.id === db().admissions.find((a) => a.id === prn.admissionId).bedId).ward
    const pl = db().stockLocations.find((l) => l.kind === 'ward' && l.ward === pw)
    const g1 = await api.nursingApi.givePrn(prn.id, '頭痛')
    ok(g1.stockFrom === 'ward' && db().stockTxns.at(-1).locationId === pl.id, `PRN 給藥扣${pl.name}`)
    // 把這個病房的 Acetaminophen 點成 0（全被拿走）→ 再給藥改由藥局直送
    const pv = await W.getWardStock(pw)
    await W.countWard(pw, { lines: pv.rows.map((r) => ({ drugId: r.drugId, book: r.onHand, counted: r.drugId === 'M001' ? 0 : r.onHand, reason: r.drugId === 'M001' ? '測試：櫃子空了' : undefined })), witness: await witnessOf({ purpose: 'wardCount', ward: pw }, 'nurse02') })
    const ipdB = qtyAt('M001', ipd)
    const g2 = await api.nursingApi.givePrn(prn.id, '再次頭痛')
    ok(g2.stockFrom === 'pharmacy' && qtyAt('M001', ipd) === ipdB - prn.dose && db().stockTxns.at(-1).ref.startsWith('藥局直送'), '病房常備不夠：不擋給藥，改由住院藥局直送（給藥紀錄標「藥局直送」）')
    ok(db().mar.find((m) => m.id === g2.id).stockFrom === 'pharmacy', '給藥紀錄記下扣哪裡')
    const { readFileSync } = await import('node:fs')
    ok(readFileSync('src/services/nursing.ts', 'utf8').includes('wardStockOut(') && !/stockLoc\.ipd\(\)/.test(readFileSync('src/services/nursing.ts', 'utf8')), 'PRN、STAT 扣帳只走 wardStockOut（護理站不自己決定扣哪裡）')
    await as('clerk01')
  }

  // 第二人當場確認（共用 witness-core）：管制藥點班見證、報廢覆核；優免主管核准也走同一套（上面的優免測試）
  console.log('\n[管制藥雙人點班、報廢覆核]')
  {
    resetDb('small')
    const W = api.wardStockApi
    const WI = api.witnessApi
    const db = () => dbm.db
    const drug = (id) => db().drugs.find((d) => d.id === id)
    ok(drug('M039').controlled === 2 && drug('M031').controlled === 4 && !drug('M001').controlled, '種子：Morphine 第二級、Tramadol 第四級管制藥；其他不是')
    // 主檔：級別只有 1～4；空白＝非管制
    await as('ph01')
    const m26 = drug('M026')
    await expectError(() => api.masterApi.saveDrug({ ...m26, controlled: 5 }), '管制藥品級別填 5')
    await api.masterApi.saveDrug({ ...m26, controlled: 3 })
    ok(drug('M026').controlled === 3, '主檔設定管制級別（第三級）')
    await api.masterApi.saveDrug({ ...drug('M026'), controlled: '' })
    ok(drug('M026').controlled === undefined, '改回非管制（空白）')

    const w1 = db().stockLocations.find((l) => l.kind === 'ward')
    await as('nurse01')
    let v = await W.getWardStock(w1.ward)
    ok(v.needsWitness && v.rows.find((r) => r.drugId === 'M039')?.controlled === 2 && !v.rows.find((r) => r.drugId === 'M001').controlled, `${w1.name}含管制藥：點班要見證，品項標出級別`)
    const lines = () => v.rows.map((r) => ({ drugId: r.drugId, book: r.onHand, counted: r.onHand }))
    try {
      await W.countWard(w1.ward, { lines: lines() })
      ok(false, '沒有見證應被擋下')
    } catch (e) {
      ok(e.field === 'witness' && e.message.includes('另一位護理師'), `含管制藥沒有見證 → 「${e.message}」（服務層把關）`)
    }
    // 見證人：不能是自己、密碼錯、不是護理師、停用的帳號都回傳失敗（不丟錯），失敗留稽核
    const tryW = (username, password = '1234') => WI.approveWitness({ purpose: 'wardCount', ward: w1.ward, username, password })
    let r = await tryW('nurse01')
    ok(!r.ok && r.field === 'username' && r.message.includes('自己') && db().auditLogs[0].action === '管制藥點班見證失敗', `見證人是自己 → 「${r.message}」，失敗留在稽核`)
    r = await tryW('nurse02', 'wrong')
    ok(!r.ok && r.field === 'password', '見證人密碼錯 → 回傳失敗（標在密碼欄）')
    r = await tryW('ph01')
    ok(!r.ok && r.message.includes('不是護理師'), `藥師見證病房點班 → 「${r.message}」`)
    db().users.find((u) => u.username === 'nurse02').active = false
    r = await tryW('nurse02')
    db().users.find((u) => u.username === 'nurse02').active = true
    ok(!r.ok && r.message.includes('停用'), '停用的帳號不能見證')
    await expectError(() => WI.approveWitness({ purpose: 'wardCount', ward: w1.ward, username: '', password: '' }), '見證沒填帳密')
    // 確認綁定病房與發起人
    const other = db().stockLocations.filter((l) => l.kind === 'ward')[1]
    const tOther = await witnessOf({ purpose: 'wardCount', ward: other.ward }, 'nurse02')
    await expectError(() => W.countWard(w1.ward, { lines: lines(), witness: tOther }), '拿別的病房的見證點班')
    const tok = await witnessOf({ purpose: 'wardCount', ward: w1.ward }, 'staff01')
    ok(db().auditLogs[0].action === '管制藥點班見證' && db().auditLogs[0].detail.includes('陳小芬 見證') && db().auditLogs[0].detail.includes('Morphine'), '兼任護理師的帳號（護理＋櫃台）也能見證；稽核寫出見證人與管制藥')
    await as('nurse02')
    await expectError(() => W.countWard(w1.ward, { lines: lines(), witness: tok }), '別的護理師拿這張見證點班')
    await as('nurse01')
    // 送出失敗（差異沒寫原因）不會用掉見證：改好再送
    await expectError(() => W.countWard(w1.ward, { lines: lines().map((l) => (l.drugId === 'M039' ? { ...l, counted: l.book - 1 } : l)), witness: tok }), '差異沒寫原因（見證還在）')
    clockBase += 11 * 60_000
    try {
      await W.countWard(w1.ward, { lines: lines(), witness: tok })
      ok(false, '過期的見證應被擋下')
    } catch (e) {
      ok(e.field === 'witness' && e.message.includes('重新見證'), `見證超過 10 分鐘 → 「${e.message}」`)
    } finally {
      clockBase -= 11 * 60_000
    }
    const c = await W.countWard(w1.ward, { lines: lines(), witness: tok })
    ok(c.witnessBy === 'U501' && (await W.getWardStock(w1.ward)).lastCount?.witnessName === '陳小芬' && db().auditLogs[0].detail.includes('見證 陳小芬'), '點班完成：記下見證人（點班紀錄、上次點班、稽核）')
    await expectError(() => W.countWard(w1.ward, { lines: lines(), witness: tok }), '同一張見證再用一次')
    // 沒有管制藥的病房常備不需要見證
    for (const id of ['M031', 'M039']) db().drugs.find((d) => d.id === id).controlled = undefined
    v = await W.getWardStock(other.ward)
    ok(!v.needsWitness, '常備沒有管制藥：不需要見證')
    await expectError(() => WI.approveWitness({ purpose: 'wardCount', ward: other.ward, username: 'nurse02', password: '1234' }), '沒有管制藥卻要求見證')
    await W.countWard(other.ward, { lines: lines() })
    ok(!db().wardCounts.at(-1).witnessBy, '沒有管制藥：一個人點班即可')
    resetDb('small')

    // 報廢一律要另一位藥師（或管理者）覆核
    await as('ph01')
    const lot = db().drugLots.find((l) => l.qty > 0 && l.expiry < today() && l.locationId === db().stockLocations.find((x) => x.dispensesOpd).id)
    ok(!!lot, '種子資料有已過期的批號')
    try {
      await api.inventoryApi.scrapExpired(lot.drugId)
      ok(false, '沒有覆核應被擋下')
    } catch (e) {
      ok(e.field === 'witness' && e.message.includes('另一位藥師'), `過期報廢沒有覆核 → 「${e.message}」`)
    }
    const tryS = (username) => WI.approveWitness({ purpose: 'scrapExpired', drugId: lot.drugId, username, password: '1234' })
    r = await tryS('ph01')
    ok(!r.ok && r.message.includes('自己') && db().auditLogs[0].action === '報廢覆核失敗', '覆核人是自己 → 回傳失敗，留稽核')
    r = await tryS('nurse01')
    ok(!r.ok && r.message.includes('不是藥師或管理者'), `護理師覆核報廢 → 「${r.message}」`)
    const other2 = db().drugLots.find((l) => l.qty > 0 && l.expiry >= today())
    await expectError(() => WI.approveWitness({ purpose: 'scrapExpired', drugId: other2.drugId, locationId: other2.locationId, username: 'ph02', password: '1234' }), '沒有過期批號卻要求覆核')
    const sTok = await witnessOf({ purpose: 'scrapExpired', drugId: lot.drugId }, 'admin')
    const stockBefore = drug(lot.drugId).stock
    const txns = await api.inventoryApi.scrapExpired(lot.drugId, undefined, sTok)
    ok(txns.length >= 1 && drug(lot.drugId).stock < stockBefore && txns.every((x) => x.reason.includes('覆核 系統管理員')) && db().auditLogs[0].detail.includes('覆核 系統管理員'), '管理者覆核後報廢：異動原因與稽核都寫出覆核人')
    ok(ledgerBroken(db()).length === 0, '報廢後帳本仍對得起來')
    const { readFileSync } = await import('node:fs')
    const src = (f) => readFileSync(f, 'utf8')
    ok(!src('src/services/index.ts').includes('witness-core') && src('src/services/charge.ts').includes("grantWitness({") && !src('src/services/charge.ts').includes('const approvals'), '優免核准改用共用的 witness-core（內部模組，不是 API）')
    await as('clerk01')
  }

  console.log('\n[住院調劑（UD）]')
  {
    resetDb('small')
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
    ok(seedUd?.kind === 'daily' && seedUd.dispensedAt.startsWith(addDays(T, -1)) && todayLong.length > 0 && todayLong.every((m) => m.udLineId) && seedUd.boxes.every((b) => b.status === 'verified' && b.verifiedBy !== seedUd.dispensedBy),
      `展示資料：昨天 15:00 調劑、另一位藥師核對送出今天的 ${todayLong.length} 劑（${seedUd?.no}）`)
    ok(seedUd.lines.every((l) => l.qty === 0 || db().stockTxns.find((x) => x.id === l.txnId && x.ref === seedUd.no && x.locationId === ipd && x.qty === -l.qty)), '展示資料的調劑都有扣住院藥局的異動（同單號、同數量）')
    ok(ledgerBroken(db()).length === 0, '加上住院調劑後，帳本、批號、結存仍對得起來')
    await as('nurse01')
    await expectError(() => U.getUdWork(), '護理師看住院調劑工作清單')
    await as('ph01')
    let w = await U.getUdWork()
    const dailyLines = w.daily.flatMap((g) => g.lines)
    ok(w.extra.length === 0 && w.daily.length > 0 && w.verify.length === 0 && w.returns.length === 0 && w.awaitingWard.length === 0 && w.recent.length === 1, `工作清單：補調劑 0、明天 ${w.daily.length} 位病人 ${dailyLines.length} 項、待退藥 0`)
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
    const admId = (w.daily.find((g) => db().admissions.find((x) => x.id === g.admissionId)?.deptId === 'D02') ?? w.daily[0]).admissionId // dr02 是內科：挑內科的病人
    const fresh = await api.ipdApi.addOrder({ admissionId: admId, type: 'long', category: 'medication', drugId: 'M010', content: '', dose: 1, freq: 'QID', route: 'PO', allowDuplicate: true })
    await as('ph01')
    const need = {}
    for (const l of dailyLines.filter((l) => l.perDose)) need[l.drugId] = (need[l.drugId] ?? 0) + l.qty
    const before = Object.fromEntries(Object.keys(need).map((d) => [d, usableAt(d)]))
    const r = await U.dispenseUd({ kind: 'daily', marIds: dailyIds, qtys: { [insulin.orderId]: 0 } })
    w = await U.getUdWork()
    ok(r.lines === dailyLines.length && Object.entries(need).every(([d]) => usableAt(d) === before[d]) && w.verify.length === r.patients && !w.daily.some((g) => g.lines.some((l) => l.marIds.some((id) => dailyIds.includes(id)))) && db().auditLogs[0].action === '住院調劑',
      `每日調劑 ${r.no}：${r.patients} 位病人 ${r.lines} 項，待核對（調劑只是備藥，還不扣帳）`)
    const tomorrowMar = (await api.ipdApi.listMar(admId, addDays(T, 1))).find((m) => dailyIds.includes(m.id))
    ok(tomorrowMar?.awaitingUd === 'checking', '護理站：已調劑、核對中的標「藥局核對中」（還不能給）')
    // 雙人核對（和門診共用同一個設定）：調劑的人不能自己核對
    await as('admin')
    await api.pharmacyApi.saveDispensePolicy(true)
    await as('ph01')
    const myBox = (await U.getUdWork()).verify[0]
    await expectError(() => U.verifyUdBox(myBox.dispenseId, myBox.admissionId), '雙人核對開啟時，調劑的人自己核對')
    ok(!!myBox.blocked, `待核對清單先說清楚：「${myBox.blocked}」`)
    await as('ph02')
    for (const b of (await U.getUdWork()).verify) await U.verifyUdBox(b.dispenseId, b.admissionId)
    ok(Object.entries(need).every(([d, q]) => usableAt(d) === before[d] - q) && db().auditLogs[0].action === '住院調劑核對' && db().udDispenses.find((x) => x.no === r.no).boxes.every((b) => b.status === 'verified' && b.verifiedBy === 'U302'),
      '另一位藥師逐位病人核對通過：這時才扣住院藥局、送病房')
    ok(dailyIds.every((id) => db().mar.find((m) => m.id === id).udLineId) && !db().stockTxns.some((x) => x.ref === r.no && x.drugId === insulin.drugId), '那幾劑標為已調劑；胰島素填 0（床邊已有）不產生異動')
    await expectError(() => U.verifyUdBox(myBox.dispenseId, myBox.admissionId), '已核對的藥盒再核對一次')
    // 藥車交接：核對送出 → 病房逐盒點收；不符回報藥局、藥師處理。點收前照樣可以給（只標示）
    {
      ok(seedUd.boxes.every((b) => b.receivedAt && b.receivedBy && b.ward), '展示資料：昨天的藥車已在病房點收（記下送到哪個病房）')
      const disp = db().udDispenses.find((x) => x.no === r.no)
      const wardOf = (b) => db().beds.find((x) => x.id === db().admissions.find((a) => a.id === b.admissionId).bedId)?.ward
      ok(disp.boxes.every((b) => b.ward && b.ward === wardOf(b)), '調劑時記下藥盒送去的病房（病人當時的床）')
      await expectError(() => U.listWardUdCarts(disp.boxes[0].ward), '藥師看護理站的藥車點收')
      await as('nurse01')
      const wards = [...new Set(disp.boxes.map((b) => b.ward))]
      const cartsByWard = Object.fromEntries(await Promise.all(wards.map(async (wd) => [wd, await U.listWardUdCarts(wd)])))
      const listed = wards.flatMap((wd) => cartsByWard[wd].carts.filter((c) => c.no === r.no).flatMap((c) => c.boxes))
      ok(listed.length === disp.boxes.length && wards.every((wd) => cartsByWard[wd].carts.filter((c) => c.no === r.no).every((c) => c.boxes.every((b) => disp.boxes.find((x) => x.admissionId === b.admissionId).ward === wd))), `護理站：${r.no} 的 ${listed.length} 盒依病房列在「藥車待點收」`)
      ok((await api.dashboardApi.getDashboard()).udToReceive === disp.boxes.length, '首頁待辦：藥車待點收的盒數')
      const [b1, b2] = disp.boxes
      const box = (b) => db().udDispenses.find((x) => x.no === r.no).boxes.find((x) => x.admissionId === b.admissionId) // mutate 失敗會換成快照：每次重新取
      const m1 = (await api.ipdApi.listMar(b1.admissionId, addDays(T, 1))).find((m) => m.udLineId && disp.lines.some((l) => l.id === m.udLineId))
      ok(m1?.udDelivery === 'notReceived' && !m1.awaitingUd, '給藥列：已核對送出、還沒點收的標「藥車未點收」（不擋給藥）')
      await expectError(() => U.receiveUdBoxes(disp.id, []), '沒勾藥盒就點收')
      const rc = await U.receiveUdBoxes(disp.id, [b1.admissionId])
      ok(rc.boxes === 1 && box(b1).receivedBy === 'U201' && db().auditLogs[0].action === '藥車點收', '點收勾的那一盒（記下誰、何時），寫稽核')
      ok(!(await api.ipdApi.listMar(b1.admissionId, addDays(T, 1))).some((m) => m.udDelivery), '點收後給藥列不再標示')
      await expectError(() => U.receiveUdBoxes(disp.id, [b1.admissionId]), '已點收的再點收一次')
      if (b2) {
        try {
          await U.reportUdBox(disp.id, b2.admissionId, { cause: '其他' })
          ok(false, '「其他」沒寫說明應被擋下')
        } catch (e) {
          ok(e.fields?.note, '不符選「其他」要寫說明')
        }
        await expectError(() => U.reportUdBox(disp.id, b2.admissionId, { cause: '亂寫' }), '不在清單的不符原因')
        await U.reportUdBox(disp.id, b2.admissionId, { cause: '短少', note: '少一顆' })
        const m2 = (await api.ipdApi.listMar(b2.admissionId, addDays(T, 1))).find((m) => m.udLineId && disp.lines.some((l) => l.id === m.udLineId))
        ok(box(b2).receivedAt && box(b2).issue?.cause === '短少' && m2?.udDelivery === 'issue' && db().auditLogs[0].action === '藥盒不符', '回報不符：這一盒算已到病房、記下原因，給藥列標「藥盒不符」')
        ok((await U.listWardUdCarts(b2.ward)).issues.some((i) => i.admissionId === b2.admissionId && i.note === '少一顆'), '護理站列出「已回報藥局、處理中」')
        await expectError(() => U.receiveUdBoxes(disp.id, [b2.admissionId]), '回報不符的再點收')
        await expectError(() => U.resolveUdIssue(disp.id, b2.admissionId, { resolution: '已補發' }), '護理師處理藥局的回報')
        await as('ph01')
        const iw = await U.getUdWork()
        ok(iw.issues.length === 1 && iw.issues[0].items.length > 0 && (await api.dashboardApi.getDashboard()).udIssues === 1, `藥局 UD 頁：病房回報 1 盒（${iw.issues[0]?.cause}，列出這盒的藥）；首頁待辦也有`)
        try {
          await U.resolveUdIssue(disp.id, b2.admissionId, { resolution: ' ', resupply: { [iw.issues[0].lines[0].lineId]: -1 } })
          ok(false, '沒寫處理說明應被擋下')
        } catch (e) {
          ok(e.fields?.resolution && e.fields?.[`resupply.${iw.issues[0].lines[0].lineId}`], '處理要寫說明；補發數量要是 0 以上整數（一次標出）')
        }
        const before2 = db().stockTxns.length
        const rl = iw.issues[0].lines.find((l) => l.qty > 0)
        const rs = await U.resolveUdIssue(disp.id, b2.admissionId, { resolution: '已補發 1 顆', resupply: { [rl.lineId]: 1 } })
        const rtx = db().stockTxns.slice(before2)
        ok(rs.resupplied === 1 && rtx.length === 1 && rtx[0].ref === r.no && rtx[0].qty === -1 && rtx[0].reason.includes('藥盒不符補發') && box(b2).issue.resupplyTxnIds?.[0] === rtx[0].id, `補發 1 ${rl.unit} ${rl.drugName}：扣住院藥局、同一張單號（那幾劑不會再出現在補調劑，不在這裡扣就帳實不符）`)
        ok(box(b2).issue.resolvedBy === 'U301' && !(await U.getUdWork()).issues.length && db().auditLogs[0].detail.includes('補發') && ledgerBroken(db()).length === 0, '藥師處理完：記下說明、稽核寫出補發，帳本仍對得起來')
        await expectError(() => U.resolveUdIssue(disp.id, b2.admissionId, { resolution: '再處理一次' }), '已處理的再處理')
        await as('nurse01')
        ok(!(await api.ipdApi.listMar(b2.admissionId, addDays(T, 1))).some((m) => m.udDelivery) && !(await U.listWardUdCarts(b2.ward)).issues.length, '處理完：給藥列、護理站都不再標示')
      }
      // 其餘的點收完（後面的測試照常）
      for (const wd of wards) for (const c of (await U.listWardUdCarts(wd)).carts) await U.receiveUdBoxes(c.dispenseId, c.boxes.map((b) => b.admissionId))
      ok((await api.dashboardApi.getDashboard()).udToReceive === 0, '全部點收完，首頁待辦歸零')
      await as('ph02')
    }
    await as('admin')
    await api.pharmacyApi.saveDispensePolicy(false)
    await as('ph01')
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
    const rx = await U.dispenseUd({ kind: 'extra', marIds: freshExtra.marIds })
    await as('nurse01')
    try {
      await api.nursingApi.executeMar(fm.id, 'given')
      ok(false, '核對中就給藥應被擋下')
    } catch (e) {
      ok(e.field === 'ud' && e.message.includes('核對'), `已調劑、還沒核對就給 → 「${e.message}」`)
    }
    await as('ph01')
    const xbox = (await U.getUdWork()).verify.find((b) => b.no === rx.no)
    try {
      await U.rejectUdBox(xbox.dispenseId, xbox.admissionId, '')
      ok(false, '退回重調沒寫原因應被擋下')
    } catch (e) {
      ok(e.field === 'reason', `退回重調沒寫原因 → 「${e.message}」`)
    }
    await U.rejectUdBox(xbox.dispenseId, xbox.admissionId, '劑量放錯藥盒')
    w = await U.getUdWork()
    ok(!w.verify.some((b) => b.no === rx.no) && w.extra.flatMap((g) => g.lines).some((l) => l.orderId === fresh.id && l.marIds.includes(fm.id)) && !db().stockTxns.some((x) => x.ref === rx.no),
      '核對發現錯誤退回重調：那幾劑回到待調劑，沒有扣帳')
    await udSupply('extra', freshExtra.marIds)
    const r2 = await udSupply('daily', freshDaily.marIds)
    await as('nurse01')
    const given = await api.nursingApi.executeMar(fm.id, 'given')
    ok(given.status === 'given', '重新調劑、核對送出後可以給')
    // 退藥：暫停一劑、醫師停止醫囑（明天已調好的 4 劑被取消）
    const later = db().mar.find((m) => m.orderId === fresh.id && m.status === 'pending' && m.udLineId && m.scheduledAt.startsWith(T))
    await api.nursingApi.executeMar(later.id, 'held', '病人禁食')
    await as('dr02')
    await api.ipdApi.stopOrder(fresh.id)
    await as('ph01')
    w = await U.getUdWork()
    const lineOf = (x) => db().udDispenses.find((u) => u.id === x.dispenseId).lines.find((l) => l.id === x.lineId)
    ok(!w.returns.some((x) => lineOf(x).orderId === fresh.id) && w.awaitingWard.filter((x) => lineOf(x).orderId === fresh.id).length === 2, '沒給的劑量先列在「病房待送回」，還不能點收')
    const waitRow = w.awaitingWard.find((x) => lineOf(x).orderId === fresh.id)
    await expectError(() => U.receiveUdReturn(waitRow.lineId, { qty: waitRow.expected }), '病房還沒送回就點收')
    await as('nurse01')
    const ward = db().beds.find((b) => b.id === db().admissions.find((a) => a.id === admId).bedId).ward
    const wardRows = await U.listWardUdReturns(ward)
    const mine = wardRows.filter((x) => lineOf(x).orderId === fresh.id)
    ok(mine.length === 2, `護理站「待送回藥局」：${mine.map((x) => `${x.bedNo} ${x.drugName} ${x.expected}`).join('、')}`)
    await as('ph01')
    await expectError(() => U.sendBackUd(mine.map((x) => x.lineId)), '藥師按「送回藥局」')
    await as('nurse01')
    const sb = await U.sendBackUd(mine.map((x) => x.lineId))
    ok(sb.lines === 2 && !(await U.listWardUdReturns(ward)).some((x) => lineOf(x).orderId === fresh.id) && db().auditLogs[0].action === '送回藥局', `送回藥局：${sb.lines} 項 ${sb.doses} 劑，離開護理站待辦`)
    await expectError(() => U.sendBackUd([mine[0].lineId]), '已送回的再送一次')
    await as('ph01')
    w = await U.getUdWork()
    const rows = w.returns.filter((x) => lineOf(x).orderId === fresh.id)
    ok(rows.every((x) => x.sentByName === '周怡萱' && x.sentAt), '藥局待點收：看得到誰、何時送回')
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
    // PRN：病房常備，給的時候扣病人所在病房的常備（不在常備清單上的藥改由住院藥局直送）
    await as('nurse01')
    const prn = db().ipdOrders.find((o) => o.freq === 'PRN' && o.status === 'active' && db().drugs.find((d) => d.id === o.drugId && !d.doseUnit))
    const prnWard = db().beds.find((b) => b.id === db().admissions.find((a) => a.id === prn.admissionId).bedId).ward
    const wl = db().stockLocations.find((l) => l.kind === 'ward' && l.ward === prnWard)
    const inWard = db().wardStockItems.some((x) => x.ward === prnWard && x.drugId === prn.drugId)
    const wardQty = () => db().drugLots.filter((l) => l.drugId === prn.drugId && l.locationId === wl.id).reduce((n, l) => n + l.qty, 0)
    const bp = usableAt(prn.drugId)
    const bw = wardQty()
    const mPrn = await api.nursingApi.givePrn(prn.id, '體溫 38.5°C')
    const last = db().stockTxns.at(-1)
    ok(inWard ? wardQty() === bw - prn.dose && last.locationId === wl.id && last.ref.startsWith('病房常備') && mPrn.stockFrom === 'ward' && usableAt(prn.drugId) === bp : usableAt(prn.drugId) === bp - prn.dose && mPrn.stockFrom === 'pharmacy',
      `PRN 給藥扣${inWard ? `病房常備（${wl.name} −${prn.dose}），住院藥局不動` : '住院藥局（不在常備清單：藥局直送）'}`)
    ok(!('wardStockOut' in api.nursingApi) && !('pendingReturn' in api.udApi) && !('wardStockOut' in api.udApi), '病房常備扣帳、待退計算都不對外（服務層內部）')
    // 出院：已調好、還沒給的劑量（出院時取消的排程、逾時沒給的）都要退
    {
      const lineById = (id) => db().udDispenses.flatMap((u) => u.lines).find((l) => l.id === id)
      const dis = db().admissions.find((a) => a.status === 'admitted' && db().mar.some((m) => m.admissionId === a.id && m.status === 'pending' && m.udLineId && lineById(m.udLineId)?.perDose))
      ok(!!dis, '有已調劑、還沒給的病人可以測出院退藥')
      if (dis) {
        await as(db().users.find((u) => u.doctorId === dis.doctorId).username)
        await api.ipdApi.saveDischargeSummary(dis.id, { diagnosis: dis.diagnosis, course: '測試', condition: '穩定', followUp: '門診追蹤', dischargeType: '治癒' }, true)
        await as('clerk01')
        await api.ipdChargeApi.payIpd(dis.id, { payMethod: 'card', received: 0 }) // 出院前先結帳
        await as('nurse01')
        await api.admissionApi.discharge(dis.id, { confirmUnfinished: true })
        const disWard = db().beds.find((b) => b.id === dis.bedId).ward
        const rws = (await U.listWardUdReturns(disWard)).filter((x) => x.admissionId === dis.id)
        ok(rws.length > 0 && rws.every((x) => x.causes.startsWith('出院') && x.discharged), `出院後：今天已調好沒給的 ${rws.reduce((n, x) => n + x.doses, 0)} 劑列在原病房「待送回藥局」（標已出院，原因「出院」）`)
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
    const work = (x) => x.stockLocations.filter((l) => l.kind === 'warehouse' || l.kind === 'pharmacy')
    ok(work(small).length === 1 && work(large).map((l) => l.name).join('、') === '藥庫、門診藥局、住院藥局' && small.stockLocations.filter((l) => l.kind === 'ward').length === 3, `小型 1 個作業地點；大型 ${work(large).map((l) => l.name).join('、')}；兩種規模都有 3 個病房常備`)
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
    ok(byType('dispense') === 'LOC-OPD,LOC-IPD' && large.stockTxns.filter((x) => x.type === 'dispense' && x.locationId === 'LOC-IPD').every((x) => x.ref.startsWith('UD') || x.ref.startsWith('PCA ')) && byType('receive') === 'LOC-WH' && byType('opening') === 'LOC-WH', '門診發藥從門診藥局扣、住院調劑（UD、PCA 架設）從住院藥局扣；期初、進貨只進藥庫')
    const outs = large.stockTxns.filter((x) => x.type === 'transfer-out' && !x.ref?.startsWith('WR'))
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
    resetDb('large')
    ok(dbm.db.hospitalScale === 'large', '重建展示資料可選大型')
    await as('ph01')
    {
      const w = await api.udApi.getUdWork()
      const g = w.daily[0]
      const ids = g.lines.filter((l) => l.perDose).flatMap((l) => l.marIds)
      const r = await udSupply('daily', ids)
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
    const trTxns = dbm.db.stockTxns.filter((t) => (t.type === 'transfer-out' || t.type === 'transfer-in') && !t.ref?.startsWith('WR'))
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
    // 退回藥庫：藥局逐批申請（不扣帳）→ 藥庫核准 → 藥局送出才扣（運送中）→ 藥庫簽收入帳
    {
      const cands = await TRA.returnCandidates('LOC-OPD')
      const T0 = T
      ok(cands.length > 0 && cands.every((c) => dbm.db.drugLots.find((l) => l.id === c.lotId)?.locationId === 'LOC-OPD') && cands.findIndex((c) => !c.flag) >= cands.findLastIndex((c) => !!c.flag),
        `退回候選：門診藥局有庫存的批號 ${cands.length} 個，過期／近效期／存太多的排前面（${cands.filter((c) => c.flag).map((c) => `${c.drugName} ${c.flag}`).slice(0, 3).join('、')}…）`)
      await expectError(() => TRA.returnCandidates('LOC-WH'), '從藥庫發起退回')
      const pick = cands.find((c) => c.qty >= 3 && c.expiry >= T0)
      // 不留物件參照：下面會先呼叫一次失敗的 mutate（資料庫換成快照，舊參照就失效）
      const lotNow = () => dbm.db.drugLots.find((l) => l.id === pick.lotId)
      const lot = { drugId: pick.drugId, lotNo: pick.lotNo, expiry: pick.expiry }
      try {
        await TRA.returnToWarehouse({ fromLocationId: 'LOC-OPD', reason: '', lines: [{ lotId: pick.lotId, qty: pick.qty + 1 }, { lotId: pick.lotId, qty: 1 }] })
        ok(false, '退回欄位錯誤應被擋下')
      } catch (e) {
        ok(e.fields?.reason && e.fields?.['line-0'] && e.fields?.['line-1'], `退回欄位錯誤一次標出：${Object.values(e.fields ?? {}).join('／')}`)
      }
      const whLot = () => dbm.db.drugLots.find((l) => l.locationId === 'LOC-WH' && l.drugId === lot.drugId && l.lotNo === lot.lotNo)?.qty ?? 0
      const before = { opd: lotNow().qty, wh: whLot() }
      const expired = cands.find((c) => c.flag === 'expired')
      const lines = [{ lotId: pick.lotId, qty: 3 }, ...(expired ? [{ lotId: expired.lotId, qty: expired.qty }] : [])]
      const req = await TRA.returnToWarehouse({ fromLocationId: 'LOC-OPD', reason: '請領過多', lines })
      ok(req.kind === 'return' && req.status === 'requested' && lotNow().qty === before.opd && dbm.db.auditLogs[0].action === '退回藥庫申請', `退回申請 ${req.no}：待藥庫審核，還沒扣帳（藥還在門診藥局）`)
      const rt = await approveAndShip(req)
      ok(rt.kind === 'return' && rt.status === 'issued' && rt.fromLocationId === 'LOC-OPD' && rt.toLocationId === 'LOC-WH' && lotNow().qty === before.opd - 3 && whLot() === before.wh && dbm.db.auditLogs[0].action === '退回藥庫送出',
        `藥庫核准、藥局送出才從門診藥局扣（指定批號 ${lot.lotNo}），運送中、藥庫還沒入${expired ? '；過期批號也能退' : ''}`)
      const ln = rt.lines.find((l) => l.drugId === lot.drugId)
      const recvd = Object.fromEntries(rt.lines.map((l) => [l.id, l.lots.map((x) => x.qty)]))
      recvd[ln.id] = ln.lots.map((x, k) => (x.lotNo === lot.lotNo ? x.qty - 1 : x.qty))
      await expectError(() => TRA.receiveTransfer(rt.id, { received: recvd }), '退回簽收短少沒寫原因')
      // 退回藥庫逐批處理：過期的不能入可用庫存（只能待報廢或拒收）
      const dispAll = Object.fromEntries(rt.lines.map((l) => [l.id, l.lots.map(() => 'stock')]))
      if (expired) {
        try {
          await TRA.receiveTransfer(rt.id, { received: recvd, shortReasons: { [ln.id]: '運送破損 1' }, dispositions: dispAll })
          ok(false, '過期的入可用庫存應被擋下')
        } catch (e) {
          ok(Object.keys(e.fields ?? {}).some((k) => k.startsWith('disp-')) && Object.values(e.fields).some((m) => m.includes('不能入可用庫存')), '退回的過期批號不能入可用庫存（只能待報廢或拒收）')
        }
      }
      const dispOk = Object.fromEntries(rt.lines.map((l) => [l.id, l.lots.map((x) => (x.expiry < T ? 'quarantine' : 'stock'))]))
      const got = await TRA.receiveTransfer(rt.id, { received: recvd, shortReasons: { [ln.id]: '運送破損 1' }, dispositions: dispOk })
      ok(got.status === 'received' && whLot() === before.wh + 2 && dbm.db.drugLots.find((l) => l.locationId === 'LOC-WH' && l.lotNo === lot.lotNo).expiry === lot.expiry, '藥庫簽收：入藥庫同一批號、同效期（短少 1 寫原因）')
      ok(ledgerBroken(dbm.db).length === 0, '退回後各地點帳本仍對得起來')
      if (expired) {
        const qr = dbm.db.stockLocations.find((l) => l.kind === 'quarantine')
        const qLot = dbm.db.drugLots.find((l) => l.locationId === qr?.id && l.lotNo === expired.lotNo && l.qty > 0)
        ok(qr?.parentId === 'LOC-WH' && qLot?.qty === expired.qty && got.lines.some((l) => l.lots.some((x) => x.disposition === 'quarantine')), `過期批號 ${expired.lotNo} 進「${qr?.name}」（藥庫底下另一區），單上標「待報廢」`)
      }
    }
    // ---- 退回藥庫：拒收、待報廢區（報廢、放回可用） ----
    {
      const INV2 = api.inventoryApi
      const lotQty = (loc, drugId, lotNo) => dbm.db.drugLots.find((l) => l.locationId === loc && l.drugId === drugId && l.lotNo === lotNo)?.qty ?? 0
      const cands = (await TRA.returnCandidates('LOC-OPD')).filter((c) => c.qty >= 4 && c.flag !== 'expired')
      const [c1, c2] = [cands[0], cands.find((c) => c.drugId !== cands[0].drugId)]
      const rt2 = await approveAndShip(await TRA.returnToWarehouse({ fromLocationId: 'LOC-OPD', reason: '請領過多', lines: [{ lotId: c1.lotId, qty: 2 }, { lotId: c2.lotId, qty: 2 }] }))
      const l1 = rt2.lines.find((l) => l.drugId === c1.drugId)
      const l2 = rt2.lines.find((l) => l.drugId === c2.drugId)
      const recv2 = Object.fromEntries(rt2.lines.map((l) => [l.id, l.lots.map((x) => x.qty)]))
      const opdBefore = lotQty('LOC-OPD', c1.drugId, c1.lotNo)
      const whBefore = lotQty('LOC-WH', c1.drugId, c1.lotNo)
      try {
        await TRA.receiveTransfer(rt2.id, { received: recv2, dispositions: { [l1.id]: ['rejected'], [l2.id]: ['quarantine'] } })
        ok(false, '拒收沒寫原因應被擋下')
      } catch (e) {
        ok(e.fields?.[`reject-${l1.id}`], '拒收要寫原因')
      }
      const got2 = await TRA.receiveTransfer(rt2.id, { received: recv2, dispositions: { [l1.id]: ['rejected'], [l2.id]: ['quarantine'] }, rejectReasons: { [l1.id]: '未事先聯絡' } })
      ok(lotQty('LOC-OPD', c1.drugId, c1.lotNo) === opdBefore + 2 && lotQty('LOC-WH', c1.drugId, c1.lotNo) === whBefore && got2.lines.find((l) => l.id === l1.id).rejectReason === '未事先聯絡' && dbm.db.auditLogs[0].detail.includes('拒收退回 2'),
        '拒收：退回原藥局的同一個批號（帳回到門診藥局），藥庫不入；稽核寫出拒收')
      ok(dbm.db.stockTxns.some((x) => x.ref === rt2.no && x.locationId === 'LOC-OPD' && x.qty === 2 && x.reason?.startsWith('藥庫拒收')), '拒收的帳：門診藥局 transfer-in、原因「藥庫拒收」')
      ok(ledgerBroken(dbm.db).length === 0, '拒收、待報廢後各地點帳本仍對得起來')

      // 待報廢區：不算可用（開藥、撥補、庫存頁選單都看不到）、只能報廢或放回可用
      const qr = dbm.db.stockLocations.find((l) => l.kind === 'quarantine')
      ok(!(await INV2.listStockLocations()).locations.some((l) => l.kind === 'quarantine') && (await INV2.listStockLocations({ includeInactive: true })).locations.some((l) => l.id === qr.id), '庫存頁的地點選單沒有待報廢區（管理清單才列）')
      await expectError(() => INV2.listInventory({ locationId: qr.id }), '把待報廢區當一般地點查庫存')
      await expectError(() => INV2.receiveStock({ reason: '緊急調貨（向鄰近藥局借調）', drugId: c2.drugId, locationId: qr.id, qty: 1, lotNo: 'QR-X', expiry: '2030-01-01' }), '進貨進待報廢區')
      await expectError(() => api.stocktakeApi.createStocktake({ locationId: qr.id, scope: { kind: 'all' } }), '盤點待報廢區')
      await expectError(() => INV2.setLocationRole({ role: 'receiving', locationId: qr.id, confirm: true }), '待報廢區負責採購入庫')
      const whUsable = (await INV2.listInventory({ locationId: 'LOC-WH' })).find((r) => r.id === c2.drugId).usable
      const qrows = await INV2.listQuarantine()
      const q2 = qrows.find((r) => r.drugId === c2.drugId && r.lotNo === c2.lotNo)
      ok(q2?.qty === 2 && q2.ref === rt2.no && !q2.expired, `待報廢區清單：${q2?.drugName} 批號 ${q2?.lotNo} 2（來自 ${rt2.no}）`)
      const totalBefore = dbm.db.drugs.find((d) => d.id === c2.drugId).stock
      try {
        await INV2.releaseQuarantine(q2.lotId, '')
        ok(false, '放回可用沒寫原因應被擋下')
      } catch (e) {
        ok(e.field === 'reason', '放回可用要寫原因')
      }
      const rel = await INV2.releaseQuarantine(q2.lotId, '確認包裝完好')
      ok(rel.qty === 2 && (await INV2.listInventory({ locationId: 'LOC-WH' })).find((r) => r.id === c2.drugId).usable === whUsable + 2 && dbm.db.drugs.find((d) => d.id === c2.drugId).stock === totalBefore, '放回可用：移回藥庫（藥庫可用量 +2、全院總量不變）')
      const exQ = (await INV2.listQuarantine()).find((r) => r.expired)
      if (exQ) {
        await expectError(() => INV2.releaseQuarantine(exQ.lotId, '想放回'), '過期的放回可用')
        const before = dbm.db.drugs.find((d) => d.id === exQ.drugId).stock
        await expectError(() => INV2.scrapQuarantine(exQ.lotId, ' '), '報廢沒寫原因')
        await expectError(() => INV2.scrapQuarantine(exQ.lotId, '過期'), '待報廢區報廢沒有覆核')
        await INV2.scrapQuarantine(exQ.lotId, '過期', await witnessOf({ purpose: 'scrapQuarantine', lotId: exQ.lotId }, 'ph02'))
        ok(dbm.db.drugs.find((d) => d.id === exQ.drugId).stock === before - exQ.qty && !(await INV2.listQuarantine()).some((r) => r.lotId === exQ.lotId) && dbm.db.auditLogs[0].action === '待報廢區報廢' && dbm.db.auditLogs[0].detail.includes('覆核 林雅婷'), `報廢 ${exQ.drugName} ${exQ.qty}：全院總量才扣、寫稽核（含覆核人）`)
        await expectError(() => INV2.scrapQuarantine(exQ.lotId, '再報廢', 'x'), '已報廢完的再報廢')
      }
      await expectError(() => INV2.scrapQuarantine(dbm.db.drugLots.find((l) => l.locationId === 'LOC-WH' && l.qty > 0).id, 'x'), '用待報廢區的報廢扣藥庫的批號')
      ok(ledgerBroken(dbm.db).length === 0, '報廢、放回後帳本仍對得起來')
      // 一般撥補不能選待報廢、拒收
      const wh0 = (await TRA.listTransfers()).find((x) => x.status === 'issued' && x.kind !== 'return')
      if (wh0) await expectError(() => TRA.receiveTransfer(wh0.id, { received: Object.fromEntries(wh0.lines.map((l) => [l.id, (l.lots ?? []).map((x) => x.qty)])), dispositions: { [wh0.lines[0].id]: ['quarantine'] } }), '一般撥補簽收選待報廢')
    }
    // ---- 退回藥庫先申請：藥庫逐批同意、少收、不收；送出才扣，申請後用掉的照現有的少送 ----
    {
      await as('ph01')
      const lotQ = (loc, drugId, lotNo) => dbm.db.drugLots.find((l) => l.locationId === loc && l.drugId === drugId && l.lotNo === lotNo)?.qty ?? 0
      const open = (await TRA.listTransfers()).filter((x) => x.kind === 'return' && ['requested', 'approved'].includes(x.status)).flatMap((x) => x.lines.flatMap((l) => (l.lots ?? []).map((y) => `${l.drugId}|${y.lotNo}`)))
      const cs = (await TRA.returnCandidates('LOC-OPD')).filter((c) => c.qty >= 6 && c.flag !== 'expired' && !open.includes(`${c.drugId}|${c.lotNo}`) && !dbm.db.stocktakes.some((st) => ['counting', 'submitted'].includes(st.status) && st.lines.some((l) => l.drugId === c.drugId)))
      const a = cs[0]
      const b = cs.find((c) => c.drugId !== a.drugId)
      const opd0 = { a: lotQ('LOC-OPD', a.drugId, a.lotNo), b: lotQ('LOC-OPD', b.drugId, b.lotNo) }
      const req = await TRA.returnToWarehouse({ fromLocationId: 'LOC-OPD', reason: '近效期，退回藥庫統一處理', lines: [{ lotId: a.lotId, qty: 4 }, { lotId: b.lotId, qty: 3 }] })
      ok(req.status === 'requested' && lotQ('LOC-OPD', a.drugId, a.lotNo) === opd0.a && req.lines.every((l) => l.lotsOnHand?.length === l.lots.length), '申請：不扣帳，單上看得到每個批號藥局現有多少')
      let d = await api.dashboardApi.getDashboard()
      ok(d.returnToReview >= 1 && d.transferRequested === dbm.db.transfers.filter((x) => x.status === 'requested' && x.kind !== 'return').length, '首頁：退回待藥庫審核另外算（不混進「撥補待撥發」）')
      try {
        await TRA.returnToWarehouse({ fromLocationId: 'LOC-OPD', reason: '再退一次', lines: [{ lotId: a.lotId, qty: 1 }] })
        ok(false, '同一批號已在申請中應被擋下')
      } catch (e) {
        ok(e.fields?.['line-0']?.includes(req.no), `同一批號已在另一張退回申請 → 「${e.fields?.['line-0']}」`)
      }
      await expectError(() => TRA.issueTransfer(req.id, Object.fromEntries(req.lines.map((l) => [l.id, l.qty]))), '退回申請用「撥發」')
      await expectError(() => TRA.shipReturn(req.id), '還沒核准就送出')
      const la = req.lines.find((l) => l.drugId === a.drugId)
      const lb = req.lines.find((l) => l.drugId === b.drugId)
      const errsOf = async (input) => {
        try {
          await TRA.approveReturn(req.id, input)
          return {}
        } catch (e) {
          return e.fields ?? { _: e.message }
        }
      }
      let e1 = await errsOf({ approved: { [la.id]: [5], [lb.id]: [1] } })
      ok(e1[`approve-${la.id}-0`]?.includes('不能多於申請的 4') && e1[`reason-${lb.id}`], '核准：多於申請量、少收沒寫原因，一次標在各列')
      e1 = await errsOf({ approved: { [la.id]: [0], [lb.id]: [0] }, reasons: { [la.id]: 'x', [lb.id]: 'x' } })
      ok(e1._?.includes('不收'), '每一批都是 0 → 請用「不收」')
      const ap = await TRA.approveReturn(req.id, { approved: { [la.id]: [4], [lb.id]: [1] }, reasons: { [lb.id]: '藥庫也滿了，其餘請藥局自行用完' } })
      ok(ap.status === 'approved' && ap.lines.find((l) => l.id === lb.id).declineReason?.includes('藥庫也滿了') && ap.lines.find((l) => l.id === la.id).lots[0].approvedQty === 4 && lotQ('LOC-OPD', a.drugId, a.lotNo) === opd0.a && dbm.db.auditLogs[0].action === '退回藥庫核准',
        '核准：逐批記下同意收多少、少收的原因；仍不扣帳')
      d = await api.dashboardApi.getDashboard()
      ok(d.returnToShip >= 1, '首頁：退回已核准待送出')
      // 核准後照常發藥：a 這批被用掉只剩 2（用盤點模擬）
      await takeStock([a.drugId], (l, lot) => (lot.lotNo === a.lotNo ? 2 : l.bookQty ?? lot.qty), '發藥用掉', 'LOC-OPD')
      ok(lotQ('LOC-OPD', a.drugId, a.lotNo) === 2, `模擬申請後已發掉：${a.lotNo} 只剩 2`)
      const shp = await TRA.shipReturn(req.id)
      const sa = shp.lines.find((l) => l.id === la.id)
      ok(shp.status === 'issued' && sa.issuedQty === 2 && sa.shipNote?.includes('核准 4、只剩 2') && lotQ('LOC-OPD', a.drugId, a.lotNo) === 0 && lotQ('LOC-OPD', b.drugId, b.lotNo) === opd0.b - 1 && dbm.db.auditLogs[0].action === '退回藥庫送出',
        '送出才扣：用掉的照現有的少送（2／核准 4，單上註明）；少收的那批只送同意的 1')
      const recv = Object.fromEntries(shp.lines.map((l) => [l.id, l.lots.map((x) => x.qty)]))
      const done = await TRA.receiveTransfer(shp.id, { received: recv })
      ok(done.status === 'received' && ledgerBroken(dbm.db).length === 0, '藥庫照實送的量簽收；帳本對得起來')

      // 不收：整張退回，藥留在藥局
      const req2 = await TRA.returnToWarehouse({ fromLocationId: 'LOC-OPD', reason: '請領過多', lines: [{ lotId: b.lotId, qty: 1 }] })
      try {
        await TRA.declineReturn(req2.id, ' ')
        ok(false, '不收沒寫原因應被擋下')
      } catch (e) {
        ok(e.field === 'reason', '不收要寫原因')
      }
      const before2 = lotQ('LOC-OPD', b.drugId, b.lotNo)
      const dc = await TRA.declineReturn(req2.id, '近效期請藥局自行用完')
      ok(dc.status === 'cancelled' && dc.cancelReason === '藥庫不收：近效期請藥局自行用完' && lotQ('LOC-OPD', b.drugId, b.lotNo) === before2, '藥庫不收：單子結束、寫原因，藥留在藥局（帳沒動）')
      // 核准後藥局可以取消（還沒送出）
      const req3 = await TRA.returnToWarehouse({ fromLocationId: 'LOC-OPD', reason: '請領過多', lines: [{ lotId: b.lotId, qty: 1 }] })
      await TRA.approveReturn(req3.id, { approved: { [req3.lines[0].id]: [1] } })
      const cc = await TRA.cancelTransfer(req3.id, '病人量變多，自己用')
      ok(cc.status === 'cancelled' && lotQ('LOC-OPD', b.drugId, b.lotNo) === before2, '已核准、還沒送出：藥局可以取消申請')
      // 全部用完：不能送
      const req4 = await TRA.returnToWarehouse({ fromLocationId: 'LOC-OPD', reason: '請領過多', lines: [{ lotId: b.lotId, qty: 1 }] })
      await TRA.approveReturn(req4.id, { approved: { [req4.lines[0].id]: [1] } })
      await takeStock([b.drugId], (l, lot) => (lot.lotNo === b.lotNo ? 0 : l.bookQty ?? lot.qty), '發藥用掉', 'LOC-OPD')
      await expectError(() => TRA.shipReturn(req4.id), '核准的批號全用完了還送出')
      await TRA.cancelTransfer(req4.id, '已用完')
      ok(ledgerBroken(dbm.db).length === 0, '申請、核准、不收、取消都不動帳；帳本對得起來')
    }
    // ---- 庫存地點維護（大型）：新增、改名、停用；三項工作改由哪個地點負責 ----
    {
      const I2 = api.inventoryApi
      const all = async () => (await I2.listStockLocations({ includeInactive: true })).locations
      const loc = async (id) => (await all()).find((l) => l.id === id)
      const wh0 = await loc('LOC-WH')
      ok(wh0.roles.join() === 'receiving' && wh0.blockers.some((b) => b.includes('負責採購入庫')) && wh0.blockers.some((b) => b.includes('種藥的庫存')), `藥庫不能停用：${wh0.blockers.join('；')}`)
      await as('clerk01')
      await expectError(() => I2.saveStockLocation({ name: '急診藥局', kind: 'pharmacy', active: true }), '櫃台新增庫存地點')
      await as('ph01')
      try {
        await I2.saveStockLocation({ name: ' 藥 庫', kind: 'warehouse', active: true })
        ok(false, '同名、第二個藥庫應被擋下')
      } catch (e) {
        ok(e.fields?.name?.includes('已有「藥庫」') && e.fields?.kind?.includes('同時只能有一個藥庫'), `同名（忽略空白）與第二個藥庫一次標出：${Object.values(e.fields ?? {}).join('／')}`)
      }
      try {
        await I2.saveStockLocation({ name: '一二三四五六七八九十十一二', active: true })
        ok(false, '名稱過長、沒選類別應被擋下')
      } catch (e) {
        ok(e.fields?.name?.includes('最多 12 字') && e.fields?.kind, '名稱最多 12 字、新增要選類別')
      }
      const er = await I2.saveStockLocation({ name: '急診藥局', kind: 'pharmacy', active: true })
      ok(er.kind === 'pharmacy' && !er.roles.length && er.drugCount === 0 && !er.blockers.length && dbm.db.auditLogs[0].action === '新增庫存地點', '新增急診藥局：不負責任何工作、沒有庫存（可以停用）、寫稽核')
      ok((await I2.listStockLocations()).locations.length === 4, '庫存頁的地點選單多了一個')
      await expectError(() => I2.saveStockLocation({ id: er.id, name: '急診藥局', kind: 'warehouse', active: true }), '建立後改類別')

      // 門診發藥改由急診藥局：先回 CONFLICT 說明，確認後才改；開藥可用量跟著換地點
      await expectError(() => I2.setLocationRole({ role: 'opd', locationId: 'LOC-WH', confirm: true }), '藥庫負責門診發藥')
      try {
        await I2.setLocationRole({ role: 'opd', locationId: er.id })
        ok(false, '改負責地點應先確認')
      } catch (e) {
        ok(e.code === 'CONFLICT' && e.field === 'confirm' && e.message.includes('改從「急診藥局」扣') && e.message.includes('原本是「門診藥局」'), `改負責地點先說明 → 「${e.message}」`)
      }
      ok((await I2.listStockLocations()).opd === 'LOC-OPD', '沒確認就沒改')
      const mv = await I2.setLocationRole({ role: 'opd', locationId: er.id, confirm: true })
      const m10 = (await api.masterApi.listDrugs({ includeInactive: true })).find((d) => d.id === 'M010')
      ok(mv.from === '門診藥局' && (await I2.listStockLocations()).opd === er.id && m10.usable === 0 && dbm.db.auditLogs[0].detail === '門診發藥：門診藥局 → 急診藥局', '確認後門診發藥改從急診藥局扣：醫師開藥看到的可用量跟著變（急診藥局還沒有貨）、寫稽核')
      ok((await loc('LOC-OPD')).roles.length === 0 && (await loc(er.id)).blockers.some((b) => b.includes('負責門診發藥')), '每項工作同一時間只有一個地點；負責工作的不能停用')
      await expectError(() => I2.setLocationRole({ role: 'opd', locationId: er.id, confirm: true }), '已經負責的再指定一次')
      await I2.setLocationRole({ role: 'opd', locationId: 'LOC-OPD', confirm: true })

      // 改名：單據存地點 id，舊單據顯示新名稱
      const anyTr = dbm.db.transfers.find((x) => x.toLocationId === 'LOC-OPD')
      await I2.saveStockLocation({ id: 'LOC-OPD', name: '門診調劑台', active: true })
      ok((await api.transferApi.getTransfer(anyTr.id)).toName === '門診調劑台' && dbm.db.auditLogs[0].detail === '門診調劑台：門診藥局 → 門診調劑台', '改名：舊撥補單顯示新名稱（地點是院內單位，不是外部對象）；稽核記下前後')
      await I2.saveStockLocation({ id: 'LOC-OPD', name: '門診藥局', active: true })

      // 停用：有工作、有庫存的擋下並一次說明；空的可以停用、再啟用
      try {
        await I2.saveStockLocation({ id: 'LOC-IPD', name: '住院藥局', active: false })
        ok(false, '住院藥局不能停用')
      } catch (e) {
        ok(e.fields?.active?.includes('負責住院調劑與病房常備') && e.fields.active.includes('種藥的庫存'), `有工作、有庫存不能停用 → 「${e.fields?.active}」`)
      }
      await I2.saveStockLocation({ id: er.id, name: '急診藥局', active: false })
      ok(!(await I2.listStockLocations()).locations.some((l) => l.id === er.id) && (await loc(er.id)).active === false, '停用後庫存頁選單不再出現，管理清單仍列出')
      await expectError(() => I2.setLocationRole({ role: 'ipd', locationId: er.id, confirm: true }), '停用的地點負責住院調劑')
      try {
        await I2.saveStockLocation({ name: '急診藥局', kind: 'pharmacy', active: true })
        ok(false, '和停用的同名應擋下')
      } catch (e) {
        ok(e.fields?.name?.includes('已停用，請直接啟用它'), '和停用的地點同名：請直接啟用它')
      }
      await I2.saveStockLocation({ id: er.id, name: '急診藥局', active: true })
      // 有進行中的單據：撥補請領中不能停用（列出單號）
      const trq = await api.transferApi.requestTransfer({ toLocationId: er.id, lines: [{ drugId: 'M001', qty: 1 }] })
      ok((await loc(er.id)).blockers.some((b) => b === '撥補進行中：' + trq.no), '撥補請領中不能停用（列出單號）')
      await api.transferApi.cancelTransfer(trq.id, '測試結束')
      await I2.saveStockLocation({ id: er.id, name: '急診藥局', active: false })
      const { readFileSync } = await import('node:fs')
      const panel = readFileSync('src/pages/drugs/components/LocationPanel.vue', 'utf8')
      ok(panel.includes('l.blockers') && !/db\.|stocktakes|transfers\.filter/.test(panel) && panel.includes("e.field === 'confirm'"), '不能停用的原因由服務層列出（locationBlockers），頁面只顯示；改負責地點走 CONFLICT 確認')
    }
    const dashL = await api.dashboardApi.getDashboard()
    ok(dashL.transferRequested === dbm.db.transfers.filter((x) => x.status === 'requested').length && dashL.transferIssued === 0, '首頁待辦（大型）：撥補待撥發、待簽收')
    ok(!Object.values(api).some((m) => m && typeof m === 'object' && ('inTransit' in m || 'inTransitTo' in m)), '內部查詢（運送中數量）不經 Api 對外')
    resetDb('small')
    ok(dbm.db.hospitalScale === 'small' && dbm.db.stockLocations.filter((l) => l.kind === 'pharmacy' || l.kind === 'warehouse').length === 1, '再重建回小型')
    await as('ph01')
    await expectError(() => api.transferApi.requestTransfer({ toLocationId: 'LOC-PH', lines: [{ drugId: 'M001', qty: 1 }] }), '小型醫院（只有一個藥局）請領')
    await expectError(() => api.transferApi.returnCandidates('LOC-PH'), '小型醫院（只有一個藥局）退回藥庫')
    ok((await api.dashboardApi.getDashboard()).transferRequested === undefined, '小型醫院首頁沒有撥補待辦')
    // 小型醫院也能加藥庫：加了之後就能撥補（藥庫負責採購入庫、撥給藥局）
    {
      const wh = await api.inventoryApi.saveStockLocation({ name: '藥庫', kind: 'warehouse', active: true })
      ok(Array.isArray(await api.transferApi.transferCandidates('LOC-PH')) && (await api.inventoryApi.listStockLocations()).locations.length === 2, '小型醫院新增藥庫後可以請領（不再說只有一個藥局）')
      await expectError(() => api.inventoryApi.setLocationRole({ role: 'ipd', locationId: wh.id, confirm: true }), '藥庫負責住院調劑')
      await api.inventoryApi.saveStockLocation({ id: wh.id, name: '藥庫', active: false })
      await expectError(() => api.transferApi.transferCandidates('LOC-PH'), '藥庫停用後請領')
    }
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
