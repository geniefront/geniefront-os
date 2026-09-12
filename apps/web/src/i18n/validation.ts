/**
 * 输入格式校验的提示文案。
 *
 * 与 `lib/validation.ts` 的 `reason` 一一对应。文案一律写成**可执行句式**：
 * 告诉用户该怎么填，而不是复述「格式不正确」—— 后者对前台没有任何指导作用。
 *
 * key 以 `valid.` 开头并按「字段类型 + 失败原因」命名，例如
 * `valid.moneyFormat`。逐条显式列出，不得运行期拼接（拼接出的 key 对字典
 * 瘦身脚本不可见，会被当作未引用词条删掉，且删除后没有编译期错误）。
 */
import type { DomainDict } from './types';

export const validation = {
  'valid.moneyEmpty': { 'zh-Hans': '请填写金额', en: 'Enter an amount', ko: '금액을 입력하세요', es: 'Introduce un importe', vi: 'Nhập số tiền' },
  'valid.moneyFormat': { 'zh-Hans': '金额只能填数字，最多两位小数，例如 45 或 45.50', en: 'Amounts take digits only, up to two decimals — for example 45 or 45.50', ko: '금액은 숫자만, 소수점 두 자리까지 입력하세요(예: 45 또는 45.50)', es: 'El importe solo admite dígitos con hasta dos decimales, por ejemplo 45 o 45.50', vi: 'Số tiền chỉ nhận chữ số, tối đa hai số lẻ — ví dụ 45 hoặc 45.50' },
  'valid.moneyNegative': { 'zh-Hans': '金额不能为负数', en: 'The amount cannot be negative', ko: '금액은 음수가 될 수 없습니다', es: 'El importe no puede ser negativo', vi: 'Số tiền không thể là số âm' },
  'valid.moneyTooLarge': { 'zh-Hans': '金额过大，请核对是否多打了一位', en: 'That amount looks too large — check for an extra digit', ko: '금액이 너무 큽니다. 자릿수를 확인해 주세요', es: 'El importe es demasiado alto; comprueba si sobra un dígito', vi: 'Số tiền quá lớn — kiểm tra xem có thừa chữ số không' },

  'valid.durationEmpty': { 'zh-Hans': '请填写服务时长', en: 'Enter a duration', ko: '서비스 시간을 입력하세요', es: 'Introduce una duración', vi: 'Nhập thời lượng' },
  'valid.durationFormat': { 'zh-Hans': '时长请填整数分钟，例如 45', en: 'Enter the duration in whole minutes — for example 45', ko: '시간은 정수 분 단위로 입력하세요(예: 45)', es: 'Indica la duración en minutos enteros, por ejemplo 45', vi: 'Nhập thời lượng theo số phút nguyên — ví dụ 45' },
  'valid.durationRange': { 'zh-Hans': '时长需在 {p0}–{p1} 分钟之间', en: 'Duration must be between {p0} and {p1} minutes', ko: '시간은 {p0}~{p1}분 사이여야 합니다', es: 'La duración debe estar entre {p0} y {p1} minutos', vi: 'Thời lượng phải từ {p0} đến {p1} phút' },

  'valid.emailEmpty': { 'zh-Hans': '请填写邮箱', en: 'Enter an email address', ko: '이메일을 입력하세요', es: 'Introduce un correo electrónico', vi: 'Nhập địa chỉ email' },
  'valid.emailFormat': { 'zh-Hans': '邮箱格式不完整，应形如 name@example.com', en: 'That email looks incomplete — it should read like name@example.com', ko: '이메일 형식이 올바르지 않습니다. name@example.com 형태여야 합니다', es: 'El correo parece incompleto; debe tener la forma name@example.com', vi: 'Email chưa đầy đủ — cần có dạng name@example.com' },

  'valid.pinEmpty': { 'zh-Hans': '请设置快捷 PIN', en: 'Set a quick PIN', ko: '빠른 PIN을 설정하세요', es: 'Establece un PIN rápido', vi: 'Đặt mã PIN nhanh' },
  'valid.pinFormat': { 'zh-Hans': 'PIN 需为 4–6 位数字', en: 'The PIN must be 4–6 digits', ko: 'PIN은 4~6자리 숫자여야 합니다', es: 'El PIN debe tener entre 4 y 6 dígitos', vi: 'Mã PIN phải gồm 4–6 chữ số' },

  'valid.percentEmpty': { 'zh-Hans': '请填写百分比', en: 'Enter a percentage', ko: '비율을 입력하세요', es: 'Introduce un porcentaje', vi: 'Nhập phần trăm' },
  'valid.percentFormat': { 'zh-Hans': '百分比只能填数字，最多两位小数，例如 8.25', en: 'Percentages take digits only, up to two decimals — for example 8.25', ko: '비율은 숫자만, 소수점 두 자리까지 입력하세요(예: 8.25)', es: 'El porcentaje solo admite dígitos con hasta dos decimales, por ejemplo 8.25', vi: 'Phần trăm chỉ nhận chữ số, tối đa hai số lẻ — ví dụ 8.25' },
  'valid.percentRange': { 'zh-Hans': '百分比需在 0–{p0} 之间', en: 'The percentage must be between 0 and {p0}', ko: '비율은 0~{p0} 사이여야 합니다', es: 'El porcentaje debe estar entre 0 y {p0}', vi: 'Phần trăm phải từ 0 đến {p0}' },

  'valid.countEmpty': { 'zh-Hans': '请填写数量', en: 'Enter a quantity', ko: '수량을 입력하세요', es: 'Introduce una cantidad', vi: 'Nhập số lượng' },
  'valid.countFormat': { 'zh-Hans': '数量请填正整数', en: 'Enter the quantity as a whole number', ko: '수량은 양의 정수로 입력하세요', es: 'Indica la cantidad como número entero', vi: 'Nhập số lượng là số nguyên dương' },
  'valid.countRange': { 'zh-Hans': '数量需在 {p0}–{p1} 之间', en: 'Quantity must be between {p0} and {p1}', ko: '수량은 {p0}~{p1} 사이여야 합니다', es: 'La cantidad debe estar entre {p0} y {p1}', vi: 'Số lượng phải từ {p0} đến {p1}' },
} satisfies DomainDict;
