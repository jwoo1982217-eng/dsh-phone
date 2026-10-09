#!/usr/bin/env node
import { NativeControlBridge } from './bridge.mjs';

const help = `cli-anything-phone --json <status|request|action|stop> --owner <session-id> [--args '<JSON>']
Android-only structured command adapter. Requires the shipped native module.
request args: {"task":"Search in an App","packages":["com.example.app"],"minutes":10}
action args: {"action":"read"} or {"action":"click","snapshotId":"...","nodeId":"n3"}
Consent is granted ONLY on the phone's native page. No command enables accessibility or approves a task.
Prefer the DSH phone_control tools: they bind the real local session automatically.`;
const argv = process.argv.slice(2);
if (!argv.length || argv.includes('--help')) { process.stdout.write(help + '\n'); }
else {
  try {
    const positionals = argv.filter((arg, i) => !arg.startsWith('--') && (i === 0 || !['--owner', '--args'].includes(argv[i - 1])));
    const command = positionals[0], owner = argv[argv.indexOf('--owner') + 1];
    if (!argv.includes('--owner') || !/^[a-zA-Z0-9_-]{1,128}$/.test(owner) || owner.startsWith('qq-')) throw Error('Use an explicit local session --owner; native approval is still required.');
    const args = argv.includes('--args') ? JSON.parse(argv[argv.indexOf('--args') + 1]) : {};
    const bridge = new NativeControlBridge();
    const value = command === 'action' ? await bridge.execute(owner, args)
      : ['status', 'stop'].includes(command) ? await bridge.call(command, { owner })
      : command === 'request' ? await bridge.call('request', { ...args, owner }) : (() => { throw Error('Unknown command'); })();
    process.stdout.write(JSON.stringify({ ok: true, value }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, error: error.message }) + '\n'); process.exitCode = 1; }
}
