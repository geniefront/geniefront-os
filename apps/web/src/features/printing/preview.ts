import './print.css';

export type PrintPaper = 'letter' | 'thermal';
let closeActive: (() => void) | undefined;

/** An isolated, in-memory preview. No popup, storage, navigation or payment retry. */
export function openPrintPreview(source: Element | null, title: string, paper: PrintPaper = 'letter') {
  if (!source) throw new Error('Print document is not ready.');
  closeActive?.();
  const previousFocus = document.activeElement as HTMLElement | null;
  const root = document.createElement('div');
  root.id = 'gf-print-root';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', title);
  const toolbar = document.createElement('div');
  toolbar.className = 'gf-print-toolbar';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Paper size');
  for (const [value, label] of [['letter', 'US Letter (8.5 × 11 in)'], ['thermal', 'Receipt (80 mm / 3⅛ in)']]) {
    const option = document.createElement('option');
    option.value = value!; option.textContent = label!; select.append(option);
  }
  select.value = paper;
  const print = document.createElement('button');
  print.textContent = 'Loading print assets…'; print.disabled = true;
  const close = document.createElement('button');
  close.textContent = 'Close preview';
  const help = document.createElement('p');
  help.className = 'gf-print-help';
  help.textContent = 'iPad: use an AirPrint printer on the same Wi-Fi. Computer: select your installed printer or Save as PDF. Match the paper size in the print dialog; turn off browser headers and footers. Printing does not confirm payment or paper delivery.';
  const pageStyle = document.createElement('style');
  const sheet = document.createElement('article');
  sheet.className = 'gf-print-sheet';
  const snapshot = source.cloneNode(true) as HTMLElement;
  snapshot.querySelectorAll('button, input, select, textarea, [data-no-print], script').forEach(el => el.remove());
  snapshot.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
  snapshot.removeAttribute('id');
  sheet.append(snapshot);
  toolbar.append(heading, select, print, close);
  root.append(pageStyle, toolbar, help, sheet);
  const setPaper = () => {
    root.dataset.paper = select.value;
    // Thermal roll length is controlled by the printer driver. Keep pagination
    // available rather than clipping a long receipt to a fabricated roll length.
    pageStyle.textContent = `@page { size: ${select.value === 'thermal' ? 'auto' : 'letter'}; margin: ${select.value === 'thermal' ? '3mm' : '0.5in'}; }`;
  };
  select.onchange = setPaper; setPaper();
  const hidden = [...document.body.children].filter(el => el instanceof HTMLElement) as HTMLElement[];
  const inertBefore = hidden.map(el => el.inert);
  hidden.forEach(el => { el.inert = true; });
  const previousTitle = document.title;
  document.title = title;
  document.body.append(root);
  document.body.classList.add('gf-print-open');
  const cleanup = () => {
    root.remove();
    document.body.classList.remove('gf-print-open');
    document.title = previousTitle;
    hidden.forEach((el, i) => { el.inert = inertBefore[i] ?? false; });
    document.removeEventListener('keydown', onKey, true);
    previousFocus?.focus();
    closeActive = undefined;
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.stopImmediatePropagation(); cleanup(); }
    if (event.key === 'Tab') {
      const controls = [select, print, close].filter(el => !el.disabled);
      if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); close.focus(); }
      else if (!event.shiftKey && document.activeElement === close) { event.preventDefault(); select.focus(); }
    }
  };
  document.addEventListener('keydown', onKey, true);
  close.onclick = cleanup; closeActive = cleanup; close.focus();
  print.onclick = () => {
    try { window.print(); } catch { help.textContent = 'Use your browser menu (or Share on iPad) and choose Print.'; }
  };
  // Keep the preview open after cancellation; afterprint does not prove success.
  const images = [...sheet.querySelectorAll('img')].map(img => {
    img.loading = 'eager';
    return img.decode ? img.decode() : new Promise<void>((resolve, reject) => {
      if (img.complete) { img.naturalWidth ? resolve() : reject(); }
      else { img.onload = () => resolve(); img.onerror = () => reject(); }
    });
  });
  void Promise.all([document.fonts?.ready, ...images]).then(() => {
    print.disabled = false; print.textContent = 'Print / Save PDF';
  }).catch(() => {
    print.textContent = 'Image failed to load';
    help.textContent = 'A document image could not be loaded. Close this preview and reload the record before printing.';
  });
  return cleanup;
}

/**
 * 打印用表头。内部单据跟随界面语言，因此数字列由调用方显式声明，
 * 不能靠英文表头文案猜测。
 */
export type PrintColumn = string | { label: string; numeric?: boolean };

export function printTable(title: string, headers: PrintColumn[], rows: Array<Array<string | number>>) {
  const article = document.createElement('article');
  const h1 = document.createElement('h1'); h1.textContent = title; article.append(h1);
  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  const numeric = headers.map(column => typeof column !== 'string' && column.numeric === true);
  headers.forEach((column, index) => {
    const th = document.createElement('th');
    th.textContent = typeof column === 'string' ? column : column.label;
    if (numeric[index]) th.className = 'gf-print-num';
    head.append(th);
  });
  const body = table.createTBody();
  rows.forEach(row => {
    const tr = body.insertRow();
    row.forEach((value, index) => {
      const cell = tr.insertCell();
      cell.textContent = String(value);
      if (numeric[index]) cell.className = 'gf-print-num';
    });
  });
  article.append(table);
  return openPrintPreview(article, title);
}
