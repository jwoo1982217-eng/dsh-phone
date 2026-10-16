# 统一外观

DSH 0.2.1-alpha.1 的独立外观模块。设置里只有一个“外观”入口，按来源展开；同一时刻启用一个基础皮肤，字体、颜色、壁纸和布局调整在该来源下保存。

| 来源 | 已接入的外观能力 | 方案数 |
| --- | --- | ---: |
| 现有皮肤 | 桃云、薄荷手记、原版，读取原选择 | 3 |
| [现有 OpenCode 调色板](https://github.com/FeatherHunter/dsh-opencode-palette) | 37 套配色与跟随系统，保留原设置 | 38 |
| [Dream Skin](https://github.com/RevolutionLA/dsh-dream-skin) | 8 套原配色、渐变；统一壁纸与玻璃输入框选项 | 8 |
| [Theme Plugin](https://github.com/BeiZi6/dsh-theme-plugin) | 原配色推导、深浅色、字体 | 5 |
| [Theme Studio](https://github.com/oil-oil/dsh-theme) | 原配色与排版预设 | 15 |
| [DSH Themes](https://github.com/whyihaveyou/dsh-themes) | 151 套原 CSS、纹理、装饰和深浅色 | 151 |
| [UI Tweaks](https://github.com/wlj521/dsh-ui-tweaks) | 默认、极简、荧光海报、规格书样式 | 4 |

这里接入各项目的外观资源与适配器。原插件的 Git 工具、账号、通知、会话或其他功能仍由原插件管理。Dream Skin 的完整液态玻璃模拟、主题包编辑器以及 UI Tweaks 的功能工具不属于本模块。

状态写入当前 DSH_HOME 的 `appearance/center.json`。旧 `appearance/theme.json` 只读迁移，账号、模型、会话和现有插件配置不写入。保存采用版本校验和原子替换；缺失样式/存储失败保留现用外观。只加载一套主题 CSS，无定时轮询或新增 SSE；跨标签页通过 BroadcastChannel 通知后读取最新状态。

通过 SDK ThemeRuntime 管理 token、深浅色和正文大小；通过 SlotCore 的优先级替换旧外观入口。旧入口由旧注册的拥有者主动让位。现装 OpenCode 2.0.26 使用原始 SHA 校验的兼容适配：暂挂原渲染器与皮肤入口，不修改其保存状态；释放统一模块后恢复。适配前原文件保存在 DSH_HOME 的 appearance/compatibility。其他版本或被修改的插件保留原状并报告适配缺口。可选字体只使用设备本地字体，不发起远程字体请求。

电脑安装用 `scripts/install-desktop-appearance.mjs <profile> <runtime node_modules>`，在现有串行安装锁下执行。手工加载行有独立标记，保留其他 profile 内容；已选中本模块组合包的 profile 使用正常组合包加载。运行中升级调用 `installDesktopAppearanceLive`，采用内容摘要目录和独立的摘要 entry ID，仅换掉外观作用域；固定 SDK 修改原 entry 的 name 不会重新加载其 fiber。手机通过同一模块、phone profile 组合包和既有升级合并入口接入。所有页面使用同源相对地址，沿用各设备端口。

`assets/provenance.json` 固定五个上游提交；OpenCode 来源摘要另见 `compat/opencode-provenance.json`；`licenses/` 保留来源许可。主题画廊上游 README 声明 Apache-2.0，未随源码附独立 LICENSE；其原 CSS 保留来源注释。生成外观资产：先取得这些提交的源码快照与 source-manifest，再运行 `node appearance/build-catalog.mjs <快照目录>`。生成结果随工程保存，日常打包不需要联网。

验证：`node --test appearance/store.test.mjs`；`node appearance/ui.test.mjs <证据目录>` 使用当前固定 SDK 的 React、ThemeRuntime 和 SlotCore。浏览器手机尺寸测试不等于真机验收。
