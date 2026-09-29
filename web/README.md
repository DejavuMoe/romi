# romi 公开状态页

React + Vite 应用，随 Hub 构建和交付。卡片/列表、节点详情、资源历史和明暗主题只使用 Hub 数据。
匿名可见性由服务端决定，前端不从管理数据拼出公开响应。

在根目录运行 `make dev-server` 与 `make dev-web`；公开页开发端口为回环 5174，API/WS 代理到 Hub。
`make frontend check-frontends` 构建并检查两端；`make e2e` 使用实际 Hub 页面。
默认视图来自 `/api/me`，管理员通过设置接口保存；当前页面切换不改变站点默认值。

界面约束见 [产品约束](../docs/product/constraints.md)，映射见 [UI 契约](../docs/ui/implementation.md)。
