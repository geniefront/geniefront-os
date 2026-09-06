import { describe, expect, it } from 'vitest';
import { generateHealthFormQuestions } from './healthForms';

describe('generateHealthFormQuestions', () => {
  it('accepts only structured five-language questions', async () => {
    const client = {
      messages: {
        create: async () => ({
          stop_reason: 'tool_use',
          content: [{
            type: 'tool_use', id: 'tool_1', name: 'return_health_form_questions',
            input: {
              questions: [{
                id: 'q_open_wound', type: 'bool', required: true, hidden: false,
                sync: 'health_flag',
                label: {
                  'zh-Hans': '目前是否有开放性伤口？', en: 'Do you currently have an open wound?',
                  ko: '현재 열린 상처가 있나요?', es: '¿Tiene actualmente una herida abierta?',
                  vi: 'Hiện tại bạn có vết thương hở không?',
                },
              }],
            },
          }],
          usage: { input_tokens: 20, output_tokens: 30 },
        }),
      },
    } as any;

    const result = await generateHealthFormQuestions({
      prompt: '增加开放性伤口排查', actionType: 'add_safety',
      templateTitle: { en: 'Massage intake' }, existingQuestions: [],
    }, { client });

    expect(result.questions[0]).toMatchObject({ id: 'q_open_wound', sync: 'health_flag' });
    expect(result.usage).toMatchObject({ inputTokens: 20, outputTokens: 30 });
  });
});
