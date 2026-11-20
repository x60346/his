// 植入物批號登記與追溯：手術室收貨（品項、批號、效期、數量；權限「供應中心」）→ 手術中流動護理師登記用了哪一批、幾個、植入部位
// （術式不會用到、召回、過期、不夠的擋；自費品項要病房先記錄病人同意）→ 會放植入物的手術完成前至少一筆（surgery.finishSurgery）
// → 用掉的進住院帳單（surgery-work.surgeryFeeItems）→ 廠商召回整批：列出用過的手術與病人，逐台記錄已通知主刀。規則在 implant-rules
import type { ImplantLot } from '@/types'
import { db, newId } from '@/mock/db'
import { addDays, now, today } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, permissionsOf, query, requirePermission, requireUser } from './http'
import { checkImplantUse, checkLotInput, IMPLANT_FOR, implantUseProblem, lotLeft, lotState, LOT_STATE_LABEL, type LotState } from './implant-rules'
import { isSelfPayImplant, lotOf, lotSurgeries, usedOf } from './implant-work'
import { requireImplantPreAuth } from './preauth-work'
import { surgeryOf, surgeryView, type SurgeryView } from './surgery-work'
import { find, nameOf } from './views'

const isImplant = (id: string) => !!find.procedure(id)?.implant
const audS = (s: { no: string; patientId: string }) => `${s.no} ${nameOf.patient(s.patientId)}`

export interface LotItem {
  id: string
  procId: string
  name: string
  vendor: string
  selfPay: boolean
  lot: string
  expiresOn: string
  qty: number
  left: number
  state: LotState
  stateLabel: string
  /** 30 天內到期 */
  expiring: boolean
  receivedText: string
}
export interface LotRecallItem {
  lotId: string
  name: string
  lot: string
  reason: string
  recalledText: string
  /** 還在架上的（要退回廠商） */
  left: number
  affected: { surgeryId: string; no: string; patientName: string; chartNo: string; procName: string; doctorName: string; date: string; qty: number; site: string; notified?: string }[]
}
export interface ImplantBoard {
  canManage: boolean
  items: { id: string; name: string; vendor: string; selfPay: boolean; available: number }[]
  lots: LotItem[]
  recalls: LotRecallItem[]
}

function lotItem(l: ImplantLot, d: string): LotItem {
  const p = find.procedure(l.procId)
  const used = usedOf(l.id)
  const st = lotState(l, used, d)
  return {
    id: l.id, procId: l.procId, name: p?.name ?? l.procId, vendor: p?.implant?.vendor ?? '', selfPay: isSelfPayImplant(p), lot: l.lot, expiresOn: l.expiresOn, qty: l.qty, left: lotLeft(l, used),
    state: st, stateLabel: LOT_STATE_LABEL[st], expiring: st === 'available' && l.expiresOn <= addDays(d, 30), receivedText: `${l.receivedAt.slice(5)} ${nameOf.user(l.receivedBy)}`,
  }
}

function recallItem(l: ImplantLot): LotRecallItem {
  return {
    lotId: l.id, name: find.procedure(l.procId)?.name ?? '', lot: l.lot, reason: l.recall!.reason, recalledText: `${l.recall!.at.slice(5)} ${nameOf.user(l.recall!.by)}`, left: lotLeft(l, usedOf(l.id)),
    affected: lotSurgeries(l.id).map((s) => {
      const us = (s.implants ?? []).filter((u) => u.lotId === l.id)
      const n = l.recall!.notified.find((x) => x.surgeryId === s.id)
      return {
        surgeryId: s.id, no: s.no, patientName: nameOf.patient(s.patientId), chartNo: find.patient(s.patientId)?.chartNo ?? '', procName: find.procedure(s.procId)?.name ?? '', doctorName: nameOf.doctor(s.doctorId),
        date: (s.endAt ?? us[0].at).slice(0, 10), qty: us.reduce((a, u) => a + u.qty, 0), site: us.map((u) => u.site).join('、'),
        ...(n ? { notified: `${nameOf.user(n.by)} ${n.at.slice(5)}：${n.note}` } : {}),
      }
    }),
  }
}

