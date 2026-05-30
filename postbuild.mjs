@'
import { cpSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

const dist = './dist';
const out = './dist/pages';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

cpSync(join(dist, 'client'), out, { recursive: true });
cpSync(join(dist, 'server'), join(out, 'server'), { recursive: true });

writeFileSync(
  join(out, '_worker.js'),
  `import handler from './server/entry.mjs';\nexport default handler;\n`
);

console.log('Pages output ready in dist/pages/');
'@ | Set-Content postbuild.mjs