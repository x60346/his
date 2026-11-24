// 器械包與滅菌（供應中心）：登記滅菌鍋次（化學指示劑合格）→ 24 小時後判讀生物指示劑（陰性放行、陽性整鍋召回）→
// 手術中護理師掃包號綁到手術（過期、召回、用過的擋；會放植入物的手術要等生物指示劑陰性）→ 召回時沒用的收回、用過的逐台通知主刀與感控。
// 規則在 sterile-rules；手術完成前要有器械包（surgery.finishSurgery）
import type { InstrumentPack, PackSet, SterileBatch } from '@/types'
import { db, newId, nextCounter } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser } from './http'
import { biDueAt, biText, checkBatchInput, expiresOnOf, packState, packStock, packUseProblem, PACK_SET_LABEL, PACK_SETS, type PackState } from './sterile-rules'
import { surgeryOf, surgeryView, type SurgeryView } from './surgery-work'
import { find, nameOf } from './views'

import { batchOf } from './sterile-work'
const packByNo = (no: string) => db.instrumentPacks.find((p) => p.no === no.trim().toUpperCase())
const implantOf = (procId: string) => !!find.procedure(procId)?.surgery?.implant

export interface BatchItem {
  id: string
  no: string
  sterilizer: string
  at: string
  byName: string
  /** 「基本手術包 2、小手術包 2」 */
  contents: string
  packCount: number
  biState: 'pending' | 'due' | 'negative' | 'positive'
  biText: string
  biByName?: string
}
export interface RecallItem {
  batchId: string
  batchNo: string
  recalledAt: string
  /** 還在架上、沒收回的（要收回） */
  toWithdraw: { id: string; no: string; setLabel: string }[]
  /** 用過的：哪台手術、哪位病人；已通知主刀與感控的寫誰、說明 */
  affected: { surgeryId: string; no: string; patientName: string; chartNo: string; procName: string; doctorName: string; usedAt: string; packNo: string; notified?: string }[]
}
export interface SterileBoard {
  /** 有「供應中心」權限（登記、判讀、召回、收回） */
  canManage: boolean
  stock: ReturnType<typeof packStock>
  /** 最近 7 天、或生物指示劑還沒判讀的鍋次（新到舊） */
  batches: BatchItem[]
  recalls: RecallItem[]
  /** 過期還在架上的（要收回重新滅菌） */
  expired: { id: string; no: string; setLabel: string; expiresOn: string; batchNo: string }[]
}

function batchItem(b: SterileBatch, t: string): BatchItem {
  const packs = db.instrumentPacks.filter((p) => p.batchId === b.id)
  return {
    id: b.id, no: b.no, sterilizer: b.sterilizer, at: b.at, byName: nameOf.user(b.by),
    contents: PACK_SETS.map((s) => [s, packs.filter((p) => p.set === s).length] as const).filter(([, n]) => n).map(([s, n]) => `${PACK_SET_LABEL[s]} ${n}`).join('、'),
    packCount: packs.length,
    biState: b.bi ? b.bi.result : biDueAt(b) <= t ? 'due' : 'pending', biText: biText(b, t),
    ...(b.bi ? { biByName: `${nameOf.user(b.bi.by)} ${b.bi.at.slice(5).replace('-', '/')}` } : {}),
  }
}

function recallItem(b: SterileBatch): RecallItem {
  const packs = db.instrumentPacks.filter((p) => p.batchId === b.id)
  return {
    batchId: b.id, batchNo: b.no, recalledAt: b.recall!.at,
    toWithdraw: packs.filter((p) => !p.used && !p.withdrawn).map((p) => ({ id: p.id, no: p.no, setLabel: PACK_SET_LABEL[p.set] })),
    affected: packs.filter((p) => p.used).map((p) => {
      const s = surgeryOf(p.used!.surgeryId)
      const n = b.recall!.notified.find((x) => x.surgeryId === p.used!.surgeryId)
      return {
        surgeryId: p.used!.surgeryId, no: s?.no ?? '', patientName: s ? nameOf.patient(s.patientId) : '', chartNo: s ? (find.patient(s.patientId)?.chartNo ?? '') : '',
        procName: s ? (find.procedure(s.procId)?.name ?? '') : '', doctorName: s ? nameOf.doctor(s.doctorId) : '', usedAt: p.used!.at, packNo: p.no,
        ...(n ? { notified: `${nameOf.user(n.by)} ${n.at.slice(5).replace('-', '/')}：${n.note}` } : {}),
      }
    }),
  }
}

