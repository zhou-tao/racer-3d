/* run-all.js —— 一键跑全部测试 */
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');

const cases = [
  'js/protocol.test.js',
  'js/track.test.js',
  'js/car.test.js',
  'test-server.js',
];

let failed = 0;
for (const c of cases) {
  console.log(`\n==== ${c} ====${new Array(30).fill('=')}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', c)], {
    stdio: 'inherit',
    timeout: 120000,
  });
  if (r.status !== 0) failed++;
}

console.log('\n========================================');
if (failed) {
  console.log(`❌ ${failed} 个测试文件失败`);
  process.exit(1);
} else {
  console.log('✅ 全部测试通过');
}
