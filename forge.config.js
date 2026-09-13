const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { preparePtyHelpers } = require('./scripts/prepare-pty-helpers');

module.exports = {
  packagerConfig: {
    // node-pty launches this executable by its app.asar.unpacked path.
    // AutoUnpackNatives only handles .node libraries, not spawn-helper.
    asar: { unpack: '**/node-pty/**/spawn-helper' },
    extraResource: ['codex-notify.js'],
    afterPrune: [(buildPath, _electronVersion, platform, _arch, callback) => {
      if (platform !== 'darwin') return callback();
      preparePtyHelpers(buildPath).then(() => callback(), callback);
    }],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {},
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {},
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
