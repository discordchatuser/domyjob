export function modelCatalog(rpc) {
  let pending;
  return () => {
    if (!pending) pending = (async () => {
      const models = [], seen = new Set();
      let cursor;
      do {
        if (cursor && seen.has(cursor)) throw new Error('Codex model catalog repeated a page.');
        if (cursor) seen.add(cursor);
        const page = await rpc.request('model/list', { includeHidden: false, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(page.data)) throw new Error('Invalid Codex model catalog.');
        models.push(...page.data.filter(item => item && typeof item.model === 'string' && item.model));
        cursor = page.nextCursor;
      } while (cursor);
      const unique = [...new Map(models.map(item => [item.model, item])).values()];
      if (!unique.length) throw new Error('Codex did not advertise any available models.');
      return unique;
    })();
    return pending;
  };
}
