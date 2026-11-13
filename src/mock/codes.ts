// 參考代碼表（科別、身分、ICD-10、藥品、醫令、頻率、預防保健項目）。
// 皆為展示用資料：藥品代碼、醫令點數為近似值，不代表現行健保給付標準。
import type {
  BillingSettings,
  DiscountRule,
  Department,
  Doctor,
  Drug, DrugTiming,
  Frequency,
  IcdCode,
  Identity,
  PreventItem,
  Procedure,
} from '@/types'

export const departments: Department[] = [
  // 代碼依慣例：FM＝Family Medicine。以前寫成 IM（一般指內科），又和給藥途徑 IM（肌肉注射）同名。
  // 內科維持 MED，不改成 IM——用過的代碼不重新指派，免得舊資料、匯出檔裡的 IM 意思變了
  { id: 'D01', code: 'FM', name: '家醫科', active: true },
  { id: 'D02', code: 'MED', name: '內科', active: true },
  { id: 'D03', code: 'SUR', name: '外科', active: true },
  { id: 'D04', code: 'PED', name: '小兒科', active: true },
  { id: 'D05', code: 'OBG', name: '婦產科', active: true },
  { id: 'D06', code: 'ORT', name: '骨科', active: true },
  { id: 'D07', code: 'ENT', name: '耳鼻喉科', active: true },
  { id: 'D08', code: 'REH', name: '復健科', active: true },
]

export const doctors: Doctor[] = [
  { id: 'DR01', name: '林子謙', deptId: 'D01', title: '主治醫師', licenseNo: 'A100231', active: true },
  { id: 'DR02', name: '陳映如', deptId: 'D02', title: '主任', licenseNo: 'A100452', active: true },
  { id: 'DR03', name: '黃柏翰', deptId: 'D02', title: '主治醫師', licenseNo: 'A100873', active: true },
  { id: 'DR04', name: '張皓宇', deptId: 'D03', title: '主治醫師', licenseNo: 'A101094', active: true },
  { id: 'DR05', name: '吳佳穎', deptId: 'D04', title: '主治醫師', licenseNo: 'A101315', active: true },
  { id: 'DR06', name: '劉書妤', deptId: 'D05', title: '主治醫師', licenseNo: 'A101536', active: true },
  { id: 'DR07', name: '蔡承恩', deptId: 'D06', title: '主治醫師', licenseNo: 'A101757', active: true },
  { id: 'DR08', name: '鄭雅婷', deptId: 'D07', title: '主治醫師', licenseNo: 'A101978', active: true },
  { id: 'DR09', name: '許立群', deptId: 'D08', title: '主治醫師', licenseNo: 'A102199', active: true },
]

export const identities: Identity[] = [
  { code: '01', name: '健保一般', regFee: 150, copayExempt: false, selfPay: false },
  { code: '02', name: '榮民', regFee: 50, copayExempt: true, selfPay: false },
  { code: '03', name: '低收入戶', regFee: 0, copayExempt: true, selfPay: false },
  { code: '04', name: '重大傷病', regFee: 150, copayExempt: true, selfPay: false },
  { code: '05', name: '身心障礙', regFee: 50, copayExempt: false, selfPay: false },
  { code: '06', name: '兒童（未滿 3 歲）', regFee: 100, copayExempt: true, selfPay: false },
  { code: '09', name: '自費', regFee: 200, copayExempt: false, selfPay: true },
]

/**
 * 優免類別（展示用）。低收入戶不在這裡：它是健保的「就醫身分」（掛號費 0、免部分負擔），不是院內優免。
 */
export const discounts: DiscountRule[] = [
  { code: 'DC01', name: '員工', regMode: 'all', regAmount: 0, selfPayRate: 80, needsReason: false, active: true },
  { code: 'DC02', name: '員工眷屬', regMode: 'amount', regAmount: 50, selfPayRate: 90, needsReason: false, active: true },
  { code: 'DC03', name: '志工', regMode: 'all', regAmount: 0, selfPayRate: 100, needsReason: false, active: true },
  { code: 'DC04', name: '社福個案', regMode: 'all', regAmount: 0, selfPayRate: 50, needsReason: true, active: true },
  { code: 'DC05', name: '專案減免', regMode: 'all', regAmount: 0, selfPayRate: 100, needsReason: true, needsApproval: true, active: true },
]

/** 收費參數預設值（展示用的簡化規則） */
export const billingSettings: BillingSettings = { basicCopay: 80, drugCopayFreeUpTo: 100, drugCopayStep: 100, drugCopayPerStep: 20, drugCopayMax: 200 }

export const caseTypes = [
  { code: '01', name: '西醫一般案件' },
  { code: '04', name: '西醫慢性病' },
  { code: '08', name: '慢性病連續處方調劑' },
  { code: 'A3', name: '預防保健' },
  { code: 'B6', name: '職業傷害' },
  { code: 'E1', name: '急診' },
]

