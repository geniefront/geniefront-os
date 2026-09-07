/**
 * 服务端错误的可读呈现。
 *
 * ⚠️ **不得直接展示 `err.message`。** `ApiError` 的 `message` 即服务端返回的
 * 错误码本身（如 `STAFF_OVER_CAPACITY`），直接 toast 出去等同于让前台
 * 面对一个无法理解的大写标识符，其结果通常是致电技术支持。
 */
import { useCallback } from 'react';
import { ERROR_CODES } from '@gf/contracts';
import type { ErrorCode } from '@gf/contracts';
import { useLanguage } from '@/LanguageContext';
import type { TranslationKey } from '@/i18n';
import { ApiError } from './api';

/**
 * 错误码到文案 key 的映射。
 *
 * ⚠️ **必须逐条显式列出，不得写成 `` t(`error${code}`) `` 这类运行期拼接。**
 * 拼接出来的 key 对静态分析不可见：字典瘦身脚本会把这些词条判定为「未引用」
 * 并删除，而删除后没有任何编译期错误，故障要到门店真的触发该错误时才暴露。
 *
 * 此处的 `Record<ErrorCode, TranslationKey>` 同时提供两重保障 ——
 * 服务端新增错误码时缺少映射是类型错误，映射到不存在的词条同样是类型错误。
 */
const ERROR_MESSAGE_KEYS: Record<ErrorCode, TranslationKey> = {
  [ERROR_CODES.UNAUTHENTICATED]: 'errorUNAUTHENTICATED',
  [ERROR_CODES.PERMISSION_DENIED]: 'errorPERMISSION_DENIED',
  [ERROR_CODES.MEMBERSHIP_INACTIVE]: 'errorMEMBERSHIP_INACTIVE',
  [ERROR_CODES.LOCATION_SUSPENDED]: 'errorLOCATION_SUSPENDED',
  [ERROR_CODES.SUBSCRIPTION_PAST_DUE]: 'errorSUBSCRIPTION_PAST_DUE',
  [ERROR_CODES.AI_QUOTA_EXHAUSTED]: 'errorAI_QUOTA_EXHAUSTED',
  [ERROR_CODES.AI_RATE_LIMITED]: 'errorAI_RATE_LIMITED',
  [ERROR_CODES.VALIDATION_FAILED]: 'errorVALIDATION_FAILED',
  [ERROR_CODES.NOT_FOUND]: 'errorNOT_FOUND',
  [ERROR_CODES.IDEMPOTENCY_KEY_REUSED]: 'errorIDEMPOTENCY_KEY_REUSED',
  [ERROR_CODES.RESOURCE_CONFLICT]: 'errorRESOURCE_CONFLICT',
  [ERROR_CODES.STAFF_OVER_CAPACITY]: 'errorSTAFF_OVER_CAPACITY',
  [ERROR_CODES.LOCATION_OVER_CAPACITY]: 'errorLOCATION_OVER_CAPACITY',
  [ERROR_CODES.STAFF_LACKS_SKILL]: 'errorSTAFF_LACKS_SKILL',
  [ERROR_CODES.STAFF_NOT_BOOKABLE]: 'errorSTAFF_NOT_BOOKABLE',
  [ERROR_CODES.OUTSIDE_BUSINESS_HOURS]: 'errorOUTSIDE_BUSINESS_HOURS',
  [ERROR_CODES.OVERBOOK_REASON_REQUIRED]: 'errorOVERBOOK_REASON_REQUIRED',
  [ERROR_CODES.ALREADY_CANCELLED]: 'errorALREADY_CANCELLED',
  [ERROR_CODES.TICKET_ALREADY_CLOSED]: 'errorTICKET_ALREADY_CLOSED',
  [ERROR_CODES.VOID_REASON_REQUIRED]: 'errorVOID_REASON_REQUIRED',
  [ERROR_CODES.PAYMENT_MISMATCH]: 'errorPAYMENT_MISMATCH',
  [ERROR_CODES.DAY_ALREADY_CLOSED]: 'errorDAY_ALREADY_CLOSED',
  [ERROR_CODES.STORE_CREDIT_INSUFFICIENT]: 'errorSTORE_CREDIT_INSUFFICIENT',
  [ERROR_CODES.VARIANCE_REASON_REQUIRED]: 'errorVARIANCE_REASON_REQUIRED',
  [ERROR_CODES.OPEN_TICKETS_REMAIN]: 'errorOPEN_TICKETS_REMAIN',
  [ERROR_CODES.DAY_HAS_REAL_RECORDS]: 'errorDAY_HAS_REAL_RECORDS',
  [ERROR_CODES.HOUSE_CUT_FORBIDDEN]: 'errorHOUSE_CUT_FORBIDDEN',
  [ERROR_CODES.PATCH_TEST_REQUIRED]: 'errorPATCH_TEST_REQUIRED',
  [ERROR_CODES.BLUEPRINT_FROZEN]: 'errorBLUEPRINT_FROZEN',
  [ERROR_CODES.BLUEPRINT_NOTHING_ACCEPTED]: 'errorBLUEPRINT_NOTHING_ACCEPTED',
  [ERROR_CODES.EXTRACTION_FAILED]: 'errorEXTRACTION_FAILED',
  [ERROR_CODES.INTERNAL]: 'errorINTERNAL',
  [ERROR_CODES.UPSTREAM_UNAVAILABLE]: 'errorUPSTREAM_UNAVAILABLE',
};

