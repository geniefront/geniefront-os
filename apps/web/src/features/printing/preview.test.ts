import { afterEach, describe, expect, it, vi } from 'vitest';
import { openPrintPreview, printTable } from './preview';
afterEach(() => { document.querySelector<HTMLButtonElement>('#gf-print-root .gf-print-toolbar button:last-child')?.click(); document.body.innerHTML = ''; });
describe('isolated printing', () => {
  it('isolates the document and restores focus/inert state without treating cancel as success', async () => {
    const app = document.createElement('main'); app.innerHTML = '<button>Return</button><section><p>Receipt</p><button>Do not print</button></section>';
    document.body.append(app); app.querySelector('button')!.focus();
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    openPrintPreview(app.querySelector('section'), 'Receipt', 'thermal');
    await Promise.resolve(); await Promise.resolve();
    expect(app.inert).toBe(true);
    expect(document.querySelector('.gf-print-sheet')?.textContent).toBe('Receipt');
    expect(document.querySelector('#gf-print-root style')?.textContent).toContain('size: auto');
    document.querySelector<HTMLButtonElement>('.gf-print-toolbar button')!.click();
    expect(print).toHaveBeenCalledOnce();
    window.dispatchEvent(new Event('afterprint'));
    expect(document.querySelector('#gf-print-root')).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}));
    expect(app.inert).toBeFalsy(); expect(document.activeElement).toBe(app.querySelector('button'));
  });
  it('prints all exported rows and escapes user text', () => {
    printTable('Statement', ['Customer'], Array.from({length:120}, (_,i) => [`<img src=x onerror=alert(1)> ${i}`]));
    expect(document.querySelectorAll('.gf-print-sheet tbody tr')).toHaveLength(120);
    expect(document.querySelector('.gf-print-sheet img')).toBeNull();
    expect(document.querySelector('#gf-print-root style')?.textContent).toContain('letter');
  });
  it('blocks printing when a signature image cannot load', async () => {
    const previous = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'decode');
    Object.defineProperty(HTMLImageElement.prototype, 'decode', {configurable:true, value:()=>Promise.reject(new Error('missing signature'))});
    try {
      const source = document.createElement('article');
      source.innerHTML = '<img src="https://example.invalid/signature.png" alt="Signature">';
      openPrintPreview(source, 'Health record');
      await new Promise(resolve=>setTimeout(resolve, 0));
      const button = document.querySelector<HTMLButtonElement>('.gf-print-toolbar button')!;
      expect(button.disabled).toBe(true);
      expect(button.textContent).toBe('Image failed to load');
    } finally {
      if (previous) Object.defineProperty(HTMLImageElement.prototype, 'decode', previous);
      else delete (HTMLImageElement.prototype as unknown as {decode?:unknown}).decode;
    }
  });

});
