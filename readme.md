这份 GitHub 说明文档（README.md）是专门为你这个 **Domain Manager v4** 定制的。它包含了项目简介、功能特性、快速部署指南以及 Telegram 机器人的使用说明。

---

# Domain Manager v4

一个基于 Cloudflare Workers + KV 的轻量级域名监控与管理系统。支持从 Cloudflare 自动同步域名、Telegram 机器人提醒、以及快捷续费功能。

## 🌟 功能特性

- **零成本部署**：完全基于 Cloudflare Workers 免费额度运行，无需服务器。
- **自动同步**：通过 Cloudflare API 一键导入所有域名，支持自动同步注册商和到期日期。
- **自定义提醒**：预设 **180, 90, 30, 15, 1** 天到期提醒，确保不会错过续费。
- **Telegram 集成**：
  - 自动发送到期通知。
  - 内置快捷续费按钮，一键跳转注册商。
  - 支持交互指令：`/domains`（查看全部）、`/expiring`（近期到期）、`/check`（立即检查）。
- **多账户管理**：支持管理多个 Cloudflare 账号及其他手动录入的注册商账号。
- **可视化面板**：响应式 Web UI，支持深色模式，随时随地管理资产。

## 🚀 快速部署

### 1. 创建 KV 命名空间
1. 登录 Cloudflare 控制台。
2. 进入 **Workers & Pages** -> **KV**。
3. 创建一个新的命名空间，名称建议设为 `DOMAIN_KV`。

### 2. 创建 Worker
1. 在 **Workers & Pages** 中创建一个新的 Worker。
2. 将 `worker.js` 中的代码全部替换为本项目提供的代码。
3. **关键步骤**：进入 Worker 的 **Settings** -> **Bindings**：
   - 添加 **KV Namespace Binding**：变量名称必须填 **`KV`**，绑定你刚才创建的命名空间。
   - （可选）添加 **Environment Variable**：变量名 `ADMIN_PASSWORD`，设置你的后台登录密码（默认是 `admin123`）。

### 3. 部署并访问
1. 点击 **Save and Deploy**。
2. 访问分配的 `*.workers.dev` 域名即可进入面板。

---

## 🤖 Telegram 机器人设置

1. **获取 Token**：私聊 [@BotFather](https://t.me/BotFather) 创建机器人并获取 API Token。
2. **获取 Chat ID**：
   - 在面板的“设置”页填写 Bot Token 并保存。
   - 向你的机器人发送 `/start`，它会回复你的 Chat ID。
   - 将 Chat ID 填回面板设置中保存。
3. **完成连接**：点击“测试发送”，如果收到测试消息，则表示通知系统已就绪。

### 机器人指令
- `/domains` - 列出所有域名及到期剩余天数。
- `/expiring` - 查看未来 30 天内即将到期的域名。
- `/check` - 强制运行一次检查逻辑。

---

## 🛠 技术架构

- **Runtime**: Cloudflare Workers (Edge Computing)
- **Storage**: Cloudflare KV (Key-Value storage)
- **Frontend**: 原生 JS + CSS (Single Page Application)
- **API**: Telegram Bot API, Cloudflare Client API v4

---

## 📝 提醒逻辑说明

系统会每天自动运行一次（基于 Cloudflare Cron Triggers），并针对每个域名检查是否满足以下提醒条件：
- 距离到期正好剩余：180天、90天、30天、15天、1天。
- 已经过期的域名。

如果满足条件，机器人将推送一条带格式的消息，并附带控制台续费链接。

---

## 🔒 免责声明

本工具仅用于个人域名资产管理和到期提醒。
- 请妥善保管你的 `ADMIN_PASSWORD` 和 `Cloudflare API Token`。
- 建议定期备份 KV 中的数据。
- 作者不对因任何原因导致的域名到期未续费损失负责。

---

### 如何贡献
欢迎提交 Issue 或 Pull Request 来改进 UI 或增加新功能。

---



这份文档结构清晰，既能展示你的项目亮点，又能让新用户快速上手。需要我为你生成对应的 `LICENSE` 或其他文件吗？
