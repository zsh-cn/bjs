# BJS · 北京时间

一个简洁现代的多文件静态时钟站点。页面通过 **中国科学院国家授时中心、中国计量科学研究院、CNNIC、阿里云、腾讯云** 等公共 NTP 服务校准，显示精确到毫秒的北京时间。

```
index.html          页面结构
css/style.css       界面样式（自动深浅色）
js/config.js        运行配置
js/time.js          浏览器授时客户端
js/app.js           时钟渲染与交互
server.mjs          零依赖 NTP 代理 + 静态服务器
favicon.svg         站点图标
```

## 快速开始

需要 Node.js 18 或更高版本，无需安装任何依赖：

```bash
node server.mjs
```

打开 <http://127.0.0.1:8787>。

启动后终端会显示：

```
  BJS · 北京时间
  → http://127.0.0.1:8787
  NTP: ntp.ntsc.ac.cn, ntp1.nim.ac.cn, ntp.cnnic.cn, ntp.aliyun.com, ntp.tencent.com
```

也可以使用 `npm start`。默认只监听本机，若需局域网访问：

```bash
# macOS / Linux
HOST=0.0.0.0 PORT=8787 node server.mjs

# Windows PowerShell
$env:HOST="0.0.0.0"; $env:PORT="8787"; node server.mjs
```

## 为什么需要 server.mjs？

浏览器出于安全限制，**不能直接发送 UDP 数据包**，所以纯前端 JavaScript 无法直接访问 NTP（UDP 123）。本项目的做法是：

1. `server.mjs` 用 SNTP 协议向公共 NTP 服务器发送请求，取往返延迟有效的一次采样；
2. 通过同源的 `GET /api/time` 把校准后的时间交给浏览器；
3. 浏览器按请求往返时间做补偿，并每 5 分钟自动重新校准。

代理不可用时，页面会降级到支持 JSONP 的 HTTP 时间接口（苏宁 / 淘宝），并在界面中明确标注「已同步 · HTTP」。HTTP 接口的精度明显低于 NTP，仅作为兜底。

## 纯静态部署

`index.html`、`css/`、`js/`、`favicon.svg` 可以直接部署到 GitHub Pages、Cloudflare Pages、Nginx 等静态托管服务。此时页面无法访问同源的 NTP 代理，会使用 HTTP 时间接口。

若要在静态托管上继续使用真实 NTP，只需把 `server.mjs` 部署到任意支持 Node.js 的服务器（VPS / Render / Railway 等），然后：

- 在页面地址后追加 `?api=https://your-proxy.example.com`，或
- 修改 `js/config.js` 中的 `apiBase`。

代理已开启 `Access-Control-Allow-Origin: *`，可跨域调用 `/api/time`。

## 配置

`js/config.js`：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `apiBase` | 同源（`file://` 时为 `http://127.0.0.1:8787`） | NTP 代理地址 |
| `apiPath` | `/api/time` | 代理接口路径 |
| `autoSyncMs` | `300000` | 自动校准间隔 |
| `retryMs` | `30000` | 失败重试间隔 |
| `requestTimeoutMs` | `5000` | 请求超时 |
| `fallbackHttp` | `true` | 是否允许 HTTP 兜底 |

服务端环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `NTP_HOSTS` | 见下 | 逗号分隔的 NTP 服务器，按顺序尝试 |
| `NTP_TIMEOUT` | `2500` | 单次 NTP 请求超时（毫秒） |

默认 NTP 服务器（按顺序尝试）：

| 服务器 | 机构 |
| --- | --- |
| `ntp.ntsc.ac.cn` | 中国科学院国家授时中心（NTSC） |
| `ntp1.nim.ac.cn` | 中国计量科学研究院（NIM） |
| `ntp.cnnic.cn` | 中国互联网络信息中心（CNNIC） |
| `ntp.aliyun.com` | 阿里云 |
| `ntp.tencent.com` | 腾讯云 |

首个可用服务器会被写入响应，界面据此显示时间源。任一服务器限流或丢包时，代理会自动尝试下一台，页面会在「时间源」与页脚如实标注实际使用的机构，不会冒充其他来源。

若只允许使用某一台服务器，可这样启动：

```bash
NTP_HOSTS=ntp.cnnic.cn node server.mjs
```

## /api/time

```json
{
  "ok": true,
  "server": "ntp.cnnic.cn",
  "ip": "113.141.164.38",
  "time": 1793447288600,
  "processingMs": 0.048,
  "offsetMs": 18790.113,
  "rttMs": 196.954,
  "stratum": 3,
  "leap": 0,
  "sampledAt": "2026-10-31T11:46:55.542Z"
}
```

- `time`：本次响应生成时的服务器时间（Unix 毫秒）；
- `processingMs`：服务端处理本次请求的耗时（首次无缓存时会等待 NTP 查询）；
- `offsetMs`：代理主机时钟相对 NTP 的偏差；
- `rttMs`：NTP 请求的往返延迟；
- 结果缓存 60 秒，过期后先返回缓存并在后台刷新，避免每次请求都等待授时服务器；每个 NTP 服务器每次只发送一个请求。

失败时返回 HTTP 502 与 `{ "ok": false, "error": "...", "causes": [...] }`。

## 精度说明

- 页面显示依据 NTP 推算，并每帧用 `performance.now()` 插值，不受本机时钟跳变影响；
- 实际精度主要取决于网络往返延迟与对称性，通常为几毫秒到几十毫秒；
- HTTP 兜底接口精度约为几十毫秒到 1 秒，界面会标注为 `HTTP`；
- 所有时间均按 `Asia/Shanghai`（UTC+8，无夏令时）显示。

## 界面

- 默认跟随系统深浅色，可手动切换并记忆；
- 支持 24/12 小时制切换（`24H` / `12H` 按钮），偏好保存在 `localStorage`，12 小时制下会显示 AM / PM；
- 大号轻字重数字（等宽对齐）、毫秒、秒进度条、日期与星期，浏览器标题同步显示到秒；
- 显示时间源、本机时钟偏差、网络往返、上次同步时间；
- 页脚右下角显示协调世界时（UTC），同样跟随 12/24 小时制切换；
- 支持手动重新校准，失败时明确提示；
- 响应式布局，尊重 `prefers-reduced-motion`。

## 许可

仅用于学习与展示。时间数据来自各公共 NTP 服务提供方，请遵守其服务条款，合理控制请求频率。
