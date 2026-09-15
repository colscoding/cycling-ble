# Changelog

All notable changes to this package are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-09-15

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
- `classifyBluetoothError` reports a browser with no `getDevices()` as
  `unavailable` with `canRetry: false`. It used to fall through to `unknown`
  with `canRetry: true`, advising a retry that cannot ever succeed. A
  saved-device lookup that merely failed stays retryable.
- `initialCadenceState` is frozen. It is a single object shared by every
  caller, so a consumer writing to it used to move the starting point for
  every other consumer in the process.
- Cadence documentation no longer claims a `0 rpm` reading is impossible. A
  sensor that advances its crank event time without reporting a new
  revolution yields a real `0`, and always did.

### Changed

- `CadenceState`'s fields are `readonly`. The parser never mutated the state it
  was handed, and callers thread the returned state through instead; code that
  wrote to a `CadenceState` in place will now fail to compile.

### Added

- The `BluetoothAdapter` type is exported from the root entry point.
- README sections on reconnection options, the order of status changes,
  cadence when pedalling stops, and known limitations.

## [0.1.0] - 2026-09-10

First release.

[Unreleased]: https://github.com/colscoding/cycling-ble/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/colscoding/cycling-ble/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/colscoding/cycling-ble/releases/tag/v0.1.0
