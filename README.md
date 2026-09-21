# 行迹 Travel Planner

一个基于高德 Web 服务 API 的轻量旅行规划网站。用户输入出发地、目的地、日期、往返交通、人数、预算和兴趣后，网站会生成逐日路线，并提供：

- 日间/夜间温度折线图
- 通过 FlyAI/飞猪查询实时航班、火车和酒店起价及预订链接（本地 Node 服务）
- 住宿、美食推荐和预算档位调整
- 高德静态路线地图与地点跳转
- 基于浏览器本地存储的地点收藏

交通与酒店展示 FlyAI/飞猪查询时的实时价格或起价，最终价格和库存以预订页为准；餐饮与门票仍是规划参考。

## 本地运行

```bash
npm install
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 填入高德 Web 服务 API Key
npm run dev
```

打开 `http://127.0.0.1:8787`。本地端到端验收可运行：

```bash
node scripts/e2e-local.mjs
```

`npm run dev` 使用本地 Node 服务调用已安装的 `flyai` CLI。正式 FlyAI Key 保存在 `~/.flyai/config.json`，不要提交到项目。`npm run dev:worker` 仅运行无本地子进程能力的 Worker 版本，不包含飞猪实时票务增强。

## 部署

实时票务版本需要可运行 Node.js 子进程的托管平台，因为服务端会调用 `flyai` CLI。推荐使用仓库内的 `render.yaml` 或 `Dockerfile`。

部署时配置以下服务端环境变量，不要写进前端或提交到仓库：

- `AMAP_MAPS_API_KEY`：高德 Web 服务 Key
- `FLYAI_API_KEY`：FlyAI/飞猪开放平台 Key
- `HOST=0.0.0.0`
- `PORT`：通常由托管平台自动注入

Cloudflare Worker 版本只能运行高德基础能力，不能执行 `flyai` CLI，因此不适合完整实时票务部署。

仓库也包含 `.devcontainer/devcontainer.json`。GitHub Codespaces 创建或恢复时会安装 FlyAI CLI、加载 Codespaces Secrets、自动启动服务，并将 8787 端口设为公开预览。