export function implantBoard(): Promise<ImplantBoard> {
  return query(() => {
    const u = requireUser('nurse', 'admin')
    const d = today()
    const lots = db.implantLots.map((l) => lotItem(l, d))
    return {
      canManage: permissionsOf(u).includes('cssd'),
      items: db.procedures.filter((p) => p.implant && p.active).map((p) => ({ id: p.id, name: p.name, vendor: p.implant!.vendor, selfPay: isSelfPayImplant(p), available: lots.filter((l) => l.procId === p.id && l.state === 'available').reduce((n, l) => n + l.left, 0) })),
      // 可用的在前（先到期的先用），用完、過期、召回的在後
      lots: lots.sort((a, b) => Number(a.state !== 'available') - Number(b.state !== 'available') || a.expiresOn.localeCompare(b.expiresOn)),
      recalls: db.implantLots.filter((l) => l.recall).sort((a, b) => b.recall!.at.localeCompare(a.recall!.at)).map(recallItem),
    }
  })
}

/** 收貨（供應中心）：品項、批號、效期、數量；同品項同批號不能重複收（加量請另收一筆不同批號） */
export function receiveLot(input: { procId: string; lot: string; expiresOn: string; qty: number }): Promise<LotItem> {
  return mutate(() => {
    const u = requirePermission('cssd')
    const d = today()
    failFields(checkLotInput(input, d, isImplant))
    const lot = input.lot.trim().toUpperCase()
    if (db.implantLots.some((l) => l.procId === input.procId && l.lot === lot)) failField('lot', '這個品項的這個批號已經收過了')
    const l: ImplantLot = { id: newId('IL'), procId: input.procId, lot, expiresOn: input.expiresOn, qty: Number(input.qty), receivedAt: now(), receivedBy: u.id }
    db.implantLots.push(l)
    audit('植入物收貨', `${find.procedure(l.procId)?.name ?? ''} 批號 ${lot} × ${l.qty}（效期 ${l.expiresOn}）`)
    return lotItem(l, d)
  })
}

/** 廠商召回整批（供應中心）：寫原因；架上的不能再用，用過的列出來逐台通知 */
export function recallLot(lotId: string, reason: string): Promise<LotRecallItem> {
  return mutate(() => {
    const u = requirePermission('cssd')
    const l = must(lotOf(lotId), '植入物批號')
    if (l.recall) fail('這批已經召回了', 'CONFLICT')
    if (!reason?.trim()) failField('reason', '請寫召回原因（廠商通知內容）')
    l.recall = { at: now(), by: u.id, reason: reason.trim(), notified: [] }
    audit('植入物召回', `${find.procedure(l.procId)?.name ?? ''} 批號 ${l.lot}：${reason.trim()}（用在 ${lotSurgeries(l.id).length} 台手術）`)
    return recallItem(l)
  })
}

/** 召回：用過的那台已通知主刀（寫怎麼通知、後續處理） */
export function notifyLotRecall(lotId: string, surgeryId: string, note: string): Promise<LotRecallItem> {
  return mutate(() => {
    const u = requirePermission('cssd')
    const l = must(lotOf(lotId), '植入物批號')
    if (!l.recall) fail('這批沒有召回', 'CONFLICT')
    const s = surgeryOf(surgeryId)
    if (!s || !(s.implants ?? []).some((x) => x.lotId === l.id)) fail('這台手術沒有用到這批', 'CONFLICT')
    if (l.recall!.notified.some((x) => x.surgeryId === surgeryId)) fail('這台已經記過通知了', 'CONFLICT')
    if (!note?.trim()) failField('note', '請寫通知了誰、後續怎麼處理（例：已電話通知主刀，門診追蹤 X 光）')
    l.recall!.notified.push({ surgeryId, at: now(), by: u.id, note: note.trim() })
    audit('植入物召回通知', `批號 ${l.lot} → ${audS(s!)}：${note.trim()}`)
    return recallItem(l)
  })
}

