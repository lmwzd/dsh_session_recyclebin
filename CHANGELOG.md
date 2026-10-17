# Changelog

## 0.2.2

- Remove the DSH version lock: `engines.dsh` is now an open `>=0.2.0` range and every kernel package peer dependency is dropped, leaving only the framework (`@deepseek-ai/cordis`).
- Bind services late by name instead of declaring hard dependencies, so the plugin activates whenever its services appear — including after a changed load order or a renamed bundle in a newer DSH.
- Drop the pinned client activation list; the session-list owner is now bound through deferred injection with a retry fallback.
- Degrade a single feature instead of the whole plugin when a kernel service method changes in a future release.
- Verified against the real Cordis runtime: no hard dependency, staged late activation, both HTTP routes mounted, disposal clean.

## 0.2.1

- Target DSH runtime `0.2.1-rc.1` and Cordis `4.0.5`, as shipped with Desktop 44.7.0.
- Replace the obsolete runtime dependency on `dsh-client-ui-slots` with its shipped owner, `dsh-client-ui-renderer`.
- Declare client activation dependencies on the renderer, locale service and Session Controller so deletion filtering starts after the actual list owner.
- Align host peer dependencies with the persistence, query and workspace services the plugin uses.
- Add manifest compatibility checks and retain the existing recycle-bin data format.

## 0.2.0

- Rename the package and client module to `dsh_session_recyclebin`.
- Keep existing recycle-bin data and browser deletion markers compatible with the previous package name.
- Hide recycled and permanently deleted sessions from sidebar snapshots, including archived views and refreshed lists.
- Refresh the sidebar after delete, restore, purge and empty operations.
- Fix permanent deletion and read actual session titles from title snapshots.
- Preserve parked logs when shared purge fails and refuse to overwrite existing history during relocation.
- Display “取消” and “确认清空” on the empty-bin confirmation buttons.
- Add Chinese and English GitHub installation instructions and isolated test automation.

## 0.1.0

- Initial session delete plugin with an optional recycle-bin entry.
