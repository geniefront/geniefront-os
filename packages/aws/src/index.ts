/**
 * AWS 直连客户端。
 *
 * ## 为什么单独成包，而不是放在 apps/api 里
 *
 * `packages/db/src/ops/diagnoseComms.ts`（通信链路体检）同样需要查询 SES 的
 * 域名身份状态，而 `packages/` 不能反向依赖 `apps/`。把签名与传输层放在此处，
 * 使发信侧（`apps/api`）与体检侧（`packages/db`）共用同一份实现 ——
 * 两份实现各自演进的话，体检报告与实际发信行为会逐渐脱节，
 * 而体检工具存在的意义正是「它说什么就是什么」。
 */

export {
  signRequest, credentialsFromEnv, awsRegion, encodePath, canonicalPath, amzDate,
  canonicalQuery,
  type AwsCredentials, type SignableRequest,
} from './sigv4';

export {
  sesRequest, sesSendEmail, sesIdentities, sesHost, SesError,
  type SesSendInput, type SesDkimStatus,
  type SesIdentityDetail, type SesIdentitySummary,
} from './ses';
