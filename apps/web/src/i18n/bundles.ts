/**
 * 组合套餐（service bundle，U10）的界面文案。
 *
 * 覆盖范围：pages/Marketing.tsx 的「组合套餐」标签页、features/bundles/*、
 * 看板卡片的套餐分组、结账页的套餐明细、apps/booking 的套餐选择、
 * features/setup/ImportWorkspace.tsx 的组合/次卡分流。
 * key 一律以 `bundle.` 为前缀，避免跨域重名。
 *
 * 组合套餐 = 一次买走固定组合价、当场展开成实际子项履约；
 * 与「次卡」（package，按次核销的预付资产）是两回事，文案须让店主区分。
 */
import type { DomainDict } from './types';

export const bundle = {
  // ── 导航 / 通用 ───────────────────────────────────────────────────────────
  'bundle.navLabel': { 'zh-Hans': '组合套餐', 'zh-Hant': "組合套餐", en: 'Bundles', ko: '묶음 상품', es: 'Paquetes combinados', vi: 'Gói kết hợp' },
  'bundle.tabTitle': { 'zh-Hans': '组合套餐', 'zh-Hant': "組合套餐", en: 'Service bundles', ko: '서비스 묶음', es: 'Paquetes de servicios', vi: 'Gói dịch vụ' },
  'bundle.tabDesc': { 'zh-Hans': '几个项目一起买走固定组合价，开单时自动展开成实际子项。与按次核销的次卡不同。', 'zh-Hant': "幾個項目一起買走固定組合價，開單時自動展開成實際子項。與按次覈銷的次卡不同。", en: 'Several services bought together at one fixed price, expanded into their real sub-items at checkout. Different from a punch-card package.', ko: '여러 서비스를 하나의 고정 가격으로 함께 판매하고, 계산 시 실제 하위 항목으로 펼칩니다. 횟수 차감식 회수권과 다릅니다.', es: 'Varios servicios comprados juntos a un precio fijo, que se despliegan en sus subelementos reales al cobrar. Distinto de un bono por sesiones.', vi: 'Nhiều dịch vụ mua chung với một giá cố định, được tách thành các mục con thực tế khi thanh toán. Khác với thẻ trừ buổi.' },
  'bundle.vsPackageHint': { 'zh-Hans': '提示：「组合套餐」是一次做完的固定组合；「次卡」是买了之后按次核销。选错类型会影响履约和账务。', 'zh-Hant': "提示：「組合套餐」是一次做完的固定組合；「次卡」是買了之後按次覈銷。選錯類型會影響履約和賬務。", en: 'Note: a bundle is a fixed combination done in one visit; a package is redeemed session by session. The wrong type affects fulfilment and accounting.', ko: '참고: 묶음 상품은 한 번 방문에 완료하는 고정 조합이고, 회수권은 방문마다 차감합니다. 유형을 잘못 고르면 이행과 회계에 영향을 줍니다.', es: 'Nota: un paquete combinado es una combinación fija realizada en una visita; un bono se canjea sesión a sesión. Elegir mal el tipo afecta la ejecución y la contabilidad.', vi: 'Lưu ý: gói kết hợp là tổ hợp cố định làm trong một lần; thẻ buổi được trừ theo từng buổi. Chọn sai loại sẽ ảnh hưởng đến thực hiện và kế toán.' },

  // ── 目录列表 ──────────────────────────────────────────────────────────────
  'bundle.newButton': { 'zh-Hans': '新建组合套餐', 'zh-Hant': "新建組合套餐", en: 'New bundle', ko: '새 묶음 상품', es: 'Nuevo paquete', vi: 'Gói mới' },
  'bundle.empty': { 'zh-Hans': '还没有组合套餐。点「新建组合套餐」把常一起做的几个项目打包成一个优惠价。', 'zh-Hant': "還沒有組合套餐。點「新建組合套餐」把常一起做的幾個項目打包成一個優惠價。", en: 'No bundles yet. Use “New bundle” to package services that are often done together at one price.', ko: '아직 묶음 상품이 없습니다. “새 묶음 상품”으로 함께 자주 하는 서비스를 하나의 가격으로 묶으세요.', es: 'Aún no hay paquetes. Usa «Nuevo paquete» para agrupar servicios que suelen hacerse juntos a un solo precio.', vi: 'Chưa có gói nào. Dùng “Gói mới” để gộp các dịch vụ thường làm cùng nhau vào một mức giá.' },
  'bundle.colName': { 'zh-Hans': '名称', 'zh-Hant': "名稱", en: 'Name', ko: '이름', es: 'Nombre', vi: 'Tên' },
  'bundle.colItems': { 'zh-Hans': '组成', 'zh-Hant': "組成", en: 'Items', ko: '구성', es: 'Elementos', vi: 'Thành phần' },
  'bundle.colOriginal': { 'zh-Hans': '原价合计', 'zh-Hant': "原價合計", en: 'List total', ko: '정가 합계', es: 'Total de lista', vi: 'Tổng giá gốc' },
  'bundle.colPrice': { 'zh-Hans': '组合价', 'zh-Hant': "組合價", en: 'Bundle price', ko: '묶음 가격', es: 'Precio del paquete', vi: 'Giá gói' },
  'bundle.colDiscount': { 'zh-Hans': '优惠', 'zh-Hant': "優惠", en: 'Savings', ko: '할인', es: 'Ahorro', vi: 'Tiết kiệm' },
  'bundle.colStatus': { 'zh-Hans': '状态', 'zh-Hant': "狀態", en: 'Status', ko: '상태', es: 'Estado', vi: 'Trạng thái' },
  'bundle.statusActive': { 'zh-Hans': '在售', 'zh-Hant': "在售", en: 'Active', ko: '판매 중', es: 'Activo', vi: 'Đang bán' },
  'bundle.statusArchived': { 'zh-Hans': '已下架', 'zh-Hant': "已下架", en: 'Archived', ko: '내림', es: 'Archivado', vi: 'Đã lưu trữ' },
  'bundle.statusOnline': { 'zh-Hans': '可在线预约', 'zh-Hant': "可在線預約", en: 'Online bookable', ko: '온라인 예약 가능', es: 'Reservable en línea', vi: 'Đặt trực tuyến' },
  'bundle.needsFix': { 'zh-Hans': '需修复：有子项目已停用', 'zh-Hant': "需修復：有子項目已停用", en: 'Needs fixing: a sub-service is inactive', ko: '수정 필요: 하위 서비스가 비활성', es: 'Requiere corrección: un subservicio está inactivo', vi: 'Cần sửa: một dịch vụ con đã ngừng' },
  'bundle.instanceCount': { 'zh-Hans': '已售 {count} 份', 'zh-Hant': "已售 {count} 份", en: '{count} sold', ko: '{count}건 판매', es: '{count} vendidos', vi: 'Đã bán {count}' },

  // ── 编辑器 ───────────────────────────────────────────────────────────────
  'bundle.editorNewTitle': { 'zh-Hans': '新建组合套餐', 'zh-Hant': "新建組合套餐", en: 'New bundle', ko: '새 묶음 상품', es: 'Nuevo paquete', vi: 'Gói mới' },
  'bundle.editorEditTitle': { 'zh-Hans': '编辑组合套餐', 'zh-Hant': "編輯組合套餐", en: 'Edit bundle', ko: '묶음 상품 편집', es: 'Editar paquete', vi: 'Sửa gói' },
  'bundle.fieldName': { 'zh-Hans': '套餐名称', 'zh-Hant': "套餐名稱", en: 'Bundle name', ko: '묶음 이름', es: 'Nombre del paquete', vi: 'Tên gói' },
  'bundle.fieldNamePlaceholder': { 'zh-Hans': '例如：手足护理套餐', 'zh-Hant': "例如：手足護理套餐", en: 'e.g. Mani + Pedi combo', ko: '예: 손발 관리 세트', es: 'p. ej. Combo manos y pies', vi: 'vd: Combo tay + chân' },
  'bundle.fieldDescription': { 'zh-Hans': '描述（可选）', 'zh-Hant': "描述（可選）", en: 'Description (optional)', ko: '설명(선택)', es: 'Descripción (opcional)', vi: 'Mô tả (tùy chọn)' },
  'bundle.fieldComponents': { 'zh-Hans': '包含的项目', 'zh-Hant': "包含的項目", en: 'Services included', ko: '포함 서비스', es: 'Servicios incluidos', vi: 'Dịch vụ bao gồm' },
  'bundle.addComponent': { 'zh-Hans': '添加项目', 'zh-Hant': "添加項目", en: 'Add a service', ko: '서비스 추가', es: 'Añadir servicio', vi: 'Thêm dịch vụ' },
  'bundle.componentQty': { 'zh-Hans': '份数', 'zh-Hant': "份數", en: 'Qty', ko: '수량', es: 'Cant.', vi: 'SL' },
  'bundle.componentRemove': { 'zh-Hans': '移除', 'zh-Hant': "移除", en: 'Remove', ko: '제거', es: 'Quitar', vi: 'Xóa' },
  'bundle.fieldPrice': { 'zh-Hans': '组合价', 'zh-Hant': "組合價", en: 'Bundle price', ko: '묶음 가격', es: 'Precio del paquete', vi: 'Giá gói' },
  'bundle.priceHelpOriginal': { 'zh-Hans': '原价合计 {amount}', 'zh-Hant': "原價合計 {amount}", en: 'List total {amount}', ko: '정가 합계 {amount}', es: 'Total de lista {amount}', vi: 'Tổng giá gốc {amount}' },
  'bundle.priceHelpSavings': { 'zh-Hans': '顾客省 {amount}', 'zh-Hant': "顧客省 {amount}", en: 'Customer saves {amount}', ko: '고객 절약 {amount}', es: 'El cliente ahorra {amount}', vi: 'Khách tiết kiệm {amount}' },
  'bundle.fieldOnlineBookable': { 'zh-Hans': '允许在线预约', 'zh-Hant': "允許在線預約", en: 'Allow online booking', ko: '온라인 예약 허용', es: 'Permitir reserva en línea', vi: 'Cho phép đặt trực tuyến' },
  'bundle.fieldOnlineBookableHint': { 'zh-Hans': '打开后，这个套餐会出现在门店官网的预约页。', 'zh-Hant': "打開後，這個套餐會出現在門店官網的預約頁。", en: 'When on, this bundle appears on your online booking page.', ko: '켜면 이 묶음 상품이 온라인 예약 페이지에 표시됩니다.', es: 'Si está activo, este paquete aparece en tu página de reservas en línea.', vi: 'Khi bật, gói này xuất hiện trên trang đặt lịch trực tuyến.' },
  'bundle.save': { 'zh-Hans': '保存', 'zh-Hant': "保存", en: 'Save', ko: '저장', es: 'Guardar', vi: 'Lưu' },
  'bundle.saving': { 'zh-Hans': '保存中…', 'zh-Hant': "保存中…", en: 'Saving…', ko: '저장 중…', es: 'Guardando…', vi: 'Đang lưu…' },
  'bundle.saved': { 'zh-Hans': '组合套餐已保存', 'zh-Hant': "組合套餐已保存", en: 'Bundle saved', ko: '묶음 상품을 저장했습니다', es: 'Paquete guardado', vi: 'Đã lưu gói' },
  'bundle.duplicate': { 'zh-Hans': '复制一份', 'zh-Hant': "複製一份", en: 'Duplicate', ko: '복제', es: 'Duplicar', vi: 'Nhân bản' },
  'bundle.archive': { 'zh-Hans': '下架', 'zh-Hant': "下架", en: 'Archive', ko: '내리기', es: 'Archivar', vi: 'Lưu trữ' },
  'bundle.archived': { 'zh-Hans': '组合套餐已下架', 'zh-Hant': "組合套餐已下架", en: 'Bundle archived', ko: '묶음 상품을 내렸습니다', es: 'Paquete archivado', vi: 'Đã lưu trữ gói' },
  'bundle.archiveConfirmTitle': { 'zh-Hans': '下架这个组合套餐？', 'zh-Hant': "下架這個組合套餐？", en: 'Archive this bundle?', ko: '이 묶음 상품을 내릴까요?', es: '¿Archivar este paquete?', vi: 'Lưu trữ gói này?' },
  'bundle.archiveConfirmBody': { 'zh-Hans': '下架后不能再新开这个套餐的单。已经卖出的订单不受影响 —— 名称和价格在下单时已经记下。', 'zh-Hant': "下架後不能再新開這個套餐的單。已經賣出的訂單不受影響 —— 名稱和價格在下單時已經記下。", en: 'Once archived it can no longer be sold. Orders already placed are unaffected — the name and price were captured at the time.', ko: '내린 뒤에는 신규 판매가 불가합니다. 이미 접수된 주문은 영향받지 않습니다 — 이름과 가격은 주문 시점에 기록되었습니다.', es: 'Tras archivarlo ya no se puede vender. Los pedidos ya realizados no se ven afectados: el nombre y el precio quedaron registrados en su momento.', vi: 'Sau khi lưu trữ sẽ không bán được nữa. Các đơn đã tạo không bị ảnh hưởng — tên và giá đã được ghi lại tại thời điểm đó.' },

  // ── 校验 / 错误 ───────────────────────────────────────────────────────────
  'bundle.errNameRequired': { 'zh-Hans': '请填写套餐名称', 'zh-Hant': "請填寫套餐名稱", en: 'Enter a bundle name', ko: '묶음 이름을 입력하세요', es: 'Escribe un nombre de paquete', vi: 'Nhập tên gói' },
  'bundle.errTwoUnits': { 'zh-Hans': '组合套餐至少要包含两个执行单元（可以是不同项目，或同一项目两份）', 'zh-Hant': "組合套餐至少要包含兩個執行單元（可以是不同項目，或同一項目兩份）", en: 'A bundle needs at least two execution units (different services, or the same service twice)', ko: '묶음 상품에는 실행 단위가 최소 2개 필요합니다(다른 서비스 또는 같은 서비스 2개)', es: 'Un paquete necesita al menos dos unidades de ejecución (servicios distintos o el mismo servicio dos veces)', vi: 'Gói cần ít nhất hai đơn vị thực hiện (dịch vụ khác nhau, hoặc cùng một dịch vụ hai lần)' },
  'bundle.errPriceAboveList': { 'zh-Hans': '组合价不能高于原价合计', 'zh-Hant': "組合價不能高於原價合計", en: 'The bundle price cannot exceed the list total', ko: '묶음 가격은 정가 합계를 넘을 수 없습니다', es: 'El precio del paquete no puede superar el total de lista', vi: 'Giá gói không được vượt tổng giá gốc' },
  'bundle.errVersionConflict': { 'zh-Hans': '这个套餐刚被别人改过，请刷新后重试', 'zh-Hant': "這個套餐剛被別人改過，請刷新後重試", en: 'Someone just changed this bundle — refresh and try again', ko: '다른 사용자가 방금 이 묶음 상품을 변경했습니다. 새로고침 후 다시 시도하세요', es: 'Alguien acaba de cambiar este paquete: actualiza e inténtalo de nuevo', vi: 'Ai đó vừa thay đổi gói này — làm mới và thử lại' },
  'bundle.errInactiveService': { 'zh-Hans': '有子项目已停用，请先在「项目」里恢复或替换', 'zh-Hant': "有子項目已停用，請先在「項目」裏恢復或替換", en: 'A sub-service is inactive — restore or replace it under Services first', ko: '하위 서비스가 비활성입니다 — 먼저 서비스에서 복원하거나 교체하세요', es: 'Un subservicio está inactivo: restáuralo o reemplázalo en Servicios primero', vi: 'Một dịch vụ con đã ngừng — hãy khôi phục hoặc thay thế trong mục Dịch vụ trước' },

  // ── 结账 / 工单里的套餐明细 ───────────────────────────────────────────────
  'bundle.checkoutGroupLabel': { 'zh-Hans': '组合套餐', 'zh-Hant': "組合套餐", en: 'Bundle', ko: '묶음', es: 'Paquete', vi: 'Gói' },
  'bundle.checkoutListPrice': { 'zh-Hans': '原价', 'zh-Hant': "原價", en: 'List price', ko: '정가', es: 'Precio de lista', vi: 'Giá gốc' },
  'bundle.checkoutBundleSaving': { 'zh-Hans': '套餐优惠', 'zh-Hant': "套餐優惠", en: 'Bundle savings', ko: '묶음 할인', es: 'Ahorro del paquete', vi: 'Ưu đãi gói' },
  'bundle.checkoutBundlePrice': { 'zh-Hans': '套餐价', 'zh-Hant': "套餐價", en: 'Bundle price', ko: '묶음 가격', es: 'Precio del paquete', vi: 'Giá gói' },
  'bundle.checkoutExtraAddon': { 'zh-Hans': '额外加项', 'zh-Hant': "額外加項", en: 'Extra add-on', ko: '추가 옵션', es: 'Complemento extra', vi: 'Tùy chọn thêm' },
  'bundle.checkoutSubItem': { 'zh-Hans': '子项', 'zh-Hant': "子項", en: 'Sub-item', ko: '하위 항목', es: 'Subelemento', vi: 'Mục con' },

  // ── 拆单为单项（B14）─────────────────────────────────────────────────────
  'bundle.split': { 'zh-Hans': '拆成单项', 'zh-Hant': "拆成單項", en: 'Split into items', ko: '개별 항목으로 분리', es: 'Separar en elementos', vi: 'Tách thành từng mục' },
  'bundle.splitConfirmTitle': { 'zh-Hans': '把这份组合套餐拆成单独的项目？', 'zh-Hant': "把這份組合套餐拆成單獨的項目？", en: 'Split this bundle into separate services?', ko: '이 묶음을 개별 서비스로 분리할까요?', es: '¿Separar este paquete en servicios sueltos?', vi: 'Tách gói này thành các dịch vụ riêng?' },
  'bundle.splitConfirmBody': { 'zh-Hans': '拆开后各项目按下单时锁定的单项原价计费，不再享受套餐价。仅在未开工、未付款时可拆。', 'zh-Hant': "拆開後各項目按下單時鎖定的單項原價計費，不再享受套餐價。僅在未開工、未付款時可拆。", en: 'After splitting, each service is charged at the single-item price locked when the order was placed — the bundle price no longer applies. Only possible before work starts and before payment.', ko: '분리 후 각 서비스는 주문 시 고정된 개별 가격으로 청구되며 묶음 가격이 더는 적용되지 않습니다. 작업 시작 전·결제 전에만 가능합니다.', es: 'Tras separarlo, cada servicio se cobra al precio individual fijado al hacer el pedido; el precio del paquete deja de aplicarse. Solo es posible antes de empezar y antes del pago.', vi: 'Sau khi tách, mỗi dịch vụ tính theo giá lẻ đã khóa khi tạo đơn — không còn giá gói. Chỉ thực hiện được trước khi bắt đầu và trước khi thanh toán.' },
  'bundle.splitDone': { 'zh-Hans': '已拆成单项', 'zh-Hant': "已拆成單項", en: 'Split into items', ko: '개별 항목으로 분리했습니다', es: 'Separado en elementos', vi: 'Đã tách thành từng mục' },
  'bundle.splitUnsupportedExtras': { 'zh-Hans': '这份套餐带了额外加项或额外优惠，暂不能直接拆 —— 请作废后重新开单', 'zh-Hant': "這份套餐帶了額外加項或額外優惠，暫不能直接拆 —— 請作廢後重新開單", en: 'This bundle has extra add-ons or an extra discount and cannot be split directly — void and re-open the ticket instead', ko: '이 묶음에는 추가 옵션이나 추가 할인이 있어 바로 분리할 수 없습니다 — 취소 후 다시 접수하세요', es: 'Este paquete tiene complementos o un descuento extra y no puede separarse directamente: anúlalo y vuelve a abrir el ticket', vi: 'Gói này có tùy chọn thêm hoặc ưu đãi thêm nên không thể tách trực tiếp — hãy hủy và mở lại phiếu' },

  // ── 看板卡片 ─────────────────────────────────────────────────────────────
  'bundle.cardBadge': { 'zh-Hans': '套餐', 'zh-Hant': "套餐", en: 'Bundle', ko: '묶음', es: 'Paquete', vi: 'Gói' },
  'bundle.cardProgress': { 'zh-Hans': '{done}/{total} 项已完成', 'zh-Hant': "{done}/{total} 項已完成", en: '{done}/{total} done', ko: '{done}/{total} 완료', es: '{done}/{total} hechos', vi: '{done}/{total} xong' },
  'bundle.cardFulfilled': { 'zh-Hans': '套餐已完成', 'zh-Hant': "套餐已完成", en: 'Bundle complete', ko: '묶음 완료', es: 'Paquete completo', vi: 'Gói hoàn tất' },

  // ── 在线预约（apps/booking）─────────────────────────────────────────────
  'bundle.bookingSectionTitle': { 'zh-Hans': '套餐', 'zh-Hant': "套餐", en: 'Bundles', ko: '묶음 상품', es: 'Paquetes', vi: 'Gói' },
  'bundle.bookingIncludes': { 'zh-Hans': '包含', 'zh-Hant': "包含", en: 'Includes', ko: '포함', es: 'Incluye', vi: 'Bao gồm' },
  'bundle.bookingOriginal': { 'zh-Hans': '原价 {amount}', 'zh-Hant': "原價 {amount}", en: 'List {amount}', ko: '정가 {amount}', es: 'Lista {amount}', vi: 'Giá gốc {amount}' },
  'bundle.bookingSelect': { 'zh-Hans': '选这个套餐', 'zh-Hant': "選這個套餐", en: 'Choose this bundle', ko: '이 묶음 선택', es: 'Elegir este paquete', vi: 'Chọn gói này' },
  'bundle.bookingSelected': { 'zh-Hans': '已选套餐', 'zh-Hant': "已選套餐", en: 'Bundle selected', ko: '묶음 선택됨', es: 'Paquete elegido', vi: 'Đã chọn gói' },

  // ── 导入分流（ImportWorkspace）─────────────────────────────────────────
  'bundle.importKindBundle': { 'zh-Hans': '组合套餐', 'zh-Hant': "組合套餐", en: 'Bundle', ko: '묶음 상품', es: 'Paquete combinado', vi: 'Gói kết hợp' },
  'bundle.importKindPackage': { 'zh-Hans': '次卡', 'zh-Hant': "次卡", en: 'Package', ko: '회수권', es: 'Bono', vi: 'Thẻ buổi' },
  'bundle.importKindAmbiguous': { 'zh-Hans': '待确认类型', 'zh-Hant': "待確認類型", en: 'Type unclear', ko: '유형 미확정', es: 'Tipo por confirmar', vi: 'Chưa rõ loại' },
  'bundle.importPickKind': { 'zh-Hans': '这是组合套餐还是次卡？', 'zh-Hant': "這是組合套餐還是次卡？", en: 'Is this a bundle or a package?', ko: '묶음 상품인가요, 회수권인가요?', es: '¿Es un paquete combinado o un bono?', vi: 'Đây là gói kết hợp hay thẻ buổi?' },
  'bundle.importUnresolved': { 'zh-Hans': '有组成项目未匹配到现有项目，请选择或新建', 'zh-Hant': "有組成項目未匹配到現有項目，請選擇或新建", en: 'Some component services are unmatched — pick an existing one or create it', ko: '일부 구성 서비스가 매칭되지 않았습니다 — 기존 항목을 고르거나 새로 만드세요', es: 'Algunos servicios del combo no coinciden: elige uno existente o créalo', vi: 'Một số dịch vụ thành phần chưa khớp — hãy chọn dịch vụ có sẵn hoặc tạo mới' },
  'bundle.importKindHint': { 'zh-Hans': '按次数与项目数自动判断，可手动改。', 'zh-Hant': "按次數與項目數自動判斷，可手動改。", en: 'Guessed from the session count and service list; change it if wrong.', ko: '횟수와 서비스 수로 자동 판단합니다. 필요하면 변경하세요.', es: 'Deducido del número de sesiones y de servicios; cámbialo si no es correcto.', vi: 'Suy ra từ số buổi và số dịch vụ; đổi nếu sai.' },
  'bundle.importCreated': { 'zh-Hans': '已创建 {count} 个组合套餐', 'zh-Hant': "已創建 {count} 個組合套餐", en: 'Created {count} bundle(s)', ko: '묶음 상품 {count}개를 만들었습니다', es: 'Se crearon {count} paquete(s)', vi: 'Đã tạo {count} gói' },
  'bundle.importSkipped': { 'zh-Hans': '这些组合的组成项目没找到，请在「组合套餐」页手动创建：{names}', 'zh-Hant': "這些組合的組成項目沒找到，請在「組合套餐」頁手動創建：{names}", en: 'These combos had unmatched component services — build them by hand under Bundles: {names}', ko: '구성 서비스를 찾지 못한 조합입니다. 묶음 상품 페이지에서 직접 만드세요: {names}', es: 'Estos combos tienen servicios sin coincidencia: créalos a mano en Paquetes: {names}', vi: 'Các combo này có dịch vụ thành phần chưa khớp — hãy tạo thủ công ở mục Gói: {names}' },

  // ── 前台选套餐（新建预约 / 看板 walk-in 开单）─────────────────────────────
  'bundle.pickerModeSingle': { 'zh-Hans': '单项', 'zh-Hant': "單項", en: 'Single services', ko: '단품', es: 'Servicios sueltos', vi: 'Dịch vụ lẻ' },
  'bundle.pickerModeBundle': { 'zh-Hans': '组合套餐', 'zh-Hant': "組合套餐", en: 'Bundle', ko: '묶음 상품', es: 'Paquete', vi: 'Gói kết hợp' },
  'bundle.pickerHeading': { 'zh-Hans': '选择组合套餐', 'zh-Hant': "選擇組合套餐", en: 'Choose a bundle', ko: '묶음 상품 선택', es: 'Elegir un paquete', vi: 'Chọn gói kết hợp' },
  'bundle.pickerPlaceholder': { 'zh-Hans': '选择一个组合套餐…', 'zh-Hant': "選擇一個組合套餐…", en: 'Pick a bundle…', ko: '묶음 상품을 고르세요…', es: 'Elige un paquete…', vi: 'Chọn một gói…' },
  'bundle.pickerNoTemplates': { 'zh-Hans': '暂无在售的组合套餐。先去「组合套餐」页建一个。', 'zh-Hant': "暫無在售的組合套餐。先去「組合套餐」頁建一個。", en: 'No active bundles yet. Create one under Bundles first.', ko: '판매 중인 묶음 상품이 없습니다. 먼저 묶음 상품 페이지에서 만드세요.', es: 'Aún no hay paquetes activos. Crea uno en Paquetes primero.', vi: 'Chưa có gói nào đang bán. Hãy tạo một gói ở mục Gói trước.' },
  'bundle.pickerUnfulfillable': { 'zh-Hans': '组成项目已停用，去组合套餐页修复', 'zh-Hant': "組成項目已停用，去組合套餐頁修復", en: 'A component service is inactive — fix it under Bundles', ko: '구성 서비스가 비활성입니다 — 묶음 상품 페이지에서 수정하세요', es: 'Un servicio del paquete está inactivo: corrígelo en Paquetes', vi: 'Một dịch vụ thành phần đã ngừng — hãy sửa ở mục Gói' },
  'bundle.pickerUnitsHeading': { 'zh-Hans': '套餐子项（逐项指派技师）', 'zh-Hant': "套餐子項（逐項指派技師）", en: 'Bundle sub-items (assign a therapist to each)', ko: '묶음 하위 항목(항목마다 담당자 지정)', es: 'Subelementos del paquete (asigna un terapeuta a cada uno)', vi: 'Các mục con của gói (phân công KTV cho từng mục)' },
  'bundle.pickerLoadingQuote': { 'zh-Hans': '正在计算套餐明细…', 'zh-Hant': "正在計算套餐明細…", en: 'Calculating bundle details…', ko: '묶음 상세 계산 중…', es: 'Calculando los detalles del paquete…', vi: 'Đang tính chi tiết gói…' },
  'bundle.pickerQuoteFailed': { 'zh-Hans': '套餐报价失败，请重试', 'zh-Hant': "套餐報價失敗，請重試", en: 'Could not price the bundle — try again', ko: '묶음 견적에 실패했습니다. 다시 시도하세요', es: 'No se pudo cotizar el paquete: inténtalo de nuevo', vi: 'Không thể báo giá gói — hãy thử lại' },
  'bundle.pickerOriginalTotal': { 'zh-Hans': '原价合计', 'zh-Hant': "原價合計", en: 'List total', ko: '정가 합계', es: 'Total de lista', vi: 'Tổng giá gốc' },
  'bundle.pickerBundlePrice': { 'zh-Hans': '组合价', 'zh-Hant': "組合價", en: 'Bundle price', ko: '묶음 가격', es: 'Precio del paquete', vi: 'Giá gói' },
  'bundle.pickerSavings': { 'zh-Hans': '套餐优惠', 'zh-Hant': "套餐優惠", en: 'Bundle savings', ko: '묶음 할인', es: 'Ahorro del paquete', vi: 'Ưu đãi gói' },
  'bundle.pickerStaffRequired': { 'zh-Hans': '每个子项都要指定技师', 'zh-Hant': "每個子項都要指定技師", en: 'Every sub-item needs a therapist', ko: '모든 하위 항목에 담당자를 지정해야 합니다', es: 'Cada subelemento necesita un terapeuta', vi: 'Mỗi mục con cần một KTV' },
  'bundle.pickerStartTime': { 'zh-Hans': '套餐开始时刻', 'zh-Hant': "套餐開始時刻", en: 'Bundle start time', ko: '묶음 시작 시각', es: 'Hora de inicio del paquete', vi: 'Giờ bắt đầu gói' },
  'bundle.pickerSubItemsFollow': { 'zh-Hans': '子项从这个时刻起按标准时长顺排', 'zh-Hant': "子項從這個時刻起按標準時長順排", en: 'Sub-items run back-to-back from this time at their standard durations', ko: '하위 항목은 이 시각부터 표준 소요시간으로 연이어 배치됩니다', es: 'Los subelementos se encadenan desde esta hora con su duración estándar', vi: 'Các mục con nối tiếp nhau từ giờ này theo thời lượng chuẩn' },
  'bundle.errNotFound': { 'zh-Hans': '这个组合套餐已不存在，请刷新后重试', 'zh-Hant': "這個組合套餐已不存在，請刷新後重試", en: 'This bundle no longer exists — refresh and try again', ko: '이 묶음 상품은 더 이상 존재하지 않습니다. 새로고침 후 다시 시도하세요', es: 'Este paquete ya no existe: actualiza e inténtalo de nuevo', vi: 'Gói này không còn tồn tại — làm mới và thử lại' },

  // ── 套餐额外加项（新建预约 / 看板 walk-in 通用）─────────────────────────
  'bundle.addonSectionLabel': { 'zh-Hans': '额外加项（可选）', 'zh-Hant': "額外加項（可選）", en: 'Extra add-ons (optional)', ko: '추가 옵션(선택)', es: 'Complementos extra (opcional)', vi: 'Tùy chọn thêm (không bắt buộc)' },
  'bundle.addonPick': { 'zh-Hans': '添加加项…', 'zh-Hant': "添加加項…", en: 'Add an add-on…', ko: '옵션 추가…', es: 'Añadir un complemento…', vi: 'Thêm tùy chọn…' },
  'bundle.addonQty': { 'zh-Hans': '数量', 'zh-Hant': "數量", en: 'Qty', ko: '수량', es: 'Cant.', vi: 'SL' },
  'bundle.addonRemove': { 'zh-Hans': '移除加项', 'zh-Hant': "移除加項", en: 'Remove add-on', ko: '옵션 제거', es: 'Quitar complemento', vi: 'Xóa tùy chọn' },
  'bundle.addonExtraLine': { 'zh-Hans': '额外加项', 'zh-Hant': "額外加項", en: 'Extra add-ons', ko: '추가 옵션', es: 'Complementos extra', vi: 'Tùy chọn thêm' },
  'bundle.addonNetTotal': { 'zh-Hans': '应付合计', 'zh-Hant': "應付合計", en: 'Amount due', ko: '결제 금액', es: 'Total a pagar', vi: 'Tổng phải trả' },
  'bundle.addonNone': { 'zh-Hans': '这个门店还没有可加的加项', 'zh-Hant': "這個門店還沒有可加的加項", en: 'No add-on services available at this location', ko: '이 지점에 추가할 수 있는 옵션이 없습니다', es: 'No hay complementos disponibles en esta sede', vi: 'Chi nhánh này chưa có dịch vụ tùy chọn' },

  // ── 预约详情抽屉：只读展示已选套餐 ─────────────────────────────────────────
  'bundle.drawerSectionTitle': { 'zh-Hans': '已选组合套餐', 'zh-Hant': "已選組合套餐", en: 'Selected bundle', ko: '선택한 묶음 상품', es: 'Paquete elegido', vi: 'Gói đã chọn' },
  'bundle.drawerHint': { 'zh-Hans': '子项的改期 / 换技师用上方「改期」，服务端会按套餐整体感知处理。', 'zh-Hant': "子項的改期 / 換技師用上方「改期」，服務端會按套餐整體感知處理。", en: 'To reschedule or reassign a sub-item, use “Reschedule” above — the server handles it bundle-aware.', ko: '하위 항목의 일정 변경·담당자 변경은 위의 “일정 변경”을 사용하세요. 서버가 묶음 단위로 처리합니다.', es: 'Para reprogramar o reasignar un subelemento, usa «Reprogramar» arriba; el servidor lo gestiona a nivel de paquete.', vi: 'Để đổi lịch hoặc đổi KTV cho mục con, dùng “Đổi lịch” ở trên — máy chủ xử lý theo cả gói.' },

  // ── 看板 walk-in 直接开单（组合套餐）─────────────────────────────────────
  'bundle.walkInButton': { 'zh-Hans': '套餐开单', 'zh-Hant': "套餐開單", en: 'Bundle ticket', ko: '묶음 접수', es: 'Ticket de paquete', vi: 'Mở phiếu gói' },
  'bundle.walkInTitle': { 'zh-Hans': '直接开单 · 组合套餐', 'zh-Hant': "直接開單 · 組合套餐", en: 'Open a ticket · bundle', ko: '바로 접수 · 묶음 상품', es: 'Abrir ticket · paquete', vi: 'Mở phiếu · gói kết hợp' },
  'bundle.walkInSubtitle': { 'zh-Hans': '无预约到店客，选套餐直接开单；每个子项都要指定技师。', 'zh-Hant': "無預約到店客，選套餐直接開單；每個子項都要指定技師。", en: 'Walk-in with no appointment — pick a bundle and open the ticket now; every sub-item needs a therapist.', ko: '예약 없이 방문한 고객 — 묶음 상품을 골라 바로 접수합니다. 모든 하위 항목에 담당자를 지정해야 합니다.', es: 'Cliente sin cita: elige un paquete y abre el ticket ahora; cada subelemento necesita un terapeuta.', vi: 'Khách vãng lai không hẹn — chọn gói và mở phiếu ngay; mỗi mục con cần một KTV.' },
  'bundle.walkInNameLabel': { 'zh-Hans': '客人称呼', 'zh-Hant': "客人稱呼", en: 'Guest name', ko: '고객 이름', es: 'Nombre del cliente', vi: 'Tên khách' },
  'bundle.walkInNamePlaceholder': { 'zh-Hans': '例如：王小姐', 'zh-Hant': "例如：王小姐", en: 'e.g. Jane', ko: '예: 홍길동', es: 'p. ej. Ana', vi: 'vd: Chị Lan' },
  'bundle.walkInNameRequired': { 'zh-Hans': '请填写客人称呼', 'zh-Hant': "請填寫客人稱呼", en: 'Enter a guest name', ko: '고객 이름을 입력하세요', es: 'Escribe el nombre del cliente', vi: 'Nhập tên khách' },
  'bundle.walkInPickStaff': { 'zh-Hans': '选择技师…', 'zh-Hant': "選擇技師…", en: 'Choose a therapist…', ko: '담당자 선택…', es: 'Elige un terapeuta…', vi: 'Chọn KTV…' },
  'bundle.walkInSubmit': { 'zh-Hans': '开单', 'zh-Hant': "開單", en: 'Open ticket', ko: '접수', es: 'Abrir ticket', vi: 'Mở phiếu' },
  'bundle.walkInSubmitting': { 'zh-Hans': '开单中…', 'zh-Hant': "開單中…", en: 'Opening…', ko: '접수 중…', es: 'Abriendo…', vi: 'Đang mở…' },
  'bundle.walkInSuccess': { 'zh-Hans': '已为 {name} 开单', 'zh-Hant': "已爲 {name} 開單", en: 'Ticket opened for {name}', ko: '{name} 님 접수 완료', es: 'Ticket abierto para {name}', vi: 'Đã mở phiếu cho {name}' },
  'bundle.errUnitMultiStaff': { 'zh-Hans': '这个套餐里有需要多位技师的项目，暂不支持直接开单', 'zh-Hant': "這個套餐裏有需要多位技師的項目，暫不支持直接開單", en: 'This bundle contains a service that needs more than one therapist — direct ticketing is not supported yet', ko: '이 묶음에는 관리사가 여러 명 필요한 서비스가 있어 바로 접수를 지원하지 않습니다', es: 'Este paquete incluye un servicio que requiere más de un terapeuta: aún no se puede abrir el ticket directamente', vi: 'Gói này có dịch vụ cần nhiều KTV — chưa hỗ trợ mở phiếu trực tiếp' },
} satisfies DomainDict;
