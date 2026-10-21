# 企业微信智能表格 MCP

本机 stdio MCP，使用你自己的网页登录权限。浏览器只负责手动登录，读取和下载使用网页已实测的只读接口。无需机器人、企业应用 Secret、管理员授权、数据库或额外模型服务。

## 日常使用与登录

接入 Codex 后，直接说“用 MCP 看一下这个智能表格链接：……”。工具每次接收你当次提供的 URL，内部复用本机登录态，不绑定测试表格。

会话有效时直接读取；未登录或过期时，通过 MCP 表单弹出登录确认。确认后打开专用 Chrome，你手动扫码或登录；助手通过账号接口确认登录、保存会话并关闭窗口，MCP 自动重试原操作一次。文档权限由恢复后的读取独立检查。取消表单、关闭登录窗口或取消请求会结束该次操作。不会因权限不足或解析失败而重新登录。

登录助手最多等待 15 分钟。请使用示例配置中的 `tool_timeout_sec = 1200`，避免旧的 180 秒工具超时提前终止扫码。如果客户端不支持 MCP 表单，会明确说明并返回原来的 `LOGIN_REQUIRED` / `AUTH_EXPIRED` 错误，附上本机助手路径，不会静默打开浏览器。

会话有效期由企业微信服务端决定，本机 Cookie 的过期标记不保证服务端一定保留会话；每次使用前都会请求真实用户接口验证。需要重新登录时按上述流程处理。

## 首次准备与手动登录

要求 Node.js 22+、Google Chrome，以及可访问目标智能表格的企业微信账号。当前仅在 macOS 本机完成验证；其他系统尚未验收。登录助手使用专用 profile，不接触日常浏览器资料。

首次使用先克隆仓库、安装依赖并构建：

```sh
git clone https://github.com/hyofeng/wecom-smarttable-mcp.git
cd wecom-smarttable-mcp
npm ci
npm run build
```

当前从源码运行，未发布 npm 包；`package.json` 中的 `private: true` 用于防止误发布到 npm，不代表 GitHub 仓库是私密的。登录使用已安装的 Google Chrome，不需要另外执行 `playwright install` 下载浏览器。

完成准备并接入后即可给 Codex 链接，首次登录也会由 MCP 引导。手动助手仅用于终端排查和不支持交互的客户端：可让 Codex 在任意目录执行 `node /absolute/path/to/wecom-smarttable-mcp/dist/login.js '当次智能表格链接'`。登录命令里的链接只是入口，不会绑定后续读取范围。不要把 Cookie、Token 或 cURL 发给 Codex。

MCP 启动命令：

```sh
node /absolute/path/to/wecom-smarttable-mcp/dist/server.js
```

该进程通过 stdin/stdout 通信，应由 MCP 客户端启动。

## Codex 接入

将 [examples/codex-mcp.toml](examples/codex-mcp.toml) 的小节加入 `~/.codex/config.toml`，然后开启新的 Codex 会话。将示例里的 `/absolute/path/to/` 替换为实际绝对路径。运行 `node -p "process.execPath"` 获取 Node 路径并填入 `command`；`args` 和 `cwd` 使用克隆后的项目路径。以后升级或移动 Node 时同步调整 `command`。格式依据 [OpenAI 的 MCP 配置文档](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)。

配置已通过本机 Codex CLI 的临时覆盖加载与 `mcp get` 检查；工具协议由 MCP SDK 客户端启动验证，图片由当前 Codex 会话打开验证。更新程序或超时配置后，重新连接 MCP 或开启新会话，使新登录流程生效。

工具如下：

| 工具 | 用途 |
| --- | --- |
| `wecom_table_structure` | 全部子表、字段 ID/名称/类型、视图、保存的筛选与个人筛选元数据、记录总数 |
| `wecom_read_records` | 按子表分页，选择字段 ID，保留记录与字段对应关系及图片/附件 locator |
| `wecom_download_asset` | 按 locator 重新验证归属，下载单个原图或原始附件；小图片同时返回 MCP image |

