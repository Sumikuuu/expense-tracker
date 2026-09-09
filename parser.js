/* ============================================================
 * parser.js —— 账单解析、分类推断与记录规范化
 *
 * 设计约束：本文件内全部是纯函数（给定输入必然得到相同输出），
 * 不访问 DOM、不读写 localStorage，因此可以被自动化测试直接调用。
 *
 * 兼容两种运行环境：
 *   浏览器：作为普通脚本加载，挂到 window.ExpenseParser
 *   Node  ：module.exports，供 test/parser.test.js 使用
 * ============================================================ */
(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.ExpenseParser = api;
})(typeof self !== 'undefined' ? self : this, function(){
'use strict';

/* ===== 分类与渠道定义 ===== */
/* ============ 数据模型 ============ */
const CATEGORIES = [
  {name:'餐饮', emoji:'🍜', color:'#ff6b6b'},
  {name:'交通', emoji:'🚇', color:'#4dabf7'},
  {name:'购物', emoji:'🛒', color:'#9775fa'},
  {name:'娱乐', emoji:'🎮', color:'#ffa94d'},
  {name:'通讯', emoji:'📱', color:'#22b8cf'},
  {name:'学习', emoji:'📚', color:'#38d9a9'},
  {name:'医疗', emoji:'💊', color:'#63e6be'},
  {name:'居住', emoji:'🏠', color:'#868e96'},
  {name:'其他', emoji:'📦', color:'#adb5bd'},
];
const CHANNELS = [
  {name:'微信零钱', emoji:'💚', color:'#07c160'},
  {name:'支付宝', emoji:'💙', color:'#3b6cff'},
  {name:'银行卡', emoji:'💳', color:'#7c5ef0'},
  {name:'现金', emoji:'💵', color:'#ff9f43'},
  {name:'其他', emoji:'🏷️', color:'#adb5bd'},
];
const INCOME_CATS = [
  {name:'工资', emoji:'💰', color:'#22b573'},
  {name:'兼职', emoji:'💼', color:'#38d9a9'},
  {name:'奖金', emoji:'🧧', color:'#ffd43b'},
  {name:'其他', emoji:'🎁', color:'#adb5bd'},
];

/* ===== 基础工具：金额 / 文本 / 显示 ===== */
function toCents(x){
  const n = parseFloat(x);
  if(!isFinite(n)) return 0;
  return Math.round(n*100);
}
function fmt(n){ // 输入为「分」，显示为元（两位小数）
  const c = Math.round(parseFloat(n)||0);
  return (c/100).toLocaleString('zh-CN', {minimumFractionDigits:2, maximumFractionDigits:2});
}
function fmtSci(n){ // 输入为「分」，显示为元（最多两位）
  const c = Math.round(parseFloat(n)||0);
  return (c/100).toLocaleString('zh-CN', {maximumFractionDigits:2});
}
function esc(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function catName(name){ for(const c of CATEGORIES){ if(c.name===name) return c; } return CATEGORIES[CATEGORIES.length-1]; }
function channelName(n){ for(const c of CHANNELS){ if(c.name===n) return c; } return CHANNELS[4]; }

function genId(){ return Date.now().toString(36)+Math.random().toString(36).slice(2,6); }

// 清洗单元格：去掉空占位符（微信用 "/" 表示无值）
function cleanVal(v){
  const s = (v||'').trim();
  return (s==='/'||s==='-'||s==='—'||s==='') ? '' : s;
}

/* ===== xlsx 解析（依赖 pako 解压，见 unzip 的依赖注入） ===== */

function unzip(u8, inflateRaw){
  // 解压依赖可注入：浏览器用全局 pako，Node 测试可传桩函数
  const inflate = inflateRaw || (typeof pako !== 'undefined' ? pako.inflateRaw : null);
  if(!inflate) throw new Error('缺少解压依赖 pako');
  // 解析 zip（本地文件头 + 中央目录），用 pako 解压 deflate
  const entries = {};
  let p = 0;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  while(p < u8.length - 4){
    const sig = dv.getUint32(p, true);
    if(sig === 0x04034b50){ // local file header
      const method = dv.getUint16(p+8, true);
      const csize = dv.getUint32(p+18, true);
      const usize = dv.getUint32(p+22, true);
      const nameLen = dv.getUint16(p+26, true);
      const extraLen = dv.getUint16(p+28, true);
      const name = new TextDecoder('utf-8').decode(u8.subarray(p+30, p+30+nameLen));
      const dataStart = p+30+nameLen+extraLen;
      let content;
      if(method===8){ content = inflate(new Uint8Array(u8.buffer, u8.byteOffset+dataStart, csize)); }
      else if(method===0){ content = u8.subarray(dataStart, dataStart+usize); }
      else { p = dataStart+csize; continue; }
      entries[name] = content;
      p = dataStart + csize;
    } else if(sig === 0x02014b50){ // central dir — stop
      break;
    } else {
      p += 1;
    }
  }
  return entries;
}

// 简单 xlsx→CSV 文本转换（共享字符串 + 序列号日期 → 日期字符串），依赖 pako
function parseXlsxText(buf){
  try{
    // 解析 zip 目录，取每个条目内容
    const entries = unzip(new Uint8Array(buf));
    const ssXml = entries['xl/sharedStrings.xml'];
    if(!entries['xl/worksheets/sheet1.xml']){
      // 尝试用 rels 定位第一个工作表（多 sheet 场景）
      const relsRaw = entries['xl/_rels/workbook.xml.rels'] || '';
      const rels = new TextDecoder('utf-8').decode(relsRaw);
      const firstRel = (rels.match(/<Relationship[^>]*Target="worksheets\/[^"]*"[^>]*>/)||[''])[0];
      const target = (firstRel.match(/Target="([^"]*)"/)||[])[1];
      if(target) entries['xl/worksheets/sheet1.xml'] = entries['xl/'+target];
    }
    if(!ssXml || !entries['xl/worksheets/sheet1.xml']) return null;
    // 解码 XML 为文本再解析（否则 Uint8Array 会 toString 成逗号列表）
    const ssText = new TextDecoder('utf-8').decode(ssXml);
    const sheetText = new TextDecoder('utf-8').decode(entries['xl/worksheets/sheet1.xml']);
    const shared = parseSS(ssText);
    return sheetToCsv(sheetText, shared);
  }catch(e){ return null; }
}

function parseSS(xml){
  const list = [];
  const re = /<si[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while((m = re.exec(xml)) !== null){
    const inner = m[1];
    const texts = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => xmlUnescape(x[1]));
    list.push(texts.join(''));
  }
  return list;
}
function xmlUnescape(s){
  return s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
          .replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&#(\d+);/g,(_,n)=>String.fromCharCode(n));
}
function cellType(c){ const m = c.match(/t="([^"]*)"/); return m?m[1]:''; }
function sheetToCsv(xml, shared){
  const rows = [];
  const rowRe = /<row[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while((rm = rowRe.exec(xml)) !== null){
    const rowXml = rm[1];
    const cells = [];
    const cRe = /<c([^>]*)>([\s\S]*?)<\/c>|<c([^>]*)\/>/g;
    let cm;
    const cellMap = {};
    while((cm = cRe.exec(rowXml)) !== null){
      const attrs = cm[1] || cm[3] || '';
      const ref = (attrs.match(/r="([^"]*)"/)||[])[1] || '';
      const colLetter = (ref.match(/[A-Z]+/)||['A'])[0];
      const colIdx = colLetterToNum(colLetter);
      const t = cellType(attrs);
      let val = '';
      if(cm[2]){ // has <v>
        const vm = cm[2].match(/<v[^>]*>([\s\S]*?)<\/v>/);
        const isStr = /<is[^>]*>/.test(cm[2]);
        if(isStr){
          const tm = cm[2].match(/<t[^>]*>([\s\S]*?)<\/t>/);
          val = tm?xmlUnescape(tm[1]):'';
        } else if(t==='s'){
          const idx = vm?parseInt(vm[1]):0;
          val = shared[idx]!==undefined ? shared[idx] : '';
        } else if(t==='inlineStr'){
          const tm = cm[2].match(/<t[^>]*>([\s\S]*?)<\/t>/);
          val = tm?xmlUnescape(tm[1]):'';
        } else {
          val = vm?vm[1]:'';
        }
      }
      cellMap[colIdx] = val;
    }
    // 填补空列
    let maxCol = 0;
    Object.keys(cellMap).forEach(k=>{ if(+k>maxCol) maxCol=+k; });
    const row = [];
    for(let i=0;i<=maxCol;i++) row.push(cellMap[i]!==undefined?cellMap[i]:'');
    rows.push(row);
  }
  return rows.map(r => r.map((cv,ci) => normalizeCell(cv,ci)).join(',')).join('\n');
}
function colLetterToNum(s){
  let n=0;
  for(const ch of s){ n = n*26 + (ch.charCodeAt(0)-64); }
  return n-1; // 0-based
}
// Excel 单元格值 -> 合适字符串。仅对第1列(时间列)把日期序列号转成日期，避免金额被误转
function normalizeCell(v, ci){
  if(v==='') return '';
  if(/^\d+(\.\d+)?$/.test(v)){
    const n = parseFloat(v);
    if(ci===0 && n>20000 && n<90000){ return excelDateToStr(n); } // 仅当位于首列且是日期序列号
    return String(v);
  }
  return v;
}
function excelDateToStr(serial){
  // Excel 序列号，(1900-01-01) 1 = 1900-01-01。修正 1900-02-29 bug
  let d = new Date(Date.UTC(1899,11,30) + Math.floor(serial)*86400000);
  if(serial < 60) d = new Date(Date.UTC(1899,11,31) + Math.floor(serial)*86400000);
  const y = d.getUTCFullYear(), mo = String(d.getUTCMonth()+1).padStart(2,'0'), da = String(d.getUTCDate()).padStart(2,'0');
  return y+'-'+mo+'-'+da;
}

/* ===== 账单文本解析（微信 / 支付宝通用） ===== */

function toRows(text){
  // 单遍字符扫描：引号内不切行、不切列，支持 "" 转义，
  // 因此备注里带换行/逗号的账单也不会断行丢记录
  const rows = [];
  let row = [], cur = '', inQ = false, i = 0;
  const pushCell = () => { row.push(cur.trim()); cur = ''; };
  const pushRow = () => {
    pushCell();
    if(row.some(c => c !== '')) rows.push(row);   // 整行空则丢弃
    row = [];
  };
  while(i < text.length){
    const ch = text[i];
    if(inQ){
      if(ch === '"'){
        if(text[i+1] === '"'){ cur += '"'; i += 2; continue; }   // "" → 一个引号
        inQ = false; i++; continue;
      }
      cur += ch; i++; continue;
    }
    if(ch === '"'){ inQ = true; i++; continue; }
    if(ch === ','){ pushCell(); i++; continue; }
    if(ch === '\r'){ i++; continue; }
    if(ch === '\n'){ pushRow(); i++; continue; }
    cur += ch; i++;
  }
  pushRow();   // 收尾最后一行
  return rows;
}

// 支付宝/微信各类账单通用解析：
// 兼容两种列结构：
//   A 交易流水式：交易时间,交易分类/商品说明,收/支,金额(元),支付方式,...
//   B 记账本明细式：记录时间,分类,收支类型,金额,备注,账户,来源,标签,...
function parseBill(text){
  const rows = toRows(text);
  if(!rows.length) return [];
  // 找真正的表头行：含“时间”列名 且 含“金额”列名，跳过前面的说明文字
  let hi = rows.findIndex(r => r.some(c => /时间/.test(c)) && r.some(c => /金额/.test(c)));
  if(hi < 0) return [];
  const head = rows[hi].map(c => c.trim());
  const idx = {};
  head.forEach((c,i) => {
    if(/记录时间|交易时间|时间/.test(c)) idx.time = i;
    else if(/收支类型|收\/支|收支/.test(c)) idx.flow = i;
    else if(/金额/.test(c)) idx.amt = i;
    else if(/分类|交易分类/.test(c)) idx.rawcat = i;     // 支付宝自带分类
    else if(/交易对方|对方/.test(c)) idx.party = i;
    else if(/商品说明|商品/.test(c)) idx.desc = i;        // 商品/商品说明
    else if(/账户|支付方式|收\/付款方式|付款方式/.test(c)) idx.pay = i;
    else if(/当前状态|交易状态|状态/.test(c)) idx.status = i;  // 微信"当前状态"、支付宝"交易状态"
    else if(/备注/.test(c)) idx.note = i;                 // 备注
  });
  if(idx.time===undefined || idx.amt===undefined) return [];
  const recs = [];
  for(let i=hi+1; i<rows.length; i++){
    const r = rows[i];
    let time = (r[idx.time]||'').trim();
    const rawAmt = (r[idx.amt]||'').trim();
    // 时间列可能是 Excel 日期序列号（如 45000），转成日期字符串
    if(/^\d{4}-\d{1,2}-\d{1,2}/.test(time)){ /* 已是日期 */ }
    else if(/^\d+(\.\d+)?$/.test(time) && parseFloat(time)>20000 && parseFloat(time)<90000){
      time = excelDateToStr(Math.floor(parseFloat(time)));
    }
    if(!/^\d{4}-\d{1,2}-\d{1,2}/.test(time) || !rawAmt) continue;
    // 金额可能为负或带 ¥/￥/空格，取绝对值
    const amt = toCents(Math.abs(parseFloat(rawAmt.replace(/,/g,'').replace(/[¥￥]/g,'').trim())));
    if(amt<=0) continue;
    const flowRaw = (r[idx.flow]||'').trim();
    // 中性交易（提现/充值/理财/还款等）：收/支为“/”或空，跳过，不计入收支
    if(!flowRaw || flowRaw==='/' || flowRaw==='—' || flowRaw==='-') continue;
    let type = /收|入|income/i.test(flowRaw) ? 'income' : 'expense';
    if(/支|出|expense/i.test(flowRaw) && !/收/.test(flowRaw)) type = 'expense';
    const party = cleanVal(r[idx.party]);
    const desc = cleanVal(r[idx.desc]);
    const rawcat = cleanVal(r[idx.rawcat]);              // 支付宝分类
    const payRaw = cleanVal(r[idx.pay]);
    const status = cleanVal(r[idx.status]);             // 当前状态/交易状态
    const note = cleanVal(r[idx.note]);
    const isRefund = /退款|退回|失败，已退还/i.test(status);
    // 分类优先：支付宝自带的分类 > 关键词归（归类时合并 商品+交易对方，商家名常在对方列）
    let category = (rawcat && mapAlipayCat(rawcat)) || guessCat(type, party+' '+desc+' '+note+' '+status);
    if(isRefund) category = '其他';
    const channel = guessChannel(payRaw, desc, party);
    const date = time.slice(0,10).replace(/\//g,'-');
    recs.push({ id: genId(), type, amount: amt, category, note: note || party || desc || category,
      date, channel, updatedAt: Date.now() });
  }
  return recs;
}

// 支付宝分类 → 内置分类
function mapAlipayCat(c){
  const m = {
    '交通':'交通','餐饮':'餐饮','购物':'购物','娱乐':'娱乐','休闲玩乐':'娱乐',
    '生活日用':'购物','生活服务':'其他','穿搭美容':'购物','生意':'其他',
    '医疗':'医疗','学习':'学习','居住':'居住','其他':'其他','通讯':'通讯',
    '充值缴费':'通讯','酒店旅游':'娱乐','运动户外':'购物','转账':'其他',
    '社交':'其他','话费':'通讯','生活缴费':'通讯'
  };
  return m[c] || null;
}

// 关键词 → 分类（传入的 s 已合并 交易对方+商品+备注）
function guessCat(type, s){
  if(type==='income'){
    if(/退款|退回|极速退款/.test(s)) return '其他';        // 退款/退回是返还，不是收入
    if(/工资|薪|薪资/.test(s)) return '工资';
    if(/红包|奖|兼|结款|生意|收钱码|收款/.test(s)) return '奖金';
    if(/转账/.test(s)) return '其他';
    return '其他';   // 无法判断的收入归入「其他」，不再默认成工资
  }
  // 通讯：话费/流量/宽带（必须先于“居住”）
  if(/话费|流量|宽带|中国电信|中国移动|中国联通|电信充值|移动充值|联通充值|充话|手机费|通讯/.test(s)) return '通讯';
  // 其他：转账/AA/请客/红包人情（微信转账给朋友等，并入其他）
  if(/转账|AA|请客|红包|人情|喝喜酒|随礼|份子/.test(s)) return '其他';
  // 餐饮：奶茶/咖啡/外卖/快餐/茶饮/便利店零食（「面」「粉」过宽会误吞“面试”，改为词组）
  if(/餐|饭|美团|饿了么|外卖|奶茶|咖啡|火锅|烧烤|食堂|瑞幸|麦当劳|肯德基|食|茶|冰城|蜜雪|饮料|饮品|面包|甜|小吃|面条|拉面|面馆|米粉|螺蛳粉|汉堡|奈雪|喜茶|古茗|7-ELEVEN|美宜佳|便利店|鲜果|果饮/.test(s)) return '餐饮';
  // 交通：地铁/打车/骑行/加油/停车/出行
  if(/地铁|公交|滴滴|打车|快车|出租|高铁|火车|机票|航空|加油|停车|单车|哈啰|骑行|出行|先骑后付|先乘车后付款|自动充值|掌上高铁|12306|联运/.test(s)) return '交通';
  // 娱乐：电影/游戏/游戏币/月卡/门票/订阅类（iCloud/会员/订阅等固定扣费）
  if(/电影|影院|游戏|Steam|Valve|库洛|KTV|唱吧|视频|音乐|娱乐|景区|门票|展览|月相|观察卡|金币|通行证|观影|寰宇|账号|月卡|档|游|订阅|连续包月|自动续费|月费|iCloud|App Store|Apple|Netflix|Spotify|YouTube|会员|VIP|云服务|Monthly/.test(s)) return '娱乐';
  // 居住：房租/水电/物业/宽带/快递/寄件（必须排在「学习」之前：
  // 否则“水费缴费”“物业缴费”会被学习里的缴费类关键词抢走）
  if(/房租|水电|水费|电费|水电气|物业|燃气|取暖|宽带|快递|顺丰|寄件|邮费|居住|房/.test(s)) return '居住';
  // 学习：学费/报名费/课程/资料（不再用宽泛的“缴费”，避免吞掉水电燃气）
  if(/书|课程|学费|报名费|培训|学习|考试|文具|教育|网课|资料|大学|学校|平台缴费/.test(s)) return '学习';
  // 医疗：医院/药店/医保/体检
  if(/药|医院|挂号|诊所|体检|医疗|健康|医保|就医/.test(s)) return '医疗';
  // 购物：电商/百货/数码/服饰/超市/配件硬件
  if(/购物|淘宝|天猫|京东|拼多多|超市|商场|专卖|服饰|衣|鞋|裤|帽|百货|大润发|鼠标|键盘|耳机|键帽|手机|数码|充电|支架|改装|电竞|鼠标垫|钢化|机箱|星闪|水滴|发热/.test(s)) return '购物';
  return '其他';
}

// 支付方式/描述 → 渠道
function guessChannel(pay, desc, party){
  const s = pay+desc+party;
  // 先判支付宝(含“支付宝/小程序”字样)，再判微信，避免“支付宝小程序”被误判
  if(/支付宝|余额|花呗|收钱码|Alipay/i.test(s)) return '支付宝';
  if(/零钱|微信|WeChat|微信支付/i.test(s)) return '微信零钱';
  if(/银行卡|储蓄卡|信用卡|借贷|银行|招行|工行|建行|农行/.test(s)) return '银行卡';
  if(/现金/.test(s)) return '现金';
  return '其他';
}

/* ===== 记录规范化与去重键 ===== */
function dupKey(r){
  return [r.date||'', r.type||'', r.amount||0, r.category||'', r.note||''].join('\u0001');
}

// 备份记录校验：字段非法或分类/渠道不在名单内的记录一律丢弃或回落，
// 避免脏数据进入渲染流程（date 会被拼进 innerHTML，必须严格限定为 YYYY-MM-DD）
function normalizeImportedRecord(r, isCents){
  if(!r || typeof r !== 'object') return null;
  const date = String(r.date == null ? '' : r.date).slice(0, 10);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [, dm, dd] = date.split('-').map(Number);
  if(!(dm >= 1 && dm <= 12 && dd >= 1 && dd <= 31)) return null;   // 拒绝 2026-13-45 这类假日期
  const type = r.type === 'income' ? 'income' : 'expense';
  const amount = isCents ? Math.round(parseFloat(r.amount) || 0) : toCents(r.amount);
  if(!(amount > 0)) return null;
  const knownCat = CATEGORIES.some(c => c.name === r.category)
    || INCOME_CATS.some(c => c.name === r.category);
  const channel = CHANNELS.some(c => c.name === r.channel) ? r.channel : '其他';
  return {
    id: (typeof r.id === 'string' && r.id) ? r.id : genId(),
    type: type,
    amount: amount,
    category: knownCat ? r.category : '其他',
    note: String(r.note == null ? '' : r.note).slice(0, 60),
    date: date,
    channel: channel,
    updatedAt: Number(r.updatedAt) || Date.now()
  };
}

/* ===== 对外导出 ===== */
return {
  CATEGORIES: CATEGORIES, CHANNELS: CHANNELS, INCOME_CATS: INCOME_CATS,
  toCents: toCents, fmt: fmt, fmtSci: fmtSci, esc: esc,
  catName: catName, channelName: channelName, genId: genId, cleanVal: cleanVal,
  toRows: toRows, parseBill: parseBill, guessCat: guessCat,
  mapAlipayCat: mapAlipayCat, guessChannel: guessChannel,
  dupKey: dupKey, normalizeImportedRecord: normalizeImportedRecord,
  parseXlsxText: parseXlsxText,
  // 以下主要供测试与内部复用
  excelDateToStr: excelDateToStr, colLetterToNum: colLetterToNum,
  normalizeCell: normalizeCell, xmlUnescape: xmlUnescape,
  sheetToCsv: sheetToCsv, parseSS: parseSS, cellType: cellType, unzip: unzip
};
});
