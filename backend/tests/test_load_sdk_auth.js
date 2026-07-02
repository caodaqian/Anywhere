// Verify loadSdkAuth (from mcp_oauth_provider.js) resolves the SDK auth module.
const fs = require('fs');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'mcp_oauth_provider.js'), 'utf8');
const match = src.match(/function loadSdkAuth\(\)\s*\{[\s\S]*?\n\}/);
if (!match) { console.error('loadSdkAuth not found'); process.exit(1); }
eval(match[0]);
try {
  const mod = loadSdkAuth();
  console.log('loadSdkAuth OK: exports=' + Object.keys(mod).slice(0, 6).join(',') + '...');
  console.log('has auth fn:', typeof mod.auth === 'function');
  console.log('has UnauthorizedError:', typeof mod.UnauthorizedError === 'function');
  process.exit(0);
} catch (e) {
  console.error('loadSdkAuth FAILED:', e.message);
  process.exit(1);
}
