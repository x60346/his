// 術後醫囑：手術完成後主刀（或本科醫師）開術後醫囑——套用綁術式的組套（個人的、科室共用的），或沿用術前醫囑（寫原因）；
// 術前開的禁食醫囑一起處理：停掉或保留（組套裡有長期飲食醫囑就會取代禁食，不能保留）。
// 不擋任何事（小手術可能沿用術前醫囑）；手術完成 4 小時還沒開，主刀首頁標紅（surgery-work.postopCounts）。
// 套用時每一項都走住院醫囑同一份建立與檢查（ipd.createOrderInternal）：停用、過敏、重複、劑量、交互作用；
// 預覽先逐項列出要確認的與不能套的（管制性抗生素要填理由、嚴重交互作用要寫原因 → 請個別開立）
import type { IpdOrder, PostopItem, PostopSet, Surgery } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failField, failFields, must, mutate, query, requirePermission, requireUser, type Actor } from './http'
import { find, nameOf } from './views'
import { surgeryOf } from './surgery-work'
import { careRoleOf, requireCare } from './care-team'
import { createOrderInternal, activeSameDrug } from './ipd'
import { checkAllergies } from './allergy'
import { doseLevel, doseNote } from './dose-rules'
import { licenseProblem, needsSpecialRx, CONTROLLED_LEVEL_LABEL } from './controlled-rules'
import { checkRxAlerts } from './interaction-rules'
import { drugRefs, ipdInUse } from './rx-alert-work'
import { renalAlertOf } from './renal-work'
import { doseUnitOf } from './billing'
import { DIET_KINDS, dietOf } from './nutrition-rules'
import { SIDE_LABEL } from './surgery-rules'

function me(): Actor & { doctorId: string; deptId: string } {
  const u = requireUser('doctor')
  if (!u.doctorId) fail('此帳號沒有對應的醫師資料', 'FORBIDDEN')
  return { ...u, doctorId: u.doctorId!, deptId: must(find.doctor(u.doctorId!), '醫師').deptId }
}
/** 看得到（也就能改）：自己的個人組套、目前所屬科別的科室組套 */
const canUseSet = (s: PostopSet, m: { doctorId: string; deptId: string }) => (s.scope === 'dept' ? s.deptId === m.deptId : s.doctorId === m.doctorId)

export const postopItemText = (it: PostopItem): string => {
  const head = it.type === 'long' ? '長期' : '臨時'
  if (it.category === 'medication') {
    const d = find.drug(it.drugId ?? '')
    return `${head}・${d?.name ?? it.content} ${it.dose ?? ''} ${d ? doseUnitOf(d) : ''} ${it.freq ?? ''} ${it.route ?? ''}`.replace(/\s+/g, ' ').trim()
  }
  if (it.category === 'diet') return `${head}・飲食：${DIET_KINDS.find((k) => k.kind === it.diet?.kind)?.label ?? it.content}${it.diet?.note ? `（${it.diet.note}）` : ''}`
  return `${head}・${it.category === 'procedure' ? find.procedure(it.procId ?? '')?.name ?? it.content : it.content}`
}

export interface PostopSetView extends PostopSet {
  procName: string
  deptName?: string
  updatedByName?: string
  itemTexts: string[]
  mine: boolean
}
const setView = (s: PostopSet, m: { doctorId: string }): PostopSetView => ({
  ...s, procName: find.procedure(s.procId)?.name ?? s.procId, itemTexts: s.items.map(postopItemText), mine: s.doctorId === m.doctorId,
  ...(s.scope === 'dept' ? { deptName: nameOf.dept(s.deptId ?? ''), updatedByName: nameOf.doctor(s.updatedBy ?? s.doctorId) } : {}),
})

const activeNpo = (admissionId: string) => db.ipdOrders.filter((o) => o.admissionId === admissionId && o.category === 'diet' && o.status === 'active' && dietOf(o).kind === 'npo')

export interface PostopPlan {
  surgeryId: string
  procName: string
  patientName: string
  /** 已開（套用組套或沿用）：「11-19 15:20 林子謙 套用『疝氣修補術後』3 項；禁食停止」 */
  doneText?: string
  /** 可以開：手術完成、住院中、本科醫師、還沒開 */
  canWrite: boolean
  sets: PostopSetView[]
  /** 執行中的禁食醫囑（要決定停或保留） */
  npoOrders: { id: string; text: string }[]
  /** 存成組套可以選的：這次住院執行中的醫囑（點滴、升壓劑、呼吸器、排程檢驗不能存） */
  orderOptions: { id: string; text: string }[]
}

