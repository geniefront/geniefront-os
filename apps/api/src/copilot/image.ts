import { AppError, ERROR_CODES } from '@gf/contracts';
import type { CopilotImageInput } from '@gf/ai';

export const MAX_COPILOT_IMAGE_BYTES = 10 * 1024 * 1024;
export const COPILOT_BODY_LIMIT = 15_000_000;

const COPILOT_IMAGE_TYPES = new Set<CopilotImageInput['mediaType']>([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
]);

/** Validate the encoded payload before passing any image bytes to the model SDK. */
export function parseCopilotImage(
  image: { base64?: unknown; mediaType?: unknown } | undefined,
): CopilotImageInput | undefined {
  if (!image || image.base64 === undefined || image.base64 === '') return undefined;
  const mediaType = image.mediaType ?? 'image/png';
  if (typeof image.base64 !== 'string'
      || typeof mediaType !== 'string'
      || !COPILOT_IMAGE_TYPES.has(mediaType as CopilotImageInput['mediaType'])
      || image.base64.length % 4 !== 0
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64)) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: { reason: 'copilot_image_invalid' },
    });
  }

  const decodedBytes = Buffer.byteLength(image.base64, 'base64');
  if (decodedBytes <= 0 || decodedBytes > MAX_COPILOT_IMAGE_BYTES) {
    throw new AppError(ERROR_CODES.VALIDATION_FAILED, {
      details: {
        reason: 'copilot_image_too_large',
        maxBytes: MAX_COPILOT_IMAGE_BYTES,
        gotBytes: decodedBytes,
      },
    });
  }
  return {
    base64: image.base64,
    mediaType: mediaType as CopilotImageInput['mediaType'],
  };
}
