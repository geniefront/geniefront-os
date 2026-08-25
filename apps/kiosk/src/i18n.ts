/**
 * 门口端的六种语言（宪法第 7 条）。
 *
 * 这一端的多语言和别处不是一个性质：前台端翻译差一点只是别扭，
 * **门口端翻译差一点就等于客人没看懂他签的那份免责书** ——
 * 而「我看不懂英文」是这类纠纷里最常见、也最有效的抗辩。
 *
 * 所以这里没有一句硬编码文案，语言选择固定摆在首屏最显眼的位置，
 * 而且客人选了什么语言会**跟着提交记录一起存下来**（form_submissions.locale）。
 */

export const LOCALES = ['zh-Hans', 'en', 'vi', 'ko', 'es', 'zh-Hant'] as const;
export type Locale = (typeof LOCALES)[number];

/** 用各自的语言写自己 —— 客人找的是他认得的那几个字，不是中文的「越南语」 */
export const LOCALE_LABEL: Record<Locale, string> = {
  'zh-Hans': '简体中文',
  en: 'English',
  vi: 'Tiếng Việt',
  ko: '한국어',
  es: 'Español',
  'zh-Hant': '繁體中文',
};

type Dict = Record<string, string>;

/**
 * ⚠️ `link.*` 是**客人在自己手机上**看到的那几句（`docs/15` §4）。
 * 和门口那台 iPad 同一条标准：六种语言齐 —— 一个看不懂这句话的人
 * 会以为链接坏了，然后到店还是得在柜台前重填一遍。
 */

const zhHans: Dict = {
  'welcome.title': '欢迎光临',
  'welcome.pick': '请选择语言',
  'home.checkIn': '我有预约',
  'home.walkIn': '我没有预约',
  'home.hint': '点一下开始，全程不用一分钟',

  'phone.title': '请输入您的手机号',
  'phone.hint': '就是您预约时留的那个号码',
  'phone.clear': '清除',
  'phone.next': '下一步',
  'phone.back': '返回',
  'phone.notFound': '没有找到今天的预约',
  'phone.notFoundHint': '可能是号码不同，或者预约在别的日子。可以按「我没有预约」排队，或者找前台。',

  'pick.title': '请问是您本人吗？',
  'pick.hint': '点一下您的名字',

  'walkin.title': '请留一个称呼',
  'walkin.hint': '前台叫号时会用到',
  'walkin.namePlaceholder': '例：陈女士',
  'walkin.service': '想做什么？',
  'walkin.skipService': '还没想好',
  'walkin.party': '几位？',

  'form.title': '请先看一下这份说明',
  'form.readHint': '看不懂可以随时按右上角换语言',
  'form.yes': '是',
  'form.no': '否',
  'form.required': '必填',
  'form.signHere': '请在这里签名',
  'form.clearSign': '重签',
  'form.signerName': '您的姓名',
  'form.guardian': '我是监护人代签',
  'form.submit': '确认并提交',
  'form.missing': '还有必填项没填',

  'done.title': '好了！',
  'done.yourNumber': '您的号码',
  'done.ahead': '前面还有',
  'done.people': '位',
  'done.noWait': '马上就到您',
  'done.about': '大约还要',
  'done.minutes': '分钟',
  'done.keepScreen': '请留意叫号，或者把这个号码记一下',
  'done.finish': '完成',

  'err.generic': '出了点问题，请找前台',
  'err.tooMany': '请稍等一下再试',
  'err.device': '这台设备还没配置好，请找前台',

  'setup.title': '配置这台设备',
  'setup.hint': '在前台的「开店配置 → 门口 iPad」里生成一个配对码，粘贴到这里',
  'setup.paste': '粘贴配对码',
  'setup.save': '保存',
  'link.title': '请先填一下健康表',
  'link.hint': '两分钟填完，到店就不用在柜台前填了',
  'link.for': '这份表是发给',
  'link.start': '开始填写',
  'link.remaining': '还剩',
  'link.forms': '份',
  'link.allDone': '都填好了，谢谢！',
  'link.allDoneHint': '到店直接找前台就行，不用再填一遍。',
  'link.dead': '这个链接用不了了',
  'link.deadHint': '可能已经填过了、过期了，或者门店取消了它。请直接联系门店。',
  'link.callShop': '打给门店',
};