export const routes = [
  { code: 'PO', name: '口服' },
  { code: 'EXT', name: '外用' },
  { code: 'IV', name: '靜脈注射' },
  { code: 'IM', name: '肌肉注射' },
  { code: 'SC', name: '皮下注射' },
  { code: 'INHL', name: '吸入' },
  { code: 'OU', name: '雙眼' },
]

export const frequencies: Frequency[] = [
  { code: 'QD', label: '每日一次', timesPerDay: 1, times: ['09:00'] },
  { code: 'BID', label: '每日兩次', timesPerDay: 2, times: ['09:00', '17:00'] },
  { code: 'TID', label: '每日三次', timesPerDay: 3, times: ['09:00', '13:00', '17:00'] },
  { code: 'QID', label: '每日四次', timesPerDay: 4, times: ['09:00', '13:00', '17:00', '21:00'] },
  { code: 'HS', label: '睡前', timesPerDay: 1, times: ['21:00'] },
  { code: 'Q6H', label: '每 6 小時', timesPerDay: 4, times: ['00:00', '06:00', '12:00', '18:00'] },
  { code: 'Q8H', label: '每 8 小時', timesPerDay: 3, times: ['06:00', '14:00', '22:00'] },
  { code: 'Q12H', label: '每 12 小時', timesPerDay: 2, times: ['09:00', '21:00'] },
  { code: 'PRN', label: '需要時', timesPerDay: 1, times: [] },
  { code: 'STAT', label: '立即一次', timesPerDay: 1, times: [] },
]

