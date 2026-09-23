# 山海植物志

四季山林植物观察游戏。React 客户端负责地图、观察笔记、采集交互和年度报告，Node.js 服务端负责环境生成、生态演化、持久化和全部权威判定。

## 已实现闭环

- 创建匿名观察档案并持久化到 SQLite
- 四区域、四季、十日制探索与每日行动点
- 植物物候、叶片纹理、主色和环境数据记录
- 拍照、拓印、落叶采集、标准剪取及安全上限
- 错误采集对健康、种群、种子库、区域干扰和下一年度状态的持续影响
- 季节结算、年度报告、分布变化、物候偏移和生态修复
- 观察笔记、物种档案、事件时间线、存档导出与恢复
- 环境记录校准：仪器误差、天气突变、区域基线三要素纳入评分，联动日志与年度报告
- 幂等命令、乐观并发版本控制和自动化闭环测试

## 环境要求

- Node.js 22.13 或更高版本
- pnpm 10 或 npm 10 或更高版本

项目使用 Node.js 内置 SQLite，不需要额外安装数据库服务。

## 启动

```bash
pnpm install
cp .env.example .env
pnpm db:init
pnpm dev
```


浏览器访问 `http://127.0.0.1:5173`。API 默认运行在 `http://127.0.0.1:8787`，Vite 会代理 `/api`。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm start
```

`pnpm test:e2e` 会先构建生产包，再启动真实 HTTP 服务，完成“创建档案 → 观察 → 错误采集 → 四季结算 → 年度报告 → 第二年”的闭环，并在结束后清理临时数据库。

## 生产启动

```bash
pnpm build
pnpm start
```

生产模式由 Node.js 同时提供 `/api` 和 `apps/web/dist` 静态资源。请在生产环境设置安全的 `SESSION_SECRET`、正确的 `APP_ORIGIN`，并将 `DATABASE_URL` 指向持久化磁盘。

## 目录

```text
apps/web                 React 客户端
apps/server              Node.js API、SQLite 与游戏服务
packages/contracts       前后端共享命令、类型和校验
packages/game-core       物种目录、环境生成和生态模拟
data/runtime             本地 SQLite 文件
tests                    真实 HTTP 闭环脚本
```

## 数据说明

物种、区域和演化参数是完整的游戏内容配置，不是界面演示数据。模拟结果用于游戏机制，不用于现实科研或生态预测。

## 环境记录校准

环境读数（`RECORD_ENVIRONMENT` 与 `OBSERVE_PLANT` 的环境子项）按版本化口径评分：

- **v1（旧口径）**：固定阈值判定。迁移前的历史记录保持原分数与口径，不参与重算。
- **v2（新口径）**：`packages/game-core/src/calibration.ts` 的纯函数，纳入三类校准来源并写入 `observations.calibration_json`：
  - **仪器误差**：各传感器 `bias + precision` 构成基础容差带；
  - **天气突变**：相对上一记录时次发生剧烈天气或要素跃变时，在仪器容差之外放宽判定；
  - **区域基线**：站点季节气候学基线托底，读数贴近基线时给予封顶的部分分。

v2 为确定性纯函数，相同输入（读数 + 环境站真值 + 同季历史）重算结果恒定一致。校准明细联动到观察日志（`JournalEntry.calibration`）、季节回顾与年度报告（`CalibrationSummary`），旧记录以 `legacyCount` 单独计数、保持原口径。
