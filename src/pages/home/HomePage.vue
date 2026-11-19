<script setup lang="ts">
// 首頁儀表板：今日營運指標、近 7 日趨勢、依角色顯示的待辦。
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import {
  Droplet, Scissors, Siren,
  AlertTriangle, BedDouble, ChevronRight, ClipboardCheck, Coins, DoorOpen, FlaskConical, ScanLine, Package, PhoneCall, Pill, ShieldAlert, Receipt, Stethoscope, Truck, Users,
} from 'lucide-vue-next'
import { UBarChart, UCard, UEmpty, UStatCard } from '@/components/ui'
import { dashboardApi, masterApi, opdApi } from '@/services'
import { useQuery } from '@/composables/useService'
import { useToday } from '@/composables/useClock'
import { useAuth } from '@/stores/auth'
import { useCan } from '@/composables/useCan'
import DiscountRequestsCard from '@/components/DiscountRequestsCard.vue'
import LabAcksCard from '@/components/LabAcksCard.vue'
import { money } from '@/utils/labels'

const auth = useAuth()
const can = useCan()
const router = useRouter()

const { data: s, reload } = useQuery(() => dashboardApi.getDashboard())

// 醫師才查自己的候診清單
const isDoctor = computed(() => auth.user?.role === 'doctor' && !!auth.user.doctorId)
const todayStr = useToday()
const { data: myQueue } = useQuery(async () => (isDoctor.value ? opdApi.listQueue({ date: todayStr.value, doctorId: auth.user!.doctorId! }) : []), [todayStr])
const myWaiting = computed(() => (myQueue.value ?? []).filter((v) => v.status === 'registered' || v.status === 'in-consult').length)

// 「時間經過」也會讓數字改變（例如給藥逾時），但資料沒變、dbVersion 不會動，所以每分鐘重查一次
let timer: ReturnType<typeof setInterval> | undefined
onMounted(() => (timer = setInterval(reload, 60_000)))
onBeforeUnmount(() => clearInterval(timer))

interface Todo {
  label: string
  count: number
  hint: string
  route: string
  query?: Record<string, string>
  icon: typeof Users
  urgent?: boolean
}

