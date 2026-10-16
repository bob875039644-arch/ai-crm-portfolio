# 展示版来源、调整与脱敏范围

## 发布方式

这是经项目所有者授权整理的公开代码展示，采用全新的 Git 历史，不包含原私有项目的提交、PR、分支或内部协作记录。公开代码可以被读取和下载。

## 纳入的内容

| 展示文件 | 原项目位置 | 调整 |
| --- | --- | --- |
| `src/calendar-date.ts` | `packages/shared/src/calendar-date.ts` | 核心实现保持不变 |
| `tests/calendar-date.test.ts` | `packages/shared/src/calendar-date.spec.ts` | 导入改为独立模块 |
| `src/customer-grade-loader.ts` | `apps/web/src/api/customer-grade-loader.ts` | 移除私有 API 客户端与默认 HTTP 请求；fetch 改为必传依赖 |
| `src/grade-contract.ts` | 参考 `packages/shared/src/customer-grade-summary.ts` | 仅保留样例所需的 current/assessment 结果子集；不是原 API 完整校验契约 |
| `tests/customer-grade-loader.test.ts` | `apps/web/src/api/customer-grade-loader.test.ts` | 更换本地导入，保留批处理与失败行为断言 |
| `src/inbound-identity-locks.ts` | `apps/api/src/modules/whatsapp/inbound-identity-locks.ts` | 核心实现保持不变 |
| `tests/inbound-identity-locks.test.ts` | 同模块原测试 | 更换本地导入，合成 phone 改为明显的演示标识 |
| `src/semantic-observation.ts` | `packages/shared/src/semantic-observation.ts` | 只抽取观察 schema；内联原有方向常量与引用身份 helper，移除其他评分阶段依赖 |
| `tests/semantic-observation.test.ts` | 为独立展示版编写 | 使用合成观察验证抽取后的契约及其边界 |

说明文档与 `examples/run.ts` 为展示版新写。概览图是能力示意图，不是生产界面截图。没有把生成的示意内容当作真实业务证据。

## 排除的内容

- 凭据、密钥、token、数据库连接串、环境配置文件和私钥。
- 客户姓名、公司、联系方式、聊天记录、订单、合同、媒体和真实业务导出。
- 生产地址、服务器 IP、部署脚本、备份、运行日志和内部任务台账。
- 私有仓库链接、提交元数据、历史补丁、内部审查报告和历史事故明细。
- 完整数据库模型、完整生产 API、安全配置和付费 provider 的运行参数。

整理采用逐文件白名单提取，而非复制整个项目后批量删除。所有示例输入与测试标识均为合成内容。公开文件在发布前进行人工审阅、类型与行为验证、敏感模式及文件范围检查。静态检查有明确能力边界，不被表述为形式化的零泄漏保证。

## 怎样理解这个仓库

可以据此审阅代码结构、边界处理、技术取舍和聚焦测试；不能据此推断生产部署状态、实际吞吐量、客户规模、商业收入或某个人独立完成全部项目。具体角色分工和 AI 辅助开发方式应在面试中据实说明。


## MAX / 分析主线的补充选材

`reference/` 按主题公开实际源码：MAX runtime、Harness、证据封装、查询工具、权限与上下文、预算、持久 Attempt、最终校验；分析的 Map/Reduce、语义来源校验、V2 生命周期与付费操作；以及成交事务和规则上下文。每页注明原路径及行范围。阅读型源码保留内部依赖名称，不提供原项目私有包或连接，因此不承诺这些节选可以独立编译或启动。

MAX runtime 中的同进程 MCP 逻辑地址替换为 `https://mcp.example.invalid/mcp`，不是可访问的生产服务。原代码对语音历史保留的兼容分支不代表退役的实时通话仍可使用。安全预算常量是选材基线的代码契约，不是生产配置或运维指南。

新增可运行样例 `agent-progress.ts` 抽取自 MAX runtime 的进展控制，内联原代码预算常量；`evidence-grounding.ts` 抽取自语义观察处理的来源准入，改用最小 EvidenceContext，并在本地收集 map 引用。相关新增测试全部使用合成上下文；没有运行完整 Agent、数据库授权、provider 或付费集成测试。
