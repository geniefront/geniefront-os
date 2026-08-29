import type { SaveFormTemplateInput } from './api';

const i18n = (zh: string, en: string, ko: string, es: string, vi: string) => ({
  'zh-Hans': zh,
  en,
  ko,
  es,
  vi,
});

export const FORM_PRESETS: Array<{
  id: 'massage' | 'facial' | 'nail' | 'blank';
  name: string;
  description: string;
  template: SaveFormTemplateInput;
}> = [
  {
    id: 'massage',
    name: '按摩 / 足疗健康表',
    description: '过敏、健康禁忌、需避开部位和力度偏好。',
    template: {
      key: 'massage_intake',
      title: i18n('按摩 / 足疗健康表', 'Massage health intake', '마사지 및 발 관리 건강 설문', 'Formulario de salud para masaje', 'Phiếu khai báo sức khỏe massage'),
      requiresSignature: true,
      validDays: 365,
      serviceIds: [],
      questions: [
        {
          id: 'health_conditions',
          type: 'bool',
          label: i18n('是否有需要我们注意的健康状况？', 'Do you have a health condition we should know about?', '저희가 알아야 할 특별한 건강 상태가 있으신가요?', '¿Tiene alguna afección de salud que debamos conocer?', 'Bạn có tình trạng sức khỏe nào cần chúng tôi lưu ý không?'),
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'allergies',
          type: 'text',
          label: i18n('请填写过敏或敏感情况', 'Please list allergies or sensitivities', '알레르기 또는 민감 반응이 있다면 적어주세요', 'Por favor indique alergias o sensibilidades', 'Vui lòng ghi rõ dị ứng hoặc mẫn cảm nếu có'),
          required: false,
        },
        {
          id: 'avoid_areas',
          type: 'multi',
          label: i18n('需要避开的部位', 'Areas to avoid', '마사지를 피해야 할 부위', 'Áreas del cuerpo a evitar', 'Các vùng cơ thể cần tránh'),
          required: false,
          sync: 'avoid_areas',
          options: [
            { value: 'head', label: i18n('头部', 'Head', '머리', 'Cabeza', 'Đầu') },
            { value: 'neck', label: i18n('颈部', 'Neck', '목', 'Cuello', 'Cổ') },
            { value: 'back', label: i18n('背部', 'Back', '등', 'Espalda', 'Lưng') },
            { value: 'legs', label: i18n('腿部', 'Legs', '다리', 'Piernas', 'Chân') },
            { value: 'feet', label: i18n('足部', 'Feet', '발', 'Pies', 'Bàn chân') },
          ],
        },
        {
          id: 'pressure',
          type: 'choice',
          label: i18n('偏好的按摩力度', 'Preferred pressure', '선호하는 마사지 강도', 'Presión de masaje preferida', 'Lực mát xa ưa thích'),
          required: true,
          options: [
            { value: 'light', label: i18n('轻柔', 'Light', '부드럽게', 'Suave', 'Nhẹ nhàng') },
            { value: 'medium', label: i18n('适中', 'Medium', '보통', 'Moderada', 'Vừa phải') },
            { value: 'firm', label: i18n('较重', 'Firm', '강하게', 'Fuerte', 'Mạnh') },
          ],
        },
      ],
    },
  },
  {
    id: 'facial',
    name: '美容 / 面部护理表',
    description: '皮肤敏感、药物与近期美容项目。',
    template: {
      key: 'facial_intake',
      title: i18n('美容 / 面部护理表', 'Facial treatment intake', '피부 미용 및 페이셜 관리 설문', 'Formulario de tratamiento facial', 'Phiếu chăm sóc da mặt'),
      requiresSignature: true,
      validDays: 180,
      serviceIds: [],
      questions: [
        {
          id: 'skin_allergy',
          type: 'bool',
          label: i18n('是否有皮肤过敏或敏感？', 'Do you have skin allergies or sensitivities?', '피부 알레르기나 민감성 반응이 있으신가요?', '¿Tiene alergias o sensibilidad en la piel?', 'Bạn có bị dị ứng hoặc mẫn cảm da không?'),
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'medications',
          type: 'text',
          label: i18n('请填写相关药物或外用产品', 'List relevant medications or topical products', '복용 중인 약물이나 사용 중인 제품이 있다면 적어주세요', 'Indique medicamentos o productos tópicos relevantes', 'Ghi rõ các loại thuốc hoặc sản phẩm bôi ngoài da'),
          required: false,
        },
        {
          id: 'recent_treatment',
          type: 'text',
          label: i18n('近期是否做过刷酸、激光、注射或手术？', 'Recent peels, laser, injections or surgery', '최근 필링, 레이저, 시술 또는 수술을 받은 적이 있나요?', '¿Ha tenido exfoliaciones, láser, inyecciones o cirugías recientes?', 'Gần đây bạn có peel da, laser, tiêm hoặc phẫu thuật không?'),
          required: false,
        },
      ],
    },
  },
  {
    id: 'nail',
    name: '美甲 / 美睫服务同意书',
    description: '过敏、感染风险与服务同意。',
    template: {
      key: 'nail_consent',
      title: i18n('美甲 / 美睫服务同意书', 'Nail and lash service consent', '네일 및 속눈썹 시술 동의서', 'Consentimiento de uñas y pestañas', 'Phiếu đồng thuận dịch vụ móng và mi'),
      requiresSignature: true,
      validDays: 365,
      serviceIds: [],
      questions: [
        {
          id: 'allergy',
          type: 'bool',
          label: i18n('是否对胶水、甲油胶或水晶粉过敏？', 'Any known allergy to adhesives, gel or acrylic products?', '접착제, 젤 또는 아크릴 제품에 알레르기가 있으신가요?', '¿Tiene alergia a adhesivos, gel o productos acrílicos?', 'Bạn có dị ứng với keo, gel hoặc bột acrylic không?'),
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'infection',
          type: 'bool',
          label: i18n('目前是否有感染、伤口或刺激症状？', 'Any current infection, open wound or irritation?', '현재 감염, 상처 또는 자극 증상이 있으신가요?', '¿Tiene alguna infección, herida abierta o irritación actual?', 'Hiện tại có bị nhiễm trùng, vết thương hở hay kích ứng không?'),
          required: true,
          sync: 'health_flag',
        },
        {
          id: 'consent',
          type: 'bool',
          label: i18n('我已了解服务内容并同意进行服务', 'I understand the service and consent to proceed', '시술 내용을 충분히 이해하였으며 진행에 동의합니다', 'Entiendo el procedimiento y doy mi consentimiento', 'Tôi đã hiểu nội dung dịch vụ và đồng ý thực hiện'),
          required: true,
        },
      ],
    },
  },
  {
    id: 'blank',
    name: '空白自定义模板',
    description: '从一个问题开始，自由增删和设置字段。',
    template: {
      key: 'custom_form',
      title: i18n('自定义表单', 'Custom form', '맞춤형 건강 설문', 'Formulario personalizado', 'Biểu mẫu tùy chỉnh'),
      requiresSignature: true,
      validDays: 365,
      serviceIds: [],
      questions: [
        {
          id: 'question_1',
          type: 'text',
          label: i18n('请填写您的特别要求或健康说明', 'Please list special requests or health notes', '특별 요청사항이나 건강 상태를 적어주세요', 'Indique peticiones especiales o notas de salud', 'Vui lòng ghi yêu cầu đặc biệt hoặc lưu ý sức khỏe'),
          required: false,
        },
      ],
    },
  },
];
