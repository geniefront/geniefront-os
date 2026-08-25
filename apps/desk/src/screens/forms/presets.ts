/**
 * 健康表模板库 —— 三份现成的表，六种语言（`docs/15` §2）。
 *
 * ## 为什么要有预设，而不是让老板自己从零写
 *
 * 一位刚开店的老板打开「新建健康表」，面对一个空列表时，写出来的
 * 十有八九是「有没有不舒服？」这一类**在纠纷里没有任何用处**的问题。
 * 而这张表真正要问的是禁忌症（怀孕、血栓、近期手术、抗凝药）——
 * 那是保险公司和律师会逐条看的东西（`00` §2）。
 *
 * 所以模板库不是省事，是**把该问的问题问出来**。老板可以改、可以删，
 * 但他至少见过一份长得对的。
 *
 * ## ⚠️ 六种语言不是锦上添花
 *
 * 客人看不懂的免责书**在法律上等于没签**（宪法第 7 条在这里不是体验问题）。
 * 而「我看不懂英文」是这类纠纷里最常见的抗辩 —— 所以每一题、每一个选项
 * 都是六语言齐的，缺一种就等于那种语言的客人签的表不作数。
 *
 * ## ⚠️ 这里**不是**法律意见
 *
 * 各州对免责条款的要求不同（加州对遮盖同意、纽约对未成年人监护都有
 * 单独的规定）。这三份是**起点**，不是合规保证 —— 界面上也是这么写的。
 */

import type { Locale } from '../../i18n';

/** ⚠️ 顺序固定，下面每个 `t6()` 的六个参数按这个顺序对号入座 */
const ORDER = ['en', 'zh-Hans', 'zh-Hant', 'ko', 'vi', 'es'] as const;

export type I18nText = Partial<Record<Locale, string>>;

const t6 = (
  en: string, zhHans: string, zhHant: string, ko: string, vi: string, es: string,
): I18nText => ({
  en, 'zh-Hans': zhHans, 'zh-Hant': zhHant, ko, vi, es,
});

export interface PresetOption { value: string; label: I18nText }

export interface PresetQuestion {
  id: string;
  type: 'bool' | 'text' | 'choice' | 'multi';
  label: I18nText;
  /**
   * ⚠️ 这几个可选字段都显式带上 `| undefined`：编辑器要能把「回填」
   * 改回「不回填」，而 exactOptionalPropertyTypes 下
   * 「删掉这个键」和「把它设成 undefined」是两件事
   */
  options?: PresetOption[] | undefined;
  required?: boolean | undefined;
  /** 见 contracts 的 SaveFormTemplate：只有部位和一个布尔会回填客户档案 */
  sync?: 'avoid_areas' | 'health_flag' | undefined;
}

export interface FormPreset {
  key: string;
  /** 模板库里那张卡片上的一句话 */
  blurb: I18nText;
  title: I18nText;
  questions: PresetQuestion[];
  requiresSignature: boolean;
  validDays: number | null;
}

/** 「以上都没有」。⚠️ 服务端把它当成「没勾」处理，不会因此置禁忌标记 */
const NONE = {
  value: 'none',
  label: t6('None of the above', '以上都没有', '以上都沒有', '해당 없음',
            'Không có mục nào', 'Ninguna de las anteriores'),
};

const YES_NO_NOTE = t6(
  'If yes, please tell the front desk before your service.',
  '如果有，做之前请先告诉前台。', '如果有，做之前請先告訴前台。',
  '해당되는 경우 시술 전 프런트에 알려주세요.',
  'Nếu có, vui lòng báo quầy lễ tân trước khi làm.',
  'Si es así, informe a recepción antes del servicio.',
);

// ══════════════════════════════════════════════════════ ① 按摩 / Spa

