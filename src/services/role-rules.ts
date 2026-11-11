// 帳號角色規則（純函式：帳號管理頁的勾選提示與服務層共用）。

import type { Role } from '@/types'

/**
 * 不能兼任的角色組合。
 * 醫師＋藥師：醫藥分業——開處方的人不能自己核對、發出自己開的藥（雙人把關就沒了）。
 */
export const ROLE_CONFLICTS: { roles: [Role, Role]; reason: string }[] = [
  { roles: ['doctor', 'pharmacist'], reason: '醫師與藥師不可兼任（醫藥分業：開處方的人不能自己核對、發藥）' },
]

/** 角色組合的問題；沒問題回傳 null */
export function rolesProblem(roles: Role[]): string | null {
  if (!roles.length) return '請至少選一個角色'
  for (const c of ROLE_CONFLICTS) if (c.roles.every((r) => roles.includes(r))) return c.reason
  return null
}
