# 衣样 YIYANG

衣样提供对话服装设计、照片试穿、参考衣橱和风格偏好。项目使用 Sites 的 Vinext / React starter，服务端 API 部署到 Cloudflare Workers。

## 本地开发

```sh
npm run install:ci
npm run dev
```

打开终端给出的本地地址。运行 `npm run build` 可构建部署产物。

创建未跟踪的 `.dev.vars`，按需填写以下配置。Sites 私有部署使用同名运行时变量，在 Sites 中将 API 密钥标记为 Secret。

```dotenv
OPENAI_API_KEY=
FASHN_API_KEY=
# 可选，按 API 账号可用模型覆盖默认值
OPENAI_TEXT_MODEL=gpt-6.2-astra
OPENAI_IMAGE_MODEL=gpt-image-2.5-sunburst
```

- 对话请求通过 OpenAI Responses API 返回文字或服装图片。后端同时接收当前选中版本、最多三张手选参考图和个人偏好。
- FASHN tryon-v1.6 接收人像和服装图。后端签发短期状态凭证，浏览器查询队列并展示结果。使用示例照片可以先预览、对比和下载预置示例。
- 对话历史、服装版本、参考衣橱和偏好保存在当前浏览器的 IndexedDB。试穿人像和结果保存在页面会话中。开始照片试穿时，图片发送至 FASHN。服装版本和手选参考图仅在提交设计请求时发送至 OpenAI。
- 参考衣橱按名称、标签和备注查询，使用时明确选择图片。清除该网站的浏览器数据会清空本地档案。

## 实时摄像头试穿

在 Sites 运行时变量中添加 `DECART_API_KEY`（Secret），并部署新版本。使用 `npm run dev` 时可将它放入未跟踪的 `.dev.vars`。密钥需来自启用了实时 Lucy VTON 的 Decart API 账号。

「实时试穿」先在本机预览摄像头，点击「开始实时试穿」时才通过 WebRTC 向 Decart 发送视频与服装参考图。后端通过 `POST /api/studio/live/token` 签发短期令牌，绑定当前站点与 Lucy VTON 3.6，每次会话最长 120 秒。麦克风关闭，试穿画面不保存到衣样服务器。可使用上传服装、生成款、衣橱参考款或示例服装，并在通话中切换服装。部分内嵌浏览器禁止摄像头，在独立浏览器标签页打开站点即可请求摄像头权限。

公开实现参考 [ShopAnywear](https://shopanywear.com/)、[Decart Realtime SDK](https://docs.platform.decart.ai/sdks/javascript-realtime) 和 [客户端令牌文档](https://docs.platform.decart.ai/getting-started/client-tokens)。

## 独立运行与局域网访问

使用 Node.js 22.13 以上。在项目目录运行：

```sh
npm ci
npm run build:local
npm run start:local
```

默认地址为 `http://127.0.0.1:3080`。首次运行时，在「设置管理员」页面输入启动终端显示的一次性初始化口令，自定用户名和密码。已经启动时也可在当前项目目录执行 `npm run setup:token` 查看口令。可用环境变量 `YIYANG_SETUP_TOKEN` 指定口令。管理员初始化后，注册默认开放，管理员可在右上角账号菜单关闭新用户注册。

独立版由管理员在「接口设置」统一配置各服务，沿用管理员原有的加密配置。在「用户与计费」设置单价并分配积分后，普通用户可以使用服务及查看自己的使用日志。实时试穿按签发的授权秒数预付，播放秒数由浏览器在结束时上报。关闭浏览器或网络中断可能导致播放时长未上报。异步任务失败后在轮询时返还积分，长期未结算的记录可由管理员核实后返还。

独立版账号使用 SQLite，数据目录默认是 `.yiyang-data/`，可用 `YIYANG_DATA_DIR` 指定。备份时保留数据库及加密密钥 `secrets.key`，可在停服后备份整个目录。密码采用带独立盐的 scrypt，登录会话用 HttpOnly Cookie 并在登出时立即撤销。只有管理员能修改接口配置。自定义站点域名可通过 `YIYANG_ALLOWED_HOSTS` 添加。

| 设置 | 自定义服务须兼容的协议 |
| --- | --- |
| 对话与生图 · Responses | `POST {base}/responses`，支持 `image_generation` 工具 |
| 对话与生图 · Images | `POST {base}/images/generations` 和 `POST {base}/images/edits`，支持 Base64 图片或同源结果图 |
| 实时视频试穿 | Decart `POST {base}/client/tokens`，以及兼容 Decart SDK 的 WebRTC 信令和模型 |
| 静态照片试穿 | FASHN `POST {base}/run` 与 `GET {base}/status/{id}`，结果使用 Base64 |
| 短视频生成 | OpenAI Videos 风格的 `POST {base}/videos`（multipart），`GET {base}/videos/{id}` 与 `GET {base}/videos/{id}/content`（直接返回视频） |

Base URL 一般包括 `/v1`，不包括具体接口路径。服务无需鉴权时可将 Key 留空。第三方接口若使用其他协议，需要对应适配器。不要通过不受信任的 HTTP 连接传输真实密钥。图片和视频接口使用服务端代理，实时试穿视频由浏览器和选定服务直接传输。视频生成请求只在浏览器里轮询，关闭页面不会撤销已提交到供应商的任务。

### 在同一局域网打开

摄像头需要浏览器认可的安全上下文。跨设备使用实时试穿时，为主机的局域网 IP 准备访问设备信任的 HTTPS 证书，例如使用 mkcert 创建本地测试证书，或者使用你已有的可信证书。在项目目录新建被 Git 忽略的 `.env.local`：

```dotenv
YIYANG_HOST=0.0.0.0
YIYANG_PORT=3080
YIYANG_TLS_CERT=/absolute/path/to/lan-cert.pem
YIYANG_TLS_KEY=/absolute/path/to/lan-key.pem
# 可选，管理员初始化使用。省略时自动生成。
# YIYANG_SETUP_TOKEN=your-random-setup-token
```

执行 `npm run start:local`，用同一网络内的手机或电脑打开终端显示的 `https://<主机局域网IP>:3080`。证书须包含该 IP 地址，访问设备须信任签发它的 CA。局域网模式要求 HTTPS。局域网访问由本机端口和网络防火墙决定，无需登录 ChatGPT 或 Codex。

也可以将局域网配置放在独立的 `.env.lan`，通过 `npm run start:lan` 启动，这样 `npm run start:local` 仍可使用默认的本机地址。如果为测试设备签发了自己的 CA，只向设备提供 CA 的公开证书，私钥保留在主机。换网后如 IP 有变化，应更新证书的 IP。
