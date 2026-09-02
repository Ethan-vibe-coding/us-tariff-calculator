# 贡献指南

感谢关注本项目。本项目为纯静态站点（无构建步骤），贡献前请阅读以下约定。

## 环境要求

- 任意现代浏览器（直接使用）
- Node.js ≥ 18（仅用于运行测试）

## 本地运行与测试

```bash
# 本地预览
npm run serve        # 或 python3 -m http.server 8000

# 运行回归测试（改动 assets/app.js 或 assets/data.js 后必须通过）
npm test
```

## 目录结构

| 路径 | 说明 |
|---|---|
| `index.html` / `301fl.html` | 主站页面 / 301强迫劳动专项查询页 |
| `assets/app.js` | 计算引擎与渲染（纯计算逻辑在"渲染"注释分隔线之前） |
| `assets/data.js` | 内嵌数据库（由数据更新流程生成，勿手工编辑单条记录） |
| `assets/update.js` | 数据更新中心逻辑 |
| `us_china_tariffs.db` | SQLite 版本数据库（与 data.js 同步生成） |
| `tests/` | Node 回归测试 |
| `docs/` | SOP 流程图、验证工作簿、清单等工作文档 |

## 数据更新流程

1. 通过站内「数据更新中心」检查联邦公报新文件、比对 USITC 最新 HTS 修订版
2. 更新 `assets/data.js` 与 `us_china_tariffs.db`（两者必须同步），推进 `META.base_date`
3. 更新 `tests/tariff.test.js` 中的行数断言与代表税号回归值
4. `npm test` 全绿后提交
5. 在 `CHANGELOG.md` 记录变更

## 提交信息

- 使用中文、祈使句，格式：`类型: 摘要`，类型取 `新增/修复/变更/数据/文档`
- 涉及税率数据的提交必须注明官方依据（联邦公报卷页／总统公告号／HTS 注释号）

## 行为准则

数据准确性高于一切：任何税率、税号、生效日期的改动都必须可溯源至官方文件。