export const icdCodes: IcdCode[] = [
  { code: 'J00', name: '急性鼻咽炎（感冒）', nameEn: 'Acute nasopharyngitis' },
  { code: 'J02.9', name: '急性咽炎', nameEn: 'Acute pharyngitis, unspecified' },
  { code: 'J03.90', name: '急性扁桃腺炎', nameEn: 'Acute tonsillitis, unspecified' },
  { code: 'J06.9', name: '急性上呼吸道感染', nameEn: 'Acute upper respiratory infection' },
  { code: 'J20.9', name: '急性支氣管炎', nameEn: 'Acute bronchitis, unspecified' },
  { code: 'J30.9', name: '過敏性鼻炎', nameEn: 'Allergic rhinitis, unspecified' },
  { code: 'J45.909', name: '氣喘', nameEn: 'Unspecified asthma, uncomplicated' },
  { code: 'J18.9', name: '肺炎', nameEn: 'Pneumonia, unspecified organism' },
  { code: 'I10', name: '原發性高血壓', nameEn: 'Essential (primary) hypertension' },
  { code: 'I25.10', name: '冠狀動脈粥狀硬化心臟病', nameEn: 'Atherosclerotic heart disease' },
  { code: 'I48.91', name: '心房顫動', nameEn: 'Unspecified atrial fibrillation' },
  { code: 'E11.9', name: '第二型糖尿病，無併發症', nameEn: 'Type 2 diabetes mellitus without complications' },
  { code: 'E11.65', name: '第二型糖尿病伴高血糖', nameEn: 'Type 2 diabetes mellitus with hyperglycemia' },
  { code: 'E78.5', name: '高血脂症', nameEn: 'Hyperlipidemia, unspecified' },
  { code: 'E03.9', name: '甲狀腺功能低下', nameEn: 'Hypothyroidism, unspecified' },
  { code: 'E66.9', name: '肥胖', nameEn: 'Obesity, unspecified' },
  { code: 'K21.9', name: '胃食道逆流', nameEn: 'Gastro-esophageal reflux disease' },
  { code: 'K29.70', name: '胃炎', nameEn: 'Gastritis, unspecified' },
  { code: 'K59.00', name: '便秘', nameEn: 'Constipation, unspecified' },
  { code: 'A09', name: '感染性腸胃炎', nameEn: 'Infectious gastroenteritis and colitis' },
  { code: 'K35.80', name: '急性闌尾炎', nameEn: 'Acute appendicitis' },
  { code: 'K80.20', name: '膽結石', nameEn: 'Calculus of gallbladder' },
  { code: 'N39.0', name: '泌尿道感染', nameEn: 'Urinary tract infection' },
  { code: 'N18.3', name: '慢性腎臟病第三期', nameEn: 'Chronic kidney disease, stage 3' },
  { code: 'M54.5', name: '下背痛', nameEn: 'Low back pain' },
  { code: 'M17.11', name: '右膝原發性退化性關節炎', nameEn: 'Primary osteoarthritis, right knee' },
  { code: 'M17.12', name: '左膝原發性退化性關節炎', nameEn: 'Primary osteoarthritis, left knee' },
  { code: 'M75.100', name: '旋轉肌袖症候群', nameEn: 'Rotator cuff syndrome' },
  { code: 'M79.1', name: '肌肉痛', nameEn: 'Myalgia' },
  { code: 'M81.0', name: '停經後骨質疏鬆', nameEn: 'Age-related osteoporosis' },
  { code: 'S93.401A', name: '右踝扭傷', nameEn: 'Sprain of right ankle, initial' },
  { code: 'S52.501A', name: '右橈骨遠端骨折', nameEn: 'Fracture of lower end of right radius' },
  { code: 'S61.411A', name: '右手撕裂傷', nameEn: 'Laceration of right hand' },
  { code: 'L30.9', name: '皮膚炎', nameEn: 'Dermatitis, unspecified' },
  { code: 'L50.9', name: '蕁麻疹', nameEn: 'Urticaria, unspecified' },
  { code: 'H10.9', name: '結膜炎', nameEn: 'Conjunctivitis, unspecified' },
  { code: 'H66.90', name: '中耳炎', nameEn: 'Otitis media, unspecified' },
  { code: 'J01.90', name: '急性鼻竇炎', nameEn: 'Acute sinusitis, unspecified' },
  { code: 'H81.10', name: '良性陣發性姿勢性眩暈', nameEn: 'Benign paroxysmal vertigo' },
  { code: 'G43.909', name: '偏頭痛', nameEn: 'Migraine, unspecified' },
  { code: 'R51.9', name: '頭痛', nameEn: 'Headache, unspecified' },
  { code: 'R50.9', name: '發燒', nameEn: 'Fever, unspecified' },
  { code: 'R10.9', name: '腹痛', nameEn: 'Unspecified abdominal pain' },
  { code: 'R05.9', name: '咳嗽', nameEn: 'Cough, unspecified' },
  { code: 'F41.9', name: '焦慮症', nameEn: 'Anxiety disorder, unspecified' },
  { code: 'G47.00', name: '失眠', nameEn: 'Insomnia, unspecified' },
  { code: 'N94.6', name: '經痛', nameEn: 'Dysmenorrhea, unspecified' },
  { code: 'O80', name: '單胎自然生產', nameEn: 'Encounter for full-term uncomplicated delivery' },
  { code: 'Z34.90', name: '正常妊娠之監督', nameEn: 'Supervision of normal pregnancy' },
  { code: 'Z00.00', name: '成人健康檢查', nameEn: 'General adult medical examination' },
  { code: 'Z00.129', name: '兒童例行健康檢查', nameEn: 'Routine child health examination' },
  { code: 'Z23', name: '預防接種', nameEn: 'Encounter for immunization' },
  { code: 'Z12.4', name: '子宮頸癌篩檢', nameEn: 'Screening for malignant neoplasm of cervix' },
  { code: 'Z12.31', name: '乳癌篩檢', nameEn: 'Screening mammogram' },
  { code: 'Z12.11', name: '大腸癌篩檢', nameEn: 'Screening for malignant neoplasm of colon' },
  { code: 'Z12.2', name: '肺癌篩檢', nameEn: 'Screening for malignant neoplasm of respiratory organs' },
  { code: 'C34.90', name: '肺惡性腫瘤', nameEn: 'Malignant neoplasm of lung' },
  { code: 'I63.9', name: '腦梗塞', nameEn: 'Cerebral infarction, unspecified' },
  { code: 'A41.9', name: '敗血症', nameEn: 'Sepsis, unspecified organism' },
  { code: 'L03.115', name: '右下肢蜂窩性組織炎', nameEn: 'Cellulitis of right lower limb' },
]

const drug = (
  id: string,
  nhiCode: string,
  name: string,
  generic: string,
  spec: string,
  unit: string,
  category: Drug['category'],
  nhiPrice: number,
  selfPrice: number,
  stock: number,
  defaultDose: number,
  defaultFreq: string,
  defaultRoute: string,
  highAlert = false,
  doseUnit?: string,
): Omit<Drug, 'indication' | 'warning' | 'timing' | 'nameZh'> => ({
  id, nhiCode, name, generic, spec, unit, category, nhiPrice, selfPrice, stock,
  safetyStock: Math.max(50, Math.round(stock * 0.15)), defaultDose, defaultFreq, defaultRoute, highAlert, active: true,
  ...(doseUnit ? { doseUnit } : {}),
})

