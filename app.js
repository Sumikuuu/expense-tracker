/* ============================================================
 * app.js —— 应用主逻辑（状态、渲染、存储、事件）
 *
 * 依赖：parser.js（纯函数模块，通过 window.ExpenseParser 引入）
 * 说明：整体包在 IIFE 里，所有函数与状态都在闭包内，不污染 window。
 *       账单解析/分类等纯逻辑不在这里，见 parser.js。
 * ============================================================ */
(function(){
'use strict';

/* ===== 从 parser.js 引入纯函数与常量（无 DOM 依赖，可单独测试） ===== */
const {
  CATEGORIES, CHANNELS, INCOME_CATS, toCents, fmt, fmtSci, esc, catName, channelName, parseXlsxText, parseBill, dupKey, normalizeImportedRecord
} = window.ExpenseParser;
/* ===== 从 stats.js 引入月份索引与聚合（纯函数，无 DOM 依赖，可单独测试） ===== */
const {build: buildMonthIndex, monthList, monthAgg, groupByDate, monthRange} = window.ExpenseStats;

/* ===== DOM 查询简写 ===== */
const $  = id => document.getElementById(id);              // 按 id
const $$ = sel => document.querySelectorAll(sel);          // 按选择器（返回 NodeList）

// 读取 CSS 变量的当前值。canvas 的 fillStyle/strokeStyle 不认 CSS 变量，
// 只能这样取值；每次调用都重新读，因此系统切换明暗后重绘即可自动跟随。
function themeVar(name, fallback){
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback || '';
}

const STORE_KEY = 'expense-tracker-v1';
// 去重索引：dupKey → Set，避免导入时对 data 反复全量扫描（O(N×M)）
let dupIndex = null;
// 月份索引：一次扫描建「月份 → 记录 / 聚合」两张表，取代每次渲染的 10 次全量扫描
// （表头/账本/统计各 1 次 + 趋势图 6 次 + 导入提醒 1 次）。
// 与 dupIndex 同策略：懒建、save() 时失效；改动 data 的每条路径后面都会调 save()。
let monthIndex = null;
const BUDGET_KEY = 'expense-budget-v1';

let data = load();
// 旧数据迁移：已删除的分类 → 并入现有分类（记录本身保留）
const CAT_MIGRATE = {'订阅':'娱乐', '社交':'其他'};
(function(){
  let changed = false;
  data.forEach(t => {
    const to = CAT_MIGRATE[t.category];
    if(to){ t.category = to; changed = true; }
  });
  if(changed) save();
})();
let budget = loadBudget(); // {total:Number, cats:{Name:Number}}
// 旧分类预算并入新分类，防止残留
(function(){
  let changed = false;
  if(budget.cats && typeof budget.cats==='object'){
    Object.keys(CAT_MIGRATE).forEach(old => {
      if(budget.cats[old]!==undefined){
        const to = CAT_MIGRATE[old];
        budget.cats[to] = (budget.cats[to]||0) + budget.cats[old];
        delete budget.cats[old];
        changed = true;
      }
    });
  }
  if(changed) saveBudget();
})();
// 一次性迁移：旧的「金额以元存储」改为「整数分」，避免浮点误差
const CENTS_FLAG = 'expense-cents-v1';
(function(){
  if(localStorage.getItem(CENTS_FLAG)) return;
  data.forEach(t => { t.amount = toCents(t.amount); });
  budget.total = toCents(budget.total);
  if(budget.cats && typeof budget.cats==='object'){
    Object.keys(budget.cats).forEach(k => { budget.cats[k] = toCents(budget.cats[k]); });
  }
  localStorage.setItem(CENTS_FLAG,'1');
  save(); saveBudget();
})();
let viewMonth = currentMonth(); // YYYY-MM
let viewCat = '';               // 分类筛选：''=全部
let currentTab = 'ledger';
let editingId = null;
let pickerYear = new Date().getFullYear(); // 月份选择器当前展示的年份
let statsDirty = true;                     // 统计页是否待重绘（记账页时延后）

function load(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  }catch(e){ return []; }
}
function save(){
  dupIndex = null;    // 数据已变更，去重索引失效，下次导入时重建
  monthIndex = null;  // 月份索引同理失效（所有会改 data 的路径都以 save() 收尾）
  try{
    localStorage.setItem(STORE_KEY, JSON.stringify(data));
    return true;
  }catch(e){
    // 配额溢出等写入失败：明确提示，避免用户以为已经存好了
    toast('保存失败：存储空间可能已满，请先导出备份');
    return false;
  }
}

function loadBudget(){
  try{
    const raw = localStorage.getItem(BUDGET_KEY);
    if(!raw) return {total:0, cats:{}};
    const b = JSON.parse(raw);
    return {total: parseFloat(b.total)||0, cats: (b.cats && typeof b.cats==='object') ? b.cats : {} };
  }catch(e){ return {total:0, cats:{}}; }
}
function saveBudget(){
  try{ localStorage.setItem(BUDGET_KEY, JSON.stringify(budget)); }
  catch(e){ toast('保存失败：存储空间可能已满'); }
}
function totalBudget(){ return parseFloat(budget.total)||0; }

/* ============ 弹窗通用控制：焦点管理 / Escape / 背景滚动锁定 ============ */
const overlayStack = [];                  // 已打开的遮罩 id，后进先出
const overlayReturnFocus = new Map();     // 每个遮罩打开前的焦点位置
function lockBodyScroll(lock){ document.body.style.overflow = lock ? 'hidden' : ''; }
function openOverlayEl(id){
  const el = $(id);
  if(!el || el.classList.contains('show')) return;
  overlayReturnFocus.set(id, document.activeElement);
  el.classList.add('show');
  if(overlayStack.indexOf(id) < 0) overlayStack.push(id);
  lockBodyScroll(true);
  // 聚焦对话框容器本身：读屏会念出 aria-labelledby 的标题，又不会在手机上弹出键盘
  const sheet = el.querySelector('.sheet');
  if(sheet) sheet.focus();
}
function closeOverlayEl(id){
  const el = $(id);
  if(!el) return;
  el.classList.remove('show');
  const i = overlayStack.indexOf(id);
  if(i > -1) overlayStack.splice(i, 1);
  if(!overlayStack.length) lockBodyScroll(false);
  const back = overlayReturnFocus.get(id);
  overlayReturnFocus.delete(id);
  if(back && back.isConnected && typeof back.focus === 'function') back.focus();   // 焦点归还
}
const OVERLAY_CLOSERS = {
  overlay: () => closeSheet(),
  confirmOverlay: () => closeConfirm(),
  previewOverlay: () => closePreview(),
  monthOverlay: () => closeMonthPicker(),
  backupOverlay: () => closeBackup()
};
document.addEventListener('keydown', e => {
  if(!overlayStack.length) return;
  const topId = overlayStack[overlayStack.length - 1];
  const el = $(topId);
  if(!el) return;
  if(e.key === 'Escape'){                       // Esc 关闭最上层弹窗
    if(OVERLAY_CLOSERS[topId]){ OVERLAY_CLOSERS[topId](); e.preventDefault(); }
    return;
  }
  if(e.key !== 'Tab') return;                   // Tab 在弹窗内循环，不跑到背景
  const items = [...el.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')]
    .filter(x => x.offsetParent !== null || getComputedStyle(x).position === 'fixed');
  if(!items.length) return;
  const first = items[0], last = items[items.length - 1];
  const onSheet = document.activeElement === el.querySelector('.sheet');
  if(e.shiftKey && (document.activeElement === first || onSheet)){ last.focus(); e.preventDefault(); }
  else if(!e.shiftKey && document.activeElement === last){ first.focus(); e.preventDefault(); }
});

/* ============ 备份 / 导入 ============ */
function openBackup(){ openOverlayEl('backupOverlay'); }
function closeBackup(){ closeOverlayEl('backupOverlay'); }
// 导出：打包 data + budget 为 JSON 文件下载
function exportBackup(){
  const payload = {
    app: '月度记账',
    version: 2,
    unit: 'cents',
    exportedAt: new Date().toISOString(),
    budget: budget,
    data: data
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '记账备份_' + todayStr().replace(/-/g,'') + '.json';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
  toast('已导出备份文件 ✓');
  closeBackup();
}

// 恢复：读取备份 JSON，按 id 去重合并到当前数据（供统一导入入口调用）
function restoreBackupText(text){
  try{
    const obj = JSON.parse(text);
    const arr = Array.isArray(obj) ? obj : (obj.data||[]);
    if(!Array.isArray(arr)){ toast('备份文件格式不正确'); return; }
    // 老版本导出金额以「元」存储，转成「分」保持一致（v2 / unit=cents 的备份已是分）
    const isCents = !!(obj && (obj.unit==='cents' || ((obj.version||0)>=2)));
    // id 索引只建一次：早先每条记录都 data.some() 扫全量，是 O(N×M)，
    // 恢复大备份时实测 5000 条备份 × 20000 条存量要 773ms，且随库存量平方增长
    // （20000×20000 会卡住十几秒）。改用 Set 后同一场景 7ms。
    const idIndex = new Set(data.map(t => t.id));
    let added = 0, skipped = 0, invalid = 0;
    arr.forEach(raw => {
      const rec = normalizeImportedRecord(raw, isCents);
      if(!rec){ invalid++; return; }
      // idIndex 与 dupIndex 都随写入同步登记，保证同一文件内部的重复也能识别
      if(idIndex.has(rec.id) || isDup(rec)){ skipped++; }
      else { idIndex.add(rec.id); data.push(rec); markDup(rec); added++; }
    });
    // 同步预算（同样做数值与分类名校验）
    if(obj && obj.budget && typeof obj.budget==='object'){
      const rawCats = (obj.budget.cats && typeof obj.budget.cats==='object') ? obj.budget.cats : {};
      const cats = {};
      Object.keys(rawCats).forEach(k => {
        const v = isCents ? Math.round(parseFloat(rawCats[k])||0) : toCents(rawCats[k]);
        if(v > 0) cats[k] = v;
      });
      const rawTotal = isCents ? Math.round(parseFloat(obj.budget.total)||0) : toCents(obj.budget.total);
      budget = { total: rawTotal > 0 ? rawTotal : 0, cats: cats };
      saveBudget();
    }
    save();
    renderAll();
    toast(`导入完成：新增 ${added} 条，跳过重复 ${skipped} 条${invalid?`，忽略无效 ${invalid} 条`:''}`);
  }catch(err){
    toast('导入失败：文件解析出错');
  }
}

function catBudget(name){ return parseFloat(budget.cats && budget.cats[name])||0; }

function currentMonth(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
}
function todayStr(){
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
// 月份索引懒建：第一次用到时扫一遍 data，之后每次取月都是 O(1)
function getMonthIndex(){
  if(!monthIndex) monthIndex = buildMonthIndex(data);
  return monthIndex;
}
// 取某月记录。返回的是索引内部的数组，**调用方只读**：
// 需要排序/修改请先复制（groupByDate 内部已复制，账本那条路径安全）
function monthTransactions(m){
  return monthList(getMonthIndex(), m);
}
// 取某月聚合（支出/收入/分类/渠道）
function monthStats(m){
  return monthAgg(getMonthIndex(), m);
}

/* ============ 头部月份 ============ */
function renderHeader(){
  const [y,m] = viewMonth.split('-').map(Number);
  const label = (y===new Date().getFullYear() && m===new Date().getMonth()+1) ? '本月' : (y+'年'+m+'月');
  $('monthLabel').textContent = label;
  const list = monthTransactions(viewMonth);
  const st = monthStats(viewMonth);
  const exp = st.exp;
  $('totalExpense').textContent = '¥' + fmt(exp);
  $('monthSub').textContent = '收入 ¥' + fmt(st.inc) + '　·　' + list.length + ' 笔';

  // 本月预算进度
  const tb = totalBudget();
  const track = $('budgetTrack');
  const fill = $('budgetFill');
  const line = $('budgetLine');
  if(tb>0){
    track.style.display='block';
    const pct = Math.min(exp/tb*100, 100);
    fill.style.width = pct + '%';
    fill.classList.remove('warn','over');
    if(exp>tb){ fill.classList.add('over'); }
    else if(pct>=80){ fill.classList.add('warn'); }
    if(exp>tb){
      line.textContent = `已超支 ¥${fmt(exp-tb)}`;
      line.classList.add('over');
    } else {
      line.textContent = `预算 ${fmt(tb)} · 剩 ¥${fmt(tb-exp)}`;
      line.classList.remove('over');
    }
  } else {
    track.style.display='none';
    line.textContent = '';
    line.classList.remove('over');
  }
}

/* ============ 记账列表 ============ */
// 分类筛选条（顶部横滑胶囊：全部 + 支出分类 + 收入分类去重）
function renderCatFilter(){
  const el = $('catFilter');
  if(!el) return;
  const keepLeft = el.scrollLeft;   // 重建 DOM 会重置横向滚动，先记住再还原
  // label=显示文本；name=筛选键（'' 表示全部，不能改成"全部"否则筛选逻辑失效）
  const cats = [{name:'', label:'📋 全部', color:null}]
    .concat(CATEGORIES)
    .concat(INCOME_CATS.filter(c=>!CATEGORIES.some(e=>e.name===c.name))); // 收入类去重后追加
  el.innerHTML = cats.map(c => {
    const sel = c.name===viewCat;
    const col = c.color || 'var(--primary)';
    const bg = c.color ? hexA(c.color,.14) : 'var(--sel-bg)';
    const label = c.label || (c.emoji+ (c.name?' '+c.name:''));
    return `<button type="button" class="cf${sel?' sel':''}" data-cat="${esc(c.name)}"
      style="${sel?`--c:${col};--cgbg:${bg};`:''}">${esc(label)}</button>`;
  }).join('');
  // 点击事件用委托方式在 bind() 里统一绑定一次，这里不再逐个绑（避免每次重绘都重新绑）
  el.scrollLeft = keepLeft;
}

function renderLedger(){
  // 不排序：monthTransactions 返回的是索引内部数组（只读），需筛选时 filter 会自行复制。
  // 日期排序与分组交给 groupByDate，它内部先复制再排，并顺带算好组内支出合计
  const all = monthTransactions(viewMonth);
  // 按分类名筛选（任意支出/收入的记录匹配即显示）
  const list = viewCat ? all.filter(t => t.category===viewCat) : all;
  const wrap = $('ledgerList');
  if(list.length===0){
    wrap.innerHTML = viewCat
      ? `<div class="empty"><div class="big">🍃</div>本月「${esc(viewCat)}」还没有记录</div>`
      : '<div class="empty"><div class="big">🍃</div>本月还没有记录<br>点右下角 + 记一笔</div>';
    return;
  }
  let html = '';
  for(const g of groupByDate(list)){
    html += '<div class="date-group">';
    html += `<div class="date-head"><span>${esc(g.date)}</span><span class="g-total">支出 ${fmt(g.expense)}</span></div>`;
    for(const t of g.records){
      const c = catName(t.category);
      const ch = channelName(t.channel);
      const signed = (t.type==='income'?'+':'−') + fmt(t.amount);
      html += `<button type="button" class="item" data-id="${esc(t.id)}">
        <span class="emoji" style="background:${hexA(c.color,.12)}">${esc(c.emoji)}</span>
        <span class="info">
          <span class="cat">${esc(c.name)}<span class="chb" style="color:${ch.color};border-color:${hexA(ch.color,.35)};background:${hexA(ch.color,.1)}">${esc(ch.emoji)} ${esc(ch.name)}</span></span>
          <span class="note">${esc(t.note || (t.type==='income'?'收入':c.name))}</span>
        </span>
        <span class="amt ${t.type==='income'?'income':'expense'}">${signed}</span>
      </button>`;
    }
    html += '</div>';
  }
  wrap.innerHTML = html;
}

function hexA(hex,a){
  const n = hex.replace('#','');
  const r = parseInt(n.substr(0,2),16), g = parseInt(n.substr(2,2),16), b = parseInt(n.substr(4,2),16);
  return `rgba(${r},${g},${b},${a})`;
}

/* ============ 统计 ============ */
function renderStats(){
  const list = monthTransactions(viewMonth);
  const st = monthStats(viewMonth);
  const exp = st.exp, inc = st.inc;
  $('stExpense').textContent = '¥' + fmtSci(exp);
  $('stIncome').textContent = '¥' + fmtSci(inc);
  $('stBalance').textContent = '¥' + fmtSci(inc-exp);

  // 分类统计
  const expList = list.filter(t=>t.type==='expense');
  const byCat = {};
  expList.forEach(t => { byCat[t.category] = (byCat[t.category]||0) + (parseFloat(t.amount)||0); });
  const sorted = Object.keys(byCat).sort((a,b)=>byCat[b]-byCat[a])
      .map(name => ({name, value:byCat[name]}));
  drawDonut(sorted, exp);
  renderLegend(sorted, exp);
  renderChannelStats(list, exp);
  renderBudgetEditor(list);
  renderTrend();
}

function renderChannelStats(list, exp){
  const expList = list.filter(t=>t.type==='expense');
  const byCh = {};
  expList.forEach(t => { const ch = t.channel || '其他'; byCh[ch] = (byCh[ch]||0) + (parseFloat(t.amount)||0); });
  const sorted = Object.keys(byCh).sort((a,b)=>byCh[b]-byCh[a]).map(name=>({name:(channelName(name).name), value:byCh[name]}));
  const el = $('chanList');
  const sumEl = $('chanSum');
  if(sorted.length===0){ el.innerHTML=''; sumEl.innerHTML=''; return; }
  el.innerHTML = sorted.map(item => {
    const ch = channelName(item.name);
    const pct = exp>0 ? (item.value/exp*100) : 0;
    return `<li>
      <span class="dot" style="background:${ch.color}"></span>
      <span class="name">${esc(ch.emoji)} ${esc(ch.name)}</span>
      <span class="pct">${pct.toFixed(1)}%</span>
      <span class="amt">¥${fmtSci(item.value)}</span>
    </li>`;
  }).join('');
  sumEl.innerHTML = `<div class="chs-label">总计支出</div><div class="chs-val">¥${fmtSci(exp)}</div>`;
}

/* 预算编辑器 + 趋势图 */
function renderBudgetEditor(list){
  const totalIn = $('budgetTotal');
  // 只在容器隐藏/未聚焦时刷新数值，避免打字被覆盖
  if(document.activeElement !== totalIn){
    totalIn.value = totalBudget()>0 ? (totalBudget()/100) : '';
  }
  // 分类预算行
  const wrap = $('budgetCats');
  wrap.innerHTML = CATEGORIES.map(c => {
    const used = list.filter(t=>t.type==='expense' && t.category===c.name)
      .reduce((s,t)=>s+(parseFloat(t.amount)||0),0);
    const b = catBudget(c.name);
    const over = b>0 && used>b;
    return `<div class="bc">
      <span class="bc-emoji">${c.emoji}</span>
      <span class="bc-name">${c.name}</span>
      <input class="bc-in" data-cat="${c.name}" type="number" inputmode="decimal" min="0" step="1"
        placeholder="不限" value="${b>0?(b/100):''}" ${over?'style="color:var(--expense);font-weight:700;border-bottom-color:var(--expense);"':''}>
      <span class="bc-used" style="color:${over?'var(--expense)':'var(--ink-3)'}">${fmtSci(used)}</span>
    </div>`;
  }).join('');
  // 分类预算的输入事件同样用委托，在 bind() 里绑定一次
}

/* 近6个月支出柱状趋势（高清DPR） */
function renderTrend(){
  const canvas = $('trend');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = 640, H = 220;
  canvas.width = W*dpr; canvas.height = H*dpr;
  ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);
  // 最近 6 个月：以「本月」为准而非当前查看的月份（保持原行为），
  // 各月支出直接取聚合结果，不再逐月扫描 data
  const months = monthRange(currentMonth(), 6);
  const vals = months.map(m => monthStats(m).exp);
  const maxV = Math.max(1, ...vals);
  const padL = 46, padR = 14, padT = 22, padB = 30;
  const innerW = W-padL-padR, innerH = H-padT-padB;
  // 网格+刻度（颜色随明暗切换，见 themeVar）
  ctx.strokeStyle=themeVar('--chart-grid'); ctx.fillStyle=themeVar('--ink-3'); ctx.font='10px sans-serif';
  ctx.textAlign='right'; ctx.textBaseline='middle';
  for(let g=0; g<=4; g++){
    const y = padT + innerH - (g/4)*innerH;
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(W-padR,y); ctx.stroke();
    ctx.fillStyle=themeVar('--ink-3');
    ctx.fillText('¥' + fmtSci(maxV*g/4), padL-6, y);
  }
  // 柱
  const bw = innerW/vals.length * 0.5;
  ctx.textAlign='center'; ctx.textBaseline='top';
  vals.forEach((v,i)=>{
    const cx = padL + innerW/vals.length*(i+0.5);
    const barH = (v/maxV)*innerH;
    const bx = cx-bw/2, by = padT+innerH-barH;
    const isCur = i===vals.length-1;
    const grad = ctx.createLinearGradient(0,by,0,padT+innerH);
    if(isCur){ grad.addColorStop(0,themeVar('--primary')); grad.addColorStop(1,themeVar('--primary-dark')); }
    else { grad.addColorStop(0,themeVar('--chart-bar')); grad.addColorStop(1,themeVar('--chart-bar2')); }
    ctx.fillStyle = grad;
    // 圆角柱
    roundRect(ctx,bx,by,bw,Math.max(2,barH),Math.min(5,bw/2)); ctx.fill();
    // 数值
    ctx.fillStyle=themeVar('--ink-2');
    if(v>0) ctx.fillText(fmtSci(v), cx, (by-14)<padT? padT+2 : by-14);
    // 月份标签
    ctx.fillStyle= isCur? themeVar('--primary-dark'):themeVar('--ink-3'); ctx.font = (isCur?'700 ':'' )+'10px sans-serif';
    ctx.fillText(months[i].slice(5)+'月', cx, padT+innerH+8);
  });
}
function roundRect(ctx,x,y,w,h,r){
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r);
  ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r);
  ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

function drawDonut(sorted, total){
  const canvas = $('donut');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const cssSize = Math.min(canvas.getBoundingClientRect().width || 250, 250);
  const px = Math.max(192, Math.round(cssSize * dpr));   // 高清位图，够清晰
  canvas.width = px; canvas.height = px;
  const cx = px/2, cy = px/2;
  const r = px/2 - 6, inner = r * 0.60;
  ctx.clearRect(0,0,px,px);
  if(sorted.length===0){
    ctx.strokeStyle = themeVar('--surface-2'); ctx.lineWidth = 24 * dpr;
    // 描边以路径为中线，外侧会溢出 lineWidth/2；收缩半径保证外缘落在画布边距内
    const strokeR = r - 12 * dpr;
    ctx.beginPath(); ctx.arc(cx,cy,strokeR,0,Math.PI*2); ctx.stroke();
    ctx.fillStyle = themeVar('--ph'); ctx.font = `${15*dpr}px sans-serif`; ctx.textAlign='center';
    ctx.fillText('暂无支出', cx, cy+5*dpr);
    return;
  }
  let start = -Math.PI/2;
  sorted.forEach(item => {
    const c = catName(item.name);
    const angle = (item.value/total) * Math.PI*2;
    ctx.beginPath();
    ctx.arc(cx,cy,r,start,start+angle);
    ctx.arc(cx,cy,inner,start+angle,start,true);
    ctx.closePath();
    ctx.fillStyle = c.color;
    ctx.fill();
    // 段间描边，消除抗锯齿白色细缝
    ctx.lineWidth = 2 * dpr; ctx.strokeStyle = c.color; ctx.stroke();
    start += angle;
  });
}

function renderLegend(sorted, total){
  const el = $('legendList');
  if(sorted.length===0){ el.innerHTML=''; return; }
  el.innerHTML = sorted.map(item => {
    const c = catName(item.name);
    const pct = total>0 ? (item.value/total*100) : 0;
    return `<li>
      <span class="dot" style="background:${c.color}"></span>
      <span class="name">${esc(c.emoji)} ${esc(c.name)}</span>
      <span class="pct">${pct.toFixed(1)}%</span>
      <span class="amt">¥${fmtSci(item.value)}</span>
    </li>`;
  }).join('');
}

/* ============ 添加/编辑 弹窗 ============ */
const overlay = $('overlay');
let formType = 'expense';
let formChannel = '其他';

function openSheet(id){
  editingId = id || null;
  setType(id ? (data.find(t=>t.id===id).type) : 'expense');
  setCat(id ? data.find(t=>t.id===id).category : '餐饮');
  formChannel = id ? (data.find(t=>t.id===id).channel || '其他') : '其他';
  $('amount').value = id ? (data.find(t=>t.id===id).amount/100) : '';
  $('note').value = id ? (data.find(t=>t.id===id).note||'') : '';
  $('date').value = id ? data.find(t=>t.id===id).date : todayStr();
  $('sheetTitle').textContent = id ? '编辑' : (formType==='expense'?'记一笔支出':'记一笔收入');
  $('delBtn').style.display = id ? 'block':'none';
  renderChannelGrid();
  setChannel(formChannel);
  openOverlayEl('overlay');
}
function closeSheet(){ closeOverlayEl('overlay'); }

function setType(type){
  formType = type;
  document.querySelectorAll('#typeSeg button').forEach(b=>{
    b.classList.toggle('on', b.dataset.type===type);
    b.classList.toggle('expense', type==='expense');
    b.classList.toggle('income', type==='income');
  });
  // 收入也给几个分类
  const cats = type==='expense' ? CATEGORIES : INCOME_CATS;
  const grid = $('catGrid');
  grid.innerHTML = cats.map(c=>`<button type="button" class="c" data-name="${c.name}"
     style="--c:${c.color};--cgbg:${hexA(c.color,.14)}"><span class="e">${c.emoji}</span><span class="n">${c.name}</span></button>`).join('');
  // 点击由 bind() 里的委托处理
  if(formType==='expense') setCat('餐饮');
  else setCat(INCOME_CATS[0] ? INCOME_CATS[0].name : '其他');
  $('sheetTitle').textContent = editingId ? '编辑' : (type==='expense'?'记一笔支出':'记一笔收入');
}
function setCat(name){
  $$('#catGrid .c').forEach(el=>{
    el.classList.toggle('sel', el.dataset.name===name);
  });
}

function renderChannelGrid(){
  const grid = $('chanGrid');
  grid.innerHTML = CHANNELS.map(c=>`<button type="button" class="ch" data-name="${c.name}"
    style="--c:${c.color};--cgbg:${hexA(c.color,.14)}"><span class="e">${c.emoji}</span><span class="n">${c.name}</span></button>`).join('');
  // 点击由 bind() 里的委托处理
}
function setChannel(name){
  formChannel = name;
  $$('#chanGrid .ch').forEach(el=>{
    el.classList.toggle('sel', el.dataset.name===name);
  });
}

function toast(msg){
  const t = $('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(t._t); t._t = setTimeout(()=>t.classList.remove('show'),1600);
}

function saveEntry(){
  const amount = toCents($('amount').value);
  if(amount<=0){ toast('请输入有效金额'); return; }
  const cat = document.querySelector('#catGrid .c.sel')?.dataset?.name || '其他';
  const note = $('note').value.trim();
  const date = $('date').value || todayStr();
  const entry = { id: editingId || Date.now().toString(36)+Math.random().toString(36).slice(2,5),
    type: formType, amount, category: cat, note, date, channel: formChannel, updatedAt: Date.now() };
  if(editingId){
    const i = data.findIndex(t=>t.id===editingId);
    if(i>-1) data[i] = entry;
  } else {
    data.push(entry);
  }
  save(); closeSheet(); renderAll();
  toast(editingId ? '已更新' : '记好了 ✓');
}

function delEntry(){
  if(!editingId) return;
  openOverlayEl('confirmOverlay');
}
function confirmDel(){
  if(!editingId){ closeConfirm(); return; }
  data = data.filter(t=>t.id!==editingId);
  save(); closeSheet(); closeConfirm(); renderAll();
  toast('已删除');
}
function closeConfirm(){ closeOverlayEl('confirmOverlay'); }

/* ============ 月份选择器 ============ */
function todayYear(){ return new Date().getFullYear(); }
function todayMonth(){ return new Date().getMonth()+1; }
function openMonthPicker(){
  const [y] = viewMonth.split('-').map(Number);
  pickerYear = y;
  renderMonthGrid();
  openOverlayEl('monthOverlay');
}
function closeMonthPicker(){ closeOverlayEl('monthOverlay'); }
function renderMonthGrid(){
  $('mpYear').textContent = pickerYear;
  const nowY = todayYear(), nowM = todayMonth();
  const [vy, vm] = viewMonth.split('-').map(Number);
  const grid = $('monthGrid');
  grid.innerHTML = '';
  for(let mo=1; mo<=12; mo++){
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'm'
      + (vy===pickerYear && vm===mo ? ' sel' : '')
      + (nowY===pickerYear && nowM===mo ? ' isNow' : '');
    b.textContent = mo + '月';
    b.dataset.mo = mo;                 // 点击逻辑由 bind() 里的委托处理
    grid.appendChild(b);
  }
}

/* ============ 账单导入 ============ */
// 进度遮罩控制
function showProgress(title){
  $('progTitle').textContent = title;
  $('progFill').style.width = '0%';
  $('progText').innerHTML = '<span class="p-spin"></span>请稍候，勿操作';
  $('progressOverlay').classList.add('show');
  lockBodyScroll(true);
}
function updateProgress(pct, text){
  $('progFill').style.width = Math.max(0, Math.min(100, pct)) + '%';
  const t = $('progText');
  t.innerHTML = text ? text : '请稍候，勿操作';
}
function hideProgress(){
  $('progressOverlay').classList.remove('show');
  if(!overlayStack.length) lockBodyScroll(false);
}

function importBill(){
  pickFile();
}

/* ---------- 文件读取工具（把回调式的 FileReader 包成 Promise） ---------- */
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

// 读取文件为 ArrayBuffer；带 20 秒超时与中断兜底，失败时抛出可展示的错误信息
function readAsArrayBuffer(file, timeoutMs){
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    let timer = null;
    const fail = msg => { if(timer) clearTimeout(timer); reject(new Error(msg)); };
    timer = setTimeout(() => {
      try{ rd.abort(); }catch(e){}
      fail('读取超时：文件可能未下载完毕，请下载到本地后重试');
    }, timeoutMs || 20000);
    rd.addEventListener('load', () => { clearTimeout(timer); resolve(rd.result); });
    rd.addEventListener('error', () => fail('文件读取失败，请重试（iCloud 文件请先下载到手机本地）'));
    rd.addEventListener('abort', () => fail('读取被中断，请重新选择文件'));
    rd.readAsArrayBuffer(file);
  });
}
function readAsText(file){
  return new Promise((resolve, reject) => {
    const rd = new FileReader();
    rd.addEventListener('load', () => resolve(rd.result));
    rd.addEventListener('error', () => reject(new Error('备份文件读取失败，请重试')));
    rd.readAsText(file, 'utf-8');
  });
}
// 账单文本编码探测：微信/支付宝账单多为 GBK，utf-8 解码出现替换符(�)或没有中文时改用 GBK
function decodeBillText(buf){
  let text = new TextDecoder('utf-8').decode(buf);
  if(text.includes('\uFFFD') || !/[\u4e00-\u9fa5]/.test(text)){
    try{ text = new TextDecoder('gbk').decode(buf); }catch(e){}
  }
  return text;
}

// 打开文件选择并处理（可重复调用，支持"再导一份"）
function pickFile(){
  const input = document.createElement('input');
  input.type = 'file';
  // 兼容扩展名 + iOS 常见 MIME（含 octet-stream，避免文件被灰掉选不了）
  input.accept = '.csv,.txt,.json,.xlsx,.CSV,.JSON,.XLSX,' +
    'text/csv,text/plain,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
    'application/octet-stream,text/*';
  input.style.display = 'none';
  document.body.appendChild(input);   // 挂到 DOM，iOS 更稳
  let done = false;
  const cleanup = () => {
    setTimeout(()=>{ if(input.parentNode) input.parentNode.removeChild(input); }, 50);
  };
  input.addEventListener('change', async () => {
    if(done) return; done = true;
    const f = input.files[0];
    if(!f){ cleanup(); return; }
    const fname = (f.name||'').toLowerCase();
    try{
      // 统一入口自动分流：.json 备份恢复；否则按账单解析
      if(/\.json$/.test(fname)){
        const text = await readAsText(f);
        cleanup();
        restoreBackupText(text);
        closeBackup();
        return;
      }
      // 明确不支持旧版二进制 .xls，给提示而不是静默失败
      if(/\.xls$|application\/vnd\.ms-excel/i.test(f.name + (f.type||''))){
        cleanup();
        toast('暂不支持旧版 .xls 表格，请导出为 .xlsx 或 CSV');
        return;
      }
      const isXlsx = /\.xlsx$|application\/vnd\.openxmlformats|officeDocument/i.test(f.name + (f.type||''));
      showProgress('正在读取账单…');
      await sleep(30);                       // 让出主线程，保证进度条先绘制
      const buf = await readAsArrayBuffer(f);
      cleanup();
      let text;
      if(isXlsx){
        updateProgress(0, '正在解析 Excel…');
        await sleep(30);
        try{ text = parseXlsxText(buf); }
        catch(e){ text = null; }
        if(text === null){ hideProgress(); toast('无法读取该 Excel 文件'); return; }
      } else {
        text = decodeBillText(buf);
      }
      mergeAndFinish(text);
    }catch(err){
      hideProgress(); cleanup();
      toast(err && err.message ? err.message : '文件读取失败，请重试');
    }
  });
  // 取消选择：清理 input，不做任何提示（正常取消不算错误）
  input.addEventListener('cancel', ()=>{ if(!done){ done=true; cleanup(); } });
  input.click();
}

// 解析 → 写入（分帧更新进度，避免阻塞 UI）
let pendingRecs = [];   // 待确认导入的记录（预览确认后再写入）

function mergeAndFinish(text){
  updateProgress(0, '正在解析交易记录…');
  setTimeout(() => {
    let recs = [];
    try{ recs = parseBill(text); }
    catch(e){ recs = []; }
    if(!recs || recs.length===0){ hideProgress(); toast('未识别到有效的交易记录'); return; }
    pendingRecs = recs;
    showImportPreview(recs);
  }, 30);
}

// 预览：展示识别出的记录与汇总，让用户确认后再写入
function showImportPreview(recs){
  hideProgress();
  const exp = recs.filter(r=>r.type==='expense').reduce((s,r)=>s+(parseFloat(r.amount)||0),0);
  const inc = recs.filter(r=>r.type==='income').reduce((s,r)=>s+(parseFloat(r.amount)||0),0);
  const byCat = {};
  recs.forEach(r=>{ if(r.type==='expense') byCat[r.category]=(byCat[r.category]||0)+1; });
  const catStr = Object.keys(byCat).sort((a,b)=>byCat[b]-byCat[a])
    .map(c=>`${catName(c).emoji} ${esc(c)} ×${byCat[c]}`).join('　');
  $('pvSummary').innerHTML =
    `共识别 <b>${recs.length}</b> 条　支出 ¥${fmt(exp)}　收入 ¥${fmt(inc)}` +
    (catStr?`<br><span class="pv-cats">${catStr}</span>`:'');
  const MAX = 300;
  const list = recs.slice(0, MAX).map(r=>{
    const c = catName(r.category);
    return `<div class="pv-item">
      <span class="pv-date">${esc(r.date)}</span>
      <span class="pv-cat">${esc(c.emoji)} ${esc(c.name)}</span>
      <span class="pv-note">${esc(r.note||'')}</span>
      <span class="pv-amt ${r.type==='income'?'income':'expense'}">${r.type==='income'?'+':'−'}${fmt(r.amount)}</span>
    </div>`;
  }).join('');
  $('pvList').innerHTML = list +
    (recs.length>MAX?`<div class="pv-more">… 仅显示前 ${MAX} 条，共 ${recs.length} 条</div>`:'');
  $('pvConfirm').textContent = `确认导入 ${recs.length} 条`;
  openOverlayEl('previewOverlay');
}
function closePreview(){ closeOverlayEl('previewOverlay'); }
function confirmImport(){
  const recs = pendingRecs;
  if(!recs || !recs.length){ closePreview(); return; }
  pendingRecs = [];
  closePreview();
  writeRecs(recs);
}
// 分帧批量写入（预览确认后调用）
function writeRecs(recs){
  let added = 0, skipped = 0, i = 0;
  const total = recs.length;
  showProgress('正在导入…');
  const BATCH = 250;
  function step(){
    const end = Math.min(i + BATCH, total);
    for(; i<end; i++){
      const r = recs[i];
      if(!r) continue;
      if(isDup(r)){ skipped++; }
      else { data.push(r); markDup(r); added++; }
    }
    updateProgress(Math.round(i/total*100), `正在写入 ${i}/${total} 条…`);
    if(i < total){
      setTimeout(step, 0);   // 让出主线程，进度条可见、界面不卡
    } else {
      save(); renderAll(); hideProgress();
      toast(`导入成功 ${added} 条${skipped?`，已跳过重复 ${skipped} 条`:''}`);
      showContinueImport();   // 提示"再导一份"（如微信/支付宝第二份账单）
    }
  }
  updateProgress(0, `开始写入，共 ${total} 条…`);
  setTimeout(step, 0);
}

// "再导一份" 浮动提示：显示 3.5 秒，点击继续选文件
function showContinueImport(){
  // 若已存在则不重复创建
  let el = $('continueImport');
  if(!el){
    el = document.createElement('div');
    el.id = 'continueImport';
    el.innerHTML = `💡 <b>还要导别的账单吗？</b><button type="button" id="contBtn">再导一份</button>`;
    document.body.appendChild(el);
    el.querySelector('#contBtn').addEventListener('click', () => { el.classList.remove('show'); pickFile(); });
  }
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(()=>el.classList.remove('show'), 3500);
}

// 每月导入提醒：有历史记录但上月缺失时，提示"该导账单了"
let remindDismissed = loadRemindDismissed();   // {YM:true} 已忽略的月份，持久化跨会话
function loadRemindDismissed(){
  try{ const o = JSON.parse(localStorage.getItem('expense-remind-dismissed')||'{}'); return (o && typeof o==='object') ? o : {}; }
  catch(e){ return {}; }
}
function saveRemindDismissed(){ localStorage.setItem('expense-remind-dismissed', JSON.stringify(remindDismissed)); }
function checkImportReminder(){
  const el = $('importReminder');
  if(!el) return;
  const now = new Date();
  const curYM = currentMonth();
  // 上月 YM
  const lm = new Date(now.getFullYear(), now.getMonth()-1, 1);
  const lastYM = lm.getFullYear() + '-' + String(lm.getMonth()+1).padStart(2,'0');
  const hasHistory = data.length > 0;
  const lastEmpty = monthTransactions(lastYM).length === 0;
  if(!hasHistory || !lastEmpty || remindDismissed[lastYM]){ el.style.display='none'; return; }
  // 上月无记录（无论本月状态）→ 提醒补导入
  const label = lm.getFullYear()+'年'+(lm.getMonth()+1)+'月';
  el.innerHTML = `
    <span>⚠️ <b>${label}还没有账单</b>，要不要导入一下？</span>
    <button type="button" id="remindGo">去导入</button>
    <button type="button" class="x" id="remindX" aria-label="忽略本次提醒">✕</button>`;
  el.style.display = 'flex';
  el.querySelector('#remindGo').addEventListener('click', ()=>{ remindDismissed[lastYM]=true; saveRemindDismissed(); el.style.display='none'; importBill(); });
  el.querySelector('#remindX').addEventListener('click', ()=>{ remindDismissed[lastYM]=true; saveRemindDismissed(); el.style.display='none'; });
}
function buildDupIndex(){ dupIndex = new Set(data.map(dupKey)); }
function isDup(r){
  if(!dupIndex) buildDupIndex();
  return dupIndex.has(dupKey(r));
}
// 记录被写入 data 后同步登记，保证同一文件内部的重复也能识别
function markDup(r){ if(dupIndex) dupIndex.add(dupKey(r)); }

/* ============ 渲染总调度 ============ */
function renderAll(){
  renderHeader(); renderCatFilter(); renderLedger();
  if(currentTab==='stats'){ renderStats(); statsDirty=false; }
  else { statsDirty=true; }
  checkImportReminder();
}

/* ============ 事件绑定 ============
 * 统一用 addEventListener；会被反复重建的内容（分类胶囊、月份格子、分类/渠道选项、
 * 预算输入框）用「事件委托」挂在稳定的父容器上，只绑一次，避免每次重绘都重新绑定。
 */
function bindHeader(){
  // 月份前后切换
  $('prevMonth').addEventListener('click', ()=>{
    const [y,m]=viewMonth.split('-').map(Number);
    viewMonth = (m===1 ? (y-1)+'-12' : y+'-'+String(m-1).padStart(2,'0'));
    renderAll();
  });
  $('nextMonth').addEventListener('click', ()=>{
    const [y,m]=viewMonth.split('-').map(Number);
    viewMonth = (m===12 ? (y+1)+'-01' : y+'-'+String(m+1).padStart(2,'0'));
    renderAll();
  });

  // 总预算输入（每敲一个字就存，故只更新头部，不重绘整个统计页）
  $('budgetTotal').addEventListener('input', ()=>{
    const v = toCents($('budgetTotal').value);
    budget.total = v > 0 ? v : 0;
    saveBudget();
    renderHeader();
  });
}

function bindTabs(){
  $$('nav.tabs .tab').forEach(tab=>{
    tab.addEventListener('click', ()=>{
      currentTab = tab.dataset.tab;
      $$('nav.tabs .tab').forEach(t=>{
        const on = t===tab;
        t.classList.toggle('active', on);
        if(on) t.setAttribute('aria-current','page'); else t.removeAttribute('aria-current');
      });
      $('panel-ledger').classList.toggle('active', currentTab==='ledger');
      $('panel-stats').classList.toggle('active', currentTab==='stats');
      if(currentTab==='stats' && statsDirty){ renderStats(); statsDirty=false; }
    });
  });
}

function bindMonthPicker(){
  $('monthBtn').addEventListener('click', openMonthPicker);
  $('mpPrev').addEventListener('click', ()=>{ pickerYear--; renderMonthGrid(); });
  $('mpNext').addEventListener('click', ()=>{ pickerYear++; renderMonthGrid(); });
  $('mpToday').addEventListener('click', ()=>{
    viewMonth = currentMonth();
    pickerYear = todayYear();
    renderMonthGrid();
    closeMonthPicker();
    renderAll();
  });
  // 12 个月份格子是每次重绘生成的，用委托
  $('monthGrid').addEventListener('click', e=>{
    const b = e.target.closest('.m');
    if(!b) return;
    viewMonth = pickerYear + '-' + String(b.dataset.mo).padStart(2,'0');
    closeMonthPicker();
    renderAll();
  });
  $('monthOverlay').addEventListener('click', e=>{
    if(e.target===e.currentTarget) closeMonthPicker();
  });
}

function bindLedger(){
  $('fabAdd').addEventListener('click', ()=>openSheet(null));

  // 点击列表项编辑（列表每次重绘，用委托）
  $('ledgerList').addEventListener('click', e=>{
    const item = e.target.closest('.item');
    if(item) openSheet(item.dataset.id);
  });

  // 分类筛选胶囊（每次重绘，用委托）
  $('catFilter').addEventListener('click', e=>{
    const chip = e.target.closest('.cf');
    if(!chip) return;
    viewCat = chip.dataset.cat;
    renderCatFilter();
    renderLedger();
  });

  // 桌面鼠标：滚轮横向滚动分类筛选条（触屏本来就能滑动，故只在需要滚动时接管）
  const catFilterEl = $('catFilter');
  catFilterEl.addEventListener('wheel', e => {
    if(catFilterEl.scrollWidth <= catFilterEl.clientWidth) return;   // 未溢出则不拦截
    const d = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    catFilterEl.scrollLeft += d;
    e.preventDefault();
  }, {passive:false});

  // 分类预算输入（每次重绘，用委托；改完只刷新头部）
  $('budgetCats').addEventListener('input', e=>{
    const inp = e.target.closest('.bc-in');
    if(!inp) return;
    const name = inp.dataset.cat;
    const cents = toCents(parseFloat(inp.value));
    if(cents > 0) budget.cats[name] = cents; else delete budget.cats[name];
    saveBudget();
    // 该分类本月已花：直接取聚合结果（每敲一个字都会跑，不再扫一遍当月记录）
    const used = monthStats(viewMonth).byCat[name] || 0;
    const over = cents > 0 && used > cents;
    inp.style.color = over ? 'var(--expense)' : 'var(--ink)';
    inp.style.fontWeight = over ? '700' : '400';
    inp.style.borderBottomColor = over ? 'var(--expense)' : 'var(--line-strong)';
    renderHeader();
  });
}

function bindSheet(){
  // 支出 / 收入切换
  $$('#typeSeg button').forEach(b=>b.addEventListener('click', ()=>setType(b.dataset.type)));

  // 分类与渠道选项（每次重绘，用委托）
  $('catGrid').addEventListener('click', e=>{
    const c = e.target.closest('.c');
    if(c) setCat(c.dataset.name);
  });
  $('chanGrid').addEventListener('click', e=>{
    const c = e.target.closest('.ch');
    if(c) setChannel(c.dataset.name);
  });

  // 保存 / 删除 / 关闭
  $('saveBtn').addEventListener('click', saveEntry);
  $('delBtn').addEventListener('click', delEntry);
  $('confirmDelBtn').addEventListener('click', confirmDel);
  $('confirmCancelBtn').addEventListener('click', closeConfirm);
  $('confirmOverlay').addEventListener('click', e=>{ if(e.target===e.currentTarget) closeConfirm(); });
  overlay.addEventListener('click', e=>{ if(e.target===overlay) closeSheet(); });
}

function bindImportPreview(){
  $('pvConfirm').addEventListener('click', confirmImport);
  $('pvCancel').addEventListener('click', closePreview);
  $('previewOverlay').addEventListener('click', e=>{ if(e.target===e.currentTarget) closePreview(); });
}

function bindBackup(){
  $('backupBtn').addEventListener('click', openBackup);
  $('bkExport').addEventListener('click', exportBackup);
  $('bkImport').addEventListener('click', pickFile);
  $('backupOverlay').addEventListener('click', e=>{ if(e.target===e.currentTarget) closeBackup(); });
}

function bind(){
  bindHeader();
  bindTabs();
  bindMonthPicker();
  bindLedger();
  bindSheet();
  bindImportPreview();
  bindBackup();
}

bind();
renderAll();


/* ============ 明暗切换 ============
 * CSS 变量会自动跟随系统切换，但 canvas 上已经画好的像素不会自己重画，
 * 所以这里监听系统配色变化，重绘统计页（含趋势图与甜甜圈）。
 */
(function watchColorScheme(){
  if(!window.matchMedia) return;
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const onChange = () => {
    if(currentTab==='stats'){ renderStats(); statsDirty = false; }
    else { statsDirty = true; }   // 记账页没有图表，等切到统计页再重绘
  };
  if(mq.addEventListener) mq.addEventListener('change', onChange);
  else if(mq.addListener) mq.addListener(onChange);   // 老 Safari
})();

/* ============ 离线/服务 ============ */
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  });
}

})();   // 结束 IIFE：所有函数与状态都封装在闭包内，不再污染 window
