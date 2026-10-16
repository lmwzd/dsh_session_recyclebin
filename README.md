# dsh_session_recyclebin

[English](README_EN.md) | 简体中文

为 DSH 侧栏的会话菜单添加「删除会话」，并提供可恢复的回收站。支持 **DSH 0.2.0-rc.2**，要求 **Node.js >= 20**。

## 功能与删除行为

- 默认启用回收站：删除会话后可以在回收站恢复，也可以彻底删除或清空。清空按钮使用中文。
- 保留期限可在 **3–30 天**之间设置；到期清理、彻底删除和清空均不可恢复。
- 回收站是可选子插件。**禁用 trash 条目后，「删除会话」会直接永久删除会话，无法恢复。**
- 回收站优先显示日志中的真实会话标题，并兼容旧条目的标题修复。
- 删除后同步过滤侧栏及其更新，避免会话重新出现在「未分组」或「显示归档」列表；恢复后重新显示并恢复工作区关联。

删除前会停止该会话的活动回合。处理范围包括会话日志、会话附件、投影缓存和工作区登记；项目工作目录中的文件不会被删除或还原，分叉子会话也不会连带删除。

## 安装

以下命令以 `desktop` profile 为例；使用其他 profile 时请替换它。安装或更新后重启 DSH，以加载宿主和客户端代码。

### 从 GitHub 安装

将 `<OWNER>` 替换为实际 GitHub 用户名或组织名，**不要保留尖括号或照抄占位符**：

```bash
dsh plugin --profile desktop add github:<OWNER>/dsh_session_recyclebin
```

仓库根目录应直接包含插件包内容。此安装方式无需先发布到 npm。更新时重新执行安装命令并重启 DSH。

### 从本地目录安装

当前本地目录可直接使用：

```bash
dsh plugin --profile desktop add link:D:/Agent/Work/PersPlugin/SessionDelete
```

包名和仓库名为 `dsh_session_recyclebin`，本地目录名可以保持 `SessionDelete`；若移动或重命名目录，请相应修改命令中的路径。

### 从旧名称迁移

先卸载旧包，再安装新包，避免两个版本重复挂载：

```bash
dsh plugin --profile desktop remove dsh-session-delete
dsh plugin --profile desktop add github:<OWNER>/dsh_session_recyclebin
```

同样需要替换 `<OWNER>`。本地安装也遵循先卸载旧包、再安装新包的顺序。迁移时保留 `<DSH_HOME>/session-delete/` 中的回收站数据，不要手动删除该目录；新名称继续使用它，已有回收站记录得以保留。

### Loader 条目

| 功能 | entry name | id |
| --- | --- | --- |
| 主插件 | `dsh_session_recyclebin` | `dsh_session_recyclebin` |
| 可选回收站 | `dsh_session_recyclebin/trash` | `dsh_session_recyclebin-trash` |

默认保留两个条目。关闭回收站条目前，请确认你接受后续删除直接永久生效。

卸载新包：

```bash
dsh plugin --profile desktop remove dsh_session_recyclebin
```

## 使用

1. 打开侧栏会话行的「…」菜单，选择「删除会话」并确认。
2. 在插件的回收站面板查看已删除的会话，选择恢复或彻底删除。
3. 按需设置 3–30 天的保留期限；清空前确认不再需要其中的会话。

## 测试

在插件根目录运行：

```bash
npm test
```

## 上传到 GitHub

在 GitHub 创建名为 `dsh_session_recyclebin` 的空仓库，不要预先生成 README。以下命令在已整理好的插件根目录运行；先确认待提交文件中没有密钥、依赖目录或个人数据。将 `<OWNER>` 替换为实际仓库所有者，Git 提交身份使用你自己的配置。

```bash
git init
git add .
git commit -m "Prepare dsh_session_recyclebin release"
git branch -M main
git remote add origin https://github.com/<OWNER>/dsh_session_recyclebin.git
git push -u origin main
```

仓库根目录需要包含包声明、Loader 配置、运行代码及测试所需文件。推送完成后，其他人即可使用上面的 GitHub 安装命令。
