import { UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { sql, Kysely } from 'kysely';
import { serviceRequest } from './suite-channel';

/** Live authorization before native HTTP, OAuth/MCP and collaboration access.
 * Serialize fetch + materialization per subject so a slow old response cannot
 * restore a grant after a newer revocation. No stale-on-error permission cache.
 */
export async function refreshManagedAccess(db: Kysely<any>, config: any, identity: any) {
  await db.transaction().execute(async trx => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${identity.userId + ':managed-access'},0))`.execute(trx);
    const organizationId = config.get('LAB_IDENTITY_TENANT_KEY','');
    const data = await serviceRequest(config.get('LAB_IDENTITY_ORIGIN',''),
      '/api/suite/services/weknow/project-access', {organizationId, subject: identity.subject},
      config.get('COBUILD_SERVICE_KEY_FILE',''));
    if (data.organizationId !== organizationId || data.subject !== identity.subject ||
        !Array.isArray(data.projects) || data.projects.length > 10000 ||
        new Set(data.projects.map(p=>p.id)).size !== data.projects.length ||
        data.projects.some(p=>!/^[-a-f0-9]{36}$/.test(p.id) || !['admin','writer'].includes(p.role)))
      throw new ServiceUnavailableException('Invalid project access snapshot');
    const managed = await trx.selectFrom('suiteManagedSpaces').selectAll()
      .where('organizationId','=',organizationId).execute();
    const allowed = new Map<string,any>(data.projects.map(p=>[p.id,p]));
    const previous = await trx.selectFrom('suiteManagedAccess').select('spaceId')
      .where('userId','=',identity.userId).execute();
    const known = new Set(previous.map(p=>p.spaceId));
    await trx.deleteFrom('suiteManagedAccess').where('userId','=',identity.userId).execute();
    for (const space of managed) {
      const project = allowed.get(space.projectId);
      if (!project) continue;
      // Initial membership seeds the native ACL. A native role edit/removal while
      // membership remains active is preserved; eligibility alone grants no role.
      if (!known.has(space.spaceId)) {
        const existing = await trx.selectFrom('spaceMembers').select('id')
          .where('spaceId','=',space.spaceId).where('userId','=',identity.userId).executeTakeFirst();
        if (!existing) await trx.insertInto('spaceMembers').values({spaceId:space.spaceId,
          userId:identity.userId,role:project.role}).execute();
      }
      await trx.insertInto('suiteManagedAccess').values({spaceId:space.spaceId,
        userId:identity.userId,expiresAt:new Date(Date.now()+35000)}).execute();
    }
  });
}
