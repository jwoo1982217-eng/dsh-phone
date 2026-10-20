# Community managed Host launcher compatibility

1.1.68-community.stable-dock-entry.2 is community adaptation revision managed-bootstrap-launcher.1 based on 1.1.68-community.stable-dock-entry.1 (9b6f3f583da6d168d2d4cfa471867a1ff31652c71bbe07ae3e2988cec9107119), with upstream author release 1.1.67 and MIT attribution preserved. It is not an upstream author release.

The original private-runtime ownership function required the process argv entry to equal the Host main index.js. The managed Desktop now launches the separately published bootstrap.js first. This revision accepts only those two physical entries in the same resolved @deepseek-ai/dsh-desktop-host@0.2.1-alpha.1 package; bootstrap must also be explicitly listed in that package's published files. The immutable config files and actual launcher overlays still determine supported rows. Other launchers, unlisted entries, linked files, wrong package identities, unmatched overlay config, private Apply/Revert trial refusal and cleanup/security behavior retain their original checks. The shipped client, patches and every other host file are byte-identical.

本修订属于社区适配，保留原作者 1.1.67、许可证与原件。只补当前受控宿主 bootstrap 启动入口识别，仍校验同包身份、真实发布文件与配置归属；不更改清理或安全业务、不弱化私有目录及试运行保护。候选制作阶段尚未发布，实测与最终发布状态由独立报告记录。
