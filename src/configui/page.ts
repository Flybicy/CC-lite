
export const CONFIG_UI_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CC-lite 提供商配置</title>
<style>
  :root { --accent:#5b8def; --bg:#0f1117; --panel:#171b24; --line:#262b38; --text:#dbe2ee; --dim:#8a93a6; --ok:#4bbf6b; --err:#e06060; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:14px/1.5 -apple-system,"Segoe UI",Roboto,"Microsoft YaHei",sans-serif; }
  .wrap { max-width:900px; margin:0 auto; padding:28px 18px 60px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h1 .cc { color:var(--accent); }
  .sub { color:var(--dim); margin:0 0 22px; }
  h2 { font-size:15px; margin:26px 0 10px; color:var(--text); }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:12px; }
  label { display:block; color:var(--dim); font-size:12px; margin:10px 0 4px; }
  input, select { width:100%; background:#0d1017; border:1px solid var(--line); color:var(--text); border-radius:6px; padding:8px 10px; font-size:13px; }
  input:focus, select:focus { outline:none; border-color:var(--accent); }
  button { background:var(--accent); border:none; color:#fff; border-radius:6px; padding:8px 14px; font-size:13px; cursor:pointer; }
  button.ghost { background:transparent; border:1px solid var(--line); color:var(--text); }
  button.danger { background:transparent; border:1px solid var(--err); color:var(--err); }
  button:disabled { opacity:.45; cursor:not-allowed; }
  .row { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .row > * { flex:1; }
  .row > .fit { flex:0 0 auto; }
  .prov { display:flex; align-items:center; gap:12px; padding:10px 12px; border:1px solid var(--line); border-radius:8px; margin-bottom:8px; background:#141820; }
  .prov .meta { flex:1; min-width:0; }
  .prov .name { font-weight:600; }
  .prov .url { color:var(--dim); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tag { font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--line); color:var(--dim); }
  .tag.openai { color:#7fd0a0; border-color:#2c4a38; }
  .tag.anthropic { color:#e2a86b; border-color:#4a3a28; }
  .tier-card { display:grid; grid-template-columns:150px 1fr 1fr; gap:10px; align-items:end; margin-bottom:10px; }
  .tier-name { padding-bottom:9px; font-weight:600; }
  .tier-code { color:var(--accent); font-family:ui-monospace,Menlo,Consolas,monospace; }
  .tier-desc { color:var(--dim); font-weight:400; font-size:12px; display:block; }
  .hint { color:var(--dim); font-size:12px; margin-top:6px; }
  .toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#1d2431; border:1px solid var(--line); color:var(--text); padding:10px 18px; border-radius:8px; opacity:0; transition:opacity .2s; pointer-events:none; max-width:80%; }
  .toast.show { opacity:1; }
  .toast.err { border-color:var(--err); color:#f0b0b0; }
  .toast.ok { border-color:var(--ok); }
  .models { margin-top:8px; color:var(--dim); font-size:12px; }
  .models code { background:#0d1017; padding:1px 6px; border-radius:4px; margin-right:4px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:0 12px; }
  .empty { color:var(--dim); font-size:13px; padding:6px 2px 10px; }
</style>
</head>
<body>
<div class="wrap">
  <h1><span class="cc">CC-lite</span> 提供商配置</h1>
  <p class="sub">本页面仅在 <b>127.0.0.1</b> 本机监听，所有配置保存在本地 <code id="cfgpath">~/.claude/providers.json</code>。
  保存后<b>下一次请求立即生效</b>，无需重启 cclite。</p>

  <h2>三档模型（调用代号 <span class="tier-code">pro</span> / <span class="tier-code">plus</span> / <span class="tier-code">se</span>）</h2>
  <p class="sub" style="margin-top:-6px">请求失败（超时 / 5xx / 429）时自动顺位降级 <b>pro → plus → se</b>，成功后下一轮自动换回高挡（最多自动降级 5 次）；余额不足 / 额度用尽会直接换到低档且<b>不再切回</b>，充值后用 <code>/model</code> 手动切换。也可在对话里用 <code>/model pro</code> / <code>/model plus</code> / <code>/model se</code> 随时手动指定。</p>
  <div class="card">
    <div id="tiers"></div>
    <div class="row" style="margin-top:8px">
      <div class="fit"><button id="saveTiers">保存三档</button></div>
      <div class="fit"><span class="hint">留空 = 该档回退到环境变量 / 内置默认</span></div>
    </div>
  </div>

  <h2>提供商（可保存多个）</h2>
  <div id="providers"></div>

  <div class="card" id="editor">
    <h2 style="margin-top:0" id="editorTitle">添加提供商</h2>
    <input type="hidden" id="f_id">
    <div class="grid2">
      <div><label>名称</label><input id="f_label" placeholder="例如 DeepSeek / 本地 Ollama"></div>
      <div><label>类型</label><select id="f_type">
        <option value="openai">OpenAI 兼容（含 Ollama / LM Studio / DeepSeek / OpenRouter…）</option>
        <option value="anthropic">Anthropic 兼容</option>
      </select></div>
    </div>
    <label>Base URL</label><input id="f_base" placeholder="http://127.0.0.1:11434/v1">
    <label>API Key（本地服务可留空）</label><input id="f_key" type="password" placeholder="sk-…（留空表示不修改）">
    <div class="row" style="margin-top:14px">
      <div class="fit"><button id="fetchModels">拉取模型列表</button></div>
      <div class="fit"><button id="saveProv">保存提供商</button></div>
      <div class="fit"><button class="ghost" id="cancelEdit">清空表单</button></div>
    </div>
    <div class="models" id="fetched"></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
const TIERS = [
  { key:'pro',  name:'pro',  desc:'主模型 · 规划与主循环，建议最强模型' },
  { key:'plus', name:'plus', desc:'中档 · Advisor 复盘 / 第二意见' },
  { key:'se',   name:'se',   desc:'经济档 · 子代理与工具干活，建议便宜或本地模型' }
]
var CFG = { providers:[], tiers:{} }

function \$(id){ return document.getElementById(id) }
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){
  return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
}) }

var toastTimer = null
function toast(msg, kind){
  const el = \$('toast')
  el.textContent = msg
  el.className = 'toast show' + (kind ? ' ' + kind : '')
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(function(){ el.className = 'toast' }, 3200)
}

async function api(path, method, body){
  const resp = await fetch(path, {
    method: method || 'GET',
    headers: body ? { 'content-type':'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  })
  const data = await resp.json().catch(function(){ return null })
  if (!resp.ok) throw new Error((data && data.error) || ('HTTP ' + resp.status))
  return data
}

async function reload(){
  const data = await api('/api/config')
  CFG = data.config
  CFG.providers = CFG.providers || []
  CFG.tiers = CFG.tiers || {}
  \$('cfgpath').textContent = data.path
  renderProviders()
  renderTiers()
}

function renderProviders(){
  if (!CFG.providers.length){
    \$('providers').innerHTML = '<div class="empty">还没有提供商。在下面的表单里添加第一个。</div>'
    return
  }
  \$('providers').innerHTML = CFG.providers.map(function(p){
    const models = p.models && p.models.length
      ? p.models.slice(0,6).map(function(m){ return '<code>'+esc(m)+'</code>' }).join('') + (p.models.length>6 ? ' <span>+'+(p.models.length-6)+' 更多</span>' : '')
      : '<span>未拉取模型列表</span>'
    const bound = TIERS.filter(function(t){ return CFG.tiers[t.key] && CFG.tiers[t.key].providerId === p.id })
      .map(function(t){ return t.key }).join(' / ')
    return '<div class="prov">'
      + '<span class="tag '+esc(p.type)+'">'+esc(p.type)+'</span>'
      + '<div class="meta">'
      +   '<div class="name">'+esc(p.label)+(bound ? ' <span class="tier-code">['+esc(bound)+']</span>' : '')+'</div>'
      +   '<div class="url">'+esc(p.baseURL)+'</div>'
      +   '<div class="models">'+models+'</div>'
      + '</div>'
      + '<button class="ghost fit" data-act="fetch" data-id="'+esc(p.id)+'">拉模型</button>'
      + '<button class="ghost fit" data-act="edit" data-id="'+esc(p.id)+'">编辑</button>'
      + '<button class="danger fit" data-act="del" data-id="'+esc(p.id)+'">删除</button>'
      + '</div>'
  }).join('')
}

function modelOptionsFor(providerId){
  const prov = CFG.providers.find(function(p){ return p.id === providerId })
  const models = (prov && prov.models) || []
  return models.map(function(m){ return '<option value="'+esc(m)+'">' }).join('')
}

function renderTiers(){
  \$('tiers').innerHTML = TIERS.map(function(t){
    const b = CFG.tiers[t.key] || null
    const provOpts = ['<option value="">（不指定 · 回退环境默认）</option>'].concat(
      CFG.providers.map(function(p){
        return '<option value="'+esc(p.id)+'"'+(b && b.providerId === p.id ? ' selected' : '')+'>'+esc(p.label)+'</option>'
      })).join('')
    return '<div class="tier-card">'
      + '<div class="tier-name"><span class="tier-code">'+esc(t.name)+'</span><span class="tier-desc">'+esc(t.desc)+'</span></div>'
      + '<div><label>提供商</label><select id="tier_prov_'+t.key+'" data-tier="'+t.key+'">'+provOpts+'</select></div>'
      + '<div><label>模型</label><input id="tier_model_'+t.key+'" list="list_'+t.key+'" placeholder="模型名，如 gpt-4o / deepseek-chat" value="'+(b ? esc(b.model) : '')+'">'
      + '<datalist id="list_'+t.key+'">'+modelOptionsFor(b ? b.providerId : '')+'</datalist></div>'
      + '</div>'
  }).join('')
  // Keep the model datalist in sync with the selected provider, and clear a
  // stale model name when it does not belong to the newly picked provider.
  TIERS.forEach(function(t){
    \$('tier_prov_'+t.key).onchange = function(){
      const pid = this.value
      \$('list_'+t.key).innerHTML = modelOptionsFor(pid)
      const box = \$('tier_model_'+t.key)
      if (!pid){ box.value = ''; return }
      const prov = CFG.providers.find(function(p){ return p.id === pid })
      const models = (prov && prov.models) || []
      if (box.value && models.length && models.indexOf(box.value) === -1) box.value = ''
    }
  })
}

async function fetchSaved(id){
  try{
    const data = await api('/api/providers/'+encodeURIComponent(id)+'/fetch-models','POST')
    await reload()
    toast('拉取到 '+data.models.length+' 个模型','ok')
  }catch(e){ toast('拉取失败: '+e.message,'err') }
}

async function delProv(id){
  const p = CFG.providers.find(function(x){ return x.id === id })
  if(!confirm('删除提供商 "'+(p?p.label:id)+'"？其档位绑定也会一并移除。')) return
  try{ await api('/api/providers/'+encodeURIComponent(id),'DELETE'); await reload(); toast('已删除','ok') }
  catch(e){ toast('删除失败: '+e.message,'err') }
}

function editProv(id){
  const p = CFG.providers.find(function(x){ return x.id === id })
  if(!p) return
  \$('editorTitle').textContent = '编辑提供商：'+p.label
  \$('f_id').value = p.id
  \$('f_label').value = p.label
  \$('f_type').value = p.type
  \$('f_base').value = p.baseURL
  \$('f_key').value = ''
  \$('f_key').placeholder = '留空表示不修改现有 Key'
  \$('fetched').innerHTML = ''
  \$('editor').scrollIntoView({ behavior:'smooth', block:'center' })
}

\$('providers').onclick = function(ev){
  const btn = ev.target.closest('button[data-act]')
  if (!btn) return
  const id = btn.getAttribute('data-id')
  const act = btn.getAttribute('data-act')
  if (act === 'fetch') void fetchSaved(id)
  else if (act === 'edit') editProv(id)
  else if (act === 'del') void delProv(id)
}

async function saveProv(){
  const body = { id:\$('f_id').value||undefined, label:\$('f_label').value, type:\$('f_type').value, baseURL:\$('f_base').value, apiKey:\$('f_key').value }
  try{
    await api('/api/providers','POST',body)
    clearForm()
    \$('editorTitle').textContent='添加提供商'
    await reload(); toast('已保存','ok')
  }catch(e){ toast('保存失败: '+e.message,'err') }
}

async function fetchPreview(){
  const body = { id:\$('f_id').value||undefined, type:\$('f_type').value, baseURL:\$('f_base').value, apiKey:\$('f_key').value }
  \$('fetchModels').disabled = true
  try{
    const data = await api('/api/fetch-models-direct','POST',body)
    \$('fetched').innerHTML = data.models.length
      ? '拉取到 '+data.models.length+' 个模型：'+data.models.slice(0,20).map(function(m){ return '<code>'+esc(m)+'</code>' }).join('')+(data.models.length>20?' …':'')
      : '提供商未返回模型列表（不影响保存，模型名可手填）'
    toast('拉取成功','ok')
  }catch(e){ \$('fetched').innerHTML=''; toast('拉取失败: '+e.message,'err') }
  finally{ \$('fetchModels').disabled = false }
}

async function saveTiers(){
  const body = {}
  for (const t of TIERS){
    const pid = \$('tier_prov_'+t.key).value
    const model = \$('tier_model_'+t.key).value.trim()
    if (pid && !model){ toast(t.key + ' 选了提供商，请填模型名','err'); return }
    body[t.key] = pid ? { providerId:pid, model:model } : null
  }
  try{ await api('/api/tiers','PUT',body); await reload(); toast('三档已保存，下一次请求即生效','ok') }
  catch(e){ toast('保存失败: '+e.message,'err') }
}

function clearForm(){
  \$('f_id').value=''; \$('f_label').value=''; \$('f_base').value=''; \$('f_key').value=''
  \$('f_key').placeholder='sk-…（留空表示不修改）'; \$('fetched').innerHTML=''
}

\$('saveProv').onclick = saveProv
\$('fetchModels').onclick = fetchPreview
\$('cancelEdit').onclick = function(){ clearForm(); \$('editorTitle').textContent='添加提供商' }
\$('saveTiers').onclick = saveTiers
reload().catch(function(e){ toast('读取配置失败: '+e.message,'err') })
</script>
</body>
</html>
`;