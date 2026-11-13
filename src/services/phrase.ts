// 片語：常用文字（「.htn」→「高血壓，規則服藥中，血壓控制良好。」）。
// 三種範圍：個人的（只有本人看得到、改得到）；醫師的科室共用（同科醫師都能用、能改、能刪，記下最後修改的人）；
// 護理師的病房共用（在哪個病房寫紀錄就用那個病房的——帳號沒有綁病房，支援別的病房的護理師也用得到那裡的片語）。
// 第四種「全院共用」：醫師、護理師各一組；所有醫師（護理師）都能用，只有被指定「維護全院片語」的人能改（權限 phrase.hospital）。
// 同一個簡碼可以並存，優先順序：個人 > 科室／病房共用 > 全院共用——越貼近自己的越優先，不會被上層蓋掉（清單把被蓋住的標出來）。
// 規則（簡碼格式、展開）在 phrase-rules。
import type { Phrase, Role } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, permissionsOf, query, requireUser } from './http'
import { checkPhrase, normalizePhraseCode } from './phrase-rules'
import { find, nameOf } from './views'

export type PhraseScope = NonNullable<Phrase['scope']>

/** 片語的範圍：誰（帳號）、以什麼身分、可以用哪一個共用範圍 */
interface PhraseCtx {
  userId: string
  role: Role
  /** 醫師：所屬科別（科室共用） */
  deptId?: string
  /** 護理師：目前所在的病房（病房共用）；沒給就只有個人的 */
  ward?: string
  /** 被指定維護全院片語（自己這一組） */
  hospitalEditor: boolean
}

function ctxOf(ward?: string): PhraseCtx {
  const u = requireUser('doctor', 'nurse')
  const hospitalEditor = permissionsOf(u).includes('phrase.hospital')
  if (u.role === 'doctor') {
    const d = u.doctorId ? find.doctor(u.doctorId) : undefined
    return { userId: u.id, role: u.role, deptId: d?.deptId, hospitalEditor }
  }
  const w = ward?.trim()
  if (w && !db.beds.some((b) => b.ward === w)) fail(`找不到病房「${w}」`)
  return { userId: u.id, role: u.role, ward: w || undefined, hospitalEditor }
}

const scopeOf = (p: Phrase): PhraseScope => p.scope ?? 'personal'

/** 這則片語我看得到嗎（個人、科室、病房共用：看得到就改得到；全院的見 canEdit） */
function canUse(p: Phrase, c: PhraseCtx): boolean {
  const s = scopeOf(p)
  if (s === 'personal') return p.userId === c.userId
  if (s === 'hospital') return p.forRole === c.role
  if (s === 'dept') return c.role === 'doctor' && !!c.deptId && p.deptId === c.deptId
  return c.role === 'nurse' && !!c.ward && p.ward === c.ward
}

/** 改得到嗎：全院的只有被指定的人（自己這一組） */
const canEdit = (p: Phrase, c: PhraseCtx) => canUse(p, c) && (scopeOf(p) !== 'hospital' || c.hospitalEditor)

/** 同一範圍：個人的看擁有者，共用的看科別／病房，全院的看哪一組 */
const sameGroup = (p: Phrase, scope: PhraseScope, c: PhraseCtx) =>
  scopeOf(p) === scope &&
  (scope === 'personal' ? p.userId === c.userId : scope === 'dept' ? p.deptId === c.deptId : scope === 'ward' ? p.ward === c.ward : p.forRole === c.role)

/** 優先順序（小的優先）：個人 > 科室／病房 > 全院 */
const rankOf = (p: Phrase) => ({ personal: 0, dept: 1, ward: 1, hospital: 2 })[scopeOf(p)]
const ROLE_GROUP = { doctor: '醫師', nurse: '護理' } as const

const scopeLabel = (p: Pick<Phrase, 'scope' | 'deptId' | 'ward' | 'forRole'>) =>
  p.scope === 'dept' ? `${nameOf.dept(p.deptId)}科室共用` : p.scope === 'ward' ? `${p.ward}共用` : p.scope === 'hospital' ? `全院${ROLE_GROUP[p.forRole ?? 'doctor']}共用` : '個人'

export interface PhraseView extends Phrase {
  /** 「內科科室共用」「5A 病房共用」；個人的是「個人」 */
  scopeLabel: string
  /** 共用片語最後修改的人 */
  updatedByName?: string
  /** 有優先順序更高、同簡碼的片語（個人蓋科室／病房，兩者都蓋全院）：展開時用的是那一則；by＝蓋住它的範圍 */
  shadowed?: boolean
  shadowedBy?: string
  /** 我能不能改（全院片語只有被指定的人能改） */
  canEdit: boolean
}

/** 全院片語：哪一組、我能不能維護 */
export interface PhraseHospitalTarget {
  label: string
  canEdit: boolean
}

/** 我目前可以建立的共用範圍（醫師＝科室；護理師＝目前的病房；都沒有就只能存個人的） */
export interface PhraseShareTarget {
  scope: 'dept' | 'ward'
  label: string
}

const shareTargetOf = (c: PhraseCtx): PhraseShareTarget | undefined =>
  c.role === 'doctor' && c.deptId ? { scope: 'dept', label: `${nameOf.dept(c.deptId)}科室共用` } : c.role === 'nurse' && c.ward ? { scope: 'ward', label: `${c.ward}共用` } : undefined

