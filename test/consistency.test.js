/* ============================================================
 * 项目一致性检查
 *
 * 这些检查不测业务逻辑，而是防止「改了 A 忘了改 B」这类低级但致命的问题：
 *   1. index.html 引用的本地文件是否存在
 *   2. 这些文件是否都进了 Service Worker 的离线缓存清单
 *   3. manifest.json 里的图标/截图是否存在、尺寸是否与声明一致
 *   4. app.js 从 parser.js 解构的名字是否都被导出
 *   5. 结构约定：index.html 不应再有内联 <style> / <script>
 *
 * 运行： node test/consistency.test.js    或    npm test
 * ============================================================ */
const fs = require('node:fs');
const path = require('node:path');
const { test, group, finish, assert } = require('./runner.js');

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

test('至少有一张安装横幅截图', () => {
  assert.ok(Array.isArray(manifest.screenshots) && manifest.screenshots.length > 0);
});

for (const shot of manifest.screenshots || []) {
  test('截图存在且尺寸一致：' + shot.src, () => {
    assert.ok(exists(shot.src), shot.src + ' 不存在');
    const size = pngSize(shot.src);
    assert.ok(size, shot.src + ' 不是有效的 PNG');
    assert.strictEqual(size.w + 'x' + size.h, shot.sizes, '实际 ' + size.w + 'x' + size.h + '，声明 ' + shot.sizes);
  });
}

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

/* ---------------------------------------------------------- */
finish();
