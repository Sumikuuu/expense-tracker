/* ============================================================
 * stats.js —— 月份索引与聚合（纯函数，无 DOM）
 *
 * 为什么单独一层：app.js 过去每次渲染都要反复全量扫描 data ——
 * 表头 1 次、账本 1 次、统计 1 次、趋势图 6 次、导入提醒 1 次，共 10 次。
 * 单月账单可能上千条、攒几个月就是上万条，这 10 次扫描于是成了
 * 每次切月 / 记账 / 删除都要付的固定开销。
 *
 * 这里把「分月 + 聚合」抽成无 DOM 依赖的纯逻辑：app.js 只扫一遍，
 * 并且这部分能被 Node 直接测试（app.js 的渲染逻辑依赖 DOM，目前测不了）。
 *
 * 设计约束：与 parser.js 一致 —— 全部是纯函数，不访问 DOM、不读写 localStorage。
 * 兼容两种运行环境：
 *   浏览器：作为普通脚本加载，挂到 window.ExpenseStats
 *   Node  ：module.exports，供 test/index.js 使用
 * ============================================================ */
(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.ExpenseStats = api;
})(typeof self !== 'undefined' ? self : this, function(){
'use strict';

/** 取金额：与 app.js 旧 sum() 的 `parseFloat(t.amount)||0` 保持一致（非法值归 0） */
function amt(v){ return parseFloat(v) || 0; }

/**
 * 从 'YYYY-MM-DD' 取出 'YYYY-MM'。
 * 用 String() 包一层：日期理论上必是字符串，但对被手工改坏的 localStorage 数据
 * 也不会像旧的 `(t.date||'').slice()` 那样直接抛 TypeError。
 * @param {*} date
 * @returns {string} 无日期返回 ''（归入 '' 桶，任何月份都取不到它）
 */
function monthOf(date){ return String(date==null ? '' : date).slice(0, 7); }

/** 账本排序：日期倒序。同一天返回 0，靠 Array.prototype.sort 的稳定性保持原有顺序 */
function byDateDesc(a, b){ return (b.date||'').localeCompare(a.date||''); }

function emptyAgg(){
  return {exp:0, inc:0, byCat:Object.create(null), byCh:Object.create(null)};
}

/**
 * 一次全量扫描，建两张表。
 * @param {Array} data 全部记录
 * @returns {{byMonth:Map<string,Array>, agg:Map<string,Object>}}
 *   byMonth: 'YYYY-MM' → 该月记录数组（保持 data 中的原始顺序）
 *   agg:     'YYYY-MM' → {exp, inc, byCat, byCh}
 */
function build(data){
  const byMonth = new Map();
  const agg = new Map();
  for(const t of (data || [])){
    const m = monthOf(t.date);
    let list = byMonth.get(m);
    if(!list){ list = []; byMonth.set(m, list); }
    list.push(t);

    let a = agg.get(m);
    if(!a){ a = emptyAgg(); agg.set(m, a); }
    const v = amt(t.amount);
    if(t.type === 'income'){
      a.inc += v;
    } else if(t.type === 'expense'){
      // 只认显式的 expense：未知 type 与旧的 sum(list,'expense') 一样两边都不计
      a.exp += v;
      a.byCat[t.category] = (a.byCat[t.category]||0) + v;
      const ch = t.channel || '其他';
      a.byCh[ch] = (a.byCh[ch]||0) + v;
    }
  }
  return {byMonth: byMonth, agg: agg};
}

/**
 * 取某月记录。
 * @param {Object} index build() 的返回值
 * @param {string} ym 'YYYY-MM'
 * @returns {Array} 内部数组本身，**调用方只读**：需要排序或修改请先自行复制
 *   （账本那条路径走 groupByDate，它内部已经复制过，是安全的）
 */
function monthList(index, ym){ return index.byMonth.get(ym) || []; }

/**
 * 取某月聚合。缺失的月份返回全零对象；每次新建，避免共享可变状态被误改。
 * @param {Object} index build() 的返回值
 * @param {string} ym 'YYYY-MM'
 * @returns {{exp:number, inc:number, byCat:Object, byCh:Object}}
 */
function monthAgg(index, ym){ return index.agg.get(ym) || emptyAgg(); }

/**
 * 按日期分组：日期倒序，组内保持原有顺序，并顺带算好组内支出合计。
 * 不修改入参 —— 传进来的很可能就是索引内部缓存的那个数组。
 * @param {Array} records
 * @returns {Array<{date:string, records:Array, expense:number}>}
 */
function groupByDate(records){
  const sorted = (records || []).slice().sort(byDateDesc);
  const seen = new Map();
  const groups = [];
  for(const t of sorted){
    const d = t.date || '';
    let g = seen.get(d);
    if(!g){ g = {date:d, records:[], expense:0}; seen.set(d, g); groups.push(g); }
    g.records.push(t);
    if(t.type === 'expense') g.expense += amt(t.amount);
  }
  return groups;
}

/**
 * 以 endYM 结尾、往前数 count 个月的 YYYY-MM 列表（升序）。
 * 跨年借位交给 Date 处理（如 2026-01 往前 5 个月会正确落到 2025-08）。
 * @param {string} endYM 末尾月份 'YYYY-MM'
 * @param {number} count 月份个数
 * @returns {string[]}
 */
function monthRange(endYM, count){
  const [y, m] = String(endYM).split('-').map(Number);
  const out = [];
  for(let i=count-1; i>=0; i--){
    const d = new Date(y, m-1-i, 1);
    out.push(d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'));
  }
  return out;
}

/* ===== 对外导出：只导出 app.js 与测试真正用到的名字 ===== */
return {
  build: build,
  monthList: monthList,
  monthAgg: monthAgg,
  groupByDate: groupByDate,
  monthRange: monthRange
};
});
