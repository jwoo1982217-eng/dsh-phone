/**
 * 二维码生成（零依赖，供本地登录页使用）。
 *
 * ## 为什么要自己实现
 *
 * 仓库**没有任何 QR 依赖**（已核实 `node_modules` 与 DSH 的 `node_modules`）。
 * 客户端用的是 `qrcode.react`（内部 `qrcode-generator`），但那不能直接复用：
 * 我们的登录页是宿主侧渲染的 HTML，而 `qrcode.react` 是 React 组件。
 *
 * ## 为什么放在宿主侧而不是浏览器端
 *
 * 二维码内容（`https://…/login/mp?code=<32位hex>&appname=…`）由**宿主侧**
 * 在登录会话开始时生成，之后**不再变化** —— 页面只需把它画出来。
 * 故宿主侧直接产出 SVG 字符串内联进 HTML 即可，浏览器端**不需要**任何 QR 逻辑。
 * 这消除了「两份实现漂移」的风险（计划里曾考虑宿主 + 浏览器两份实现 + parity 测试）。
 *
 * ## 实现范围（刻意最小）
 *
 * - **byte 模式**（UTF-8 字节）
 * - **纠错等级 M**
 * - **版本 1–10**（内容上限 213 字节，够编码约 145 字节的登录 URL）
 *
 * 不做数字/字母数字模式、不做更高纠错等级、不做版本 11+ —— 本插件的用途是
 * 编码一个固定形态的短 URL。超出容量时**抛错**（由调用方缩短内容），
 * 而不是静默产出扫不出来的坏码。
 *
 * 算法依据 ISO/IEC 18004。结构与 Nayuki 的参考实现一致（MIT），
 * 但按本项目的注释与命名习惯重写。
 */
/** 生成结果。 */
export interface QrMatrix {
    /** 边长（模块数）。 */
    size: number;
    /** `modules[row][col]`，`true` 表示深色模块。 */
    modules: boolean[][];
}
/**
 * 生成 QR 模块矩阵。
 *
 * ⚠️ 只实现 byte 模式 + 纠错等级 M + 版本 1–10 —— 本插件的用途是编码一个
 * 约 145 字节的固定形态 URL。超出容量时**抛错**，由调用方缩短内容，
 * 而不是静默产出扫不出来的坏码。
 */
export declare function buildQrMatrix(text: string, options?: {
    errorCorrection?: 'L' | 'M' | 'Q' | 'H';
    mask?: number;
}): QrMatrix;
/**
 * 把矩阵渲染成内联 SVG 字符串。
 *
 * 用 SVG 而非 canvas：登录页直接把它插进 DOM 即可，无需任何 JS 绘图调用，
 * 且在任意缩放下都清晰（`shape-rendering: crispEdges` 保证模块边缘锐利）。
 */
export declare function renderQrSvg(text: string, options?: {
    size?: number;
    margin?: number;
    dark?: string;
    light?: string;
}): string;
//# sourceMappingURL=raccoon-qr.d.ts.map