/* ============================================================
 * 全部测试（零依赖，只用 Node 内置模块）
 *
 * 运行： npm test   或   node test/index.js
 *
 * 分两部分：
 *   第一部分  业务逻辑回归：账单解析、分类推断、CSV 边界、备份净化、去重键
 *   第二部分  项目一致性：资源引用 / 离线缓存清单 / manifest 图标尺寸 / 模块导出对齐
 *
 * 想加用例，照着任意一个 test('名字', () => { assert(...) }) 复制一份改即可。
 * 断言失败会以非 0 退出码结束。
 * ============================================================ */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../parser.js');

/* ============================================================
 * 极简测试运行器
 * ============================================================ */
let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ✓ ' + name);
  } catch (err) {
    failures.push(name);
    console.log('  ✗ ' + name);
    console.log('      ' + String(err.message).split('\n')[0]);
  }
}

function group(title) {
  console.log('\n' + title);
}

function finish() {
  console.log('\n' + '='.repeat(46));
  console.log('通过 ' + passed + ' 个，失败 ' + failures.length + ' 个');
  if (failures.length) {
    console.log('失败用例：');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
  }
  console.log('全部通过 ✓');
}

/* ---------------------------------------------------------- */
group('1. 金额转换与显示');

test('toCents：元 → 整数分', () => {
  assert.strictEqual(P.toCents('35.5'), 3550);
  assert.strictEqual(P.toCents('0.1'), 10);        // 0.1*100 在浮点下是 10.000000000000002
  assert.strictEqual(P.toCents(12.345), 1235);     // 四舍五入
  assert.strictEqual(P.toCents('abc'), 0);         // 非法输入归零，不抛异常
  assert.strictEqual(P.toCents(null), 0);
});

test('fmt：分 → 两位小数元', () => {
  assert.strictEqual(P.fmt(3550), '35.50');
  assert.strictEqual(P.fmt(0), '0.00');
});

test('fmtSci：分 → 最多两位小数（千分位）', () => {
  assert.strictEqual(P.fmtSci(1200), '12');
  assert.strictEqual(P.fmtSci(348990), '3,489.9');
});

/* ---------------------------------------------------------- */
group('2. HTML 转义（防注入）');

