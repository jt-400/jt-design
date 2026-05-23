import fs from 'fs';
import path from 'path';

function replaceInDir(dir) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      if (file !== 'node_modules' && file !== 'dist' && file !== '.git') {
        replaceInDir(fullPath);
      }
    } else if (file === 'package.json') {
      let content = fs.readFileSync(fullPath, 'utf8');
      if (content.includes('@open-design/')) {
        content = content.replace(/@open-design\//g, '@jt-design/');
        fs.writeFileSync(fullPath, content);
        console.log('Updated package.json in', fullPath);
      }
    }
  }
}

replaceInDir('./apps');
