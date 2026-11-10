// 路由表：頁面、選單、權限都從這裡產生。新增一個功能只要在這裡加一筆。
import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import {
  Activity, BedDouble, ClipboardList, HeartPulse, LayoutDashboard, Palette, Pill, Receipt, Settings, ShieldCheck, Stethoscope,
  UserPlus, Users,
} from 'lucide-vue-next'
import type { Role } from '@/types'

declare module 'vue-router' {
  interface RouteMeta {
    title?: string
    icon?: Component
    /** 可進入的角色；未設定表示登入即可。admin 一律可進入「檢視」，但臨床操作由服務層 requireUser 擋下 */
    roles?: Role[]
    /** 選單分組；未設定則不出現在選單 */
    group?: MenuGroup
    /** 不需登入 */
    public?: boolean
  }
}

export type MenuGroup = '總覽' | '門診' | '住院' | '其他' | '系統'
export const menuGroups: MenuGroup[] = ['總覽', '門診', '住院', '其他', '系統']


export const appRoutes: RouteRecordRaw[] = [
  { path: '', name: 'home', component: () => import('@/pages/home/HomePage.vue'), meta: { title: '首頁', icon: LayoutDashboard, group: '總覽' } },

  { path: 'booking', name: 'booking', component: () => import('@/pages/booking/BookingPage.vue'), meta: { title: '掛號作業', icon: UserPlus, group: '門診', roles: ['clerk', 'nurse'] } },
  { path: 'patients', name: 'patients', component: () => import('@/pages/patients/PatientsPage.vue'), meta: { title: '病患資料', icon: Users, group: '門診', roles: ['clerk', 'nurse', 'doctor'] } },
  { path: 'opd', name: 'opd', component: () => import('@/pages/opd/OpdPage.vue'), meta: { title: '門診看診', icon: Stethoscope, group: '門診', roles: ['doctor'] } },
  { path: 'charge', name: 'charge', component: () => import('@/pages/charge/ChargePage.vue'), meta: { title: '批價結帳', icon: Receipt, group: '門診', roles: ['clerk'] } },
  { path: 'pharmacy', name: 'pharmacy', component: () => import('@/pages/pharmacy/PharmacyPage.vue'), meta: { title: '門診藥局', icon: Pill, group: '門診', roles: ['pharmacist'] } },

  { path: 'admission', name: 'admission', component: () => import('@/pages/admission/AdmissionPage.vue'), meta: { title: '住院中心', icon: BedDouble, group: '住院', roles: ['clerk', 'nurse'] } },
  { path: 'ipd', name: 'ipd', component: () => import('@/pages/ipd/IpdPage.vue'), meta: { title: '住院醫囑', icon: ClipboardList, group: '住院', roles: ['doctor'] } },
  { path: 'nursing', name: 'nursing', component: () => import('@/pages/nursing/NursingPage.vue'), meta: { title: '護理站', icon: HeartPulse, group: '住院', roles: ['nurse'] } },

  { path: 'prevent', name: 'prevent', component: () => import('@/pages/prevent/PreventPage.vue'), meta: { title: '預防保健', icon: ShieldCheck, group: '其他', roles: ['doctor', 'nurse'] } },
  { path: 'drugs', name: 'drugs', component: () => import('@/pages/drugs/DrugsPage.vue'), meta: { title: '藥品庫存', icon: Activity, group: '其他', roles: ['pharmacist'] } },

  { path: 'admin', name: 'admin', component: () => import('@/pages/admin/AdminPage.vue'), meta: { title: '系統管理', icon: Settings, group: '系統', roles: ['admin'] } },
  { path: 'dev/ui', name: 'ui-gallery', component: () => import('@/pages/dev/UiGallery.vue'), meta: { title: 'UI 元件展示', icon: Palette, group: '系統', roles: ['admin'] } },

  { path: 'forbidden', name: 'forbidden', component: () => import('@/pages/ForbiddenPage.vue'), meta: { title: '沒有權限' } },
]

export const routes: RouteRecordRaw[] = [
  { path: '/login', name: 'login', component: () => import('@/pages/LoginPage.vue'), meta: { public: true, title: '登入' } },
  // 延遲載入：MainLayout 會讀取本檔的 appRoutes 產生選單，靜態 import 會形成循環依賴
  { path: '/', component: () => import('@/layouts/MainLayout.vue'), children: appRoutes },
  { path: '/:pathMatch(.*)*', redirect: '/' },
]