const doneText = (s: Surgery) => {
  const p = s.postop!
  return `${p.at.slice(5).replace('-', '/')} ${nameOf.user(p.by)}${p.setName ? ` 套用「${p.setName}」${p.orderIds.length} 項` : '：沿用術前醫囑'}${p.note ? `（${p.note}）` : ''}${p.npoStopped.length ? '；禁食停止' : ''}${p.npoKept.length ? '；禁食保留' : ''}`
}
const savable = (o: IpdOrder) => !o.infusion && !o.vent && !o.labSchedule && !o.codeBlueId && !o.isolationId && !(o.category === 'diet' && o.diet?.kind === 'tube')

export function postopPlan(surgeryId: string): Promise<PostopPlan> {
  return query(() => {
    const u = requireUser('doctor', 'nurse', 'admin')
    const s = must(surgeryOf(surgeryId), '手術')
    const a = must(find.admission(s.admissionId), '住院紀錄')
    const doctor = u.role === 'doctor' && u.doctorId ? me() : undefined
    const team = doctor && careRoleOf(doctor.doctorId, a)?.kind === 'team'
    return {
      surgeryId: s.id, procName: find.procedure(s.procId)?.name ?? '', patientName: nameOf.patient(s.patientId),
      ...(s.postop ? { doneText: doneText(s) } : {}),
      canWrite: !!team && s.status === 'done' && a.status === 'admitted' && !s.postop,
      sets: doctor ? db.postopSets.filter((x) => x.procId === s.procId && canUseSet(x, doctor)).map((x) => setView(x, doctor)).sort((x, y) => (x.scope === y.scope ? x.name.localeCompare(y.name) : x.scope === 'personal' ? -1 : 1)) : [],
      npoOrders: activeNpo(a.id).map((o) => ({ id: o.id, text: `${o.content}（${o.startAt.slice(5).replace('-', '/')} 起）` })),
      orderOptions: db.ipdOrders.filter((o) => o.admissionId === a.id && o.status === 'active' && savable(o)).map((o) => ({ id: o.id, text: `${o.type === 'long' ? '長期' : '臨時'}・${o.content}${o.dose ? ` ${o.dose}` : ''}${o.freq ? ` ${o.freq}` : ''}${o.route ? ` ${o.route}` : ''}` })),
    }
  })
}

export interface PostopPreviewItem {
  idx: number
  text: string
  /** ok：直接套；confirm：要醫師確認（過敏、重複、劑量偏高、交互作用、腎功能）；blocked：不能套，請個別開立 */
  status: 'ok' | 'confirm' | 'blocked'
  notes: string[]
}

/** 一項組套在這位病人身上的檢查（只列出來，真正擋的是 createOrderInternal） */
function previewItem(it: PostopItem, s: Surgery, doctorId: string, t: string, idx: number): PostopPreviewItem & { rxKeys: string[] } {
  const notes: string[] = []
  let blocked = false
  let rxKeys: string[] = []
  const block = (x: string) => {
    blocked = true
    notes.push(x)
  }
  if (it.category === 'medication') {
    const d = find.drug(it.drugId ?? '')
    if (!d) block('找不到這個藥')
    else if (!d.active) block(`${d.name} 已停用`)
    else if (d.pca || d.vaso || d.crash) block(`${d.name} 要在專用的分頁開立`)
    else {
      if (d.restrictedAbx) block('管制性抗生素要填使用理由與感染部位，請個別開立')
      if (needsSpecialRx(d.controlled)) {
        const why = licenseProblem(find.doctor(doctorId)?.controlledLicense, t.slice(0, 10))
        if (why) block(`${CONTROLLED_LEVEL_LABEL[d.controlled!]}管制藥：${why}`)
      }
      const al = checkAllergies(find.patient(s.patientId)?.allergies ?? [], [d])
      if (al.length) notes.push(`病人對 ${al.map((x) => x.allergen).join('、')} 過敏`)
      const dup = activeSameDrug(s.admissionId, d.id)
      if (dup.length) notes.push(`已有執行中的 ${d.name}（${dup.map((o) => `${o.dose ?? ''} ${o.freq ?? ''}`.trim()).join('、')}）`)
      const lv = doseLevel(d, Number(it.dose))
      if (lv === 'absurd') block(doseNote(d, Number(it.dose)))
      else if (lv === 'high') notes.push(`劑量偏高：${doseNote(d, Number(it.dose))}`)
      const rx = checkRxAlerts(drugRefs([d.id]), ipdInUse(s.admissionId, d.id))
      if (rx.some((x) => x.level === 'severe')) block(`嚴重交互作用（${rx.filter((x) => x.level === 'severe').map((x) => x.title).join('、')}）要寫原因，請個別開立`)
      else if (rx.length) notes.push(...rx.map((x) => x.title))
      rxKeys = rx.map((x) => x.key)
      const renal = renalAlertOf({ id: '', admissionId: s.admissionId, type: it.type, category: 'medication', drugId: d.id, content: d.name, freq: it.freq, status: 'active', startAt: t, doctorId, createdAt: t } as IpdOrder, t)
      if (renal) notes.push(`腎功能：${renal}`)
    }
  } else if (it.category === 'procedure') {
    const p = find.procedure(it.procId ?? '')
    if (!p?.active) block(`${p?.name ?? '醫令'} 已停用`)
  }
  return { idx, text: postopItemText(it), status: blocked ? 'blocked' : notes.length ? 'confirm' : 'ok', notes, rxKeys }
}

