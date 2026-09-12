import type { FormQuestion } from './api';
import {
  INDUSTRY_HEALTH_FORM_PRESETS,
  type IndustryHealthFormPreset,
} from '@gf/contracts';

import type { HealthAiSummary } from '@gf/contracts';
export type { HealthAiSummary } from '@gf/contracts';

export interface FormSubmissionRecord {
  id: string;
  templateKey: string;
  templateTitle: Record<string, string>;
  templateVersion: number;
  customerName: string;
  customerPhone: string;
  customerAvatar?: string;
  submittedAt: string;
  expiresAt: string | null;
  status: 'valid' | 'flagged' | 'expired';
  hasHealthFlag: boolean;
  avoidAreas: string[];
  answers: Record<string, any>;
  signatureDataUrl?: string;
  serviceName?: string;
  aiSummary?: HealthAiSummary;
}

export type IndustryPreset = IndustryHealthFormPreset;
export const INDUSTRY_PRESETS = INDUSTRY_HEALTH_FORM_PRESETS;

export function generateAiHealthSummary(record: Partial<FormSubmissionRecord>): HealthAiSummary {
  const isMassage = record.templateKey?.includes('massage') || record.serviceName?.includes('Massage');
  const isFacial = record.templateKey?.includes('facial') || record.serviceName?.includes('Facial');
  const isNail = record.templateKey?.includes('nail') || record.serviceName?.includes('Nail');
  const isHeadSpa = record.templateKey?.includes('head_spa') || record.serviceName?.includes('Scalp');

  const answers = record.answers || {};
  const hasHealthFlag = Boolean(record.hasHealthFlag || answers.q_pacemaker || answers.q_blood_clots || answers.conditions?.pacemaker || answers.conditions?.blood_clots);
  const avoidAreas = record.avoidAreas || answers.bodyMapAvoid || [];
  const focusAreas = answers.bodyMapFocus || [];
  const pain = Number(answers.painLevel ?? 0);

  let riskLevel: 'low' | 'moderate' | 'high' = 'low';
  if (hasHealthFlag || pain >= 7 || answers.q_pacemaker || answers.conditions?.pacemaker) {
    riskLevel = 'high';
  } else if (avoidAreas.length > 0 || pain >= 4 || answers.q_spine_injuries || answers.conditions?.spine_neck) {
    riskLevel = 'moderate';
  }

  if (isMassage) {
    return {
      riskLevel,
      headline: {
        'zh-Hans': riskLevel === 'high' ? '⚠️ 高风险关注：存在红线健康史，需严格避开指定区域' : riskLevel === 'moderate' ? '⚡ 中度关注：需重点护理肩颈并避开劳损下背' : '🟢 健康良好：常规中等力度全身放松',
        en: riskLevel === 'high' ? '⚠️ High Attention: Flagged medical history requires strict area avoidance' : riskLevel === 'moderate' ? '⚡ Moderate Attention: Focus on upper back and gentle pressure on lumbar' : '🟢 Good Health: Standard full-body relaxation protocol',
        ko: riskLevel === 'high' ? '⚠️ 고위험 주의: 기저 질환으로 인한 특정 부위 압력 제한 필요' : riskLevel === 'moderate' ? '⚡ 중간 주의: 상체 견갑 집중 및 허리 완화' : '🟢 정상 양호: 표준 전신 마사지 진행 가능',
        es: riskLevel === 'high' ? '⚠️ Atención Alta: Historial médico requiere evitar zonas específicas' : riskLevel === 'moderate' ? '⚡ Atención Media: Enfoque en espalda alta y cuidado lumbar' : '🟢 Buen Estado: Protocolo estándar de relajación corporal',
        vi: riskLevel === 'high' ? '⚠️ Chú ý Cao: Có tiền sử bệnh cần tuyệt đối tránh các vùng chỉ định' : riskLevel === 'moderate' ? '⚡ Chú ý Vừa: Tập trung lưng trên & giảm lực vùng thắt lưng' : '🟢 Sức khỏe Tốt: Quy trình thư giãn toàn thân tiêu chuẩn',
      },
      keyAlerts: {
        'zh-Hans': [
          ...(answers.q_pacemaker || answers.conditions?.pacemaker ? ['体内装有心脏起搏器/金属植入物 (严禁强电磁/重敲)'] : []),
          ...(answers.q_blood_clots || answers.conditions?.blood_clots ? ['有下肢静脉血栓/DVT病史 (禁止重手法推小腿)'] : []),
          ...(answers.q_spine_injuries || answers.conditions?.spine_neck ? ['有颈椎/腰椎损伤史 (避免大力扳动旋转)'] : []),
          ...(answers.q_pregnancy || answers.conditions?.pregnancy ? ['客户处于孕期 (严禁按压合谷、三阴交及腹部)'] : []),
          ...(pain >= 4 ? [`当前疼痛等级评分：${pain}/10 (${answers.painFrequency === 'constant' ? '持续性' : '间歇性'})`] : []),
        ],
        en: [
          ...(answers.q_pacemaker || answers.conditions?.pacemaker ? ['Pacemaker / Metal Implants (No heavy percussive vibration)'] : []),
          ...(answers.q_blood_clots || answers.conditions?.blood_clots ? ['History of Blood Clots/DVT (Avoid deep calf pressure)'] : []),
          ...(answers.q_spine_injuries || answers.conditions?.spine_neck ? ['Spine / Lumbar history (Avoid aggressive spinal manipulation)'] : []),
          ...(answers.q_pregnancy || answers.conditions?.pregnancy ? ['Pregnant guest (Avoid contraindicated pressure points)'] : []),
          ...(pain >= 4 ? [`Pain level score: ${pain}/10 (${answers.painFrequency === 'constant' ? 'Constant' : 'Intermittent'})`] : []),
        ],
        ko: [
          ...(answers.q_pacemaker || answers.conditions?.pacemaker ? ['체내 심장 박동기/금속 삽입물 (강한 진동/타격 금지)'] : []),
          ...(answers.q_blood_clots || answers.conditions?.blood_clots ? ['하지정맥 혈전증 병력 (종아리 깊은 압박 금지)'] : []),
          ...(answers.q_spine_injuries || answers.conditions?.spine_neck ? ['경추/요추 부상 이력 (과도한 척추 교정 금지)'] : []),
          ...(answers.q_pregnancy || answers.conditions?.pregnancy ? ['임산부 고객 (자궁 수축 유발 혈자리 절대 회피)'] : []),
          ...(pain >= 4 ? [`통증 척도 평가: ${pain}/10`] : []),
        ],
        es: [
          ...(answers.q_pacemaker || answers.conditions?.pacemaker ? ['Marcapasos / Implantes metálicos (Sin percusión fuerte)'] : []),
          ...(answers.q_blood_clots || answers.conditions?.blood_clots ? ['Historial de trombosis/TVP (Evitar presión profunda en pantorrillas)'] : []),
          ...(answers.q_spine_injuries || answers.conditions?.spine_neck ? ['Lesión cervical/lumbar (Evitar manipulaciones bruscas)'] : []),
          ...(answers.q_pregnancy || answers.conditions?.pregnancy ? ['Clienta embarazada (Evitar puntos de presión contraindicados)'] : []),
          ...(pain >= 4 ? [`Puntuación de dolor: ${pain}/10`] : []),
        ],
        vi: [
          ...(answers.q_pacemaker || answers.conditions?.pacemaker ? ['Máy tạo nhịp tim/kim loại (Không đấm rung mạnh)'] : []),
          ...(answers.q_blood_clots || answers.conditions?.blood_clots ? ['Tiền sử huyết khối tĩnh mạch (Tránh ấn sâu bắp chân)'] : []),
          ...(answers.q_spine_injuries || answers.conditions?.spine_neck ? ['Tiền sử đau cột sống/cổ (Tránh bẻ vặn mạnh)'] : []),
          ...(answers.q_pregnancy || answers.conditions?.pregnancy ? ['Khách đang mang thai (Tránh bấm huyệt nhạy cảm)'] : []),
          ...(pain >= 4 ? [`Điểm đau hiện tại: ${pain}/10`] : []),
        ],
      },
      avoidAreasList: {
        'zh-Hans': avoidAreas.length > 0 ? avoidAreas : ['暂无特殊避开部位'],
        en: avoidAreas.length > 0 ? avoidAreas : ['No specific areas to avoid'],
        ko: avoidAreas.length > 0 ? avoidAreas : ['특별한 회피 부위 없음'],
        es: avoidAreas.length > 0 ? avoidAreas : ['Sin zonas específicas a evitar'],
        vi: avoidAreas.length > 0 ? avoidAreas : ['Không có vùng cần tránh đặc biệt'],
      },
      focusNotes: {
        'zh-Hans': `客户主诉诉求：${focusAreas.join('、') || '肩颈上背部'}，期望力度为【${answers.q_pressure_pref === 'deep_strong' ? '深层强劲' : answers.q_pressure_pref === 'gentle' ? '轻柔舒缓' : '中等适中'}】。`,
        en: `Customer Focus: ${focusAreas.join(', ') || 'Upper Back & Neck'}, preferred pressure is [${answers.q_pressure_pref === 'deep_strong' ? 'Deep Tissue' : answers.q_pressure_pref === 'gentle' ? 'Gentle' : 'Medium'}].`,
        ko: `고객 요청 집중 부위: ${focusAreas.join(', ') || '어깨 및 목/상체'}, 선호 강도는 [${answers.q_pressure_pref === 'deep_strong' ? '강하게' : answers.q_pressure_pref === 'gentle' ? '부드럽게' : '보통'}]입니다.`,
        es: `Zonas de enfoque: ${focusAreas.join(', ') || 'Espalda superior y cuello'}, presión deseada [${answers.q_pressure_pref === 'deep_strong' ? 'Fuerte' : answers.q_pressure_pref === 'gentle' ? 'Suave' : 'Media'}].`,
        vi: `Vùng yêu cầu tập trung: ${focusAreas.join(', ') || 'Lưng trên & Cổ vai gáy'}, lực mong muốn [${answers.q_pressure_pref === 'deep_strong' ? 'Mạnh' : answers.q_pressure_pref === 'gentle' ? 'Nhẹ nhàng' : 'Vừa phải'}].`,
      },
      technicianAdvice: {
        'zh-Hans': '1. 施术前先口头确认肩颈酸痛点；2. 腰椎及避开区域改用温热毛巾热敷或极轻柔抚触，切忌强力按压；3. 上背部采用中等力度掌揉结合点按天宗穴与肩井穴。',
        en: '1. Verbally verify shoulder/neck pain points before starting; 2. Use warm towels or feather-light touch on avoid areas, avoiding deep pressure; 3. Focus palm kneading and acupressure on upper back scapular muscles.',
        ko: '1. 시작 전 어깨/목 뻐근함 부위를 고객과 재확인하세요; 2. 회피 부위(허리 등)는 온습포 찜질 위주로 부드럽게 진행하세요; 3. 견갑골 주변을 손바닥 압박과 부드러운 지압으로 이완하세요.',
        es: '1. Confirmar verbalmente los puntos de dolor antes de iniciar; 2. Usar toallas calientes o tacto muy suave en zonas a evitar; 3. Centrar amasamiento medio en trapecios y escápulas.',
        vi: '1. Xác nhận lại điểm đau mỏi cổ vai trước khi làm; 2. Dùng khăn ấm xoa dịu nhẹ nhàng vùng cần tránh, không ấn sâu; 3. Tập trung miết cơ và day ấn vùng cơ thang bả vai.',
      },
    };
  }

  // 默认通用美容/美甲/头疗分析
  return {
    riskLevel,
    headline: {
      'zh-Hans': riskLevel === 'high' ? '⚠️ 高风险关注：存在过敏史或术前排查项目' : '🟢 状况良好：可按标准专业流程施术',
      en: riskLevel === 'high' ? '⚠️ High Attention: Allergy or contraindication detected' : '🟢 Healthy & Normal: Proceed with standard service protocol',
      ko: riskLevel === 'high' ? '⚠️ 주의 필요: 알레르기 또는 사전 확인 항목 존재' : '🟢 상태 양호: 표준 서비스 프로토콜 진행 가능',
      es: riskLevel === 'high' ? '⚠️ Atención: Alergia o contraindicación detectada' : '🟢 Estado Normal: Proceder con protocolo estándar',
      vi: riskLevel === 'high' ? '⚠️ Cần Chú ý: Có cảnh báo dị ứng hoặc tiền sử nhạy cảm' : '🟢 Bình thường: Thực hiện theo quy trình chuẩn',
    },
    keyAlerts: {
      'zh-Hans': isFacial
        ? ['近30天刷酸/光电激光史排查', '敏感屏障修护诉求']
        : isNail
        ? ['甲真菌/甲沟炎排查正常', '光疗胶/丙烯酸耐受']
        : ['头皮出油/敏感状态排查', '染发剂PPD过敏史'],
      en: isFacial
        ? ['Recent chemical peel / laser screening', 'Skin barrier soothing focus']
        : isNail
        ? ['Nail fungus & cuticle screening clear', 'Gel / acrylic tolerance']
        : ['Scalp sensitivity screening', 'PPD hair dye allergy check'],
      ko: isFacial
        ? ['최근 30일 필링/레이저 시술 이력 확인', '피부 장벽 진정 케어']
        : isNail
        ? ['무좀/조갑주위염 확인 완료', '젤/아크릴 알레르기 확인']
        : ['두피 유분/민감도 확인', 'PPD 염색약 알레르기 확인'],
      es: isFacial
        ? ['Revisión de peelings químicos/láser recientes', 'Cuidado de barrera cutánea']
        : isNail
        ? ['Revisión de hongos y cutículas', 'Tolerancia a geles/acrílicos']
        : ['Revisión de sensibilidad de cuero cabelludo', 'Alergia a tintes PPD'],
      vi: isFacial
        ? ['Kiểm tra tiền sử peel da/laser gần đây', 'Phục hồi hàng rào da']
        : isNail
        ? ['Kiểm tra nấm móng và biểu bì', 'Độ tương thích gel/acrylic']
        : ['Kiểm tra tình trạng dầu/nhạy cảm da đầu', 'Kiểm tra dị ứng thuốc nhuộm PPD'],
    },
    avoidAreasList: {
      'zh-Hans': avoidAreas.length > 0 ? avoidAreas : ['暂无特殊避让区域'],
      en: avoidAreas.length > 0 ? avoidAreas : ['No specific avoid areas'],
      ko: avoidAreas.length > 0 ? avoidAreas : ['특별한 회피 부위 없음'],
      es: avoidAreas.length > 0 ? avoidAreas : ['Sin zonas a evitar'],
      vi: avoidAreas.length > 0 ? avoidAreas : ['Không có vùng cần tránh'],
    },
    focusNotes: {
      'zh-Hans': '顾客期望获得专业舒缓且个性化的服务体验。',
      en: 'Customer expects a personalized and soothing professional experience.',
      ko: '고객은 맞춤형의 편안한 전문 케어를 기대하고 있습니다.',
      es: 'El cliente espera una experiencia profesional personalizada y relajante.',
      vi: 'Khách hàng mong muốn trải nghiệm dịch vụ chuyên nghiệp và thư giãn.',
    },
    technicianAdvice: {
      'zh-Hans': '操作前核对过敏源与皮肤耐受度，施术中随时询问舒适感。',
      en: 'Double-check allergies and skin sensitivity prior to treatment; check in on comfort during session.',
      ko: '시술 전 알레르기 유무를 재확인하고, 시술 중 지속적으로 편안함을 확인하세요.',
      es: 'Verificar alergias antes del tratamiento y consultar la comodidad del cliente durante la sesión.',
      vi: 'Kiểm tra dị ứng trước khi thực hiện và hỏi thăm cảm giác của khách trong quá trình làm.',
    },
  };
}


