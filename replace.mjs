import fs from 'fs';
import path from 'path';

function replaceInDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== 'dist') {
        replaceInDir(fullPath);
      }
    } else if (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx') || fullPath.endsWith('.mjs') || fullPath.endsWith('.cjs') || fullPath.endsWith('.md')) {
      let content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('@open-design/')) {
        content = content.replace(/@open-design\//g, '@jt-design/');
        fs.writeFileSync(fullPath, content);
        console.log('Updated', fullPath);
      }
    }
  }
}

replaceInDir('./tools');
replaceInDir('./apps/desktop');
