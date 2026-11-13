# 本地文件转换

## 范围

Amadeus 提供一个独立的本地文件转换页（`/conversion`）。它参考 [FlyingMouse Format](https://github.com/LaoFeng-mouse/flyingmouse-format) 的能力发现、批量队列与多引擎思路，但**没有复制其源码、二进制、资源或许可证**。FlyingMouse Format 使用限制商业用途的自定义许可证，因此本仓库只采用公开的产品形态作为参考；具体引擎均是独立依赖，发布前仍需逐项审核许可证与打包方式。

当前服务端路由：

- `GET /api/conversion/capabilities`：探测 npm 引擎与本机可执行文件，返回运行时能力。
- `POST /api/conversion/capabilities/refresh`：清除缓存并重新探测。
- `POST /api/conversion/targets`：按输入扩展名返回可用目标格式。
- `POST /api/conversion/convert`：单文件转换，multipart 字段为 `file` 与 `to`。
- `POST /api/conversion/images-to-pdf`：按上传顺序把图片合并为 A4 PDF，multipart 字段为重复的 `files`。
- `POST /api/conversion/merge-pdfs`：按上传顺序合并 PDF，multipart 字段为重复的 `files`。

转换结果以二进制响应返回，浏览器只在用户点击「下载结果」时保存到用户选择的下载位置。服务不把转换文件写入 SQLite，也不持久化上传文件。

## 引擎与能力状态

内置并可直接执行的引擎：

- `sharp`：常见图片解码、EXIF 方向校正与 PNG/JPEG/WebP/AVIF/TIFF/GIF 输出。
- `pdf-lib`：图片转 PDF 与 PDF 合并。
- `fflate`：在本机内存中把多张图片打包为 ZIP，不写入用户目录。
- 生产桌面包会携带 bundled brain 服务并由 Electron 主进程托管；Sharp 等原生依赖随单文件 brain bundle 解析，外部 FFmpeg/Poppler/LibreOffice/Tesseract/Pandoc 仍要求系统已安装。
- `officeparser`：DOCX/PPTX/XLSX/ODF/RTF/PDF/EPUB 等文档解析与文本、Markdown、HTML、PDF、CSV、RTF、EPUB、DOCX、ODT、XLSX、ODS、PPTX、ODP、TEX 输出；复杂版式、字体、表格与图片可能有损。
- 文本格式转换按源格式返回真实目标矩阵；不在矩阵中的组合会直接标记为不支持，而不是显示后再失败。

可选的本机工具也会在运行时探测，并在检测到后用于对应转换：FFmpeg/FFprobe（音视频）、Poppler（PDF 首页栅格化）、LibreOffice（旧版 Office/WPS/OFD 等）、Tesseract（图片 OCR）、Pandoc（文本/文档补充转换）。这些工具不会由用户输入拼接 shell 命令；调用使用固定可执行文件、固定临时目录、参数白名单、超时和结果大小上限。

状态含义：

- `ready`：进程内依赖已加载，可执行对应操作。
- `detected`：系统找到了并接入了对应本机适配器，可执行对应操作；具体源/目标组合仍以目标格式接口为准。
- `missing`：未找到可执行文件。
- `broken`：找到但版本探测失败。
- `unsupported`：当前操作没有可用实现。

## 限制与安全

- 单文件最大 64 MiB；请求最大 128 MiB；批量最多 50 个文件；PDF 合并最多 500 页；单结果最大 512 MiB。
- 图像解码最多 50 MP，避免解压炸弹和异常图片占满内存。
- 目标格式、文件数量、输入大小在服务端重新校验；前端校验只用于交互反馈。
- 不接受可执行文件路径、shell 命令或用户指定的服务端输出路径；转换不经过已有 `bash` 工具。
- 输出文件名只从展示名生成，并清理换行、引号和反斜杠。
- 文件内容不会进入聊天上下文、LLM、SQLite 或外部平台。
- PDF 栅格化当前输出首页；扫描 PDF 的 OCR 需要本机 Tesseract，且默认使用 `eng` 语言。视频编解码、WPS 专有格式、加密文件和复杂版式的结果仍取决于本机引擎质量，不能因为扩展名出现在参考项目矩阵里就宣称所有组合都无损。
- 当前共享契约只声明已经接入的常见图片、文本、Office、电子书、音视频和归档格式；RAW、字幕、MOBI 等尚未接入的格式不会出现在可用目标矩阵中。

## 验证

```bash
npm run typecheck
npm run lint
npm run build

# 启动 brain 后检查能力
npm run dev:brain
curl http://localhost:3002/api/conversion/capabilities
```

真实桌面端验证还应覆盖：拖放与选择文件、目标格式动态变化、批量图片转 PDF、PDF 合并、错误提示、下载结果，以及能力服务离线后的重试。转换页不改变聊天消息 schema，也不把结果隐式上传到聊天。

## 后续扩展边界

若要达到参考项目的完整矩阵，需要另行设计和验收：FFmpeg、LibreOffice、Poppler、Tesseract、Pandoc 与 OFD/RAW 等适配器；每个适配器必须使用固定 argv、隔离临时目录、超时/取消、资源预算、清理和逐平台打包。原生引擎的许可证、编解码器专利、对应源码与 `extraResources`/`asarUnpack` 策略必须在发布前单独审核。
