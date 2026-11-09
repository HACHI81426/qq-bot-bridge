QQ Bot Bridge 1.1.0
====================

把 QQ 官方机器人连接到本机 Codex CLI，并提供本地聊天面板。

功能
----
- 支持一个或多个 QQ 官方机器人。
- 强制 openid 白名单；白名单为空时进入安全模式。
- 本地聊天面板：http://127.0.0.1:17890
- 话题隔离、话题切换、话题归档。
- 收件箱模式、批量直连、停止当前任务。
- QQ 文件收件箱、面板通知接口。
- 独立 Windows 托盘程序。

环境
----
- Windows 10/11
- Node.js 22 或更高版本
- Codex CLI 已安装并已登录

快速开始
--------
1. 在 QQ 开放平台创建机器人，取得 AppID 和 AppSecret。
2. 将 .env.example 复制为 .env。
3. 在 .env 中填写 QQBOTS_JSON。
4. 运行 start.bat，或执行 node bridge.mjs。
5. 给机器人发送一条消息。
6. 从 logs/bridge.log 取得 openid。
7. 将 openid 填入 ALLOWED_OPENIDS。
8. 重启桥接。

托盘启动
--------
运行 qq-bot-tray.ps1。首次运行时会尝试编译 QQBotTray.exe。
运行 start-panel.ps1 可在桥接未启动时拉起桥接并打开聊天面板。

通用面板示例
------------
- examples/menu.json：新话题、切换话题、归档话题、收件箱模式、直连、清空并直连。
- examples/panel.json：常用快捷指令面板。

使用 tools/qq-menu.mjs 下发示例前，请先确认目标机器人。

安全
----
- 不要把 .env 提交到版本库或发送给他人。
- 不要在公开仓库中保存真实 AppID、AppSecret、openid、日志或聊天记录。
- 生产环境建议保持白名单最小化。

API
---
POST /api/notify
{"bot":"main","message":"通知文本"}

POST /api/send
{"bot":"main","message":"交给 Codex 的内容","pushQQ":true}

本地接口只绑定 127.0.0.1，并校验本机来源。

许可证
------
MIT
