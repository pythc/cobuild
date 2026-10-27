// The server is authoritative. Each operation captures an identity generation so
// late responses from a previous login cannot populate the next user's sidebar.
export function createFavoritesClient({request, onChange = () => {}, onUnauthorized = () => {}}) {
  let epoch = 0, identity = null, ready = false, pending = false, revision = 0, ids = [], error = '', queue = Promise.resolve();
  const snapshot = () => ({subject: identity?.subject || null, ready, pending, revision, favoriteAppIds: [...ids], error});
  const emit = () => onChange(snapshot());
  function accept(value) {
    if (value?.subject !== identity?.subject) throw Object.assign(new Error('登录身份已改变，正在刷新'), {status:401});
    if (!value || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.favoriteAppIds)
        || value.favoriteAppIds.some(id => typeof id !== 'string')) throw new Error('收藏数据无效');
    revision = value.revision; ids = [...new Set(value.favoriteAppIds)]; ready = true; error = '';
  }
  async function read(token) {
    const value = await request('GET', null, identity);
    if (token !== epoch) return false;
    accept(value); return true;
  }
  function enqueue(operation) {
    const token = epoch, actor = identity;
    const run = async () => {
      if (!actor || token !== epoch) return;
      pending = true; error = ''; emit();
      try { await operation(token, actor); }
      catch (e) {
        if (token !== epoch) return;
        if (e.status === 401 || e.status === 403) { setIdentity(null); onUnauthorized(e); return; }
        error = ['TimeoutError','AbortError'].includes(e?.name) || /timed?\s*out|timeout/i.test(e?.message || '')
          ? '收藏加载超时，请重试' : e?.name === 'TypeError' || /network|offline|fetch|disconnect/i.test(e?.message || '')
          ? '暂时无法连接收藏服务，请重试' : e.message || '收藏未保存，请重试';
      } finally { if (token === epoch) { pending = false; emit(); } }
    };
    queue = queue.then(run, run);
    return queue;
  }
  function refresh() { return enqueue(token => read(token)); }
  function setIdentity(actor) {
    if ((actor?.subject || null) === (identity?.subject || null) && (actor?.csrf || '') === (identity?.csrf || '')) { identity = actor; return actor && !ready && !pending ? refresh() : queue; }
    epoch++; identity = actor?.subject ? actor : null; ready = false; pending = false; revision = 0; ids = []; error = ''; queue = Promise.resolve(); emit();
    return identity ? refresh() : queue;
  }
  function setFavorite(id, selected) {
    return enqueue(async (token, actor) => {
      if (!ready && !await read(token)) return;
      for (let retry = 0; retry < 3 && token === epoch; retry++) {
        const next = selected ? [...new Set([...ids, id])] : ids.filter(value => value !== id);
        if (next.length === ids.length && next.every((v, i) => v === ids[i])) return;
        try {
          const value = await request('POST', {revision, favoriteAppIds: next}, actor);
          if (token === epoch) accept(value);
          return;
        } catch (e) {
          if (token !== epoch) return;
          if (e.status === 409) { if (!await read(token)) return; continue; }
          // A lost POST response may have committed. Reconcile without replaying
          // an entire stale list or reporting success when the intent is absent.
          if (!e.status || e.status >= 500) {
            if (!await read(token)) return;
            if (ids.includes(id) === selected) return;
          }
          throw e;
        }
      }
      if (token === epoch) throw new Error('收藏正在其他页面更新，请重试');
    });
  }
  return {snapshot, setIdentity, setFavorite, refresh};
}
