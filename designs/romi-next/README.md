# 当前界面规格

本目录保留当前已批准并实施的 v12。生产代码和接口是功能依据；原型用于界面和交互对照。

- [管理端](revision-v12/index.html)
- [公开页](revision-v12/public.html)
- [表面/源码契约](ui-contract.json)
- [文案清单](content-inventory.json)
- [来源角色](design-sources.json)

在仓库根运行 `python -m http.server 4311 --bind 127.0.0.1 --directory designs`，然后访问 `/romi-next/revision-v12/index.html`。
原型登录可使用 admin/admin；只校验非空。所有节点、地址、操作反馈都是合成数据，不连接生产 API。
`vendor/` 保留本地预览依赖与许可证，`fixtures/` 是非生产样本。原型资源不参与 Hub 构建。

状态由 `_d_meta.json` 管理。下一次 UI 变更创建新版本，独立审阅和批准，再修改生产代码。
