const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../mobile/src/push.js'), 'utf8')
  .replace(/^export /m, '')
  .replace(/\n$/, '\nmodule.exports = { expoProjectId };\n');
const context = { module: { exports: {} }, exports: {} };
vm.runInNewContext(`(function (module, exports) { ${source}\n})(module, exports);`, context);
const { expoProjectId } = context.module.exports;

assert.equal(expoProjectId({ expoConfig: { extra: { eas: { projectId: 'project-from-expo-config' } } } }), 'project-from-expo-config');
assert.equal(expoProjectId({ easConfig: { projectId: 'project-from-legacy-config' } }), 'project-from-legacy-config');
assert.equal(expoProjectId({ expoConfig: { extra: { eas: {} } }, easConfig: {} }), null);
console.log('mobile push config tests passed');
