import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface SelfhostIdentity {
  userId?: string;
  userName?: string;
  appId?: string;
  roles?: string[];
  employeeId?: string;
  auditPrincipal?: string;
}
const identities = new AsyncLocalStorage<SelfhostIdentity>();

@Injectable()
export class RequestContextService {
  get current(): SelfhostIdentity | undefined { return identities.getStore(); }
  run<T>(identity: SelfhostIdentity, operation: () => T): T {
    return identities.run({ ...identities.getStore(), ...identity }, operation);
  }
}

export function withSelfhostActor<T>(actor: {miaodaUserId:string;name:string;employeeId:string;roles?:string[];platformRoleIds?:string[];platformAppId?:string}, operation:()=>T):T {
  if (process.env.MAKIT_STORAGE !== 'postgres') return operation();
  return new RequestContextService().run({userId:actor.miaodaUserId,userName:actor.name,employeeId:actor.employeeId,
    roles:actor.platformRoleIds || actor.roles || [],appId:actor.platformAppId || process.env.REQUIREMENT_PLATFORM_APP_ID},operation);
}
