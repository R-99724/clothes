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