const en: Dict = {
  'welcome.title': 'Welcome',
  'welcome.pick': 'Choose your language',
  'home.checkIn': 'I have an appointment',
  'home.walkIn': 'I do not have an appointment',
  'home.hint': 'Tap to start — it takes less than a minute',

  'phone.title': 'Enter your phone number',
  'phone.hint': 'The number you booked with',
  'phone.clear': 'Clear',
  'phone.next': 'Next',
  'phone.back': 'Back',
  'phone.notFound': 'No appointment found for today',
  'phone.notFoundHint': 'It may be a different number, or another day. You can tap "I do not have an appointment" to join the queue, or see the front desk.',

  'pick.title': 'Is this you?',
  'pick.hint': 'Tap your name',

  'walkin.title': 'What should we call you?',
  'walkin.hint': 'We will use it when your turn comes',
  'walkin.namePlaceholder': 'e.g. Ms. Chen',
  'walkin.service': 'What would you like?',
  'walkin.skipService': 'Not sure yet',
  'walkin.party': 'How many people?',

  'form.title': 'Please read this first',
  'form.readHint': 'You can change language any time — top right',
  'form.yes': 'Yes',
  'form.no': 'No',
  'form.required': 'Required',
  'form.signHere': 'Please sign here',
  'form.clearSign': 'Sign again',
  'form.signerName': 'Your name',
  'form.guardian': 'I am signing as a guardian',
  'form.submit': 'Agree and submit',
  'form.missing': 'Some required questions are not answered',

  'done.title': 'All set!',
  'done.yourNumber': 'Your number',
  'done.ahead': 'Ahead of you',
  'done.people': '',
  'done.noWait': 'You are next',
  'done.about': 'About',
  'done.minutes': 'minutes',
  'done.keepScreen': 'Listen for your number, or write it down',
  'done.finish': 'Done',

  'err.generic': 'Something went wrong — please see the front desk',
  'err.tooMany': 'Please wait a moment and try again',
  'err.device': 'This device is not set up yet — please see the front desk',

  'setup.title': 'Set up this device',
  'setup.hint': 'Generate a pairing code in Settings → Door iPad on the front desk, then paste it here',
  'setup.paste': 'Paste pairing code',
  'setup.save': 'Save',
  'link.title': 'Please fill out your health form',
  'link.hint': 'Two minutes now means no paperwork at the counter',
  'link.for': 'This form was sent to',
  'link.start': 'Start',
  'link.remaining': 'Still to go:',
  'link.forms': 'form(s)',
  'link.allDone': 'All done — thank you!',
  'link.allDoneHint': 'Just check in at the front desk when you arrive.',
  'link.dead': 'This link no longer works',
  'link.deadHint': 'It may have been used already, expired, or been cancelled by the shop. Please contact the shop.',
  'link.callShop': 'Call the shop',
};

