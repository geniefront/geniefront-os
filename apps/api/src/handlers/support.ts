import { SubmitSupportRequest } from '@gf/contracts';
import { parseTs } from '@gf/db';
import { registerHandler, type HandlerArgs } from '../bus';

registerHandler(SubmitSupportRequest, async ({ input, ctx, tx, audit }: HandlerArgs<
  typeof SubmitSupportRequest.input._type
>) => {
  const [row] = await tx<{ id: string; created_at: string | Date }[]>`
    insert into support_requests (
      org_id, location_id, submitted_by_user_id, submitted_by_membership_id,
      category, subject, description, status, priority
    ) values (
      ${ctx.orgId}, ${ctx.locationId}, ${ctx.userId}, ${ctx.membershipId},
      ${input.category}, ${input.subject}, ${input.description}, 'open', ${input.priority}
    )
    returning id, created_at`;

  audit({
    entityType: 'support_request',
    entityId: row!.id,
    after: { status: 'open', category: input.category, subject: input.subject },
  });

  return {
    requestId: row!.id,
    status: 'open' as const,
    createdAt: parseTs(row!.created_at).toISOString(),
  };
});
