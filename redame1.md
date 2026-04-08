这是一份专门为零基础用户准备的 Domain Manager v4 完整部署教程。它将手把手教你如何从零开始，在 Cloudflare 上搭建一套全自动的域名监控系统。

🌐 Domain Manager v4 零基础全自动化部署教程

本系统可以帮你监控所有域名的到期时间，并在到期前 180, 90, 30, 15, 1 天通过 Telegram 自动提醒你续费。

📝 准备工作

一个 Cloudflare 账号（免费版即可）。

一个 Telegram 账号。

🚩 第一步：创建 KV 数据库（用于存放数据）

Worker 就像一个大脑，而 KV 就是它的硬盘。

登录 Cloudflare 后台。

在左侧菜单点击 Workers & Pages -> KV。

点击右上角的 Create a namespace（创建命名空间）。

Namespace Name 输入：DOMAIN_DATA（也可以自定义，记住这个名字）。

点击 Add。

🚩 第二步：创建并部署 Worker（运行程序）

在左侧菜单点击 Workers & Pages -> Overview（概览）。

点击 Create application -> Create Worker。

给你的 Worker 起个名字（比如 my-domain-mgr），点击底部的 Deploy（部署）。

部署成功后，点击 Edit Code（编辑代码）。

清空编辑器里原有的所有代码，将本仓库提供的 worker.js 全部内容粘贴进去。

点击右上角的 Save and Deploy（保存并部署）。

🚩 第三步：核心配置：绑定与环境变量 (必做！)

如果不做这一步，程序会报错无法使用。

回到 Worker 的详情页面（点击左上角 Worker 名字回到主页）：

1. 绑定 KV 数据库

点击 Settings（设置）选项卡 -> 点击左侧的 Bindings（绑定）。

找到 KV Namespace Bindings 区域，点击 Add -> KV namespace。

Variable name (变量名)：必须填 KV（全大写，不能改）。

KV namespace (KV 命名空间)：选择你在“第一步”创建的 DOMAIN_DATA。

点击 Save（保存）。

2. 设置管理员密码

在同一页面的 Environment Variables (环境变量) 区域，点击 Add variable。

Variable name：填 ADMIN_PASSWORD。

Value：设置你的后台登录密码（如果不设置，默认密码是 admin123）。

点击 Save（保存）。

🚩 第四步：设置定时检查任务（让它每天自动运行）

为了让系统每天自动检查域名，我们需要给它设个“闹钟”。

在 Worker 详情页面，点击 Triggers（触发器）选项卡。

找到 Cron Triggers 区域，点击 Add Cron Trigger。

选择 Custom，在输入框输入：0 0 * * *（这代表每天凌晨 0:00 自动检查）。

点击 Add Trigger。

🚩 第五步：Telegram 机器人配置
1. 获取 Bot Token 和 Chat ID

在 Telegram 里私聊 @BotFather，发送 /newbot，按照提示给机器人起名，获得 API Token。

访问你的 Worker 地址（在 Worker 概览页可以看到类似 https://xxx.workers.dev 的链接）。

使用你在第三步设置的密码登录后台。

点击“设置”，填入 Bot Token 并点击保存。

在 Telegram 里找到你的机器人，发送 /start。机器人会识别并回复你的 Chat ID。

回到网页后台，填入这个 Chat ID 并再次保存。

2. 强力激活 Webhook（解决机器人不回消息）

如果你的机器人不响应 /domains 指令，是因为 Telegram 还不知道把消息发给谁。请在浏览器地址栏直接访问下面这个拼接好的链接（重要）：

链接模板：
https://api.telegram.org/bot<你的_BOT_TOKEN>/setWebhook?url=https://<你的_WORKER_名字>.<你的_用户名>.workers.dev/api/telegram/webhook

<你的_BOT_TOKEN>：换成你的机器人 Token。

url=...：换成你 Worker 的完整访问地址，结尾必须带上 /api/telegram/webhook。

看到 {"ok":true,"result":true,"description":"Webhook was set"} 即代表成功！ 此时你可以关闭所有网页，机器人已经可以在后台 24 小时随时待命了。

💡 使用说明
1. 自动同步 Cloudflare 域名

登录后台 -> 点击“账号” -> “添加 CF 账号”。

API Token 获取方式：Cloudflare 官网 -> 右上角头像 -> My Profile -> API Tokens -> Create Token -> 选 Read All Resources 模板 -> 创建后复制。

添加成功后点击“同步”，系统会自动读取你 CF 下的所有域名。

2. 提醒天数说明

系统默认在到期前 180、90、30、15、1 天推送 Telegram。

如果你在添加域名时填写了“控制台链接”，TG 消息里会出现**“💳 续费”**按钮，点击直接跳转。

3. Telegram 指令表

/domains - 获取所有域名列表及到期状态。

/expiring - 获取未来 30 天内即将过期的域名。

/check - 强制系统立刻扫描一次（手动触发提醒）。

❓ 常见问题

登录显示 Unauthorized？：密码输入错误，请检查环境变量中的 ADMIN_PASSWORD。

网页显示 KV 未绑定？：请回到“第三步”，确认变量名是 KV 而不是命名空间的名字。

机器人不回指令？：请重新执行“第五步”中的手动激活 Webhook 链接。