const vi: Dict = {
  'welcome.title': 'Chào mừng',
  'welcome.pick': 'Chọn ngôn ngữ',
  'home.checkIn': 'Tôi có hẹn trước',
  'home.walkIn': 'Tôi không có hẹn',
  'home.hint': 'Chạm để bắt đầu — chưa tới một phút',

  'phone.title': 'Nhập số điện thoại',
  'phone.hint': 'Số bạn dùng khi đặt hẹn',
  'phone.clear': 'Xóa',
  'phone.next': 'Tiếp',
  'phone.back': 'Quay lại',
  'phone.notFound': 'Không tìm thấy lịch hẹn hôm nay',
  'phone.notFoundHint': 'Có thể là số khác hoặc ngày khác. Bạn có thể chọn "Tôi không có hẹn" để lấy số, hoặc hỏi quầy lễ tân.',

  'pick.title': 'Đây có phải bạn không?',
  'pick.hint': 'Chạm vào tên của bạn',

  'walkin.title': 'Chúng tôi gọi bạn thế nào?',
  'walkin.hint': 'Dùng khi đến lượt bạn',
  'walkin.namePlaceholder': 'ví dụ: Cô Trần',
  'walkin.service': 'Bạn muốn làm gì?',
  'walkin.skipService': 'Chưa quyết định',
  'walkin.party': 'Mấy người?',

  'form.title': 'Vui lòng đọc trước',
  'form.readHint': 'Bạn có thể đổi ngôn ngữ bất cứ lúc nào — góc trên bên phải',
  'form.yes': 'Có',
  'form.no': 'Không',
  'form.required': 'Bắt buộc',
  'form.signHere': 'Vui lòng ký tên ở đây',
  'form.clearSign': 'Ký lại',
  'form.signerName': 'Tên của bạn',
  'form.guardian': 'Tôi ký thay với tư cách người giám hộ',
  'form.submit': 'Đồng ý và gửi',
  'form.missing': 'Còn câu hỏi bắt buộc chưa trả lời',

  'done.title': 'Xong!',
  'done.yourNumber': 'Số của bạn',
  'done.ahead': 'Trước bạn còn',
  'done.people': 'người',
  'done.noWait': 'Sắp tới lượt bạn',
  'done.about': 'Khoảng',
  'done.minutes': 'phút',
  'done.keepScreen': 'Chú ý nghe gọi số, hoặc ghi lại số này',
  'done.finish': 'Hoàn tất',

  'err.generic': 'Có lỗi xảy ra — vui lòng hỏi quầy lễ tân',
  'err.tooMany': 'Vui lòng đợi một chút rồi thử lại',
  'err.device': 'Thiết bị chưa được thiết lập — vui lòng hỏi quầy lễ tân',

  'setup.title': 'Thiết lập thiết bị',
  'setup.hint': 'Tạo mã ghép nối ở quầy lễ tân rồi dán vào đây',
  'setup.paste': 'Dán mã ghép nối',
  'setup.save': 'Lưu',
  'link.title': 'Vui lòng điền phiếu sức khỏe',
  'link.hint': 'Hai phút bây giờ, khỏi phải điền ở quầy khi đến',
  'link.for': 'Phiếu này được gửi cho',
  'link.start': 'Bắt đầu',
  'link.remaining': 'Còn lại:',
  'link.forms': 'phiếu',
  'link.allDone': 'Xong rồi — cảm ơn bạn!',
  'link.allDoneHint': 'Khi đến, bạn chỉ cần báo quầy lễ tân.',
  'link.dead': 'Liên kết này không dùng được nữa',
  'link.deadHint': 'Có thể đã điền rồi, đã hết hạn, hoặc cửa hàng đã hủy. Vui lòng liên hệ cửa hàng.',
  'link.callShop': 'Gọi cửa hàng',
};