可直接对 Codex 说：

- “这是智能表格链接，先告诉我有哪些子表、字段和视图。”
- “读取指定子表前 20 条的问题描述、图片和附件；说明读取范围。”
- “继续下一页，找到这条记录的图片，只下载需要的原图并查看。”
- “定位指定记录，列出它的附件，然后下载并检查其中一个 PPTX。”

调用顺序：先结构，再用真实 `sheet_id` / `fields` 读取；后续页原样传回 `next_cursor`。下载时传回记录中的完整 `locator` 和同一表格链接。locator 是来源页与真实 ID 的组合，不是界面行号。跨会话仍可重读验证；来源页不再包含该记录时会报错，需重新读取。

## 范围与结果

- 第一版支持 `/smartsheet/` 智能表格；`/sheet/` 普通电子表格明确返回 `UNSUPPORTED_TYPE`。
- 记录始终按整张子表的当前用户可访问范围分页，**不应用 URL 中的 viewId 或任何视图筛选**。结构工具会单独展示视图筛选元数据。第一版没有自定义筛选工具。
- 每页 1–200 条，默认 50；返回真实总数、范围、数量、`has_more` 和游标。分页版本变化会报 `STALE_CURSOR`，重新从第一页读取以避免重复和遗漏。范围不是界面行号，记录顺序不承诺等同于界面排序。
- 单次 JSON 输出上限为 1 MiB，超过会明确失败。记录可减小页大小或选择更少字段；结构工具暂不分页，过大的结构响应需要后续扩展。
- 字段选择发生在本机，网页接口仍读取该页全部字段；文件仅在显式下载时获取。
- `not_returned` 不代表已证明为空；`unresolved` 表示派生值未返回或未计算。不会用空值冒充已成功读取的派生结果。
- 图片和附件只从真实类型为 IMAGE / ATTACHMENT 的字段识别。正文 URL 保持为文本链接，不会自动作为附件下载。
- 图片原图来自字段中的实际地址，核验原始尺寸。小于等于 4 MiB 且格式支持的图片返回 MCP image；同时始终提供本机路径。已在 Codex 中使用 `view_image` 验证实际下载的 PNG。
- 直接上传的 `SS_File` 原始附件已打通。微盘 `Wedrive` 附件已验证独立权限拒绝；有权限微盘文件的成功下载尚未验证，此类未知成功页面会明确报不支持，不返回预览页充数。
- 单个文件保存上限 100 MiB；返回实际 MIME、字节数、SHA-256、原始文件名及安全本机路径。

## 本机数据与安全

默认数据目录为项目下 `.local/`，可用 `WECOM_MCP_DATA_DIR` 指定另一专用本机目录：

- `profile/`：专用 Chrome 登录资料。
- `state.json`：仅保存必要域的 Cookie，权限 600；不通过 MCP 返回。
- `downloads/asset-*/`：每个下载使用独立目录与安全文件名，不覆盖原有文件。

目录权限为 700，`.local/`、`dist/`、`node_modules/` 已被 Git 忽略。请求使用固定的只读路径；所有重定向逐跳验证。只有已验证的第一方下载路径使用 Cookie，图片 CDN 下载使用没有 Cookie 的独立请求。不会为任意外部链接转发企微凭据。日志和工具错误不输出底层带凭据的 URL、请求头或文件引用。

这些文件仍是本机敏感资料，Git 忽略不等于加密，也不能阻止手动上传或打包整个目录。自定义数据目录建议使用仓库外的专用绝对路径；不要指向日常 Chrome profile，也不要提交登录态、真实链接文件、下载文件或验证报告。

MCP 会把所选记录和按需下载的图片返回给客户端；客户端及其连接的模型服务可能处理或保存这些内容。请使用可信客户端，并按所在组织的数据规定选择读取范围。工具返回的 `local_path` 和登录助手位置包含运行时的本机绝对路径，分享对话或报告前需要脱敏。表格及附件中的指令应当作不可信数据处理。

