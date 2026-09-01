import type { LanguageCode } from '../types/i18n';

export const uiText: Record<LanguageCode, {
  all: string;
  close: string;
  openNavigation: string;
  closeNavigation: string;
  primaryNavigation: string;
  mobileNavigation: string;
  skipToContent: string;
  humanApproval: string;
  noDirectWrite: string;
  confirmAction: string;
  confirmed: string;
  undo: string;
  previousStep: string;
  nextStep: string;
  role: string;
  operationalImpact: string;
  desktopShortcuts: string;
  plan: string;
  redirecting: string;
  shopPlaceholder: string;
  emailPlaceholder: string;
  ctaBadge: string;
  staffPwaMeta: string;
  kioskMeta: string;
  painPrompt: string;
  selectedAreas: string;
  pressurePrompt: string;
  signedWaiver: string;
  encrypted: string;
  shopRequired: string;
  shopTooLong: string;
  emailRequired: string;
  invalidEmail: string;
  checkoutUnavailable: string;
  trialSecurity: (days: number) => string;
}> = {
  en: {
    all: 'All', close: 'Close', openNavigation: 'Open navigation', closeNavigation: 'Close navigation', primaryNavigation: 'Primary navigation', mobileNavigation: 'Mobile navigation', skipToContent: 'Skip to main content', humanApproval: 'Human approval required', noDirectWrite: 'No direct system changes', confirmAction: 'Confirm action', confirmed: 'Confirmed', undo: 'Undo', previousStep: 'Previous step', nextStep: 'Next step', role: 'Role', operationalImpact: 'Operational impact', desktopShortcuts: 'Desktop-first workflow', plan: 'Plan', redirecting: 'Connecting securely…', shopPlaceholder: 'Example: Golden Lotus Spa', emailPlaceholder: 'you@yourshop.com', ctaBadge: 'Purpose-built for U.S. beauty and wellness operators', staffPwaMeta: 'Browser-based • No app-store installation', kioskMeta: 'Walk-in intake • Preferences • Digital consent', painPrompt: 'Select areas of discomfort or focus', selectedAreas: 'areas selected', pressurePrompt: 'Preferred pressure level', signedWaiver: 'Digital consent signed', encrypted: 'Encrypted at rest', shopRequired: 'Shop name is required.', shopTooLong: 'Shop name must be 80 characters or fewer.', emailRequired: 'Owner email is required.', invalidEmail: 'Enter a valid owner email.', checkoutUnavailable: 'Secure checkout is temporarily unavailable. Please try again.', trialSecurity: (days) => `${days}-day trial. Payment details are collected securely by Stripe; GenieFront never receives your card number.`,
  },
  'zh-CN': {
    all: '全部', close: '关闭', openNavigation: '打开导航', closeNavigation: '关闭导航', primaryNavigation: '主导航', mobileNavigation: '移动端导航', skipToContent: '跳至主要内容', humanApproval: '需前台人工确认', noDirectWrite: '不会直接更改系统', confirmAction: '确认执行', confirmed: '已确认', undo: '撤销', previousStep: '上一步', nextStep: '下一步', role: '负责角色', operationalImpact: '运营价值', desktopShortcuts: '桌面端优先流程', plan: '方案', redirecting: '正在安全连接…', shopPlaceholder: '例如：Golden Lotus Spa', emailPlaceholder: 'you@yourshop.com', ctaBadge: '为美国美业与健康服务门店量身打造', staffPwaMeta: '浏览器即开即用 • 无需应用商店下载', kioskMeta: '散客登记 • 偏好采集 • 数字同意书', painPrompt: '请选择不适或重点护理部位', selectedAreas: '个部位已选择', pressurePrompt: '偏好的力度', signedWaiver: '数字同意书已签署', encrypted: '静态加密存储', shopRequired: '请输入门店名称。', shopTooLong: '门店名称不能超过 80 个字符。', emailRequired: '请输入店主邮箱。', invalidEmail: '请输入有效的店主邮箱。', checkoutUnavailable: '安全结账服务暂时不可用，请稍后重试。', trialSecurity: (days) => `${days} 天免费试用。支付信息由 Stripe 安全收集；GenieFront 不会接收您的银行卡号。`,
  },
  ko: {
    all: '전체', close: '닫기', openNavigation: '탐색 열기', closeNavigation: '탐색 닫기', primaryNavigation: '주요 탐색', mobileNavigation: '모바일 탐색', skipToContent: '본문으로 건너뛰기', humanApproval: '프런트 데스크 승인 필요', noDirectWrite: '시스템을 직접 변경하지 않음', confirmAction: '작업 확인', confirmed: '확인됨', undo: '실행 취소', previousStep: '이전 단계', nextStep: '다음 단계', role: '담당 역할', operationalImpact: '운영 효과', desktopShortcuts: '데스크톱 중심 워크플로', plan: '요금제', redirecting: '보안 연결 중…', shopPlaceholder: '예: Golden Lotus Spa', emailPlaceholder: 'you@yourshop.com', ctaBadge: '미국 뷰티·웰니스 매장을 위해 설계', staffPwaMeta: '브라우저 기반 • 앱 설치 불필요', kioskMeta: '워크인 접수 • 선호도 • 전자 동의', painPrompt: '불편하거나 집중 관리할 부위를 선택하세요', selectedAreas: '개 부위 선택됨', pressurePrompt: '선호 압력', signedWaiver: '전자 동의서 서명 완료', encrypted: '저장 시 암호화', shopRequired: '매장 이름을 입력하세요.', shopTooLong: '매장 이름은 80자 이하여야 합니다.', emailRequired: '소유자 이메일을 입력하세요.', invalidEmail: '유효한 소유자 이메일을 입력하세요.', checkoutUnavailable: '보안 결제를 일시적으로 사용할 수 없습니다. 다시 시도해 주세요.', trialSecurity: (days) => `${days}일 무료 체험입니다. 결제 정보는 Stripe에서 안전하게 수집하며 GenieFront는 카드 번호를 받지 않습니다.`,
  },
  vi: {
    all: 'Tất cả', close: 'Đóng', openNavigation: 'Mở điều hướng', closeNavigation: 'Đóng điều hướng', primaryNavigation: 'Điều hướng chính', mobileNavigation: 'Điều hướng di động', skipToContent: 'Chuyển đến nội dung chính', humanApproval: 'Cần lễ tân xác nhận', noDirectWrite: 'Không tự ý thay đổi hệ thống', confirmAction: 'Xác nhận thao tác', confirmed: 'Đã xác nhận', undo: 'Hoàn tác', previousStep: 'Bước trước', nextStep: 'Bước tiếp theo', role: 'Vai trò', operationalImpact: 'Hiệu quả vận hành', desktopShortcuts: 'Quy trình ưu tiên máy tính', plan: 'Gói dịch vụ', redirecting: 'Đang kết nối bảo mật…', shopPlaceholder: 'Ví dụ: Golden Lotus Spa', emailPlaceholder: 'you@yourshop.com', ctaBadge: 'Thiết kế riêng cho cơ sở làm đẹp và wellness tại Mỹ', staffPwaMeta: 'Chạy trên trình duyệt • Không cần cài ứng dụng', kioskMeta: 'Tiếp nhận khách lẻ • Sở thích • Đồng ý điện tử', painPrompt: 'Chọn vùng khó chịu hoặc cần tập trung', selectedAreas: 'vùng đã chọn', pressurePrompt: 'Mức lực mong muốn', signedWaiver: 'Đã ký đồng ý điện tử', encrypted: 'Mã hóa khi lưu trữ', shopRequired: 'Nhập tên cơ sở.', shopTooLong: 'Tên cơ sở không được vượt quá 80 ký tự.', emailRequired: 'Nhập email của chủ cơ sở.', invalidEmail: 'Nhập email chủ cơ sở hợp lệ.', checkoutUnavailable: 'Thanh toán bảo mật tạm thời không khả dụng. Vui lòng thử lại.', trialSecurity: (days) => `Dùng thử miễn phí ${days} ngày. Stripe thu thập thông tin thanh toán an toàn; GenieFront không nhận số thẻ của bạn.`,
  },
  es: {
    all: 'Todo', close: 'Cerrar', openNavigation: 'Abrir navegación', closeNavigation: 'Cerrar navegación', primaryNavigation: 'Navegación principal', mobileNavigation: 'Navegación móvil', skipToContent: 'Saltar al contenido principal', humanApproval: 'Requiere aprobación de recepción', noDirectWrite: 'Sin cambios directos al sistema', confirmAction: 'Confirmar acción', confirmed: 'Confirmado', undo: 'Deshacer', previousStep: 'Paso anterior', nextStep: 'Paso siguiente', role: 'Responsable', operationalImpact: 'Impacto operativo', desktopShortcuts: 'Flujo optimizado para escritorio', plan: 'Plan', redirecting: 'Conectando de forma segura…', shopPlaceholder: 'Ejemplo: Golden Lotus Spa', emailPlaceholder: 'you@yourshop.com', ctaBadge: 'Diseñado para negocios de belleza y bienestar en EE. UU.', staffPwaMeta: 'Funciona en navegador • Sin instalar aplicaciones', kioskMeta: 'Registro sin cita • Preferencias • Consentimiento digital', painPrompt: 'Selecciona zonas de molestia o enfoque', selectedAreas: 'zonas seleccionadas', pressurePrompt: 'Nivel de presión preferido', signedWaiver: 'Consentimiento digital firmado', encrypted: 'Cifrado en reposo', shopRequired: 'Introduce el nombre del negocio.', shopTooLong: 'El nombre debe tener 80 caracteres o menos.', emailRequired: 'Introduce el correo del propietario.', invalidEmail: 'Introduce un correo válido del propietario.', checkoutUnavailable: 'El pago seguro no está disponible temporalmente. Inténtalo de nuevo.', trialSecurity: (days) => `${days} días de prueba. Stripe recopila los datos de pago de forma segura; GenieFront nunca recibe el número de tu tarjeta.`,
  },
};
