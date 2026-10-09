import { PhoneRuntime } from './runtime.js';
import { adaptPhonePlugins } from './plugin-compat.js';
const root = process.cwd(), home = process.env.DSH_HOME;
if (!home) throw Error('DSH_HOME required');
const report = await new PhoneRuntime(root, home).apply();
console.log(JSON.stringify({ phoneRuntimePreflight: report }));
try { console.log(JSON.stringify({ phonePluginCompatibility: await adaptPhonePlugins(root, home) })); }
catch (error) { console.log(JSON.stringify({ phonePluginCompatibility: { error: error.message } })); }