const drugBase = [
  drug('M001', 'AC00001100', 'Acetaminophen 500mg', 'Acetaminophen', '500 mg/tab', 'TAB', '口服', 2, 5, 3200, 1, 'TID', 'PO'),
  drug('M002', 'AC00002100', 'Ibuprofen 400mg', 'Ibuprofen', '400 mg/tab', 'TAB', '口服', 2.5, 6, 1800, 1, 'TID', 'PO'),
  drug('M003', 'AC00003100', 'Amoxicillin 500mg', 'Amoxicillin', '500 mg/cap', 'CAP', '口服', 3.2, 8, 1500, 1, 'TID', 'PO'),
  drug('M004', 'AC00004100', 'Augmentin 625mg', 'Amoxicillin/Clavulanate', '625 mg/tab', 'TAB', '口服', 9.8, 22, 900, 1, 'BID', 'PO'),
  drug('M005', 'AC00005100', 'Cephalexin 500mg', 'Cephalexin', '500 mg/cap', 'CAP', '口服', 4.1, 10, 1100, 1, 'QID', 'PO'),
  drug('M006', 'AC00006100', 'Azithromycin 250mg', 'Azithromycin', '250 mg/tab', 'TAB', '口服', 21, 45, 400, 1, 'QD', 'PO'),
  drug('M007', 'AC00007100', 'Cetirizine 10mg', 'Cetirizine', '10 mg/tab', 'TAB', '口服', 1.6, 4, 2600, 1, 'HS', 'PO'),
  drug('M008', 'AC00008100', 'Loratadine 10mg', 'Loratadine', '10 mg/tab', 'TAB', '口服', 1.8, 4, 1900, 1, 'QD', 'PO'),
  drug('M009', 'AC00009100', 'Dextromethorphan 20mg', 'Dextromethorphan', '20 mg/tab', 'TAB', '口服', 1.5, 3, 2400, 1, 'TID', 'PO'),
  drug('M010', 'AC00010100', 'Ambroxol 30mg', 'Ambroxol', '30 mg/tab', 'TAB', '口服', 1.5, 3, 2600, 1, 'TID', 'PO'),
  drug('M011', 'AC00011100', 'Pseudoephedrine 60mg', 'Pseudoephedrine', '60 mg/tab', 'TAB', '口服', 1.7, 4, 1400, 1, 'TID', 'PO'),
  drug('M012', 'AC00012100', 'Amlodipine 5mg', 'Amlodipine', '5 mg/tab', 'TAB', '口服', 3.6, 8, 3000, 1, 'QD', 'PO'),
  drug('M013', 'AC00013100', 'Losartan 50mg', 'Losartan', '50 mg/tab', 'TAB', '口服', 5.2, 12, 2500, 1, 'QD', 'PO'),
  drug('M014', 'AC00014100', 'Bisoprolol 5mg', 'Bisoprolol', '5 mg/tab', 'TAB', '口服', 4.4, 10, 1200, 1, 'QD', 'PO'),
  drug('M015', 'AC00015100', 'Metformin 500mg', 'Metformin', '500 mg/tab', 'TAB', '口服', 2, 5, 4200, 1, 'BID', 'PO'),
  drug('M016', 'AC00016100', 'Glimepiride 2mg', 'Glimepiride', '2 mg/tab', 'TAB', '口服', 3, 7, 1600, 1, 'QD', 'PO'),
  drug('M017', 'AC00017100', 'Sitagliptin 100mg', 'Sitagliptin', '100 mg/tab', 'TAB', '口服', 19, 40, 900, 1, 'QD', 'PO'),
  drug('M018', 'AC00018100', 'Atorvastatin 20mg', 'Atorvastatin', '20 mg/tab', 'TAB', '口服', 8.5, 18, 2100, 1, 'HS', 'PO'),
  drug('M019', 'AC00019100', 'Aspirin 100mg', 'Acetylsalicylic acid', '100 mg/tab', 'TAB', '口服', 1.5, 3, 3500, 1, 'QD', 'PO'),
  drug('M020', 'AC00020100', 'Clopidogrel 75mg', 'Clopidogrel', '75 mg/tab', 'TAB', '口服', 15, 32, 800, 1, 'QD', 'PO'),
  drug('M021', 'AC00021100', 'Warfarin 5mg', 'Warfarin', '5 mg/tab', 'TAB', '口服', 2.2, 5, 300, 1, 'QD', 'PO', true),
  drug('M022', 'AC00022100', 'Omeprazole 20mg', 'Omeprazole', '20 mg/cap', 'CAP', '口服', 6, 14, 1700, 1, 'QD', 'PO'),
  drug('M023', 'AC00023100', 'Famotidine 20mg', 'Famotidine', '20 mg/tab', 'TAB', '口服', 1.8, 4, 1800, 1, 'BID', 'PO'),
  drug('M024', 'AC00024100', 'Magnesium Oxide 250mg', 'Magnesium oxide', '250 mg/tab', 'TAB', '口服', 1.5, 3, 3000, 1, 'TID', 'PO'),
  drug('M025', 'AC00025100', 'Domperidone 10mg', 'Domperidone', '10 mg/tab', 'TAB', '口服', 1.5, 3, 1900, 1, 'TID', 'PO'),
  drug('M026', 'AC00026100', 'Loperamide 2mg', 'Loperamide', '2 mg/cap', 'CAP', '口服', 1.5, 3, 900, 1, 'PRN', 'PO'),
  drug('M027', 'AC00027100', 'Levothyroxine 50mcg', 'Levothyroxine', '50 mcg/tab', 'TAB', '口服', 2.4, 5, 700, 1, 'QD', 'PO'),
  drug('M028', 'AC00028100', 'Zolpidem 10mg', 'Zolpidem', '10 mg/tab', 'TAB', '口服', 6.5, 15, 400, 1, 'HS', 'PO', true),
  drug('M029', 'AC00029100', 'Alprazolam 0.5mg', 'Alprazolam', '0.5 mg/tab', 'TAB', '口服', 1.8, 4, 600, 1, 'HS', 'PO'),
  drug('M030', 'AC00030100', 'Celecoxib 200mg', 'Celecoxib', '200 mg/cap', 'CAP', '口服', 11, 25, 1000, 1, 'BID', 'PO'),
  drug('M031', 'AC00031100', 'Tramadol 50mg', 'Tramadol', '50 mg/cap', 'CAP', '口服', 3.5, 8, 800, 1, 'PRN', 'PO'),
  drug('M032', 'AC00032100', 'Diclofenac Gel 1%', 'Diclofenac', '1% 20 g/tube', 'TUBE', '外用', 45, 90, 300, 1, 'TID', 'EXT', false, '次'),
  drug('M033', 'AC00033100', 'Betamethasone Cream', 'Betamethasone', '0.05% 5 g/tube', 'TUBE', '外用', 18, 40, 400, 1, 'BID', 'EXT', false, '次'),
  drug('M034', 'AC00034100', 'Gentamicin Eye Drop', 'Gentamicin', '0.3% 5 ml/btl', 'BTL', '眼用', 22, 50, 260, 1, 'QID', 'OU', false, '滴'),
  drug('M035', 'AC00035100', 'Salbutamol Inhaler', 'Salbutamol', '100 mcg/puff 200 puffs', 'BTL', '吸入', 150, 280, 120, 2, 'PRN', 'INHL', false, '噴'),
  drug('M036', 'AC00036100', 'Ceftriaxone 1g Inj', 'Ceftriaxone', '1 g/vial', 'VIAL', '注射', 65, 140, 500, 1, 'Q12H', 'IV'),
  drug('M037', 'AC00037100', 'Normal Saline 500ml', 'Sodium chloride 0.9%', '500 ml/bag', 'BAG', '注射', 25, 50, 900, 1, 'QD', 'IV'),
  drug('M038', 'AC00038100', 'Insulin Glargine 100U/ml', 'Insulin glargine', '300 U/pen', 'PEN', '注射', 480, 900, 90, 10, 'HS', 'SC', true, 'U'),
  drug('M039', 'AC00039100', 'Morphine 10mg Inj', 'Morphine', '10 mg/amp', 'AMP', '注射', 18, 40, 120, 1, 'PRN', 'IM', true),
  drug('M040', 'AC00040100', 'Potassium Chloride 20mEq Inj', 'Potassium chloride', '20 mEq/amp', 'AMP', '注射', 12, 30, 160, 1, 'QD', 'IV', true),
]

