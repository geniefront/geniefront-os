import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';

export type Locale = 'en' | 'zh-Hans' | 'es' | 'vi' | 'ko';

const DICTIONARIES: Record<string, Record<string, string>> = {
  en: {
    'nav.services': 'Services',
    'nav.time': 'Date & Time',
    'nav.details': 'Your Details',
    'nav.confirm': 'Confirmation',
    'step.selectService': 'Select a Service',
    'step.selectTime': 'Choose Date & Time',
    'step.yourInfo': 'Enter Your Information',
    'btn.next': 'Continue',
    'btn.back': 'Back',
    'btn.book': 'Confirm Booking',
    'btn.change': 'Change',
    'btn.cancel': 'Cancel',
    'status.confirmed': 'Appointment Confirmed',
    'status.notFound': 'Shop not found',
    'shop.notFoundDesc': 'Open your shop’s hosted booking link to get started.',
  },
  'zh-Hans': {
    'nav.services': '选择服务',
    'nav.time': '预约时间',
    'nav.details': '顾客信息',
    'nav.confirm': '确认预约',
    'step.selectService': '请选择服务项目',
    'step.selectTime': '请选择预约日期与时间',
    'step.yourInfo': '请填写您的联系方式',
    'btn.next': '下一步',
    'btn.back': '返回',
    'btn.book': '确认预约',
    'btn.change': '修改',
    'btn.cancel': '取消',
    'status.confirmed': '预约已成功确认',
    'status.notFound': '未找到门店',
    'shop.notFoundDesc': '请通过门店提供的在线预约链接访问。',
  },
  es: {
    'nav.services': 'Servicios',
    'nav.time': 'Fecha y Hora',
    'nav.details': 'Sus Datos',
    'nav.confirm': 'Confirmación',
    'step.selectService': 'Seleccione un Servicio',
    'step.selectTime': 'Elija Fecha y Hora',
    'step.yourInfo': 'Ingrese sus datos',
    'btn.next': 'Continuar',
    'btn.back': 'Volver',
    'btn.book': 'Confirmar Reserva',
    'btn.change': 'Modificar',
    'btn.cancel': 'Cancelar',
    'status.confirmed': 'Cita Confirmada',
    'status.notFound': 'Tienda no encontrada',
    'shop.notFoundDesc': 'Abra el enlace de reserva de su tienda para comenzar.',
  },
  vi: {
    'nav.services': 'Dịch vụ',
    'nav.time': 'Ngày & Giờ',
    'nav.details': 'Thông tin',
    'nav.confirm': 'Xác nhận',
    'step.selectService': 'Chọn dịch vụ',
    'step.selectTime': 'Chọn ngày & giờ',
    'step.yourInfo': 'Nhập thông tin của bạn',
    'btn.next': 'Tiếp tục',
    'btn.back': 'Quay lại',
    'btn.book': 'Xác nhận đặt hẹn',
    'btn.change': 'Thay đổi',
    'btn.cancel': 'Hủy',
    'status.confirmed': 'Lịch hẹn đã được xác nhận',
    'status.notFound': 'Không tìm thấy cửa hàng',
    'shop.notFoundDesc': 'Mở liên kết đặt lịch của cửa hàng để bắt đầu.',
  },
  ko: {
    'nav.services': '서비스',
    'nav.time': '날짜 및 시간',
    'nav.details': '고객 정보',
    'nav.confirm': '예약 확인',
    'step.selectService': '서비스 선택',
    'step.selectTime': '날짜 및 시간 선택',
    'step.yourInfo': '고객 정보 입력',
    'btn.next': '계속하기',
    'btn.back': '뒤로',
    'btn.book': '예약 확정',
    'btn.change': '변경',
    'btn.cancel': '취소',
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
