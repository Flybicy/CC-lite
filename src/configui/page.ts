
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
  .wrap { max-width:860px; margin:0 auto; padding:28px 18px 60px; }
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
  .scope-card { display:grid; grid-template-columns:120px 1fr 1fr; gap:10px; align-items:end; margin-bottom:10px; }
  .scope-name { padding-bottom:9px; font-weight:600; }
  .scope-desc { color:var(--dim); font-weight:400; font-size:12px; display:block; }
  .hint { color:var(--dim); font-size:12px; margin-top:6px; }
  .toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%); background:#1d2431; border:1px solid var(--line); color:var(--text); padding:10px 18px; border-radius:8px; opacity:0; transition:opacity .2s; pointer-events:none; max-width:80%; }
  .toast.show { opacity:1; }
  .toast.err { border-color:var(--err); color:#f0b0b0; }
  .toast.ok { border-color:var(--ok); }
  .models { margin-top:8px; color:var(--dim); font-size:12px; }
  .models code { background:#0d1017; padding:1px 6px; border-radius:4px; margin-right:4px; }
  .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:0 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1><span class="cc">CC-lite</span> 提供商配置</h1>
  <p class="sub">本页面仅在 <b>127.0.0.1</b> 本机监听，所有配置保存在本地 <code id="cfgpath">~/.claude/providers.json</code>。</p>

  <h2>模型路由（跨供应商：主模型规划 · 小模型干活）</h2>
  <div class="card">
    <div id="routes"></div>
    <div class="row" style="margin-top:8px">
      <div class="fit"><button id="saveRouting">保存路由</button></div>
      <div class="fit"><span class="hint">留空 = 该用途回退到环境变量 / 默认配置</span></div>
    </div>
  </div>

  <h2>提供商</h2>
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
const $ = id => document.getElementById(id)
const SCOPES = [
  { key:'main',     name:'主模型 main',     desc:'规划与对话主循环' },
  { key:'subagent', name:'副模型 subagent', desc:'干活：工具执行 / 子代理' },
  { key:'advisor',  name:'顾问 advisor',    desc:'复盘与建议（可选）' },
]
let CFG = { providers:[], routing:{} }

async function api(path, method, body){
  const resp = await fetch(path, {
    method: method || 'GET',
    headers: body ? {'content-type':'application/json'} : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await resp.json().catch(function(){ return {} })
  if(!resp.ok) throw new Error(data.error || ('HTTP '+resp.status))
  return data
}

function toast(msg, kind){
  const t = $('toast')
  t.textContent = msg
  t.className = 'toast show' + (kind ? ' '+kind : '')
  setTimeout(function(){ t.className='toast' }, 2600)
}

async function reload(){
  const data = await api('/api/config')
  CFG = data.config
  $('cfgpath').textContent = data.path
  renderProviders()
  renderRoutes()
}

function esc(s){ return String(s==null?'':s).replace(/[&<>"]/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c] }) }

function renderProviders(){
  const box = $('providers')
  if(!CFG.providers.length){
    box.innerHTML = '<div class="card hint">还没有提供商。使用下方表单添加，支持 OpenAI 兼容与 Anthropic 兼容接口。</div>'
    return
  }
  box.innerHTML = CFG.providers.map(function(p){
    const models = p.models && p.models.length
      ? p.models.slice(0,6).map(function(m){ return '<code>'+esc(m)+'</code>' }).join('') + (p.models.length>6 ? ' <span>+'+(p.models.length-6)+' 更多</span>' : '')
      : '<span>未拉取模型列表</span>'
    return '<div class="prov">'
      + '<span class="tag '+esc(p.type)+'">'+esc(p.type)+'</span>'
      + '<div class="meta">'
      +   '<div class="name">'+esc(p.label)+'</div>'
      +   '<div class="url">'+esc(p.baseURL)+'</div>'
      +   '<div class="models">'+models+'</div>'
      + '</div>'
      + '<button class="ghost fit" onclick="fetchSaved(\''+esc(p.id)+'\')">拉模型</button>'
      + '<button class="ghost fit" onclick="editProv(\''+esc(p.id)+'\')">编辑</button>'
      + '<button class="danger fit" onclick="delProv(\''+esc(p.id)+'\')">删除</button>'
      + '</div>'
  }).join('')
}

function renderRoutes(){
  $('routes').innerHTML = SCOPES.map(function(s){
    const r = CFG.routing[s.key] || null
    const provOpts = ['<option value="">（不指定 · 使用环境默认）</option>'].concat(
      CFG.providers.map(function(p){ return '<option value="'+esc(p.id)+'"'+(r&&r.providerId===p.id?' selected':'')+'>'+esc(p.label)+'</option>' })).join('')
    const prov = r ? CFG.providers.find(function(p){ return p.id===r.providerId }) : null
    const models = prov && prov.models ? prov.models : []
    const dl = models.map(function(m){ return '<option value="'+esc(m)+'">' }).join('')
    return '<div class="scope-card">'
      + '<div class="scope-name">'+esc(s.name)+'<span class="scope-desc">'+esc(s.desc)+'</span></div>'
      + '<div><label>提供商</label><select id="route_prov_'+s.key+'">'+provOpts+'</select></div>'
      + '<div><label>模型</label><input id="route_model_'+s.key+'" list="list_'+s.key+'" placeholder="模型名，如 gpt-4o / deepseek-chat" value="'+(r?esc(r.model):'')+'">'
      + '<datalist id="list_'+s.key+'">'+dl+'</datalist></div>'
      + '</div>'
  }).join('')
}

watchProvSelect = null
async function fetchSaved(id){
  try{
    const data = await api('/api/providers/'+encodeURIComponent(id)+'/fetch-models','POST')
    await reload()
    toast('拉取到 '+data.models.length+' 个模型','ok')
  }catch(e){ toast('拉取失败: '+e.message,'err') }
}

async function delProv(id){
  const p = CFG.providers.find(function(x){ return x.id===id })
  if(!confirm('删除提供商 "'+(p?p.label:id)+'"？其路由绑定也会一并移除。')) return
  try{ await api('/api/providers/'+encodeURIComponent(id),'DELETE'); await reload(); toast('已删除','ok') }
  catch(e){ toast('删除失败: '+e.message,'err') }
}

function editProv(id){
  const p = CFG.providers.find(function(x){ return x.id===id })
  if(!p) return
  $('editorTitle').textContent = '编辑提供商：'+p.label
  $('f_id').value = p.id
  $('f_label').value = p.label
  $('f_type').value = p.type
  $('f_base').value = p.baseURL
  $('f_key').value = ''
  $('f_key').placeholder = '留空表示不修改现有 Key'
  $('fetched').innerHTML = ''
  window.scrollTo({top:document.body.scrollHeight, behavior:'smooth'})
}

async function saveProv(){
  const body = { id:$('f_id').value||undefined, label:$('f_label').value, type:$('f_type').value, baseURL:$('f_base').value, apiKey:$('f_key').value }
  try{
    await api('/api/providers','POST',body)
    clearForm()
    $('editorTitle').textContent='添加提供商'
    await reload(); toast('已保存','ok')
  }catch(e){ toast('保存失败: '+e.message,'err') }
}

async function fetchPreview(){
  const body = { type:$('f_type').value, baseURL:$('f_base').value, apiKey:$('f_key').value }
  $('fetchModels').disabled = true
  try{
    const data = await api('/api/fetch-models-direct','POST',body)
    $('fetched').innerHTML = data.models.length
      ? '拉取到 '+data.models.length+' 个模型：'+data.models.slice(0,20).map(function(m){ return '<code>'+esc(m)+'</code>' }).join('')+(data.models.length>20?' …':'')
      : '提供商未返回模型列表（不影响保存，模型名可手填）'
    toast('拉取成功','ok')
  }catch(e){ $('fetched').innerHTML=''; toast('拉取失败: '+e.message,'err') }
  finally{ $('fetchModels').disabled = false }
}

async function saveRouting(){
  const body = {}
  for(const s of SCOPES){
    const pid = $('route_prov_'+s.key).value
    const model = $('route_model_'+s.key).value.trim()
    body[s.key] = pid ? { providerId:pid, model:model } : null
  }
  try{ await api('/api/routing','PUT',body); await reload(); toast('路由已保存，下一次请求即生效','ok') }
  catch(e){ toast('保存失败: '+e.message,'err') }
}

function clearForm(){ $('f_id').value=''; $('f_label').value=''; $('f_base').value=''; $('f_key').value=''; $('fetched').innerHTML='' }

$('saveProv').onclick = saveProv
$('fetchModels').onclick = fetchPreview
$('cancelEdit').onclick = function(){ clearForm(); $('editorTitle').textContent='添加提供商' }
$('saveRouting').onclick = saveRouting
reload()
</script>
</body>
</html>
`;
