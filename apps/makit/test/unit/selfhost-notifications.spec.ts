import { MakitNotificationWorker } from '../../server/common/selfhost/notification-worker.service';
import { FeishuService, FeishuMessageDeliveryError } from '../../server/modules/requirements/feishu.service';
import { selfhostAssetReferences } from '../../shared/selfhost-assets';
import { uploadedFileName } from '../../server/common/selfhost/file-name';

describe('selfhost background delivery boundaries',()=>{
  const old={...process.env};
  it('preserves browser UTF-8 filenames and does not damage decoded Unicode or Latin-1 names',()=>{
    const name='迁移验收文档.txt';
    expect(uploadedFileName(Buffer.from(name,'utf8').toString('latin1'))).toBe(name);
    expect(uploadedFileName(name)).toBe(name);
    expect(uploadedFileName('café.txt')).toBe('café.txt');
    expect(uploadedFileName('document.txt')).toBe('document.txt');
  });
  afterEach(()=>{process.env=old;});
  it('does not claim or dispatch imported work while rehearsal workers are disabled',async()=>{
    process.env.MAKIT_WORKERS_ENABLED='false';
    const deliveries={claim:jest.fn()},feishu={sendMessageWithReceipt:jest.fn()},overdue={scan:jest.fn()};
    await new MakitNotificationWorker(deliveries as never,feishu as never,overdue as never).tick();
    expect(deliveries.claim).not.toHaveBeenCalled(); expect(overdue.scan).not.toHaveBeenCalled();
    process.env.MAKIT_EXTERNAL_WRITES_ENABLED='false';
    await expect(new FeishuService().sendMessageWithReceipt('ou_test','open_id','post',{},'id')).rejects.toMatchObject({errorCode:'rehearsal_external_write_disabled'});
  });
  it('uses fixed payload and idempotency key and records ambiguous sends as unknown',async()=>{
    process.env.MAKIT_WORKERS_ENABLED='true';process.env.MAKIT_EXTERNAL_WRITES_ENABLED='true';
    const item={id:'delivery',leaseToken:'lease',targetId:'ou_test',payload:{receiveIdType:'open_id',type:'interactive',content:{header:'test'}},idempotencyKey:'stable-key'};
    const deliveries={claim:jest.fn(async()=>[item]),result:jest.fn(async()=>({accepted:true}))};
    const feishu={sendMessageWithReceipt:jest.fn(async()=>{throw new FeishuMessageDeliveryError('unknown','message_transport_ambiguous');})};
    await new MakitNotificationWorker(deliveries as never,feishu as never,{scan:jest.fn()} as never).tick();
    expect(feishu.sendMessageWithReceipt).toHaveBeenCalledTimes(1);
    expect(feishu.sendMessageWithReceipt).toHaveBeenCalledWith('ou_test','open_id','interactive',item.payload.content,'stable-key');
    expect(deliveries.result).toHaveBeenCalledWith({id:'delivery',leaseToken:'lease',outcome:'unknown',errorCode:'message_transport_ambiguous'});
  });
  it('relocates historical Makit files without rewriting external documents',()=>{
    const url='https://fcncvoyreb8p.feishuapp.com/app/app_17b6pxwde0x/runtime/api/v1/storage/object/bucket_test/image.png';
    expect(selfhostAssetReferences(`<img src="${url}">`)).toBe('<img src="/app/app_17b6pxwde0x/runtime/api/v1/storage/object/bucket_test/image.png">');
    expect(selfhostAssetReferences('https://fcncvoyreb8p.feishu.cn/wiki/doc')).toBe('https://fcncvoyreb8p.feishu.cn/wiki/doc');
  });
});