/**
 * 藥袋上的「作用或適應症」「警語或副作用」（藥師法規定的藥袋欄位）：給病人看的白話，不寫醫學術語。
 * 展示用的簡化內容，不是完整的仿單。
 */
const labelInfo: Record<string, [indication: string, warning: string]> = {
  M001: ['退燒、止痛', '一天總量不超過 8 顆（4 公克）；不要和其他含乙醯胺酚的感冒藥一起吃；常喝酒者容易傷肝'],
  M002: ['止痛、消炎、退燒', '可能胃痛，請飯後服用；有胃潰瘍、腎臟病請先告知醫師'],
  M003: ['抗生素，治療細菌感染', '請按時吃完整個療程，不要自行停藥；出現皮疹、呼吸困難立即停藥就醫'],
  M004: ['抗生素，治療細菌感染', '可能腹瀉；請吃完整個療程；出現皮疹、呼吸困難立即停藥就醫'],
  M005: ['抗生素，治療細菌感染', '可能腹瀉、噁心；請吃完整個療程；出現皮疹、呼吸困難立即停藥就醫'],
  M006: ['抗生素，治療細菌感染', '可能腸胃不適；請依指示天數吃完'],
  M007: ['抗過敏（流鼻水、皮膚癢）', '可能嗜睡，服藥後避免開車；避免喝酒'],
  M008: ['抗過敏（流鼻水、皮膚癢）', '少數人會嗜睡、口乾'],
  M009: ['止咳', '可能頭暈、嗜睡；不要和其他止咳藥一起吃'],
  M010: ['化痰', '可能輕微腸胃不適；多喝水幫助排痰'],
  M011: ['減輕鼻塞', '可能心悸、失眠；有高血壓、心臟病請先告知醫師'],
  M012: ['降血壓', '可能頭暈、臉潮紅、腳踝水腫；從坐姿或躺姿起身請放慢'],
  M013: ['降血壓', '可能頭暈；懷孕或準備懷孕請立即告知醫師'],
  M014: ['降血壓、減緩心跳', '可能疲倦、心跳變慢；不要自行突然停藥'],
  M015: ['降血糖', '可能腹瀉、腸胃不適，隨餐吃可減輕；要做顯影劑檢查前請告知醫師'],
  M016: ['降血糖', '可能低血糖（冒冷汗、手抖、心慌），請隨身帶糖果；吃藥後不要不吃飯'],
  M017: ['降血糖', '少數人會頭痛、鼻塞；持續劇烈腹痛請就醫'],
  M018: ['降血脂（膽固醇）', '出現不明原因肌肉痠痛、無力請告知醫師'],
  M019: ['預防血栓（抗血小板）', '容易瘀青、流血不止；解黑便或吐血立即就醫；拔牙、手術前請告知醫師'],
  M020: ['預防血栓（抗血小板）', '容易瘀青、流血不止；解黑便或吐血立即就醫；拔牙、手術前請告知醫師'],
  M021: ['抗凝血，預防血栓', '容易出血，需定期抽血檢查；不要自行增減劑量；吃其他藥、保健食品前請先詢問醫師或藥師'],
  M022: ['減少胃酸（胃潰瘍、胃食道逆流）', '可能頭痛、腹瀉；長期使用請依醫師指示'],
  M023: ['減少胃酸（胃潰瘍、胃食道逆流）', '可能頭痛、便秘'],
  M024: ['軟便、中和胃酸', '可能腹瀉；腎功能不好請告知醫師；與其他藥物間隔 2 小時服用'],
  M025: ['止吐、幫助腸胃蠕動', '可能口乾；有心律不整病史請告知醫師'],
  M026: ['止瀉', '發燒或拉出血便時不要使用；可能便秘、腹脹'],
  M027: ['補充甲狀腺素', '出現心悸、手抖、失眠請告知醫師；不要自行停藥'],
  M028: ['幫助入睡', '吃完立即上床；可能夢遊、隔天嗜睡；不要喝酒、不要開車'],
  M029: ['抗焦慮、幫助放鬆', '可能嗜睡、頭暈；不要喝酒、不要開車；長期使用不要自行突然停藥'],
  M030: ['止痛、消炎（關節炎）', '可能胃部不適；對磺胺類藥物過敏請先告知醫師'],
  M031: ['止痛', '可能頭暈、噁心、嗜睡；不要喝酒、不要開車；不要超過醫師指示的劑量'],
  M032: ['外用止痛、消炎', '只擦在完整的皮膚，不要擦在傷口；擦完洗手'],
  M033: ['外用類固醇（皮膚炎、濕疹）', '薄薄擦在患處；不要長期大面積使用，臉部請依醫師指示'],
  M034: ['眼用抗生素（眼睛感染）', '瓶口不要碰到眼睛；點完可能短暫刺痛；開封 1 個月後丟棄'],
  M035: ['緩解氣喘、呼吸困難', '可能心悸、手抖；需要使用的次數變多時請回診'],
  M036: ['抗生素（注射）', '注射部位可能疼痛；出現皮疹、呼吸困難立即告知醫護人員'],
  M037: ['補充水分、電解質（點滴）', '注射部位紅腫疼痛請告知醫護人員'],
  M038: ['長效胰島素，降血糖', '可能低血糖（冒冷汗、手抖），請隨身帶糖果；未開封冷藏，開封後室溫保存 28 天內用完；每次換注射部位'],
  M039: ['強效止痛', '可能嗜睡、呼吸變慢、便秘；不要喝酒'],
  M040: ['補充鉀離子', '須稀釋後緩慢點滴；注射處疼痛請告知醫護人員'],
}

