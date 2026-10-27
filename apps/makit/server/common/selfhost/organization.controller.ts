import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
import { z } from 'zod';
import { NeedLogin } from './platform';
import { DrizzleDatabaseManager } from './database';
import { MakitOrganizationService } from './organization.service';
const search = z.object({query:z.string().max(200).optional(),offset:z.number().int().min(0).max(100000).optional(),
  pageSize:z.number().int().min(1).max(100).optional()}).strict();
@Controller('api/selfhost')
@NeedLogin()
export class MakitOrganizationController {
  constructor(private readonly database: DrizzleDatabaseManager, private readonly organization: MakitOrganizationService) {}
  @Post('departments/search')
  async departments(@Body() body: unknown) {
    const parsed=search.safeParse(body); if(!parsed.success) throw new BadRequestException('查询参数无效');
    await this.organization.refresh(); const input=parsed.data, sql=this.database.client;
    const rows=await sql<{id:string;name:string}[]>`SELECT id,name FROM makit_department WHERE strpos(lower(name),lower(${input.query || ''}))>0
      ORDER BY name,id LIMIT ${input.pageSize || 20} OFFSET ${input.offset || 0}`;
    const [count]=await sql`SELECT count(*)::int AS total FROM makit_department WHERE strpos(lower(name),lower(${input.query || ''}))>0`;
    return {data:{departmentList:rows.map((row)=>({departmentID:row.id,larkDepartmentID:row.id,openDepartmentID:row.id,name:{zh_cn:row.name}})),total:count.total},status_code:'0'};
  }
  @Post('chats/search')
  async chats(@Body() body: unknown) {
    const parsed=search.safeParse(body); if(!parsed.success) throw new BadRequestException('查询参数无效');
    const input=parsed.data, rows=(await this.organization.visibleChats()).filter((row)=>row.name.toLowerCase().includes((input.query || '').toLowerCase()));
    return {data:{result:{chatResult:{total:rows.length,items:rows.slice(input.offset || 0,(input.offset || 0)+(input.pageSize || 20)).map(this.chat)}}},status_code:'0'};
  }
  @Post('chats/batch')
  async batch(@Body() body: unknown) {
    const parsed=z.object({chatIds:z.array(z.string().regex(/^oc_[\w-]+$/)).max(100)}).strict().safeParse(body);
    if(!parsed.success) throw new BadRequestException('群查询无效');
    const rows=await this.organization.visibleChats();
    return {data:{chatInfoMap:Object.fromEntries(rows.filter((row)=>parsed.data.chatIds.includes(row.chat_id)).map((row)=>[row.chat_id,this.chat(row)]))},status_code:'0'};
  }
  private chat(row:{chat_id:string;name:string;avatar?:string;external?:boolean}) {
    return {chatID:row.chat_id,openChatID:row.chat_id,name:{zh_cn:row.name},avatar:row.avatar || '',isExternal:row.external || false};
  }
}
