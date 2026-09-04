import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type Locale = 'en' | 'zh-Hans' | 'es' | 'vi' | 'ko';

const DICTIONARIES: Record<string, Record<string, string>> = {
  en: {
    'nav.onlineBooking': 'Online booking',
    'nav.services': 'Services',
    'nav.specialist': 'Specialist',
    'nav.time': 'Date & Time',
    'nav.details': 'Your Details',
    'nav.confirm': 'Confirmation',
    'step.selectService': 'Choose a service',
    'step.selectSpecialist': 'Choose a specialist',
    'step.anySpecialist': 'Any available specialist',
    'step.selectTime': 'Pick a time',
    'step.earlier': 'Earlier',
    'step.later': 'Later',
    'step.confirmDetails': 'Confirm your details',
    'step.yourInfo': 'Enter Your Information',
    'step.addons': 'Add-ons',
    'step.total': 'Total',
    'step.booked': 'You are booked',
    'btn.next': 'Continue',
    'btn.back': 'Back',
    'btn.book': 'Book appointment',
    'btn.change': 'Change',
    'btn.cancel': 'Cancel',
    'btn.reschedule': 'Reschedule',
    'btn.bookAgain': 'Book again',
    'status.confirmed': 'Appointment Confirmed',
    'status.notFound': 'Shop not found',
    'shop.notFoundDesc': 'Open your shop’s hosted booking link to get started.',
  },
  'zh-Hans': {
    'nav.onlineBooking': '在线预约',
    'nav.services': '选择服务',
    'nav.specialist': '选择技师',
    'nav.time': '预约时间',
    'nav.details': '顾客信息',
    'nav.confirm': '确认预约',
    'step.selectService': '选择服务项目',
    'step.selectSpecialist': '选择技师',
    'step.anySpecialist': '任意可约技师',
    'step.selectTime': '选择预约时间',
    'step.earlier': '更早',
    'step.later': '更晚',
    'step.confirmDetails': '确认您的预约信息',
    'step.yourInfo': '请填写您的联系方式',
    'step.addons': '附加项目',
    'step.total': '合计',
    'step.booked': '预约成功',
    'btn.next': '下一步',
    'btn.back': '返回',
    'btn.book': '确认预约',
    'btn.change': '修改',
    'btn.cancel': '取消',
    'btn.reschedule': '改约时间',
    'btn.bookAgain': '再次预约',
    'status.confirmed': '预约已成功确认',
    'status.notFound': '未找到门店',
    'shop.notFoundDesc': '请通过门店提供的在线预约链接访问。',
  },
  es: {
    'nav.onlineBooking': 'Reserva online',
    'nav.services': 'Servicios',
    'nav.specialist': 'Especialista',
    'nav.time': 'Fecha y Hora',
    'nav.details': 'Sus Datos',
    'nav.confirm': 'Confirmación',
    'step.selectService': 'Seleccione un Servicio',
    'step.selectSpecialist': 'Elija un especialista',
    'step.anySpecialist': 'Cualquier especialista disponible',
    'step.selectTime': 'Elija Fecha y Hora',
    'step.earlier': 'Anterior',
    'step.later': 'Posterior',
    'step.confirmDetails': 'Confirme sus datos',
    'step.yourInfo': 'Ingrese sus datos',
    'step.addons': 'Servicios adicionales',
    'step.total': 'Total',
    'step.booked': 'Reserva confirmada',
    'btn.next': 'Continuar',
    'btn.back': 'Volver',
    'btn.book': 'Reservar cita',
    'btn.change': 'Modificar',
    'btn.cancel': 'Cancelar',
    'btn.reschedule': 'Reprogramar',
    'btn.bookAgain': 'Reservar de nuevo',
    'status.confirmed': 'Cita Confirmada',
    'status.notFound': 'Tienda no encontrada',
    'shop.notFoundDesc': 'Abra el enlace de reserva de su tienda para comenzar.',
  },
  vi: {
    'nav.onlineBooking': 'Đặt lịch trực tuyến',
    'nav.services': 'Dịch vụ',
    'nav.specialist': 'Kỹ thuật viên',
    'nav.time': 'Ngày & Giờ',
    'nav.details': 'Thông tin',
    'nav.confirm': 'Xác nhận',
    'step.selectService': 'Chọn dịch vụ',
    'step.selectSpecialist': 'Chọn kỹ thuật viên',
    'step.anySpecialist': 'Bất kỳ kỹ thuật viên nào',
    'step.selectTime': 'Chọn ngày & giờ',
    'step.earlier': 'Trước đó',
    'step.later': 'Sau đó',
    'step.confirmDetails': 'Xác nhận thông tin',
    'step.yourInfo': 'Nhập thông tin của bạn',
    'step.addons': 'Dịch vụ bổ sung',
    'step.total': 'Tổng',
    'step.booked': 'Đặt lịch thành công',
    'btn.next': 'Tiếp tục',
    'btn.back': 'Quay lại',
    'btn.book': 'Đặt lịch hẹn',
    'btn.change': 'Thay đổi',
    'btn.cancel': 'Hủy',
    'btn.reschedule': 'Đổi lịch',
    'btn.bookAgain': 'Đặt lịch lại',
    'status.confirmed': 'Lịch hẹn đã được xác nhận',
    'status.notFound': 'Không tìm thấy cửa hàng',
    'shop.notFoundDesc': 'Mở liên kết đặt lịch của cửa hàng để bắt đầu.',
  },
  ko: {
    'nav.onlineBooking': '온라인 예약',
    'nav.services': '서비스',
    'nav.specialist': '담당자',
    'nav.time': '날짜 및 시간',
    'nav.details': '고객 정보',
    'nav.confirm': '예약 확인',
    'step.selectService': '서비스 선택',
    'step.selectSpecialist': '담당자 선택',
    'step.anySpecialist': '예약 가능한 모든 담당자',
    'step.selectTime': '날짜 및 시간 선택',
    'step.earlier': '이전',
    'step.later': '이후',
    'step.confirmDetails': '예약 정보 확인',
    'step.yourInfo': '고객 정보 입력',
    'step.addons': '추가 서비스',
    'step.total': '합계',
    'step.booked': '예약 완료',
    'btn.next': '계속하기',
    'btn.back': '뒤로',
    'btn.book': '예약 확정',
    'btn.change': '변경',
    'btn.cancel': '취소',
    'btn.reschedule': '일정 변경',
    'btn.bookAgain': '다시 예약',
    'status.confirmed': '예약이 확정되었습니다',
    'status.notFound': '매장을 찾을 수 없습니다',
    'shop.notFoundDesc': '매장의 온라인 예약 링크를 통해 접속해주세요.',
  },
};

interface LanguageContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: string, fallback?: string) => string;
}

const LanguageContext = createContext<LanguageContextValue>({
  locale: 'en',
  setLocale: () => {},
  t: (k, f) => f ?? k,
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [locale, setLocale] = useState<Locale>(() => {
    if (typeof window !== 'undefined') {
      const p = new URLSearchParams(window.location.search);
      const urlLocale = p.get('locale');
      if (urlLocale && urlLocale in DICTIONARIES) return urlLocale as Locale;
      const stored = localStorage.getItem('booking_locale');
      if (stored && stored in DICTIONARIES) return stored as Locale;
      if (navigator.language.startsWith('zh')) return 'zh-Hans';
      if (navigator.language.startsWith('es')) return 'es';
      if (navigator.language.startsWith('vi')) return 'vi';
      if (navigator.language.startsWith('ko')) return 'ko';
    }
    return 'en';
  });

  useEffect(() => {
    localStorage.setItem('booking_locale', locale);
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({
    locale,
    setLocale,
    t: (key: string, fallback?: string) => {
      const dict = DICTIONARIES[locale] || DICTIONARIES['en']!;
      return dict[key] ?? DICTIONARIES['en']![key] ?? fallback ?? key;
    },
  }), [locale]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}
