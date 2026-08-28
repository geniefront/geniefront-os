/**
 * 通用数据导出工具库 (支持 CSV, Excel TSV, 打印)
 */

/**
 * 导出为标准 CSV 文件 (带 UTF-8 BOM，防止 Excel 打开中文乱码)
 */
export function exportToCSV(filename: string, headers: string[], rows: (string | number | boolean | null | undefined)[][]) {
  const escapeCell = (val: string | number | boolean | null | undefined): string => {
    if (val === null || val === undefined) return '""';
    const str = String(val);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return `"${str}"`;
  };

  const headerLine = headers.map(escapeCell).join(',');
  const rowLines = rows.map((row) => row.map(escapeCell).join(','));
  const csvContent = '\uFEFF' + [headerLine, ...rowLines].join('\r\n');

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
  const escapeCell = (val: string | number | boolean | null | undefined): string => {
    if (val === null || val === undefined) return '';
    return String(val).replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
  };

  const headerLine = headers.map(escapeCell).join('\t');
  const rowLines = rows.map((row) => row.map(escapeCell).join('\t'));
  const tsvContent = '\uFEFF' + [headerLine, ...rowLines].join('\r\n');

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
