import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { serviceRequest } from './suite-channel';
// Raised before the record transaction changes any row. Queued operations can
// safely classify this as rejected rather than an uncertain external write.
export class ProjectArchivedError extends ConflictException {
  constructor(){super('项目已归档，请先在 Kick 恢复项目');}
}

// Deny-only, live check shared by UI, MCP and queued record writes. Native
// business authorization still runs before the record store. No permission cache.
export async function assertProjectWrites(fields: Array<Record<string,unknown>>) {
  if(process.env.COBUILD_IDENTITY_MODE!=='local')return;
  const names=new Set<string>();
  for(const row of fields){
    const value=row['项目'];
    for(const name of Array.isArray(value)?value:[value]){
      if(name===undefined||name===null||name==='')continue;
      if(typeof name!=='string'||name.length>200)throw new BadRequestException('项目名称无效');
      names.add(name);
    }
  }
  if(!names.size)return;
  let result:any;
  try{
    result=await serviceRequest(process.env.COBUILD_IDENTITY_ORIGIN!, '/api/suite/services/makit/project-writes',
      {organizationId:process.env.LAB_IDENTITY_TENANT_KEY,names:[...names]},process.env.COBUILD_SERVICE_KEY_FILE!);
  }catch{throw new ServiceUnavailableException('项目状态暂时无法确认，请稍后重试');}
  if(result.organizationId!==process.env.LAB_IDENTITY_TENANT_KEY||!Array.isArray(result.blockedNames)||
      result.blockedNames.some(n=>!names.has(n)))throw new ServiceUnavailableException('项目状态响应无效');
  if(result.blockedNames.length)throw new ProjectArchivedError();
}
