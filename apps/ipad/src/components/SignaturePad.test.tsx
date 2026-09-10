import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { SignaturePad } from './SignaturePad';
import { LanguageProvider } from '../context/LanguageContext';

const ctx = {
  scale: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(),
  lineTo: vi.fn(), stroke: vi.fn(), getImageData: vi.fn(() => ({})), putImageData: vi.fn(),
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,signature');
});
describe('SignaturePad tablet resizing', () => {
  it('maps resized display coordinates to the preserved canvas and clears the final undone stroke', () => {
    const onSave = vi.fn();
    const onClear = vi.fn();
    const { container, getByRole } = render(<LanguageProvider><SignaturePad onSave={onSave} onClear={onClear} /></LanguageProvider>);
    const canvas = container.querySelector('canvas')!;
    expect(canvas.style.width).toBe('100%');
    vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue({left: 10, top: 20, width: 250, height: 180} as DOMRect);
    fireEvent.mouseDown(canvas, {clientX: 135, clientY: 65});
    expect(ctx.moveTo).toHaveBeenCalledWith(250, 45);
    fireEvent.mouseMove(canvas, {clientX: 160, clientY: 80});
    fireEvent.mouseUp(canvas);
    expect(onSave).toHaveBeenCalledTimes(1);
    getByRole('button', {name: /undo|撤销|撤回/i}).click();
    expect(onClear).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
