/**
 * 任务草案校验工具 (29 §6.2)
 */

import type { CommandContext } from '@gf/contracts';
import { getCommand } from '@gf/contracts';

export async function validateTaskDraft(
  ctx: CommandContext,
  input: Record<string, unknown>,
): Promise<unknown> {
  const steps = Array.isArray(input['steps']) ? input['steps'] : [];
  const results = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const cmd = getCommand(step.command);
    if (!cmd) {
      results.push({
        stepIndex: i,
        command: step.command,
        status: 'invalid',
        error: `未知命令: ${step.command}`,
      });
      continue;
    }

    if (cmd.permission && !ctx.permissions.has(cmd.permission)) {
      results.push({
        stepIndex: i,
        command: step.command,
        status: 'invalid',
        error: `缺少权限: ${cmd.permission}`,
      });
      continue;
    }

    const parse = cmd.input.safeParse(step.input);
    if (!parse.success) {
      results.push({
        stepIndex: i,
        command: step.command,
        status: 'invalid',
        issues: parse.error.issues,
      });
      continue;
    }

    results.push({
      stepIndex: i,
      command: step.command,
      status: 'ready',
    });
  }

  const allReady = results.every((r) => r.status === 'ready');
  return {
    valid: allReady,
    status: allReady ? 'ready' : 'has_issues',
    steps: results,
  };
}
