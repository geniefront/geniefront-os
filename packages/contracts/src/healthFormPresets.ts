import type { z } from 'zod';
import { SaveFormTemplate } from './commands/kiosk.js';
import type { HealthFormCategory } from './healthForms.js';

export type HealthFormPresetTemplate = z.input<typeof SaveFormTemplate.input>;

export interface IndustryHealthFormPreset {
  id: string;
  category: HealthFormCategory;
  name: Record<string, string>;
  description: Record<string, string>;
  icon: string;
  color: string;
  template: HealthFormPresetTemplate;
}

export const INDUSTRY_HEALTH_FORM_PRESETS: IndustryHealthFormPreset[] = [
  // 1. 💆 按摩 / 水疗 / SPA (Massage & Spa) -> 放在第一个！
  {
    id: 'massage_spa',
    category: 'massage',
    name: {
      'zh-Hans': '按摩 / 水疗 / Spa',
      en: 'Massage & Spa',
      ko: '마사지 & 스파',
      es: 'Masaje y Spa',
      vi: 'Massage & Spa',
    },
    description: {
      'zh-Hans': '包含精细疼痛评估、互动人体模型、起搏器/血栓等红线禁忌排查及知情同意书',
      en: 'Clinical standard intake with pain slider, interactive body map, contraindications, and waiver',
      ko: '통증 척도, 인터랙티브 신체 부위 맵, 금기 사항 및 사전 동의서 포함 표준 문진표',
      es: 'Cuestionario clínico con evaluación de dolor, mapa anatómico interactivo y consentimiento',
      vi: 'Biểu mẫu chuẩn với thanh đo cơn đau, bản đồ cơ thể tương tác và cam kết miễn trừ',
    },
    icon: 'Sparkles',
    color: 'teal',
    template: {
      key: 'massage_intake',
      title: {
        'zh-Hans': '按摩理疗与水疗健康知情同意表',
        en: 'Massage & Spa Client Intake & Health History',
        ko: '마사지 & 스파 고객 건강 차트 및 동의서',
        es: 'Historial de Salud y Consentimiento de Masaje',
        vi: 'Bảng Tư Vấn & Cam Kết Sức Khỏe Massage Spa',
      },
      validDays: 365,
      requiresSignature: true,
      serviceIds: [],
      questions: [
        {
          id: 'q_pressure_pref',
          type: 'choice',
          label: {
            'zh-Hans': '您期望的按摩力度偏好是？',
            en: 'What is your preferred massage pressure level?',
            ko: '선호하시는 마사지 압력 강도는 어느 정도인가요?',
            es: '¿Cuál es su preferencia de presión de masaje?',
            vi: 'Mức độ lực massage bạn mong muốn là gì?',
          },
          required: true,
          options: [
            { value: 'gentle', label: { 'zh-Hans': '轻柔放松 (Light / Gentle)', en: 'Light / Gentle', ko: '부드럽게 (Light)', es: 'Suave / Relajante', vi: 'Nhẹ nhàng' } },
            { value: 'medium', label: { 'zh-Hans': '中等适中 (Medium - 推荐)', en: 'Medium (Recommended)', ko: '보통 (Medium - 추천)', es: 'Media (Recomendada)', vi: 'Vừa phải (Khuyên dùng)' } },
            { value: 'deep_strong', label: { 'zh-Hans': '深层强劲 (Deep Tissue / Strong)', en: 'Deep Tissue / Strong', ko: '강하게 (Deep Tissue)', es: 'Presión profunda / Fuerte', vi: 'Mạnh / Mô sâu' } },
          ],
        },
        {
          id: 'q_pacemaker',
          type: 'bool',
          label: {
            'zh-Hans': '您体内是否有心脏起搏器、除颤器或金属植入物？',
            en: 'Do you have a pacemaker, defibrillator, or internal metal implants?',
            ko: '체내에 심장 박동기, 제세동기 또는 금속 삽입물이 있으신가요?',
            es: '¿Tiene marcapasos, desfibrilador o implantes metálicos internos?',
            vi: 'Bạn có máy tạo nhịp tim, máy phá rung hoặc cấy ghép kim loại không?',
          },
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'q_blood_clots',
          type: 'bool',
          label: {
            'zh-Hans': '您是否有深静脉血栓(DVT)、肺栓塞或严重静脉曲张病史？',
            en: 'Do you have a history of blood clots, DVT, or severe varicose veins?',
            ko: '심부정맥 혈전증(DVT) 또는 심한 하지정맥류 병력이 있으신가요?',
            es: '¿Tiene antecedentes de coágulos sanguíneos, TVP o várices graves?',
            vi: 'Bạn có tiền sử huyết khối tĩnh mạch sâu (DVT) hoặc suy giãn tĩnh mạch nặng không?',
          },
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'q_heart_bp',
          type: 'bool',
          label: {
            'zh-Hans': '您是否有心脏病史、未控制的高血压或低血压？',
            en: 'Do you have a history of heart condition, high or low blood pressure?',
            ko: '심장 질환 또는 고혈압/저혈압 병력이 있으신가요?',
            es: '¿Tiene antecedentes de problemas cardíacos, presión arterial alta o baja?',
            vi: 'Bạn có bệnh tim, cao huyết áp hoặc huyết áp thấp không?',
          },
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'q_spine_injuries',
          type: 'bool',
          label: {
            'zh-Hans': '您是否有颈椎/腰椎间盘突出、急性骨折或骨质疏松？',
            en: 'Do you have spinal/lumbar disc herniation, recent fractures, or osteoporosis?',
            ko: '경추/요추 디스크 탈출증, 최근 골절 또는 골다공증이 있으신가요?',
            es: '¿Tiene hernia discal, fracturas recientes u osteoporosis?',
            vi: 'Bạn có thoát vị đĩa đệm cổ/thắt lưng, gãy xương hoặc loãng xương không?',
          },
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'q_pregnancy',
          type: 'bool',
          label: {
            'zh-Hans': '女性客户：您当前是否处于怀孕或备孕阶段？',
            en: 'For female clients: Are you currently pregnant or trying to conceive?',
            ko: '여성 고객: 현재 임신 중이거나 임신을 준비 중이신가요?',
            es: 'Para clientas: ¿Está actualmente embarazada o intentando concebir?',
            vi: 'Dành cho khách nữ: Bạn hiện có đang mang thai hoặc chuẩn bị mang thai không?',
          },
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'q_allergies',
          type: 'text',
          label: {
            'zh-Hans': '过敏史 (如坚果精油、薰衣草、乳胶手套等，无则填无)：',
            en: 'Allergies (e.g. Nut oils, Lavender, Latex gloves, or None):',
            ko: '알레르기 이력 (예: 넛 오일, 라벤더, 라텍스 장갑 등, 없을 시 없음 입력):',
            es: 'Alergias (ej. aceites de nueces, lavanda, látex, o ninguna):',
            vi: 'Dị ứng (như dầu hạnh nhân, hoa oải hương, găng tay cao su...):',
          },
          required: false,
        },
        {
          id: 'q_surgeries_meds',
          type: 'text',
          label: {
            'zh-Hans': '近两年内的手术创伤史或目前服用的特殊药物 (无则填无)：',
            en: 'Recent surgeries / injuries (past 2 yrs) or current medications:',
            ko: '최근 2년 내 수술/부상 이력 또는 복용 중인 약물 (없을 시 없음 입력):',
            es: 'Cirugías recientes (últimos 2 años) o medicamentos actuales:',
            vi: 'Tiền sử phẫu thuật (2 năm gần đây) hoặc thuốc đang sử dụng:',
          },
          required: false,
        },
      ],
    },
  },

  // 2. 🌸 美容 / 皮肤管理 / 轻医美 (Facials & Skincare / Medspa)
  {
    id: 'facial_skincare',
    category: 'facial',
    name: {
      'zh-Hans': '美容 / 护肤 / 轻医美',
      en: 'Facials & Skincare',
      ko: '피부 관리 & 메디스파',
      es: 'Faciales y Cuidado de Piel',
      vi: 'Chăm Sóc Da & Thẩm Mỹ',
    },
    description: {
      'zh-Hans': '重点排查刷酸光电史、敏感肌屏障、孕哺期状态、口服A酸及过敏源',
      en: 'Screens skin barrier condition, recent chemical peels/lasers, allergies, and pregnancy',
      ko: '필링/레이저 시술 이력, 피부 장벽 상태, 알레르기 및 임신 여부 확인',
      es: 'Evalúa barrera cutánea, peelings/láser recientes, alergias y embarazo',
      vi: 'Kiểm tra tiền sử peel da/laser, hàng rào da, dị ứng và thai kỳ',
    },
    icon: 'Smile',
    color: 'rose',
    template: {
      key: 'facial_skincare_intake',
      title: {
        'zh-Hans': '面部皮肤管理与美容咨询表',
        en: 'Facial Skincare & Aesthetic Consultation Form',
        ko: '피부 관리 및 에스테틱 상담 설문지',
        es: 'Formulario de Consulta Estética Facial',
        vi: 'Bảng Tư Vấn Chăm Sóc Da & Thẩm Mỹ',
      },
      validDays: 180,
      requiresSignature: true,
      serviceIds: [],
      questions: [
        {
          id: 'q_skin_type',
          type: 'choice',
          label: {
            'zh-Hans': '您的主要肤质类型与当前皮肤状态是？',
            en: 'What is your primary skin type and current condition?',
            ko: '귀하의 주요 피부 타입과 현재 상태는 무엇인가요?',
            es: '¿Cuál es su tipo de piel principal y estado actual?',
            vi: 'Loại da chính và tình trạng da hiện tại của bạn là gì?',
          },
          required: true,
          options: [
            { value: 'sensitive', label: { 'zh-Hans': '敏感脆弱泛红 (Sensitive / Rosacea)', en: 'Sensitive / Redness', ko: '민감성 / 홍조', es: 'Sensible / Enrojecimiento', vi: 'Nhạy cảm / Dễ đỏ' } },
            { value: 'dry_dehydrated', label: { 'zh-Hans': '干性 / 严重缺水 (Dry / Dehydrated)', en: 'Dry / Dehydrated', ko: '건성 / 수분 부족', es: 'Seca / Deshidratada', vi: 'Da khô / Thiếu nước' } },
            { value: 'oily_acne', label: { 'zh-Hans': '油性 / 痘痘闭口 (Oily / Acne-prone)', en: 'Oily / Acne-prone', ko: '지성 / 여드름성', es: 'Grasa / Propensa al acné', vi: 'Da dầu / Dễ nổi mụn' } },
            { value: 'combination', label: { 'zh-Hans': '混合性 (Combination)', en: 'Combination', ko: '복합성', es: 'Mixta', vi: 'Da hỗn hợp' } },
          ],
        },
        {
          id: 'q_recent_procedures',
          type: 'multi',
          label: {
            'zh-Hans': '在过去 30 天内，您是否进行过以下任何项目？',
            en: 'Within the last 30 days, have you undergone any of the following?',
            ko: '지난 30일 이내에 다음 시술을 받으신 적이 있나요?',
            es: 'En los últimos 30 días, ¿ha tenido alguno de los siguientes tratamientos?',
            vi: 'Trong 30 ngày qua, bạn có thực hiện liệu trình nào sau đây không?',
          },
          required: true,
          options: [
            { value: 'retinol_aha', label: { 'zh-Hans': '高浓度刷酸 / 维A酸 (Chemical Peel / Retinoids)', en: 'Chemical Peels / Retinol / Tretinoin', ko: '고농도 필링 / 레티놀', es: 'Peelings químicos / Retinol', vi: 'Peel da hóa học / Retinol' } },
            { value: 'laser_ipl', label: { 'zh-Hans': '皮秒 / 光子嫩肤 / 激光 (Laser / IPL / RF)', en: 'Laser / IPL / Radiofrequency', ko: '레이저 / IPL / 고주파', es: 'Láser / IPL / Radiofrecuencia', vi: 'Laser / IPL / RF' } },
            { value: 'injectables', label: { 'zh-Hans': '肉毒素 / 玻尿酸注射 (Botox / Fillers)', en: 'Botox / Dermal Fillers', ko: '보톡스 / 필러 시술', es: 'Bótox / Rellenos dérmicos', vi: 'Tiêm Botox / Filler' } },
            { value: 'sunburn', label: { 'zh-Hans': '近期严重暴晒脱皮 (Recent Sunburn)', en: 'Recent severe sunburn', ko: '최근 심한 일광화상', es: 'Quemadura solar reciente', vi: 'Cháy nắng nặng gần đây' } },
          ],
        },
        {
          id: 'q_accutane_pregnancy',
          type: 'bool',
          label: {
            'zh-Hans': '您是否正在口服异维A酸（如泰尔丝），或当前处于孕哺期？',
            en: 'Are you taking oral Isotretinoin (Accutane), or currently pregnant/nursing?',
            ko: '이소트레티노인(로아큐탄 등)을 복용 중이거나 임신/수유 중이신가요?',
            es: '¿Toma isotretinoína oral (Accutane) o está embarazada/lactando?',
            vi: 'Bạn có đang uống Isotretinoin hoặc đang mang thai/cho con bú không?',
          },
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'q_facial_allergies',
          type: 'text',
          label: {
            'zh-Hans': '请列出护肤品、精油、乳胶或其他已知过敏源（无则填 None）。',
            en: 'List any allergies to skincare products, essential oils, latex, or other known allergens (or enter None).',
            ko: '스킨케어 제품, 에센셜 오일, 라텍스 또는 기타 알레르기를 적어 주세요(없으면 None).',
            es: 'Indique alergias a productos, aceites esenciales, látex u otros alérgenos (o escriba None).',
            vi: 'Liệt kê dị ứng với mỹ phẩm, tinh dầu, cao su hoặc chất khác (hoặc nhập None).',
          },
          required: true,
        },
        {
          id: 'q_skincare_goals',
          type: 'text',
          label: {
            'zh-Hans': '您今天最希望改善的皮肤诉求是？',
            en: 'What is your primary skincare goal for today’s session?',
            ko: '오늘 세션에서 가장 개선하고 싶은 피부 고민은 무엇인가요?',
            es: '¿Cuál es su objetivo principal para el cuidado de la piel hoy?',
            vi: 'Mục tiêu chăm sóc da quan trọng nhất của bạn hôm nay là gì?',
          },
          required: false,
        },
      ],
    },
  },

  // 3. 💅 美甲 / 足疗 (Nails & Pedicure)
  {
    id: 'nail_pedicure',
    category: 'nail',
    name: {
      'zh-Hans': '美甲 / 足疗',
      en: 'Nail & Pedicure',
      ko: '네일 & 페디큐어',
      es: 'Uñas y Pedicura',
      vi: 'Móng & Chăm Sóc Chân',
    },
    description: {
      'zh-Hans': '排查甲真菌、伤口、循环问题与产品过敏，不使用全身人体图',
      en: 'Screens nail health, wounds, circulation concerns, and product allergies without a body map',
      ko: '손발톱 건강, 상처, 순환 문제 및 제품 알레르기 확인',
      es: 'Evalúa uñas, heridas, circulación y alergias a productos',
      vi: 'Kiểm tra móng, vết thương, tuần hoàn và dị ứng sản phẩm',
    },
    icon: 'Sparkles',
    color: 'amber',
    template: {
      key: 'nail_pedicure_intake',
      title: {
        'zh-Hans': '美甲与足部护理咨询表',
        en: 'Nail & Pedicure Consultation Form',
        ko: '네일 및 페디큐어 상담 설문지',
        es: 'Formulario de Uñas y Pedicura',
        vi: 'Bảng Tư Vấn Móng & Chăm Sóc Chân',
      },
      validDays: 180,
      requiresSignature: true,
      serviceIds: [],
      questions: [
        {
          id: 'q_nail_fungus',
          type: 'bool',
          label: {
            'zh-Hans': '您的指甲或脚趾甲近期是否有真菌感染（如灰指甲、增厚变色）或甲沟炎？',
            en: 'Do you currently have nail fungus, discoloration, thickening, or paronychia?',
            ko: '현재 손/발톱 무좀(변색, 두꺼워짐) 또는 조갑주위염(생손앓이)이 있으신가요?',
            es: '¿Tiene actualmente hongos en las uñas, decoloración o inflamación alrededor de la uña?',
            vi: 'Bạn hiện có bị nấm móng (dày móng, đổi màu) hoặc viêm khóe móng không?',
          },
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'q_nail_allergy',
          type: 'bool',
          label: {
            'zh-Hans': '您是否对光疗胶、丙烯酸单体、卸甲液或乳胶过敏？',
            en: 'Are you allergic to gel polish, acrylic monomer, acetone, or latex?',
            ko: '젤 폴리시, 아크릴 모노머, 아세톤 또는 라텍스에 알레르기가 있나요?',
            es: '¿Tiene alergia al gel, monómero acrílico, acetona o látex?',
            vi: 'Bạn có dị ứng với gel, acrylic, acetone hoặc cao su không?',
          },
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'q_nail_wounds',
          type: 'bool',
          label: {
            'zh-Hans': '手或脚目前是否有开放性伤口、红肿、渗液或明显感染迹象？',
            en: 'Do your hands or feet currently have open wounds, swelling, drainage, or signs of infection?',
            ko: '손이나 발에 열린 상처, 붓기, 진물 또는 감염 징후가 있나요?',
            es: '¿Tiene heridas abiertas, hinchazón, secreción o signos de infección en manos o pies?',
            vi: 'Tay hoặc chân hiện có vết thương hở, sưng, chảy dịch hay dấu hiệu nhiễm trùng không?',
          },
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'q_diabetes_circulation', type: 'bool', required: true, sync: 'health_flag',
          label: {
            'zh-Hans': '您是否有糖尿病、神经病变或手足循环不良？',
            en: 'Do you have diabetes, neuropathy, or poor circulation in your hands or feet?',
            ko: '당뇨병, 신경병증 또는 손발 혈액순환 문제가 있나요?',
            es: '¿Tiene diabetes, neuropatía o mala circulación en manos o pies?',
            vi: 'Bạn có tiểu đường, bệnh thần kinh hoặc tuần hoàn tay chân kém không?',
          },
        },
        {
          id: 'q_nail_service_area', type: 'choice', required: true,
          label: { 'zh-Hans': '今天需要护理哪个部位？', en: 'Which area are we servicing today?', ko: '오늘 어느 부위를 관리하나요?', es: '¿Qué zona atenderemos hoy?', vi: 'Hôm nay bạn làm dịch vụ ở vùng nào?' },
          options: [
            { value: 'hands', label: { 'zh-Hans': '手部', en: 'Hands', ko: '손', es: 'Manos', vi: 'Tay' } },
            { value: 'feet', label: { 'zh-Hans': '足部', en: 'Feet', ko: '발', es: 'Pies', vi: 'Chân' } },
            { value: 'both', label: { 'zh-Hans': '手部和足部', en: 'Hands and feet', ko: '손과 발', es: 'Manos y pies', vi: 'Tay và chân' } },
          ],
        },
        {
          id: 'q_nail_symptoms', type: 'multi', required: false,
          label: { 'zh-Hans': '当前是否有以下情况？', en: 'Are you currently experiencing any of these symptoms?', ko: '현재 다음 증상이 있나요?', es: '¿Presenta alguno de estos síntomas?', vi: 'Hiện bạn có triệu chứng nào sau đây?' },
          options: [
            { value: 'none', label: { 'zh-Hans': '无', en: 'None', ko: '없음', es: 'Ninguno', vi: 'Không' } },
            { value: 'pain', label: { 'zh-Hans': '疼痛或触痛', en: 'Pain or tenderness', ko: '통증 또는 압통', es: 'Dolor o sensibilidad', vi: 'Đau hoặc nhạy cảm' } },
            { value: 'redness', label: { 'zh-Hans': '红肿', en: 'Redness or swelling', ko: '붉음 또는 붓기', es: 'Enrojecimiento o hinchazón', vi: 'Đỏ hoặc sưng' } },
            { value: 'broken_skin', label: { 'zh-Hans': '皮肤破损', en: 'Broken skin', ko: '피부 손상', es: 'Piel lesionada', vi: 'Da bị tổn thương' } },
          ],
        },
        {
          id: 'q_nail_pref',
          type: 'choice',
          label: {
            'zh-Hans': '您偏好的指甲修形风格是？',
            en: 'What is your preferred nail shape?',
            ko: '선호하시는 손톱 모양(쉐입)은 무엇인가요?',
            es: '¿Cuál es su forma de uña preferida?',
            vi: 'Dáng móng bạn yêu thích là gì?',
          },
          required: false,
          options: [
            { value: 'oval_round', label: { 'zh-Hans': '经典椭圆 / 圆形 (Oval / Round)', en: 'Oval / Round', ko: '오발 / 라운드', es: 'Ovalada / Redonda', vi: 'Tròn / Bầu dục' } },
            { value: 'square_squoval', label: { 'zh-Hans': '方圆形 / 经典平头 (Squoval / Square)', en: 'Squoval / Square', ko: '스퀘어 / 스쿠오발', es: 'Cuadrada / Squoval', vi: 'Vuông / Vuông bầu' } },
            { value: 'almond_coffin', label: { 'zh-Hans': '杏仁型 / 梯形棺材甲 (Almond / Coffin)', en: 'Almond / Coffin', ko: '아몬드 / 코핀', es: 'Almendra / Coffin', vi: 'Hạnh nhân / Móng quan tài' } },
          ],
        },
      ],
    },
  },

  // 4. 💇 头疗 / 日式头皮养护 (Head Spa & Scalp Therapy)
  {
    id: 'head_spa',
    category: 'scalp',
    name: {
      'zh-Hans': '头疗 / 头皮养护 / 美发',
      en: 'Head Spa & Scalp',
      ko: '헤드스파 & 두피',
      es: 'Head Spa y Cuero Cabelludo',
      vi: 'Gội Đầu Dưỡng Sinh & Head Spa',
    },
    description: {
      'zh-Hans': '重点排查头皮敏感红肿、近期染烫漂发史、染发剂过敏及仰卧颈椎耐受度',
      en: 'Screens scalp sensitivity, recent perm/dye history, PPD allergy, and neck tolerance',
      ko: '두피 민감도, 최근 염색/펌 이력, 염색약 알레르기 및 경추 부담 여부 확인',
      es: 'Evalúa sensibilidad del cuero cabelludo, tintes recientes, alergias y tolerancia cervical',
      vi: 'Kiểm tra độ nhạy cảm da đầu, tiền sử nhuộm uốn, dị ứng thuốc nhuộm & đốt sống cổ',
    },
    icon: 'Scissors',
    color: 'emerald',
    template: {
      key: 'head_spa_intake',
      title: {
        'zh-Hans': '日式头疗与头皮健康咨询表',
        en: 'Head Spa & Scalp Therapy Consultation Form',
        ko: '헤드스파 및 두피 건강 상담 설문지',
        es: 'Formulario de Consulta para Head Spa y Cuero Cabelludo',
        vi: 'Bảng Tư Vấn Gội Đầu Dưỡng Sinh & Chăm Sóc Da Đầu',
      },
      validDays: 180,
      requiresSignature: true,
      serviceIds: [],
      questions: [
        {
          id: 'q_scalp_wounds', type: 'bool', required: true, sync: 'health_flag',
          label: {
            'zh-Hans': '头皮目前是否有开放性伤口、渗液、严重红肿或感染迹象？',
            en: 'Does your scalp currently have open wounds, drainage, severe redness, or signs of infection?',
            ko: '두피에 열린 상처, 진물, 심한 붉음 또는 감염 징후가 있나요?',
            es: '¿Tiene heridas abiertas, secreción, enrojecimiento intenso o infección en el cuero cabelludo?',
            vi: 'Da đầu hiện có vết thương hở, chảy dịch, đỏ nặng hoặc dấu hiệu nhiễm trùng không?',
          },
        },
        {
          id: 'q_recent_hair_treatment', type: 'multi', required: true,
          label: {
            'zh-Hans': '过去 14 天内是否进行过染发、漂发、烫发或头皮化学护理？',
            en: 'Have you had color, bleach, perm, or a chemical scalp treatment within the last 14 days?',
            ko: '지난 14일 이내 염색, 탈색, 펌 또는 두피 화학 시술을 받았나요?',
            es: '¿Ha tenido tinte, decoloración, permanente o tratamiento químico en los últimos 14 días?',
            vi: 'Trong 14 ngày qua bạn có nhuộm, tẩy, uốn hoặc xử lý hóa chất da đầu không?',
          },
          options: [
            { value: 'none', label: { 'zh-Hans': '无', en: 'None', ko: '없음', es: 'Ninguno', vi: 'Không' } },
            { value: 'color', label: { 'zh-Hans': '染发', en: 'Color', ko: '염색', es: 'Tinte', vi: 'Nhuộm' } },
            { value: 'bleach', label: { 'zh-Hans': '漂发', en: 'Bleach', ko: '탈색', es: 'Decoloración', vi: 'Tẩy' } },
            { value: 'perm', label: { 'zh-Hans': '烫发', en: 'Perm', ko: '펌', es: 'Permanente', vi: 'Uốn' } },
          ],
        },
        {
          id: 'q_scalp_condition',
          type: 'choice',
          label: {
            'zh-Hans': '您感觉当前头皮最明显的困扰是？',
            en: 'What is your primary scalp concern right now?',
            ko: '현재 가장 고민되는 두피 증상은 무엇인가요?',
            es: '¿Cuál es su principal molestia en el cuero cabelludo?',
            vi: 'Vấn đề về da đầu bạn quan tâm nhất hiện tại là gì?',
          },
          required: true,
          options: [
            { value: 'oily_dandruff', label: { 'zh-Hans': '出油快 / 伴有头屑头痒 (Oily / Dandruff)', en: 'Oily / Dandruff & Itchiness', ko: '유분 과다 / 비듬 및 가려움', es: 'Grasa / Caspa y picor', vi: 'Nhiều dầu / Gàu ngứa' } },
            { value: 'sensitive_red', label: { 'zh-Hans': '头皮紧绷泛红 / 敏感刺痛 (Sensitive / Redness)', en: 'Tightness / Redness / Sensitive', ko: '두피 당김 / 붉은기 / 민감성', es: 'Tirantez / Enrojecimiento', vi: 'Da đầu căng đỏ / Nhạy cảm' } },
            { value: 'hair_loss', label: { 'zh-Hans': '脱发掉发 / 发缝变宽 (Hair Thinning / Shedding)', en: 'Hair thinning / Shedding', ko: '탈모 / 모발 가늘어짐', es: 'Caída de cabello', vi: 'Rụng tóc / Tóc thưa yếu' } },
            { value: 'normal_relax', label: { 'zh-Hans': '头皮健康，纯放松解压 (Healthy / Deep Relaxation)', en: 'Healthy / Pure Relaxation', ko: '건강함 / 순수 릴랙스', es: 'Saludable / Relajación pura', vi: 'Khỏe mạnh / Muốn thư giãn sâu' } },
          ],
        },
        {
          id: 'q_hair_dye_allergy',
          type: 'bool',
          label: {
            'zh-Hans': '您是否对染发剂（对苯二胺 PPD）、烫发水或特定芳香精油有过敏反应？',
            en: 'Are you allergic to hair dyes (PPD), perming solutions, or essential oils?',
            ko: '염색약(PPD 성분), 펌제 또는 특정 아로마 오일에 알레르기 반응이 있으신가요?',
            es: '¿Tiene alergia a tintes (PPD), permanentes o aceites esenciales?',
            vi: 'Bạn có từng dị ứng với thuốc nhuộm (PPD), thuốc uốn hoặc tinh dầu không?',
          },
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'q_neck_tolerance',
          type: 'choice',
          label: {
            'zh-Hans': '在冲水床仰卧平躺时，您的颈椎舒适度与水压偏好是？',
            en: 'When lying supine at washbasin, what is your neck comfort and water pressure preference?',
            ko: '샴푸대에서 누우실 때 목의 편안함 및 선호 수압은 어떠신가요?',
            es: 'Al recostarse en el lavacabezas, ¿cuál es su comodidad cervical y preferencia de presión?',
            vi: 'Khi nằm gội đầu, tình trạng cổ và áp lực nước bạn mong muốn là gì?',
          },
          required: false,
          options: [
            { value: 'standard_pressure', label: { 'zh-Hans': '颈椎良好，喜欢适中水温水压 (Comfortable / Standard)', en: 'Good neck health, standard water flow', ko: '목 편안함 / 표준 수압', es: 'Cervical bien, presión media', vi: 'Cổ bình thường, áp lực nước vừa' } },
            { value: 'neck_sensitive', label: { 'zh-Hans': '有颈椎酸痛，需垫软枕并减轻仰角 (Neck Sensitive / Extra Cushion)', en: 'Neck stiffness, needs extra pillow/support', ko: '경추 뻐근함 / 목 받침 필요', es: 'Molestia cervical, requiere cojín suave', vi: 'Mỏi cổ, cần gối đỡ mềm' } },
            { value: 'warm_waterfall', label: { 'zh-Hans': '喜欢较热循环水瀑深层熏蒸 (Warm Head Bath Waterfall)', en: 'Prefers warm circulating water bath', ko: '따뜻한 탄산수 스파 선호', es: 'Prefiere cascada de agua caliente', vi: 'Thích thác nước ấm tuần hoàn' } },
          ],
        },
      ],
    },
  },
  {
    id: 'lash_services',
    category: 'lash',
    name: { 'zh-Hans': '美睫服务', en: 'Lash Services', ko: '속눈썹 서비스', es: 'Servicios de Pestañas', vi: 'Dịch Vụ Nối Mi' },
    description: { 'zh-Hans': '排查眼部感染、近期手术、胶水过敏与隐形眼镜佩戴情况', en: 'Screens eye conditions, recent surgery, adhesive allergies, and contact lens use', ko: '눈 상태, 최근 수술, 접착제 알레르기 및 렌즈 착용 확인', es: 'Evalúa ojos, cirugía reciente, alergias y lentes de contacto', vi: 'Kiểm tra mắt, phẫu thuật gần đây, dị ứng keo và kính áp tròng' },
    icon: 'Eye', color: 'violet',
    template: {
      key: 'lash_services_intake', validDays: 180, requiresSignature: true, serviceIds: [],
      title: { 'zh-Hans': '美睫服务安全咨询表', en: 'Lash Service Safety & Consultation Form', ko: '속눈썹 서비스 안전 상담서', es: 'Formulario de Seguridad para Pestañas', vi: 'Bảng An Toàn Dịch Vụ Nối Mi' },
      questions: [
        { id: 'q_lash_allergy', type: 'bool', required: true, sync: 'health_flag', label: { 'zh-Hans': '您是否对美睫胶、氰基丙烯酸酯、胶带或乳胶过敏？', en: 'Are you allergic to lash adhesive, cyanoacrylate, tape, or latex?', ko: '속눈썹 접착제, 시아노아크릴레이트, 테이프 또는 라텍스 알레르기가 있나요?', es: '¿Tiene alergia al adhesivo, cianoacrilato, cinta o látex?', vi: 'Bạn có dị ứng keo nối mi, cyanoacrylate, băng dính hoặc cao su không?' } },
        { id: 'q_eye_surgery', type: 'bool', required: true, sync: 'health_flag', label: { 'zh-Hans': '过去六个月内是否接受过眼部手术或医疗操作？', en: 'Have you had eye surgery or a medical eye procedure within the last six months?', ko: '지난 6개월 내 안과 수술 또는 시술을 받았나요?', es: '¿Ha tenido cirugía o procedimiento ocular en los últimos seis meses?', vi: 'Bạn có phẫu thuật hoặc thủ thuật mắt trong sáu tháng qua không?' } },
        { id: 'q_eye_condition', type: 'bool', required: true, sync: 'health_flag', label: { 'zh-Hans': '目前是否有结膜炎、麦粒肿、眼睑红肿、渗液或其他眼部感染？', en: 'Do you currently have conjunctivitis, a stye, eyelid swelling, drainage, or another eye infection?', ko: '현재 결막염, 다래끼, 눈꺼풀 붓기, 분비물 또는 감염이 있나요?', es: '¿Tiene conjuntivitis, orzuelo, hinchazón, secreción u otra infección ocular?', vi: 'Bạn hiện có viêm kết mạc, lẹo mắt, sưng mí, chảy dịch hoặc nhiễm trùng mắt không?' } },
        { id: 'q_contact_lenses', type: 'bool', required: true, label: { 'zh-Hans': '今天是否佩戴隐形眼镜？', en: 'Are you wearing contact lenses today?', ko: '오늘 콘택트렌즈를 착용했나요?', es: '¿Lleva lentes de contacto hoy?', vi: 'Hôm nay bạn có đeo kính áp tròng không?' } },
        { id: 'q_lash_reaction', type: 'text', required: false, label: { 'zh-Hans': '请描述以往美睫后的刺激或不良反应。', en: 'Describe any irritation or reaction after a previous lash service.', ko: '이전 속눈썹 시술 후 자극이나 반응을 설명해 주세요.', es: 'Describa cualquier irritación tras un servicio anterior.', vi: 'Mô tả kích ứng hoặc phản ứng sau lần nối mi trước.' } },
        { id: 'q_lash_goal', type: 'text', required: false, label: { 'zh-Hans': '今天希望达到什么样的美睫效果？', en: 'What lash result would you like today?', ko: '오늘 원하는 속눈썹 스타일은 무엇인가요?', es: '¿Qué resultado de pestañas desea hoy?', vi: 'Hôm nay bạn muốn kiểu mi như thế nào?' } },
      ],
    },
  },
  {
    id: 'hair_services',
    category: 'hair',
    name: { 'zh-Hans': '美发服务', en: 'Hair Services', ko: '헤어 서비스', es: 'Servicios de Cabello', vi: 'Dịch Vụ Tóc' },
    description: { 'zh-Hans': '排查染烫化学品过敏、头皮伤口与近期化学处理历史', en: 'Screens chemical allergies, scalp wounds, and recent color or texture services', ko: '화학 알레르기, 두피 상처 및 최근 시술 이력 확인', es: 'Evalúa alergias químicas, heridas y servicios recientes', vi: 'Kiểm tra dị ứng hóa chất, vết thương da đầu và dịch vụ gần đây' },
    icon: 'Scissors', color: 'blue',
    template: {
      key: 'hair_services_intake', validDays: 180, requiresSignature: true, serviceIds: [],
      title: { 'zh-Hans': '美发与头皮安全咨询表', en: 'Hair & Scalp Safety Consultation Form', ko: '헤어 및 두피 안전 상담서', es: 'Formulario de Seguridad Capilar', vi: 'Bảng An Toàn Tóc & Da Đầu' },
      questions: [
        { id: 'q_hair_chemical_allergy', type: 'bool', required: true, sync: 'health_flag', label: { 'zh-Hans': '您是否对染发剂、PPD、漂粉、烫发剂或护发产品过敏？', en: 'Are you allergic to hair color, PPD, bleach, perm solution, or hair products?', ko: '염색약, PPD, 탈색제, 펌제 또는 헤어 제품 알레르기가 있나요?', es: '¿Tiene alergia a tintes, PPD, decolorante, permanente o productos capilares?', vi: 'Bạn có dị ứng thuốc nhuộm, PPD, thuốc tẩy, thuốc uốn hoặc sản phẩm tóc không?' } },
        { id: 'q_hair_scalp_wounds', type: 'bool', required: true, sync: 'health_flag', label: { 'zh-Hans': '头皮目前是否有开放性伤口、严重刺激或感染迹象？', en: 'Does your scalp currently have open wounds, severe irritation, or signs of infection?', ko: '두피에 열린 상처, 심한 자극 또는 감염 징후가 있나요?', es: '¿Tiene heridas abiertas, irritación intensa o infección en el cuero cabelludo?', vi: 'Da đầu hiện có vết thương hở, kích ứng nặng hoặc dấu hiệu nhiễm trùng không?' } },
        { id: 'q_recent_chemical_service', type: 'text', required: true, label: { 'zh-Hans': '请列出过去六个月的染发、漂发、烫发、拉直或角蛋白护理。', en: 'List any color, bleach, perm, relaxer, or keratin services from the last six months.', ko: '지난 6개월 내 염색, 탈색, 펌, 매직 또는 케라틴 시술을 적어 주세요.', es: 'Indique tintes, decoloración, permanente, alisado o queratina de los últimos seis meses.', vi: 'Liệt kê nhuộm, tẩy, uốn, duỗi hoặc keratin trong sáu tháng qua.' } },
        { id: 'q_hair_condition', type: 'choice', required: true, label: { 'zh-Hans': '您当前的主要发质状态是？', en: 'What is your current primary hair condition?', ko: '현재 주요 모발 상태는 무엇인가요?', es: '¿Cuál es el estado principal de su cabello?', vi: 'Tình trạng tóc chính hiện tại là gì?' }, options: [
          { value: 'healthy', label: { 'zh-Hans': '健康', en: 'Healthy', ko: '건강함', es: 'Saludable', vi: 'Khỏe' } },
          { value: 'dry', label: { 'zh-Hans': '干燥受损', en: 'Dry or damaged', ko: '건조 또는 손상', es: 'Seco o dañado', vi: 'Khô hoặc hư tổn' } },
          { value: 'fragile', label: { 'zh-Hans': '脆弱易断', en: 'Fragile or breaking', ko: '약하거나 끊어짐', es: 'Frágil o quebradizo', vi: 'Yếu hoặc dễ gãy' } },
        ] },
        { id: 'q_hair_goal', type: 'text', required: false, label: { 'zh-Hans': '今天希望完成什么服务或效果？', en: 'What service or result would you like today?', ko: '오늘 원하는 서비스 또는 결과는 무엇인가요?', es: '¿Qué servicio o resultado desea hoy?', vi: 'Hôm nay bạn muốn dịch vụ hoặc kết quả gì?' } },
      ],
    },
  },
];