test('esc：转义 & < > " \'', () => {
  assert.strictEqual(P.esc('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.strictEqual(P.esc("A&B\"C'D"), 'A&amp;B&quot;C&#39;D');
  assert.strictEqual(P.esc(null), '');
});

/* ---------------------------------------------------------- */
group('3. CSV 行解析');

test('toRows：普通行', () => {
  assert.deepStrictEqual(P.toRows('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('toRows：引号内的逗号不被切开', () => {
  assert.deepStrictEqual(P.toRows('a,"x,y",c'), [['a', 'x,y', 'c']]);
});

test('toRows：引号内的换行不会断行（旧实现会丢记录）', () => {
  const rows = P.toRows('a,b\n"多行\n备注",c');
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[1][0], '多行\n备注');
});

test('toRows："" 表示一个引号，空行被丢弃', () => {
  assert.deepStrictEqual(P.toRows('a\n""""\nb\n\nc'), [['a'], ['"'], ['b'], ['c']]);
});

/* ---------------------------------------------------------- */
group('4. 分类推断 guessCat（含已修复的误判回归）');

const expenseCases = [
  ['水费缴费', '居住'], ['电费缴纳', '居住'], ['物业缴费', '居住'], ['电费', '居住'],
  ['宽带缴费', '通讯'], ['学校缴费', '学习'], ['面试报名费', '学习'], ['健身房月卡', '娱乐'],
  ['话费充值', '通讯'], ['房租', '居住'], ['外卖', '餐饮'], ['地铁', '交通'],
  ['医院挂号', '医疗'], ['洗衣机', '购物'], ['Steam游戏', '娱乐'], ['8月电费', '居住'],
];
for (const [input, want] of expenseCases) {
  test('支出「' + input + '」→ ' + want, () => {
    assert.strictEqual(P.guessCat('expense', input), want);
  });
}

test('收入：无法判断时归入「其他」而不是「工资」', () => {
  assert.strictEqual(P.guessCat('income', '8月工资'), '工资');
  assert.strictEqual(P.guessCat('income', '红包'), '奖金');
  assert.strictEqual(P.guessCat('income', '股票分红'), '其他');
});

/* ---------------------------------------------------------- */
group('5. 渠道推断 guessChannel');

test('「支付宝小程序」优先判为支付宝，不被微信抢走', () => {
  assert.strictEqual(P.guessChannel('支付宝小程序', '', ''), '支付宝');
});
test('微信 / 银行卡 / 现金', () => {
  assert.strictEqual(P.guessChannel('零钱', '', ''), '微信零钱');
  assert.strictEqual(P.guessChannel('招商银行储蓄卡', '', ''), '银行卡');
  assert.strictEqual(P.guessChannel('现金', '', ''), '现金');
});
test('未知渠道回落「其他」', () => {
  assert.strictEqual(P.guessChannel('', '', ''), '其他');
});

/* ---------------------------------------------------------- */
group('6. 支付宝分类映射');

test('mapAlipayCat：已知分类映射，未知返回 null', () => {
  assert.strictEqual(P.mapAlipayCat('交通'), '交通');
  assert.strictEqual(P.mapAlipayCat('休闲玩乐'), '娱乐');
  assert.strictEqual(P.mapAlipayCat('这个分类不存在'), null);
});

/* ---------------------------------------------------------- */
group('7. xlsx 单元格处理');

test('excelDateToStr：序列号 → 日期', () => {
  assert.strictEqual(P.excelDateToStr(45000), '2023-03-15');
  assert.strictEqual(P.excelDateToStr(1), '1900-01-01');   // 1900 闰年 bug 修正分支
});

test('normalizeCell：只有首列的序列号才当日期，金额列不能被误转', () => {
  assert.strictEqual(P.normalizeCell('45000', 0), '2023-03-15');
  assert.strictEqual(P.normalizeCell('45000', 3), '45000');   // 第 4 列是金额，必须原样保留
});

test('colLetterToNum：Excel 列号 → 0 基索引', () => {
  assert.strictEqual(P.colLetterToNum('A'), 0);
  assert.strictEqual(P.colLetterToNum('Z'), 25);
  assert.strictEqual(P.colLetterToNum('AA'), 26);
});

test('xmlUnescape：还原实体与数字引用', () => {
  assert.strictEqual(P.xmlUnescape('&amp;&lt;&#65;'), '&<A');
});

test('unzip：缺少 pako 时给出明确错误（依赖注入）', () => {
  assert.throws(() => P.unzip(new Uint8Array(4)), /pako/);
});

/* ---------------------------------------------------------- */
group('8. 账单端到端解析 parseBill');

const WECHAT_CSV = '\uFEFF交易时间,交易类型,交易对方,商品,收/支,金额(元),支付方式,当前状态,交易单号,备注\n' +
  '2026-08-01 12:30:00,商户消费,美团,午饭,支出,¥35.50,零钱,支付成功,10001,工作餐\n' +
  '2026-08-02 09:10:00,转账,张三,/,/,200.00,零钱,已收钱,10002,还款\n' +
  '2026-08-03 18:00:00,商户消费,国网电力,电费缴费,支出,120.00,银行卡,支付成功,10003,8月电费\n' +
  '2026-08-04 10:00:00,退款,某商户,退货,收入,50.00,零钱,已全额退款,10004,退款\n' +
  '2026-08-05 10:00:00,商户消费,超市,日用品,支出,"1,234.56",零钱,支付成功,10005,\n';

const recs = P.parseBill(WECHAT_CSV);

test('识别条数正确：收/支为「/」的中性交易被跳过（5 行 → 4 条）', () => {
  assert.strictEqual(recs.length, 4);
});

test('第一条：金额、类型、分类、渠道、备注', () => {
  const r = recs[0];
  assert.strictEqual(r.date, '2026-08-01');
  assert.strictEqual(r.type, 'expense');
  assert.strictEqual(r.amount, 3550);
  assert.strictEqual(r.category, '餐饮');
  assert.strictEqual(r.channel, '微信零钱');
  assert.strictEqual(r.note, '工作餐');
});

test('带千分位的金额「1,234.56」被正确解析为分', () => {
  assert.strictEqual(recs[3].amount, 123456);
});

test('退款行识别为收入且分类为「其他」', () => {
  assert.strictEqual(recs[2].type, 'income');
  assert.strictEqual(recs[2].category, '其他');
});

test('每条记录都有唯一 id', () => {
  const ids = new Set(recs.map(r => r.id));
  assert.strictEqual(ids.size, recs.length);
});

test('非账单文本返回空数组而不是抛异常', () => {
  assert.deepStrictEqual(P.parseBill('这不是账单'), []);
  assert.deepStrictEqual(P.parseBill(''), []);
});

/* ---------------------------------------------------------- */
group('9. 备份记录规范化与去重键');

test('dupKey：同内容同键，任一字段不同则键不同', () => {
  const a = { date: '2026-08-01', type: 'expense', amount: 3550, category: '餐饮', note: '午饭' };
  const b = Object.assign({}, a);
  const c = Object.assign({}, a, { amount: 3551 });
  assert.strictEqual(P.dupKey(a), P.dupKey(b));
  assert.notStrictEqual(P.dupKey(a), P.dupKey(c));
});

test('normalizeImportedRecord：合法记录原样通过', () => {
  const r = P.normalizeImportedRecord({
    id: 'x1', type: 'expense', amount: 3550, category: '餐饮',
    note: '午饭', date: '2026-08-01', channel: '现金',
  }, true);
  assert.strictEqual(r.date, '2026-08-01');
  assert.strictEqual(r.amount, 3550);
  assert.strictEqual(r.category, '餐饮');
});

test('normalizeImportedRecord：日期里的注入内容被截断净化（XSS 回归）', () => {
  const r = P.normalizeImportedRecord({
    id: 'x2', type: 'expense', amount: 1000, category: '餐饮',
    note: 'x', date: '2026-08-02<img src=x onerror=alert(1)>', channel: '现金',
  }, true);
  assert.strictEqual(r.date, '2026-08-02');
  assert.ok(!JSON.stringify(r).includes('<img'));
});

test('normalizeImportedRecord：非法记录返回 null', () => {
  const base = { type: 'expense', amount: 1000, category: '餐饮', note: '', channel: '现金' };
  assert.strictEqual(P.normalizeImportedRecord(Object.assign({}, base, { date: '2026-13-45' }), true), null);
  assert.strictEqual(P.normalizeImportedRecord(Object.assign({}, base, { date: '乱码' }), true), null);
  assert.strictEqual(P.normalizeImportedRecord(Object.assign({}, base, { date: '2026-08-01', amount: -5 }), true), null);
  assert.strictEqual(P.normalizeImportedRecord(null, true), null);
});

test('normalizeImportedRecord：未知分类 / 渠道回落「其他」', () => {
  const r = P.normalizeImportedRecord({
    id: 'x3', type: 'expense', amount: 100, category: '不存在的分类',
    note: '', date: '2026-08-03', channel: '不存在的渠道',
  }, true);
  assert.strictEqual(r.category, '其他');
  assert.strictEqual(r.channel, '其他');
});

const ROOT = path.join(__dirname, '..');
const readText = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const exists = f => fs.existsSync(path.join(ROOT, f));
const isLocal = ref => !/^(https?:)?\/\//.test(ref) && !ref.startsWith('data:') && !ref.startsWith('#');

const html = readText('index.html');
const sw = readText('service-worker.js');
const manifest = JSON.parse(readText('manifest.json'));
const appJs = readText('app.js');

// index.html 里引用的所有本地资源（link[href] / script[src]）
const referenced = [...html.matchAll(/<(?:link|script)\b[^>]*?\b(?:href|src)="([^"]+)"/g)]
  .map(m => m[1])
  .filter(isLocal);

// service-worker.js 的 ASSETS 清单
const assetsBlock = sw.match(/const\s+ASSETS\s*=\s*\[([\s\S]*?)\]/);
const assets = assetsBlock ? [...assetsBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1]) : [];

/* ---------------------------------------------------------- */
group('1. index.html 引用的文件都存在');

test('至少解析到 3 个本地资源（防止正则失效导致检查形同虚设）', () => {
  assert.ok(referenced.length >= 3, '只解析到 ' + referenced.length + ' 个：' + referenced.join(', '));
});

for (const ref of referenced) {
  test('存在：' + ref, () => {
    assert.ok(exists(ref), ref + ' 不存在（index.html 引用了它）');
  });
}

/* ---------------------------------------------------------- */
group('2. 引用的文件都进了 Service Worker 离线缓存');

test('ASSETS 清单可被解析且非空', () => {
  assert.ok(assets.length >= 5, '只解析到 ' + assets.length + ' 项');
});

for (const ref of referenced) {
  // manifest.json 是浏览器直接读的，不参与 SW 预缓存
  if (ref === 'manifest.json') continue;
  test('已缓存：' + ref, () => {
    const normalized = './' + ref.replace(/^\.\//, '');
    assert.ok(assets.includes(normalized), 'ASSETS 里缺少 ' + normalized + '（离线时会 404）');
  });
}

test('ASSETS 里的每个文件都真实存在', () => {
  for (const a of assets) {
    const f = a.replace(/^\.\//, '');
    assert.ok(exists(f), 'ASSETS 列出的 ' + f + ' 不存在');
  }
});

/* ---------------------------------------------------------- */
group('3. manifest.json 的图标与截图');

function pngSize(file) {
  const b = fs.readFileSync(path.join(ROOT, file));
  const isPng = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  return isPng ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
}

for (const icon of manifest.icons) {
  test('图标存在且尺寸一致：' + icon.src, () => {
    assert.ok(exists(icon.src), icon.src + ' 不存在');
    const size = pngSize(icon.src);
    assert.ok(size, icon.src + ' 不是有效的 PNG');
    assert.strictEqual(size.w + 'x' + size.h, icon.sizes, '实际 ' + size.w + 'x' + size.h + '，声明 ' + icon.sizes);
  });
}

test('manifest 声明的截图（如果有）都真实存在且尺寸一致', () => {
  // 截图是可选的：用于浏览器「安装到主屏」时展示预览图。
  // 这里只在 manifest 真的声明了 screenshots 时才校验，避免删掉截图后测试误报。
  const shots = manifest.screenshots || [];
  for (const shot of shots) {
    assert.ok(exists(shot.src), shot.src + ' 不存在');
    const size = pngSize(shot.src);
    assert.ok(size, shot.src + ' 不是有效的 PNG');
    assert.strictEqual(size.w + 'x' + size.h, shot.sizes, '实际 ' + size.w + 'x' + size.h + '，声明 ' + shot.sizes);
  }
});

/* ---------------------------------------------------------- */
group('4. app.js 从 parser.js 解构的名字都已导出');

test('能解析出解构语句', () => {
  const m = appJs.match(/const\s*\{([^}]+)\}\s*=\s*window\.ExpenseParser/);
  assert.ok(m, 'app.js 里找不到 window.ExpenseParser 的解构语句');
});

test('每个名字都在 parser.js 的导出里', () => {
  const m = appJs.match(/const\s*\{([^}]+)\}\s*=\s*window\.ExpenseParser/);
  const names = m[1].split(',').map(s => s.trim()).filter(Boolean);
  const exported = Object.keys(require('../parser.js'));
  const missing = names.filter(n => !exported.includes(n));
  assert.deepStrictEqual(missing, [], 'parser.js 未导出：' + missing.join(', '));
});

/* ---------------------------------------------------------- */
group('5. 结构约定');

test('index.html 不含内联 <style>（样式应全在 styles.css）', () => {
  assert.ok(!/<style[\s>]/.test(html), 'index.html 里出现了内联 <style>');
});

test('index.html 不含内联 <script>（逻辑应全在外部 js）', () => {
  const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
  assert.strictEqual(inline.length, 0, '发现 ' + inline.length + ' 处内联 <script>');
});

test('Service Worker 缓存名符合 expense-tracker-vN 格式', () => {
  const m = sw.match(/const\s+CACHE\s*=\s*'([^']+)'/);
  assert.ok(m, '找不到 CACHE 常量');
  assert.match(m[1], /^expense-tracker-v\d+$/, '当前值：' + m[1]);
});

finish();