const ko: Dict = {
  'welcome.title': '환영합니다',
  'welcome.pick': '언어를 선택하세요',
  'home.checkIn': '예약했습니다',
  'home.walkIn': '예약 없이 왔습니다',
  'home.hint': '눌러서 시작하세요 — 1분도 안 걸립니다',

  'phone.title': '전화번호를 입력하세요',
  'phone.hint': '예약하실 때 사용한 번호',
  'phone.clear': '지우기',
  'phone.next': '다음',
  'phone.back': '뒤로',
  'phone.notFound': '오늘 예약을 찾을 수 없습니다',
  'phone.notFoundHint': '번호가 다르거나 다른 날짜일 수 있습니다. "예약 없이 왔습니다"를 눌러 대기하시거나 데스크에 문의하세요.',

  'pick.title': '본인이 맞으신가요?',
  'pick.hint': '이름을 눌러주세요',

  'walkin.title': '어떻게 불러드릴까요?',
  'walkin.hint': '순서가 되면 불러드립니다',
  'walkin.namePlaceholder': '예: 진 님',
  'walkin.service': '무엇을 원하시나요?',
  'walkin.skipService': '아직 정하지 않음',
  'walkin.party': '몇 분이신가요?',

  'form.title': '먼저 확인해 주세요',
  'form.readHint': '오른쪽 위에서 언제든 언어를 바꿀 수 있습니다',
  'form.yes': '예',
  'form.no': '아니오',
  'form.required': '필수',
  'form.signHere': '여기에 서명해 주세요',
  'form.clearSign': '다시 서명',
  'form.signerName': '성함',
  'form.guardian': '보호자로서 서명합니다',
  'form.submit': '동의하고 제출',
  'form.missing': '필수 항목이 남아 있습니다',

  'done.title': '완료!',
  'done.yourNumber': '번호',
  'done.ahead': '앞에',
  'done.people': '분',
  'done.noWait': '곧 순서입니다',
  'done.about': '약',
  'done.minutes': '분',
  'done.keepScreen': '번호를 기억해 주세요',
  'done.finish': '완료',

  'err.generic': '문제가 발생했습니다 — 데스크에 문의하세요',
  'err.tooMany': '잠시 후 다시 시도해 주세요',
  'err.device': '기기가 설정되지 않았습니다 — 데스크에 문의하세요',

  'setup.title': '기기 설정',
  'setup.hint': '데스크에서 페어링 코드를 생성한 뒤 여기에 붙여넣으세요',
  'setup.paste': '페어링 코드 붙여넣기',
  'setup.save': '저장',
  'link.title': '건강 문진표를 작성해 주세요',
  'link.hint': '지금 2분이면 매장에서 따로 작성하지 않아도 됩니다',
  'link.for': '이 문진표는 다음 분께 보냈습니다:',
  'link.start': '시작하기',
  'link.remaining': '남은 문진표:',
  'link.forms': '개',
  'link.allDone': '모두 완료되었습니다. 감사합니다!',
  'link.allDoneHint': '방문하시면 프런트에 말씀만 해주세요.',
  'link.dead': '이 링크는 더 이상 사용할 수 없습니다',
  'link.deadHint': '이미 작성되었거나, 기한이 지났거나, 매장에서 취소했을 수 있습니다. 매장으로 문의해 주세요.',
  'link.callShop': '매장에 전화하기',
};

const es: Dict = {
  'welcome.title': 'Bienvenido',
  'welcome.pick': 'Elija su idioma',
  'home.checkIn': 'Tengo una cita',
  'home.walkIn': 'No tengo cita',
  'home.hint': 'Toque para empezar — menos de un minuto',

  'phone.title': 'Escriba su teléfono',
  'phone.hint': 'El número con el que reservó',
  'phone.clear': 'Borrar',
  'phone.next': 'Siguiente',
  'phone.back': 'Atrás',
  'phone.notFound': 'No encontramos una cita para hoy',
  'phone.notFoundHint': 'Puede ser otro número u otro día. Toque "No tengo cita" para hacer fila, o pregunte en recepción.',

  'pick.title': '¿Es usted?',
  'pick.hint': 'Toque su nombre',

  'walkin.title': '¿Cómo lo llamamos?',
  'walkin.hint': 'Lo usaremos cuando sea su turno',
  'walkin.namePlaceholder': 'ej. Sra. Chen',
  'walkin.service': '¿Qué desea?',
  'walkin.skipService': 'Aún no lo sé',
  'walkin.party': '¿Cuántas personas?',

  'form.title': 'Por favor lea esto primero',
  'form.readHint': 'Puede cambiar el idioma arriba a la derecha',
  'form.yes': 'Sí',
  'form.no': 'No',
  'form.required': 'Obligatorio',
  'form.signHere': 'Firme aquí',
  'form.clearSign': 'Firmar de nuevo',
  'form.signerName': 'Su nombre',
  'form.guardian': 'Firmo como tutor',
  'form.submit': 'Aceptar y enviar',
  'form.missing': 'Faltan preguntas obligatorias',

  'done.title': '¡Listo!',
  'done.yourNumber': 'Su número',
  'done.ahead': 'Antes de usted',
  'done.people': 'personas',
  'done.noWait': 'Usted sigue',
  'done.about': 'Unos',
  'done.minutes': 'minutos',
  'done.keepScreen': 'Esté atento a su número',
  'done.finish': 'Listo',

  'err.generic': 'Algo salió mal — pregunte en recepción',
  'err.tooMany': 'Espere un momento e intente de nuevo',
  'err.device': 'Este dispositivo no está configurado — pregunte en recepción',

  'setup.title': 'Configurar este dispositivo',
  'setup.hint': 'Genere un código en recepción y péguelo aquí',
  'setup.paste': 'Pegar código',
  'setup.save': 'Guardar',
  'link.title': 'Complete su formulario de salud',
  'link.hint': 'Dos minutos ahora y no tendrá que llenarlo en el mostrador',
  'link.for': 'Este formulario se envió a',
  'link.start': 'Empezar',
  'link.remaining': 'Faltan:',
  'link.forms': 'formulario(s)',
  'link.allDone': 'Listo — ¡gracias!',
  'link.allDoneHint': 'Solo avise en recepción cuando llegue.',
  'link.dead': 'Este enlace ya no funciona',
  'link.deadHint': 'Puede que ya se haya usado, haya caducado o el negocio lo haya cancelado. Comuníquese con el negocio.',
  'link.callShop': 'Llamar al negocio',
};

