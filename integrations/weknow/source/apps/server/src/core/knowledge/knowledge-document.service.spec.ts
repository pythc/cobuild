import { KnowledgeDocumentService } from './knowledge-document.service';

describe('knowledge document read metadata consistency', () => {
  const principal: any = { user: { id: 'owner' }, workspace: { id: 'workspace' } };
  function fixture() {
    let page: any = { id: 'doc', workspaceId: 'workspace', updatedAt: new Date(1000), title: 'Created', content: { type: 'doc', content: [] }, slugId: 'slug' };
    const pages = { findById: jest.fn(async () => ({ ...page })), updatePage: jest.fn(async (changes: any) => { page = { ...page, ...changes, updatedAt: new Date(3000) }; }) };
    const access = { validateCanView: jest.fn(), validateCanEdit: jest.fn(), validateCanViewWithPermissions: jest.fn(async () => ({ canEdit: true })) };
    const collab = { handleYjsEvent: jest.fn(async () => { page = { ...page, updatedAt: new Date(2000) }; return { content: { type: 'doc', content: [] }, revision: 'live-revision' }; }) };
    const db = { transaction: () => ({ execute: (fn: any) => fn({}) }) };
    const service = new KnowledgeDocumentService(pages as any, {} as any, access as any, collab as any, db as any);
    return { service, pages, access, mutate: (changes: any) => { page = { ...page, ...changes }; } };
  }
  it('first get returns the durable post-initialization timestamp usable by metadata', async () => {
    const f = fixture();
    const read = await f.service.get({ pageId: 'doc', format: 'json', maxCharacters: 10000 }, principal);
    expect(read.updatedAt).toEqual(new Date(2000));
    await expect(f.service.metadata({ pageId: 'doc', expectedUpdatedAt: read.updatedAt, title: 'Renamed' }, principal)).resolves.toMatchObject({ title: 'Renamed' });
  });
  it('still rejects an actual concurrent metadata edit', async () => {
    const f = fixture();
    const read = await f.service.get({ pageId: 'doc', format: 'json', maxCharacters: 10000 }, principal);
    f.mutate({ updatedAt: new Date(2500) });
    await expect(f.service.metadata({ pageId: 'doc', expectedUpdatedAt: read.updatedAt, title: 'Stale' }, principal)).rejects.toThrow('metadata_conflict');
    expect(f.pages.updatePage).not.toHaveBeenCalled();
  });
  it('rechecks access after collaborative read before returning content', async () => {
    const f = fixture();
    f.access.validateCanView.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error('permission revoked'); });
    await expect(f.service.read('doc', principal)).rejects.toThrow('permission revoked');
    expect(f.access.validateCanViewWithPermissions).not.toHaveBeenCalled();
  });
});
