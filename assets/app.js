/* 中国输美产品关税叠加计算引擎（数据基准日 2026-07-18） */
const BASE_MAP = new Map(); BASE.forEach(r=>BASE_MAP.set(r[0],[r[1],r[2]]));
const M301L_MAP = new Map(); M301L.forEach(r=>M301L_MAP.set(r[0],[r[1],r[2]]));
const M232_MAP = new Map(); M232.forEach(r=>{if(!M232_MAP.has(r[0]))M232_MAP.set(r[0],[]);M232_MAP.get(r[0]).push(r);});
const EX122_SET = new Set(EX122);
const CHNAME = {'84':'机器机械','85':'电机电气','86':'铁路装备','87':'车辆','88':'航空器','89':'船舶','90':'仪器仪表','72':'钢铁','73':'钢铁制品','76':'铝及其制品','74':'铜及其制品','29':'有机化学品','30':'药品','94':'家具寝具','44':'木及木制品','39':'塑料制品','62':'梭织服装','61':'针织服装'};

/* ---------- 税号标准化 ---------- */
function normalize(raw){
  raw = (raw||'').trim().toUpperCase(); if(!raw) return null;
  let c8=null,c10=null;
  if(/^\d{8}$/.test(raw)) c8 = raw.slice(0,4)+'.'+raw.slice(4,6)+'.'+raw.slice(6,8);
  else if(/^\d{10}$/.test(raw)){ c8 = raw.slice(0,4)+'.'+raw.slice(4,6)+'.'+raw.slice(6,8); c10 = c8+raw.slice(8,10); }
  else{
    const m = raw.match(/^(\d{4})\.?(\d{2})\.?(\d{2})\.?(\d{2})?$/);
    if(m){ c8 = m[1]+'.'+m[2]+'.'+m[3]; if(m[4]) c10 = c8+m[4]; }
  }
  return c8 ? {raw,c8,c10} : null;
}

/* ---------- MFN税率解析 ---------- */
function parseMFN(gen){
  gen = (gen||'').trim();
  if(!gen || /^free/i.test(gen)) return {pct:0, text:gen||'Free', specific:false};
  const m = gen.match(/([\d.]+)\s*%/);
  const pct = m ? parseFloat(m[1]) : null;
  const specific = /[¢$€£]|\/\s*(kg|g|lb|ton|liter|l|m[23]?|doz|pair|unit|piece)/i.test(gen);
  return {pct, text:gen, specific};
}

