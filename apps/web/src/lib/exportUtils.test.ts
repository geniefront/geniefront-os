import { expect, it } from 'vitest';
import { serializeDelimited, spreadsheetCell } from './exportUtils';
it('neutralizes formula text and preserves phone and numeric semantics', () => {
  for (const value of ['=1+1', '+15551234567', '-1+1', '@SUM(A1)', '\t=1+1', '\r\n =1+1']) {
    expect(spreadsheetCell(value)).toBe("'" + value);
  }
  expect(spreadsheetCell(-123.45)).toBe('-123.45');
  expect(spreadsheetCell('普通客户')).toBe('普通客户');
});
it.each([',', '\t'])('quotes separators, quotes and line endings for %s', separator => {
  expect(serializeDelimited(['Name'], [['A "Quoted", Name\r\nNext\tLine'], ['=1+1']], separator))
    .toBe('\uFEFF"Name"\r\n"A ""Quoted"", Name\r\nNext\tLine"\r\n"\'=1+1"');
});
