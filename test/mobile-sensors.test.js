const assert = require('node:assert/strict');

async function loadHelper() {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../mobile/src/sensors.js'), 'utf8')
    .replace(/^export /m, '')
    .replace(/\n$/, '\nmodule.exports = { readMotionSample };\n');
  const vm = require('node:vm');
  const context = { module: { exports: {} }, exports: {}, setTimeout, clearTimeout, Math, Error, Number, Promise };
  vm.runInNewContext(`(function (module, exports) { ${source}\n})(module, exports);`, context);
  return context.module.exports.readMotionSample;
}

(async () => {
  const readMotionSample = await loadHelper();
  let removed = false;
  const accelerometer = {
    isAvailableAsync: async () => true,
    requestPermissionsAsync: async () => ({ status: 'granted' }),
    setUpdateInterval: (interval) => assert.equal(interval, 250),
    addListener: (listener) => { setImmediate(() => listener({ x: 0, y: 0, z: 1.2 })); return { remove: () => { removed = true; } }; },
  };
  const sample = await readMotionSample(accelerometer);
  assert.equal(sample.active, true);
  assert.equal(sample.activity, 'unknown');
  assert.equal(removed, true);

  await assert.rejects(() => readMotionSample({ ...accelerometer, isAvailableAsync: async () => false }), /unavailable/);
  await assert.rejects(() => readMotionSample({ ...accelerometer, requestPermissionsAsync: async () => ({ status: 'denied' }) }), /not granted/);
  let synchronousRemoved = false;
  await readMotionSample({ ...accelerometer, addListener: (listener) => { listener({ x: 0, y: 0, z: 1 }); return { remove: () => { synchronousRemoved = true; } }; } });
  assert.equal(synchronousRemoved, true);
  console.log('mobile sensor tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