export const MOCK_SUBMISSIONS: FormSubmissionRecord[] = [
  {
    id: 'sub_001',
    templateKey: 'massage_intake',
    templateTitle: {
      'zh-Hans': '按摩理疗与水疗健康知情同意表',
      en: 'Massage & Spa Client Intake & Health History',
      ko: '마사지 & 스파 고객 건강 차트 및 동의서',
      es: 'Historial de Salud y Consentimiento de Masaje',
      vi: 'Bảng Tư Vấn & Cam Kết Sức Khỏe Massage Spa',
    },
    templateVersion: 1,
    customerName: 'Sarah Jenkins',
    customerPhone: '+1 (415) 890-2134',
    customerAvatar: 'SJ',
    submittedAt: '2026-08-28T14:22:00Z',
    expiresAt: '2027-08-28T14:22:00Z',
    status: 'flagged',
    hasHealthFlag: true,
    avoidAreas: ['Lower Back / Lumbar'],
    answers: {
      q_pressure_pref: 'medium',
      q_pacemaker: false,
      q_blood_clots: false,
      q_heart_bp: false,
      q_spine_injuries: true,
      q_pregnancy: false,
      q_allergies: 'None',
      bodyMapFocus: ['Upper Back / Scapula', 'Neck/Throat'],
      painLevel: 5,
      painFrequency: 'intermittent',
      painDescription: 'Stiff neck and shoulder knots from computer desk work.',
    },
    serviceName: '60 Min Deep Tissue Massage',
  },
  {
    id: 'sub_002',
    templateKey: 'facial_skincare_intake',
    templateTitle: {
      'zh-Hans': '面部皮肤管理与美容咨询表',
      en: 'Facial Skincare & Aesthetic Consultation Form',
      ko: '피부 관리 및 에스테틱 상담 설문지',
      es: 'Formulario de Consulta Estética Facial',
      vi: 'Bảng Tư Vấn Chăm Sóc Da & Thẩm Mỹ',
    },
    templateVersion: 1,
    customerName: 'Michael Chang',
    customerPhone: '+1 (415) 555-9081',
    customerAvatar: 'MC',
    submittedAt: '2026-08-28T10:15:00Z',
    expiresAt: '2027-02-28T10:15:00Z',
    status: 'valid',
    hasHealthFlag: false,
    avoidAreas: [],
    answers: {
      q_skin_type: 'combination',
      q_recent_procedures: ['retinol_aha'],
      q_accutane_pregnancy: false,
      q_skincare_goals: 'Deep blackhead extraction and soothing redness.',
    },
    serviceName: 'HydraFacial Glow Treatment',
  },
  {
    id: 'sub_003',
    templateKey: 'nail_lash_intake',
    templateTitle: {
      'zh-Hans': '美甲美睫与足部护理知情咨询表',
      en: 'Nail, Lash & Foot Care Consultation Form',
      ko: '네일, 속눈썹 및 페디케어 사전 상담 설문지',
      es: 'Formulario de Consulta para Uñas, Pestañas y Pedicura',
      vi: 'Bảng Tư Vấn Dịch Vụ Móng, Nối Mi & Chăm Sóc Chân',
    },
    templateVersion: 1,
    customerName: 'Emily Watson',
    customerPhone: '+1 (415) 342-1190',
    customerAvatar: 'EW',
    submittedAt: '2026-08-27T16:45:00Z',
    expiresAt: '2027-02-27T16:45:00Z',
    status: 'valid',
    hasHealthFlag: false,
    avoidAreas: [],
    answers: {
      q_nail_fungus: false,
      q_glue_allergy: false,
      q_nail_pref: 'almond_coffin',
    },
    serviceName: 'Gel X Extension + Custom Nail Art',
  },
  {
    id: 'sub_004',
    templateKey: 'head_spa_intake',
    templateTitle: {
      'zh-Hans': '日式头疗与头皮健康咨询表',
      en: 'Head Spa & Scalp Therapy Consultation Form',
      ko: '헤드스파 및 두피 건강 상담 설문지',
      es: 'Formulario de Consulta para Head Spa y Cuero Cabelludo',
      vi: 'Bảng Tư Vấn Gội Đầu Dưỡng Sinh & Chăm Sóc Da Đầu',
    },
    templateVersion: 1,
    customerName: 'David Lee',
    customerPhone: '+1 (415) 229-8871',
    customerAvatar: 'DL',
    submittedAt: '2026-08-26T11:00:00Z',
    expiresAt: '2027-02-26T11:00:00Z',
    status: 'valid',
    hasHealthFlag: false,
    avoidAreas: [],
    answers: {
      q_scalp_condition: 'oily_dandruff',
      q_hair_dye_allergy: false,
      q_neck_tolerance: 'warm_waterfall',
    },
    serviceName: 'Japanese Scalp Waterfall Therapy',
  },
];

