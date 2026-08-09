# QQ 机器人桥接（QQ Bot Bridge）

把 QQ 官方机器人接到本机 Codex CLI 的本地桥接程序，带聊天面板。

人不在电脑前时，用 QQ 给机器人发消息，就能远程使用本机的 Codex。回复经机器人发回 QQ，发来的文件自动归档。

## 功能特性

- 多机器人并行：支持多个 QQ 官方机器人（WebSocket 网关）。
- 白名单强制：未配置白名单时进入安全模式，不执行任何任务。
- 聊天面板：本地网页面板（http://127.0.0.1:17890），实时查看聊天记录、以机器人身份发送。
- 面板回复同步到 QQ：勾选"同步到QQ"，电脑端回复会经机器人发回手机。
- 文件收件箱：QQ 发来的文件按 机器人名/日期 自动归档。
- 独立托盘：QQBotTray.exe 常驻，不与其它托盘图标合并。
- 一键更新：增量更新包 + 更新.bat。

## 快速开始

部署者（工程师）阅读 说明书.md，按步骤执行。用户必须自己创建机器人。

1. 用户在 QQ 开放平台（https://q.qq.com/）创建机器人，获取 AppID 和 AppSecret。
2. 环境：Windows 10/11，Node.js 22 或更高，Codex CLI 已安装并已登录。
3. 复制 .env.example 为 .env，填写 QQBOTS_JSON。
4. 运行 start.bat，或运行 node bridge.mjs。
5. 让用户给机器人发一条消息。
6. 从 logs/bridge.log 取 openid，填入 .env 的 ALLOWED_OPENIDS。
7. 重启桥接。

## 目录结构

| 文件/目录 | 说明 |
|-----------|------|
| bridge.mjs | 主程序（QQ 网关、Codex 调用、面板服务） |
| panel.html | 聊天面板页面 |
| qq-bot-tray.ps1 | 托盘启动器（自动编译并启动 QQBotTray.exe） |
| QQBotTray.cs / QQBotTray.exe | 独立托盘程序源码与成品 |
| chat-latest.mjs | 增量日志读取 |
| .env.example | 配置模板（复制为 .env 后填写） |
| start.bat | 前台启动脚本 |

## 安全说明

- 白名单是强制配置。留空时进入安全模式，不执行任何任务。
- 本包使用 QQ 官方机器人 API，不使用账号协议。
- 建议启用设备锁（PIN 或密码）。
- 不要把 .env 提交到仓库。.gitignore 已排除 .env、logs、data 等运行时数据。

## 平台限制

- QQ 单聊被动回复：每条用户消息 60 分钟内最多回复 4 条。
- 文件回传走 iCloud 文件夹，不走 QQ 富媒体。
- 需要本机 Codex CLI 已登录。

## 更新

新版本以增量更新包发布。把更新包文件夹放进桥接目录，双击 更新.bat 即可，详见 说明书.md。

## 许可证

MIT

## 作者

- 8!!（[GitHub](https://github.com/HACHI81426)）
