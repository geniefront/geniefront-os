/**
 * 入座服务单一页纸的文案。
 *
 * 独立成域的理由：这张纸会按打印语言整页重新生成，与前台界面语言无关 ——
 * 客人的技师说越南语，前台界面是中文，纸要按技师的语言印。
 * key 一律以 `print.` 为前缀。
 */
import type { DomainDict } from './types';

export const print = {
  'print.briefTitle': { 'zh-Hans': '入座服务单', en: 'Service brief', ko: '서비스 시트', es: 'Hoja de servicio', vi: 'Phiếu dịch vụ' },
  'print.briefLoading': { 'zh-Hans': '正在生成服务单…', en: 'Building the service brief…', ko: '서비스 시트를 만드는 중…', es: 'Generando la hoja de servicio…', vi: 'Đang tạo phiếu dịch vụ…' },
  'print.briefFailed': { 'zh-Hans': '服务单打不开', en: 'Could not open the service brief', ko: '서비스 시트를 열지 못했습니다', es: 'No se pudo abrir la hoja de servicio', vi: 'Không mở được phiếu dịch vụ' },
  'print.printAction': { 'zh-Hans': '打印', en: 'Print', ko: '인쇄', es: 'Imprimir', vi: 'In' },
  'print.langLabel': { 'zh-Hans': '打印语言', en: 'Print language', ko: '인쇄 언어', es: 'Idioma de impresión', vi: 'Ngôn ngữ in' },
  'print.formatLabel': { 'zh-Hans': '版式', en: 'Format', ko: '용지', es: 'Formato', vi: 'Khổ giấy' },
  'print.formatA4': { 'zh-Hans': 'A4', en: 'A4', ko: 'A4', es: 'A4', vi: 'A4' },
  'print.formatThermal': { 'zh-Hans': '80mm 热敏', en: '80mm receipt', ko: '80mm 영수증', es: 'Recibo 80 mm', vi: 'Hóa đơn 80mm' },

  'print.visitNth': { 'zh-Hans': '第 {p0} 次到店', en: 'Visit {p0}', ko: '{p0}번째 방문', es: 'Visita {p0}', vi: 'Lần thứ {p0}' },
  'print.firstVisit': { 'zh-Hans': '首次到店', en: 'First visit', ko: '첫 방문', es: 'Primera visita', vi: 'Lần đầu đến' },
  'print.quiet': { 'zh-Hans': '不多聊', en: 'Prefers quiet', ko: '대화 적게', es: 'Prefiere silencio', vi: 'Ít trò chuyện' },

  'print.sectionItems': { 'zh-Hans': '今日服务', en: "Today's services", ko: '오늘의 시술', es: 'Servicios de hoy', vi: 'Dịch vụ hôm nay' },
  'print.colService': { 'zh-Hans': '项目', en: 'Service', ko: '시술', es: 'Servicio', vi: 'Dịch vụ' },
  'print.colStaff': { 'zh-Hans': '技师', en: 'Therapist', ko: '관리사', es: 'Terapeuta', vi: 'Kỹ thuật viên' },
  'print.colRoom': { 'zh-Hans': '工位', en: 'Station', ko: '스테이션', es: 'Puesto', vi: 'Vị trí' },
  'print.colTime': { 'zh-Hans': '起止', en: 'Time', ko: '시간', es: 'Horario', vi: 'Giờ' },
  'print.colAmount': { 'zh-Hans': '金额', en: 'Amount', ko: '금액', es: 'Importe', vi: 'Số tiền' },
  'print.itemCount': { 'zh-Hans': '合计 {p0} 项', en: '{p0} services', ko: '총 {p0}건', es: '{p0} servicios', vi: '{p0} dịch vụ' },
  'print.notStarted': { 'zh-Hans': '未开始', en: 'Not started', ko: '시작 전', es: 'Sin iniciar', vi: 'Chưa bắt đầu' },
  'print.roomUnassigned': { 'zh-Hans': '未指定', en: 'Unassigned', ko: '미지정', es: 'Sin asignar', vi: 'Chưa xếp' },
  'print.staffUnassigned': { 'zh-Hans': '待分配', en: 'Unassigned', ko: '미배정', es: 'Sin asignar', vi: 'Chưa phân công' },

  'print.sectionPrefs': { 'zh-Hans': '服务偏好', en: 'Preferences', ko: '선호 사항', es: 'Preferencias', vi: 'Sở thích' },
  'print.prefStrength': { 'zh-Hans': '力度', en: 'Pressure', ko: '압력', es: 'Presión', vi: 'Lực tay' },
  'print.prefOil': { 'zh-Hans': '精油', en: 'Oil', ko: '오일', es: 'Aceite', vi: 'Tinh dầu' },
  'print.prefFocus': { 'zh-Hans': '重点部位', en: 'Focus areas', ko: '집중 부위', es: 'Zonas de énfasis', vi: 'Vùng tập trung' },
  'print.prefAllergy': { 'zh-Hans': '过敏', en: 'Allergies', ko: '알레르기', es: 'Alergias', vi: 'Dị ứng' },
  'print.prefNotes': { 'zh-Hans': '客户备注', en: 'Customer notes', ko: '고객 메모', es: 'Notas del cliente', vi: 'Ghi chú khách' },
  'print.prefNone': { 'zh-Hans': '无特别要求', en: 'No preference given', ko: '특별 요청 없음', es: 'Sin preferencias', vi: 'Không yêu cầu đặc biệt' },

  'print.sectionAvoid': { 'zh-Hans': '避开部位', en: 'Areas to avoid', ko: '피할 부위', es: 'Zonas a evitar', vi: 'Vùng cần tránh' },
  'print.avoidNone': { 'zh-Hans': '无需避开部位', en: 'No areas to avoid', ko: '피할 부위 없음', es: 'Ninguna zona que evitar', vi: 'Không có vùng cần tránh' },
  'print.sectionHealth': { 'zh-Hans': '健康提示', en: 'Health notes', ko: '건강 참고', es: 'Notas de salud', vi: 'Lưu ý sức khỏe' },
  'print.healthFlagged': { 'zh-Hans': '有禁忌，动手前先看下面几条', en: 'Contraindications on file — read the notes below before starting', ko: '금기 사항이 있습니다. 시작 전 아래 내용을 확인해 주세요', es: 'Hay contraindicaciones: lee las notas antes de empezar', vi: 'Có chống chỉ định — đọc các lưu ý bên dưới trước khi làm' },
  'print.healthClear': { 'zh-Hans': '问卷未标记禁忌', en: 'No contraindications flagged on the form', ko: '문진에서 금기 사항이 표시되지 않았습니다', es: 'El cuestionario no marca contraindicaciones', vi: 'Bảng hỏi không đánh dấu chống chỉ định' },
  'print.healthNoForm': { 'zh-Hans': '这位客人没有有效问卷。动手前请到前台确认。', en: 'This guest has no valid health form. Check with the front desk before starting.', ko: '이 고객은 유효한 문진표가 없습니다. 시작 전 프런트에 확인해 주세요.', es: 'Este cliente no tiene un cuestionario de salud válido. Consulta en recepción antes de empezar.', vi: 'Khách này chưa có bảng hỏi sức khỏe hợp lệ. Hãy hỏi lễ tân trước khi làm.' },
  'print.healthNoPermission': { 'zh-Hans': '你的账号看不到问卷内容，此处只印结论。需要细节请找店长。', en: 'Your account cannot view form content, so only the summary is printed. Ask a manager for details.', ko: '이 계정은 문진 내용을 볼 수 없어 요약만 인쇄됩니다. 자세한 내용은 점장에게 문의해 주세요.', es: 'Tu cuenta no puede ver el cuestionario, así que solo se imprime el resumen. Pide los detalles a un encargado.', vi: 'Tài khoản của bạn không xem được nội dung bảng hỏi nên chỉ in phần tóm tắt. Cần chi tiết hãy hỏi quản lý.' },
  'print.sectionForm': { 'zh-Hans': '健康问卷内容', en: 'Health form answers', ko: '문진 응답', es: 'Respuestas del cuestionario', vi: 'Nội dung bảng hỏi' },
  'print.formSignedBy': { 'zh-Hans': '{p0} 于 {p1} 签署', en: 'Signed by {p0} on {p1}', ko: '{p0} 님이 {p1}에 서명', es: 'Firmado por {p0} el {p1}', vi: '{p0} đã ký ngày {p1}' },
  'print.answerYes': { 'zh-Hans': '是', en: 'Yes', ko: '예', es: 'Sí', vi: 'Có' },
  'print.answerNo': { 'zh-Hans': '否', en: 'No', ko: '아니오', es: 'No', vi: 'Không' },

  'print.sectionHandoff': { 'zh-Hans': '前台交接', en: 'From the front desk', ko: '프런트 인계', es: 'Nota de recepción', vi: 'Bàn giao từ lễ tân' },
  'print.confidential': { 'zh-Hans': '本页含健康问卷内容，仅供本次服务的技师使用。服务结束后请交回前台销毁，不要留在工位上。每次打印都会记录打印人与时间。', en: 'This sheet contains health form content and is for the therapist on this service only. Return it to the front desk to be destroyed after the service; do not leave it at the station. Every print is logged with who printed it and when.', ko: '이 시트에는 문진 내용이 포함되어 있으며 해당 시술 관리사만 사용합니다. 시술 후 프런트에 반납해 폐기하고 스테이션에 두지 마세요. 인쇄할 때마다 인쇄자와 시각이 기록됩니다.', es: 'Esta hoja contiene el cuestionario de salud y es solo para el terapeuta de este servicio. Devuélvela a recepción para destruirla al terminar; no la dejes en el puesto. Cada impresión queda registrada con quién y cuándo.', vi: 'Phiếu này chứa nội dung bảng hỏi sức khỏe, chỉ dành cho kỹ thuật viên của ca này. Xong việc hãy trả lại lễ tân để hủy, đừng để lại tại vị trí. Mỗi lần in đều ghi lại người in và thời gian.' },

  /*
   * 由服务端按解密后的问卷答案推导出的技师可执行建议。
   * 服务端只给编码，成句文案在这里 —— 五种语言才能齐备。
   */
  'print.advicePregnancy': { 'zh-Hans': '孕期：禁止按压腹部、腰骶与合谷、三阴交等穴位；避免俯卧。', en: 'Pregnant: no pressure on the abdomen, lower back or sacrum, and avoid the LI4 / SP6 points. Do not position face-down.', ko: '임신 중: 복부·요천추 압박 금지, 합곡·삼음교 자극 금지, 엎드린 자세 금지.', es: 'Embarazo: sin presión en abdomen, zona lumbar ni sacro; evita los puntos LI4 y SP6. No la coloques boca abajo.', vi: 'Đang mang thai: không ấn bụng, thắt lưng và xương cùng; tránh huyệt hợp cốc, tam âm giao. Không nằm sấp.' },
  'print.adviceBloodClots': { 'zh-Hans': '有血栓病史：小腿与大腿禁止重手法与深压，不做被动拉伸。', en: 'History of blood clots: no deep or heavy work on the calves and thighs, and no passive stretching.', ko: '혈전 병력: 종아리·허벅지 강한 압박과 깊은 마사지 금지, 수동 스트레칭 금지.', es: 'Antecedentes de trombosis: nada de presión profunda ni maniobras fuertes en pantorrillas y muslos; sin estiramientos pasivos.', vi: 'Có tiền sử huyết khối: không ấn sâu hay mạnh vùng bắp chân và đùi, không kéo giãn thụ động.' },
  'print.advicePacemaker': { 'zh-Hans': '装有起搏器：胸前与左肩区域不得使用任何电子仪器或强震动。', en: 'Has a pacemaker: no electrical devices or strong vibration over the chest or left shoulder.', ko: '심박 조율기 착용: 가슴과 왼쪽 어깨 부위에 전기 기기·강한 진동 사용 금지.', es: 'Lleva marcapasos: no uses aparatos eléctricos ni vibración fuerte en el pecho ni el hombro izquierdo.', vi: 'Có máy tạo nhịp tim: không dùng thiết bị điện hay rung mạnh ở ngực và vai trái.' },
  'print.adviceHeartCondition': { 'zh-Hans': '有心脏病史：力度放轻，避免长时间俯卧，随时留意客人脸色与呼吸。', en: 'Heart condition: keep pressure light, avoid long face-down periods, and watch their colour and breathing.', ko: '심장 질환: 압력을 약하게, 장시간 엎드린 자세 피하고 안색과 호흡을 계속 확인.', es: 'Cardiopatía: presión suave, evita periodos largos boca abajo y vigila su color y respiración.', vi: 'Bệnh tim: giữ lực nhẹ, tránh nằm sấp lâu, luôn để ý sắc mặt và nhịp thở của khách.' },
  'print.adviceBloodPressure': { 'zh-Hans': '血压异常：结束时慢慢起身，避免突然改变体位。', en: 'Blood pressure issues: have them sit up slowly at the end and avoid sudden position changes.', ko: '혈압 이상: 마무리 시 천천히 일어나게 하고 급격한 자세 변경 금지.', es: 'Tensión alterada: que se incorpore despacio al final y evita cambios bruscos de postura.', vi: 'Huyết áp bất thường: cuối buổi cho khách ngồi dậy từ từ, tránh đổi tư thế đột ngột.' },
  'print.adviceDiabetes': { 'zh-Hans': '糖尿病：足部与小腿力度放轻，留意皮肤破损，水温不要过高。', en: 'Diabetes: use light pressure on feet and lower legs, check for broken skin, and keep water temperature moderate.', ko: '당뇨: 발과 종아리는 약하게, 피부 상처 확인, 물 온도는 너무 뜨겁지 않게.', es: 'Diabetes: presión suave en pies y piernas, revisa si hay heridas y no uses agua muy caliente.', vi: 'Tiểu đường: nhẹ tay ở bàn chân và cẳng chân, kiểm tra da có trầy xước, nước không quá nóng.' },
  'print.adviceOncology': { 'zh-Hans': '肿瘤治疗史：全程轻手法，不做深层按压与淋巴引流，避开手术与放疗部位。', en: 'Cancer treatment history: light work throughout, no deep pressure or lymphatic drainage, and stay clear of surgical or radiation sites.', ko: '암 치료 이력: 전 과정 가볍게, 깊은 압박·림프 배액 금지, 수술 및 방사선 부위 회피.', es: 'Historial oncológico: trabajo suave en todo momento, sin presión profunda ni drenaje linfático, y evita zonas de cirugía o radioterapia.', vi: 'Tiền sử điều trị ung thư: làm nhẹ toàn bộ, không ấn sâu hay dẫn lưu bạch huyết, tránh vùng phẫu thuật và xạ trị.' },
  'print.adviceSpineNeck': { 'zh-Hans': '脊柱或颈椎损伤史：颈部不做旋转与扳法，脊柱中线不施压。', en: 'Spine or neck injury: no neck rotation or thrust techniques, and no pressure on the spinal midline.', ko: '척추·경추 손상 이력: 목 회전 및 교정 기법 금지, 척추 정중선 압박 금지.', es: 'Lesión de columna o cuello: sin rotaciones ni manipulaciones cervicales, y sin presión en la línea media de la columna.', vi: 'Từng chấn thương cột sống hoặc cổ: không xoay hay nắn cổ, không ấn đường giữa cột sống.' },
  'print.adviceArthritis': { 'zh-Hans': '关节炎：关节处不做被动屈伸，遇到肿胀或发热的关节直接跳过。', en: 'Arthritis: no passive joint flexion or extension; skip any joint that is swollen or warm.', ko: '관절염: 관절 수동 굴신 금지, 부어 있거나 열감 있는 관절은 건너뛰기.', es: 'Artritis: sin flexión ni extensión pasiva de articulaciones; omite las que estén hinchadas o calientes.', vi: 'Viêm khớp: không gập duỗi khớp thụ động, bỏ qua khớp đang sưng hoặc nóng.' },
  'print.adviceFibromyalgia': { 'zh-Hans': '纤维肌痛：从最轻力度开始，每换一个部位都问一次感受。', en: 'Fibromyalgia: start at the lightest pressure and check in each time you move to a new area.', ko: '섬유근육통: 가장 약한 압력부터 시작하고 부위를 옮길 때마다 상태를 확인.', es: 'Fibromialgia: empieza con la presión más suave y pregunta cada vez que cambies de zona.', vi: 'Đau xơ cơ: bắt đầu với lực nhẹ nhất, mỗi khi đổi vùng đều hỏi lại cảm giác của khách.' },
} satisfies DomainDict;
