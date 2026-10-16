# Changelog

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