/**
 * 我能用的片語：個人的在前（依簡碼），共用的在後。展開時取第一個符合的簡碼——個人的優先。
 * 護理師帶目前的病房（ward）才有病房共用片語。
 */
export function listPhrases(q: { ward?: string } = {}): Promise<{ phrases: PhraseView[]; shareTarget?: PhraseShareTarget; hospital: PhraseHospitalTarget }> {
  return query(() => {
    const c = ctxOf(q.ward)
    const mine = db.phrases.filter((p) => canUse(p, c))
    const phrases = mine
      // 依優先順序排（展開時取第一個符合的簡碼），同一層依簡碼
      .sort((a, b) => rankOf(a) - rankOf(b) || a.code.localeCompare(b.code))
      .map((p): PhraseView => {
        const shared = scopeOf(p) !== 'personal'
        const over = mine.find((x) => x.code === p.code && rankOf(x) < rankOf(p))
        return {
          ...p,
          scopeLabel: scopeLabel(p),
          canEdit: canEdit(p, c),
          ...(shared ? { updatedByName: db.users.find((u) => u.id === (p.updatedBy ?? p.userId))?.name } : {}),
          ...(over ? { shadowed: true, shadowedBy: scopeOf(over) === 'personal' ? '你的個人片語' : scopeLabel(over) } : {}),
        }
      })
    return {
      phrases,
      ...(shareTargetOf(c) ? { shareTarget: shareTargetOf(c) } : {}),
      hospital: { label: `全院${ROLE_GROUP[c.role as 'doctor' | 'nurse']}共用`, canEdit: c.hospitalEditor },
    }
  })
}

export interface PhraseInput {
  id?: string
  code: string
  text: string
  /** 新增時：個人（預設）或共用（醫師＝科室、護理師＝目前的病房）；修改時不能換範圍 */
  shared?: boolean
  /** 新增全院共用（自己這一組；要被指定維護全院片語） */
  hospital?: boolean
  /** 護理師目前的病房 */
  ward?: string
}

/** 新增或修改；同一範圍內簡碼重複時標在簡碼欄位（個人與共用可以同簡碼，個人的優先） */
export function savePhrase(input: PhraseInput): Promise<PhraseView> {
  return mutate(() => {
    const c = ctxOf(input.ward)
    failFields(checkPhrase(input))
    const code = normalizePhraseCode(input.code)
    const text = input.text.trim()
    const old = input.id ? must(db.phrases.find((p) => p.id === input.id && canUse(p, c)), '片語') : undefined
    if (old && !canEdit(old, c)) fail('全院片語只有被指定維護的人能改（系統管理 → 權限「維護全院片語」）', 'FORBIDDEN')
    let scope: PhraseScope
    if (old) scope = scopeOf(old)
    else if (input.hospital) {
      if (!c.hospitalEditor) fail('你沒有被指定維護全院片語（系統管理 → 權限）', 'FORBIDDEN')
      scope = 'hospital'
    } else if (input.shared) {
      const t = shareTargetOf(c)
      if (!t) fail(c.role === 'nurse' ? '請在護理站選好病房再新增病房共用片語' : '此帳號沒有所屬科別，不能新增科室共用片語')
      scope = t!.scope
    } else scope = 'personal'
    const dup = db.phrases.find((p) => sameGroup(p, scope, c) && p.code === code && p.id !== old?.id)
    if (dup) failFields({ code: `${scope === 'personal' ? '' : scopeLabel(dup)}已有簡碼「.${code}」：${dup.text.slice(0, 20)}${dup.text.length > 20 ? '…' : ''}` })
    const t = now()
    let p: Phrase
    if (old) {
      p = Object.assign(old, { code, text, updatedAt: t, ...(scope !== 'personal' ? { updatedBy: c.userId } : {}) })
    } else {
      p = {
        id: newId('PH'), userId: c.userId, code, text, createdAt: t, updatedAt: t,
        ...(scope === 'dept' ? { scope, deptId: c.deptId, updatedBy: c.userId } : scope === 'ward' ? { scope, ward: c.ward, updatedBy: c.userId } : scope === 'hospital' ? { scope, forRole: c.role as 'doctor' | 'nurse', updatedBy: c.userId } : {}),
      }
      db.phrases.push(p)
    }
    audit(old ? '修改片語' : '新增片語', `${scope === 'personal' ? '' : scopeLabel(p) + ' '}.${code}`)
    return { ...p, scopeLabel: scopeLabel(p), canEdit: true }
  })
}

/** 刪除：個人的只有本人；共用的同科（同病房）都可以刪；全院的只有被指定的人。寫稽核 */
export function deletePhrase(id: string, q: { ward?: string } = {}): Promise<void> {
  return mutate(() => {
    const c = ctxOf(q.ward)
    const p = must(db.phrases.find((x) => x.id === id && canUse(x, c)), '片語')
    if (!canEdit(p, c)) fail('全院片語只有被指定維護的人能刪', 'FORBIDDEN')
    db.phrases = db.phrases.filter((x) => x.id !== p.id)
    audit('刪除片語', `${scopeOf(p) === 'personal' ? '' : scopeLabel(p) + ' '}.${p.code}`)
  })
}