export interface ImplantOption {
  lotId: string
  label: string
  selfPay: boolean
  left: number
}
/** 這台可以選的批（術式會用到的品項、可用的批，先到期的在前） */
export function implantOptions(surgeryId: string): Promise<{ options: ImplantOption[]; consent: boolean }> {
  return query(() => {
    requireUser('nurse', 'doctor', 'admin')
    const s = must(surgeryOf(surgeryId), '手術')
    const d = today()
    const ids = IMPLANT_FOR[s.procId] ?? []
    return {
      consent: !!s.selfPayImplant,
      options: db.implantLots.filter((l) => ids.includes(l.procId) && lotState(l, usedOf(l.id), d) === 'available').sort((a, b) => a.procId.localeCompare(b.procId) || a.expiresOn.localeCompare(b.expiresOn)).map((l) => {
        const p = find.procedure(l.procId)
        const left = lotLeft(l, usedOf(l.id))
        return { lotId: l.id, label: `${p?.name ?? ''}・批號 ${l.lot}・效期 ${l.expiresOn}・剩 ${left}`, selfPay: isSelfPayImplant(p), left }
      }),
    }
  })
}

/** 登記植入物（流動護理師；已送到手術室或手術中） */
export function useImplant(surgeryId: string, input: { lotId: string; qty: number; site: string }): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(surgeryOf(surgeryId), '手術')
    if (s.status !== 'sent' && s.status !== 'in-progress') fail(s.status === 'done' ? '手術已完成，植入物不能再改' : '病人送到手術室後才能登記植入物', 'CONFLICT')
    failFields(checkImplantUse(input))
    const l = lotOf(input.lotId)
    if (!l) failField('lotId', '找不到這批植入物')
    const p = find.procedure(l!.procId)
    const why = implantUseProblem({ surgeryProcId: s.procId, implantProcId: l!.procId, selfPay: isSelfPayImplant(p), consent: !!s.selfPayImplant, qty: Number(input.qty) }, l!, usedOf(l!.id), today())
    if (why) failField('lotId', `${p?.name ?? ''} 批號 ${l!.lot}：${why}`)
    // 需健保事前審查的特殊材料：核准前不能用（自費、緊急除外）
    requireImplantPreAuth(s.id, l!.procId)
    s.implants = [...(s.implants ?? []), { id: newId('IU'), lotId: l!.id, qty: Number(input.qty), site: input.site.trim(), at: now(), by: u.id }]
    audit('使用植入物', `${audS(s)}：${p?.name ?? ''} 批號 ${l!.lot} × ${input.qty}（${input.site.trim()}）`)
    return surgeryView(s)
  })
}

/** 登記錯了拿掉（手術完成前） */
export function removeImplant(surgeryId: string, useId: string): Promise<SurgeryView> {
  return mutate(() => {
    requireUser('nurse')
    const s = must(surgeryOf(surgeryId), '手術')
    if (s.status !== 'sent' && s.status !== 'in-progress') fail('手術已完成，植入物不能再改', 'CONFLICT')
    const x = must((s.implants ?? []).find((u) => u.id === useId), '這台的植入物')
    s.implants = s.implants!.filter((u) => u.id !== useId)
    audit('植入物取消登記', `${audS(s)}：批號 ${lotOf(x.lotId)?.lot ?? ''} × ${x.qty}`)
    return surgeryView(s)
  })
}

/** 病人（或家屬）同意使用自費植入物（病房護理師；手術完成前） */
export function consentSelfPayImplant(surgeryId: string, note?: string): Promise<SurgeryView> {
  return mutate(() => {
    const u = requireUser('nurse')
    const s = must(surgeryOf(surgeryId), '手術')
    if (!(IMPLANT_FOR[s.procId] ?? []).some((id) => isSelfPayImplant(find.procedure(id)))) fail('這個術式沒有自費植入物', 'CONFLICT')
    if (s.status === 'done' || s.status === 'cancelled') fail('手術已完成或取消', 'CONFLICT')
    if (s.selfPayImplant) fail('已經記錄過同意了', 'CONFLICT')
    s.selfPayImplant = { by: u.id, at: now(), ...(note?.trim() ? { note: note.trim() } : {}) }
    audit('自費植入物同意', `${audS(s)}${note?.trim() ? `：${note.trim()}` : ''}`)
    return surgeryView(s)
  })
}
