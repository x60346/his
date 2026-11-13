// 權限設定（系統管理）：只能在權限目錄（permission-rules）允許的範圍內調整——
// 角色層級：在「法規允許的角色」裡勾選，至少留一個；指定個人：只開放主管型權限。
// 每次調整都要寫原因、寫稽核（誰把什麼從哪些角色改成哪些）；會讓人失去權限的，先回 CONFLICT 列出受影響的帳號，確認後才改。
import type { Role } from '@/types'
import { db } from '@/mock/db'
import { audit, fail, failField, failFields, must, mutate, query, requirePermission } from './http'
import { checkPermissionRoles, PERMISSIONS, permDef, permits, rolesOf, type PermDef, type PermKey } from './permission-rules'

const ROLE: Record<Role, string> = { admin: '系統管理員', doctor: '醫師', nurse: '護理師', pharmacist: '藥師', clerk: '掛號批價' }
const roleList = (rs: Role[]) => (rs.length ? rs.map((r) => ROLE[r]).join('、') : '（無）')
const settings = () => db.permissionSettings as Partial<Record<PermKey, Role[]>> | undefined

export interface PermissionRow extends PermDef {
  /** 目前開放的角色 */
  roles: Role[]
  /** 和預設不同 */
  changed: boolean
  /** 指定給個人的帳號 */
  grantees: { userId: string; username: string; name: string; active: boolean }[]
}

export function listPermissions(): Promise<PermissionRow[]> {
  return query(() => {
    requirePermission('system.accounts')
    return PERMISSIONS.map((d) => {
      const roles = rolesOf(d, settings())
      return {
        ...d,
        roles,
        changed: !d.fixed && roles.join() !== d.defaults.join(),
        grantees: db.users.filter((u) => u.grants?.includes(d.key)).map((u) => ({ userId: u.id, username: u.username, name: u.name, active: u.active })),
      }
    })
  })
}

/** 誰會因為這次調整失去權限（啟用中的帳號，任一角色原本可以、改了以後都不行） */
function losers(d: PermDef, next: Role[]) {
  const before = settings()
  const after = { ...before, [d.key]: next }
  return db.users.filter((u) => u.active && u.roles.some((r) => permits(d, before, r, u.grants ?? [])) && !u.roles.some((r) => permits(d, after, r, u.grants ?? [])))
}

/** 調整某項權限開放的角色（法規範圍內、至少一個）。有人會失去權限：先回 CONFLICT 列出，確認後帶 confirm 重送 */
export function savePermissionRoles(key: PermKey, input: { roles: Role[]; reason: string; confirm?: boolean }): Promise<PermissionRow> {
  return mutate(() => {
    requirePermission('system.accounts')
    const d = permDef(key)
    const roles = d.candidates.filter((r) => input.roles?.includes(r)) // 依目錄的順序存
    const errors: Record<string, string> = {}
    const problem = checkPermissionRoles(d, (input.roles ?? []) as Role[])
    if (problem) errors.roles = problem
    if (!input.reason?.trim()) errors.reason = '請寫調整原因（會記在稽核紀錄）'
    failFields(errors)
    const before = rolesOf(d, settings())
    if (before.join() === roles.join()) fail('沒有任何變更')
    const lose = losers(d, roles)
    if (lose.length && !input.confirm) fail(`這些帳號會失去「${d.label}」：${lose.map((u) => `${u.name}（${u.username}）`).join('、')}`, 'CONFLICT', 'confirm')
    const next = { ...settings() }
    if (roles.join() === d.defaults.join()) delete next[key]
    else next[key] = roles
    db.permissionSettings = next
    audit('修改權限', `${d.label}：${roleList(before)} → ${roleList(roles)}（${input.reason.trim()}）`)
    return listRow(d)
  })
}

/** 把某項權限指定給（或收回）某個帳號：只限可指定個人的權限，帳號要有法規範圍內的角色 */
export function setPermissionGrant(key: PermKey, userId: string, input: { on: boolean; reason: string }): Promise<PermissionRow> {
  return mutate(() => {
    requirePermission('system.accounts')
    const d = permDef(key)
    if (!d.grantable && !d.grantOnly) fail(`「${d.label}」不能指定給個人${d.fixed ? '（固定的權限）' : '，請調整角色'}`)
    const u = must(db.users.find((x) => x.id === userId), '帳號')
    if (!input.reason?.trim()) failField('reason', '請寫原因（例：升任藥劑部主管）')
    const has = !!u.grants?.includes(key)
    if (input.on) {
      if (has) fail(`${u.name} 已經有這項權限`, 'CONFLICT')
      if (!u.active) fail(`${u.name} 的帳號已停用`)
      if (!u.roles.some((r) => d.candidates.includes(r))) fail(`「${d.label}」只能給 ${roleList(d.candidates)}，${u.name} 沒有這些角色`)
      u.grants = [...(u.grants ?? []), key]
    } else {
      if (!has) fail(`${u.name} 沒有被指定這項權限`, 'CONFLICT')
      u.grants = u.grants!.filter((g) => g !== key)
      if (!u.grants.length) delete u.grants
    }
    audit('修改權限', `${d.label}：${input.on ? '指定給' : '收回'} ${u.name}（${u.username}）（${input.reason.trim()}）`)
    return listRow(d)
  })
}

function listRow(d: PermDef): PermissionRow {
  const roles = rolesOf(d, settings())
  return {
    ...d, roles, changed: !d.fixed && roles.join() !== d.defaults.join(),
    grantees: db.users.filter((u) => u.grants?.includes(d.key)).map((u) => ({ userId: u.id, username: u.username, name: u.name, active: u.active })),
  }
}
