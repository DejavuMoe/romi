# 界面原型

生产代码和接口是功能依据；原型用于界面和交互对照。每个版本的状态记录在 `_d_meta.json` 中。

| 版本 | 状态 | 入口 |
| --- | --- | --- |
| [v15 晨昏](revision-v15/README.md) | 已批准，现行规格；状态页已实施，节点详情与管理面板分批迁移 | [管理端](revision-v15/index.html)、[公开页](revision-v15/public.html)、[设计规范](revision-v15/system.html) |
| [v14 视觉收敛](revision-v14/README.md) | 已被 v15 取代；迁移完成前节点详情与管理面板沿用其布局 | [管理端](revision-v14/index.html)、[公开页](revision-v14/public.html)、[设计规范](revision-v14/system.html) |
| [v12](revision-v12/README.md) | 已被 v14 取代 | [管理端](revision-v12/index.html)、[公开页](revision-v12/public.html) |

- [表面/源码契约](ui-contract.json)
- [文案清单](content-inventory.json)
- [来源角色](design-sources.json)

在仓库根运行 `node designs/preview.mjs 4311`，然后访问 `http://127.0.0.1:4311/romi-next/<版本>/index.html`。
v12 与 v14 的原型登录只检查账号和密码非空；v15 的登录账号见其 README。所有节点、地址和操作反馈都是合成数据，不连接生产 API。
`vendor/` 保留本地预览依赖与许可证（来源和校验值见 `vendor/provenance.json`），`fixtures/` 是非生产样本。原型资源不参与 Hub 构建。

下一次 UI 变更创建新版本，独立审阅和批准，再修改生产代码。