/** 依角色挑出「我現在該處理的事」 */
const todos = computed<Todo[]>(() => {
  if (!s.value) return []
  const role = auth.user?.role
  const list: (Todo & { roles: string[] })[] = [
    { roles: ['lab'], label: '備血待處理', count: s.value.bloodWork ?? 0, hint: s.value.bloodUrgent ? `其中急件 ${s.value.bloodUrgent} 張` : '待驗血型、交叉試驗還沒配滿的備血單', route: 'blood', icon: Droplet, urgent: !!s.value.bloodUrgent },
    { roles: ['doctor'], label: '輸血反應待確認', count: s.value.bloodReactions ?? 0, hint: '我的病人輸血時發生反應、已停止輸血：請在住院醫囑「輸血」分頁寫處置', route: 'ipd', icon: Droplet, urgent: true },
    { roles: ['nurse'], label: '急診待看診', count: s.value.erWaiting, hint: s.value.erOverdue ? `其中 ${s.value.erOverdue} 位超過目標等候時間` : '已檢傷、等醫師看的急診病人', route: 'er', icon: Siren, urgent: !!s.value.erOverdue },
    { roles: ['doctor'], label: '急診待看診', count: s.value.erDeciding !== undefined ? s.value.erWaiting : 0, hint: s.value.erOverdue ? `其中 ${s.value.erOverdue} 位超過目標等候時間（在門診看診的急診診次依級數叫號）` : '在門診看診的急診診次依檢傷級數叫號', route: 'opd', icon: Siren, urgent: !!s.value.erOverdue },
    { roles: ['doctor'], label: '急診待決定去向', count: s.value.erDeciding ?? 0, hint: '看完診的急診病人：離院、收住院或轉院（急診看板）', route: 'er', icon: Siren, urgent: true },
    { roles: ['nurse'], label: '急診待排留觀床', count: s.value.erObsBed, hint: '急診醫師決定留觀：排留觀床（OB1–OB6）、印腕帶後開始留觀', route: 'er', icon: Siren, urgent: true },
    { roles: ['doctor'], label: '急診留觀超過 48 小時', count: s.value.erObsOverdue ?? 0, hint: '留觀太久：請決定離院、收住院或轉院（急診看板「結束留觀」）', route: 'er', icon: Siren, urgent: true },
    { roles: ['clerk', 'nurse'], label: '急診收住院待床', count: s.value.erBed, hint: '急診醫師決定收住院、還沒報到：住院中心優先安排床位', route: 'admission', icon: Siren, urgent: true },
    { roles: ['nurse'], label: '手術待排程', count: s.value.surgeryToSchedule ?? 0, hint: '醫師申請的手術，排手術房與時間（手術排程權限）', route: 'or', icon: Scissors, urgent: true },
    { roles: ['nurse'], label: '術前準備未完成', count: s.value.surgeryPrepDue, hint: '今天、明天要開的手術，同意書、禁食、部位標記等還沒完成（全院）', route: 'or', icon: Scissors, urgent: true },
    { roles: ['doctor'], label: '手術紀錄待寫', count: s.value.opRecordsDue ?? 0, hint: '我主刀、已完成的手術：在住院醫囑「手術」分頁寫手術紀錄', route: 'ipd', icon: Scissors, urgent: true },
    { roles: ['nurse'], label: '疼痛重評逾時', count: s.value.painReassessOverdue, hint: '疼痛 ≥4 處置後 1 小時還沒重評（全院；護理站生命徵象記疼痛分數就算重評）', route: 'nursing', icon: Droplet, urgent: true },
    { roles: ['nurse'], label: '管路待處理', count: s.value.lineTodo, hint: '導尿管、CVC 今天還沒評估還需要嗎、評估可移除；周邊留置針滿 96 小時（全院，護理站「管路」分頁）', route: 'nursing', icon: Droplet },
    { roles: ['doctor'], label: '管路滿 7 天', count: s.value.lineAttending ?? 0, hint: '你的住院病人導尿管或中心靜脈導管已放滿 7 天：請評估是否移除（住院醫囑「管路」分頁）', route: 'ipd', icon: Droplet, urgent: true },
    { roles: ['doctor', 'nurse', 'admin'], label: '疑似群聚待判定', count: s.value.clustersOpen ?? 0, hint: '同病房 14 天內兩例以上同菌種或同感染部位：確認（寫處置）或排除（寫原因）（「感染管制」頁）', route: 'infection', icon: Droplet, urgent: true },
    { roles: ['doctor', 'nurse', 'admin'], label: '法定傳染病通報逾時', count: s.value.notifiableOverdue ?? 0, hint: '隔離原因或診斷符合法定傳染病、超過通報時限還沒通報（「感染管制」頁）', route: 'infection', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: '抗藥菌待隔離', count: s.value.mdroAlerts ?? 0, hint: '你的住院病人培養出 MRSA、CRE 或 VRE，還沒開接觸隔離（「隔離與 DNR」分頁）', route: 'ipd', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: '法定傳染病待通報', count: s.value.notifiablePending ?? 0, hint: '你的住院病人隔離原因或診斷符合法定傳染病：在時限內通報（「隔離與 DNR」分頁）', route: 'ipd', icon: Droplet, urgent: true },
    { roles: ['doctor', 'nurse', 'admin'], label: '院內感染待判定', count: s.value.infectionToDecide ?? 0, hint: '醫師、護理師通報的院內感染個案：判定成立或不成立（「感染管制」頁）', route: 'infection', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: 'PCA 警示待處理', count: s.value.pcaAlerts ?? 0, hint: 'PCA 使用中的病人鎮靜過深或呼吸過慢：請處理（住院醫囑「PCA」分頁）', route: 'ipd', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: '死亡病例待審查', count: s.value.mortalityToReview ?? 0, hint: '非預期死亡（沒有 DNR、入院 48 小時內、術後 30 天內、急救後、加護病房轉出 48 小時內）：審查結論與改善事項（「死亡審查」頁）', route: 'mortality', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: '安寧照會待收案', count: s.value.palliativeRequests ?? 0, hint: '主治提出的安寧共照照會：末期評估後收案或婉拒（「安寧」頁）', route: 'palliative', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: '安寧訪視到期', count: s.value.palliativeVisitDue ?? 0, hint: '收案的病人每週至少訪視一次：症狀評估、照護目標（「安寧」頁）', route: 'palliative', icon: Droplet },
    { roles: ['doctor'], label: '快速反應待到場', count: s.value.rrtPending ?? 0, hint: '一般病房 NEWS2 ≥7 自動呼叫、或護理師手動呼叫：到場評估，留原病房或申請轉加護病房（「快速反應」頁）', route: 'rrt', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: 'NEWS2 警示', count: s.value.newsAlerts ?? 0, hint: '你的一般病房病人最近一次 NEWS2 中（5–6 分或單項 3 分）或高（≥7 分）：請評估（住院醫囑「加護病房」分頁看分數與趨勢）', route: 'ipd', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: '加護病房轉入待處理', count: s.value.icuRequestsPending ?? 0, hint: '轉入加護病房的申請：同意（選床）或不同意；同意了在候床的有床再排（「加護病房」頁）', route: 'icu', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: '鎮靜超出目標', count: s.value.rassOut ?? 0, hint: '你的加護病房病人最近一次 RASS 超出你設的鎮靜目標：調整鎮靜藥或目標（住院醫囑「呼吸器與鎮靜」分頁）', route: 'ipd', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: '今日脫離評估', count: s.value.weanDue ?? 0, hint: '插管接呼吸器的病人今天還沒做 SAT（停鎮靜）／SBT（自發呼吸）：做完記結果（住院醫囑「呼吸器與鎮靜」分頁）', route: 'ipd', icon: Droplet },
    { roles: ['doctor'], label: '傷口 2 週沒變小', count: s.value.woundStall ?? 0, hint: '你的住院病人傷口連續 2 週面積沒變小：評估換敷料、會診整形外科、營養（住院醫囑「傷口」分頁）', route: 'ipd', icon: Droplet, urgent: true },
    { roles: ['nurse'], label: '負壓室待處理', count: s.value.negativeRoomTodo ?? 0, hint: '負壓隔離室這一班還沒記錄壓差、或負壓不足（高於 −2.5 Pa）：沒處理好不能收新的空氣隔離病人（護理站「負壓室」分頁）', route: 'nursing', icon: Droplet, urgent: true },
    { roles: ['nurse'], label: 'NEWS2 再量逾時', count: s.value.newsRecheckOverdue ?? 0, hint: 'NEWS2 中或高的病人 1 小時內要再量一次生命徵象（含給氧、意識；護理站「生命徵象」分頁）', route: 'nursing', icon: Droplet, urgent: true },
    { roles: ['nurse'], label: '重症流程表漏記', count: s.value.icuHourlyLate ?? 0, hint: '加護病房病人超過 75 分鐘沒記流程表（每小時一筆；護理站「重症流程表」分頁）', route: 'nursing', query: { ward: masterApi.staticCodes.icuWard }, icon: Droplet, urgent: true },
    { roles: ['nurse'], label: '點滴已滴完未換', count: s.value.infusionOverdue, hint: '點滴已滴完還沒換瓶、或醫囑停了還在滴（護理站「點滴」分頁）', route: 'nursing', icon: Droplet, urgent: true },
    { roles: ['nurse'], label: 'PCA 紀錄逾時', count: s.value.pcaRecordOverdue, hint: 'PCA 每 4 小時要記按壓、用量、疼痛、鎮靜、呼吸（全院；護理站「PCA」分頁）', route: 'nursing', icon: Droplet, urgent: true },
    { roles: ['nurse'], label: '別人請我換班', count: s.value.swapToRespond ?? 0, hint: '同事想和你換班：到「護理排班」同意或不同意', route: 'nurse-schedule', icon: Droplet, urgent: true },
    { roles: ['nurse'], label: '換班請假有結果', count: s.value.myRequestResults ?? 0, hint: '你的換班或請假申請最近 24 小時有結果（核准、退回、對方不同意）', route: 'nurse-schedule', icon: Droplet },
    { roles: ['nurse', 'admin'], label: '換班請假待核准', count: s.value.shiftRequestsToApprove ?? 0, hint: '護理師的換班（對方已同意）與請假申請：到「護理排班」核准或退回', route: 'nurse-schedule', icon: Droplet, urgent: true },
    { roles: ['nurse', 'admin'], label: '出院準備待篩選', count: s.value.planScreenDue ?? 0, hint: '入院 72 小時內要做出院準備篩選：快到期或已逾時的（全院）', route: 'discharge-plan', icon: Droplet },
    { roles: ['nurse', 'admin'], label: '出院後待電話追蹤', count: s.value.planFollowUp ?? 0, hint: '出院準備收案的病人出院後 7 天內電話追蹤', route: 'discharge-plan', icon: Droplet, urgent: true },
    { roles: ['nurse'], label: '約束查核逾時', count: s.value.restraintCheckOverdue, hint: '約束中每 2 小時查末梢循環、皮膚、是否還需要（全院，護理站「譫妄與約束」分頁）', route: 'nursing', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: '譫妄陽性待確認', count: s.value.deliriumPositive ?? 0, hint: '護理師 CAM 評估陽性：請查找原因（感染、藥物、電解質）並確認（住院醫囑「譫妄與約束」分頁）', route: 'ipd', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: '約束醫囑待補或到期', count: s.value.restraintOrder ?? 0, hint: '緊急約束 1 小時內要補醫囑；約束醫囑每次最長 24 小時，到期請續開或解除', route: 'ipd', icon: Droplet, urgent: true },
    { roles: ['nurse'], label: '營養篩檢', count: s.value.nutritionScreenDue, hint: '入院 48 小時內要做營養篩檢：快到期或已逾時的（全院，護理站「營養」分頁）', route: 'nursing', icon: Droplet },
    { roles: ['diet'], label: '營養師待評估', count: s.value.nutritionToAssess ?? 0, hint: '營養篩檢 ≥3 分、還沒評估的住院病人', route: 'nutrition', icon: Droplet, urgent: true },
    { roles: ['doctor'], label: '營養評估待已閱', count: s.value.nutritionUnseen ?? 0, hint: '營養師對你的住院病人寫了評估與建議：請看過按已閱（住院醫囑「營養」分頁）', route: 'ipd', icon: Droplet },
    { roles: ['nurse'], label: '輸血待處理', count: s.value.transfusionTodo, hint: '已發血待床邊核對輸血、輸血中該量 15 分鐘生命徵象（全院）', route: 'nursing', icon: Droplet, urgent: true },
    { roles: ['lab'], label: '待檢驗', count: s.value.labWork ?? 0, hint: '門診已批價、住院已採檢的，登打後發報告', route: 'lab', icon: FlaskConical, urgent: true },
    { roles: ['doctor'], label: '待確認報告', count: (s.value.labAcks ?? 0) + (s.value.imagingAcks ?? 0), hint: '檢驗危急值、影像重要發現或更正補充過的報告，在上方清單按「已知悉」', route: 'home', icon: FlaskConical, urgent: true },
    { roles: ['doctor'], label: '顯影劑後暫停 Metformin', count: s.value.metforminAlerts ?? 0, hint: '病人做完含顯影劑檢查、腎功能不好：暫停 Metformin 48 小時、複查腎功能（住院醫囑的病人分頁「檢查」按已處理）', route: 'ipd', icon: ScanLine, urgent: !!s.value.metforminAlerts },
    { roles: ['doctor'], label: '影像檢查病人未到', count: s.value.examNoShow ?? 0, hint: s.value.examNoShowText ? `${s.value.examNoShowText}：櫃台可改期，需要的話聯絡病人` : '門診病人過了排程 30 分鐘沒到影像檢查室', route: 'imaging', icon: ScanLine, urgent: !!s.value.examNoShow },
    { roles: ['doctor'], label: '待判讀影像', count: s.value.imagingWork ?? 0, hint: '放射科：X 光、超音波、電腦斷層；其他醫師：自己開的心電圖', route: 'imaging', icon: ScanLine },
    { roles: ['doctor'], label: '管制性抗生素待審核', count: s.value.abxPending ?? 0, hint: s.value.abxOverdue ? `其中 ${s.value.abxOverdue} 筆超過 48 小時` : '感染科：先用後審，開立後 48 小時內審核', route: 'abx', icon: ShieldAlert, urgent: !!s.value.abxOverdue },
    { roles: ['doctor'], label: '抗生素審核未通過', count: s.value.abxRejected ?? 0, hint: '我的住院病人：感染科不核准，請停藥、改藥或申覆（在住院醫囑）', route: 'ipd', icon: ShieldAlert, urgent: true },
    { roles: ['doctor'], label: '抗生素每日審視', count: s.value.abxSteward ?? 0, hint: '感染科：系統標出可降階、改口服、無效、重疊、超過 7 天的抗生素，發出建議或標不用介入', route: 'abx', query: { tab: 'steward' }, icon: ShieldAlert },
    { roles: ['doctor'], label: '抗生素建議待回覆', count: s.value.abxAdvice ?? 0, hint: '我的住院病人：感染科的抗生素建議（在住院醫囑停止或修改＝接受；不接受要寫原因）', route: 'ipd', icon: ShieldAlert },
    { roles: ['nurse', 'pharmacist'], label: '居家用藥待建清單', count: s.value.medRecToBuild ?? 0, hint: s.value.medRecToBuildLate ? `其中 ${s.value.medRecToBuildLate} 位入院超過 24 小時` : '新住院病人：在病人分頁「用藥整合」建居家用藥清單（自動帶入門診處方）', route: 'nursing', icon: Pill, urgent: !!s.value.medRecToBuildLate },
    { roles: ['doctor'], label: '用藥整合待決定', count: s.value.medRecToDecide ?? 0, hint: s.value.medRecLate ? `其中 ${s.value.medRecLate} 位入院超過 24 小時` : '我的住院病人：居家用藥逐項決定續用、暫停或改藥（住院醫囑「用藥整合」分頁）', route: 'ipd', icon: Pill, urgent: !!s.value.medRecLate },
    { roles: ['radtech'], label: '檢查室：已報到待檢查', count: s.value.examArrived ?? 0, hint: s.value.examWaiting ? `今天還有 ${s.value.examWaiting} 筆排了還沒報到` : '病人報到後逐項確認檢查前準備、做完按「完成」（含顯影劑記用量與反應）', route: 'exam', icon: ScanLine },
    { roles: ['clerk', 'doctor'], label: '檢查室停機需改期', count: s.value.examNeedsReschedule ?? 0, hint: '排在檢查室停機（故障、保養）時段、還沒報到的檢查：在影像檢查室按「排到下一個空檔」或改時間', route: 'exam', icon: ScanLine, urgent: true },
    { roles: ['clerk', 'doctor'], label: '影像待排程', count: s.value.examToSchedule ?? 0, hint: s.value.examToday ? `今天已排 ${s.value.examToday} 筆還沒做完` : '門診批價後、住院開立後的影像：排檢查室與時間（影像檢查室）', route: 'exam', icon: ScanLine },
    { roles: ['lab'], label: '今日品管未通過', count: s.value.qcPending ?? 0, hint: s.value.qcRejected ? `其中 ${s.value.qcRejected} 項被拒絕：矯正後重做，通過前不能發這項報告` : '今天還沒做品管的項目不能發報告（檢驗頁「品管」）', route: 'lab', query: { tab: 'qc' }, icon: FlaskConical, urgent: !!s.value.qcRejected },
    { roles: ['lab'], label: '檢驗逾時未發', count: s.value.tatLate ?? 0, hint: s.value.tatWarn ? `另有 ${s.value.tatWarn} 筆快逾時（急件 60 分、一般 240 分）` : '從開立（門診從批價）到發報告：急件 60 分鐘、一般 240 分鐘', route: 'lab', icon: FlaskConical, urgent: !!s.value.tatLate },
    { roles: ['lab'], label: '危急值待通報', count: s.value.calloutPending ?? 0, hint: s.value.calloutLate ? `其中 ${s.value.calloutLate} 筆已超過 30 分鐘：立刻打電話通報並記錄` : '發出後 30 分鐘內打電話通報病房或開立醫師，記受話者與複誦', route: 'lab', icon: FlaskConical, urgent: !!s.value.calloutPending },
    { roles: ['lab'], label: '儀器結果待審核', count: s.value.analyzerHeld ?? 0, hint: '沒通過自動審核（品管、危急值、差異檢查、超出可測範圍）：確認發出或重測', route: 'lab', query: { tab: 'analyzer' }, icon: FlaskConical },
    { roles: ['lab'], label: '抽血櫃台待採檢', count: s.value.deskToCollect ?? 0, hint: '已批價的門診檢驗：報到取號、印條碼、採檢（尿液痰液發容器等交回）', route: 'lab', query: { tab: 'desk' }, icon: FlaskConical },
    { roles: ['lab'], label: '檢體待收件', count: s.value.specimenToReceive ?? 0, hint: s.value.specimenLate ? `其中 ${s.value.specimenLate} 支採檢超過 60 分鐘` : '護理站、抽血櫃台已採檢的檢體：掃條碼收件後才能登打', route: 'lab', icon: FlaskConical, urgent: !!s.value.specimenLate },
    { roles: ['nurse'], label: '今天待採檢', count: s.value.labToCollect ?? 0, hint: '住院檢驗（含長期檢驗今天到期的）：在病人分頁「檢體」印條碼、採檢', route: 'nursing', icon: FlaskConical },
    { roles: ['nurse'], label: '急診檢驗待床邊採檢', count: s.value.erLabToCollect ?? 0, hint: '急診醫師已送出的檢驗：在急診看板按「檢驗」印條碼、採檢（不用先批價）', route: 'er', icon: FlaskConical, urgent: true },
    { roles: ['nurse'], label: '檢體退件待重新採檢', count: s.value.specimenRecollect ?? 0, hint: '檢驗科退件（溶血、量不足…）：在病人分頁「檢體」重新印條碼、採檢', route: 'nursing', icon: FlaskConical, urgent: true },
    { roles: ['doctor'], label: '藥師建議待回覆', count: s.value.pharmCareToReply ?? 0, hint: '我的住院病人：臨床藥師查房的建議（劑量、監測、停藥…），在住院醫囑「藥事照護」分頁接受或不接受', route: 'ipd', icon: Pill },
    { roles: ['doctor'], label: '藥師疑義待回覆', count: s.value.pharmQueries ?? 0, hint: '我的住院病人：藥師對醫囑有疑義，回覆前暫停給藥；在住院醫囑修改、停止或寫理由維持', route: 'ipd', icon: Pill, urgent: true },
    { roles: ['doctor'], label: '預防性抗生素超過 24 小時', count: s.value.prophylaxisDue ?? 0, hint: '我的住院病人：手術結束滿 24 小時，術前連的抗生素還在用，請在住院醫囑停止（已有感染請寫明療程）', route: 'ipd', icon: ShieldAlert },
    { roles: ['doctor'], label: 'Vancomycin 谷濃度異常', count: s.value.tdmAlerts ?? 0, hint: '我的住院病人：谷濃度過高或過低，請在住院醫囑修改劑量或頻率', route: 'ipd', icon: ShieldAlert, urgent: true },
    { roles: ['doctor'], label: '抗生素核准天數將到', count: s.value.abxExtend ?? 0, hint: '我的住院病人：核准天數快到或已超過，要續用請在住院醫囑申請', route: 'ipd', icon: ShieldAlert },
    { roles: ['doctor'], label: '待回覆會診', count: s.value.consultIncoming ?? 0, hint: s.value.consultUrgent ? `其中急會診 ${s.value.consultUrgent} 張` : '他科請本科會診的住院病人', route: 'ipd', icon: Stethoscope, urgent: !!s.value.consultUrgent },
    { roles: ['doctor'], label: '轉入申請', count: s.value.transferIncoming ?? 0, hint: '他科申請轉入本科的住院病人，待接受', route: 'ipd', icon: Stethoscope, urgent: true },
    { roles: ['doctor'], label: '待回覆門診會診', count: s.value.opdConsultIncoming ?? 0, hint: '他科看診時請本科書面會診（病人不必在場）', route: 'opd', icon: Stethoscope, urgent: true },
    { roles: ['doctor'], label: '轉診待回覆', count: s.value.referralReplies ?? 0, hint: '持外院轉診單、已看完診，請開轉診回覆單給原院所', route: 'opd', icon: Stethoscope },
    { roles: ['doctor'], label: '會診已回覆', count: s.value.consultReplies ?? 0, hint: '我申請的門診會診已回覆，看過按已閱', route: 'opd', icon: Stethoscope },
    { roles: ['doctor'], label: '會診醫師新開的醫囑', count: s.value.consultOrdersUnseen ?? 0, hint: '我的住院病人：會診醫師開了醫囑，看過後按「已閱」', route: 'ipd', icon: Stethoscope, urgent: true },
    { roles: ['doctor'], label: '護理師醫囑疑問', count: s.value.orderQueries ?? 0, hint: '我的住院病人，待回覆（回覆前給藥暫停）', route: 'ipd', icon: Stethoscope, urgent: true },
    { roles: ['doctor'], label: '我的候診病人', count: myWaiting.value, hint: '今日全部診次・含看診中', route: 'opd', icon: Stethoscope },
    { roles: ['clerk'], label: '待批價', count: s.value.opd.toCharge, hint: '看診完成，等待結帳', route: 'charge', icon: Receipt },
    { roles: ['clerk'], label: '住院待結帳', count: s.value.ipdToBill, hint: '醫師已簽准出院：結清住院費用後才能辦出院', route: 'charge', query: { tab: 'ipd' }, icon: Receipt, urgent: true },
    { roles: ['admin', 'nurse'], label: '急刀待入刀房', count: s.value.emergencyWaiting ?? 0, hint: s.value.emergencyOverdue ? `其中 ${s.value.emergencyOverdue} 台已超過時限（立即 1 小時、緊急 6 小時、次緊急 24 小時）` : '緊急手術：排房（可排在開放時段外、撞到的擇期改期）、送手術室', route: 'or', icon: ShieldAlert, urgent: !!s.value.emergencyOverdue },
    { roles: ['admin', 'nurse', 'doctor'], label: 'RCA 行動計畫過期', count: s.value.rcaOverdue ?? 0, hint: '根本原因分析的改善行動過了期限還沒完成：追蹤負責人、完成後在病安通報勾完成', route: 'incidents', icon: ShieldAlert, urgent: true },
    { roles: ['admin', 'nurse', 'doctor'], label: '病安事件待審查', count: s.value.incidentPending ?? 0, hint: '病安通報還沒結案的：評定嚴重度、寫原因分析與改善措施', route: 'incidents', icon: ShieldAlert },
    { roles: ['clerk'], label: '醫師建議回診待預約', count: s.value.adviceToBook ?? 0, hint: s.value.adviceOverdue ? `其中 ${s.value.adviceOverdue} 位過了建議日一週還沒掛` : '醫師寫了「幾週後回診」交給櫃台：電話聯絡病人掛號，或標病人自己掛、不回診', route: 'booking', query: { tab: 'advice' }, icon: PhoneCall, urgent: !!s.value.adviceOverdue },
    { roles: ['clerk'], label: '預約未到待追蹤', count: s.value.noShowsToFollow, hint: '出院後回診、醫師約的回診、慢性病的預約沒來：電話聯絡、改約', route: 'booking', query: { tab: 'noshow' }, icon: PhoneCall, urgent: true },
    { roles: ['clerk'], label: '建議期中繳款', count: s.value.ipdInterim, hint: '住很久、累計費用很多的住院病人：可以先收一部分，出院結帳時扣抵', route: 'charge', query: { tab: 'ipd' }, icon: Receipt },
    { roles: ['clerk'], label: '待退費', count: s.value.pendingRefunds, hint: '部分退藥、檢驗處置未執行後，退還病人差額（可能是前幾天看的診）', route: 'charge', icon: Receipt, urgent: true },
    { roles: ['clerk'], label: '停診待通知', count: s.value.suspendNoticesPending, hint: '停診退掛的病人，需電話通知', route: 'booking', icon: PhoneCall, urgent: true },
    { roles: ['pharmacist'], label: '出院帶藥待調劑', count: s.value.dischargeRxToDispense, hint: '醫師已簽准出院：調好後櫃台才能結帳', route: 'ud', icon: Pill, urgent: true },
    { roles: ['pharmacist'], label: '住院醫囑待審核', count: s.value.pharmReview ?? 0, hint: s.value.pharmReviewStat ? `其中 ${s.value.pharmReviewStat} 筆臨時醫囑（先給後審）` : '長期醫囑審核通過才能每日調劑；系統已列出過敏、交互作用、劑量、腎功能等問題', route: 'ud', query: { tab: 'review' }, icon: Pill, urgent: !!s.value.pharmReviewStat },
    { roles: ['pharmacist'], label: '藥物不良反應待評估', count: s.value.adrPending ?? 0, hint: s.value.adrUrgent ? `其中 ${s.value.adrUrgent} 筆嚴重型（過敏性休克、SJS），24 小時內要評估` : '醫師、護理師通報的不良反應：用 Naranjo 量表評估因果，很可能以上可加入過敏', route: 'ud', query: { tab: 'adr' }, icon: Pill, urgent: !!s.value.adrUrgent },
    { roles: ['pharmacist'], label: '住院補調劑', count: s.value.udExtra, hint: '今天的劑量還沒調劑（新開的醫囑），護理師在等', route: 'ud', icon: Pill, urgent: true },
    { roles: ['pharmacist'], label: '住院待核對', count: s.value.udVerify, hint: '已調劑的藥盒，核對通過才送病房', route: 'ud', icon: Pill, urgent: true },
    { roles: ['pharmacist'], label: '住院待退藥', count: s.value.udReturns, hint: '病房已送回，待點收入庫', route: 'ud', icon: Pill },
    { roles: ['pharmacist'], label: '病房回報不符', count: s.value.udIssues, hint: '藥車點收時發現短少、破損，待藥局處理', route: 'ud', icon: AlertTriangle, urgent: true },
    { roles: ['nurse'], label: '藥車待點收', count: s.value.udToReceive, hint: '藥局已核對送出的藥盒（全院），在護理站本班待辦點收', route: 'nursing', icon: Pill },
    { roles: ['pharmacist'], label: '病房常備待補充', count: s.value.wardRefillDue, hint: '各病房低於基準量的品項，在住院藥局補充', route: 'ud', icon: Pill },
    { roles: ['nurse'], label: '本班未點班', count: s.value.wardCountDue, hint: '病房常備還沒點班的病房（全院），在護理站「常備點班」', route: 'nursing', query: { tab: 'stock' }, icon: Pill },
    { roles: ['nurse'], label: '風險評估逾時', count: s.value.riskOverdue, hint: '跌倒、壓傷評估過了期限（全院）：入院 24 小時內、高風險每天、轉床轉科後', route: 'nursing', icon: ShieldAlert, urgent: true },
    { roles: ['nurse'], label: '待送回藥局', count: s.value.udSendBack, hint: '沒給的 UD 藥（含出院病人），在護理站本班待辦送回', route: 'nursing', icon: Pill },
    { roles: ['pharmacist'], label: '待領藥', count: s.value.opd.toDispense, hint: '已批價，等待調劑發藥', route: 'pharmacy', icon: Pill },
    { roles: ['nurse'], label: '逾時未給藥', count: s.value.ipd.overdueMar, hint: '已過預定時間尚未執行', route: 'nursing', icon: AlertTriangle, urgent: true },
    { roles: ['clerk', 'nurse'], label: '今日待報到住院', count: s.value.ipd.reservedToday, hint: '預約入院日為今天或更早（含逾期未報到）', route: 'admission', icon: DoorOpen },
    { roles: ['pharmacist'], label: '缺貨或低於安全庫存', count: s.value.lowStockDrugs, hint: '門診藥局需要補貨的藥品', route: 'drugs', query: { filter: 'short' }, icon: Package, urgent: true },
    { roles: ['pharmacist'], label: '補貨申請待到貨', count: s.value.restockOpen, hint: '已申請、還沒到貨入庫', route: 'drugs', query: { filter: 'restock' }, icon: Truck },
    ...(s.value.transferRequested !== undefined
      ? [
          { roles: ['pharmacist'], label: '撥補待撥發', count: s.value.transferRequested, hint: '藥局請領、等藥庫撥發', route: 'drugs', query: { tab: 'transfer' }, icon: Truck },
          { roles: ['pharmacist'], label: '撥補待簽收', count: s.value.transferIssued ?? 0, hint: '運送中，簽收才入帳', route: 'drugs', query: { tab: 'transfer' }, icon: Truck },
          { roles: ['pharmacist'], label: '退回待藥庫審核', count: s.value.returnToReview ?? 0, hint: '藥局申請退回藥庫，藥庫逐批同意、少收或不收', route: 'drugs', query: { tab: 'transfer' }, icon: Truck },
          { roles: ['pharmacist'], label: '退回已核准待送出', count: s.value.returnToShip ?? 0, hint: '藥庫已同意，藥局送出才扣帳', route: 'drugs', query: { tab: 'transfer' }, icon: Truck },
        ]
      : []),
    { roles: ['pharmacist'], label: '採購單待到貨', count: s.value.purchaseOrdered, hint: '已核准訂購，貨到了對品項入庫', route: 'drugs', query: { tab: 'purchase' }, icon: Truck },
    // 管理員唯一的待辦：核准採購（開單與核准分開，是給管理員做的事）
    { roles: ['admin'], label: '採購單待核准', count: s.value.purchasePending, hint: '藥師送出、等核准才算訂購', route: 'drugs', query: { tab: 'purchase' }, icon: Truck, urgent: true },
  ]
  // 管理員不做第一線作業，下方指標卡已涵蓋其他數字；只列「核准採購」這種只有管理員能做的事
  return list.filter((t) => t.roles.includes(role ?? ''))
})

