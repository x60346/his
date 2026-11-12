// 片語：醫師個人的常用文字（「.htn」→「高血壓，規則服藥中，血壓控制良好。」）。
// 只有醫師本人看得到、改得到；規則（簡碼格式、展開）在 phrase-rules。
import type { Phrase } from '@/types'
import { db, newId } from '@/mock/db'
import { now } from '@/utils/date'
import { audit, fail, failFields, must, mutate, query, requireUser } from './http'
import { checkPhrase, normalizePhraseCode } from './phrase-rules'

function myDoctorId(): string {
  const u = requireUser('doctor')
  if (!u.doctorId) fail('此帳號沒有對應的醫師資料', 'FORBIDDEN')
  return u.doctorId
}

/** 我的片語（依簡碼排序） */
export function listPhrases(): Promise<Phrase[]> {
  return query(() => {
    const me = myDoctorId()
    return db.phrases.filter((p) => p.doctorId === me).sort((a, b) => a.code.localeCompare(b.code))
  })
}

/** 新增或修改；簡碼重複時標在簡碼欄位 */
export function savePhrase(input: { id?: string; code: string; text: string }): Promise<Phrase> {
  return mutate(() => {
    const me = myDoctorId()
    failFields(checkPhrase(input))
    const code = normalizePhraseCode(input.code)
    const text = input.text.trim()
    const old = input.id ? must(db.phrases.find((p) => p.id === input.id && p.doctorId === me), '片語') : undefined
    const dup = db.phrases.find((p) => p.doctorId === me && p.code === code && p.id !== old?.id)
    if (dup) failFields({ code: `已有簡碼「.${code}」：${dup.text.slice(0, 20)}${dup.text.length > 20 ? '…' : ''}` })
    const t = now()
    let p: Phrase
    if (old) {
      p = Object.assign(old, { code, text, updatedAt: t })
    } else {
      p = { id: newId('PH'), doctorId: me, code, text, createdAt: t, updatedAt: t }
      db.phrases.push(p)
    }
    audit(old ? '修改片語' : '新增片語', `.${code}`)
    return p
  })
}

export function deletePhrase(id: string): Promise<void> {
  return mutate(() => {
    const me = myDoctorId()
    const p = must(db.phrases.find((x) => x.id === id && x.doctorId === me), '片語')
    db.phrases = db.phrases.filter((x) => x.id !== p.id)
    audit('刪除片語', `.${p.code}`)
  })
}