/* ---------- 叠加计算 ---------- */
function calc(raw){
  const n = normalize(raw);
  if(!n) return {status:'invalid', raw};
  const r = {raw:n.raw, c8:n.c8, c10:n.c10, rows:[], notes:[], status:'ok'};
  const base = BASE_MAP.get(n.c8);
  // 1. MFN
  let mfnPct = 0, mfnText = 'Free', mfnSpecific = false;
  if(base){ const p = parseMFN(base[0]); mfnPct = p.pct||0; mfnText = p.text; mfnSpecific = p.specific; r.desc = base[1]; }
  else {
    r.desc = '';
    const p6 = n.c8.slice(0,7); // 6位前缀，如 8471.6
    r.candidates = BASE.filter(b=>b[0].startsWith(p6)).map(b=>b[0]).slice(0,12);
    if(r.candidates.length) r.notes.push('提示：未找到'+n.c8+'；美国HTS中 '+p6+' 项下子目见下方候选（中国海关编码与美国HTS在第7-8位常有差异，可点击候选逐个试算）。');
    else r.notes.push('提示：该8位子目未在现行HTS基础表中找到（可能已改号、为10位统计号或编码有误），请核对。');
  }
  r.descCn = (typeof CNAMES!=='undefined' && CNAMES[n.c8]) || '';
  r.rows.push({layer:'最惠国税率（MFN）', rate:mfnText, add:mfnPct, addText:mfnPct+'%', basis:'HTS第1—97章General栏', zero:mfnPct===0});
  if(mfnSpecific) r.notes.push('该税号最惠国税率为从量/复合税（'+mfnText+'），从价合计未包含从量部分，需按进口数量另计。');
  // 2. 301
  let has301 = false;
  if(M301L_MAP.has(n.c8)){
    const [id,desc] = M301L_MAP.get(n.c8); const m = LISTS[id];
    const pct = parseFloat(m.rate);
    r.rows.push({layer:'301关税（'+m.name+'）', rate:m.rate, add:pct, addText:'+'+m.rate, basis:m.h9903+'｜'+m.src, zero:false});
    has301 = true; r.m301desc = desc;
  }
  let srnMaybe = [];
  for(const s of M301S){
    const scode = s[0];
    if(scode === n.c8 || (n.c10 && scode.indexOf(n.c10)>=0)){
      const pct = parseFloat(s[3]);
      r.rows.push({layer:'301战略产业加税（'+s[2]+'）', rate:s[3], add:pct, addText:'+'+s[3], basis:s[4]+'｜'+s[7], zero:false});
      has301 = true; if(!r.m301desc) r.m301desc = s[6];
    } else if(scode.indexOf(n.c8)>=0){ srnMaybe.push(s); }
  }
  if(!has301 && srnMaybe.length){
    const s = srnMaybe[0];
    r.notes.push('该8位子目不整体适用301战略产业加税，但项下特定10位统计号（'+s[0]+'，'+s[2]+'，'+s[3]+'，'+s[4]+'）适用——请按10位统计号确认。');
  }
  // 301排除初筛
  let exclHit = [];
  for(const e of M301X){
    const srns = e[5]||'';
    if(n.c10 && srns.indexOf(n.c10)>=0) exclHit.push([e,true]);
    else if(srns.indexOf(n.c8)>=0) exclHit.push([e,false]);
  }
  if(exclHit.length) r.notes.push('301排除初筛命中（'+exclHit.length+'条）：排除按“10位统计号＋英文描述”双重限定，须逐字核对描述；现行排除2026-11-09到期。');
  r.exclHit = exclHit;
  // 3. 232
  let has232 = false;
  const m232items = M232_MAP.get(n.c8) || [];
  for(const it of m232items){
    let add = null, addText = it[2];
    if(it[1].indexOf('15%封顶')>=0 || it[2].indexOf('max')>=0){
      add = Math.max(0, 15 - mfnPct); addText = (add===0?'0':'+'+add+'%')+'（补至15%）';
    } else { add = parseFloat(it[2]); addText = '+'+it[2]; }
    r.rows.push({layer:'232关税（'+it[1]+'）', rate:it[2], add, addText, basis:it[4]+'｜'+it[5]+(it[6]?'｜'+it[6]:''), zero:add===0});
    if(add>0) has232 = true; else has232 = has232 || true; // 覆盖即豁免122
  }
  if(m232items.length) has232 = true;
  // 4. Section 122
  if(m232items.length){
    r.rows.push({layer:'Section 122普遍附加税', rate:'10%', add:0, addText:'0（豁免）', basis:'9903.03.06：232覆盖产品不与122叠加（注释2(aa)(v)）', zero:true});
  } else if(EX122_SET.has(n.c8)){
    r.rows.push({layer:'Section 122普遍附加税', rate:'10%', add:0, addText:'0（例外）', basis:'9903.03.03/9903.03.04：产品例外清单（注释2(aa)(ii)/(iii)）', zero:true});
  } else if(n.c8.startsWith('88')){
    r.rows.push({layer:'Section 122普遍附加税', rate:'10%', add:0, addText:'0（豁免）', basis:'9903.03.05：民用航空器及其发动机部件例外（描述判定）', zero:true});
  } else {
    r.rows.push({layer:'Section 122普遍附加税', rate:'10%', add:10, addText:'+10%', basis:'9903.03.01｜Proclamation 11012（FR 2026-03824）｜2026-02-24生效，2026-07-24法定到期；CIT判违法被CAFC中止，上诉期间照收', zero:false});
  }
  // 5. IEEPA（已终止）
  r.rows.push({layer:'IEEPA（芬太尼10%＋对等10%）', rate:'已终止', add:0, addText:'0', basis:'SCOTUS 2026-02-20裁决（Learning Resources v. Trump）；CBP 2026-02-24停征；已缴税款可经CAPE门户申请退还', zero:true});
  // 6. 201（已到期）
  if(['8541.42.00','8541.43.00'].indexOf(n.c8)>=0)
    r.rows.push({layer:'201保障措施（光伏电池/组件）', rate:'已到期', add:0, addText:'0', basis:'2026年2月届满（HTS编译注释）；如需请复核USTR是否延期', zero:true});
  if(['8450.11.00','8450.19.00','8450.20.00'].indexOf(n.c8)>=0)
    r.rows.push({layer:'201保障措施（洗衣机）', rate:'已到期', add:0, addText:'0', basis:'2023年2月届满', zero:true});
  // 7. 双反
  r.rows.push({layer:'反倾销/反补贴税', rate:'个案判定', add:null, addText:'—', basis:'按“企业＋产品范围”判定（access.trade.gov案件清单），不纳入自动合计', zero:true});
  // 合计
  let total = 0; const parts = [];
  for(const row of r.rows){ if(row.add){ total += row.add; parts.push(row.addText.replace(/（.*$/,'').replace('+','')); } }
  r.total = total; r.has232 = has232;
  r.notes.push('总叠加值＝各行从价税率之和（简单相加）；从量税、双反税、UFLPA扣留不计入。122将于2026-07-24法定到期，若未延期/接替，总税负相应下降10个百分点。');
  return r;
}

