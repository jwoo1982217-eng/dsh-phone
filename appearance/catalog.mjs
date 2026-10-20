import { readFileSync } from 'node:fs';

export const catalog = JSON.parse(readFileSync(new URL('./assets/catalog.json', import.meta.url), 'utf8'));
export const themes = new Map(catalog.providers.flatMap(provider => provider.themes.map(theme => [theme.id, { ...theme, provider: provider.id }])));
export function findTheme(id) {
  const theme = themes.get(id);
  if (!theme) throw Error('请选择外观列表中的皮肤');
  return theme;
}
export const legacyIds = { peach: 'local:peach', mint: 'local:mint', original: 'local:original' };