const massage: FormPreset = {
  key: 'massage_intake',
  blurb: t6(
    'Contraindication screening + draping consent. The one insurers ask for.',
    '禁忌症筛查 + 遮盖同意。保险公司要看的就是这一份。',
    '禁忌症篩查 + 遮蓋同意。保險公司要看的就是這一份。',
    '금기증 확인 + 드레이핑 동의. 보험사가 요구하는 서식입니다.',
    'Sàng lọc chống chỉ định + đồng ý che phủ. Bảo hiểm yêu cầu phiếu này.',
    'Detección de contraindicaciones + consentimiento de cobertura.',
  ),
  title: t6(
    'Massage & Spa Health Intake', '按摩与 Spa 健康问卷', '按摩與 Spa 健康問卷',
    '마사지 및 스파 건강 문진표', 'Phiếu khai báo sức khỏe massage & spa',
    'Cuestionario de salud para masaje y spa',
  ),
  requiresSignature: true,
  validDays: 365,
  questions: [
    {
      id: 'conditions', type: 'multi', sync: 'health_flag',
      label: t6(
        'Do you have any of the following?', '您有以下情况吗？', '您有以下情況嗎？',
        '다음 중 해당되는 것이 있습니까?', 'Bạn có tình trạng nào sau đây không?',
        '¿Tiene alguna de las siguientes condiciones?',
      ),
      options: [
        { value: 'high_blood_pressure', label: t6('High blood pressure', '高血压', '高血壓', '고혈압', 'Huyết áp cao', 'Presión arterial alta') },
        { value: 'blood_clots', label: t6('History of blood clots', '血栓病史', '血栓病史', '혈전 병력', 'Tiền sử cục máu đông', 'Antecedentes de coágulos') },
        { value: 'diabetes', label: t6('Diabetes', '糖尿病', '糖尿病', '당뇨병', 'Tiểu đường', 'Diabetes') },
        { value: 'heart_condition', label: t6('Heart condition', '心脏病', '心臟病', '심장 질환', 'Bệnh tim', 'Afección cardíaca') },
        { value: 'osteoporosis', label: t6('Osteoporosis', '骨质疏松', '骨質疏鬆', '골다공증', 'Loãng xương', 'Osteoporosis') },
        { value: 'skin_condition', label: t6('Skin condition or rash', '皮肤病或皮疹', '皮膚病或皮疹', '피부 질환 또는 발진', 'Bệnh da hoặc phát ban', 'Afección cutánea o erupción') },
        NONE,
      ],
    },
    {
      id: 'pregnant', type: 'bool', required: true, sync: 'health_flag',
      label: t6(
        'Are you pregnant?', '是否怀孕？', '是否懷孕？', '임신 중이신가요?',
        'Bạn có đang mang thai không?', '¿Está embarazada?',
      ),
    },
    {
      id: 'pregnancy_weeks', type: 'text',
      label: t6(
        'If pregnant, how many weeks?', '如果怀孕，多少周？', '如果懷孕，多少週？',
        '임신 중이라면 몇 주차인가요?', 'Nếu có thai, bao nhiêu tuần?',
        'Si está embarazada, ¿de cuántas semanas?',
      ),
    },
    {
      id: 'recent_surgery', type: 'bool', required: true, sync: 'health_flag',
      label: t6(
        'Any surgery or injury in the last 6 months?', '最近半年有手术或受伤吗？',
        '最近半年有手術或受傷嗎？', '최근 6개월 내 수술이나 부상이 있었나요?',
        'Bạn có phẫu thuật hoặc chấn thương trong 6 tháng qua không?',
        '¿Cirugía o lesión en los últimos 6 meses?',
      ),
    },
    {
      id: 'blood_thinners', type: 'bool', sync: 'health_flag',
      label: t6(
        'Are you taking blood thinners?', '是否在服用抗凝血药物？',
        '是否在服用抗凝血藥物？', '항응고제를 복용 중이신가요?',
        'Bạn có đang dùng thuốc chống đông máu không?',
        '¿Toma anticoagulantes?',
      ),
    },
    {
      id: 'avoid_areas', type: 'multi', sync: 'avoid_areas',
      label: t6(
        'Any areas you want us to avoid?', '有哪些部位不要按？', '有哪些部位不要按？',
        '피해야 할 부위가 있나요?', 'Có vùng nào bạn muốn tránh không?',
        '¿Hay zonas que debamos evitar?',
      ),
      options: [
        { value: 'head_face', label: t6('Head / face', '头面部', '頭面部', '머리·얼굴', 'Đầu / mặt', 'Cabeza / cara') },
        { value: 'neck', label: t6('Neck', '颈部', '頸部', '목', 'Cổ', 'Cuello') },
        { value: 'shoulders', label: t6('Shoulders', '肩部', '肩部', '어깨', 'Vai', 'Hombros') },
        { value: 'upper_back', label: t6('Upper back', '上背', '上背', '등 위쪽', 'Lưng trên', 'Espalda alta') },
        { value: 'lower_back', label: t6('Lower back', '下背 / 腰', '下背 / 腰', '허리', 'Lưng dưới', 'Espalda baja') },
        { value: 'abdomen', label: t6('Abdomen', '腹部', '腹部', '복부', 'Bụng', 'Abdomen') },
        { value: 'arms_hands', label: t6('Arms / hands', '手臂 / 手', '手臂 / 手', '팔·손', 'Tay', 'Brazos / manos') },
        { value: 'legs_feet', label: t6('Legs / feet', '腿 / 脚', '腿 / 腳', '다리·발', 'Chân', 'Piernas / pies') },
        NONE,
      ],
    },
    {
      id: 'pressure', type: 'choice',
      label: t6(
        'Preferred pressure', '力度偏好', '力度偏好', '선호하는 압력',
        'Lực massage mong muốn', 'Presión preferida',
      ),
      options: [
        { value: 'light', label: t6('Light', '轻', '輕', '약하게', 'Nhẹ', 'Suave') },
        { value: 'medium', label: t6('Medium', '适中', '適中', '보통', 'Vừa', 'Media') },
        { value: 'firm', label: t6('Firm', '偏重', '偏重', '강하게', 'Mạnh', 'Fuerte') },
        { value: 'deep', label: t6('Deep tissue', '深层', '深層', '딥티슈', 'Mô sâu', 'Tejido profundo') },
      ],
    },
    {
      id: 'allergies', type: 'text',
      label: t6(
        'Allergies to oils, lotions, or scents?', '对精油、乳液或香味过敏吗？',
        '對精油、乳液或香味過敏嗎？', '오일·로션·향에 알레르기가 있나요?',
        'Bạn có dị ứng với dầu, kem dưỡng hoặc mùi hương không?',
        '¿Alergias a aceites, lociones o fragancias?',
      ),
    },
    {
      id: 'draping_consent', type: 'bool', required: true,
      label: t6(
        'I understand that I will be properly draped at all times and may ask to stop at any point.',
        '我了解全程会有适当遮盖，并且随时可以要求停止。',
        '我了解全程會有適當遮蓋，並且隨時可以要求停止。',
        '시술 중 항상 적절히 가려지며 언제든 중단을 요청할 수 있음을 이해합니다.',
        'Tôi hiểu rằng tôi sẽ luôn được che phủ đúng cách và có thể yêu cầu dừng bất cứ lúc nào.',
        'Entiendo que estaré cubierto/a en todo momento y puedo pedir que se detenga en cualquier momento.',
      ),
    },
    {
      id: 'waiver', type: 'bool', required: true,
      label: t6(
        'The information above is accurate, and I will inform my therapist of any changes.',
        '以上信息属实，如有变化我会告知技师。',
        '以上資訊屬實，如有變化我會告知技師。',
        '위 정보는 사실이며 변경 사항이 있으면 관리사에게 알리겠습니다.',
        'Thông tin trên là chính xác và tôi sẽ báo cho kỹ thuật viên nếu có thay đổi.',
        'La información anterior es correcta e informaré a mi terapeuta de cualquier cambio.',
      ),
    },
  ],
};