/* ---------- 渲染 ---------- */
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;');}
function renderCalc(r){
  const box = document.getElementById('qResult');
  box.style.display='block';
  if(r.status==='invalid'){ box.innerHTML='<div class="banner maybe">无法识别税号格式，请输入8位或10位HTS税号。</div>'; return; }
  const bannerCn = r.descCn ? '（'+esc(r.descCn.length>26?r.descCn.slice(0,26)+'…':r.descCn)+'）' : (r.candidates!==undefined ? '（未找到该编码）' : '');
  let h = '<div class="banner '+(r.total>0?'hit':'none')+'">'+esc(r.c8)+bannerCn+(r.c10?('（'+esc(r.c10)+'）'):'')+'　加征关税总叠加值：+'+r.total+'%＝最惠国'+(r.rows[0].add)+'%＋各项加征'+(r.total-r.rows[0].add).toFixed(2).replace(/\.00$/,'')+'%</div>';
  if(r.candidates && r.candidates.length){
    h += '<div class="note" style="margin-bottom:10px">未找到 '+esc(r.c8)+'；美国HTS '+esc(r.c8.slice(0,7))+' 项下候选子目（点击试算）：'
      + r.candidates.map(c=>'<a href="javascript:void(0)" style="color:var(--navy);font-weight:bold" onclick="document.getElementById(\'qInput\').value=\''+c+'\';runCalc()">'+c+'</a>').join('、') + '</div>';
  }
  if(r.descCn) h += '<div class="note" style="margin-bottom:10px">品名（中文参考）：'+esc(r.descCn)+(r.desc?('<br><span style="color:#8a94a0;font-size:11.5px">品名（现行HTS英文）：'+esc(r.desc)+'</span>'):'')+'</div>';
  else if(r.desc) h += '<div class="note" style="margin-bottom:10px">品名（现行HTS）：'+esc(r.desc)+'</div>';
  else h += '<div class="note" style="margin-bottom:10px">品名：未找到——该编码不在现行美国HTS中，无法提供品名翻译。</div>';
  h += '<table class="stack"><tr><th style="width:26%">措施层级</th><th style="width:10%">税率</th><th style="width:16%">加征值（从价）</th><th>加征依据</th></tr>';
  for(const row of r.rows){
    h += '<tr'+(row.zero?' class="zero"':'')+'><td>'+esc(row.layer)+'</td><td>'+esc(row.rate)+'</td><td class="add'+(row.zero?' zero':'')+'">'+esc(row.addText)+'</td><td style="font-size:12px">'+esc(row.basis)+'</td></tr>';
  }
  h += '<tr class="total"><td>合计（从价叠加）</td><td>—</td><td class="add">+'+r.total+'%</td><td>不含从量税与双反税</td></tr></table>';
  if(r.exclHit && r.exclHit.length){
    h += '<h3 class="sec">301排除初筛命中（'+r.exclHit.length+'条，须按英文描述核对）</h3><table class="stack">';
    for(const [e,exact] of r.exclHit.slice(0,5)){
      h += '<tr><td>'+(exact?'<b>[10位精确]</b> ':'[8位初筛] ')+esc(e[0])+' 第'+e[3]+'项</td><td colspan="3" style="font-size:12px">'+esc(e[4].slice(0,240))+(e[4].length>240?'…':'')+'</td></tr>';
    }
    h += '</table>';
  }
  for(const t of r.notes) h += '<div class="note'+(t.indexOf('豁免')>=0||t.indexOf('排除')>=0||t.indexOf('到期')>=0?' warn':'')+'">'+esc(t)+'</div>';
  box.innerHTML = h;
}
function runCalc(){ renderCalc(calc(document.getElementById('qInput').value)); }
function demo(c){ document.getElementById('qInput').value=c; runCalc(); }
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('qInput').addEventListener('keydown',e=>{if(e.key==='Enter')runCalc();});
});

