---
id: example
title: 创建 hello.txt
status: open
acceptance: node -e "process.exit(require('fs').existsSync('hello.txt')?0:1)"
sessions: []
retries: 0
---

在工作目录创建 `hello.txt`，内容为 `hi`。

全部要求完成后，运行（`--tasks-dir` 缺省为 `tasks`）：

```
taskctl done --task example
```

阶段性发现可随时记录交接笔记：

```
taskctl note --task example --status <一句话状态> --done <已完成> --found <关键发现> --next <下一步> [--files <逗号分隔文件>]
```
