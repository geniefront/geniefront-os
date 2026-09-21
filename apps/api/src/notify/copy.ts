import { ownerLocaleOf, type OwnerLocale } from '../email/locale';

// System copy only. Customer names, notes and verbatim transcripts remain user data.
const en = {
  servicesChanged:'Services changed', created: 'New appointment', changed: 'Appointment updated', cancelled: 'Appointment canceled', reminder: 'Appointment reminder',
  assigned: 'Appointment assigned', pending: 'Appointment awaiting confirmation',
  updatedBy: 'Updated by', team: 'Shop team', customer: 'Customer', guests: 'Guests', guest: 'Guest',
  previous: 'Previous time', current: 'New time', notes: 'Notes', open: 'Open appointment', requested: 'Requested',
  service: 'Service', addon: 'Add-on', specialist: 'Specialist', total: 'Total', timezone: 'Timezone', address: 'Address',
  cutoff: 'Cancel at least {hours} hours before the appointment.',
  guest_changed_mind: 'Cancelled at the customer’s request.', duplicate_booking: 'A duplicate booking was cancelled.',
  input_error: 'The booking details needed correction.', no_show: 'The appointment was marked as a no-show.',
  walk_out: 'The guest left before service.', other: 'The shop cancelled this appointment. Please contact the shop for details.',
  footer: 'Sent by GenieFront for your salon.', billingFooter: 'GenieFront billing notice.', stop: 'Reply STOP to opt out.',
  call: 'Call record', callDone: 'Call completed. Sign in to view the call record.', caller: 'Caller', unknown: 'Unknown number',
  callTime: 'Call time', duration: 'Duration', minutes: 'min', seconds: 'sec', receptionist: 'AI receptionist', speaker: 'Speaker',
  transcript: 'Transcript', summary: 'Call summary', emptySummary: 'No summary available', emptyCall: 'No meaningful voice exchange',
  callOpen: 'View conversation and recording', login: 'Sign in with your shop account to view.', preview: 'Conversation preview',
  fullCall: 'See call details for the full conversation.', shop: 'your shop',
};
type Copy = { [K in keyof typeof en]: string };
const copies: Record<OwnerLocale, Copy> = {
  en,
  'zh-Hans': {
    servicesChanged:'项目变更',created:'新预约',changed:'预约变更',cancelled:'预约取消',reminder:'预约提醒',assigned:'新分配预约',pending:'预约待确认',
    updatedBy:'更新方',team:'门店员工',customer:'客户',guests:'人数',guest:'客人',previous:'原',current:'现',notes:'备注',open:'查看预约',requested:'指定',
    service:'项目',addon:'附加项目',specialist:'技师',total:'合计',timezone:'时区',address:'地址',cutoff:'请至少提前{hours}小时取消预约。',
    guest_changed_mind:'应客户要求取消预约。',duplicate_booking:'重复预约已取消。',input_error:'预约信息需要更正。',no_show:'该预约已标记为未到店。',walk_out:'客人在服务前离店。',other:'门店已取消此预约，详情请联系门店。',
    footer:'由 GenieFront 代门店发送。',billingFooter:'GenieFront 账单通知。',stop:'回复STOP退订。',
    call:'来电记录',callDone:'来电已结束，请登录查看通话记录。',caller:'来电号码',unknown:'未知号码',callTime:'来电时间',duration:'通话时长',minutes:'分',seconds:'秒',receptionist:'AI 接待',speaker:'说话人',transcript:'转录',summary:'通话摘要',emptySummary:'暂无摘要',emptyCall:'无有效语音交流',callOpen:'查看对话与录音',login:'需登录门店账号查看。',preview:'对话预览',fullCall:'完整对话见通话详情。',shop:'你的门店',
  },
  'zh-Hant': {
    servicesChanged:'項目變更',created:'新預約',changed:'預約變更',cancelled:'預約取消',reminder:'預約提醒',assigned:'新分配預約',pending:'預約待確認',
    updatedBy:'更新方',team:'門店員工',customer:'客戶',guests:'人數',guest:'客人',previous:'原',current:'現',notes:'備註',open:'查看預約',requested:'指定',
    service:'項目',addon:'附加項目',specialist:'技師',total:'合計',timezone:'時區',address:'地址',cutoff:'請至少提前{hours}小時取消預約。',
    guest_changed_mind:'應客戶要求取消預約。',duplicate_booking:'重複預約已取消。',input_error:'預約資訊需要更正。',no_show:'該預約已標記為未到店。',walk_out:'客人在服務前離店。',other:'門店已取消此預約，詳情請聯絡門店。',
    footer:'由 GenieFront 代門店發送。',billingFooter:'GenieFront 帳單通知。',stop:'回覆STOP退訂。',
    call:'來電記錄',callDone:'來電已結束，請登入查看通話記錄。',caller:'來電號碼',unknown:'未知號碼',callTime:'來電時間',duration:'通話時長',minutes:'分',seconds:'秒',receptionist:'AI 接待',speaker:'說話人',transcript:'轉錄',summary:'通話摘要',emptySummary:'暫無摘要',emptyCall:'無有效語音交流',callOpen:'查看對話與錄音',login:'需登入門店帳號查看。',preview:'對話預覽',fullCall:'完整對話見通話詳情。',shop:'你的門店',
  },
  ko: {
    servicesChanged:'서비스 변경',created:'새 예약',changed:'예약 변경',cancelled:'예약 취소',reminder:'예약 알림',assigned:'배정된 예약',pending:'확인 대기 예약',
    updatedBy:'변경자',team:'매장 직원',customer:'고객',guests:'인원',guest:'고객',previous:'기존',current:'변경',notes:'메모',open:'예약 보기',requested:'지정',
    service:'서비스',addon:'추가 서비스',specialist:'담당자',total:'합계',timezone:'시간대',address:'주소',cutoff:'예약 {hours}시간 전까지 취소해 주세요.',
    guest_changed_mind:'고객 요청으로 취소되었습니다.',duplicate_booking:'중복 예약이 취소되었습니다.',input_error:'예약 정보 수정이 필요합니다.',no_show:'미방문으로 표시되었습니다.',walk_out:'고객이 서비스 전에 떠났습니다.',other:'매장에서 예약을 취소했습니다. 자세한 내용은 매장에 문의하세요.',
    footer:'GenieFront가 매장을 대신하여 보냈습니다.',billingFooter:'GenieFront 결제 알림.',stop:'수신 거부: STOP 회신.',
    call:'통화 기록',callDone:'통화가 종료되었습니다. 로그인하여 기록을 확인하세요.',caller:'발신 번호',unknown:'알 수 없는 번호',callTime:'통화 시간',duration:'통화 길이',minutes:'분',seconds:'초',receptionist:'AI 접수원',speaker:'화자',transcript:'녹취록',summary:'통화 요약',emptySummary:'요약 없음',emptyCall:'유효한 음성 대화 없음',callOpen:'대화 및 녹음 보기',login:'매장 계정으로 로그인하여 확인하세요.',preview:'대화 미리보기',fullCall:'전체 대화는 통화 상세에서 확인하세요.',shop:'매장',
  },
  vi: {
    servicesChanged:'Đổi dịch vụ',created:'Lịch hẹn mới',changed:'Đổi lịch hẹn',cancelled:'Hủy lịch hẹn',reminder:'Nhắc lịch hẹn',assigned:'Lịch hẹn được giao',pending:'Lịch hẹn chờ xác nhận',
    updatedBy:'Người cập nhật',team:'Nhân viên tiệm',customer:'Khách hàng',guests:'Số khách',guest:'Khách',previous:'Cũ',current:'Mới',notes:'Ghi chú',open:'Xem lịch hẹn',requested:'Chỉ định',
    service:'Dịch vụ',addon:'Dịch vụ bổ sung',specialist:'Nhân viên',total:'Tổng',timezone:'Múi giờ',address:'Địa chỉ',cutoff:'Vui lòng hủy trước giờ hẹn ít nhất {hours} giờ.',
    guest_changed_mind:'Đã hủy theo yêu cầu của khách.',duplicate_booking:'Đã hủy lịch hẹn trùng.',input_error:'Thông tin lịch hẹn cần được sửa.',no_show:'Khách được đánh dấu là không đến.',walk_out:'Khách đã rời đi trước khi sử dụng dịch vụ.',other:'Tiệm đã hủy lịch hẹn. Vui lòng liên hệ tiệm để biết chi tiết.',
    footer:'GenieFront gửi thay mặt tiệm.',billingFooter:'Thông báo thanh toán GenieFront.',stop:'Trả lời STOP để ngừng nhận.',
    call:'Lịch sử cuộc gọi',callDone:'Cuộc gọi đã kết thúc. Đăng nhập để xem chi tiết.',caller:'Số gọi đến',unknown:'Số không xác định',callTime:'Thời gian gọi',duration:'Thời lượng',minutes:'phút',seconds:'giây',receptionist:'Lễ tân AI',speaker:'Người nói',transcript:'Bản chép lời',summary:'Tóm tắt cuộc gọi',emptySummary:'Chưa có tóm tắt',emptyCall:'Không có trao đổi thoại có ý nghĩa',callOpen:'Xem hội thoại và bản ghi âm',login:'Đăng nhập tài khoản tiệm để xem.',preview:'Xem trước hội thoại',fullCall:'Xem chi tiết cuộc gọi để đọc toàn bộ hội thoại.',shop:'tiệm của bạn',
  },
  es: {
    servicesChanged:'Servicios modificados',created:'Nueva cita',changed:'Cita modificada',cancelled:'Cita cancelada',reminder:'Recordatorio de cita',assigned:'Cita asignada',pending:'Cita por confirmar',
    updatedBy:'Actualizado por',team:'Personal del salón',customer:'Cliente',guests:'Personas',guest:'Cliente',previous:'Antes',current:'Ahora',notes:'Notas',open:'Ver cita',requested:'Solicitado',
    service:'Servicio',addon:'Servicio adicional',specialist:'Especialista',total:'Total',timezone:'Zona horaria',address:'Dirección',cutoff:'Cancele al menos {hours} horas antes de la cita.',
    guest_changed_mind:'Cancelada a petición del cliente.',duplicate_booking:'Se canceló una cita duplicada.',input_error:'Los datos de la cita requerían corrección.',no_show:'Se marcó al cliente como ausente.',walk_out:'El cliente se fue antes del servicio.',other:'El salón canceló esta cita. Contacte con el salón para más información.',
    footer:'Enviado por GenieFront en nombre de su salón.',billingFooter:'Aviso de facturación de GenieFront.',stop:'Responda STOP para darse de baja.',
    call:'Registro de llamada',callDone:'Llamada finalizada. Inicie sesión para ver el registro.',caller:'Número de origen',unknown:'Número desconocido',callTime:'Hora de llamada',duration:'Duración',minutes:'min',seconds:'seg',receptionist:'Recepcionista IA',speaker:'Hablante',transcript:'Transcripción',summary:'Resumen de llamada',emptySummary:'Sin resumen',emptyCall:'Sin conversación de voz significativa',callOpen:'Ver conversación y grabación',login:'Inicie sesión con su cuenta del salón para ver los detalles.',preview:'Vista previa de la conversación',fullCall:'Vea la conversación completa en los detalles de la llamada.',shop:'su salón',
  },
};
export function notificationCopy(locale: unknown): Copy { return copies[ownerLocaleOf(locale)]; }
