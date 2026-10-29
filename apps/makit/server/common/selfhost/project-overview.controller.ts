import {Body, Controller, Header, HttpCode, Post, ForbiddenException, NotFoundException, ConflictException, PreconditionFailedException, UnauthorizedException, ServiceUnavailableException} from '@nestjs/common';
import {z} from 'zod';
import {DrizzleDatabaseManager} from './database';
import {serviceRequest} from './suite-channel';
import {withSelfhostActor} from './context';
import {PortalProjectService} from '../../modules/requirements/portal-project.service';
import {RequirementsQueryService} from '../../modules/requirements/requirements-query.service';
import {RequirementAccessService} from '../../modules/requirements/requirement-access.service';

// Native, signed, actor-scoped read adapter. Never provisions users or grants roles.
@Controller('openapi/suite/project-overview')
export class ProjectOverviewController {
  constructor(private readonly database: DrizzleDatabaseManager,
    private readonly projects: PortalProjectService,
    private readonly query: RequirementsQueryService,
    private readonly access: RequirementAccessService) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store, private')
  async read(@Body() body: unknown) {
    const parsed=z.object({organizationId:z.uuid(),subject:z.string().max(100),projectId:z.uuid()}).strict().safeParse(body);
    if(!parsed.success)throw new UnauthorizedException('读取请求无效');
    const {organizationId,subject,projectId}=parsed.data;
    if(organizationId!==process.env.LAB_IDENTITY_TENANT_KEY || !subject.startsWith(organizationId+':') || !z.uuid().safeParse(subject.slice(organizationId.length+1)).success)
      throw new ForbiddenException('组织身份无效');
    const authorize=async()=>{
      const profile=await serviceRequest(process.env.COBUILD_IDENTITY_ORIGIN!, '/api/suite/services/makit/member',
        {organizationId,userId:subject},process.env.COBUILD_SERVICE_KEY_FILE!).catch(error=>{
          if([401,403].includes(error?.status))throw new ForbiddenException('Makit 访问已失效');
          throw error;
        });
      if(profile.subject!==subject)throw new ForbiddenException('组织身份不一致');
      const sql=this.database.client;
      const [binding]=await sql`SELECT organization_id,issuer FROM makit_suite_organization WHERE id`;
      if(!binding || binding.organization_id!==organizationId || binding.issuer!==process.env.COBUILD_IDENTITY_ORIGIN)
        throw new PreconditionFailedException('请先连接 Makit');
      const [user]=await sql`SELECT u.id,u.active,d.active AS directory_active,d.employee_id,d.open_id,d.name
        FROM makit_user u JOIN makit_directory d ON d.employee_id=u.employee_id WHERE u.subject=${subject}`;
      if(!user)throw new PreconditionFailedException('请先连接 Makit');
      if(!user.active || !user.directory_active)throw new ForbiddenException('Makit 账号已停用');
      const roles=await sql`SELECT role_id FROM makit_user_role WHERE user_id=${user.id}`;
      return this.access.decorate({miaodaUserId:user.id,employeeId:user.employee_id,openId:user.open_id,name:user.name,
        platformAppId:process.env.REQUIREMENT_PLATFORM_APP_ID || '',platformRoleIds:roles.map(r=>r.role_id)});
    };
    const actor=await authorize();
    const resolve=async()=>{
      const projects=await this.projects.list(),project=projects.find(p=>p.projectId===projectId);
      if(!project)throw new NotFoundException('项目尚未同步');
      // Legacy requirements store names. Ambiguous aliases must never mix project totals.
      const names=new Set([project.projectName,...(project.snapshot?.aliases||[])]);
      if(projects.some(p=>p.projectId!==projectId && [p.projectName,...(p.snapshot?.aliases||[])].some(n=>names.has(n))))
        throw new ConflictException('项目名称关联存在冲突');
      return project;
    };
    const project=await resolve();
    const summary=await withSelfhostActor(actor,()=>this.query.projectOverviewAs(actor,project.projectName));
    const current=await resolve();
    if(current.revision!==project.revision||current.projectName!==project.projectName)
      throw new ServiceUnavailableException('项目信息正在更新，请重试');
    await authorize(); // Revocation wins over a slow query or a cached read.
    return {projectId,revision:project.revision,...summary};
  }
}
