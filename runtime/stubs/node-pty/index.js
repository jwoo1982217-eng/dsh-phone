// Android/Bionic 万能桩（dsh phone profile）：任何属性访问/调用都返回新的万能桩（不抛错）。
// 目的：让硬依赖原生 .node 二进制的包（koffi/node-pty/sharp）通过 import 与
// 模块级初始化（如 koffi.pointer("void")）；真正的原生功能在手机 profile 不使用。
function makeStub(label) {
  const fn = function stubFn() { return makeStub(label + "()"); };
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => 0;
      if (prop === "then") return undefined;
      if (prop === "__isStub") return true;
      if (!(prop in target)) target[prop] = makeStub(label + "." + String(prop));
      return target[prop];
    },
    apply() { return makeStub(label + "()"); },
    construct() { return makeStub(label + "#new"); }
  });
}
module.exports = makeStub("node-pty");
module.exports.default = module.exports;

