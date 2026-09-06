import type { Language } from './types';

type Copy = Record<Language, string>;
const row = (zh: string, en: string, ko: string, es: string, vi: string): Copy => ({
  'zh-Hans': zh, en, ko, es, vi,
});

/** 资料页权限清单。键为 `perm.{PERMISSIONS 原值}`。 */
export const permissions = {
  'perm.appointment.read': row('查看预约', 'View appointments', '예약 보기', 'Ver citas', 'Xem lịch hẹn'),
  'perm.appointment.write': row('创建/改预约', 'Create or edit appointments', '예약 생성/수정', 'Crear o editar citas', 'Tạo/sửa lịch hẹn'),
  'perm.appointment.cancel': row('取消预约', 'Cancel appointments', '예약 취소', 'Cancelar citas', 'Hủy lịch hẹn'),
  'perm.appointment.overbook': row('超容量放行', 'Override capacity', '정원 초과 허용', 'Exceder capacidad', 'Vượt sức chứa'),
  'perm.ticket.read': row('查看工单', 'View tickets', '주문 보기', 'Ver tickets', 'Xem phiếu'),
  'perm.ticket.write': row('开单/改单', 'Open or edit tickets', '주문 생성/수정', 'Abrir o editar tickets', 'Mở/sửa phiếu'),
  'perm.ticket.discount': row('改价折扣', 'Apply discounts', '할인 적용', 'Aplicar descuentos', 'Áp giảm giá'),
  'perm.ticket.void': row('作废工单', 'Void tickets', '주문 무효화', 'Anular tickets', 'Hủy phiếu'),
  'perm.ticket.refund': row('退款', 'Refund', '환불', 'Reembolsar', 'Hoàn tiền'),
  'perm.rotation.read': row('查看轮牌', 'View rotation', '로테이션 보기', 'Ver rotación', 'Xem vòng ca'),
  'perm.rotation.override': row('调整轮牌', 'Override rotation', '로테이션 조정', 'Ajustar rotación', 'Điều chỉnh vòng ca'),
  'perm.payroll.view_own': row('查看本人薪酬', 'View own pay', '본인 급여 보기', 'Ver mi nómina', 'Xem lương của mình'),
  'perm.payroll.view_all': row('查看全店薪酬', 'View all pay', '전체 급여 보기', 'Ver toda la nómina', 'Xem lương cả tiệm'),
  'perm.payroll.configure': row('配置薪酬规则', 'Configure payroll', '급여 규칙 설정', 'Configurar nómina', 'Cấu hình lương'),
  'perm.dayclose.manage': row('日结封账', 'Day close', '일마감', 'Cierre del día', 'Chốt ngày'),
  'perm.tip.payout': row('发现金小费', 'Pay out cash tips', '현금 팁 지급', 'Pagar propinas en efectivo', 'Trả tip tiền mặt'),
  'perm.report.view': row('查看经营报表', 'View reports', '경영 리포트 보기', 'Ver informes', 'Xem báo cáo'),
  'perm.customer.read': row('查看客户', 'View customers', '고객 보기', 'Ver clientes', 'Xem khách'),
  'perm.customer.write': row('编辑客户', 'Edit customers', '고객 수정', 'Editar clientes', 'Sửa khách'),
  'perm.customer.view_contact': row('查看完整电话', 'View full phone numbers', '전체 전화번호 보기', 'Ver teléfonos completos', 'Xem số điện thoại đầy đủ'),
  'perm.customer.view_health_form': row('查看健康表内容', 'View health form answers', '문진표 내용 보기', 'Ver el formulario de salud', 'Xem nội dung phiếu sức khỏe'),
  'perm.customer.merge': row('合并客户档案', 'Merge customer profiles', '고객 프로필 병합', 'Fusionar fichas', 'Gộp hồ sơ khách'),
  'perm.schedule.read': row('查看排班', 'View schedule', '스케줄 보기', 'Ver horario', 'Xem ca làm'),
  'perm.schedule.write': row('编辑排班', 'Edit schedule', '스케줄 수정', 'Editar horario', 'Sửa ca làm'),
  'perm.timeclock.punch_self': row('自己打卡', 'Clock in/out for self', '본인 출퇴근', 'Fichar yo', 'Chấm công cho mình'),
  'perm.timeclock.punch_others': row('代他人打卡', 'Clock in/out for others', '타인 출퇴근 대행', 'Fichar por otros', 'Chấm công hộ'),
  'perm.settings.manage': row('管理系统设置', 'Manage settings', '설정 관리', 'Gestionar ajustes', 'Quản lý cài đặt'),
  'perm.staff.manage': row('管理员工', 'Manage staff', '직원 관리', 'Gestionar personal', 'Quản lý nhân viên'),
  'perm.billing.manage': row('管理订阅账单', 'Manage billing', '결제/구독 관리', 'Gestionar facturación', 'Quản lý thanh toán gói'),
  'perm.catalog.manage': row('管理价目服务', 'Manage catalog', '메뉴/서비스 관리', 'Gestionar catálogo', 'Quản lý bảng giá'),
  'perm.marketing.manage': row('管理营销', 'Manage marketing', '마케팅 관리', 'Gestionar marketing', 'Quản lý marketing'),
  'perm.package.manage': row('管理次卡套餐', 'Manage packages', '패키지 관리', 'Gestionar bonos', 'Quản lý gói buổi'),
  'perm.comms.send': row('发送短信/邮件', 'Send SMS or email', '문자/이메일 발송', 'Enviar SMS o email', 'Gửi SMS/email'),
  'perm.ai.use': row('使用 AI 副驾', 'Use AI copilot', 'AI 코파일럿 사용', 'Usar el copiloto IA', 'Dùng AI phụ lái'),
  'perm.ai.execute_without_confirm': row('AI 免确认执行', 'AI may act without confirm', 'AI 확인 없이 실행', 'IA sin confirmación', 'AI thực hiện không cần xác nhận'),
  'perm.call.draft': row('电话意向草案', 'Phone intake drafts', '전화 초안', 'Borradores de llamadas', 'Nháp ý định cuộc gọi'),
  'perm.queue.join': row('排队取号', 'Join the queue', '대기표 발급', 'Tomar turno', 'Lấy số hàng đợi'),
  'perm.queue.manage': row('叫号与入座', 'Call and seat guests', '호출 및 배정', 'Llamar y sentar', 'Gọi số và xếp chỗ'),
  'perm.form.submit': row('提交健康表', 'Submit health forms', '문진표 제출', 'Enviar formulario de salud', 'Nộp phiếu sức khỏe'),
};
