# romi 公开状态页

React + Vite 应用，随 Hub 构建和交付。状态页包含概览与地球、卡片/列表、节点搜索面板、节点详情与资源历史、昼夜页脚、明暗主题与中英文界面；
运行时只请求 Hub，地图的陆地数据随构建打包。匿名可见性由服务端决定，前端不从管理数据拼出公开响应。

在根目录运行 `make dev-server` 与 `make dev-web`；公开页开发端口为回环 5174，API/WS 代理到 Hub。
`make frontend check-frontends` 构建并检查两端；`make e2e` 使用实际 Hub 页面。

界面约束见[产品约束](../docs/product/constraints.md)，组成与映射见[界面实现](../docs/ui/implementation.md)。