// ══════════════════════════════════════════════════════ ② 美容 / 护肤

const facial: FormPreset = {
  key: 'facial_intake',
  blurb: t6(
    'Actives, recent treatments, isotretinoin — the three that cause burns.',
    '在用的活性成分、近期疗程、异维A酸 —— 出灼伤事故的就是这三项。',
    '在用的活性成分、近期療程、異維A酸 —— 出灼傷事故的就是這三項。',
    '사용 중인 활성 성분, 최근 시술, 이소트레티노인 — 화상 사고의 3대 원인.',
    'Hoạt chất đang dùng, liệu trình gần đây, isotretinoin — ba nguyên nhân gây bỏng.',
    'Activos, tratamientos recientes e isotretinoína: las tres causas de quemaduras.',
  ),
  title: t6(
    'Facial & Skincare Consultation', '面部护理问卷', '面部護理問卷',
    '피부 관리 상담표', 'Phiếu tư vấn chăm sóc da', 'Consulta facial y de cuidado de la piel',
  ),
  requiresSignature: true,
  validDays: 365,
  questions: [
    {
      id: 'skin_type', type: 'choice',
      label: t6('Your skin type', '您的肤质', '您的膚質', '피부 타입',
                'Loại da của bạn', 'Su tipo de piel'),
      options: [
        { value: 'normal', label: t6('Normal', '中性', '中性', '보통', 'Thường', 'Normal') },
        { value: 'dry', label: t6('Dry', '干性', '乾性', '건성', 'Khô', 'Seca') },
        { value: 'oily', label: t6('Oily', '油性', '油性', '지성', 'Dầu', 'Grasa') },
        { value: 'combination', label: t6('Combination', '混合性', '混合性', '복합성', 'Hỗn hợp', 'Mixta') },
        { value: 'sensitive', label: t6('Sensitive', '敏感性', '敏感性', '민감성', 'Nhạy cảm', 'Sensible') },
      ],
    },
    {
      id: 'actives', type: 'multi',
      label: t6(
        'Products you are currently using', '目前在用的产品', '目前在用的產品',
        '현재 사용 중인 제품', 'Sản phẩm bạn đang dùng', 'Productos que usa actualmente',
      ),
      options: [
        { value: 'retinoid', label: t6('Retinol / tretinoin', '视黄醇 / A酸', '視黃醇 / A酸', '레티놀·트레티노인', 'Retinol / tretinoin', 'Retinol / tretinoína') },
        { value: 'aha_bha', label: t6('AHA / BHA acids', '果酸 / 水杨酸', '果酸 / 水楊酸', 'AHA·BHA 산', 'Axit AHA / BHA', 'Ácidos AHA / BHA') },
        { value: 'benzoyl', label: t6('Benzoyl peroxide', '过氧化苯甲酰', '過氧化苯甲醯', '벤조일 퍼옥사이드', 'Benzoyl peroxide', 'Peróxido de benzoilo') },
        { value: 'hydroquinone', label: t6('Hydroquinone', '氢醌', '氫醌', '하이드로퀴논', 'Hydroquinone', 'Hidroquinona') },
        NONE,
      ],
    },
    {
      id: 'recent_treatments', type: 'multi', sync: 'health_flag',
      label: t6(
        'Any of these in the last 2 weeks?', '最近两周做过以下项目吗？',
        '最近兩週做過以下項目嗎？', '최근 2주 이내에 받은 시술이 있나요?',
        'Bạn có làm các liệu trình sau trong 2 tuần qua không?',
        '¿Alguno de estos en las últimas 2 semanas?',
      ),
      options: [
        { value: 'laser', label: t6('Laser treatment', '激光治疗', '雷射治療', '레이저 시술', 'Điều trị laser', 'Tratamiento láser') },
        { value: 'peel', label: t6('Chemical peel', '化学换肤', '化學換膚', '화학적 필링', 'Lột da hóa học', 'Peeling químico') },
        { value: 'microneedling', label: t6('Microneedling', '微针', '微針', '마이크로니들링', 'Lăn kim', 'Microagujas') },
        { value: 'injectables', label: t6('Botox or fillers', '肉毒或填充', '肉毒或填充', '보톡스·필러', 'Botox hoặc filler', 'Bótox o rellenos') },
        NONE,
      ],
    },
    {
      id: 'isotretinoin', type: 'bool', required: true, sync: 'health_flag',
      label: t6(
        'Have you taken isotretinoin (Accutane) in the last 6 months?',
        '最近半年服用过异维A酸（泰尔丝）吗？', '最近半年服用過異維A酸嗎？',
        '최근 6개월 내 이소트레티노인을 복용했나요?',
        'Bạn có dùng isotretinoin trong 6 tháng qua không?',
        '¿Ha tomado isotretinoína en los últimos 6 meses?',
      ),
    },
    {
      id: 'pregnant', type: 'bool', sync: 'health_flag',
      label: t6('Are you pregnant or nursing?', '是否怀孕或哺乳？', '是否懷孕或哺乳？',
                '임신 또는 수유 중이신가요?', 'Bạn có đang mang thai hoặc cho con bú không?',
                '¿Está embarazada o amamantando?'),
    },
    {
      id: 'cold_sores', type: 'bool',
      label: t6('History of cold sores?', '有过唇疱疹吗？', '有過唇皰疹嗎？',
                '입술 물집(단순포진) 병력이 있나요?', 'Bạn từng bị mụn rộp môi không?',
                '¿Antecedentes de herpes labial?'),
    },
    {
      id: 'allergies', type: 'text',
      label: t6('Any known allergies?', '有已知过敏吗？', '有已知過敏嗎？',
                '알고 있는 알레르기가 있나요?', 'Bạn có dị ứng nào không?',
                '¿Alguna alergia conocida?'),
    },
    {
      id: 'consent', type: 'bool', required: true,
      label: t6(
        'The information above is accurate and I consent to the treatment.',
        '以上信息属实，我同意接受本次护理。', '以上資訊屬實，我同意接受本次護理。',
        '위 정보는 사실이며 시술에 동의합니다.',
        'Thông tin trên là chính xác và tôi đồng ý thực hiện liệu trình.',
        'La información es correcta y consiento el tratamiento.',
      ),
    },
  ],
};

