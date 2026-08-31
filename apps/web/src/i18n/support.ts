import type { DomainDict } from './types';

export const support = {
  'support.title': { 'zh-Hans': '联系 GenieFront 支持', en: 'Contact GenieFront support', ko: 'GenieFront 지원 문의', es: 'Contactar con soporte de GenieFront', vi: 'Liên hệ hỗ trợ GenieFront' },
  'support.description': { 'zh-Hans': '提交一条支持请求。平台运营会在后台处理，不会改动门店账单或营业数据。', en: 'Submit a support request. Platform operators handle it internally. This does not change billing or store data.', ko: '지원 요청을 제출하세요. 플랫폼 운영자가 내부에서 처리하며 결제나 매장 데이터는 바뀌지 않습니다.', es: 'Envía una solicitud de soporte. El equipo de plataforma la gestiona internamente. No cambia la facturación ni los datos del local.', vi: 'Gửi yêu cầu hỗ trợ. Đội vận hành nền tảng sẽ xử lý nội bộ. Việc này không đổi thanh toán hay dữ liệu cửa hàng.' },
  'support.category': { 'zh-Hans': '分类', en: 'Category', ko: '분류', es: 'Categoría', vi: 'Danh mục' },
  'support.subject': { 'zh-Hans': '主题', en: 'Subject', ko: '제목', es: 'Asunto', vi: 'Tiêu đề' },
  'support.message': { 'zh-Hans': '说明', en: 'Message', ko: '내용', es: 'Mensaje', vi: 'Nội dung' },
  'support.submit': { 'zh-Hans': '提交请求', en: 'Submit request', ko: '요청 제출', es: 'Enviar solicitud', vi: 'Gửi yêu cầu' },
  'support.submitting': { 'zh-Hans': '正在提交…', en: 'Submitting…', ko: '제출 중…', es: 'Enviando…', vi: 'Đang gửi…' },
  'support.success': { 'zh-Hans': '支持请求已提交。', en: 'Support request submitted.', ko: '지원 요청이 제출되었습니다.', es: 'Solicitud de soporte enviada.', vi: 'Đã gửi yêu cầu hỗ trợ.' },
  'support.category.general': { 'zh-Hans': '一般', en: 'General', ko: '일반', es: 'General', vi: 'Chung' },
  'support.category.onboarding': { 'zh-Hans': '开店', en: 'Onboarding', ko: '온보딩', es: 'Alta', vi: 'Onboarding' },
  'support.category.billing': { 'zh-Hans': '账单', en: 'Billing', ko: '결제', es: 'Facturación', vi: 'Thanh toán' },
  'support.category.sms_10dlc': { 'zh-Hans': '短信 / 10DLC', en: 'SMS / 10DLC', ko: 'SMS / 10DLC', es: 'SMS / 10DLC', vi: 'SMS / 10DLC' },
  'support.category.storefront': { 'zh-Hans': '微店', en: 'Storefront', ko: '스토어프론트', es: 'Tienda', vi: 'Storefront' },
  'support.category.technical': { 'zh-Hans': '技术', en: 'Technical', ko: '기술', es: 'Técnico', vi: 'Kỹ thuật' },
  'support.category.other': { 'zh-Hans': '其他', en: 'Other', ko: '기타', es: 'Otro', vi: 'Khác' },
} satisfies DomainDict;
