import type { SaveFormTemplateInput } from './api';

const text = (en: string, zh: string) => ({ en, 'zh-Hans': zh });

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
      key: 'massage_intake', title: text('Massage health intake', '按摩 / 足疗健康表'),
      requiresSignature: true, validDays: 365, serviceIds: [],
      questions: [
        { id: 'health_conditions', type: 'bool', label: text('Do you have a health condition we should know about?', '是否有需要我们注意的健康状况？'), required: true, sync: 'health_flag' },
        { id: 'allergies', type: 'text', label: text('Please list allergies or sensitivities', '请填写过敏或敏感情况'), required: false },
        { id: 'avoid_areas', type: 'multi', label: text('Areas to avoid', '需要避开的部位'), required: false, sync: 'avoid_areas', options: [
          { value: 'head', label: text('Head', '头部') }, { value: 'neck', label: text('Neck', '颈部') },
          { value: 'back', label: text('Back', '背部') }, { value: 'legs', label: text('Legs', '腿部') },
          { value: 'feet', label: text('Feet', '足部') },
        ] },
        { id: 'pressure', type: 'choice', label: text('Preferred pressure', '偏好的按摩力度'), required: true, options: [
          { value: 'light', label: text('Light', '轻柔') }, { value: 'medium', label: text('Medium', '适中') }, { value: 'firm', label: text('Firm', '较重') },
        ] },
      ],
    },
  },
  {
    id: 'facial', name: '美容 / 面部护理表', description: '皮肤敏感、药物与近期美容项目。',
    template: {
      key: 'facial_intake', title: text('Facial treatment intake', '美容 / 面部护理表'), requiresSignature: true, validDays: 180, serviceIds: [],
      questions: [
        { id: 'skin_allergy', type: 'bool', label: text('Do you have skin allergies or sensitivities?', '是否有皮肤过敏或敏感？'), required: true, sync: 'health_flag' },
        { id: 'medications', type: 'text', label: text('List relevant medications or topical products', '请填写相关药物或外用产品'), required: false },
        { id: 'recent_treatment', type: 'text', label: text('Recent peels, laser, injections or surgery', '近期是否做过刷酸、激光、注射或手术？'), required: false },
      ],
    },
  },
  {
    id: 'nail', name: '美甲 / 美睫服务同意书', description: '过敏、感染风险与服务同意。',
    template: {
      key: 'nail_consent', title: text('Nail and lash service consent', '美甲 / 美睫服务同意书'), requiresSignature: true, validDays: 365, serviceIds: [],
      questions: [
        { id: 'allergy', type: 'bool', label: text('Any known allergy to adhesives, gel or acrylic products?', '是否对胶水、甲油胶或水晶粉过敏？'), required: true, sync: 'health_flag' },
        { id: 'infection', type: 'bool', label: text('Any current infection, open wound or irritation?', '目前是否有感染、伤口或刺激症状？'), required: true, sync: 'health_flag' },
        { id: 'consent', type: 'bool', label: text('I understand the service and consent to proceed', '我已了解服务内容并同意进行服务'), required: true },
      ],
    },
  },
  {
    id: 'blank', name: '空白自定义模板', description: '从一个问题开始，自由增删和设置字段。',
    template: {
      key: 'custom_form', title: text('Custom form', '自定义表单'), requiresSignature: true, validDays: 365, serviceIds: [],
      questions: [{ id: 'question_1', type: 'text', label: text('Question', '问题'), required: false }],
    },
  },
];