// ══════════════════════════════════════════════════════ ③ 美甲 / 足疗

const nail: FormPreset = {
  key: 'nail_intake',
  blurb: t6(
    'Diabetes and circulation. A pedicure on a diabetic foot is a real liability.',
    '糖尿病与循环问题。给糖尿病人的脚做修剪是实打实的责任风险。',
    '糖尿病與循環問題。給糖尿病人的腳做修剪是實打實的責任風險。',
    '당뇨와 혈액순환. 당뇨 환자의 발 관리는 실제 배상 위험입니다.',
    'Tiểu đường và tuần hoàn máu. Làm chân cho người tiểu đường là rủi ro thật sự.',
    'Diabetes y circulación. Una pedicura en un pie diabético es un riesgo real.',
  ),
  title: t6(
    'Nail & Pedicure Safety Form', '美甲 / 足疗安全表', '美甲 / 足療安全表',
    '네일·페디큐어 안전 문진표', 'Phiếu an toàn làm móng & chăm sóc chân',
    'Formulario de seguridad para uñas y pedicura',
  ),
  requiresSignature: true,
  validDays: 365,
  questions: [
    {
      id: 'diabetes', type: 'bool', required: true, sync: 'health_flag',
      label: t6('Do you have diabetes?', '您有糖尿病吗？', '您有糖尿病嗎？',
                '당뇨병이 있으신가요?', 'Bạn có bị tiểu đường không?', '¿Tiene diabetes?'),
    },
    {
      id: 'circulation', type: 'bool', sync: 'health_flag',
      label: t6(
        'Any circulation problems or numbness in hands or feet?',
        '手脚有循环问题或麻木吗？', '手腳有循環問題或麻木嗎？',
        '손발에 혈액순환 문제나 저림이 있나요?',
        'Tay chân bạn có vấn đề tuần hoàn hoặc tê không?',
        '¿Problemas de circulación o entumecimiento en manos o pies?',
      ),
    },
    {
      id: 'open_wounds', type: 'bool', required: true, sync: 'health_flag',
      label: t6(
        'Any cuts, sores, or infections on your hands or feet today?',
        '今天手脚上有伤口、溃疡或感染吗？', '今天手腳上有傷口、潰瘍或感染嗎？',
        '오늘 손발에 상처, 궤양, 감염이 있나요?',
        'Hôm nay tay chân bạn có vết cắt, lở loét hoặc nhiễm trùng không?',
        '¿Tiene cortes, llagas o infecciones en manos o pies hoy?',
      ),
    },
    {
      id: 'nail_fungus', type: 'bool',
      label: t6('Any nail fungus or discoloration?', '有灰指甲或指甲变色吗？',
                '有灰指甲或指甲變色嗎？', '무좀이나 손발톱 변색이 있나요?',
                'Bạn có nấm móng hoặc móng đổi màu không?',
                '¿Hongos o decoloración en las uñas?'),
    },
    {
      id: 'recent_leg_surgery', type: 'bool', sync: 'health_flag',
      label: t6(
        'Any leg or foot surgery in the last 6 months?', '最近半年腿或脚做过手术吗？',
        '最近半年腿或腳做過手術嗎？', '최근 6개월 내 다리나 발 수술을 받았나요?',
        'Bạn có phẫu thuật chân trong 6 tháng qua không?',
        '¿Cirugía de pierna o pie en los últimos 6 meses?',
      ),
    },
    {
      id: 'adhesive_allergy', type: 'bool',
      label: t6(
        'Allergic to acrylic, gel, or adhesives?', '对甲油胶、水晶甲或粘合剂过敏吗？',
        '對甲油膠、水晶甲或黏合劑過敏嗎？', '아크릴·젤·접착제에 알레르기가 있나요?',
        'Bạn có dị ứng với acrylic, gel hoặc keo không?',
        '¿Es alérgico/a al acrílico, gel o adhesivos?',
      ),
    },
    {
      id: 'avoid_areas', type: 'multi', sync: 'avoid_areas',
      label: t6('Anywhere we should avoid?', '有哪里不要碰？', '有哪裡不要碰？',
                '피해야 할 부위가 있나요?', 'Có chỗ nào cần tránh không?',
                '¿Alguna zona que debamos evitar?'),
      options: [
        { value: 'left_hand', label: t6('Left hand', '左手', '左手', '왼손', 'Tay trái', 'Mano izquierda') },
        { value: 'right_hand', label: t6('Right hand', '右手', '右手', '오른손', 'Tay phải', 'Mano derecha') },
        { value: 'left_foot', label: t6('Left foot', '左脚', '左腳', '왼발', 'Chân trái', 'Pie izquierdo') },
        { value: 'right_foot', label: t6('Right foot', '右脚', '右腳', '오른발', 'Chân phải', 'Pie derecho') },
        { value: 'legs', label: t6('Lower legs', '小腿', '小腿', '종아리', 'Cẳng chân', 'Piernas') },
        NONE,
      ],
    },
    {
      id: 'consent', type: 'bool', required: true,
      label: t6(
        'The information above is accurate and I consent to the service.',
        '以上信息属实，我同意接受本次服务。', '以上資訊屬實，我同意接受本次服務。',
        '위 정보는 사실이며 서비스에 동의합니다.',
        'Thông tin trên là chính xác và tôi đồng ý sử dụng dịch vụ.',
        'La información es correcta y consiento el servicio.',
      ),
    },
  ],
};

export const FORM_PRESETS: readonly FormPreset[] = [massage, facial, nail];

export const PRESET_NOTE = YES_NO_NOTE;

/** 界面上取一段多语言文本。取不到就退到英文，再退到第一个有值的 */
export function pick(text: I18nText | undefined, locale: Locale): string {
  if (!text) return '';
  return text[locale] ?? text['en'] ?? Object.values(text).find(Boolean) ?? '';
}

/** 六种语言都齐了没有 —— 缺一种，那种语言的客人签的表就不作数 */
export function missingLocales(text: I18nText | undefined): string[] {
  return ORDER.filter((l) => !(text?.[l] ?? '').trim());
}
