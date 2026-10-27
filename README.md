# WZ 随机助手

一个基于微信小程序与 CloudBase 的校园广播站点歌、抽取、审核和发布工具。

## 主要功能

- 每周限时开放点歌，支持标题、备注与微信内容安全检测。
- 按周期抽取并生成待审核排期，管理员可调整、修改或删除备注。
- 发布每周最终列表，并向已授权用户发送订阅消息。
- 普通管理员与超级管理员分级权限，通行码使用 bcrypt 哈希。
- 动态使用说明：用户端折叠阅读并预览图片，超级管理员可草稿/发布、排序、隐藏和维护图片。
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
4. 创建项目所需的数据库集合、索引与安全规则。其中 `help_articles` 建议使用 `ADMINONLY`，由 `manageHelpContent` 云函数统一读写。
5. 在 `verifyAdmin` 云函数中配置 `SUPER_ADMIN_HASH` 环境变量，值为超管通行码的 bcrypt 哈希。
6. 逐个上传并部署 `cloudfunctions/` 下的云函数。

## 安全说明

- 仓库不包含云数据库中的用户数据、管理员通行码或超管 bcrypt 哈希。
- `project.private.config.json`、`.cloudbase/`、本地依赖和密钥文件已通过 `.gitignore` 排除。
- `testTool` 包含测试与维护能力，实际投入运行前应使用独立测试环境，并在正式环境禁用模拟数据操作。
- 本周待抽候选达到 250 条后的有效投稿按既有规则保存为 `overflow`，仍返回成功并增加计数；具体保留与清理策略见项目主文档。

## 文档

当前架构、已完成改动、云端配置要求和待办见 [`Progress/广播站点歌小程序.md`](Progress/%E5%B9%BF%E6%92%AD%E7%AB%99%E7%82%B9%E6%AD%8C%E5%B0%8F%E7%A8%8B%E5%BA%8F.md)。

- 当前界面约定：[DESIGN.md](DESIGN.md)。布局方向先讨论、再看 HTML 样稿、确认后才接入正式小程序。
- 歌单平铺历史对照：[E-playlist-flat.html](Progress/design/mockups/E-playlist-flat.html)（E.2）。保留三期、长文本、多状态及浅色/深色/跟随系统的固定数据演示，不连接业务云端；当前接入代码的方案为 F.2，正式深色适配仍未完成。
- 已确认歌单样稿：[F-playlist-card.html](Progress/design/mockups/F-playlist-card.html)（F.3）。F.2 已接入，F.3 补齐日期标题层级与无卡片状态；首页与歌单共用连续渐变和自定义顶部导航。代码完成不代表已发布，HTML 深色仍为预览；E.2 保留作历史对照。
- 待评审的说明/关于：[G-info-pages.html](Progress/design/mockups/G-info-pages.html)。可切换两页、说明折叠与图片演示、状态、小屏和浅深色；仅固定样例，不接云端。用户正在查看，正式 `pages/help` 与 `pages/about` 未修改。
- 操作图标使用按需本地 SVG；当前返回、提醒及提醒状态三个源文件共 677 字节，不引入图标库依赖或字体包。
- 备份约定：每轮改动前提交并推送备份到 `origin/main`；验证后提交并推送结果。网络失败要明确报告，不能用“本地已提交”代替“远端已备份”；只有用户明确允许时才先完成本地工作。

## 许可证

本项目由维护者原创的源代码和文档采用 [MIT License](LICENSE)，版权归 `firedbeab` 所有。允许使用、修改、分发和商业使用，须保留许可证要求的版权与许可声明。

- 第三方依赖、引用的第三方文字及代码仍遵循各自的许可证和版权声明。
- `assets/icons/` 中本项目原创的 SVG 界面图标采用 MIT 许可证。
- 图片、照片、截图、音频、字体等非代码素材不包含在本项目的 MIT 授权范围内，除非素材另有明确授权。包括 `Progress/design/shots/` 中用于设计调研的倒带 App 截图；复用前请核对素材来源与许可。
- 许可证不授予对线上服务、云资源或用户数据的访问权。