const trend = computed(() =>
  (s.value?.trend ?? []).map((t) => ({ label: t.date.slice(5).replace('-', '/'), title: t.date, value: t.count })),
)
const deptMax = computed(() => Math.max(1, ...(s.value?.byDept ?? []).map((d) => d.count)))
</script>

<template>
  <div v-if="s" class="space-y-5">
    <!-- 待核准優免：有「可核准優免」的人才查（主管在首頁直接核准，不必到櫃台） -->
    <DiscountRequestsCard v-if="can('charge.approveDiscount')" />
    <!-- 待確認的檢驗報告（危急值、更正）：醫師在首頁直接確認 -->
    <LabAcksCard v-if="auth.user?.role === 'doctor'" />
    <!-- 我的待辦 -->
    <section v-if="todos.length">
      <h2 class="mb-2 text-sm font-semibold text-slate-600">{{ auth.user?.name }}，您目前的待辦</h2>
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <button
          v-for="t in todos"
          :key="t.label"
          :class="[
            'group flex items-center gap-3 rounded-lg border bg-white p-4 text-left shadow-sm transition hover:shadow',
            t.urgent && t.count > 0 ? 'border-red-200 hover:border-red-300' : 'border-slate-200 hover:border-brand-300',
          ]"
          @click="router.push({ name: t.route, query: t.query })"
        >
          <div :class="['rounded-md p-2', t.urgent && t.count > 0 ? 'bg-red-50 text-red-600' : 'bg-brand-50 text-brand-600']">
            <component :is="t.icon" class="h-5 w-5" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-sm text-slate-600">{{ t.label }}</div>
            <div class="text-xs text-slate-400">{{ t.hint }}</div>
          </div>
          <div :class="['tabular text-2xl font-semibold', t.urgent && t.count > 0 ? 'text-red-600' : 'text-slate-800']">{{ t.count }}</div>
          <ChevronRight class="h-4 w-4 text-slate-300 group-hover:text-slate-500" />
        </button>
      </div>
    </section>

    <!-- 門診指標 -->
    <section class="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <UStatCard label="今日掛號" :value="s.opd.total" :hint="`候診 ${s.opd.waiting}・看診中 ${s.opd.inConsult}・退掛 ${s.opd.cancelled}`" :icon="Users" />
      <UStatCard label="待批價" :value="s.opd.toCharge" hint="看診完成未結帳" :icon="Receipt" tone="amber" />
      <UStatCard label="待領藥" :value="s.opd.toDispense" hint="已批價未發藥" :icon="Pill" tone="amber" />
      <!-- 今日收入只有掛號批價與管理員看得到：其他角色服務層不回傳這筆資料 -->
      <UStatCard v-if="s.revenue" label="今日收入" :value="money(s.revenue.patientTotal)" :hint="`${s.revenue.receipts} 張收據・申報 ${s.revenue.nhiPoints.toLocaleString()} 點`" :icon="Coins" tone="emerald" />
    </section>

    <!-- 住院與藥品指標 -->
    <section class="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <UStatCard label="住院中" :value="s.ipd.admitted" :hint="`今日待報到 ${s.ipd.reservedToday} 人`" :icon="BedDouble" />
      <UStatCard label="可用空床" :value="`${s.ipd.emptyBeds} / ${s.ipd.totalBeds}`" hint="不含清潔中、保留床" :icon="ClipboardCheck" tone="emerald" />
      <UStatCard label="逾時未給藥" :value="s.ipd.overdueMar" :hint="s.ipd.overdueMar ? '請護理站儘速處理' : '目前沒有逾時'" :icon="AlertTriangle" :tone="s.ipd.overdueMar ? 'red' : 'slate'" />
      <UStatCard label="缺貨或低於安全庫存" :value="s.lowStockDrugs" hint="門診藥局的藥品品項數" :icon="Package" :tone="s.lowStockDrugs ? 'amber' : 'slate'" />
    </section>

    <!-- 圖表 -->
    <section class="grid grid-cols-1 gap-4 lg:grid-cols-5">
      <UCard title="近 7 日門診人次" subtitle="不含退掛" class="lg:col-span-3">
        <UBarChart :data="trend" unit="人" :height="220" />
      </UCard>
      <UCard title="今日各科掛號" subtitle="不含退掛" class="lg:col-span-2">
        <UEmpty v-if="!s.byDept.length" title="今天還沒有掛號" />
        <!-- 類別少、只比大小：橫條最直接；數值以文字直接標示 -->
        <ul v-else class="space-y-2.5">
          <li v-for="d in s.byDept" :key="d.deptName" class="grid grid-cols-[4.5rem_1fr_2rem] items-center gap-2 text-sm">
            <span class="truncate text-slate-600">{{ d.deptName }}</span>
            <div class="h-3 rounded-r bg-slate-100">
              <div class="h-3 rounded-r bg-brand-600" :style="{ width: `${(d.count / deptMax) * 100}%` }" />
            </div>
            <span class="tabular text-right font-medium text-slate-700">{{ d.count }}</span>
          </li>
        </ul>
      </UCard>
    </section>
  </div>
</template>
