import type { OwnerLocale } from './locale';
import { renderTemplatedEmailHtml } from './layout';
import type { Rendered, TrialEndingData, PaymentFailedData, SubscriptionCanceledData, LicenseExpiringData } from './render';

type BillingCopy = {
  trial:string; charge:string; plan:string; automatic:string; cancelTrial:string; manage:string;
  failed:string; amount:string; retry:string; finalAttempt:string; update:string; readOnly:string;
  cancelled:string; periodEnd:string; until:string; ended:string; kept:string; restore:string;
  expiring:string; expired:string; remaining:string; expiredBody:string; extend:string;
};
const copy: Record<Exclude<OwnerLocale,'en'|'zh-Hans'>, BillingCopy> = {
  'zh-Hant': {
    trial:'免費試用還有 3 天',charge:'首次扣款',plan:'方案',automatic:'無需任何操作，到期將自動續訂。',cancelTrial:'取消後試用期仍可使用至最後一天，不會產生額外費用。',manage:'管理訂閱',
    failed:'訂閱扣款失敗，請更新付款方式',amount:'金額',retry:'系統將於 {date} 自動重試一次。',finalAttempt:'本次為最後一次嘗試，需要您手動處理。',update:'更新付款方式',readOnly:'在扣款成功之前，本門店僅可查看資料，無法開單，也無法修改預約。',
    cancelled:'訂閱已取消',periodEnd:'目前計費週期結束時',until:'目前計費週期結束（{date}）之前一切照常，之後本門店轉為唯讀狀態。',ended:'訂閱已於 {date} 終止，本門店目前為唯讀狀態。',kept:'資料不會被刪除，您可以隨時恢復訂閱。',restore:'恢復訂閱',
    expiring:'服務將於 {date} 到期',expired:'服務已到期',remaining:'您的服務有效期至 {date}（還剩 {days} 天）。到期後門店轉為唯讀：仍可查看資料、匯出報表，但無法開新單。',expiredBody:'您的服務已於 {date} 到期，門店目前為唯讀狀態。資料不會被刪除，續期後立即恢復。',extend:'需要續期請聯絡 GenieFront 客服，我們會為您延長有效期。',
  },
  ko: {
    trial:'무료 체험 종료까지 3일 남았습니다',charge:'첫 결제일',plan:'요금제',automatic:'별도 조치 없이 구독이 자동으로 갱신됩니다.',cancelTrial:'취소해도 체험 마지막 날까지 이용할 수 있으며 추가 요금은 없습니다.',manage:'구독 관리',
    failed:'구독 결제 실패 — 결제 수단을 업데이트해 주세요',amount:'금액',retry:'{date}에 자동으로 다시 결제합니다.',finalAttempt:'마지막 결제 시도였습니다. 계속 이용하려면 결제 수단을 업데이트해 주세요.',update:'결제 수단 업데이트',readOnly:'결제가 완료될 때까지 매장은 읽기 전용입니다. 새 주문 생성과 예약 변경은 불가능합니다.',
    cancelled:'구독이 취소되었습니다',periodEnd:'현재 결제 주기 종료 시점',until:'현재 결제 주기가 끝나는 {date}까지 정상 이용할 수 있으며, 이후에는 읽기 전용으로 전환됩니다.',ended:'구독이 {date}에 종료되어 현재 매장은 읽기 전용입니다.',kept:'데이터는 보존되며 언제든 다시 구독할 수 있습니다.',restore:'다시 구독',
    expiring:'서비스가 {date}에 만료됩니다',expired:'서비스가 만료되었습니다',remaining:'서비스는 {date}까지 유효합니다({days}일 남음). 이후에는 읽기 전용으로 전환됩니다. 데이터 조회와 내보내기는 가능하지만 새 주문은 생성할 수 없습니다.',expiredBody:'서비스가 {date}에 만료되어 현재 읽기 전용입니다. 데이터는 보존되며 갱신 즉시 이용이 재개됩니다.',extend:'이용 기간을 연장하려면 GenieFront 고객 지원에 문의하세요.',
  },
  vi: {
    trial:'Còn 3 ngày dùng thử miễn phí',charge:'Ngày thanh toán đầu tiên',plan:'Gói dịch vụ',automatic:'Không cần thao tác — đăng ký sẽ tự động gia hạn.',cancelTrial:'Nếu hủy, bạn vẫn dùng được đến ngày cuối kỳ thử mà không mất thêm phí.',manage:'Quản lý đăng ký',
    failed:'Thanh toán đăng ký thất bại — hãy cập nhật phương thức thanh toán',amount:'Số tiền',retry:'Hệ thống sẽ tự động thử lại vào {date}.',finalAttempt:'Đây là lần thử cuối. Vui lòng cập nhật phương thức thanh toán để tiếp tục.',update:'Cập nhật phương thức thanh toán',readOnly:'Cho đến khi thanh toán thành công, tiệm chỉ có thể xem dữ liệu, không thể tạo phiếu mới hoặc thay đổi lịch hẹn.',
    cancelled:'Đã hủy đăng ký',periodEnd:'cuối chu kỳ thanh toán hiện tại',until:'Dịch vụ vẫn hoạt động đến hết chu kỳ hiện tại ({date}), sau đó tiệm chuyển sang chế độ chỉ xem.',ended:'Đăng ký đã kết thúc vào {date}; tiệm hiện ở chế độ chỉ xem.',kept:'Dữ liệu được giữ lại. Bạn có thể đăng ký lại bất cứ lúc nào.',restore:'Đăng ký lại',
    expiring:'Dịch vụ hết hạn vào {date}',expired:'Dịch vụ đã hết hạn',remaining:'Dịch vụ có hiệu lực đến {date} (còn {days} ngày). Sau đó tiệm chỉ có thể xem và xuất dữ liệu, không thể tạo phiếu mới.',expiredBody:'Dịch vụ đã hết hạn vào {date}; tiệm hiện ở chế độ chỉ xem. Dữ liệu được giữ lại và dịch vụ được khôi phục ngay khi gia hạn.',extend:'Để gia hạn, vui lòng liên hệ bộ phận hỗ trợ GenieFront.',
  },
  es: {
    trial:'Quedan 3 días de prueba gratuita',charge:'Fecha del primer cobro',plan:'Plan',automatic:'No necesita hacer nada: su suscripción continuará automáticamente.',cancelTrial:'Si cancela, podrá usar la prueba hasta el último día sin cargos adicionales.',manage:'Gestionar suscripción',
    failed:'El pago de la suscripción falló — actualice su método de pago',amount:'Importe',retry:'Volveremos a intentar el cobro automáticamente el {date}.',finalAttempt:'Este fue el último intento. Actualice su método de pago para continuar.',update:'Actualizar método de pago',readOnly:'Hasta que se complete el pago, el salón estará en modo de solo lectura: no se podrán crear nuevas órdenes ni modificar citas.',
    cancelled:'Suscripción cancelada',periodEnd:'el final del período de facturación actual',until:'Todo seguirá funcionando hasta el final del período actual ({date}); después, el salón pasará a modo de solo lectura.',ended:'La suscripción terminó el {date}; el salón está en modo de solo lectura.',kept:'Sus datos se conservan. Puede volver a suscribirse en cualquier momento.',restore:'Volver a suscribirse',
    expiring:'El servicio vence el {date}',expired:'El servicio ha vencido',remaining:'Su servicio está activo hasta el {date} (quedan {days} días). Después, podrá consultar y exportar datos, pero no crear nuevas órdenes.',expiredBody:'Su servicio venció el {date} y el salón está en modo de solo lectura. Sus datos se conservan y el servicio se restablece al renovar.',extend:'Para renovar, contacte con el equipo de soporte de GenieFront.',
  },
};
const fill = (s:string,date:string,days=0) => s.replaceAll('{date}',date).replaceAll('{days}',String(days));
function message(locale:OwnerLocale, shop:string,title:string, paragraphs:string[], action?:{url:string;label:string}):Rendered {
  const subject = `${shop}: ${title}`;
  const text = [subject,...paragraphs,...(action?[`${action.label}: ${action.url}`]:[])].join('\n\n');
  return {subject,text,html:renderTemplatedEmailHtml(text,action,{locale,variant:'owner'})};
}
export function localizedTrial(d:TrialEndingData):Rendered|null {
  if(d.locale==='en'||d.locale==='zh-Hans')return null;
  const c=copy[d.locale];
  return message(d.locale,d.shopName,c.trial,[`${c.charge}: ${d.chargeDateText}`,`${c.plan}: ${d.planLabel}, ${d.monthlyText}`,c.automatic,c.cancelTrial],{url:d.billingUrl,label:c.manage});
}
export function localizedPayment(d:PaymentFailedData):Rendered|null {
  if(d.locale==='en'||d.locale==='zh-Hans')return null;
  const c=copy[d.locale];
  return message(d.locale,d.shopName,c.failed,[`${c.amount}: ${d.amountText}`,d.nextAttemptText?fill(c.retry,d.nextAttemptText):c.finalAttempt,c.readOnly],{url:d.billingUrl,label:c.update});
}
export function localizedCancellation(d:SubscriptionCanceledData):Rendered|null {
  if(d.locale==='en'||d.locale==='zh-Hans')return null;
  const c=copy[d.locale];
  return message(d.locale,d.shopName,c.cancelled,[fill(d.atPeriodEnd?c.until:c.ended,d.endsAtText??c.periodEnd),c.kept],{url:d.billingUrl,label:c.restore});
}
export function localizedLicense(d:LicenseExpiringData):Rendered|null {
  if(d.locale==='en'||d.locale==='zh-Hans')return null;
  const c=copy[d.locale];
  return message(d.locale,d.shopName,fill(d.daysLeft>0?c.expiring:c.expired,d.endsAtText),[fill(d.daysLeft>0?c.remaining:c.expiredBody,d.endsAtText,d.daysLeft),c.extend]);
}
export function trialLastDay(locale:OwnerLocale):string {
  return {en:'the last day of your trial','zh-Hans':'试用结束当天','zh-Hant':'試用結束當天',ko:'무료 체험 마지막 날',vi:'ngày cuối kỳ dùng thử',es:'el último día de su prueba'}[locale];
}
export function monthlyPrice(locale:OwnerLocale,usd:number):string {
  return {en:`$${usd}/month`,'zh-Hans':`每月 $${usd}`,'zh-Hant':`每月 $${usd}`,ko:`월 $${usd}`,vi:`$${usd}/tháng`,es:`$${usd}/mes`}[locale];
}
