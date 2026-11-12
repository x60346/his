// 片語：個人的常用文字（「.htn」→「高血壓，規則服藥中，血壓控制良好。」）。
// 醫師（門診 SOAP、病程紀錄、出院病摘）與護理師（護理紀錄、交班）各自一份，只有本人看得到、改得到；
// 規則（簡碼格式、展開）在 phrase-rules。
import type { Phrase } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, failFields, must, mutate, query, requireUser } from './http'
import { checkPhrase, normalizePhraseCode } from './phrase-rules'

/** 片語的擁有者＝目前登入的帳號（多角色的人，醫師與護理師身分共用同一份） */
const myId = (): string => requireUser('doctor', 'nurse').id

/** 我的片語（依簡碼排序） */
export function listPhrases(): Promise<Phrase[]> {
  return query(() => {
    const me = myId()
    return db.phrases.filter((p) => p.userId === me).sort((a, b) => a.code.localeCompare(b.code))
  })
}

/** 新增或修改；簡碼重複時標在簡碼欄位 */
export function savePhrase(input: { id?: string; code: string; text: string }): Promise<Phrase> {
  return mutate(() => {
    const me = myId()
    failFields(checkPhrase(input))
    const code = normalizePhraseCode(input.code)
    const text = input.text.trim()
    const old = input.id ? must(db.phrases.find((p) => p.id === input.id && p.userId === me), '片語') : undefined
    const dup = db.phrases.find((p) => p.userId === me && p.code === code && p.id !== old?.id)
    if (dup) failFields({ code: `已有簡碼「.${code}」：${dup.text.slice(0, 20)}${dup.text.length > 20 ? '…' : ''}` })
    const t = now()
    let p: Phrase
    if (old) {
      p = Object.assign(old, { code, text, updatedAt: t })
    } else {
      p = { id: newId('PH'), userId: me, code, text, createdAt: t, updatedAt: t }
      db.phrases.push(p)
    }
    audit(old ? '修改片語' : '新增片語', `.${code}`)
    return p
  })
}

export function deletePhrase(id: string): Promise<void> {
  return mutate(() => {
    const me = myId()
    const p = must(db.phrases.find((x) => x.id === id && x.userId === me), '片語')
    db.phrases = db.phrases.filter((x) => x.id !== p.id)
    audit('刪除片語', `.${p.code}`)
  })
}