/**
 * `details.reason` 到文案 key 的二级映射。
 *
 * 服务端把「为什么失败」放在 `details.reason` 里，顶层错误码只说明失败的类别。
 * 此前这一层被整个丢弃，于是 `combined_stage_not_available` 在前台显示成
 * 「输入内容格式有误，请核对」—— 前台无论如何都无法据此行动。
 *
 * 文案一律写成可执行句式：告诉前台**下一步该点哪里**，而不是复述失败原因。
 * 与错误码映射同理，键必须逐条显式列出，不得运行期拼接。
 */
const ERROR_REASON_KEYS: Record<string, TranslationKey> = {
  // 收款阶段
  service_stage_not_available: 'errorReasonServiceStageNotAvailable',
  service_stage_tip_must_be_zero: 'errorReasonServiceStageTipMustBeZero',
  tip_stage_not_available: 'errorReasonTipStageNotAvailable',
  combined_stage_not_available: 'errorReasonCombinedStageNotAvailable',
  zero_tip_payment_not_allowed: 'errorReasonZeroTipPaymentNotAllowed',
  package_cannot_pay_tip: 'errorReasonPackageCannotPayTip',
  stored_value_cannot_pay_tip: 'errorReasonStoredValueCannotPayTip',
  tip_split_override_disabled: 'errorReasonTipSplitOverrideDisabled',
  ticket_items_frozen_after_service_settlement: 'errorReasonTicketItemsFrozen',
  // 工单与预约
  ticket_exists_requires_void: 'errorReasonTicketExistsRequiresVoid',
  closed_ticket_requires_void: 'errorReasonClosedTicketRequiresVoid',
  appointment_ticket_exists: 'errorReasonAppointmentTicketExists',
  // 工位
  resource_not_available: 'errorReasonResourceNotAvailable',
  resource_has_active_occupancies: 'errorReasonResourceHasActiveOccupancies',
};

/**
 * 返回一个把任意异常转换为母语文案的函数。
 *
 * 非 `ApiError`（网络中断、解析失败等）没有稳定的错误码可依据，
 * 统一回退到通用文案 —— 对门店而言，「操作失败，请重试」是可执行的指引，
 * 而堆栈信息不是。
 */
export function useErrorMessage(): (err: unknown) => string {
  const { t } = useLanguage();
  return useCallback(
    (err: unknown) => {
      if (err instanceof ApiError) {
        /*
         * 先取 `details.reason`：同一个 VALIDATION_FAILED 之下有十几种成因，
         * 只有 reason 能区分出前台该做什么。没有对应文案时才退回错误码级别的
         * 泛化说明 —— 泛化文案至少能说明失败的类别，好过展示原始标识符。
         */
        const reason = err.details?.['reason'];
        if (typeof reason === 'string') {
          const reasonKey = ERROR_REASON_KEYS[reason];
          if (reasonKey) return t(reasonKey);
        }
        const key = ERROR_MESSAGE_KEYS[err.code as ErrorCode];
        if (key) return t(key);
      }
      return t('genericFailure');
    },
    [t],
  );
}

/** 供完整性测试使用：错误码、失败原因与文案 key 的对照表。 */
export { ERROR_MESSAGE_KEYS, ERROR_REASON_KEYS };
