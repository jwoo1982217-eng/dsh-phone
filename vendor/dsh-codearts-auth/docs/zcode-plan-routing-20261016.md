# ZCode 来源与模型目录

参考官方 zai-org/ZCode 的 config/provider/zcode-builtin.json，revision 31，commit aac4755666d09fdcd70272fcf063c077a639015f。该目录把 Coding Plan 的 Anthropic 接口与普通 API 的 OpenAI 接口分开；目录不保证具体账号的权益或价格。

- Start Plan 继续使用登录账号的赠送 JWT；个人与机构编程套餐保持各自密钥和组织项目作用域。
- 机构流量使用本人账号中该机构项目的普通 API 密钥、组织/项目头和 /api/paas/v4/chat/completions。优先 usageScene=2 的已有普通 API key，排除编程套餐专用 usageScene=1 和团队 key；旧平台没有用途标记时兼容已有普通项目 key。不创建云端密钥。
- 切换来源广播模型目录更新，并重新挂载已打开的显示列表。机构流量目录来自官方普通 API 模板，共24项；赠送/编程套餐继续读取其原有模型目录。目录和未过滤的模型设置列表保持一致，黑名单不丢失。
- GLM-5.3 系列只能选择其公开的 low/high/max；普通 API 请求透传思考档位。切回套餐后，普通 API 专有模型在发请求前明确拒绝，避免静默换扣费来源。
- 来源解析的异步期间发生切换时拒绝旧请求，已发出的 HTTP 请求保留原身份。接口错误区分 1113/1005 额度与并发限流，不泄露上游原始响应或密钥，也不退回本账号的其他 Plan。

2026-10-16 实际机构流量 GLM-5.3-Flash 请求返回 HTTP429 / 1113：余额不足或无可用资源包。它是上游对当前模型和项目的额度判断；程序不能把其他 Plan 的余额算作机构流量可用额度。本次没有为用户充值或新建云端密钥。

普通 API 的成功模型调用及页面切换验收以任务回执为准，不把静态目录、模拟测试或 HTTP URL 正确当作全部模型扣费均验证。


## 编程套餐真实额度重置

对照 ZCode 固定版本 aac4755666d（packages/services/src/usage-stats/providers/bigmodelUsageQuotaProvider.ts）：使用 ZCode JWT + 同渠道 MaaS OAuth，个人带 PERSONAL、团队带 TEAM 及准确组织/项目；请求 /api/v1/coding-plan/reset/status、opportunity、use。与清除本地冷却标记分开。

主要入口是对话页底部模型选择器中的“ZCode 重置额度”，不要求离开对话去设置。弹窗明确选择账号和编程套餐；机构流量/赠送不默认代选其他套餐。账号卡片的折叠区保留为管理页辅助入口。消耗 5 小时/周机会须在界面确认。重试复用同一操作编号；资格拒绝保留 next_try_at，不后台轮询/自动核销。机构流量余额及 Start Plan 赠送不适用。未使用实际核销来测试，不能据此声称已成功恢复真实账户额度。

模型选择器覆盖层只调用 Jet Hub 注册的 __dshOpenZcodeReset 界面桥；没有嵌入凭据或远程 API 逻辑。Jet Hub 卸载时清理桥和弹窗；没有自动核销，所有真实 use 仍要求确认。