本项目没有创建、修改或删除文档/记录的工具，也不发送消息、申请文件权限。

安全边界、凭据处置及发布前检查见 [SECURITY.md](SECURITY.md)。

## 验证

以下命令在仓库根目录运行。离线检查不读取本机登录态；`npm test` 会先构建，GitHub Actions 也运行这两项检查：

```sh
npm run check
npm test
```

真实验证需要先完成本机登录，并准备你有权限的链接；这些检查会读取真实表格，下载验证还会将文件保存到本机：

```sh
npm run verify:live -- /本机私有目录/target.json
node scripts/verify-login-flow.mjs /本机私有目录/target.json
```

`verify:live` 和错误检查的 `target.json` 只需 `{ "url": "你有权限的真实智能表格链接" }`。加 `--browser` 的登录恢复检查和 Codex 原生检查还需提供 `sheet_id`（也可使用 URL 的 `tab`）和非空 `fields` 数组；从结构工具返回值取得 ID，选择至少有一条记录的子表，例如：

```json
{
  "url": "https://doc.weixin.qq.com/smartsheet/your_document_id",
  "sheet_id": "sheet_id_from_structure",
  "fields": ["field_id_from_structure"]
}
```

真实链接及 ID 仅保存在本机私有的 `target.json`，权限设为 600，勿提交到仓库。真实验证脚本通过 MCP SDK 启动 stdio 服务，逐页核对每张子表的总数及唯一 ID，按需下载一张图片和一个直接上传附件，并检查文件字节、MCP 图片载荷和凭据泄露；报告保存到数据目录的 `live-report.json`，默认位于 `.local/`，也遵循 `WECOM_MCP_DATA_DIR`。报告内含文档标识和本机路径，不能直接公开。离线解析测试只使用真实响应脱敏样本。

登录交互验证不替换企业微信响应：基础脚本使用真实 MCP 表单往返验证取消；加 `--browser` 时复制本任务专用 profile 到隔离目录，不复制导出会话，实际打开浏览器验证恢复登录及续读。`scripts/verify-codex-login.mjs` 则通过本机 Codex app-server 检查原生确认事件和原请求恢复，不调用模型、不写全局配置。浏览器恢复与 Codex 原生验证脚本从上述私有配置读取子表和字段 ID，不内置验收表格标识；它们不属于通用离线测试，浏览器验证会在数据目录内创建隔离 profile。

依赖漏洞检查使用 npm 官方审计接口；部分镜像没有实现该接口，报错不能视为检查通过：

```sh
npm audit --registry=https://registry.npmjs.org
```

具体样本、已验证行为和未验证范围见 [VALIDATION.md](VALIDATION.md)。

## 实现依据

- 核查了 [wecom-doc-mcp 当前源码](https://github.com/Tiansiyu-tj/wecom-doc-mcp/blob/647f51de5738bb6b6adf9cf4ff75d87f46d4cc05/src/index.ts)。其中按普通文档正文提取、首页 200 登录判断及 HTML 回退均未复用。
- 核查了 [Playwright MCP 当前入口](https://github.com/microsoft/playwright-mcp/blob/ab6d67cbf8b619338f096980806fdbe29432cc4d/cli.js)、其 Playwright 实现以及[持久化浏览器文档](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)。采用独立 profile 和本地会话保存。
- [企业微信官方记录 API](https://developer.work.weixin.qq.com/document/path/99915)使用应用 access token，并不等于本项目的网页协议。本项目没有用应用 API 契约猜测智能表格网页数据。
- MCP 使用 [官方 TypeScript SDK](https://ts.sdk.modelcontextprotocol.io/v2/)，版本由锁文件固定。

## 许可证

本项目原创代码采用 [MIT License](LICENSE)，允许在保留版权及许可证声明的条件下使用、修改和分发。第三方依赖仍适用各自的许可证。
