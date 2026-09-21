import { SubmitSupportRequest, ReplySupportRequest, AppError, ERROR_CODES } from '@gf/contracts';
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

registerHandler(ReplySupportRequest, async ({ input, ctx, tx, audit }) => {
  const [request] = await tx<{ id: string }[]>`select id from support_requests where id=${input.requestId}
    and org_id=${ctx.orgId} and location_id=${ctx.locationId} for update`;
  if (!request) throw new AppError(ERROR_CODES.NOT_FOUND);
  if (input.body) await tx`insert into support_request_messages (request_id,org_id,location_id,author_kind,author_user_id,body)
    values (${request.id},${ctx.orgId},${ctx.locationId},'customer',${ctx.userId},${input.body})`;
  const status = input.status ?? 'open';
  await tx`update support_requests set status=${status},updated_at=now(),resolved_at=case when ${status}='resolved' then now() else null end where id=${request.id}`;
  audit({ entityType: 'support_request', entityId: request.id, after: { status, publicReply: Boolean(input.body) } });
  return { requestId: request.id };
});
