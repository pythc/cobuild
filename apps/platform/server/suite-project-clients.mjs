import {z} from 'zod';
import { join } from "node:path";
import { createHash } from "node:crypto";
import { serviceRequest } from "../../../packages/service/channel.mjs";
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, stable(v[k])]),
        )
      : v;
export function suiteProjectClients(config, directory, organizationId) {
  const call = (app, path, payload) =>
    serviceRequest(
      config.origins[app],
      path,
      { ...payload, organizationId },
      join(directory, app + ".service.key"),
    );
  return {
    projectOverviewClient: config.modules.includes('makit') ? {
      async requirements(actor, projectId) {
        const raw=await serviceRequest(config.origins.makit,'/openapi/suite/project-overview',
          {organizationId,subject:actor.subject,projectId},join(directory,'makit.service.key'),{timeoutMs:8000});
        const count=z.number().int().nonnegative();
        const schema=z.object({projectId:z.literal(projectId),revision:count,
          counts:z.object({total:count,inProgress:count,completed:count,blocked:count,overdue:count}).strict(),
          fetchedAt:z.iso.datetime(),stale:z.boolean()}).strict();
        const value=schema.parse(raw.data??raw);
        if(Object.values(value.counts).some(n=>n>value.counts.total))throw Error('Invalid project counts');
        return {state:'ready',...value};
      }
    } : null,
    projectSyncClient: {
      async ensure(job) {
        const input = {
          sourceProjectId: job.id,
          name: job.name,
          summary: job.summary,
          revision: job.revision,
          snapshot: job.snapshot,
        };
        const raw = await call("makit", "/openapi/workspace/projects/sync", {
            input,
          }),
          v = raw.data ?? raw;
        const url = new URL(v.projectUrl),
          digest = createHash("sha256")
            .update(JSON.stringify(stable(input)))
            .digest("hex");
        if (
          v.sourceProjectId !== job.id ||
          v.projectId !== job.id ||
          v.projectName !== job.name ||
          v.revision !== job.revision ||
          v.digest !== digest ||
          url.username ||
          url.password ||
          url.hash ||
          url.searchParams.size !== 1 ||
          url.origin !== config.origins.makit ||
          url.pathname !== "/requirements" ||
          url.searchParams.get("project") !== job.name
        )
          throw Error("Project receipt mismatch");
        return { projectId: v.projectId, url: url.href };
      },
    },
    knowledgeProjectClient: {
      async ensure(job) {
        const raw = await call("weknow", "/api/suite/projects/ensure", {
            projectId: job.id,
            revision:job.revision,name:job.name,expectedName:job.expectedName,archived:job.archived,
          }),
          v = raw.data ?? raw;
        if(v.projectId!==job.id||v.revision!==job.revision||v.archived!==job.archived||
            !['managed','legacy','suspended'].includes(v.mode))throw Error('Knowledge receipt mismatch');
        if(v.mode==='suspended'&&job.archived&&v.spaceId===null&&v.url===null)
          return {spaceId:null,url:null,name:job.name,mode:v.mode};
        const url = new URL(v.url);
        if (
          v.projectId !== job.id ||
          (v.mode!=='legacy'&&v.name!==job.name) ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
            v.spaceId,
          ) ||
          url.username ||
          url.password ||
          url.origin !== config.origins.weknow ||
          url.pathname !== "/s/" + v.slug ||
          url.search ||
          url.hash
        )
          throw Error("Knowledge receipt mismatch");
        return { spaceId: v.spaceId, url: url.href,name:v.name,mode:v.mode };
      },
    },
  };
}
