# Community stable Purge entry

Version 1.1.68-community.stable-dock-entry.1 derives from published 1.1.67 (ecd62e53bb5656ca48d364aff91615e72f4b90213c183717a09461b0b141138e). The original user notice, authorization, clean/drill state, host routes and cleanup code remain byte-identical. A fixed accessible dsh-purge button is added within the existing public shell.overlay mount and calls the original toggleDock. The original hero/tab anchor chips remain compatible with hosts that provide them. The release contains no src/client source tree; only the shipped client.js is modified, and the original build scripts remain unchanged. Future upstream rebuilds must reapply this documented narrow published-client patch.

This candidate is unpublished. Code-only contract and official archive preparation are separate from actual Desktop installation/cold-start/click validation and from cleanup or red-team business.

本社区版本仅增加稳定可访问的 dsh-purge 打开按钮，复用原 toggleDock；原须知、授权、面板和清理/安全业务保持原样。原作者包、版本与哈希保留，新版本单独发布。候选尚未发布，代码合同不等于实机或完整业务验收。
