/* ============================================================
 * 极简测试运行器（零依赖），供 test/ 下的各个 *.test.js 共用。
 *
 * 用法：
 *   const { test, group, finish, assert } = require('./runner.js');
 *   group('分组名');
 *   test('用例名', () => { assert.strictEqual(实际, 期望); });
 *   finish();          // 打印汇总，有失败则以非 0 退出码结束
 * ============================================================ */
const assert = require('node:assert');

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

module.exports = { test, group, finish, assert };
