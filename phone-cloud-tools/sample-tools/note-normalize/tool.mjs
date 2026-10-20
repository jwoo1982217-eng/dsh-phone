import { writeFile } from 'node:fs/promises';
const { text } = JSON.parse(process.argv[2]);
const content = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trimEnd()).join('\n').trim() + '\n';
await writeFile('note.txt', content, { mode: 0o600 });
console.log(JSON.stringify({ filename: 'note.txt', bytes: Buffer.byteLength(content) }));
