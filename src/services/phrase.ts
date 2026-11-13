// 片語：常用文字（「.htn」→「高血壓，規則服藥中，血壓控制良好。」）。
// 三種範圍：個人的（只有本人看得到、改得到）；醫師的科室共用（同科醫師都能用、能改、能刪，記下最後修改的人）；
// 護理師的病房共用（在哪個病房寫紀錄就用那個病房的——帳號沒有綁病房，支援別的病房的護理師也用得到那裡的片語）。
// 同一個簡碼個人與共用可以並存，**個人的優先**：自己習慣的寫法不會被別人改的共用片語蓋掉（清單把被蓋住的共用片語標出來）。
// 規則（簡碼格式、展開）在 phrase-rules。
import type { Phrase, Role } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, query, requireUser } from './http'
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
}

function ctxOf(ward?: string): PhraseCtx {
  const u = requireUser('doctor', 'nurse')
  if (u.role === 'doctor') {
    const d = u.doctorId ? find.doctor(u.doctorId) : undefined
    return { userId: u.id, role: u.role, deptId: d?.deptId }
  }
  const w = ward?.trim()
  if (w && !db.beds.some((b) => b.ward === w)) fail(`找不到病房「${w}」`)
  return { userId: u.id, role: u.role, ward: w || undefined }
}

const scopeOf = (p: Phrase): PhraseScope => p.scope ?? 'personal'

/** 這則片語我看得到（也就改得到）嗎 */
function canUse(p: Phrase, c: PhraseCtx): boolean {
  const s = scopeOf(p)
  if (s === 'personal') return p.userId === c.userId
  if (s === 'dept') return c.role === 'doctor' && !!c.deptId && p.deptId === c.deptId
  return c.role === 'nurse' && !!c.ward && p.ward === c.ward
}

/** 同一範圍：個人的看擁有者，共用的看科別／病房 */
const sameGroup = (p: Phrase, scope: PhraseScope, c: PhraseCtx) =>
  scopeOf(p) === scope && (scope === 'personal' ? p.userId === c.userId : scope === 'dept' ? p.deptId === c.deptId : p.ward === c.ward)

const scopeLabel = (p: Pick<Phrase, 'scope' | 'deptId' | 'ward'>) =>
  p.scope === 'dept' ? `${nameOf.dept(p.deptId)}科室共用` : p.scope === 'ward' ? `${p.ward}共用` : '個人'

export interface PhraseView extends Phrase {
  /** 「內科科室共用」「5A 病房共用」；個人的是「個人」 */
  scopeLabel: string
  /** 共用片語最後修改的人 */
  updatedByName?: string
  /** 共用片語的簡碼和我的個人片語相同：展開時用的是個人的 */
  shadowed?: boolean
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
export function listPhrases(q: { ward?: string } = {}): Promise<{ phrases: PhraseView[]; shareTarget?: PhraseShareTarget }> {
  return query(() => {
    const c = ctxOf(q.ward)
    const mine = db.phrases.filter((p) => canUse(p, c))
    const personalCodes = new Set(mine.filter((p) => scopeOf(p) === 'personal').map((p) => p.code))
    const phrases = mine
      .sort((a, b) => (scopeOf(a) === 'personal') === (scopeOf(b) === 'personal') ? a.code.localeCompare(b.code) : scopeOf(a) === 'personal' ? -1 : 1)
      .map((p): PhraseView => {
        const shared = scopeOf(p) !== 'personal'
        return {
          ...p,
          scopeLabel: scopeLabel(p),
          ...(shared ? { updatedByName: db.users.find((u) => u.id === (p.updatedBy ?? p.userId))?.name } : {}),
          ...(shared && personalCodes.has(p.code) ? { shadowed: true } : {}),
        }
      })
    return { phrases, ...(shareTargetOf(c) ? { shareTarget: shareTargetOf(c) } : {}) }
  })
}

export interface PhraseInput {
  id?: string
  code: string
  text: string
  /** 新增時：個人（預設）或共用（醫師＝科室、護理師＝目前的病房）；修改時不能換範圍 */
  shared?: boolean
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
    let scope: PhraseScope
    if (old) scope = scopeOf(old)
    else if (input.shared) {
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
        ...(scope === 'dept' ? { scope, deptId: c.deptId, updatedBy: c.userId } : scope === 'ward' ? { scope, ward: c.ward, updatedBy: c.userId } : {}),
      }
      db.phrases.push(p)
    }
    audit(old ? '修改片語' : '新增片語', `${scope === 'personal' ? '' : scopeLabel(p) + ' '}.${code}`)
    return { ...p, scopeLabel: scopeLabel(p) }
  })
}

/** 刪除：個人的只有本人；共用的同科（同病房）都可以刪，寫稽核 */
export function deletePhrase(id: string, q: { ward?: string } = {}): Promise<void> {
  return mutate(() => {
    const c = ctxOf(q.ward)
    const p = must(db.phrases.find((x) => x.id === id && canUse(x, c)), '片語')
    db.phrases = db.phrases.filter((x) => x.id !== p.id)
    audit('刪除片語', `${scopeOf(p) === 'personal' ? '' : scopeLabel(p) + ' '}.${p.code}`)
  })
}
