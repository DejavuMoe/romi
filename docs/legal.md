# 许可

romi 由 Dejavu Moe 以 MIT 协议授权，许可证全文见仓库根目录的 [LICENSE](https://github.com/DejavuMoe/romi/blob/master/LICENSE)。

发布的二进制包含第三方组件：Hub 静态链接 Rust 依赖和从源码编译的 DuckDB（含其自带的 C/C++ 第三方组件），并内嵌管理后台与公开页的前端依赖；Agent 链接自己的 Rust 依赖。
这些组件的版本、许可与原文见 [THIRD_PARTY_LICENSES.txt](https://github.com/DejavuMoe/romi/blob/master/THIRD_PARTY_LICENSES.txt)，它由锁文件生成、在 CI 中核对，并随每个发布归档及 Agent 镜像（`/licenses/`）分发。
概览与仓库内其他素材的来源见 [THIRD_PARTY_NOTICES.md](https://github.com/DejavuMoe/romi/blob/master/THIRD_PARTY_NOTICES.md)。

界面只使用系统字体，不分发字体文件。
