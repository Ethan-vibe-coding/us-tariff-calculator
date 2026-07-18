/* ============================================================
 * 数据更新中心引擎
 * 数据源：① 联邦公报API（浏览器直连，CORS开放）
 *         ② USITC HTS接口（经公共代理尝试；失败时走文件导入）
 *         ③ 官方文件导入比对（用户点击官网链接下载后拖入页面，本地比对）
 * 比对基准：HTS 2026HTSRev11（2026-07-18），常量 HTS_REV / C99SNAP / FP99
 * ============================================================ */
const UPD = { fr:null, rev:null, c99:null, notes:null, mfn:null, mfnRemote:null, applied:false };

/* ---------- 工具 ---------- */
function fnv1a(s){ let x=0x811c9dc5; for(let i=0;i<s.length;i++){ x^=s.charCodeAt(i); x=Math.imul(x,0x01000193)>>>0; } return ('0000000'+x.toString(16)).slice(-8); }
function stripTags(t){ return t.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function nowStr(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
function ulog(msg, cls){
  const box = document.getElementById('updConsole'); if(!box) return;
  const line = document.createElement('div'); line.className = 'uline ' + (cls||'');
  line.innerHTML = '<span class="utime">'+nowStr()+'</span> ' + msg;
  box.appendChild(line); box.scrollTop = box.scrollHeight;
}
function pctOf(txt){
  const m = String(txt||'').match(/([\d.]+)\s*%/);
  return m ? m[1]+'%' : (String(txt||'').slice(0,40) || '—');
}

/* ---------- 网络 ---------- */
async function fetchText(url, timeoutMs){
  const ctrl = new AbortController(); const t = setTimeout(()=>ctrl.abort(), timeoutMs||15000);
  try{
    const r = await fetch(url, {signal: ctrl.signal});
    clearTimeout(t);
    if(!r.ok) throw new Error('HTTP '+r.status);
    return await r.text();
  }catch(e){ clearTimeout(t); throw e; }
}
/* USITC屏蔽浏览器跨域直连，按代理链依次尝试 */
const PROXIES = [
  {name:'直连',     wrap:u=>u},
  {name:'AllOrigins', wrap:u=>'https://api.allorigins.win/raw?url='+encodeURIComponent(u)},
  {name:'CodeTabs', wrap:u=>'https://api.codetabs.com/v1/proxy?quest='+encodeURIComponent(u)}
];
async function fetchViaProxies(url){
  let lastErr = null;
  for(const p of PROXIES){
    try{
      const txt = await fetchText(p.wrap(url), 12000);
      if(txt && txt.length>10 && txt.charAt(0)!=='<') return {txt, via:p.name};
      lastErr = new Error(p.name+'返回无效内容');
    }catch(e){ lastErr = e; }
  }
  throw (lastErr||new Error('全部代理失败'));
}

/* ---------- ① 联邦公报最新文件检查（浏览器直连） ---------- */
const FR_QUERIES = [
  {key:'s232',  name:'232措施',            term:'Section 232 tariff'},
  {key:'s301',  name:'301措施',            term:'Section 301 China tariff'},
  {key:'s122',  name:'Section 122附加税',  term:'Section 122 balance-of-payments'},
  {key:'ieepa', name:'IEEPA关税（退税）',  term:'IEEPA tariff'},
  {key:'s201',  name:'201保障措施',        term:'Section 201 safeguard'},
  {key:'uflpa', name:'UFLPA强迫劳动',      term:'UFLPA forced labor'}
];
async function checkFR(){
  const base = META.base_date;
  const out = [];
  for(const q of FR_QUERIES){
    const url = 'https://www.federalregister.gov/api/v1/documents.json?per_page=3&order=newest'
      + '&conditions%5Bterm%5D=' + encodeURIComponent(q.term)
      + '&fields%5B%5D=title&fields%5B%5D=publication_date&fields%5B%5D=document_number&fields%5B%5D=html_url&fields%5B%5D=type';
    try{
      const txt = await fetchText(url, 15000);
      const docs = (JSON.parse(txt).results||[]).map(r=>({
        date:r.publication_date, type:r.type, title:r.title,
        num:r.document_number, url:r.html_url, isNew: r.publication_date > base
      }));
      out.push({q:q.name, ok:true, docs});
      const newN = docs.filter(d=>d.isNew).length;
      ulog('联邦公报 · '+esc(q.name)+'：获取最新'+docs.length+'份文件'+(newN?('，<b class="warn">其中 '+newN+' 份发布于基准日之后</b>'):'（均无晚于基准日）'), newN?'w':'ok');
    }catch(e){
      out.push({q:q.name, ok:false, err:String(e)});
      ulog('联邦公报 · '+esc(q.name)+'：查询失败（'+esc(e.message||e)+'）','err');
    }
  }
  UPD.fr = out;
}

/* ---------- ② USITC HTS修订版检查（代理链尝试） ---------- */
async function checkRev(){
  ulog('正在尝试连接 hts.usitc.gov 查询当前HTS修订版（USITC限制浏览器跨域，将依次尝试公共代理）…');
  try{
    const {txt, via} = await fetchViaProxies('https://hts.usitc.gov/reststop/currentRelease');
    const j = JSON.parse(txt);
    const same = (j.name === HTS_REV);
    UPD.rev = {ok:true, name:j.name, desc:j.description, via, same};
    ulog('HTS当前修订版：<b>'+esc(j.description||j.name)+'</b>（经'+via+'获取）｜本地基准：'+HTS_REV+' → '+(same?'<b class="ok">一致，基础数据为最新</b>':'<b class="warn">不一致！官方已发布新修订版，请执行下方“官方文件导入比对”更新数据</b>'), same?'ok':'w');
  }catch(e){
    UPD.rev = {ok:false, err:String(e)};
    ulog('USITC在线接口暂时无法从浏览器连通（USITC跨域限制＋公共代理不稳定）。<b>不影响更新</b>：请改用下方“官方文件导入比对”，两个点击即可完成。','err');
  }
}

/* ---------- 自动检查主入口 ---------- */
let _checking = false;
async function runAutoCheck(){
  if(_checking) return; _checking = true;
  const btn = document.getElementById('btnCheck'); if(btn){ btn.disabled = true; btn.textContent = '检查中…'; }
  document.getElementById('updConsole').innerHTML = '';
  ulog('开始检查｜数据基准日 '+META.base_date+'（'+HTS_REV+'）…');
  await checkFR();
  await checkRev();
  renderUpdSummary();
  localStorage.setItem('utd_last_check', nowStr());
  showLastCheck();
  ulog('自动检查完成。如需逐项更新税目与税率，请继续使用下方“官方文件导入比对”。','ok');
  if(btn){ btn.disabled = false; btn.textContent = '检查官方最新动态'; }
  _checking = false;
}
function renderUpdSummary(){
  const box = document.getElementById('updSummary'); if(!box) return;
  let html = '';
  if(UPD.fr){
    const rows = [];
    for(const r of UPD.fr){
      if(!r.ok){ rows.push('<tr><td>'+esc(r.q)+'</td><td colspan="2" class="err">查询失败</td></tr>'); continue; }
      const news = r.docs.filter(d=>d.isNew);
      if(!news.length){
        rows.push('<tr><td>'+esc(r.q)+'</td><td class="ok">无基准日后新文件</td><td>最新：'+esc(r.docs[0]?r.docs[0].date:'—')+'</td></tr>');
      }else{
        for(const d of news){
          rows.push('<tr class="newdoc"><td>'+esc(r.q)+'</td><td class="warn">新文件 '+esc(d.date)+'</td><td><a href="'+esc(d.url)+'" target="_blank" rel="noopener">'+esc(d.title)+'</a>（'+esc(d.type)+' '+esc(d.num)+'）</td></tr>');
        }
      }
    }
    html += '<h3>联邦公报检查结论（基准日 '+META.base_date+' 之后发布即标注）</h3><table class="utab"><thead><tr><th>措施</th><th>结论</th><th>说明/链接</th></tr></thead><tbody>'+rows.join('')+'</tbody></table>';
    const totalNew = UPD.fr.reduce((s,r)=>s+(r.ok?r.docs.filter(d=>d.isNew).length:0),0);
    html += totalNew
      ? '<p class="warn" style="margin-top:8px">检测到 '+totalNew+' 份基准日后新发布的官方文件，请逐份核对是否影响本库税率与清单；确认影响后执行下方文件导入更新。</p>'
      : '<p class="ok" style="margin-top:8px">联邦公报无基准日后新文件：各项措施暂无新官方公告。</p>';
  }
  box.innerHTML = html;
}

/* ---------- ③ 官方文件导入比对 ---------- */
function onUpdDrop(ev){
  ev.preventDefault(); ev.stopPropagation();
  document.getElementById('dropzone').classList.remove('hover');
  const f = ev.dataTransfer.files && ev.dataTransfer.files[0];
  if(f) readImpFile(f);
}
function onUpdPick(input){ const f = input.files && input.files[0]; if(f) readImpFile(f); input.value=''; }
function readImpFile(f){
  const rd = new FileReader();
  rd.onload = ()=> routeImpFile(f.name, String(rd.result||''));
  rd.onerror = ()=> impLog('文件读取失败','err');
  rd.readAsText(f);
}
function impLog(msg, cls){
  const box = document.getElementById('impConsole'); if(!box) return;
  const line = document.createElement('div'); line.className='uline '+(cls||'');
  line.innerHTML = '<span class="utime">'+nowStr()+'</span> '+msg;
  box.appendChild(line); box.scrollTop = box.scrollHeight;
}
function routeImpFile(name, text){
  impLog('已接收文件 <b>'+esc(name)+'</b>（'+(text.length/1048576).toFixed(2)+' MB），识别类型…');
  const t = text.trim();
  if(t.charAt(0)==='<'){
    importNotesHtml(t, name); return;
  }
  try{
    const j = JSON.parse(t);
    if(!Array.isArray(j)) throw new Error('非数组JSON');
    const has99 = j.some(x=>String(x.htsno||'').indexOf('99')===0);
    const has197 = j.some(x=>{ const h=String(x.htsno||''); return h && h.slice(0,2)!=='99'; });
    if(has99 && !has197) importCh99Json(j, name);
    else if(has197) importFullJson(j, name);
    else importCh99Json(j, name);
  }catch(e){
    impLog('无法识别文件类型：既不是第99章注释HTML，也不是exportList JSON（'+esc(e.message||e)+'）。请确认从页面给出的官方链接下载原文件。','err');
  }
}

/* —— A. 第99章税目JSON比对：捕捉措施新增/废止/税率变化 —— */
function importCh99Json(j, name){
  const remote = {};
  for(const x of j){
    const h = String(x.htsno||'');
    if(h.indexOf('9903')===0 && String(x.general||'').trim()) remote[h]=String(x.general);
  }
  const news=[], gone=[], changed=[];
  for(const h in remote){
    if(!(h in C99SNAP)) news.push(h);
    else if(remote[h].replace(/\s+/g,' ').trim() !== String(C99SNAP[h]).replace(/\s+/g,' ').trim()) changed.push(h);
  }
  for(const h in C99SNAP) if(!(h in remote)) gone.push(h);
  UPD.c99 = {remote, news, gone, changed, fname:name};
  impLog('第99章税目比对完成：远端 '+Object.keys(remote).length+' 个9903税目 ｜ 新增 <b>'+news.length+'</b> ｜ 消失 <b>'+gone.length+'</b> ｜ 税率/措辞变化 <b>'+changed.length+'</b>', (news.length||gone.length||changed.length)?'w':'ok');
  if(news.length) impLog('新增税目（可能为新措施）：'+news.map(h=>esc(h)+'（'+esc(pctOf(remote[h]))+'）').join('、'),'w');
  if(gone.length)  impLog('消失税目（可能已废止）：'+gone.map(h=>esc(h)+'（原'+esc(pctOf(C99SNAP[h]))+'）').join('、'),'w');
  if(changed.length) impLog('发生变化：'+changed.map(h=>esc(h)+'：'+esc(pctOf(C99SNAP[h]))+' → '+esc(pctOf(remote[h]))).join('；'),'w');
  if(!news.length && !gone.length && !changed.length) impLog('第99章税目与本地基准（'+HTS_REV+'）完全一致，措施层面无变化。','ok');
  renderImpResult();
}

/* —— B. 第99章注释HTML指纹比对：捕捉清单覆盖范围变化 —— */
function notesFingerprint(html){
  const i3 = html.indexOf('SUBCHAPTER III');
  if(i3<0) throw new Error('未找到第三分章标记，文件可能不完整');
  const sub = html.slice(i3);
  const re = /value='\s*(\d+)\.'/g; const marks=[]; let m;
  while((m=re.exec(sub))!==null) marks.push([m[1], i3+m.index]);
  const fp = {};
  for(let i=0;i<marks.length;i++){
    const n = marks[i][0];
    if(!(n in FP99) || (n in fp)) continue;
    const end = (i+1<marks.length)? marks[i+1][1] : html.length;
    const blk = stripTags(html.slice(marks[i][1], end));
    const n8 = (blk.match(/\d{4}\.\d{2}\.\d{2}(?!\d)/g)||[]).length;
    const n10 = (blk.match(/\d{4}\.\d{2}\.\d{4}/g)||[]).length;
    fp[n] = [n8, n10, blk.length, fnv1a(blk)];
  }
  return fp;
}
const NOTE_NAMES = {'2':'注释2（122附加税及例外清单）','16':'注释16（232金属）','20':'注释20（301清单1-4A）','31':'注释31（301战略产业）','33':'注释33（232汽车/卡车）','37':'注释37（232木材/家具）','38':'注释38（232半导体等）','39':'注释39（232机电设备）'};
function importNotesHtml(text, name){
  try{
    const fp = notesFingerprint(text);
    const diffs = [];
    for(const n in FP99){
      const a = FP99[n], b = fp[n];
      if(!b){ diffs.push({n, missing:true}); continue; }
      if(a[0]!==b[0] || a[1]!==b[1] || a[3]!==b[3]) diffs.push({n, a, b});
    }
    UPD.notes = {fp, diffs, fname:name};
    if(!diffs.length){
      impLog('注释指纹比对完成：8个关键注释（2/16/20/31/33/37/38/39）与本地基准<b>完全一致</b>，清单覆盖范围无变化。','ok');
    }else{
      impLog('注释指纹比对完成：<b class="warn">'+diffs.length+' 个注释发生变化</b>——清单覆盖范围可能调整，需重新生成数据库','w');
      for(const d of diffs){
        if(d.missing) impLog(esc(NOTE_NAMES[d.n]||('注释'+d.n))+'：远端文件中未找到','err');
        else impLog(esc(NOTE_NAMES[d.n]||('注释'+d.n))+'：8位编码数 '+d.a[0]+'→'+d.b[0]+'，10位编码数 '+d.a[1]+'→'+d.b[1]+'，文本哈希已变化','w');
      }
    }
  }catch(e){
    impLog('注释解析失败：'+esc(e.message||e),'err');
  }
  renderImpResult();
}

/* —— C. MFN全表JSON比对：基础税率差异，可直接应用 —— */
function importFullJson(j, name){
  const remote = {};
  for(const x of j){
    const h = String(x.htsno||''); const g = String(x.general||'').trim();
    if(!g) continue;
    if(/^\d{4}\.\d{2}\.\d{2}$/.test(h)) remote[h]=g;
    else if(/^\d{4}\.\d{2}\.\d{2}\.\d{2}$/.test(h)){ const p=h.slice(0,10); if(!(p in remote)) remote[p]=g; }
  }
  for(const k of Object.keys(remote)) if(k.slice(0,2)==='98') delete remote[k]; // 98章特殊规定不纳入
  const changed=[], onlyLocal=[], onlyRemote=[];
  for(const r of BASE){
    const k=r[0];
    if(!(k in remote)) onlyLocal.push(k);
    else if(remote[k].replace(/\s+/g,' ').trim() !== String(r[1]).replace(/\s+/g,' ').trim()) changed.push([k, r[1], remote[k]]);
  }
  for(const k in remote) if(!BASE_MAP.has(k)) onlyRemote.push(k);
  UPD.mfn = {changed, onlyLocal, onlyRemote, fname:name};
  UPD.mfnRemote = remote;
  const total = changed.length+onlyLocal.length+onlyRemote.length;
  impLog('MFN全表比对完成：本地 '+BASE.length+' 个8位税号 vs 远端 '+Object.keys(remote).length+' 个 ｜ 税率变化 <b>'+changed.length+'</b> ｜ 本地独有 <b>'+onlyLocal.length+'</b> ｜ 远端新增 <b>'+onlyRemote.length+'</b>', total?'w':'ok');
  if(!total) impLog('最惠国税率与官方现行数据完全一致，无需更新。','ok');
  else impLog('检测到基础税率差异，可在下方结果区点击“应用到当前页面”并下载更新后的数据文件。','w');
  renderImpResult();
}
function applyMfnUpdate(){
  if(!UPD.mfn || !UPD.mfnRemote) return;
  const remote = UPD.mfnRemote;
  let upd=0, add=0, del=0;
  // 更新现有
  for(const r of BASE){
    if(r[0] in remote){
      const g = remote[r[0]].replace(/\s+/g,' ').trim();
      if(String(r[1]).replace(/\s+/g,' ').trim()!==g){ r[1]=remote[r[0]]; BASE_MAP.set(r[0],[remote[r[0]], r[2]]); upd++; }
    }
  }
  // 新增
  for(const k of UPD.mfn.onlyRemote){
    if(remote[k]!==undefined){ BASE.push([k, remote[k], '']); BASE_MAP.set(k,[remote[k],'']); add++; }
  }
  // 移除（远端已删除的税号）
  if(UPD.mfn.onlyLocal.length){
    const dead = new Set(UPD.mfn.onlyLocal);
    for(let i=BASE.length-1;i>=0;i--) if(dead.has(BASE[i][0])){ BASE_MAP.delete(BASE[i][0]); BASE.splice(i,1); del++; }
  }
  META.base_date = nowStr().slice(0,10);
  UPD.applied = true;
  impLog('已应用更新到当前页面数据：税率更新 '+upd+' 条 ｜ 新增税号 '+add+' 条 ｜ 移除税号 '+del+' 条。基准日已调整为 '+META.base_date+'。<b>请下载更新后的 data.js 替换原文件以永久保存</b>。','ok');
  renderImpResult();
}
function downloadUpdatedData(){
  const parts = [];
  parts.push('// 中国输美产品关税叠加数据库（基准日'+META.base_date+'，经在线更新）');
  parts.push('const META='+JSON.stringify(META)+';');
  parts.push('const LISTS='+JSON.stringify(LISTS)+';');
  parts.push('const BASE='+JSON.stringify(BASE)+';');
  parts.push('const M301L='+JSON.stringify(M301L)+';');
  parts.push('const M301S='+JSON.stringify(M301S)+';');
  parts.push('const M301X='+JSON.stringify(M301X)+';');
  parts.push('const M232='+JSON.stringify(M232)+';');
  parts.push('const EX122='+JSON.stringify(EX122)+';');
  parts.push('// —— 数据更新比对基准（HTS 2026HTSRev11，2026-07-18生成）——');
  parts.push('const HTS_REV='+JSON.stringify(HTS_REV)+';');
  parts.push('const C99SNAP='+JSON.stringify(UPD.c99?UPD.c99.remote:C99SNAP)+';');
  parts.push('const FP99='+JSON.stringify(UPD.notes?UPD.notes.fp:FP99)+';');
  const blob = new Blob([parts.join('\n')], {type:'text/javascript;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = 'data.js';
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 500);
  impLog('已导出更新后的 data.js（含最新MFN数据与比对基准），替换站点 assets/data.js 即完成永久更新。','ok');
}

/* ---------- 导入结果汇总渲染 ---------- */
function renderImpResult(){
  const box = document.getElementById('impResult'); if(!box) return;
  let html = '';
  // 第99章税目
  if(UPD.c99){
    const c = UPD.c99; const t = c.news.length+c.gone.length+c.changed.length;
    html += '<h3>第99章税目比对（232/301/122等措施申报税目）</h3>';
    if(!t) html += '<p class="ok">438个9903税目与基准一致，措施层面无变化。</p>';
    else{
      html += '<table class="utab"><thead><tr><th>变化类型</th><th>税目</th><th>税率变化</th></tr></thead><tbody>';
      for(const h of c.news) html += '<tr class="newdoc"><td class="warn">新增</td><td>'+esc(h)+'</td><td>'+esc(pctOf(c.remote[h]))+'</td></tr>';
      for(const h of c.gone) html += '<tr><td class="err">消失</td><td>'+esc(h)+'</td><td>原 '+esc(pctOf(C99SNAP[h]))+'</td></tr>';
      for(const h of c.changed) html += '<tr class="newdoc"><td class="warn">变化</td><td>'+esc(h)+'</td><td>'+esc(pctOf(C99SNAP[h]))+' → '+esc(pctOf(c.remote[h]))+'</td></tr>';
      html += '</tbody></table>';
    }
  }
  // 注释指纹
  if(UPD.notes){
    const ds = UPD.notes.diffs;
    html += '<h3>第99章注释指纹比对（清单覆盖范围）</h3>';
    if(!ds.length) html += '<p class="ok">8个关键注释完全一致，清单覆盖范围无变化。</p>';
    else{
      html += '<table class="utab"><thead><tr><th>注释</th><th>8位编码数</th><th>10位编码数</th><th>文本哈希</th></tr></thead><tbody>';
      for(const d of ds){
        if(d.missing) html += '<tr><td>'+esc(NOTE_NAMES[d.n]||d.n)+'</td><td colspan="3" class="err">远端未找到</td></tr>';
        else html += '<tr class="newdoc"><td>'+esc(NOTE_NAMES[d.n]||d.n)+'</td><td>'+d.a[0]+' → '+d.b[0]+'</td><td>'+d.a[1]+' → '+d.b[1]+'</td><td class="warn">已变化</td></tr>';
      }
      html += '</tbody></table><p class="warn">注释覆盖范围变化需重新解析生成清单数据库（服务器端流程），本页面无法安全自动应用——请将变化详情反馈数据维护。</p>';
    }
  }
  // MFN
  if(UPD.mfn){
    const m = UPD.mfn; const t = m.changed.length+m.onlyLocal.length+m.onlyRemote.length;
    html += '<h3>最惠国税率（MFN）全表比对</h3>';
    if(!t) html += '<p class="ok">'+BASE.length+'个税号与官方现行数据完全一致。</p>';
    else{
      html += '<table class="utab"><thead><tr><th>变化类型</th><th>数量</th><th>明细（前20条）</th></tr></thead><tbody>';
      html += '<tr'+(m.changed.length?' class="newdoc"':'')+'><td>税率变化</td><td>'+m.changed.length+'</td><td>'+m.changed.slice(0,20).map(x=>esc(x[0])+'：'+esc(x[1])+' → '+esc(x[2])).join('<br>')+'</td></tr>';
      html += '<tr'+(m.onlyRemote.length?' class="newdoc"':'')+'><td>远端新增税号</td><td>'+m.onlyRemote.length+'</td><td>'+m.onlyRemote.slice(0,20).map(esc).join('、')+'</td></tr>';
      html += '<tr'+(m.onlyLocal.length?' class="newdoc"':'')+'><td>远端已删除税号</td><td>'+m.onlyLocal.length+'</td><td>'+m.onlyLocal.slice(0,20).map(esc).join('、')+'</td></tr>';
      html += '</tbody></table>';
      html += '<div style="margin-top:10px;display:flex;gap:10px;flex-wrap:wrap">'
        + '<button class="btn" onclick="applyMfnUpdate()">应用到当前页面数据</button>'
        + '<button class="btn ghost" onclick="downloadUpdatedData()">下载更新后的 data.js</button>'
        + '</div><p class="dim" style="margin-top:6px">“应用”立即刷新本页面内存中的税率（可直接重新计算验证）；“下载”导出完整数据文件，替换 assets/data.js 后永久生效。</p>';
    }
    if(UPD.applied) html += '<p class="ok" style="margin-top:6px">本次会话已应用更新（基准日 '+META.base_date+'）。</p>';
  }
  box.innerHTML = html;
}

/* ---------- 更新报告下载 ---------- */
function downloadUpdReport(){
  const L = [];
  const CN = ['一','二','三','四','五','六'];
  let sec = 0;
  L.push('# 数据更新检查报告');
  L.push('检查时间：'+nowStr()+'　｜　数据基准：'+META.base_date+'（'+HTS_REV+'）');
  L.push('');
  if(UPD.fr){
    L.push('## '+CN[sec++]+'、联邦公报最新文件');
    for(const r of UPD.fr){
      if(!r.ok){ L.push('- '+r.q+'：查询失败'); continue; }
      const news = r.docs.filter(d=>d.isNew);
      L.push('- '+r.q+'：'+(news.length? news.map(d=>d.date+'《'+d.title+'》('+d.num+') '+d.url).join('；') : '基准日后无新文件（最新 '+ (r.docs[0]?r.docs[0].date:'—') +'）'));
    }
    L.push('');
  }
  if(UPD.rev){
    L.push('## '+CN[sec++]+'、HTS修订版');
    L.push(UPD.rev.ok ? ('官方当前：'+UPD.rev.desc+'（'+UPD.rev.name+'）｜本地基准：'+HTS_REV+'｜'+(UPD.rev.same?'一致':'不一致，需更新')) : 'hts.usitc.gov在线接口未能从浏览器连通（USITC跨域限制＋公共代理不稳定），修订版核对请改用官方文件导入方式完成。');
    L.push('');
  }
  if(UPD.c99){
    const c=UPD.c99;
    L.push('## '+CN[sec++]+'、第99章税目比对（文件：'+c.fname+'）');
    L.push('新增 '+c.news.length+'：'+c.news.join('、'));
    L.push('消失 '+c.gone.length+'：'+c.gone.join('、'));
    L.push('变化 '+c.changed.length+'：'+c.changed.map(h=>h+'（'+pctOf(C99SNAP[h])+'→'+pctOf(c.remote[h])+'）').join('、'));
    L.push('');
  }
  if(UPD.notes){
    L.push('## '+CN[sec++]+'、注释指纹比对（文件：'+UPD.notes.fname+'）');
    if(!UPD.notes.diffs.length) L.push('8个关键注释完全一致。');
    for(const d of UPD.notes.diffs) L.push(d.missing? ('- '+(NOTE_NAMES[d.n]||d.n)+'：远端缺失') : ('- '+(NOTE_NAMES[d.n]||d.n)+'：8位 '+d.a[0]+'→'+d.b[0]+'，10位 '+d.a[1]+'→'+d.b[1]+'，哈希变化'));
    L.push('');
  }
  if(UPD.mfn){
    const m=UPD.mfn;
    L.push('## '+CN[sec++]+'、MFN全表比对（文件：'+m.fname+'）');
    L.push('税率变化 '+m.changed.length+' 条；远端新增 '+m.onlyRemote.length+' 条；远端删除 '+m.onlyLocal.length+' 条。');
    for(const x of m.changed) L.push('- '+x[0]+'：'+x[1]+' → '+x[2]);
    L.push('');
  }
  const blob = new Blob([L.join('\n')], {type:'text/markdown;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = '数据更新检查报告_'+nowStr().slice(0,10)+'.md';
  document.body.appendChild(a); a.click();
  setTimeout(()=>{ URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------- 初始化 ---------- */
function showLastCheck(){
  const el = document.getElementById('lastCheck'); if(!el) return;
  el.textContent = localStorage.getItem('utd_last_check') || '从未';
}
document.addEventListener('DOMContentLoaded', function(){
  showLastCheck();
  const dz = document.getElementById('dropzone');
  if(dz){
    dz.addEventListener('dragover', function(e){ e.preventDefault(); dz.classList.add('hover'); });
    dz.addEventListener('dragleave', function(){ dz.classList.remove('hover'); });
    dz.addEventListener('drop', onUpdDrop);
  }
});
