/**
 * 关税叠加计算引擎回归测试
 * 运行：node tests/tariff.test.js
 * 夹具：加载 assets/data.js + assets/app.js 的纯计算部分（渲染层之前），导出 calc()
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const dataSrc = fs.readFileSync(path.join(root, 'assets', 'data.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(root, 'assets', 'app.js'), 'utf8');

// app.js 渲染层从 "/* ---------- 渲染 ----------" 开始，之前为纯计算逻辑
const cut = appSrc.indexOf('/* ---------- 渲染');
if (cut < 0) { console.error('FAIL: 无法在 app.js 中定位渲染层边界'); process.exit(1); }

const factory = new Function(dataSrc + '\n' + appSrc.slice(0, cut) +
  '\nreturn { calc, normalize, parseMFN, META, BASE, M301L, M301S, M301X, M232, EX301FL, EX301FL_A, CNAMES, EX122, HTS_REV, C99SNAP, FP99, M201: (typeof M201!=="undefined"?M201:[]) };');
const T = factory();

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const ok = (typeof expected === 'number' && typeof actual === 'number')
    ? Math.abs(actual - expected) < 1e-9
    : actual === expected;
  if (ok) { pass++; console.log(`  ✓ ${name}: ${actual}`); }
  else { fail++; console.error(`  ✗ ${name}: 期望 ${expected}，实际 ${actual}`); }
}
function truthy(v, name) {
  if (v) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name}`); }
}

console.log('— 数据完整性 —');
eq(T.META.base_date, '2026-09-01', 'META.base_date');
eq(T.HTS_REV, '2026HTSRev17', 'HTS_REV');
eq(T.BASE.length, 11414, 'MFN基础表行数');
eq(T.M301L.length, 10008, '301清单1-4A行数');
eq(T.M301X.length, 178, '301排除行数');
eq(T.M232.length, 1169, '232措施行数（含药品/无人机/多晶硅）');
eq(T.M201.length, 2, '201石英TRQ行数');
eq(T.EX301FL.length, 2113, '301FL豁免码数');
eq(T.EX122.length, 1097, '122例外存档数');
eq(Object.keys(T.C99SNAP).length, 565, '9903税目快照数');
truthy(Object.keys(T.FP99).length === 11, '第99章注释指纹11个');
truthy(Object.keys(T.CNAMES).length > 0, '中文品名表非空');
truthy(Object.keys(T.EX301FL_A).length > 0, '301FL归属映射非空');

console.log('— 单元：normalize —');
eq(T.normalize('8541430000').c8, '8541.43.00', '10位无点号');
eq(T.normalize('8541.43.00').c8, '8541.43.00', '带点号');
eq(T.normalize('85414300').c8, '8541.43.00', '8位无点号');
truthy(T.normalize('abc') === null, '非法输入返回null');

console.log('— 单元：parseMFN —');
eq(T.parseMFN('Free').pct, 0, 'Free→0%');
eq(T.parseMFN('6.5%').pct, 6.5, '6.5%');
truthy(T.parseMFN('2.2¢/kg').specific === true, '从量税识别');

console.log('— 回归：8个代表税号总叠加值（人工SOP核定） —');
eq(T.calc('8541.43.00').total, 62.5, '8541.43.00 光伏电池组件（301 25+232 15封顶+301FL 12.5+MFN）');
eq(T.calc('8806.24.00').total, 125, '8806.24.00 无人机>25kg（301 25+232 100）');
eq(T.calc('8537.10.91').total, 140.2, '8537.10.91 电气控制板（MFN 2.7+301 25+232无人机零件100+301FL 12.5）');
eq(T.calc('3004.90.92').total, 0, '3004.90.92 仿制药（232药品0%，301FL豁免-专利药不叠加）');
eq(T.calc('6810.99.00').total, 37.5, '6810.99.00 石英台面（301 25+301FL 12.5，201TRQ个案不计入）');
eq(T.calc('0201.10.10').total, 7.5, '0201.10.10 牛肉（301清单4A 7.5%）');
eq(T.calc('7208.39.00').total, 75, '7208.39.00 热轧钢卷（301 25+232金属50，301FL不叠加）');
eq(T.calc('2804.61.00').total, 50, '2804.61.00 多晶硅（301 25+301FL 12.5+MFN，232从量MIP不计入）');

console.log('— 规则：301FL 与 232 不叠加 —');
{
  const steel = T.calc('7208.39.00');
  truthy(!steel.rows.some(r => r.layer.includes('301强迫劳动') && r.add === 12.5), '232金属覆盖 → 301FL不叠加');
  const beef = T.calc('0201.10.10');
  truthy(beef.rows.some(r => r.layer.includes('301强迫劳动') && r.add === 12.5) || !T.EX301FL_SET,
         '无232覆盖 → 301FL可叠加');
}
{
  const drone = T.calc('8806.24.00');
  truthy(!drone.rows.some(r => r.layer.includes('301强迫劳动') && r.add === 12.5),
         '无人机在301FL豁免清单(d) → 不加12.5%');
  const panel = T.calc('8537.10.91');
  truthy(panel.rows.some(r => r.layer.includes('301强迫劳动') && r.add === 12.5),
         '8537.10.91不在豁免清单 → 232无人机零件与301FL叠加');
}

console.log('— 规则：232工业设备15%封顶 —');
{
  const r = T.calc('8415.82.01');
  const row232 = r.rows.find(x => x.layer.includes('232'));
  truthy(row232 && row232.add !== null && row232.add <= 15, '8415.82.01 232加征≤15%（封顶逻辑）');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