/**
 * 口服藥的服用時機（沒列的是飯前飯後皆可；非口服一律 ANY）。
 * 飯前：氫離子幫浦阻斷劑要在進食刺激胃酸前作用、促進腸胃蠕動藥要在飯前吃；空腹：甲狀腺素與食物併服吸收變差；
 * 隨餐：Metformin 減少腸胃不適、Glimepiride 吃了不吃飯會低血糖；飯後：止痛消炎藥、阿斯匹靈減少胃部刺激。
 */
const timingOf: Record<string, DrugTiming> = {
  M002: 'PC', M009: 'PC', M010: 'PC', M019: 'PC', M024: 'PC', M030: 'PC',
  M022: 'AC', M025: 'AC',
  M015: 'WITH', M016: 'WITH',
  M027: 'EMPTY',
}

/**
 * 中文名與搜尋別名。中文名用通用的中文學名（展示用譯名，不是衛福部核定的正式譯名），不用商品名；
 * 別名只用來搜尋（大家習慣打的叫法），不印出。
 */
const zhOf: Record<string, [nameZh: string, aliases?: string[]]> = {
  M001: ['乙醯胺酚', ['普拿疼']],
  M002: ['布洛芬'],
  M003: ['安莫西林'],
  M004: ['安莫西林／克拉維酸'],
  M005: ['頭孢力新'],
  M006: ['阿奇黴素'],
  M007: ['西替利嗪'],
  M008: ['氯雷他定'],
  M009: ['右美沙芬'],
  M010: ['氨溴索'],
  M011: ['偽麻黃鹼'],
  M012: ['胺氯地平'],
  M013: ['洛沙坦'],
  M014: ['比索洛爾'],
  M015: ['二甲雙胍', ['美福明']],
  M016: ['格列美脲'],
  M017: ['西格列汀'],
  M018: ['阿托伐他汀'],
  M019: ['阿斯匹靈', ['阿司匹林']],
  M020: ['氯吡格雷'],
  M021: ['華法林'],
  M022: ['奧美拉唑'],
  M023: ['法莫替丁'],
  M024: ['氧化鎂', ['軟便劑']],
  M025: ['多潘立酮'],
  M026: ['洛哌丁胺'],
  M027: ['左旋甲狀腺素'],
  M028: ['唑吡坦', ['安眠藥']],
  M029: ['阿普唑侖'],
  M030: ['塞來昔布'],
  M031: ['曲馬多'],
  M032: ['雙氯芬酸凝膠', ['痠痛凝膠']],
  M033: ['倍他美松乳膏', ['類固醇藥膏']],
  M034: ['慶大黴素眼藥水'],
  M035: ['沙丁胺醇吸入劑', ['氣喘噴劑']],
  M036: ['頭孢曲松注射劑'],
  M037: ['生理食鹽水', ['點滴', 'NS']],
  M038: ['甘精胰島素'],
  M039: ['嗎啡注射劑'],
  M040: ['氯化鉀注射劑', ['KCl']],
}