export function sterileBoard(): Promise<SterileBoard> {
  return query(() => {
    const u = requireUser('nurse', 'admin')
    const t = now()
    const d = today()
    const from = `${addDays(d, -6)} 00:00`
    return {
      canManage: permissionsOf(u).includes('cssd'),
      stock: packStock(db.instrumentPacks, batchOf, d),
      batches: db.sterileBatches.filter((b) => b.at >= from || !b.bi).sort((x, y) => y.at.localeCompare(x.at)).map((b) => batchItem(b, t)),
      recalls: db.sterileBatches.filter((b) => b.recall).sort((x, y) => y.recall!.at.localeCompare(x.recall!.at)).map(recallItem),
      expired: db.instrumentPacks.filter((p) => packState(p, batchOf(p.batchId), d) === 'expired').map((p) => ({ id: p.id, no: p.no, setLabel: PACK_SET_LABEL[p.set], expiresOn: p.expiresOn, batchNo: batchOf(p.batchId)?.no ?? '' })),
    }
  })
}

/** 登記一鍋（供應中心）：滅菌鍋、化學指示劑合格、每種幾包 → 產生包號（效期滅菌後 30 天） */
export function registerBatch(input: { sterilizer: string; ciPass: boolean; packs: Partial<Record<PackSet, number>> }): Promise<{ batch: BatchItem; packNos: string[] }> {
  return mutate(() => {
    const u = requirePermission('cssd')
    failFields(checkBatchInput(input))
    const t = now()
    const ymd = t.slice(0, 10).replace(/-/g, '')
    const b: SterileBatch = { id: newId('SB'), no: `${input.sterilizer}-${ymd}-${nextCounter(`sterile:${input.sterilizer}:${ymd}`)}`, sterilizer: input.sterilizer, at: t, by: u.id }
    db.sterileBatches.push(b)
    const nos: string[] = []
    for (const set of PACK_SETS) {
      for (let i = 0; i < Number(input.packs[set] ?? 0); i++) {
        const p: InstrumentPack = { id: newId('PK'), no: `PK${String(nextCounter('pack')).padStart(5, '0')}`, set, batchId: b.id, expiresOn: expiresOnOf(t) }
        db.instrumentPacks.push(p)
        nos.push(p.no)
      }
    }
    audit('滅菌鍋次', `${b.no}：${nos.length} 包（${nos[0]}–${nos.at(-1)}），化學指示劑合格`)
    return { batch: batchItem(b, t), packNos: nos }
  })
}

/** 判讀生物指示劑（培養 24 小時後）：陰性放行；陽性＝整鍋召回（沒用的收回、用過的追蹤） */
export function recordBi(batchId: string, result: 'negative' | 'positive'): Promise<BatchItem> {
  return mutate(() => {
    const u = requirePermission('cssd')
    const b = must(batchOf(batchId), '滅菌鍋次')
    if (b.bi) fail('這鍋已經判讀過了', 'CONFLICT')
    if (result !== 'negative' && result !== 'positive') failField('result', '請選陰性或陽性')
    const t = now()
    if (biDueAt(b) > t) fail(`培養還不到 24 小時（${biDueAt(b).slice(5).replace('-', '/')} 才能判讀）`, 'CONFLICT')
    b.bi = { result, at: t, by: u.id }
    if (result === 'positive') b.recall = { at: t, by: u.id, notified: [] }
    const used = db.instrumentPacks.filter((p) => p.batchId === b.id && p.used).length
    audit(result === 'positive' ? '滅菌召回' : '生物指示劑陰性', `${b.no}${result === 'positive' ? `：生物指示劑陽性，整鍋召回（已用在 ${used} 台手術）` : ''}`)
    return batchItem(b, t)
  })
}