function writable(surgeryId: string) {
  const m = me()
  requirePermission('order.write')
  const s = must(surgeryOf(surgeryId), '手術')
  const a = must(find.admission(s.admissionId), '住院紀錄')
  requireCare(m.doctorId, a, '開術後醫囑', { consult: false })
  if (s.status !== 'done') fail('手術完成後才能開術後醫囑', 'CONFLICT')
  if (a.status !== 'admitted') fail('病人已經不在住院中', 'CONFLICT')
  return { m, s, a }
}
const setOf = (id: string, m: { doctorId: string; deptId: string }, procId?: string) => {
  const x = must(db.postopSets.find((y) => y.id === id), '組套')
  if (!canUseSet(x, m)) fail(x.scope === 'dept' ? '這是別科的科室組套' : '這不是您的組套', 'FORBIDDEN')
  if (procId && x.procId !== procId) fail('這個組套不是這個術式的', 'CONFLICT')
  return x
}

/** 套用前預覽：逐項列出要確認的、不能套的 */
export function postopPreview(surgeryId: string, setId: string): Promise<PostopPreviewItem[]> {
  return query(() => {
    const { m, s } = writable(surgeryId)
    const set = setOf(setId, m, s.procId)
    const t = now()
    return set.items.map((it, i) => (({ rxKeys: _k, ...x }) => x)(previewItem(it, s, m.doctorId, t, i)))
  })
}

export interface ApplyPostopInput {
  /** 沒有＝沿用術前醫囑（要寫原因） */
  setId?: string
  /** 要套的項目（組套裡的第幾項）；不能套的不能選 */
  items?: number[]
  /** 醫師確認過的（要確認的項目都要在這裡） */
  confirmed?: number[]
  /** 每一筆執行中的禁食醫囑：停或保留 */
  npo: Record<string, 'stop' | 'keep'>
  note?: string
}

export function applyPostop(surgeryId: string, input: ApplyPostopInput): Promise<{ doneText: string; orderIds: string[] }> {
  return mutate(() => {
    const { m, s, a } = writable(surgeryId)
    if (s.postop) fail('術後醫囑已經開過了：要再加請到住院醫囑開立', 'CONFLICT')
    const t = now()
    const set = input.setId ? setOf(input.setId, m, s.procId) : undefined
    const note = input.note?.trim()
    if (!set && !note) failField('note', '不套組套的話，請寫原因（例：小手術，沿用術前醫囑）')
    const pick = [...new Set(input.items ?? [])].filter((i) => set && i >= 0 && i < set.items.length).sort((x, y) => x - y)
    if (set && !pick.length) failField('items', '請至少選一項（不套組套請選「沿用術前醫囑」）')
    const npo = activeNpo(a.id)
    const e: Record<string, string> = {}
    for (const o of npo) if (input.npo?.[o.id] !== 'stop' && input.npo?.[o.id] !== 'keep') e[`npo.${o.id}`] = '請選停止或保留'
    const newDiet = set && pick.some((i) => set.items[i].category === 'diet' && set.items[i].type === 'long')
    if (newDiet) for (const o of npo) if (input.npo?.[o.id] === 'keep') e[`npo.${o.id}`] = '組套有長期飲食醫囑，會取代禁食：不能保留'
    failFields(e)
    const created: IpdOrder[] = []
    if (set) {
      for (const i of pick) {
        const it = set.items[i]
        const pv = previewItem(it, s, m.doctorId, t, i)
        if (pv.status === 'blocked') failField('items', `第 ${i + 1} 項 ${pv.text}：${pv.notes.join('；')}`)
        const ok = pv.status === 'ok' || (input.confirmed ?? []).includes(i)
        if (!ok) failField('items', `第 ${i + 1} 項 ${pv.text} 要確認：${pv.notes.join('；')}`)
        try {
          created.push(createOrderInternal(m, a.id, {
            admissionId: a.id, type: it.type, category: it.category, content: it.content,
            ...(it.drugId ? { drugId: it.drugId } : {}), ...(it.procId ? { procId: it.procId } : {}), ...(it.dose !== undefined ? { dose: it.dose } : {}),
            ...(it.freq ? { freq: it.freq } : {}), ...(it.route ? { route: it.route } : {}), ...(it.diet ? { diet: { ...it.diet } } : {}),
            ...(pv.status === 'confirm' ? { allowDuplicate: true, confirmHighDose: true, allergyConfirmed: true, rxAlertReasons: Object.fromEntries(pv.rxKeys.map((k) => [k, '術後組套套用時確認'])) } : {}),
          }, t))
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          fail(`第 ${i + 1} 項 ${pv.text}：${msg}`, 'CONFLICT', 'items')
        }
      }
    }
    // 禁食：要停的停掉（長期飲食醫囑已經自動停了的不重複）
    const stopped: string[] = []
    for (const o of npo) {
      if (input.npo[o.id] !== 'stop') continue
      if (o.status === 'active') Object.assign(o, { status: 'stopped', stopAt: t })
      stopped.push(o.id)
    }
    s.postop = {
      by: m.id, at: t, ...(set ? { setId: set.id, setName: set.name } : {}), orderIds: created.map((o) => o.id),
      npoStopped: stopped, npoKept: npo.filter((o) => input.npo[o.id] === 'keep').map((o) => o.id), ...(note ? { note } : {}),
    }
    audit('術後醫囑', `${s.no} ${nameOf.patient(s.patientId)} ${find.procedure(s.procId)?.name ?? ''}（${SIDE_LABEL[s.side]}）：${set ? `套用「${set.name}」：${created.map((o) => o.content).join('、')}` : `沿用術前醫囑（${note}）`}${stopped.length ? '；停止禁食' : ''}${s.postop.npoKept.length ? '；保留禁食' : ''}`)
    return { doneText: doneText(s), orderIds: s.postop.orderIds }
  })
}

