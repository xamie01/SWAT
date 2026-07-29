const fs = require('fs');
const file = 'apps/api/src/index.ts';
let content = fs.readFileSync(file, 'utf8');

const mintMatch = content.match(/app\.get\('\/v1\/tokens\/:mint'[\s\S]*?\n\}\);\n/);
const trendingMatch = content.match(/app\.get\('\/v1\/tokens\/trending'[\s\S]*?\n\}\);\n/);

if (mintMatch && trendingMatch) {
  content = content.replace(mintMatch[0], '');
  content = content.replace(trendingMatch[0], trendingMatch[0] + '\n' + mintMatch[0]);
  fs.writeFileSync(file, content);
  console.log('Swapped routes!');
} else {
  console.log('Match failed');
}