export const drugs: Drug[] = drugBase.map((d) => ({
  ...d,
  nameZh: zhOf[d.id][0],
  ...(zhOf[d.id][1] ? { aliases: zhOf[d.id][1] } : {}),
  indication: labelInfo[d.id][0],
  warning: labelInfo[d.id][1],
  timing: d.category === '口服' ? timingOf[d.id] ?? 'ANY' : 'ANY',
}))

export const procedures: Procedure[] = [
  { id: 'P001', code: '00109C', name: '一般門診診察費', category: '診察', points: 352, selfPrice: 400, active: true },
  { id: 'P002', code: '00217A', name: '住院診察費（每日）', category: '診察', points: 461, selfPrice: 500, active: true },
  { id: 'P003', code: '08011C', name: '全套血液檢查 CBC', category: '檢驗', points: 145, selfPrice: 250, active: true },
  { id: 'P004', code: '09005C', name: '飯前血糖 AC sugar', category: '檢驗', points: 45, selfPrice: 100, active: true },
  { id: 'P005', code: '09006C', name: '糖化血色素 HbA1c', category: '檢驗', points: 200, selfPrice: 350, active: true },
  { id: 'P006', code: '09001C', name: '總膽固醇 T-CHO', category: '檢驗', points: 75, selfPrice: 150, active: true },
  { id: 'P007', code: '09004C', name: '三酸甘油酯 TG', category: '檢驗', points: 110, selfPrice: 200, active: true },
  { id: 'P008', code: '09015C', name: '肌酸酐 Creatinine', category: '檢驗', points: 45, selfPrice: 100, active: true },
  { id: 'P009', code: '09026C', name: '肝功能 GPT', category: '檢驗', points: 45, selfPrice: 100, active: true },
  { id: 'P010', code: '06013C', name: '尿液常規檢查', category: '檢驗', points: 75, selfPrice: 150, active: true },
  { id: 'P011', code: '12015C', name: 'C 反應蛋白 CRP', category: '檢驗', points: 200, selfPrice: 300, active: true },
  { id: 'P012', code: '14032C', name: '流感快篩', category: '檢驗', points: 280, selfPrice: 500, active: true },
  { id: 'P013', code: '32001C', name: '胸部 X 光', category: '影像', points: 200, selfPrice: 400, active: true },
  { id: 'P014', code: '32022C', name: '膝關節 X 光', category: '影像', points: 220, selfPrice: 400, active: true },
  { id: 'P015', code: '32011C', name: '腰椎 X 光', category: '影像', points: 260, selfPrice: 450, active: true },
  { id: 'P016', code: '19001C', name: '腹部超音波', category: '影像', points: 650, selfPrice: 1200, active: true },
  { id: 'P017', code: '18001C', name: '心電圖 EKG', category: '影像', points: 150, selfPrice: 300, active: true },
  { id: 'P018', code: '33070B', name: '電腦斷層（頭部，無顯影）', category: '影像', points: 3800, selfPrice: 6000, active: true },
  { id: 'P019', code: '48001C', name: '淺部創傷處理（< 5 cm）', category: '處置', points: 575, selfPrice: 900, active: true },
  { id: 'P020', code: '48011C', name: '傷口換藥（小）', category: '處置', points: 50, selfPrice: 150, active: true },
  { id: 'P021', code: '47041C', name: '靜脈注射', category: '處置', points: 65, selfPrice: 150, active: true },
  { id: 'P022', code: '47031C', name: '肌肉注射', category: '處置', points: 30, selfPrice: 100, active: true },
  { id: 'P023', code: '56006C', name: '吸入治療', category: '處置', points: 100, selfPrice: 200, active: true },
  { id: 'P024', code: '54019C', name: '耳鼻喉局部治療', category: '處置', points: 60, selfPrice: 150, active: true },
  { id: 'P025', code: '42001C', name: '簡單物理治療', category: '復健', points: 200, selfPrice: 300, active: true },
  { id: 'P026', code: '42003C', name: '中度物理治療', category: '復健', points: 280, selfPrice: 400, active: true },
  { id: 'P027', code: 'SELF01', name: '診斷證明書', category: '處置', points: 0, selfPrice: 150, active: true },
  { id: 'P028', code: 'SELF02', name: '流感疫苗（自費）', category: '處置', points: 0, selfPrice: 800, active: true },
]

