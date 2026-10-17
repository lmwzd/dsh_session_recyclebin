# dsh_session_recyclebin

English | [简体中文](README.md)

Adds **Delete Session** to DSH's sidebar session menu and provides a recoverable recycle bin. Plugin **0.2.1** targets **DSH runtime 0.2.1-rc.1** (checked against the packages shipped with Desktop 44.7.0) and requires **Node.js >= 20**.

## Features and deletion behavior

- The recycle bin is enabled by default. Deleted sessions can be restored, permanently deleted, or removed by emptying the bin. The empty-bin button uses a Chinese label.
- Retention is configurable from **3 to 30 days**. Expiry cleanup, permanent deletion, and emptying the bin are irreversible.
- The recycle bin is an optional subplugin. **Disabling the trash entry makes Delete Session permanently delete sessions immediately, with no recovery.**
- Recycle-bin entries prefer the actual session title from the log and support title corrections for older entries.
- Sidebar filtering stays in sync with deletion and subsequent updates, preventing deleted sessions from reappearing under Ungrouped or Show Archived. Restoration makes them visible again and restores workspace associations.

An active session turn is stopped before deletion. The affected data includes session logs, session attachments, projection caches, and workspace registration. Files in your project working directory are neither deleted nor reverted; forked child sessions are not deleted along with their parent.

## Install

These commands use the `desktop` profile; replace it if you use another profile. Restart DSH after installation or updates to load both host and client code.

### Install from GitHub

Install from this plugin's public repository:

```bash
dsh plugin --profile desktop add github:lmwzd/dsh_session_recyclebin
```

The repository root must contain the plugin package directly. This installation method does not require publishing to npm. To update, run the installation command again and restart DSH.

### Install from a local directory

For the current local directory:

```bash
dsh plugin --profile desktop add link:D:/Agent/Work/PersPlugin/SessionDelete
```

The package and repository name is `dsh_session_recyclebin`; the local directory may remain named `SessionDelete`. Adjust the path if you move or rename the directory.

### Migrate from the old name

Remove the old package before installing the new one to avoid loading both versions:

```bash
dsh plugin --profile desktop remove dsh-session-delete
dsh plugin --profile desktop add github:lmwzd/dsh_session_recyclebin
```

For local installation, follow the same remove-old-then-install-new order. Preserve the recycle-bin data in `<DSH_HOME>/session-delete/`; do not manually delete that directory. The renamed package continues to use it, retaining existing recycle-bin records.

### Loader entries

| Function | Entry name | ID |
| --- | --- | --- |
| Main plugin | `dsh_session_recyclebin` | `dsh_session_recyclebin` |
| Optional recycle bin | `dsh_session_recyclebin/trash` | `dsh_session_recyclebin-trash` |

Keep both entries enabled for the default behavior. Before disabling the recycle-bin entry, make sure you accept immediate permanent deletion for subsequent Delete Session actions.

To uninstall the new package:

```bash
dsh plugin --profile desktop remove dsh_session_recyclebin
```

## Usage

1. Open a sidebar session row's **…** menu, choose **Delete Session**, and confirm.
2. Open the plugin's recycle-bin panel to restore or permanently delete sessions.
3. Set a retention period of 3–30 days as needed. Before emptying the bin, confirm that you no longer need its sessions.

## Test

Run from the plugin root:

```bash
npm test
```

## Upload to GitHub

Create an empty GitHub repository named `dsh_session_recyclebin`, without generating a README. Run these commands from the prepared plugin root after checking that staged content will not include secrets, dependency directories, or personal data. Replace `<OWNER>` with the actual repository owner and use your own configured Git commit identity.

```bash
git init
git add .
git commit -m "Prepare dsh_session_recyclebin release"
git branch -M main
git remote add origin https://github.com/<OWNER>/dsh_session_recyclebin.git
git push -u origin main
```

The repository root must include the package declaration, Loader configuration, runtime code, and files needed for tests. After pushing, others can use the GitHub installation command above.
