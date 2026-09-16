const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const { preparePtyHelpers } = require('./scripts/prepare-pty-helpers');
const path = require('node:path');

const windowsCertificateFile = process.env.WINDOWS_CERTIFICATE_FILE || '';
const windowsCertificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD || '';
const macIdentity = process.env.MACOS_SIGNING_IDENTITY || '';
const appleId = process.env.APPLE_ID || '';
const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || '';
const appleTeamId = process.env.APPLE_TEAM_ID || '';

module.exports = {
  packagerConfig: {
    name: 'signal-box',
    executableName: 'signal-box',
    appBundleId: 'com.signalbox.desktop',
    productName: 'Signal Box',
    icon: path.join(__dirname, 'branding', 'signal-box'),
    ...(macIdentity ? { osxSign: { identity: macIdentity } } : {}),
    ...(appleId && appleIdPassword && appleTeamId ? { osxNotarize: { appleId, appleIdPassword, teamId: appleTeamId } } : {}),
    ...(windowsCertificateFile ? { windowsSign: { certificateFile: windowsCertificateFile, certificatePassword: windowsCertificatePassword } } : {}),
    // node-pty launches spawn-helper and its native libraries from the
    // app.asar.unpacked path. Use a literal directory prefix so the helper is
    // matched consistently across Windows, macOS, and Linux path handling.
    asar: { unpackDir: 'node_modules/node-pty' },
    extraResource: ['codex-notify.js', 'browser-extension'],
    afterPrune: [(buildPath, _electronVersion, platform, _arch, callback) => {
      if (platform !== 'darwin') return callback();
      preparePtyHelpers(buildPath).then(() => callback(), callback);
    }],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        name: 'signal_box',
        setupExe: 'SignalBoxSetup.exe',
        setupIcon: path.join(__dirname, 'branding', 'signal-box.ico'),
        ...(windowsCertificateFile ? { certificateFile: windowsCertificateFile, certificatePassword: windowsCertificatePassword } : {}),
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        options: {
          name: 'signal-box',
          productName: 'Signal Box',
          icon: path.join(__dirname, 'branding', 'signal-box.png'),
          categories: ['Utility', 'Development'],
          maintainer: 'Signal Box contributors',
          homepage: 'https://github.com/jjhbk/code-traffic',
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        options: {
          name: 'signal-box',
          productName: 'Signal Box',
          icon: path.join(__dirname, 'branding', 'signal-box.png'),
          categories: ['Utility', 'Development'],
          homepage: 'https://github.com/jjhbk/code-traffic',
        },
      },
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
