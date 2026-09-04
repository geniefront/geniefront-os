import { describe, expect, it } from 'vitest';
import { AppError, ERROR_CODES } from '@gf/contracts';
import {
  MAX_COPILOT_IMAGE_BYTES,
  parseCopilotImage,
} from './image';

describe('parseCopilotImage', () => {
  it('accepts a supported, valid base64 image', () => {
    const base64 = Buffer.from('valid image bytes').toString('base64');
    expect(parseCopilotImage({ base64, mediaType: 'image/jpeg' })).toEqual({
      base64,
      mediaType: 'image/jpeg',
    });
  });

  it.each([
    { base64: 'not base64!', mediaType: 'image/png' },
    { base64: Buffer.from('x').toString('base64'), mediaType: 'image/svg+xml' },
  ])('rejects malformed input %#', (input) => {
    expect(() => parseCopilotImage(input)).toThrowError(expect.objectContaining({
      code: ERROR_CODES.VALIDATION_FAILED,
    }) as AppError);
  });

  it('rejects decoded images over 10 MiB', () => {
    const base64 = Buffer.alloc(MAX_COPILOT_IMAGE_BYTES + 1).toString('base64');
    expect(() => parseCopilotImage({ base64, mediaType: 'image/png' })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.VALIDATION_FAILED }) as AppError,
    );
  });
});