const zhHant: Dict = {
  ...zhHans,
  'welcome.title': '歡迎光臨',
  'welcome.pick': '請選擇語言',
  'home.checkIn': '我有預約',
  'home.walkIn': '我沒有預約',
  'home.hint': '點一下開始，全程不用一分鐘',
  'phone.title': '請輸入您的手機號碼',
  'phone.hint': '就是您預約時留的那個號碼',
  'phone.notFound': '沒有找到今天的預約',
  'pick.title': '請問是您本人嗎？',
  'pick.hint': '點一下您的名字',
  'walkin.title': '請留一個稱呼',
  'form.title': '請先看一下這份說明',
  'form.signHere': '請在這裡簽名',
  'form.submit': '確認並提交',
  'done.title': '好了！',
  'done.yourNumber': '您的號碼',
  'done.ahead': '前面還有',
  'done.keepScreen': '請留意叫號，或者把這個號碼記一下',
  'link.title': '請先填一下健康表',
  'link.hint': '兩分鐘填完，到店就不用在櫃檯前填了',
  'link.for': '這份表是發給',
  'link.start': '開始填寫',
  'link.remaining': '還剩',
  'link.forms': '份',
  'link.allDone': '都填好了，謝謝！',
  'link.allDoneHint': '到店直接找櫃檯就行，不用再填一遍。',
  'link.dead': '這個連結用不了了',
  'link.deadHint': '可能已經填過了、過期了，或者門店取消了它。請直接聯絡門店。',
  'link.callShop': '打給門店',
};

const DICTS: Record<Locale, Dict> = {
  'zh-Hans': zhHans, en, vi, ko, es, 'zh-Hant': zhHant,
};

/**
 * 取一句文案。
 *
 * 找不到就回退到英文，**再找不到就把 key 原样显示** ——
 * 显示成空白会让人以为界面坏了，而看到一个 key 至少能报给我们。
 */
export function makeT(locale: Locale) {
  return (key: string): string => DICTS[locale][key] ?? en[key] ?? key;
}

/** 服务端返回的 i18n 字段（项目名、表单标题、题目）按当前语言取 */
export function pick(v: unknown, locale: Locale): string {
  if (typeof v === 'string') return v;
  const o = (v ?? {}) as Record<string, string>;
  return o[locale] ?? o['en'] ?? o['zh-Hans'] ?? Object.values(o)[0] ?? '';
}
