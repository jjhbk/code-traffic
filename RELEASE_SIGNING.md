# Release signing

Local builds and current tagged releases remain unsigned. When production
certificates are provisioned, set `RELEASE_SIGNING_REQUIRED=1` in the release
workflow and provide the platform credentials below through the CI secret
store.

## Windows

- `WINDOWS_CERTIFICATE_FILE`: path to the Authenticode `.pfx` file on the runner
- `WINDOWS_CERTIFICATE_PASSWORD`: password for the `.pfx`

The certificate should identify Signal Box and use a trusted timestamp server.

## macOS

- `MACOS_SIGNING_IDENTITY`: Developer ID Application identity
- `APPLE_ID`: Apple developer account email
- `APPLE_APP_SPECIFIC_PASSWORD`: app-specific password for notarization
- `APPLE_TEAM_ID`: Apple developer team ID

The macOS runner must also have the Developer ID certificate installed in its
keychain. Use a signed and notarized build for public distribution.

The Electron Forge packager uses platform signing hooks for the app bundle and
the Squirrel maker signs the Windows installer when the certificate variables
are present.
