import { describe, it, expect } from 'vitest';
import {
  decodeCompactExtraction,
  compactExtractionZ,
  type CompactExtraction,
} from './schema';
import { extractPriceList, type PriceListImage } from './priceList';
import { LunaRuntime, type LunaResponse } from './runtime/luna';

describe('Luna compact schema decoder (29 §11)', () => {
  it('decodes compact schema into full domain extraction including pricingUnit and bbox', () => {
    const compact: CompactExtraction = {
      groups: [
        {
          category: 'NAILS & SPA',
          rows: [
            {
              n: 'Gel Manicure',
              k: 'service',
              p: [
                { l: 'Short', d: 45, c: 4500 },
                { l: 'Long', d: 60, c: 5500 },
              ],
              f: false,
              q: 'certain',
              b: [10, 20, 200, 50],
              pkg: null,
              unit: 'each',
            },
            {
              n: '10-Session Deluxe Package',
              k: 'package',
              p: [{ l: '', d: 60, c: 40000 }],
              f: false,
              q: 'certain',
              b: [10, 60, 200, 90],
              pkg: {
                s: 10,
                names: ['Deluxe Pedicure'],
                days: 365,
              },
              unit: null,
            },
          ],
        },
      ],
      unresolved: [
        { field: 'business_hours', question: '请问营业时间是？' },
      ],
    };

    expect(compactExtractionZ.safeParse(compact).success).toBe(true);

    const decoded = decodeCompactExtraction(compact);
    expect(decoded.items).toHaveLength(2);

    const row1 = decoded.items[0]!;
    expect(row1.name).toBe('Gel Manicure');
    expect(row1.category).toBe('NAILS & SPA');
    expect(row1.kind).toBe('service');
    expect(row1.variants).toHaveLength(2);
    expect(row1.variants[0]!.label).toBe('Short');
    expect(row1.variants[0]!.price_cents).toBe(4500);
    expect(row1.price_cents).toBe(4500);
    expect(row1.bbox).toEqual({ x1: 10, y1: 20, x2: 200, y2: 50 });
    expect(row1.pricingUnit).toBe('each');

    const row2 = decoded.items[1]!;
    expect(row2.name).toBe('10-Session Deluxe Package');
    expect(row2.kind).toBe('package');
    expect(row2.package_sessions).toBe(10);
    expect(row2.package_service_names).toEqual(['Deluxe Pedicure']);
    expect(row2.package_valid_days).toBe(365);
    expect(row2.price_cents).toBe(40000);
  });

  it('extractPriceList successfully parses Luna compact response through runtime', async () => {
    const compactOutput = {
      groups: [
        {
          category: 'MASSAGE',
          rows: [
            {
              n: 'Swedish Massage 60m',
              k: 'service',
              p: [{ l: '', d: 60, c: 8000 }],
              f: false,
              q: 'certain',
              b: [0, 0, 100, 50],
              pkg: null,
              unit: 'per person',
            },
          ],
        },
      ],
      unresolved: [],
    };

    const mockRuntime = {
      invoke: async (): Promise<LunaResponse> => ({
        text: '',
        toolCalls: [
          {
            callId: 'call_1',
            name: 'record_price_list',
            arguments: compactOutput,
            rawArguments: JSON.stringify(compactOutput),
          },
        ],
        usage: {
          uncachedInputTokens: 500,
          cachedReadInputTokens: 2000,
          cacheWriteInputTokens: 0,
          outputTokens: 300,
        },
        status: 'completed',
        model: 'gpt-5.6-luna',
      }),
    } as unknown as LunaRuntime;

    const testImage: PriceListImage = {
      seq: 1,
      base64: 'fakebase64',
      mediaType: 'image/jpeg',
    };

    const res = await extractPriceList([testImage], {
      runtime: mockRuntime,
    });

    expect(res.items).toHaveLength(1);
    expect(res.items[0]!.name['en']).toBe('Swedish Massage 60m');
    expect(res.items[0]!.category).toBe('MASSAGE');
    expect(res.items[0]!.priceCents).toBe(8000);
    expect(res.items[0]!.pricingUnit).toBe('per person');
    expect(res.usage.inputTokens).toBe(500);
    expect(res.usage.cacheReadInputTokens).toBe(2000);
    expect(res.usage.outputTokens).toBe(300);
  });
});