export const preventItems: PreventItem[] = [
  { code: 'ADULT', name: '成人預防保健', caseCode: '3D', ruleText: '40–64 歲每 3 年 1 次；65 歲以上每年 1 次', intervalYears: 3, fields: ['血壓', '空腹血糖', '總膽固醇', '身高', '體重'], needsReport: false },
  { code: 'CERVIX', name: '子宮頸抹片檢查', caseCode: '95', ruleText: '30 歲以上女性，每 3 年 1 次', intervalYears: 3, fields: ['報告'], needsReport: true },
  { code: 'BREAST', name: '乳房 X 光攝影', caseCode: '81', ruleText: '45–69 歲女性，或 40–44 歲有乳癌家族史者，每 2 年 1 次', intervalYears: 2, fields: ['報告'], needsReport: true },
  { code: 'COLON', name: '糞便潛血檢查', caseCode: '85', ruleText: '45–74 歲，每 2 年 1 次', intervalYears: 2, fields: ['糞便潛血'], needsReport: true },
  { code: 'ORAL', name: '口腔黏膜檢查', caseCode: '87', ruleText: '30 歲以上吸菸或嚼檳榔者，每 2 年 1 次', intervalYears: 2, fields: ['檢查結果'], needsReport: false },
  { code: 'LUNG', name: '低劑量電腦斷層肺癌篩檢', caseCode: 'LC', ruleText: '男 50–74 歲、女 45–74 歲，有肺癌家族史或重度吸菸史，每 2 年 1 次', intervalYears: 2, fields: ['報告'], needsReport: true },
  { code: 'BCLIVER', name: '成人 B、C 型肝炎篩檢', caseCode: 'BC', ruleText: '45–79 歲，終身 1 次', intervalYears: 0, fields: ['HBsAg', 'Anti-HCV'], needsReport: true },
  { code: 'CHILD', name: '兒童預防保健', caseCode: 'IC', ruleText: '未滿 7 歲，依年齡共 7 次', intervalYears: 0, fields: ['身高', '體重', '發展評估'], needsReport: false },
]

export const wards = ['5A 內科病房', '6B 外科病房', '7C 綜合病房']

export const dischargeTypes = ['治癒出院', '改善出院', '轉院', '自動出院', '轉長照機構', '死亡']

export const familyHistoryOptions = ['高血壓', '糖尿病', '心臟病', '中風', '乳癌', '大腸癌', '肺癌', '肝癌', '腎臟病']

export const allergyOptions = ['Penicillin', 'Aspirin', 'NSAIDs', 'Sulfa', 'Cephalosporin', '顯影劑', '海鮮']