// 初始化 AI 总结
MOCK_SUBMISSIONS.forEach((sub) => {
  sub.aiSummary = generateAiHealthSummary(sub);
});

export const AI_QUICK_PROMPTS = [
  {
    id: 'specialty_intake',
    label: {
      'zh-Hans': '✨ 生成针对性特色问卷',
      en: '✨ Generate specialty intake',
      ko: '✨ 매장 맞춤 문진표 생성',
      es: '✨ Generar cuestionario especializado',
      vi: '✨ Tạo biểu mẫu chuyên sâu',
    },
    prompt: '为本店特色项目生成一套包含术前禁忌、过敏史及偏好评估的专业问卷',
    actionType: 'generate_specialty',
  },
  {
    id: 'legal_waiver',
    label: {
      'zh-Hans': '⚖️ 增补法律免责声明',
      en: '⚖️ Add liability disclaimer',
      ko: '⚖️ 법적 면책 조항 추가',
      es: '⚖️ Añadir cláusula de exención',
      vi: '⚖️ Thêm điều khoản miễn trừ',
    },
    prompt: '添加具有法律合规效力的知情同意与免责声明条款',
    actionType: 'add_disclaimer',
  },
  {
    id: 'safety_check',
    label: {
      'zh-Hans': '🛡️ 增补禁忌症排查',
      en: '🛡️ Add safety contraindications',
      ko: '🛡️ 금기 사항 체크 추가',
      es: '🛡️ Añadir contraindicaciones',
      vi: '🛡️ Thêm kiểm tra chống chỉ định',
    },
    prompt: '增加针对传染性皮肤病、起搏器及开放性创口的红线安全排查',
    actionType: 'add_safety',
  },
  {
    id: 'auto_translate',
    label: {
      'zh-Hans': '🌐 一键 5 语系润色翻译',
      en: '🌐 Translate to 5 languages',
      ko: '🌐 5개 언어 자동 번역',
      es: '🌐 Traducir a 5 idiomas',
      vi: '🌐 Dịch sang 5 ngôn ngữ',
    },
    prompt: '将当前问卷的所有题目和选项翻译并润色为中、英、韩、西、越 5 语系',
    actionType: 'translate_all',
  },
];
