import React, { useEffect, useState } from 'react';
const money = value => typeof value === 'number' ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6 }).format(value) : 'Unavailable';
const number = value => typeof value === 'number' ? value.toLocaleString() : 'Unavailable';
export function UsagePage({ project }) {
  const [data, setData] = useState(null), [error, setError] = useState(''), [all, setAll] = useState(false);
  async function refresh() {
    try { const response = await fetch('/api/usage'); if (!response.ok) throw new Error('Could not load usage.'); setData(await response.json()); setError(''); } catch (e) { setError(e.message); }
  }
  useEffect(() => { refresh(); }, []);
  const rows = (data?.records || []).filter(r => all || !project || r.project === project).sort((a, b) => b.at.localeCompare(a.at));
  const routing = rows.filter(r => r.provider === 'openrouter'), codex = rows.filter(r => r.provider === 'codex');
  const account = data?.accounts?.openrouter, limits = data?.accounts?.codex?.limits;
  return <section className="usage-page" aria-label="Usage reporting">
    <div className="usage-heading"><div><h2>Usage & costs</h2><p>{project && !all ? project : 'All projects and General'}</p></div><div>{project && <label><input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)} /> All projects</label>} <button onClick={refresh}>Refresh</button></div></div>
    {error && <p role="alert">{error}</p>}
    {!data ? <p>Loading usage…</p> : <>
      <div className="usage-cards"><article><small>Recorded JEV cost</small><strong>{money(routing.reduce((sum, r) => sum + (r.cost || 0), 0))}</strong><span>{routing.length} requests · {routing.filter(r => r.cost == null).length} with unavailable cost</span></article>
      <article><small>Observed Codex thread tokens</small><strong>{number(codex.reduce((sum, r) => sum + (r.tokens?.totalTokens || 0), 0))}</strong><span>Dollar cost unavailable from Codex</span></article>
      <article><small>OpenRouter key spend · all apps</small><strong>{money(account?.usage)}</strong><span>Today {money(account?.usage_daily)} · month {money(account?.usage_monthly)}</span><span>Key allowance remaining: {money(account?.limit_remaining)}</span>{!account?.available && <span>{account?.reason}</span>}</article></div>
      <div className="usage-limits"><h3>Codex account limits</h3>{!limits && <p>Account limits are unavailable for this login.</p>}{[['primary', 'Primary window'], ['secondary', 'Secondary window']].map(([key, title]) => limits?.[key] && <div key={key}><span>{title}: {limits[key].usedPercent}% used{limits[key].resetsAt ? ' · resets ' + new Date(limits[key].resetsAt * 1000).toLocaleString() : ''}</span><progress max="100" value={limits[key].usedPercent} /></div>)}</div>
      <p className="usage-note">JEV requests are recorded from now on. Codex totals are the latest cumulative snapshot for each observed thread, including earlier history in resumed threads; snapshots are never added together. Subagent tokens appear when Codex sends their usage updates. Account spend includes other apps using this key. Subscription usage has no reported per-task dollar price.</p>
      <div className="usage-table"><table><thead><tr><th>Updated</th><th>Provider / model</th><th>Project / latest task</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{new Date(r.at).toLocaleString()}</td><td>{r.provider === 'codex' ? 'Codex thread' : 'OpenRouter request'}<small>{r.model}</small></td><td>{r.project?.split('/').filter(Boolean).at(-1) || 'General / unassigned'}<small>{r.task}</small></td><td>{r.tokens ? <>{number(r.tokens.totalTokens)}<small>Input {number(r.tokens.inputTokens)} · cached {number(r.tokens.cachedInputTokens)} · output {number(r.tokens.outputTokens)}</small></> : number(typeof r.inputTokens === 'number' && typeof r.outputTokens === 'number' ? r.inputTokens + r.outputTokens : undefined)}</td><td>{money(r.cost)}</td></tr>)}</tbody></table>{!rows.length && <p>No usage recorded yet. Run a task to start tracking.</p>}</div>
    </>}
  </section>;
}
