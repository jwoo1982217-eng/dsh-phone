export const defaults = Object.freeze({ mode: 'system', uiFont: '', codeFont: '', uiSize: null, codeSize: null,
  accent: '', background: '', foreground: '', wallpaper: '', wallpaperOpacity: 0.16, blur: 0,
  translucent: false, reduceMotion: true, width: 'default' });
export const fonts = Object.freeze({
  system: 'system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
  serif: '"Iowan Old Style","Songti SC","Noto Serif CJK SC",Georgia,serif',
  rounded: '"SF Pro Rounded","Nunito Sans",system-ui,sans-serif',
  mono: '"SF Mono","Cascadia Code","JetBrains Mono",Consolas,monospace',
  jetbrains: '"JetBrains Mono","SF Mono",Consolas,monospace',
  fira: '"Fira Code","SF Mono",Consolas,monospace',
});
const colors = new Set(['accent', 'background', 'foreground']);
const numbers = { uiSize: [10, 22], codeSize: [9, 24], blur: [0, 20], wallpaperOpacity: [0, 0.7] };
export function preferences(value = {}, previous = defaults) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('外观参数无效');
  const next = { ...previous };
  for (const [key, field] of Object.entries(value)) {
    if (!Object.hasOwn(defaults, key)) throw Error('未知的外观参数');
    if (colors.has(key)) {
      if (typeof field !== 'string' || (field && !/^#[\da-f]{6}$/i.test(field))) throw Error('请选择有效颜色');
    } else if (key in numbers) {
      const [min, max] = numbers[key];
      if (!(field === null && ['uiSize', 'codeSize'].includes(key)) &&
          (typeof field !== 'number' || !Number.isFinite(field) || field < min || field > max ||
          (key !== 'wallpaperOpacity' && !Number.isInteger(field)))) throw Error('外观数值超出范围');
    } else if (['uiFont', 'codeFont'].includes(key)) {
      if (field !== '' && !Object.hasOwn(fonts, field)) throw Error('请选择字体列表中的字体');
    } else if (key === 'mode') {
      if (!['system', 'light', 'dark'].includes(field)) throw Error('请选择浅色、深色或跟随系统');
    } else if (key === 'width') {
      if (!['default', 'comfortable', 'wide'].includes(field)) throw Error('请选择对话宽度');
    } else if (key === 'wallpaper') {
      if (typeof field !== 'string' || field.length > 3_000_000 || (field &&
          !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(field))) throw Error('壁纸须为本机选择的图片');
    } else if (typeof field !== 'boolean') throw Error('外观开关无效');
    next[key] = field;
  }
  return next;
}
