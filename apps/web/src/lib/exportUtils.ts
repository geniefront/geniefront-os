/**
 * 通用数据导出工具库 (支持 CSV, Excel TSV, 打印)
 */

type Cell = string | number | boolean | null | undefined;

// Spreadsheet-facing exports: apostrophe marks untrusted formula-like text.
// Numeric values stay numeric, including negative monetary amounts.
export function spreadsheetCell(value: Cell): string {
  const text = value == null ? '' : String(value);
  return typeof value === 'string' && /^[\s\u0000-\u001f]*[=+@-]/u.test(text) ? "'" + text : text;
}

export function serializeDelimited(headers: string[], rows: Cell[][], separator = ','): string {
  const escape = (value: Cell) => `"${spreadsheetCell(value).replace(/"/g, '""')}"`;
  return '\uFEFF' + [headers, ...rows].map(row => row.map(escape).join(separator)).join('\r\n');
}

/**
 * 导出为标准 CSV 文件 (带 UTF-8 BOM，防止 Excel 打开中文乱码)
 */
export function exportToCSV(filename: string, headers: string[], rows: (string | number | boolean | null | undefined)[][]) {
  const csvContent = serializeDelimited(headers, rows);

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename.endsWith('.csv') ? filename : `${filename}.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * 导出为 Excel 友好格式 (.tsv / .xls)
 */
export function exportToExcel(filename: string, headers: string[], rows: (string | number | boolean | null | undefined)[][]) {
  const tsvContent = serializeDelimited(headers, rows, '\t');

  const blob = new Blob([tsvContent], { type: 'application/vnd.ms-excel;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.setAttribute('href', url);
  link.setAttribute('download', filename.endsWith('.xls') ? filename : `${filename}.xls`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
