// 病患基本資料：搜尋、建檔、修改，以及模擬讀取健保卡。
import type { Patient } from '@/types'
import { db, nextCounter, newId } from '@/mock/db'
import { now, toDateStr } from '@/utils/date'
import { checkBirthDate, checkName, isValidIdNo, isValidPhone, makeIdNo } from '@/utils/validators'
import { audit, failField, fieldErrors, must, mutate, query, requireUser } from './http'
import { contains, find } from './views'
import { allergyOptions } from '@/mock/codes'

export function searchPatients(keyword: string, limit = 50): Promise<Patient[]> {
  return query(() => {
    const kw = keyword.trim()
    const list = kw
      ? db.patients.filter((p) => p.chartNo.startsWith(kw) || contains(p.name, kw) || contains(p.idNo, kw) || p.phone.replace(/-/g, '').includes(kw.replace(/-/g, '')))
      : db.patients
    return list.slice(0, limit)
  })
}

export const getPatient = (id: string): Promise<Patient> => query(() => must(find.patient(id), '病患'))

export type PatientInput = Omit<Patient, 'id' | 'chartNo' | 'createdAt'>

function validate(p: PatientInput, selfId?: string): void {
  // 與建檔表單的即時提示共用同一套檢查（validators.ts）
  const v = fieldErrors()
  const nameProblem = checkName(p.name)
  if (nameProblem) v.add('name', nameProblem)
  const birthProblem = checkBirthDate(p.birthDate, toDateStr(new Date()))
  if (birthProblem) v.add('birthDate', birthProblem)
  if (!isValidIdNo(p.idNo)) v.add('idNo', '身分證字號格式或檢查碼錯誤')
  if (p.phone && !isValidPhone(p.phone)) v.add('phone', '電話格式錯誤')
  if (p.emergencyPhone && !isValidPhone(p.emergencyPhone)) v.add('emergencyPhone', '電話格式錯誤')
  if (!find.identity(p.defaultIdentity)) v.add('defaultIdentity', '請選擇就醫身分')
  v.done()
  // 只有服務層才查得出來的錯誤，一樣標出欄位
  const dup = db.patients.find((x) => x.idNo === p.idNo.toUpperCase() && x.id !== selfId)
  if (dup) failField('idNo', `已建檔：病歷號 ${dup.chartNo}（${dup.name}）`, 'CONFLICT')
}

export function createPatient(input: PatientInput): Promise<Patient> {
  return mutate(() => {
    requireUser('clerk', 'doctor', 'nurse')
    validate(input)
    const p: Patient = {
      ...input,
      name: input.name.trim(),
      idNo: input.idNo.toUpperCase(),
      id: newId('PT'),
      chartNo: String(nextCounter('chartNo', 100001)),
      createdAt: now(),
    }
    db.patients.push(p)
    audit('病患建檔', `${p.chartNo} ${p.name}`)
    return p
  })
}

/**
 * 看診中新增過敏：病人當場說「我對盤尼西林過敏」，醫師不必離開看診頁去改病人資料。
 * 只能「新增」——移除過敏風險高，仍要到病患資料頁修改。過敏原限選項清單（過敏比對依這些類別），寫入稽核。
 */
export function addAllergy(patientId: string, allergen: string): Promise<Patient> {
  return mutate(() => {
    const u = requireUser('doctor', 'nurse')
    const p = must(find.patient(patientId), '病患')
    if (!allergyOptions.includes(allergen)) failField('allergen', '請從清單選擇過敏原')
    if (p.allergies.includes(allergen)) failField('allergen', `已記錄對 ${allergen} 過敏`, 'CONFLICT')
    p.allergies.push(allergen)
    audit('新增過敏', `${p.name}：${allergen}（${u.role === 'doctor' ? '醫師' : '護理師'}登錄）`)
    return p
  })
}

export function updatePatient(id: string, input: PatientInput): Promise<Patient> {
  return mutate(() => {
    requireUser('clerk', 'doctor', 'nurse')
    const p = must(find.patient(id), '病患')
    validate(input, id)
    Object.assign(p, input, { name: input.name.trim(), idNo: input.idNo.toUpperCase() })
    audit('修改病患資料', `${p.chartNo} ${p.name}`)
    return p
  })
}

// ---------- 模擬健保卡 ----------
export interface NhiCard {
  cardNo: string
  idNo: string
  name: string
  gender: Patient['gender']
  birthDate: string
}

const newcomers: [string, Patient['gender'], string][] = [
  ['藍子晴', 'F', '1994-03-18'],
  ['魏承佑', 'M', '1988-11-02'],
  ['柯品妍', 'F', '2019-07-25'],
  ['石家瑋', 'M', '1959-01-30'],
]

/**
 * 模擬讀卡機（jian-HIS 透過 ws://127.0.0.1:8889 讀卡；這裡直接產生結果）。
 * 七成機率讀到已建檔病患，三成是尚未建檔的新病人，用來展示「初診建檔」流程。
 */
export function readNhiCard(): Promise<{ card: NhiCard; patient: Patient | null }> {
  return query(() => {
    if (Math.random() < 0.7) {
      const p = db.patients[Math.floor(Math.random() * db.patients.length)]
      return { card: { cardNo: `0000${p.idNo.slice(-8)}`, idNo: p.idNo, name: p.name, gender: p.gender, birthDate: p.birthDate }, patient: p }
    }
    const [name, gender, birthDate] = newcomers[Math.floor(Math.random() * newcomers.length)]
    const idNo = makeIdNo('D', gender, Math.floor(Math.random() * 9999999))
    const existing = db.patients.find((p) => p.idNo === idNo) ?? null
    return { card: { cardNo: `0000${idNo.slice(-8)}`, idNo, name, gender, birthDate }, patient: existing }
  })
}
