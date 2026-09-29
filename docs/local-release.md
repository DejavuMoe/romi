# 本地开发快照

`make package` 构建两个前端和 Rust release 二进制，记录源树、二进制、生成资源与工具链摘要，再生成开发归档。
输出为 `dist/romi-<源树摘要>-<target>.tar.gz` 和相邻校验文件。

开发快照允许未打标签或未提交的源码，但内容必须与构建记录完全一致。修改任何输入后，旧记录不可用于打包。
manifest 的 kind 为 local-snapshot、signed 为 false；不会创建标签、发布或签名。

包中包含本地二进制、公开页资源、工具链与依赖锁文件、项目 MIT 和第三方许可。
原生安装介质使用 [发布归档](release.md)，开发快照不是安装包。

```sh
python3 scripts/package.py verify ./romi-snapshot.tar.gz --sha256 '<可信摘要>'
```

只有验证成功后才解压；不要覆盖已有数据目录。快照适用于构建机对应的架构/ABI，不代表跨平台发行验收。
