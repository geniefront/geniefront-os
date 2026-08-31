import { expect, test as base, type Page, type TestInfo } from '@playwright/test';

type RuntimeObservation = {
  kind: 'console' | 'pageerror' | 'http' | 'requestfailed';
  text: string;
  url?: string;
  status?: number;
};

type AllowRule = { status?: number; url: RegExp; note: string };

export type QaRuntime = {
  observations: RuntimeObservation[];
  allowResponse: (url: RegExp, status: number, note: string) => void;
  allowRequestFailure: (url: RegExp, note: string) => void;
  allowConsole: (text: RegExp, note: string) => void;
};

async function attachRuntimeEvidence(
  page: Page,
  testInfo: TestInfo,
  observations: RuntimeObservation[],
): Promise<void> {
  await testInfo.attach('runtime-observations', {
    body: Buffer.from(JSON.stringify(observations, null, 2)),
    contentType: 'application/json',
  });
  if (!page.isClosed()) {
    await testInfo.attach('final-page', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
  }
}

export const test = base.extend<{ qaRuntime: QaRuntime }>({
  qaRuntime: [async ({ page }, use, testInfo) => {
    const observations: RuntimeObservation[] = [];
    const responseAllow: AllowRule[] = [];
    const requestFailureAllow: Array<{ url: RegExp; note: string }> = [];
    const consoleAllow: Array<{ text: RegExp; note: string }> = [];

    page.on('console', (message) => {
      if (message.type() === 'error') {
        observations.push({ kind: 'console', text: message.text() });
      }
    });
    page.on('pageerror', (error) => {
      observations.push({ kind: 'pageerror', text: error.stack ?? error.message });
    });
    page.on('response', (response) => {
      if (response.status() >= 400) {
        observations.push({
          kind: 'http', status: response.status(), url: response.url(),
          text: `${response.request().method()} ${response.status()} ${response.url()}`,
        });
      }
    });
    page.on('requestfailed', (request) => {
      observations.push({
        kind: 'requestfailed', url: request.url(),
        text: `${request.method()} ${request.url()} — ${request.failure()?.errorText ?? 'failed'}`,
      });
    });

    await use({
      observations,
      allowResponse: (url, status, note) => responseAllow.push({ url, status, note }),
      allowRequestFailure: (url, note) => requestFailureAllow.push({ url, note }),
      allowConsole: (text, note) => consoleAllow.push({ text, note }),
    });

    await attachRuntimeEvidence(page, testInfo, observations);
    const unexpected = observations.filter((item) => {
      if (item.kind === 'http') {
        return !responseAllow.some((rule) => rule.status === item.status && rule.url.test(item.url ?? ''));
      }
      if (item.kind === 'console') {
        const expectedHttpConsole = /^Failed to load resource: the server responded with a status of (\d+)/.exec(item.text);
        if (expectedHttpConsole) {
          const status = Number(expectedHttpConsole[1]);
          if (responseAllow.some((rule) => rule.status === status)) return false;
        }
        return !consoleAllow.some((rule) => rule.text.test(item.text));
      }
      if (item.kind === 'requestfailed') {
        return !requestFailureAllow.some((rule) => rule.url.test(item.url ?? ''));
      }
      return true;
    });
    if (unexpected.length > 0 && testInfo.status === testInfo.expectedStatus) {
      throw new Error(`Unexpected browser runtime observations:\n${unexpected.map((item) => item.text).join('\n')}`);
    }
  }, { auto: true }],
});

export { expect };