/* ---------- 批量 ---------- */
let lastBatch=[];
function verdictOf(r){
  if(r.status==='invalid') return ['格式无法识别','','',''];
  const adds = r.rows.filter(x=>x.add>0);
  return ['+'+r.total+'%', adds.map(x=>x.layer.split('（')[0]+' '+x.addText).join('；')||'无加征', r.rows.find(x=>x.add>0)?'加征':'零', r.rows.length];
}
function runBatch(){
  const raw = document.getElementById('batchInput').value;
  const tokens = raw.split(/[\s,;，、]+/).filter(x=>x.trim());
  const seen = new Set(); lastBatch = [];
  for(const t of tokens){ if(!seen.has(t)){ seen.add(t); lastBatch.push(calc(t)); } }
  let h = '<table class="grid"><tr><th>输入</th><th>8位子目</th><th>总叠加值</th><th>构成（加征项）</th><th>品名（中文参考）</th></tr>';
  for(const r of lastBatch){
    const [tot, comp] = r.status==='invalid'?['格式无法识别','']:verdictOf(r);
    const cn = r.descCn || (r.desc||'').slice(0,80);
    h += '<tr><td>'+esc(r.raw)+'</td><td>'+esc(r.c8||'—')+'</td><td class="add">'+tot+'</td><td style="font-size:11.5px">'+esc(comp)+'</td><td style="font-size:11.5px" title="'+esc(r.desc||'')+'">'+esc(cn)+'</td></tr>';
  }
  h += '</table><div class="hint">共 '+lastBatch.length+' 条。合计不含从量税与双反税。</div>';
  document.getElementById('batchResult').innerHTML = h;
}
function exportCSV(){
  if(!lastBatch.length){ alert('请先执行批量计算'); return; }
  let csv = '﻿输入,8位子目,总叠加值,构成,品名（中文参考）,品名（英文HTS）\n';
  for(const r of lastBatch){
    const [tot, comp] = r.status==='invalid'?['格式无法识别','']:verdictOf(r);
    csv += [r.raw, r.c8||'', tot, comp, r.descCn||'', (r.desc||'').slice(0,100)].map(x=>'"'+String(x).replace(/"/g,'""')+'"').join(',')+'\n';
  }
  const blob = new Blob([csv],{type:'text/csv;charset=utf-8'});
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '输美关税叠加计算结果.csv'; a.click();
}

/* ---------- 浏览 ---------- */
let bTab=0, bPage=1; const PER=50;
function switchTab(i){ bTab=i; bPage=1;
  for(let k=1;k<=5;k++) document.getElementById('tab'+k).className=(k-1===i?'on':'');
  document.getElementById('fMeas').style.display = (i===2?'':'none');
  renderBrowse(1);
}
function browseData(){
  const q = (document.getElementById('fText').value||'').trim().toLowerCase();
  const ch = document.getElementById('fCh').value;
  const fm = document.getElementById('fMeas').value;
  if(bTab===0) return BASE.filter(r=>(!ch||r[0].slice(0,2)===ch)&&(!q||r[0].includes(q)||(r[2]||'').toLowerCase().includes(q)||(typeof CNAMES!=='undefined'&&(CNAMES[r[0]]||'').includes(q))));
  if(bTab===1) return M301L.filter(r=>(!ch||r[0].slice(0,2)===ch)&&(!q||r[0].includes(q)||(r[2]||'').toLowerCase().includes(q)||(typeof CNAMES!=='undefined'&&(CNAMES[r[0]]||'').includes(q))));
  if(bTab===2) return M232.filter(r=>(!ch||r[0].slice(0,2)===ch)&&(!fm||r[1]===fm)&&(!q||r[0].includes(q)||(r[1]||'').toLowerCase().includes(q)));
  if(bTab===3) return EX122.filter(c=>(!ch||c.slice(0,2)===ch)&&(!q||c.includes(q)));
  return M301X.filter(r=>!q||(r[4]||'').toLowerCase().includes(q)||(r[5]||'').toLowerCase().includes(q));
}
function renderBrowse(p){
  bPage = p||bPage;
  const rows = browseData();
  const total = rows.length, pages = Math.max(1,Math.ceil(total/PER));
  if(bPage>pages) bPage=pages;
  const slice = rows.slice((bPage-1)*PER, bPage*PER);
  let h = '<table class="grid">';
  if(bTab===0){ h+='<tr><th>8位子目</th><th>最惠国税率</th><th>品名（中文参考）</th><th>品名（英文HTS）</th></tr>';
    for(const r of slice) h+='<tr><td>'+r[0]+'</td><td>'+esc(r[1])+'</td><td>'+esc((typeof CNAMES!=='undefined'&&CNAMES[r[0]])||'')+'</td><td>'+esc(r[2])+'</td></tr>'; }
  else if(bTab===1){ h+='<tr><th>8位子目</th><th>所属清单</th><th>税率</th><th>9903税目</th><th>品名（中文参考）</th><th>品名（英文HTS）</th></tr>';
    for(const r of slice){ const m=LISTS[r[1]]; h+='<tr><td>'+r[0]+'</td><td>'+m.name+'</td><td>'+m.rate+'</td><td>'+m.h9903+'</td><td>'+esc((typeof CNAMES!=='undefined'&&CNAMES[r[0]])||'')+'</td><td>'+esc(r[2])+'</td></tr>'; } }
  else if(bTab===2){ h+='<tr><th>8位子目</th><th>232措施</th><th>税率</th><th>9903税目</th><th>备注</th></tr>';
    for(const r of slice) h+='<tr><td>'+r[0]+'</td><td>'+esc(r[1])+'</td><td>'+esc(r[2])+'</td><td>'+esc(r[4])+'</td><td style="font-size:11px">'+esc(r[6]||'')+'</td></tr>'; }
  else if(bTab===3){ h+='<tr><th>8位子目</th><th>说明</th></tr>';
    for(const c of slice){ const b=BASE_MAP.get(c); h+='<tr><td>'+c+'</td><td style="font-size:11.5px">'+esc(b?b[1].slice(0,120):'')+'</td></tr>'; } }
  else{ h+='<tr><th>排除类别</th><th>序号</th><th>产品描述（英文，为裁定依据）</th><th>涉及统计号</th></tr>';
    for(const r of slice) h+='<tr><td>'+esc(r[0])+'</td><td>'+r[3]+'</td><td>'+esc(r[4])+'</td><td>'+esc(r[5])+'</td></tr>'; }
  h += '</table>';
  document.getElementById('browseBox').innerHTML = h;
  document.getElementById('pgInfo').textContent = '第 '+bPage+' / '+pages+' 页 · 共 '+total.toLocaleString()+' 条';
}
function pageMove(d){ renderBrowse(bPage+d); }

/* ---------- 统计 ---------- */
function renderStats(){
  const items = [
    ['301清单1（25%）', M301L.filter(r=>r[1]==='L1').length],
    ['301清单2（25%）', M301L.filter(r=>r[1]==='L2').length],
    ['301清单3（25%）', M301L.filter(r=>r[1]==='L3').length],
    ['301清单4A（7.5%）', M301L.filter(r=>r[1]==='L4A').length],
    ['301战略产业加税', M301S.length],
    ['232金属50%', M232.filter(r=>r[1].indexOf('50%')>=0&&r[1].indexOf('金属（')>=0).length],
    ['232金属衍生品25%', M232.filter(r=>r[1].indexOf('衍生品')>=0&&r[2]==='25%').length],
    ['232机电设备15%封顶', M232.filter(r=>r[1].indexOf('15%封顶')>=0).length],
    ['232汽车/卡车/木材/家具/半导体', M232.filter(r=>r[1].indexOf('金属')<0).length],
    ['Section 122产品例外', EX122.length],
    ['301排除', M301X.length],
  ];
  const max = Math.max(...items.map(x=>x[1]));
  let h='';
  for(const [lb,n] of items) h+='<div class="bar-row"><span class="lb">'+lb+'</span><span class="bar" style="width:'+(n/max*50)+'%"></span><span class="vl">'+n.toLocaleString()+'</span></div>';
  document.getElementById('stat1').innerHTML = h;
}

/* ---------- 初始化 ---------- */
(function init(){
  const sel = document.getElementById('fCh');
  const chs = [...new Set(BASE.map(r=>r[0].slice(0,2)))].sort();
  for(const c of chs){ const o=document.createElement('option'); o.value=c; o.textContent=c+' '+(CHNAME[c]||''); sel.appendChild(o); }
  const ms = [...new Set(M232.map(r=>r[1]))].sort();
  const selM = document.getElementById('fMeas');
  for(const m of ms){ const o=document.createElement('option'); o.value=m; o.textContent=m; selM.appendChild(o); }
  renderBrowse(1); renderStats();
})();
