// 路由表：頁面、選單、權限都從這裡產生。新增一個功能只要在這裡加一筆。
import type { Component } from 'vue'
import type { RouteRecordRaw } from 'vue-router'
import {
  Activity, BarChart3, BedDouble, Bug, Droplet, Scissors, Siren, ClipboardList, FlaskConical, HeartPulse, ScanLine, LayoutDashboard, Palette, Pill, PillBottle, Receipt, Settings, ShieldCheck, Stethoscope,
  UserPlus, Users,
  Utensils,
  CalendarDays,
  HousePlus,
  ShieldAlert,
} from 'lucide-vue-next'
import type { Role } from '@/types'
import type { PermKey } from '@/services/permission-rules'

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
    /** 受權限目錄管的頁面：還要有這個權限才看得到、進得去（服務層一樣會擋） */
    permission?: PermKey
  }
}

export type MenuGroup = '總覽' | '門診' | '住院' | '其他' | '系統'
export const menuGroups: MenuGroup[] = ['總覽', '門診', '住院', '其他', '系統']


export const appRoutes: RouteRecordRaw[] = [
  { path: '', name: 'home', component: () => import('@/pages/home/HomePage.vue'), meta: { title: '首頁', icon: LayoutDashboard, group: '總覽' } },

  { path: 'booking', name: 'booking', component: () => import('@/pages/booking/BookingPage.vue'), meta: { title: '掛號作業', icon: UserPlus, group: '門診', roles: ['clerk', 'nurse'] } },
  { path: 'patients', name: 'patients', component: () => import('@/pages/patients/PatientsPage.vue'), meta: { title: '病患資料', icon: Users, group: '門診', roles: ['clerk', 'nurse', 'doctor'] } },
  { path: 'er', name: 'er', component: () => import('@/pages/er/ErPage.vue'), meta: { title: '急診', icon: Siren, group: '門診', roles: ['nurse', 'doctor', 'clerk'] } },
  { path: 'opd', name: 'opd', component: () => import('@/pages/opd/OpdPage.vue'), meta: { title: '門診看診', icon: Stethoscope, group: '門診', roles: ['doctor'] } },
  { path: 'charge', name: 'charge', component: () => import('@/pages/charge/ChargePage.vue'), meta: { title: '批價結帳', icon: Receipt, group: '門診', roles: ['clerk'] } },
  { path: 'pharmacy', name: 'pharmacy', component: () => import('@/pages/pharmacy/PharmacyPage.vue'), meta: { title: '門診藥局', icon: Pill, group: '門診', roles: ['pharmacist'] } },

  { path: 'admission', name: 'admission', component: () => import('@/pages/admission/AdmissionPage.vue'), meta: { title: '住院中心', icon: BedDouble, group: '住院', roles: ['clerk', 'nurse'] } },
  { path: 'ipd', name: 'ipd', component: () => import('@/pages/ipd/IpdPage.vue'), meta: { title: '住院醫囑', icon: ClipboardList, group: '住院', roles: ['doctor'] } },
  { path: 'ud', name: 'ud', component: () => import('@/pages/ud/UdPage.vue'), meta: { title: '住院藥局', icon: PillBottle, group: '住院', roles: ['pharmacist'] } },
  { path: 'or', name: 'or', component: () => import('@/pages/or/OrPage.vue'), meta: { title: '手術室', icon: Scissors, group: '住院', roles: ['nurse', 'doctor'] } },
  { path: 'nursing', name: 'nursing', component: () => import('@/pages/nursing/NursingPage.vue'), meta: { title: '護理站', icon: HeartPulse, group: '住院', roles: ['nurse'] } },

  { path: 'nurse-schedule', name: 'nurse-schedule', component: () => import('@/pages/nursing/NurseSchedulePage.vue'), meta: { title: '護理排班', icon: CalendarDays, group: '住院', roles: ['nurse', 'admin'] } },
  { path: 'discharge-plan', name: 'discharge-plan', component: () => import('@/pages/nursing/DischargePlanPage.vue'), meta: { title: '出院準備', icon: HousePlus, group: '住院', roles: ['nurse', 'admin'], permission: 'discharge.plan' } },
  { path: 'nutrition', name: 'nutrition', component: () => import('@/pages/nutrition/NutritionPage.vue'), meta: { title: '營養', icon: Utensils, group: '住院', roles: ['diet', 'nurse'] } },

  { path: 'icu', name: 'icu', component: () => import('@/pages/icu/IcuPage.vue'), meta: { title: '加護病房', icon: Activity, group: '住院', roles: ['doctor', 'admin'], permission: 'icu.attending' } },
  { path: 'infection', name: 'infection', component: () => import('@/pages/infection/InfectionPage.vue'), meta: { title: '感染管制', icon: ShieldAlert, group: '其他', roles: ['doctor', 'nurse', 'admin'], permission: 'infection.control' } },
  { path: 'lab', name: 'lab', component: () => import('@/pages/lab/LabPage.vue'), meta: { title: '檢驗', icon: FlaskConical, group: '其他', roles: ['lab'] } },
  { path: 'blood', name: 'blood', component: () => import('@/pages/blood/BloodBankPage.vue'), meta: { title: '血庫', icon: Droplet, group: '其他', roles: ['lab'] } },
  { path: 'imaging', name: 'imaging', component: () => import('@/pages/imaging/ImagingPage.vue'), meta: { title: '影像判讀', icon: ScanLine, group: '其他', roles: ['doctor'] } },
  { path: 'abx', name: 'abx', component: () => import('@/pages/abx/AbxReviewPage.vue'), meta: { title: '抗生素審核', icon: Bug, group: '其他', roles: ['doctor'] } },
  { path: 'prevent', name: 'prevent', component: () => import('@/pages/prevent/PreventPage.vue'), meta: { title: '預防保健', icon: ShieldCheck, group: '其他', roles: ['doctor', 'nurse'] } },
  { path: 'drugs', name: 'drugs', component: () => import('@/pages/drugs/DrugsPage.vue'), meta: { title: '藥品庫存', icon: Activity, group: '其他', roles: ['pharmacist'] } },

  { path: 'management', name: 'management', component: () => import('@/pages/management/ManagementPage.vue'), meta: { title: '經營月報', icon: BarChart3, group: '系統', permission: 'report.management' } },
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
