/**
 * 营销站跳到工作台的 origin。和 API `links.ts` 同一套环境分流：
 * APP_BASE_URL 优先，缺省按 GF_ENV 落到该环境 desk，绝不默认生产。
 */
declare const __DESK_BASE__: string;

export function deskBaseUrl(): string {
  return String(__DESK_BASE__).replace(/\/+$/, '');
}

/** 店主 / 员工登录页。未登录访问 desk 根路径即登录。 */
export function deskLoginUrl(): string {
  return `${deskBaseUrl()}/`;
}
