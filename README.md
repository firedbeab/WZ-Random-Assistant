# WZ 随机助手

一个基于微信小程序与 CloudBase 的校园广播站点歌、抽取、审核和发布工具。

## 主要功能

- 每周限时开放点歌，支持标题、备注与微信内容安全检测。
- 按周期抽取并生成待审核排期，管理员可调整、修改或删除备注。
- 发布每周最终列表，并向已授权用户发送订阅消息。
- 普通管理员与超级管理员分级权限，通行码使用 bcrypt 哈希。
- 提交唯一性、并发锁定、发布事务、失败频率限制与错误信息脱敏。

## 技术结构

- 微信小程序原生 WXML / WXSS / JavaScript
- 腾讯云 CloudBase 文档型数据库、云函数和订阅消息
- Node.js 16.13 云函数运行时
- `wx-server-sdk` 与 `bcryptjs`

## 本地开发

1. 安装微信开发者工具，导入本目录。
2. 复制 `project.config.example.json` 为 `project.config.json`，并填入自己的小程序 AppID。该本地文件已被 Git 忽略。
3. 在 `app.js` 和 `cloudbaserc.json` 中配置自己的 CloudBase 环境。
4. 创建项目所需的数据库集合、索引与安全规则。
5. 在 `verifyAdmin` 云函数中配置 `SUPER_ADMIN_HASH` 环境变量，值为超管通行码的 bcrypt 哈希。
6. 逐个上传并部署 `cloudfunctions/` 下的云函数。

## 安全说明

- 仓库不包含云数据库中的用户数据、管理员通行码或超管 bcrypt 哈希。
- `project.private.config.json`\、`.cloudbase/`\、本地依赖和密钥文件已通过 `.gitignore` 排除。
- `testTool` 包含测试与维护能力，实际投入运行前应使用独立测试环境，并在正式环境禁用模拟数据操作。
- 项目中“达到每周 250 条后仍返回成功但不保存内容”是已确认的业务设计，不是遗漏数据的异常分支。

## 文档

当前架构、已完成改动、云端配置要求和待办见 [`Progress/广播站点歌小程序.md`](Progress/%E5%B9%BF%E6%92%AD%E7%AB%99%E7%82%B9%E6%AD%8C%E5%B0%8F%E7%A8%8B%E5%BA%8F.md)。
