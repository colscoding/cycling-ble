# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- A listener that throws no longer keeps other listeners from receiving a
  reading or status change, and can no longer disturb reconnection. A status
  listener throwing on `'connected'` used to make reconnection retry without
  limit, and one throwing on `'disconnected'` stopped reconnection from
  starting. On a real connection the error now goes to `reportError`, or is
  rethrown on a later tick where that does not exist. A mock sensor notifies
  every listener, then rethrows the first error from `emit()` or
  `disconnect()`.
- A reconnect attempt that fails part-way closes the Bluetooth link. The link
  used to stay open after `'failed'`, which kept other apps and devices from
  connecting to the sensor.
- A second call to `disconnect()` no longer reports `'disconnected'` again.
- `classifyBluetoothError` matches wording regardless of capitalisation (so
  "Failed to connect" is a connection failure), classifies a saved device that
  is no longer permitted as `not-found`, and reads `name` and `message` from
  error-like objects that are not `Error` instances.
- Connecting with `previousDeviceId` now rejects with a message that says
  which of three things went wrong: the device is gone, the browser does not
  support `getDevices()`, or the lookup failed. A failed lookup carries the
  original error as `cause`. All three used to say the device was not found
  in the permitted device list.

### Added

- The `BluetoothAdapter` type is exported from the root entry point.
- README sections on reconnection options, the order of status changes,
  cadence when pedalling stops, and known limitations.

## [0.1.0] - 2026-09-10

First release.

[Unreleased]: https://github.com/colscoding/cycling-ble/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/colscoding/cycling-ble/releases/tag/v0.1.0
