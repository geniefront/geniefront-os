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
  'bundle.navLabel': { 'zh-Hans': '组合套餐', en: 'Bundles', ko: '묶음 상품', es: 'Paquetes combinados', vi: 'Gói kết hợp' },
  'bundle.tabTitle': { 'zh-Hans': '组合套餐', en: 'Service bundles', ko: '서비스 묶음', es: 'Paquetes de servicios', vi: 'Gói dịch vụ' },
  'bundle.tabDesc': { 'zh-Hans': '几个项目一起买走固定组合价，开单时自动展开成实际子项。与按次核销的次卡不同。', en: 'Several services bought together at one fixed price, expanded into their real sub-items at checkout. Different from a punch-card package.', ko: '여러 서비스를 하나의 고정 가격으로 함께 판매하고, 계산 시 실제 하위 항목으로 펼칩니다. 횟수 차감식 회수권과 다릅니다.', es: 'Varios servicios comprados juntos a un precio fijo, que se despliegan en sus subelementos reales al cobrar. Distinto de un bono por sesiones.', vi: 'Nhiều dịch vụ mua chung với một giá cố định, được tách thành các mục con thực tế khi thanh toán. Khác với thẻ trừ buổi.' },
  'bundle.vsPackageHint': { 'zh-Hans': '提示：「组合套餐」是一次做完的固定组合；「次卡」是买了之后按次核销。选错类型会影响履约和账务。', en: 'Note: a bundle is a fixed combination done in one visit; a package is redeemed session by session. The wrong type affects fulfilment and accounting.', ko: '참고: 묶음 상품은 한 번 방문에 완료하는 고정 조합이고, 회수권은 방문마다 차감합니다. 유형을 잘못 고르면 이행과 회계에 영향을 줍니다.', es: 'Nota: un paquete combinado es una combinación fija realizada en una visita; un bono se canjea sesión a sesión. Elegir mal el tipo afecta la ejecución y la contabilidad.', vi: 'Lưu ý: gói kết hợp là tổ hợp cố định làm trong một lần; thẻ buổi được trừ theo từng buổi. Chọn sai loại sẽ ảnh hưởng đến thực hiện và kế toán.' },

  // ── 目录列表 ──────────────────────────────────────────────────────────────
  'bundle.newButton': { 'zh-Hans': '新建组合套餐', en: 'New bundle', ko: '새 묶음 상품', es: 'Nuevo paquete', vi: 'Gói mới' },
  'bundle.empty': { 'zh-Hans': '还没有组合套餐。点「新建组合套餐」把常一起做的几个项目打包成一个优惠价。', en: 'No bundles yet. Use “New bundle” to package services that are often done together at one price.', ko: '아직 묶음 상품이 없습니다. “새 묶음 상품”으로 함께 자주 하는 서비스를 하나의 가격으로 묶으세요.', es: 'Aún no hay paquetes. Usa «Nuevo paquete» para agrupar servicios que suelen hacerse juntos a un solo precio.', vi: 'Chưa có gói nào. Dùng “Gói mới” để gộp các dịch vụ thường làm cùng nhau vào một mức giá.' },
  'bundle.colName': { 'zh-Hans': '名称', en: 'Name', ko: '이름', es: 'Nombre', vi: 'Tên' },
  'bundle.colItems': { 'zh-Hans': '组成', en: 'Items', ko: '구성', es: 'Elementos', vi: 'Thành phần' },
  'bundle.colOriginal': { 'zh-Hans': '原价合计', en: 'List total', ko: '정가 합계', es: 'Total de lista', vi: 'Tổng giá gốc' },
  'bundle.colPrice': { 'zh-Hans': '组合价', en: 'Bundle price', ko: '묶음 가격', es: 'Precio del paquete', vi: 'Giá gói' },
  'bundle.colDiscount': { 'zh-Hans': '优惠', en: 'Savings', ko: '할인', es: 'Ahorro', vi: 'Tiết kiệm' },
  'bundle.colStatus': { 'zh-Hans': '状态', en: 'Status', ko: '상태', es: 'Estado', vi: 'Trạng thái' },
  'bundle.statusActive': { 'zh-Hans': '在售', en: 'Active', ko: '판매 중', es: 'Activo', vi: 'Đang bán' },
  'bundle.statusArchived': { 'zh-Hans': '已下架', en: 'Archived', ko: '내림', es: 'Archivado', vi: 'Đã lưu trữ' },
  'bundle.statusOnline': { 'zh-Hans': '可在线预约', en: 'Online bookable', ko: '온라인 예약 가능', es: 'Reservable en línea', vi: 'Đặt trực tuyến' },
  'bundle.needsFix': { 'zh-Hans': '需修复：有子项目已停用', en: 'Needs fixing: a sub-service is inactive', ko: '수정 필요: 하위 서비스가 비활성', es: 'Requiere corrección: un subservicio está inactivo', vi: 'Cần sửa: một dịch vụ con đã ngừng' },
  'bundle.instanceCount': { 'zh-Hans': '已售 {count} 份', en: '{count} sold', ko: '{count}건 판매', es: '{count} vendidos', vi: 'Đã bán {count}' },

  // ── 编辑器 ───────────────────────────────────────────────────────────────
  'bundle.editorNewTitle': { 'zh-Hans': '新建组合套餐', en: 'New bundle', ko: '새 묶음 상품', es: 'Nuevo paquete', vi: 'Gói mới' },
  'bundle.editorEditTitle': { 'zh-Hans': '编辑组合套餐', en: 'Edit bundle', ko: '묶음 상품 편집', es: 'Editar paquete', vi: 'Sửa gói' },
  'bundle.fieldName': { 'zh-Hans': '套餐名称', en: 'Bundle name', ko: '묶음 이름', es: 'Nombre del paquete', vi: 'Tên gói' },
  'bundle.fieldNamePlaceholder': { 'zh-Hans': '例如：手足护理套餐', en: 'e.g. Mani + Pedi combo', ko: '예: 손발 관리 세트', es: 'p. ej. Combo manos y pies', vi: 'vd: Combo tay + chân' },
  'bundle.fieldDescription': { 'zh-Hans': '描述（可选）', en: 'Description (optional)', ko: '설명(선택)', es: 'Descripción (opcional)', vi: 'Mô tả (tùy chọn)' },
  'bundle.fieldComponents': { 'zh-Hans': '包含的项目', en: 'Services included', ko: '포함 서비스', es: 'Servicios incluidos', vi: 'Dịch vụ bao gồm' },
  'bundle.addComponent': { 'zh-Hans': '添加项目', en: 'Add a service', ko: '서비스 추가', es: 'Añadir servicio', vi: 'Thêm dịch vụ' },
  'bundle.componentQty': { 'zh-Hans': '份数', en: 'Qty', ko: '수량', es: 'Cant.', vi: 'SL' },
  'bundle.componentRemove': { 'zh-Hans': '移除', en: 'Remove', ko: '제거', es: 'Quitar', vi: 'Xóa' },
  'bundle.fieldPrice': { 'zh-Hans': '组合价', en: 'Bundle price', ko: '묶음 가격', es: 'Precio del paquete', vi: 'Giá gói' },
  'bundle.priceHelpOriginal': { 'zh-Hans': '原价合计 {amount}', en: 'List total {amount}', ko: '정가 합계 {amount}', es: 'Total de lista {amount}', vi: 'Tổng giá gốc {amount}' },
  'bundle.priceHelpSavings': { 'zh-Hans': '顾客省 {amount}', en: 'Customer saves {amount}', ko: '고객 절약 {amount}', es: 'El cliente ahorra {amount}', vi: 'Khách tiết kiệm {amount}' },
  'bundle.fieldOnlineBookable': { 'zh-Hans': '允许在线预约', en: 'Allow online booking', ko: '온라인 예약 허용', es: 'Permitir reserva en línea', vi: 'Cho phép đặt trực tuyến' },
  'bundle.fieldOnlineBookableHint': { 'zh-Hans': '打开后，这个套餐会出现在门店官网的预约页。', en: 'When on, this bundle appears on your online booking page.', ko: '켜면 이 묶음 상품이 온라인 예약 페이지에 표시됩니다.', es: 'Si está activo, este paquete aparece en tu página de reservas en línea.', vi: 'Khi bật, gói này xuất hiện trên trang đặt lịch trực tuyến.' },
  'bundle.save': { 'zh-Hans': '保存', en: 'Save', ko: '저장', es: 'Guardar', vi: 'Lưu' },
  'bundle.saved': { 'zh-Hans': '组合套餐已保存', en: 'Bundle saved', ko: '묶음 상품을 저장했습니다', es: 'Paquete guardado', vi: 'Đã lưu gói' },
  'bundle.duplicate': { 'zh-Hans': '复制一份', en: 'Duplicate', ko: '복제', es: 'Duplicar', vi: 'Nhân bản' },
  'bundle.archive': { 'zh-Hans': '下架', en: 'Archive', ko: '내리기', es: 'Archivar', vi: 'Lưu trữ' },
  'bundle.archived': { 'zh-Hans': '组合套餐已下架', en: 'Bundle archived', ko: '묶음 상품을 내렸습니다', es: 'Paquete archivado', vi: 'Đã lưu trữ gói' },
  'bundle.archiveConfirmTitle': { 'zh-Hans': '下架这个组合套餐？', en: 'Archive this bundle?', ko: '이 묶음 상품을 내릴까요?', es: '¿Archivar este paquete?', vi: 'Lưu trữ gói này?' },
  'bundle.archiveConfirmBody': { 'zh-Hans': '下架后不能再新开这个套餐的单。已经卖出的订单不受影响 —— 名称和价格在下单时已经记下。', en: 'Once archived it can no longer be sold. Orders already placed are unaffected — the name and price were captured at the time.', ko: '내린 뒤에는 신규 판매가 불가합니다. 이미 접수된 주문은 영향받지 않습니다 — 이름과 가격은 주문 시점에 기록되었습니다.', es: 'Tras archivarlo ya no se puede vender. Los pedidos ya realizados no se ven afectados: el nombre y el precio quedaron registrados en su momento.', vi: 'Sau khi lưu trữ sẽ không bán được nữa. Các đơn đã tạo không bị ảnh hưởng — tên và giá đã được ghi lại tại thời điểm đó.' },

  // ── 校验 / 错误 ───────────────────────────────────────────────────────────
  'bundle.errNameRequired': { 'zh-Hans': '请填写套餐名称', en: 'Enter a bundle name', ko: '묶음 이름을 입력하세요', es: 'Escribe un nombre de paquete', vi: 'Nhập tên gói' },
  'bundle.errTwoUnits': { 'zh-Hans': '组合套餐至少要包含两个执行单元（可以是不同项目，或同一项目两份）', en: 'A bundle needs at least two execution units (different services, or the same service twice)', ko: '묶음 상품에는 실행 단위가 최소 2개 필요합니다(다른 서비스 또는 같은 서비스 2개)', es: 'Un paquete necesita al menos dos unidades de ejecución (servicios distintos o el mismo servicio dos veces)', vi: 'Gói cần ít nhất hai đơn vị thực hiện (dịch vụ khác nhau, hoặc cùng một dịch vụ hai lần)' },
  'bundle.errPriceAboveList': { 'zh-Hans': '组合价不能高于原价合计', en: 'The bundle price cannot exceed the list total', ko: '묶음 가격은 정가 합계를 넘을 수 없습니다', es: 'El precio del paquete no puede superar el total de lista', vi: 'Giá gói không được vượt tổng giá gốc' },
  'bundle.errVersionConflict': { 'zh-Hans': '这个套餐刚被别人改过，请刷新后重试', en: 'Someone just changed this bundle — refresh and try again', ko: '다른 사용자가 방금 이 묶음 상품을 변경했습니다. 새로고침 후 다시 시도하세요', es: 'Alguien acaba de cambiar este paquete: actualiza e inténtalo de nuevo', vi: 'Ai đó vừa thay đổi gói này — làm mới và thử lại' },
  'bundle.errInactiveService': { 'zh-Hans': '有子项目已停用，请先在「项目」里恢复或替换', en: 'A sub-service is inactive — restore or replace it under Services first', ko: '하위 서비스가 비활성입니다 — 먼저 서비스에서 복원하거나 교체하세요', es: 'Un subservicio está inactivo: restáuralo o reemplázalo en Servicios primero', vi: 'Một dịch vụ con đã ngừng — hãy khôi phục hoặc thay thế trong mục Dịch vụ trước' },

  // ── 结账 / 工单里的套餐明细 ───────────────────────────────────────────────
  'bundle.checkoutGroupLabel': { 'zh-Hans': '组合套餐', en: 'Bundle', ko: '묶음', es: 'Paquete', vi: 'Gói' },
  'bundle.checkoutListPrice': { 'zh-Hans': '原价', en: 'List price', ko: '정가', es: 'Precio de lista', vi: 'Giá gốc' },
  'bundle.checkoutBundleSaving': { 'zh-Hans': '套餐优惠', en: 'Bundle savings', ko: '묶음 할인', es: 'Ahorro del paquete', vi: 'Ưu đãi gói' },
  'bundle.checkoutBundlePrice': { 'zh-Hans': '套餐价', en: 'Bundle price', ko: '묶음 가격', es: 'Precio del paquete', vi: 'Giá gói' },
  'bundle.checkoutExtraAddon': { 'zh-Hans': '额外加项', en: 'Extra add-on', ko: '추가 옵션', es: 'Complemento extra', vi: 'Tùy chọn thêm' },
  'bundle.checkoutSubItem': { 'zh-Hans': '子项', en: 'Sub-item', ko: '하위 항목', es: 'Subelemento', vi: 'Mục con' },

  // ── 拆单为单项（B14）─────────────────────────────────────────────────────
  'bundle.split': { 'zh-Hans': '拆成单项', en: 'Split into items', ko: '개별 항목으로 분리', es: 'Separar en elementos', vi: 'Tách thành từng mục' },
  'bundle.splitConfirmTitle': { 'zh-Hans': '把这份组合套餐拆成单独的项目？', en: 'Split this bundle into separate services?', ko: '이 묶음을 개별 서비스로 분리할까요?', es: '¿Separar este paquete en servicios sueltos?', vi: 'Tách gói này thành các dịch vụ riêng?' },
  'bundle.splitConfirmBody': { 'zh-Hans': '拆开后各项目按下单时锁定的单项原价计费，不再享受套餐价。仅在未开工、未付款时可拆。', en: 'After splitting, each service is charged at the single-item price locked when the order was placed — the bundle price no longer applies. Only possible before work starts and before payment.', ko: '분리 후 각 서비스는 주문 시 고정된 개별 가격으로 청구되며 묶음 가격이 더는 적용되지 않습니다. 작업 시작 전·결제 전에만 가능합니다.', es: 'Tras separarlo, cada servicio se cobra al precio individual fijado al hacer el pedido; el precio del paquete deja de aplicarse. Solo es posible antes de empezar y antes del pago.', vi: 'Sau khi tách, mỗi dịch vụ tính theo giá lẻ đã khóa khi tạo đơn — không còn giá gói. Chỉ thực hiện được trước khi bắt đầu và trước khi thanh toán.' },
  'bundle.splitDone': { 'zh-Hans': '已拆成单项', en: 'Split into items', ko: '개별 항목으로 분리했습니다', es: 'Separado en elementos', vi: 'Đã tách thành từng mục' },
  'bundle.splitUnsupportedExtras': { 'zh-Hans': '这份套餐带了额外加项或额外优惠，暂不能直接拆 —— 请作废后重新开单', en: 'This bundle has extra add-ons or an extra discount and cannot be split directly — void and re-open the ticket instead', ko: '이 묶음에는 추가 옵션이나 추가 할인이 있어 바로 분리할 수 없습니다 — 취소 후 다시 접수하세요', es: 'Este paquete tiene complementos o un descuento extra y no puede separarse directamente: anúlalo y vuelve a abrir el ticket', vi: 'Gói này có tùy chọn thêm hoặc ưu đãi thêm nên không thể tách trực tiếp — hãy hủy và mở lại phiếu' },

  // ── 看板卡片 ─────────────────────────────────────────────────────────────
  'bundle.cardBadge': { 'zh-Hans': '套餐', en: 'Bundle', ko: '묶음', es: 'Paquete', vi: 'Gói' },
  'bundle.cardProgress': { 'zh-Hans': '{done}/{total} 项已完成', en: '{done}/{total} done', ko: '{done}/{total} 완료', es: '{done}/{total} hechos', vi: '{done}/{total} xong' },
  'bundle.cardFulfilled': { 'zh-Hans': '套餐已完成', en: 'Bundle complete', ko: '묶음 완료', es: 'Paquete completo', vi: 'Gói hoàn tất' },

  // ── 在线预约（apps/booking）─────────────────────────────────────────────
  'bundle.bookingSectionTitle': { 'zh-Hans': '套餐', en: 'Bundles', ko: '묶음 상품', es: 'Paquetes', vi: 'Gói' },
  'bundle.bookingIncludes': { 'zh-Hans': '包含', en: 'Includes', ko: '포함', es: 'Incluye', vi: 'Bao gồm' },
  'bundle.bookingOriginal': { 'zh-Hans': '原价 {amount}', en: 'List {amount}', ko: '정가 {amount}', es: 'Lista {amount}', vi: 'Giá gốc {amount}' },
  'bundle.bookingSelect': { 'zh-Hans': '选这个套餐', en: 'Choose this bundle', ko: '이 묶음 선택', es: 'Elegir este paquete', vi: 'Chọn gói này' },
  'bundle.bookingSelected': { 'zh-Hans': '已选套餐', en: 'Bundle selected', ko: '묶음 선택됨', es: 'Paquete elegido', vi: 'Đã chọn gói' },

  // ── 导入分流（ImportWorkspace）─────────────────────────────────────────
  'bundle.importKindBundle': { 'zh-Hans': '组合套餐', en: 'Bundle', ko: '묶음 상품', es: 'Paquete combinado', vi: 'Gói kết hợp' },
  'bundle.importKindPackage': { 'zh-Hans': '次卡', en: 'Package', ko: '회수권', es: 'Bono', vi: 'Thẻ buổi' },
  'bundle.importKindAmbiguous': { 'zh-Hans': '待确认类型', en: 'Type unclear', ko: '유형 미확정', es: 'Tipo por confirmar', vi: 'Chưa rõ loại' },
  'bundle.importPickKind': { 'zh-Hans': '这是组合套餐还是次卡？', en: 'Is this a bundle or a package?', ko: '묶음 상품인가요, 회수권인가요?', es: '¿Es un paquete combinado o un bono?', vi: 'Đây là gói kết hợp hay thẻ buổi?' },
  'bundle.importUnresolved': { 'zh-Hans': '有组成项目未匹配到现有项目，请选择或新建', en: 'Some component services are unmatched — pick an existing one or create it', ko: '일부 구성 서비스가 매칭되지 않았습니다 — 기존 항목을 고르거나 새로 만드세요', es: 'Algunos servicios del combo no coinciden: elige uno existente o créalo', vi: 'Một số dịch vụ thành phần chưa khớp — hãy chọn dịch vụ có sẵn hoặc tạo mới' },
} satisfies DomainDict;
