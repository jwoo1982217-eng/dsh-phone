// Android/Bionic 万能桩（dsh phone profile）：任何属性访问/调用都返回新的万能桩。
// 目的：让硬依赖原生 .node 二进制的包（koffi/node-pty/sharp）能通过 import 与
// 模块级初始化；被实际调用时抛错并留痕，功能本身在手机 profile 中不使用。
function makeStub(label) {
  const fn = function stubFn() {
    throw new Error("[phone-stub] " + label + " 在 Android 手机 profile 中不可用（原生模块桩）");
  };
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive) return () => "[stub " + label + "]";
      if (prop === "then") return undefined;
      if (prop === "__isStub") return true;
      if (!(prop in target)) target[prop] = makeStub(label + "." + String(prop));
      return target[prop];
    },
    apply() {
      throw new Error("[phone-stub] " + label + "() 在 Android 手机 profile 中不可用（原生模块桩）");
    },
    construct() {
      throw new Error("[phone-stub] new " + label + " 在 Android 手机 profile 中不可用（原生模块桩）");
    }
  });
}
module.exports = makeStub("node-pty");
module.exports.default = module.exports;

