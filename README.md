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