// ---------- 組套管理 ----------

/** 從這位病人執行中的醫囑存成術後組套（綁這台的術式） */
export function savePostopSet(surgeryId: string, input: { name: string; scope: 'personal' | 'dept'; orderIds: string[] }): Promise<PostopSetView> {
  return mutate(() => {
    const m = me()
    const s = must(surgeryOf(surgeryId), '手術')
    requireCare(m.doctorId, must(find.admission(s.admissionId), '住院紀錄'), '存術後組套', { consult: false })
    const e: Record<string, string> = {}
    const name = input.name?.trim() ?? ''
    if (!name) e.name = '請寫組套名稱'
    if (input.scope !== 'personal' && input.scope !== 'dept') e.scope = '請選個人或科室共用'
    const orders = (input.orderIds ?? []).map((id) => db.ipdOrders.find((o) => o.id === id && o.admissionId === s.admissionId && o.status === 'active'))
    if (!orders.length) e.orderIds = '請至少選一筆醫囑'
    else if (orders.some((o) => !o || !savable(o))) e.orderIds = '有醫囑不是這次住院執行中的，或不能存（點滴、升壓劑、呼吸器、排程檢驗、管灌）'
    failFields(e)
    if (db.postopSets.some((x) => x.procId === s.procId && x.name === name && canUseSet(x, m) && x.scope === input.scope)) failField('name', '已經有同名的組套')
    const t = now()
    const set: PostopSet = {
      id: newId('PS'), name, procId: s.procId, scope: input.scope, doctorId: m.doctorId, ...(input.scope === 'dept' ? { deptId: m.deptId, updatedBy: m.doctorId } : {}),
      items: orders.map((o) => ({
        type: o!.type, category: o!.category, content: o!.category === 'diet' ? o!.content : o!.content,
        ...(o!.drugId ? { drugId: o!.drugId } : {}), ...(o!.procId ? { procId: o!.procId } : {}), ...(o!.dose !== undefined ? { dose: o!.dose } : {}),
        ...(o!.freq ? { freq: o!.freq } : {}), ...(o!.route ? { route: o!.route } : {}), ...(o!.category === 'diet' ? { diet: { kind: dietOf(o!).kind, ...(o!.diet?.note ? { note: o!.diet.note } : {}) } } : {}),
      })),
      createdAt: t, updatedAt: t,
    }
    db.postopSets.push(set)
    audit('新增術後組套', `${set.scope === 'dept' ? `${nameOf.dept(m.deptId)}科室` : '個人'}「${name}」（${find.procedure(s.procId)?.name ?? ''}）${set.items.length} 項`)
    return setView(set, m)
  })
}

export function deletePostopSet(id: string): Promise<void> {
  return mutate(() => {
    const m = me()
    const x = setOf(id, m)
    db.postopSets = db.postopSets.filter((y) => y.id !== x.id)
    audit('刪除術後組套', `${x.scope === 'dept' ? `${nameOf.dept(x.deptId ?? '')}科室` : '個人'}「${x.name}」`)
  })
}
