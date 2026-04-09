# 🌐 DOMAIN PRO - 极客域名资产管理系统

![License](https://img.shields.io/badge/License-MIT-blue.svg)
![Platform](https://img.shields.io/badge/Platform-Cloudflare%20Workers-orange)
![UI](https://img.shields.io/badge/UI-Cyberpunk%20%2F%20Glassmorphism-purple)

**Domain Pro** 是一款专为极客和独立开发者打造的**轻量级、无服务器（Serverless）**域名与账号资产管理系统。
基于 Cloudflare Workers 构建，**零成本部署，无需购买服务器**。

不仅拥有炫酷的赛博朋克玻璃拟态 UI，更内置了独家**「赛博狸花猫 AI 管家」**，让枯燥的资产管理变得生动有趣！🐱💻

---

## ✨ 核心亮点 (Features)

- 🆓 **完全免费托管**：基于 Cloudflare Workers + KV 数据库，永不宕机，0 成本运行。
- 🐱 **赛博狸花猫 AI 管家**：
  - **AI 问答**：支持本地数据推演，一键统计资产、查询即将过期的节点。
  - **互动养成**：喂食“算力罐头”升级猫咪段位（实习巡检员 ➡️ 终极摸鱼神猫）。
  - **自由漫步**：开启后猫咪会在全屏幕自由跑动巡逻。
- ☁️ **Cloudflare 深度集成**：输入 API Token，一键全自动同步所有托管的域名资产。
- 📢 **多通道智能告警**：支持 PushPlus (微信)、Bark (苹果)、Email (自定义 Webhook) 以及 Telegram 机器人（内置安全防屏蔽处理）。
- 📦 **硬核数据管理**：
  - 支持 **WHOIS 智能解析**（输入域名自动抓取注册商和时间）。
  - 支持 **不规则文本智能批量导入**。
  - 支持 **一键导出 CSV** 本地备份。

---

## 🛠️ 零基础部署指南 (仅需 3 分钟)

无论你懂不懂代码，只需跟着以下 5 步，即可拥有自己的极客资产管理后台。

### 准备工作
- 一个 [Cloudflare](https://dash.cloudflare.com/) 账号（免费注册）。

### 第一步：创建 KV 数据库
1. 登录 Cloudflare 后台，点击左侧菜单的 **[Workers & Pages]** -> **[KV]**。
2. 点击 **[Create a namespace (创建命名空间)]**。
3. 名字随便填（例如：`DomainManager_KV`），点击 **[Add (添加)]**。

### 第二步：创建 Worker 服务
1. 在左侧菜单点击 **[Workers & Pages]** -> **[Overview (概览)]**。
2. 点击右侧的 **[Create Worker (创建 Worker)]**。
3. 名字可以填 `domain-pro`，直接点击 **[Deploy (部署)]**。
4. 部署成功后，点击 **[Edit code (编辑代码)]**。

### 第三步：粘贴代码
1. 将本项目提供的 `worker.js` 代码全部复制。
2. 覆盖掉网页编辑器里原有的全部代码。
3. 点击右上角的 **[Save and deploy (保存并部署)]**。*(此时网页还不能正常保存数据，请继续下一步)*

### 第四步：绑定 KV 数据库 (最重要的一步！⚠️)
1. 回到刚才创建的 Worker 的详情页面。
2. 点击选项卡上的 **[Settings (设置)]** -> 左侧的 **[Bindings (绑定)]**。
3. 找到 **KV Namespace Bindings**，点击 **[Add (添加)]**：
   - **Variable name (变量名)**：必须精确填写为 `KV` （大写字母）。
   - **KV namespace (命名空间)**：在下拉框选择你【第一步】创建的数据库。
4. 点击 **[Save (保存)]**。

### 第五步：设置安全登录密码
1. 在同一个 **[Settings (设置)]** 页面下，找到 **[Variables and Secrets (变量和机密)]**。
2. 点击 **[Add (添加)]**：
   - **Variable name (变量名)**：填写 `ADMIN_PASSWORD`
   - **Value (值)**：填写你想要的后台登录密码（例如：`MySuperPass123`），并点击右侧的 **[Encrypt (加密)]**。
3. 点击 **[Save (保存)]**。

🎉 **恭喜！你的系统已部署完毕！**
访问 Cloudflare 为你分配的网址（`xxx.xxx.workers.dev`），输入密码即可登录！

> 💡 **提示**：如果在第五步没有设置密码，系统的默认体验密码是：`admin123`。

---

## 📖 常用功能使用指南

### 1. 如何同步 Cloudflare 账号？
1. 登录系统后，切换到顶部菜单 **[账号管理]**。
2. 点击 **[+ 绑定新 API]**。
3. 登录你的 Cloudflare 官网，在右上角[我的个人资料] -> [API 令牌] 中创建一个拥有 `Zone:Read` 和 `Account:Read` 权限的 Token。
4. 填入系统即可一键扫描并同步所有域名。

### 2. 如何和“狸花猫管家”互动？
- 点击页面右下角的猫咪，会随机弹出极客语录。
- 将鼠标悬停在猫咪身上，点击 **[💬 AI 问答]**，可以直接点击快捷指令胶囊（如“即将过期?”）让猫咪帮你汇报资产。
- 点击 **[🔋 充能罐头]** 可以喂猫，吃得越多，头衔越霸气！

### 3. 如何配置微信/TG 推送？
1. 切换到顶部菜单 **[通知设置]**。
2. **推荐国内用户** 选择 `PushPlus 微信推送`，去 [PushPlus 官网](http://www.pushplus.plus/) 扫码拿到 Token 填入即可。
3. **Telegram 用户** 需要去 `@BotFather` 申请一个机器人 Token，然后去 `@userinfobot` 获取你的 Chat ID 填入。*(系统已内置容错机制，如果填错会有红字明确报错提醒)*。

---

## ❓ 常见问题 (FAQ)

**Q：为什么登录后页面提示“⚠️ KV 未绑定，数据无法保存”？**
> **A**：这说明你在部署的【第四步】中，忘记绑定 KV，或者变量名没有大写填为 `KV`。请回到 Cloudflare 后台检查。

**Q：批量导入怎么用？**
> **A**：非常智能！你可以直接把 Excel 里的数据，或者平时乱记在记事本里的文本粘贴进去（例如：`myweb.com 2025-10-01 阿里云`）。只要每行包含**域名**和**日期**，系统就能自动提取！

**Q：支持哪些 Webhook 格式对接自己的系统？**
> **A**：通知设置中选择 `Email/Webhook`，默认会发送标准 POST JSON 数据 `{"to":"", "subject":"", "text":""}`。如果在 URL 里包含 `[text]` 或 `[title]`，系统会智能切换为 GET 请求并自动替换变量内容。

---

<div align="center">
  <b>Built with ❤️ by Hackers & Cat Lovers.</b><br>
  <i>享受每一次敲击终端的乐趣！</i>
</div>
