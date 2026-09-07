/**
 * 外部评价采集（Google / Yelp）的界面文案。
 *
 * 覆盖范围：features/reviews/ReviewSourcesPanel.tsx、pages/Settings.tsx 的
 * 「口碑采集」标签页、pages/Dashboard.tsx 的样本可信度提示。
 * key 一律以 `reviews.` 为前缀，避免跨域重名。
 */
import type { DomainDict } from './types';

export const reviews = {
  // ── 导航与页头 ────────────────────────────────────────────────────────────
  'reviews.navLabel': { 'zh-Hans': '外部口碑采集', en: 'Review Sync', ko: '외부 리뷰 수집', es: 'Sincronización de reseñas', vi: 'Đồng bộ đánh giá' },
  'reviews.title': { 'zh-Hans': 'Google 与 Yelp 评价采集', en: 'Google and Yelp review collection', ko: 'Google·Yelp 리뷰 수집', es: 'Recopilación de reseñas de Google y Yelp', vi: 'Thu thập đánh giá Google và Yelp' },
  'reviews.desc': { 'zh-Hans': '填好门店在各平台的标识之后，系统每天自动抓取新评价、分析情感并生成口碑摘要。', en: 'Once your listings are linked, new reviews are collected daily, analysed for sentiment and summarised for you.', ko: '각 플랫폼의 매장 식별자를 입력하면 매일 새 리뷰를 수집해 감성을 분석하고 요약을 생성합니다.', es: 'Cuando enlaces tus fichas, cada día se recogen las reseñas nuevas, se analiza su sentimiento y se resumen.', vi: 'Sau khi liên kết hồ sơ cửa hàng, hệ thống thu thập đánh giá mới mỗi ngày, phân tích cảm xúc và tạo bản tóm tắt.' },

  // ── 平台配置 ──────────────────────────────────────────────────────────────
  'reviews.googleTitle': { 'zh-Hans': 'Google 门店', en: 'Google listing', ko: 'Google 매장', es: 'Ficha de Google', vi: 'Hồ sơ Google' },
  'reviews.googleDesc': { 'zh-Hans': '两项填其一即可。填了地图链接就用它，否则用 Place ID 自动拼。', en: 'Either field works. The Maps link is used when present; otherwise the Place ID is used.', ko: '둘 중 하나만 입력하면 됩니다. 지도 링크가 있으면 그것을, 없으면 Place ID를 사용합니다.', es: 'Basta con uno de los dos. Se usa el enlace de Maps si está; si no, el Place ID.', vi: 'Chỉ cần một trong hai. Ưu tiên liên kết Maps, nếu trống thì dùng Place ID.' },
  'reviews.mapsUrlLabel': { 'zh-Hans': 'Google 地图链接', en: 'Google Maps link', ko: 'Google 지도 링크', es: 'Enlace de Google Maps', vi: 'Liên kết Google Maps' },
  'reviews.mapsUrlHint': { 'zh-Hans': '在 Google 地图上打开自己的店，点「分享」复制链接粘贴到这里。', en: 'Open your shop in Google Maps, tap Share and paste the link here.', ko: 'Google 지도에서 매장을 열고 공유를 눌러 링크를 붙여 넣으세요.', es: 'Abre tu negocio en Google Maps, pulsa Compartir y pega el enlace aquí.', vi: 'Mở cửa hàng trên Google Maps, nhấn Chia sẻ và dán liên kết vào đây.' },
  'reviews.placeIdLabel': { 'zh-Hans': 'Google Place ID', en: 'Google Place ID', ko: 'Google Place ID', es: 'Google Place ID', vi: 'Google Place ID' },
  'reviews.yelpTitle': { 'zh-Hans': 'Yelp 门店', en: 'Yelp listing', ko: 'Yelp 매장', es: 'Ficha de Yelp', vi: 'Hồ sơ Yelp' },
  'reviews.yelpDesc': { 'zh-Hans': '开店向导用店名和邮编搜到店时会自动填好这一项。', en: 'The setup wizard fills this in when you find your shop by name and ZIP code.', ko: '설치 마법사에서 상호와 우편번호로 매장을 찾으면 자동으로 입력됩니다.', es: 'El asistente de configuración lo rellena al encontrar tu negocio por nombre y código postal.', vi: 'Trình hướng dẫn thiết lập sẽ tự điền khi bạn tìm cửa hàng bằng tên và mã bưu chính.' },
  'reviews.yelpIdLabel': { 'zh-Hans': 'Yelp Business ID', en: 'Yelp Business ID', ko: 'Yelp Business ID', es: 'Yelp Business ID', vi: 'Yelp Business ID' },
  'reviews.yelpIdHint': { 'zh-Hans': 'Yelp 店铺网址里 /biz/ 后面那一段，例如 lucky-nails-boston。', en: 'The part after /biz/ in your Yelp URL, for example lucky-nails-boston.', ko: 'Yelp 주소의 /biz/ 뒤 부분입니다. 예: lucky-nails-boston', es: 'La parte posterior a /biz/ en tu URL de Yelp, por ejemplo lucky-nails-boston.', vi: 'Phần sau /biz/ trong địa chỉ Yelp, ví dụ lucky-nails-boston.' },
  'reviews.ready': { 'zh-Hans': '已配置', en: 'Linked', ko: '연결됨', es: 'Vinculado', vi: 'Đã liên kết' },
  'reviews.notReady': { 'zh-Hans': '未配置', en: 'Not linked', ko: '미연결', es: 'Sin vincular', vi: 'Chưa liên kết' },
  'reviews.save': { 'zh-Hans': '保存采集配置', en: 'Save', ko: '저장', es: 'Guardar', vi: 'Lưu' },
  'reviews.saved': { 'zh-Hans': '采集配置已保存', en: 'Review sources saved', ko: '수집 설정을 저장했습니다', es: 'Fuentes de reseñas guardadas', vi: 'Đã lưu nguồn đánh giá' },
  'reviews.clearHint': { 'zh-Hans': '清空某一项并保存，即可停止抓取该平台。', en: 'Clear a field and save to stop collecting from that platform.', ko: '항목을 비우고 저장하면 해당 플랫폼 수집이 중단됩니다.', es: 'Vacía un campo y guarda para dejar de recopilar de esa plataforma.', vi: 'Xóa trống một mục rồi lưu để ngừng thu thập từ nền tảng đó.' },

  // ── 手动同步 ──────────────────────────────────────────────────────────────
  'reviews.syncTitle': { 'zh-Hans': '立即同步一次', en: 'Sync now', ko: '지금 동기화', es: 'Sincronizar ahora', vi: 'Đồng bộ ngay' },
  'reviews.syncDesc': { 'zh-Hans': '用于配置完成后当场验证一遍：抓到的评价对不对、有没有重复、花了多少。', en: 'Use it right after linking to check what comes back: the reviews, the duplicates and the cost.', ko: '연결 직후 확인용입니다. 어떤 리뷰가 오는지, 중복은 없는지, 비용은 얼마인지 바로 볼 수 있습니다.', es: 'Úsalo tras enlazar para comprobar qué llega: las reseñas, los duplicados y el coste.', vi: 'Dùng ngay sau khi liên kết để kiểm tra: đánh giá lấy về, trùng lặp và chi phí.' },
  'reviews.syncButton': { 'zh-Hans': '同步', en: 'Sync', ko: '동기화', es: 'Sincronizar', vi: 'Đồng bộ' },
  'reviews.syncNotOpen': { 'zh-Hans': '手动同步暂未开放，评价评分仍会自动刷新', en: 'Manual sync is not open yet; ratings still refresh automatically', ko: '수동 동기화는 아직 열리지 않았습니다. 평점은 자동으로 갱신됩니다', es: 'La sincronización manual aún no está disponible; las valoraciones se actualizan solas', vi: 'Đồng bộ thủ công chưa mở; điểm đánh giá vẫn tự động cập nhật' },
  'reviews.syncing': { 'zh-Hans': '正在同步…', en: 'Syncing…', ko: '동기화 중…', es: 'Sincronizando…', vi: 'Đang đồng bộ…' },
  'reviews.syncConfirmTitle': { 'zh-Hans': '这次同步会产生抓取费用', en: 'This sync will incur scraping charges', ko: '이번 동기화에는 수집 비용이 발생합니다', es: 'Esta sincronización tendrá coste de extracción', vi: 'Lần đồng bộ này sẽ phát sinh chi phí thu thập' },
  'reviews.syncConfirmBody': { 'zh-Hans': '抓取按条数计费，抓回的新评价还会送去 AI 分析。日常不需要手动点 —— 定时任务每天会自动跑。', en: 'Scraping is billed per record, and new reviews are also sent for AI analysis. You do not need this day to day: the scheduled job runs on its own.', ko: '수집은 건당 과금되며 새 리뷰는 AI 분석에도 사용됩니다. 평소에는 필요 없습니다. 예약 작업이 매일 자동 실행됩니다.', es: 'La extracción se cobra por registro y las reseñas nuevas también pasan por el análisis de IA. No hace falta a diario: la tarea programada se ejecuta sola.', vi: 'Thu thập tính phí theo bản ghi, và đánh giá mới còn được đưa vào phân tích AI. Bạn không cần thao tác hằng ngày: tác vụ định kỳ tự chạy.' },
  'reviews.syncConfirmAction': { 'zh-Hans': '确认同步', en: 'Sync now', ko: '동기화 실행', es: 'Sincronizar', vi: 'Đồng bộ' },
  'reviews.syncCancel': { 'zh-Hans': '取消', en: 'Cancel', ko: '취소', es: 'Cancelar', vi: 'Hủy' },
  'reviews.syncStillRunning': { 'zh-Hans': '抓取还在进行中，通常几分钟内完成。稍后刷新同步记录即可看到结果。', en: 'The scrape is still running; it usually finishes within a few minutes. Refresh the log later to see the result.', ko: '수집이 진행 중이며 보통 몇 분 내에 끝납니다. 잠시 후 기록을 새로고침하세요.', es: 'La extracción sigue en curso; suele terminar en unos minutos. Actualiza el registro más tarde.', vi: 'Việc thu thập đang chạy, thường xong trong vài phút. Hãy làm mới nhật ký sau ít phút.' },
  'reviews.syncResult': { 'zh-Hans': '抓到 {p0} 条，新增 {p1} 条', en: 'Fetched {p0}, {p1} new', ko: '{p0}건 수집, 신규 {p1}건', es: '{p0} obtenidas, {p1} nuevas', vi: 'Lấy {p0}, mới {p1}' },
  'reviews.syncNothingNew': { 'zh-Hans': '没有新的评价 —— 这是常态，不是故障。', en: 'No new reviews — that is normal, not a failure.', ko: '새 리뷰가 없습니다. 정상이며 오류가 아닙니다.', es: 'Sin reseñas nuevas: es normal, no es un fallo.', vi: 'Không có đánh giá mới — điều này bình thường, không phải lỗi.' },
  'reviews.analysisResult': { 'zh-Hans': 'AI 已分析 {p0} 条评价', en: 'AI analysed {p0} reviews', ko: 'AI가 리뷰 {p0}건을 분석했습니다', es: 'La IA analizó {p0} reseñas', vi: 'AI đã phân tích {p0} đánh giá' },

  // ── 同步记录 ──────────────────────────────────────────────────────────────
  'reviews.logTitle': { 'zh-Hans': '同步记录', en: 'Sync log', ko: '동기화 기록', es: 'Registro de sincronización', vi: 'Nhật ký đồng bộ' },
  'reviews.logDesc': { 'zh-Hans': '抓取失败在口碑页面上只会表现为「最近没有新评价」，和真的没人写评价分不开。这份记录是唯一能分开两者的地方。', en: 'A failed scrape looks exactly like “no new reviews” on the reputation page. This log is the only place the two can be told apart.', ko: '수집 실패는 평판 화면에서 “새 리뷰 없음”과 똑같이 보입니다. 이 기록만이 두 상황을 구분해 줍니다.', es: 'Una extracción fallida se ve igual que «sin reseñas nuevas». Este registro es el único sitio donde se distinguen.', vi: 'Thu thập thất bại trông hệt như “không có đánh giá mới”. Nhật ký này là nơi duy nhất phân biệt được hai điều đó.' },
  'reviews.logEmpty': { 'zh-Hans': '还没有同步记录', en: 'No sync runs yet', ko: '아직 동기화 기록이 없습니다', es: 'Aún no hay sincronizaciones', vi: 'Chưa có lần đồng bộ nào' },
  'reviews.colTime': { 'zh-Hans': '时间', en: 'Time', ko: '시간', es: 'Hora', vi: 'Thời gian' },
  'reviews.colPlatform': { 'zh-Hans': '平台', en: 'Platform', ko: '플랫폼', es: 'Plataforma', vi: 'Nền tảng' },
  'reviews.colStatus': { 'zh-Hans': '状态', en: 'Status', ko: '상태', es: 'Estado', vi: 'Trạng thái' },
  'reviews.colFetched': { 'zh-Hans': '抓到', en: 'Fetched', ko: '수집', es: 'Obtenidas', vi: 'Đã lấy' },
  'reviews.colInserted': { 'zh-Hans': '新增', en: 'New', ko: '신규', es: 'Nuevas', vi: 'Mới' },
  'reviews.colCost': { 'zh-Hans': '费用', en: 'Cost', ko: '비용', es: 'Coste', vi: 'Chi phí' },
  'reviews.statusRunning': { 'zh-Hans': '进行中', en: 'Running', ko: '진행 중', es: 'En curso', vi: 'Đang chạy' },
  'reviews.statusDone': { 'zh-Hans': '已完成', en: 'Done', ko: '완료', es: 'Completada', vi: 'Hoàn tất' },
  'reviews.statusFailed': { 'zh-Hans': '失败', en: 'Failed', ko: '실패', es: 'Fallida', vi: 'Thất bại' },

  // ── 状态说明 ──────────────────────────────────────────────────────────────
  'reviews.stateNotConfigured': { 'zh-Hans': '这个平台还没配标识', en: 'This platform is not linked yet', ko: '이 플랫폼은 아직 연결되지 않았습니다', es: 'Esta plataforma aún no está vinculada', vi: 'Nền tảng này chưa được liên kết' },
  'reviews.stateDisabled': { 'zh-Hans': '抓取服务未启用，请联系客服', en: 'Collection is not enabled — contact support', ko: '수집 기능이 활성화되지 않았습니다. 고객지원에 문의하세요', es: 'La recopilación no está habilitada; contacta con soporte', vi: 'Tính năng thu thập chưa bật, hãy liên hệ hỗ trợ' },
  'reviews.stateThrottled': { 'zh-Hans': '刚刚才同步过，稍后再试', en: 'Synced very recently — try again later', ko: '방금 동기화했습니다. 잠시 후 다시 시도하세요', es: 'Se sincronizó hace muy poco; inténtalo más tarde', vi: 'Vừa đồng bộ xong, hãy thử lại sau' },
  'reviews.stateTimedOut': { 'zh-Hans': '上一次抓取超时，已重置，可以再试一次', en: 'The previous scrape timed out and has been reset — try again', ko: '이전 수집이 시간 초과되어 초기화되었습니다. 다시 시도하세요', es: 'La extracción anterior expiró y se ha restablecido; inténtalo otra vez', vi: 'Lần thu thập trước quá hạn và đã được đặt lại, hãy thử lại' },

  // ── 可信度 ────────────────────────────────────────────────────────────────
  'reviews.lowConfidence': { 'zh-Hans': '样本不完整，仅供参考', en: 'Incomplete sample — treat as indicative', ko: '표본이 불완전합니다. 참고용으로만 보세요', es: 'Muestra incompleta: tómalo como orientativo', vi: 'Mẫu chưa đầy đủ, chỉ mang tính tham khảo' },
  'reviews.lowConfidenceWhy': { 'zh-Hans': '这份结论里有相当比例来自被平台截断的评价正文，或者样本条数太少。', en: 'A large share of these reviews were truncated by the platform, or the sample is simply too small.', ko: '이 결론의 상당 부분이 플랫폼에서 잘린 리뷰이거나 표본 수가 너무 적습니다.', es: 'Buena parte de estas reseñas venían truncadas por la plataforma, o la muestra es demasiado pequeña.', vi: 'Phần lớn đánh giá này bị nền tảng cắt ngắn, hoặc số mẫu quá ít.' },
} satisfies DomainDict;