/** 召回：用過的那台手術已通知主刀與感控（寫怎麼通知、後續處理） */
export function notifyRecall(batchId: string, surgeryId: string, note: string): Promise<RecallItem> {
  return mutate(() => {
    const u = requirePermission('cssd')
    const b = must(batchOf(batchId), '滅菌鍋次')
    if (!b.recall) fail('這鍋沒有召回', 'CONFLICT')
    if (!db.instrumentPacks.some((p) => p.batchId === b.id && p.used?.surgeryId === surgeryId)) fail('這台手術沒有用到這鍋的器械包', 'CONFLICT')
    if (b.recall!.notified.some((x) => x.surgeryId === surgeryId)) fail('這台已經記過通知了', 'CONFLICT')
    if (!note?.trim()) failField('note', '請寫通知了誰、後續怎麼處理（例：已電話通知主刀與感控，追蹤傷口感染）')
    b.recall!.notified.push({ surgeryId, at: now(), by: u.id, note: note.trim() })
    const s = surgeryOf(surgeryId)
    audit('滅菌召回通知', `${b.no} → ${s?.no ?? surgeryId} ${s ? nameOf.patient(s.patientId) : ''}：${note.trim()}`)
    return recallItem(b)
  })
}

/** 收回（還沒用的）：過期要重新滅菌、召回；寫原因 */
export function withdrawPack(packId: string, reason: string): Promise<{ no: string; state: PackState }> {
  return mutate(() => {
    const u = requirePermission('cssd')
    const p = must(db.instrumentPacks.find((x) => x.id === packId), '器械包')
    if (p.used) fail('這包已經用在手術上，不能收回', 'CONFLICT')
    if (p.withdrawn) fail('已經收回了', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫原因（過期重新滅菌、召回）')
    p.withdrawn = { at: now(), by: u.id, reason: reason.trim() }
    audit('器械包收回', `${p.no} ${PACK_SET_LABEL[p.set]}（${batchOf(p.batchId)?.no ?? ''}）：${reason.trim()}`)
    return { no: p.no, state: 'withdrawn' as PackState }
  })
}

// ---------- 手術中：掃描器械包 ----------

/** 掃包號（護理師；已送到手術室或手術中）：過期、召回、用過、收回的擋；會放植入物的手術要生物指示劑陰性 */
export function scanPack(surgeryId: string, packNo: string): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(surgeryOf(surgeryId), '手術')
    if (s.status !== 'sent' && s.status !== 'in-progress') fail(s.status === 'done' ? '手術已完成，器械包不能再改' : '病人送到手術室後才能掃器械包', 'CONFLICT')
    if (!packNo?.trim()) failField('packNo', '請掃描或輸入包號')
    const p = packByNo(packNo)
    if (!p) failField('packNo', `找不到包號 ${packNo.trim()}`)
    if (p!.used?.surgeryId === s.id) failField('packNo', '這台已經掃過這包了')
    const t = now()
    const why = packUseProblem(p!, batchOf(p!.batchId), today(), t, implantOf(s.procId))
    if (why) failField('packNo', `${p!.no} ${PACK_SET_LABEL[p!.set]}：${why}`)
    p!.used = { surgeryId: s.id, at: t, by: u.id }
    audit('使用器械包', `${s.no} ${nameOf.patient(s.patientId)}：${p!.no} ${PACK_SET_LABEL[p!.set]}（${batchOf(p!.batchId)?.no ?? ''}）`)
    return surgeryView(s)
  })
}

/** 掃錯了拿掉（手術完成前）：包回到架上 */
export function unscanPack(surgeryId: string, packId: string): Promise<SurgeryView> {
  return mutate(() => {
    requireUser('nurse')
    const s = must(surgeryOf(surgeryId), '手術')
    if (s.status !== 'sent' && s.status !== 'in-progress') fail('手術已完成，器械包不能再改', 'CONFLICT')
    const p = must(db.instrumentPacks.find((x) => x.id === packId && x.used?.surgeryId === s.id), '這台的器械包')
    delete p.used
    audit('器械包取消掃描', `${s.no} ${nameOf.patient(s.patientId)}：${p.no}`)
    return surgeryView(s)
  })
}

